/*
 * data-source/terrain-ingest (graph task `sdn-terrain-serving-module`).
 *
 * The ORCHESTRATION half of the terrain lane. `terrain-source` (a sibling
 * module, built separately) is the request-scoped decoder — DEM/WBM bytes in,
 * terrain tiles out, nothing persisted — and this module is the scheduler that
 * decides WHICH tiles to build, in WHAT order, and where to resume after a
 * restart. Same split, same reasoning as geonames-source / geonames-ingest.
 *
 * Methods:
 *   mark_query      tick                  -> query               (read the mark)
 *   ingest_plan     tick + mark?          -> plan frames, job    (bounded batch)
 *   ingest_meta     job + records + ...   -> meta, records       (storage-ingest input)
 *   publish_request result + meta         -> mark, request?      (advance + announce)
 *
 * THE SOURCE DATASET.
 *
 * Copernicus GLO-30, served unauthenticated from S3 (bucket
 * `copernicus-dem-30m`, eu-central-1). One granule per 1x1 degree cell:
 *
 *   Copernicus_DSM_COG_10_<lat>_00_<lon>_00_DEM/
 *       Copernicus_DSM_COG_10_<lat>_00_<lon>_00_DEM.tif
 *
 * with <lat> like N45 / S09 (degrees of the cell's SOUTH edge, S counts down)
 * and <lon> like E006 / W120 (degrees of the cell's WEST edge). The water-mask
 * auxiliary rides next to it under AUXFILES/ with a _WBM suffix.
 *
 * OCEAN HANDLING — allow_404, BY DESIGN.
 *
 * Copernicus publishes NO granule for open-ocean cells: the object simply does
 * not exist. The guest cannot cheaply know land from ocean (a land mask would
 * be megabytes of data this scheduler has no business carrying), so the plan
 * lists EVERY granule URL intersecting the tile's extent and marks the entry
 * `allow_404: true`. The fetcher treats 404 as "ocean cell, no data" — an
 * expected outcome, never an error — and the tile builder fills the gap at
 * mean sea level. A missing granule is only a defect when the SAME cell later
 * turns out to exist; that is upstream's inconsistency to report, not ours to
 * guess at.
 *
 * THE PLAN IS A BOUNDED WALK OVER THE TERRAIN PYRAMID.
 *
 * The tile scheme is TMS over GEOGRAPHIC_WGS84: level 0 is 2x1 root tiles of
 * 180 degrees, level L has 2^(L+1) columns by 2^L rows, and row 0 is the
 * SOUTHERNMOST row. The enumeration is REGION-PRIORITY ordered: regions sorted
 * by priority descending (config order breaks ties), and within a region
 * shallow levels before deep, tiles row-major within a level. That order is a
 * pure function of the config, so a tile's global index is stable across
 * invocations and the durable mark can be a single integer: the index of the
 * next tile to plan. One invocation plans at most `batch_tiles` (default 64)
 * tiles and reports the remainder through plugin_set_backlog_remaining, so the
 * runtime re-invokes until the pyramid is drained.
 *
 * GRANULE LISTS ARE CLIPPED TO THE REGION.
 *
 * A shallow tile spans a huge extent — the level-0 root is 180 degrees and
 * intersects tens of thousands of 1-degree granules, which no plan frame can
 * usefully carry and no fetcher should be asked to attempt. The granules a
 * shallow tile actually needs for ITS REGION are the ones under the region's
 * bbox, so the plan lists granules for (tile extent INTERSECT region bbox),
 * expanded outward to whole-degree cells. The tile builder renders the rest of
 * the shallow tile from the ellipsoid, which is exactly what it would have
 * done with a stack of 404s — the clip changes the request count, not the
 * mesh.
 *
 * WHY THE RESUME MARK ADVANCES WHERE IT DOES.
 *
 * The mark is written by `publish_request`, from the STORAGE RESULT — never by
 * `ingest_plan` at dispatch. A mark advanced at plan time turns a crash
 * between fetch and store into a permanently skipped batch of tiles, and the
 * hole is invisible: the next tick walks on past it. Advancing only on a
 * verified store makes a restart re-plan at most one batch. The mark also
 * carries the upstream ETag/Last-Modified `ingest_meta` observed, and
 * `ingest_plan` rides that ETag out on every plan entry as `if_none_match`,
 * so an unchanged granule costs the fetcher one conditional request.
 */

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

extern "C" {

__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t sdm_host_call(const uint8_t* op_ptr, int32_t op_len,
                      const uint8_t* payload_ptr, int32_t payload_len);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t sdm_host_response_len(void);
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t sdm_host_read_response(uint8_t* dst_ptr, int32_t dst_len);

}  // extern "C"

namespace {

constexpr long kDefaultTimeoutMs = 90000;
constexpr long kDefaultBatchTiles = 64;
constexpr long kMaxBatchTiles = 256;
constexpr long kDefaultGlobalMaxLevel = 10;
constexpr const char* kMarkTable = "terrain_ingest_mark";
constexpr const char* kSchema = "DTT";
constexpr const char* kLane = "terrain";
constexpr const char* kDefaultDatasetId = "copernicus-glo30-quantized-mesh";
constexpr const char* kDefaultProviderId = "copernicus";
constexpr const char* kDefaultSourceName = "copernicus-glo30";
constexpr const char* kDefaultGranuleBase =
    "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/";
// The licence Copernicus publishes GLO-30 under; carried VERBATIM from config
// into every plan frame's provenance block, these are only the fallbacks.
constexpr const char* kDefaultLicense =
    "Copernicus DEM: ESA / Airbus Defence and Space (free licence)";
constexpr const char* kDefaultLicenseUrl =
    "https://spacedata.copernicus.eu/documents/20123/121286/CSCDA_ESA_Mission-specific+Annex_31_Oct_22.pdf";
constexpr const char* kDefaultAttribution =
    "Produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved";

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '"') return false;
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            value.push_back(json[i + 1]);
            i += 2;
        } else {
            value.push_back(json[i]);
            i++;
        }
    }
    *out = value;
    return true;
}

bool json_number_field(const std::string& json, const std::string& key, double* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (i >= json.size()) return false;
    const char c = json[i];
    if (c != '-' && (c < '0' || c > '9')) return false;
    char* end = nullptr;
    const double value = strtod(json.c_str() + i, &end);
    if (end == json.c_str() + i) return false;
    *out = value;
    return true;
}

double json_number_or(const std::string& json, const char* key, double fallback) {
    double v = 0;
    return json_number_field(json, key, &v) ? v : fallback;
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else out.push_back(c);
    }
    return out;
}

std::string fmt_double(double v) {
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.10g", v);
    return buf;
}

const char kB64Alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64_encode(const uint8_t* data, size_t length) {
    std::string out;
    out.reserve(((length + 2) / 3) * 4);
    size_t i = 0;
    while (i + 3 <= length) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8) | data[i + 2];
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 6) & 0x3f]);
        out.push_back(kB64Alphabet[v & 0x3f]);
        i += 3;
    }
    const size_t remain = length - i;
    if (remain == 1) {
        const uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back('=');
        out.push_back('=');
    } else if (remain == 2) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8);
        out.push_back(kB64Alphabet[(v >> 18) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 12) & 0x3f]);
        out.push_back(kB64Alphabet[(v >> 6) & 0x3f]);
        out.push_back('=');
    }
    return out;
}

// plugin.getConfig builtin hostcall: node CONFIG for this flow service, or "{}".
std::string load_config() {
    static const char* op = "plugin.getConfig";
    const std::string payload_json = "{}";
    std::vector<uint8_t> req(4 + payload_json.size() + 4, 0);
    const uint32_t meta_len = static_cast<uint32_t>(payload_json.size());
    req[0] = static_cast<uint8_t>(meta_len & 0xff);
    req[1] = static_cast<uint8_t>((meta_len >> 8) & 0xff);
    req[2] = static_cast<uint8_t>((meta_len >> 16) & 0xff);
    req[3] = static_cast<uint8_t>((meta_len >> 24) & 0xff);
    std::memcpy(req.data() + 4, payload_json.data(), payload_json.size());
    sdm_host_call(reinterpret_cast<const uint8_t*>(op), static_cast<int32_t>(std::strlen(op)),
                  req.data(), static_cast<int32_t>(req.size()));
    const int32_t len = sdm_host_response_len();
    if (len <= 4) return "{}";
    std::vector<uint8_t> buf(static_cast<size_t>(len));
    sdm_host_read_response(buf.data(), len);
    const uint32_t rlen = static_cast<uint32_t>(buf[0]) | (static_cast<uint32_t>(buf[1]) << 8) |
                          (static_cast<uint32_t>(buf[2]) << 16) |
                          (static_cast<uint32_t>(buf[3]) << 24);
    if (buf.size() < 4u + rlen) return "{}";
    return std::string(reinterpret_cast<const char*>(buf.data() + 4), rlen);
}

std::string config_string(const std::string& config, const char* key, const char* fallback) {
    std::string value;
    if (json_string_field(config, key, &value) && !value.empty()) return value;
    return fallback;
}

long config_timeout_ms(const std::string& config) {
    const long v = static_cast<long>(
        json_number_or(config, "terrain_http_timeout_ms", static_cast<double>(kDefaultTimeoutMs)));
    return v > 0 ? v : kDefaultTimeoutMs;
}

// The batch budget is CLAMPED, not merely defaulted: an unbounded batch turns
// one invocation into the whole pyramid, which is exactly the unbounded unit
// of work the mark/backlog protocol exists to prevent.
long config_batch_tiles(const std::string& config) {
    long v = static_cast<long>(
        json_number_or(config, "batch_tiles", static_cast<double>(kDefaultBatchTiles)));
    if (v <= 0) return kDefaultBatchTiles;
    if (v > kMaxBatchTiles) return kMaxBatchTiles;
    return v;
}

const plugin_input_frame_t* frame_for(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    if (index < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(index));
}

std::string input_text(const char* port_id) {
    const plugin_input_frame_t* f = frame_for(port_id);
    if (!f || !f->payload || f->payload_length == 0) return std::string();
    return std::string(reinterpret_cast<const char*>(f->payload), f->payload_length);
}

int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(port, nullptr, nullptr,
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                 reinterpret_cast<const uint8_t*>(json.data()),
                                 static_cast<uint32_t>(json.size()));
}

// SURPLUS-FRAME REFUSAL — see the long note in cell_tower_ingest_module.cpp.
// The compiled flow runtime drains a node's queue PORT-BLIND up to a budget of
// 64 while maxStreams/maxBatch/drainPolicy are declarative only, so a guest
// that reads ordinal 0 and returns destroys every other frame it was handed.
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        for (uint32_t j = 0; j < i; j++) {
            const plugin_input_frame_t* earlier = plugin_get_input_frame(j);
            if (!earlier || !earlier->port_id) continue;
            if (std::strcmp(earlier->port_id, frame->port_id) != 0) continue;
            uint32_t on_port = 0;
            for (uint32_t k = 0; k < count; k++) {
                const plugin_input_frame_t* f = plugin_get_input_frame(k);
                if (f && f->port_id && std::strcmp(f->port_id, frame->port_id) == 0) on_port++;
            }
            std::snprintf(message, message_len,
                          "This invocation carries %u frames on single-stream input port \"%s\" "
                          "(the compiled flow runtime drains a node's whole queue port-blind; "
                          "maxStreams is declarative only). The surplus frames are refused "
                          "rather than silently discarded.",
                          on_port, frame->port_id);
            return true;
        }
    }
    return false;
}

bool refuse_batched(void) {
    char message[384];
    if (!find_batched_input_port(message, sizeof(message))) return false;
    plugin_set_error("batched-input-frames", message);
    return true;
}

// The UTC date this tick belongs to — from the TICK, never a guest clock read.
std::string tick_date(const std::string& tick) {
    std::string fired;
    if (json_string_field(tick, "firedAt", &fired) && fired.size() >= 10) {
        return fired.substr(0, 10);
    }
    return std::string();
}

// ---------------------------------------------------------------------------
// Copernicus GLO-30 granule addressing.
// ---------------------------------------------------------------------------

// The granule STEM for the 1x1 degree cell whose SOUTH-WEST corner is
// (lat, lon), in integer degrees. N45/S09 count the south edge (S counts
// down: the cell [-1, 0) is S01, the cell [0, 1) is N00); E006/W120 count the
// west edge (W counts down: [-1, 0) is W001, [0, 1) is E000).
std::string granule_stem(int lat, int lon) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "Copernicus_DSM_COG_10_%c%02d_00_%c%03d_00",
                  lat < 0 ? 'S' : 'N', lat < 0 ? -lat : lat,
                  lon < 0 ? 'W' : 'E', lon < 0 ? -lon : lon);
    return buf;
}

std::string dem_url(const std::string& base, int lat, int lon) {
    const std::string stem = granule_stem(lat, lon);
    return base + stem + "_DEM/" + stem + "_DEM.tif";
}

std::string wbm_url(const std::string& base, int lat, int lon) {
    const std::string stem = granule_stem(lat, lon);
    return base + stem + "_DEM/AUXFILES/" + stem + "_WBM.tif";
}

// ---------------------------------------------------------------------------
// The region list and the tile pyramid.
// ---------------------------------------------------------------------------

struct Region {
    std::string name;
    double west = 0, south = 0, east = 0, north = 0;
    long max_level = -1;  // -1 = inherit global_max_level
    double priority = 0;
    size_t order = 0;  // config position; the stable tiebreak
};

// Extract the top-level JSON array value for `key` by bracket matching, then
// split it into its top-level {...} objects. Quotes are honoured so a brace
// inside a name cannot end an object early.
std::vector<std::string> json_object_array(const std::string& json, const char* key) {
    std::vector<std::string> out;
    const std::string needle = std::string("\"") + key + "\"";
    size_t k = json.find(needle);
    if (k == std::string::npos) return out;
    size_t open = json.find('[', k + needle.size());
    if (open == std::string::npos) return out;
    int depth = 0;
    bool in_string = false;
    size_t obj_start = 0;
    for (size_t i = open; i < json.size(); i++) {
        const char c = json[i];
        if (in_string) {
            if (c == '\\') i++;
            else if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') { in_string = true; continue; }
        if (c == '{') {
            if (depth == 1) obj_start = i;
            depth++;
        } else if (c == '}') {
            depth--;
            if (depth == 1) out.push_back(json.substr(obj_start, i - obj_start + 1));
        } else if (c == '[') {
            depth++;
        } else if (c == ']') {
            depth--;
            if (depth == 0) break;
        }
    }
    return out;
}

std::vector<Region> parse_regions(const std::string& config, long global_max_level) {
    std::vector<Region> regions;
    const std::vector<std::string> objects = json_object_array(config, "regions");
    for (const std::string& obj : objects) {
        Region r;
        json_string_field(obj, "name", &r.name);
        if (!json_number_field(obj, "west", &r.west)) continue;
        if (!json_number_field(obj, "south", &r.south)) continue;
        if (!json_number_field(obj, "east", &r.east)) continue;
        if (!json_number_field(obj, "north", &r.north)) continue;
        r.max_level = static_cast<long>(json_number_or(obj, "max_level", -1));
        if (r.max_level < 0 || r.max_level > global_max_level) r.max_level = global_max_level;
        r.priority = json_number_or(obj, "priority", 0);
        r.order = regions.size();
        regions.push_back(r);
    }
    // Priority DESC, config order as the stable tiebreak. Insertion sort: the
    // region list is operator-sized, never data-sized.
    for (size_t i = 1; i < regions.size(); i++) {
        Region key = regions[i];
        size_t j = i;
        while (j > 0 && (regions[j - 1].priority < key.priority ||
                         (regions[j - 1].priority == key.priority &&
                          regions[j - 1].order > key.order))) {
            regions[j] = regions[j - 1];
            j--;
        }
        regions[j] = key;
    }
    return regions;
}

// TMS GEOGRAPHIC_WGS84: level L is 2^(L+1) x 2^L tiles of 180/2^L degrees,
// row 0 SOUTHERNMOST.
double tile_size_deg(long level) { return 180.0 / static_cast<double>(1L << level); }

long clampl(long v, long lo, long hi) { return v < lo ? lo : (v > hi ? hi : v); }

// The inclusive tile-index block a region's bbox intersects at a level.
struct TileBlock {
    long x0, x1, y0, y1;
    long nx() const { return x1 - x0 + 1; }
    long ny() const { return y1 - y0 + 1; }
    long long count() const { return static_cast<long long>(nx()) * ny(); }
};

TileBlock region_block(const Region& r, long level) {
    const double size = tile_size_deg(level);
    const long max_x = (2L << level) - 1;  // 2^(L+1) - 1
    const long max_y = (1L << level) - 1;
    TileBlock b;
    b.x0 = clampl(static_cast<long>(std::floor((r.west + 180.0) / size)), 0, max_x);
    b.x1 = clampl(static_cast<long>(std::floor((r.east + 180.0) / size - 1e-9)), 0, max_x);
    b.y0 = clampl(static_cast<long>(std::floor((r.south + 90.0) / size)), 0, max_y);
    b.y1 = clampl(static_cast<long>(std::floor((r.north + 90.0) / size - 1e-9)), 0, max_y);
    if (b.x1 < b.x0) b.x1 = b.x0;
    if (b.y1 < b.y0) b.y1 = b.y0;
    return b;
}

long long total_tiles(const std::vector<Region>& regions) {
    long long total = 0;
    for (const Region& r : regions) {
        for (long level = 0; level <= r.max_level; level++) {
            total += region_block(r, level).count();
        }
    }
    return total;
}

struct PlannedTile {
    const Region* region;
    long level, x, y;
    double west, south, east, north;
};

// Resolve global tile index -> (region, level, x, y). O(regions x levels) to
// find the block, O(1) within it; the enumeration is a pure function of the
// config, which is what makes a single integer a sufficient durable mark.
bool tile_at_index(const std::vector<Region>& regions, long long index, PlannedTile* out) {
    for (const Region& r : regions) {
        for (long level = 0; level <= r.max_level; level++) {
            const TileBlock b = region_block(r, level);
            if (index >= b.count()) {
                index -= b.count();
                continue;
            }
            const double size = tile_size_deg(level);
            out->region = &r;
            out->level = level;
            out->x = b.x0 + static_cast<long>(index % b.nx());
            out->y = b.y0 + static_cast<long>(index / b.nx());
            out->west = -180.0 + out->x * size;
            out->south = -90.0 + out->y * size;
            out->east = out->west + size;
            out->north = out->south + size;
            return true;
        }
    }
    return false;
}

std::string mark_json(const std::string& dataset_id, const std::string& tileset_id,
                      const std::string& dataset_epoch, long long next_tile_index,
                      const std::string& etag, const std::string& last_modified,
                      const std::string& batch_id, long tiles) {
    return std::string("{\"dataset_id\":\"") + json_escape(dataset_id) + "\"" +
           ",\"lane\":\"" + kLane + "\"" + ",\"tileset_id\":\"" + json_escape(tileset_id) +
           "\"" + ",\"dataset_epoch\":\"" + json_escape(dataset_epoch) + "\"" +
           ",\"next_tile_index\":" + std::to_string(next_tile_index) + ",\"etag\":\"" +
           json_escape(etag) + "\"" + ",\"last_modified\":\"" + json_escape(last_modified) +
           "\"" + ",\"batch_id\":\"" + json_escape(batch_id) + "\"" +
           ",\"tiles\":" + std::to_string(tiles) + "}";
}

// The response frame's "headers" object, extracted by brace matching so a
// nested value cannot end it early.
std::string headers_object(const std::string& response) {
    const size_t h = response.find("\"headers\"");
    if (h == std::string::npos) return std::string();
    const size_t open = response.find('{', h);
    if (open == std::string::npos) return std::string();
    int depth = 0;
    size_t i = open;
    for (; i < response.size(); i++) {
        if (response[i] == '{') depth++;
        else if (response[i] == '}' && --depth == 0) break;
    }
    return i < response.size() ? response.substr(open, i - open + 1) : std::string();
}

std::string header_value(const std::string& headers, const char* lower, const char* canonical) {
    std::string v;
    if (json_string_field(headers, lower, &v)) return v;
    if (json_string_field(headers, canonical, &v)) return v;
    return std::string();
}

constexpr long kGranuleMinLevel = 8;   // 180/2^8 = 0.703125 deg <= one granule
constexpr long kDefaultGridSize = 65;

// The whole-degree cell block a region's bbox covers.
struct CellBlock {
    long lon0, lon1, lat0, lat1;
    long nx() const { return lon1 - lon0 + 1; }
    long ny() const { return lat1 - lat0 + 1; }
    long long count() const { return static_cast<long long>(nx()) * ny(); }
};

CellBlock region_cells(const Region& r, long min_level) {
    // The west/south edges reach BACK past the region. A tile is assigned to
    // the cell holding its SOUTH-WEST CORNER, and the westmost tile the region
    // overlaps starts west of the region's own west edge (its extent contains
    // that edge) — so its corner lands in the PREVIOUS cell. Bounding the walk
    // by the region's own degrees would drop that whole column and row: a hole
    // in the pyramid nothing downstream could see. The shallowest level has
    // the largest tiles and therefore reaches back furthest, so it sets the
    // floor for every level.
    const double size = tile_size_deg(min_level);
    const long max_x = (2L << min_level) - 1;
    const long max_y = (1L << min_level) - 1;
    const long first_x =
        clampl(static_cast<long>(std::floor((r.west + 180.0) / size)), 0, max_x);
    const long first_y =
        clampl(static_cast<long>(std::floor((r.south + 90.0) / size)), 0, max_y);
    CellBlock b;
    b.lon0 = clampl(static_cast<long>(std::floor(-180.0 + first_x * size)), -180, 179);
    b.lon1 = clampl(static_cast<long>(std::floor(r.east - 1e-9)), -180, 179);
    b.lat0 = clampl(static_cast<long>(std::floor(-90.0 + first_y * size)), -90, 89);
    b.lat1 = clampl(static_cast<long>(std::floor(r.north - 1e-9)), -90, 89);
    if (b.lon1 < b.lon0) b.lon1 = b.lon0;
    if (b.lat1 < b.lat0) b.lat1 = b.lat0;
    return b;
}

struct PlannedCell {
    const Region* region;
    long level;
    long lon;  // west edge of the granule cell, whole degrees
    long lat;  // south edge
};

long long total_cells(const std::vector<Region>& regions, long min_level) {
    long long total = 0;
    for (const Region& r : regions) {
        if (r.max_level < min_level) continue;
        total += (r.max_level - min_level + 1) * region_cells(r, min_level).count();
    }
    return total;
}

bool cell_at_index(const std::vector<Region>& regions, long min_level, long long index,
                   PlannedCell* out) {
    for (const Region& r : regions) {
        if (r.max_level < min_level) continue;
        const CellBlock b = region_cells(r, min_level);
        for (long level = min_level; level <= r.max_level; level++) {
            if (index >= b.count()) {
                index -= b.count();
                continue;
            }
            out->region = &r;
            out->level = level;
            out->lon = b.lon0 + static_cast<long>(index % b.nx());
            out->lat = b.lat0 + static_cast<long>(index / b.nx());
            return true;
        }
    }
    return false;
}

// Longitude WRAPS (the globe does); latitude clamps (it does not).
long wrap_lon(long lon) {
    while (lon < -180) lon += 360;
    while (lon > 179) lon -= 360;
    return lon;
}

std::string granule_request(const std::string& url, long timeout_ms) {
    // responseWire raw-body-v1: a granule is megabytes of binary and the
    // connector's default JSON dialect would base64-expand it by a third
    // before the decoder saw a byte. allow_404 because the dataset publishes
    // NO object over open ocean — an expected outcome, never an error.
    return std::string("{\"method\":\"GET\",\"url\":\"") + json_escape(url) + "\"" +
           ",\"responseWire\":\"raw-body-v1\",\"allow_404\":true" +
           ",\"timeoutMs\":" + std::to_string(timeout_ms) + "}";
}

}  // namespace

extern "C" {

// mark_query: the timer tick -> the flatsql-query JSON that reads this
// dataset's resume mark back. A SEPARATE node from ingest_plan on purpose: the
// plan takes the mark as an INPUT, and a node that emitted its own input would
// be a cycle in the flow graph.
//
// EMITS {"sql","params"}, never {"table","where"} — hostcap/flatsql-query's
// `query` reads `sql` and returns 400 `missing-sql` for anything else.
int mark_query(void) {
    if (refuse_batched()) return 500;
    const std::string config = load_config();
    const std::string dataset = config_string(config, "dataset_id", kDefaultDatasetId);
    const std::string query = std::string("{\"sql\":\"SELECT * FROM ") + kMarkTable +
                              " WHERE dataset_id = ? LIMIT 1\"" +
                              ",\"params\":[{\"t\":\"str\",\"v\":\"" + json_escape(dataset) +
                              "\"}]}";
    return push_json("query", query) < 0 ? 500 : 0;
}

// ingest_plan: tick (+ the resume mark, when one exists) -> at most
// `batch_tiles` plan frames plus the run-contract job frame, with the
// remainder of the pyramid reported as backlog. A mark whose enumeration is
// already drained (next_tile_index >= total) is a completed pyramid and the
// tick is a clean no-op.
int ingest_plan(void) {
    if (refuse_batched()) return 500;

    const std::string config = load_config();
    const std::string tileset = config_string(config, "tileset_id", "");
    if (tileset.empty()) {
        // Fail-closed: without a tileset identity there is nothing this plan
        // could be FOR, and inventing one would store tiles nobody can find.
        plugin_set_error("missing-tileset-id",
                         "ingest_plan requires tileset_id in node CONFIG.");
        return 400;
    }
    const long global_max_level = static_cast<long>(json_number_or(
        config, "global_max_level", static_cast<double>(kDefaultGlobalMaxLevel)));
    const std::vector<Region> regions =
        parse_regions(config, global_max_level < 0 ? 0 : global_max_level);
    if (regions.empty()) {
        plugin_set_error("missing-regions",
                         "ingest_plan requires a non-empty regions array in node CONFIG; an "
                         "empty region list plans nothing and a whole-earth default would "
                         "enumerate millions of tiles nobody asked for.");
        return 400;
    }
    const std::string dataset = config_string(config, "dataset_id", kDefaultDatasetId);

    // The epoch is the EDITION boundary: config override first (a pinned
    // Copernicus release), else the tick's own UTC day — never a guest clock.
    std::string epoch = config_string(config, "dataset_epoch", "");
    if (epoch.empty()) {
        const std::string date = tick_date(input_text("tick"));
        if (date.empty()) {
            plugin_set_error("missing-dataset-epoch",
                             "ingest_plan needs config dataset_epoch or the tick's firedAt to "
                             "date this edition; an epoch guessed in-guest would make two "
                             "editions falsely comparable.");
            return 400;
        }
        epoch = date + "T00:00:00.000Z";
    }

    // Resume. A mark for a different dataset, tileset or epoch is IGNORED
    // rather than trusted: resuming tileset A from tileset B's index would
    // skip A's shallow levels forever, and a new epoch replans from tile 0.
    long long start = 0;
    std::string mark_etag;
    const std::string mark = input_text("mark");
    if (!mark.empty()) {
        std::string mark_dataset, mark_tileset, mark_epoch;
        json_string_field(mark, "dataset_id", &mark_dataset);
        json_string_field(mark, "tileset_id", &mark_tileset);
        json_string_field(mark, "dataset_epoch", &mark_epoch);
        if (mark_dataset == dataset && mark_tileset == tileset && mark_epoch == epoch) {
            const double v = json_number_or(mark, "next_tile_index", 0);
            if (v > 0) start = static_cast<long long>(v);
            json_string_field(mark, "etag", &mark_etag);
        }
    }

    const long long total = total_tiles(regions);
    if (start >= total) {
        // The pyramid for this epoch is fully stored; nothing is planned and
        // the run ends here. Completion is not an error.
        plugin_set_backlog_remaining(0);
        return 0;
    }

    const long batch = config_batch_tiles(config);
    long long end = start + batch;
    if (end > total) end = total;

    const std::string base = config_string(config, "granule_base_url", kDefaultGranuleBase);
    const std::string license = config_string(config, "license", kDefaultLicense);
    const std::string license_url = config_string(config, "license_url", kDefaultLicenseUrl);
    const std::string attribution = config_string(config, "attribution", kDefaultAttribution);

    const std::string provenance =
        std::string("{\"license\":\"") + json_escape(license) + "\"" + ",\"license_url\":\"" +
        json_escape(license_url) + "\"" + ",\"attribution\":\"" + json_escape(attribution) +
        "\"" + ",\"tileset_id\":\"" + json_escape(tileset) + "\"" + ",\"dataset_epoch\":\"" +
        json_escape(epoch) + "\"}";

    for (long long i = start; i < end; i++) {
        PlannedTile t;
        if (!tile_at_index(regions, i, &t)) break;  // unreachable given end<=total

        // Granule cells: the tile's extent CLIPPED to the region bbox (see the
        // file comment — a level-0 tile intersects tens of thousands of
        // 1-degree cells, and the ones outside the region render from the
        // ellipsoid either way), expanded outward to whole-degree cells.
        const double gw = t.west > t.region->west ? t.west : t.region->west;
        const double ge = t.east < t.region->east ? t.east : t.region->east;
        const double gs = t.south > t.region->south ? t.south : t.region->south;
        const double gn = t.north < t.region->north ? t.north : t.region->north;
        std::string dem_urls, wbm_urls;
        if (ge > gw && gn > gs) {
            const long lon0 = clampl(static_cast<long>(std::floor(gw)), -180, 179);
            const long lon1 = clampl(static_cast<long>(std::floor(ge - 1e-9)), -180, 179);
            const long lat0 = clampl(static_cast<long>(std::floor(gs)), -90, 89);
            const long lat1 = clampl(static_cast<long>(std::floor(gn - 1e-9)), -90, 89);
            for (long lat = lat0; lat <= lat1; lat++) {
                for (long lon = lon0; lon <= lon1; lon++) {
                    if (!dem_urls.empty()) { dem_urls += ","; wbm_urls += ","; }
                    dem_urls += "\"" + dem_url(base, static_cast<int>(lat),
                                               static_cast<int>(lon)) + "\"";
                    wbm_urls += "\"" + wbm_url(base, static_cast<int>(lat),
                                               static_cast<int>(lon)) + "\"";
                }
            }
        }

        std::string entry =
            std::string("{\"index\":") + std::to_string(i) + ",\"tileset_id\":\"" +
            json_escape(tileset) + "\"" + ",\"region\":\"" + json_escape(t.region->name) + "\"" +
            ",\"tile\":{\"level\":" + std::to_string(t.level) +
            ",\"x\":" + std::to_string(t.x) + ",\"y\":" + std::to_string(t.y) +
            ",\"west\":" + fmt_double(t.west) + ",\"south\":" + fmt_double(t.south) +
            ",\"east\":" + fmt_double(t.east) + ",\"north\":" + fmt_double(t.north) + "}" +
            ",\"dem_urls\":[" + dem_urls + "]" + ",\"wbm_urls\":[" + wbm_urls + "]" +
            // OCEAN CELLS: Copernicus publishes NO granule over open ocean and
            // the guest cannot cheaply know land from ocean, so every granule
            // is planned and the fetcher treats 404 as "no data here" — an
            // expected outcome, never an error.
            ",\"allow_404\":true";
        if (!mark_etag.empty()) {
            // The mark's ETag rides out so an unchanged granule costs the
            // fetcher one conditional request and a 304.
            entry += ",\"if_none_match\":\"" + json_escape(mark_etag) + "\"";
        }
        entry += ",\"timeout_ms\":" + std::to_string(config_timeout_ms(config)) +
                 ",\"provenance\":" + provenance + "}";
        if (push_json("plan", entry) < 0) return 500;
    }

    const std::string job =
        std::string("{\"lane\":\"") + kLane + "\"" + ",\"dataset_id\":\"" +
        json_escape(dataset) + "\"" + ",\"tileset_id\":\"" + json_escape(tileset) + "\"" +
        ",\"dataset_epoch\":\"" + json_escape(epoch) + "\"" +
        ",\"first_tile_index\":" + std::to_string(start) +
        ",\"tiles_planned\":" + std::to_string(end - start) +
        ",\"total_tiles\":" + std::to_string(total) + ",\"provider_id\":\"" +
        json_escape(config_string(config, "provider_id", kDefaultProviderId)) + "\"" +
        ",\"source_name\":\"" +
        json_escape(config_string(config, "source_name", kDefaultSourceName)) + "\"" +
        ",\"granule_base_url\":\"" + json_escape(base) + "\"" + ",\"license\":\"" +
        json_escape(license) + "\"" + ",\"attribution\":\"" + json_escape(attribution) + "\"}";
    if (push_json("job", job) < 0) return 500;

    const long long backlog = total - end;
    plugin_set_backlog_remaining(
        backlog > 0xffffffffLL ? 0xffffffffu : static_cast<uint32_t>(backlog));
    return 0;
}

// ---------------------------------------------------------------------------
// granule_plan — the GRANULE-MAJOR planner, and the one the pyramid builder
// runs.
//
// WHY A SECOND ENUMERATION EXISTS. ingest_plan above is TILE-MAJOR: one plan
// frame per tile, each naming the granules that tile needs. That was the right
// shape when the encoder decoded per tile, and it is the wrong shape now that
// it does not: the encoder amortizes a granule decode across every tile the
// granule covers, and a tile-major plan can never hand it more than one tile
// at a time. A z11 tile is 0.088 degrees and a granule is a whole degree, so
// tile-major planning re-fetches and re-decodes the SAME granule about 130
// times per cell.
//
// This planner inverts it. The unit of work is ONE GRANULE CELL at one level:
//
//   * the 2x2 granule neighbourhood is fetched (four DEM + four water-body
//     descriptors, always exactly four so the flow's http nodes are fed
//     unconditionally), and
//   * ONE plan frame carries every tile of that level whose SOUTH-WEST CORNER
//     falls in the cell.
//
// The south-west corner is the assignment rule for a reason: a tile so
// assigned extends at most one tile-span north and east, so its extent lies
// inside the 2x2 neighbourhood and NEVER needs a third cell. Assigning by
// tile CENTRE would reach into the west and south neighbours as well and make
// the granule set 3x3.
//
// LEVEL FLOOR. That argument holds only while a tile is no wider than a
// granule, which is level 8 (180/2^8 = 0.703 degrees) and deeper. Shallower
// levels need many granules per tile and are built by DOWNSAMPLING deeper
// tiles, which is a different lane over the record store and not this one; a
// plan that asks for them is REFUSED by name rather than served a tile with
// most of its extent missing. See the task md.
//
// The enumeration — regions by priority, then level, then cell row-major — is
// a pure function of the config, exactly like the tile-major one, so the
// durable mark stays a single integer: the next CELL index.
// ---------------------------------------------------------------------------

int granule_plan(void) {
    if (refuse_batched()) return 500;

    const std::string tick = input_text("tick");
    const std::string config = load_config();

    const std::string dataset = config_string(config, "dataset_id", kDefaultDatasetId);
    const std::string tileset = config_string(config, "tileset_id", "");
    if (tileset.empty()) {
        plugin_set_error("missing-tileset-id",
                         "granule_plan needs tileset_id; a pyramid with no identity cannot be "
                         "resumed, served or superseded.");
        return 400;
    }
    const std::string epoch = config_string(config, "dataset_epoch", "");
    if (epoch.empty()) {
        plugin_set_error("missing-dataset-epoch",
                         "granule_plan needs dataset_epoch: two tiles are comparable only when "
                         "they name the edition they were cut from.");
        return 400;
    }
    // RETRIEVED_AT is required on every record and is never invented here: the
    // tick carries the run's clock, or the config states it.
    std::string retrieved_at = config_string(config, "retrieved_at", "");
    if (retrieved_at.empty()) json_string_field(tick, "now", &retrieved_at);
    if (retrieved_at.empty()) json_string_field(tick, "timestamp", &retrieved_at);
    if (retrieved_at.empty()) json_string_field(tick, "at", &retrieved_at);
    if (retrieved_at.empty()) {
        plugin_set_error("missing-retrieved-at",
                         "DTTProvenance.RETRIEVED_AT is required on every record and this "
                         "scheduler will not invent a clock: state retrieved_at in the flow "
                         "config or carry now/timestamp/at on the tick frame.");
        return 400;
    }

    const long global_max_level = static_cast<long>(json_number_or(config, "max_level", -1));
    const std::vector<Region> regions =
        parse_regions(config, global_max_level < 0 ? 0 : global_max_level);
    if (regions.empty()) {
        plugin_set_error("no-regions",
                         "granule_plan fails closed with an empty regions list rather than "
                         "inventing a whole-earth plan.");
        return 400;
    }
    long min_level = static_cast<long>(json_number_or(config, "min_level", kGranuleMinLevel));
    if (min_level < kGranuleMinLevel) {
        char message[352];
        std::snprintf(message, sizeof(message),
                      "min_level %ld is shallower than %ld, where one tile stops fitting inside "
                      "one granule (180/2^%ld = %.4f degrees). Shallower levels are built by "
                      "DOWNSAMPLING deeper tiles over the record store, not by fetching; a plan "
                      "that asks this lane for them would build tiles with most of their extent "
                      "missing.",
                      min_level, kGranuleMinLevel, kGranuleMinLevel,
                      180.0 / static_cast<double>(1L << kGranuleMinLevel));
        plugin_set_error("level-below-granule-floor", message);
        return 400;
    }

    const long long total = total_cells(regions, min_level);
    if (total == 0) {
        plugin_set_error("no-cells",
                         "every configured region tops out below min_level; there is nothing "
                         "this lane can build.");
        return 400;
    }

    long long start = 0;
    {
        const std::string mark = input_text("mark");
        if (!mark.empty()) {
            std::string mark_tileset, mark_epoch, mark_dataset;
            json_string_field(mark, "tileset_id", &mark_tileset);
            json_string_field(mark, "dataset_epoch", &mark_epoch);
            json_string_field(mark, "dataset_id", &mark_dataset);
            // A mark for another dataset, tileset or edition says nothing
            // about this walk and is IGNORED rather than half-applied.
            if ((mark_tileset.empty() || mark_tileset == tileset) &&
                (mark_epoch.empty() || mark_epoch == epoch) &&
                (mark_dataset.empty() || mark_dataset == dataset)) {
                start = static_cast<long long>(json_number_or(mark, "next_tile_index", 0));
                if (start < 0) start = 0;
            }
        }
    }
    if (start >= total) {
        // A drained enumeration is a clean no-op, not an error.
        plugin_set_backlog_remaining(0);
        return 0;
    }

    // Scan forward to the next cell that actually holds tiles for its region.
    // A cell the region bbox clips to nothing would otherwise cost four
    // granule fetches to build zero tiles.
    const std::string base = config_string(config, "granule_base_url", kDefaultGranuleBase);
    const long grid = static_cast<long>(json_number_or(config, "grid_size", kDefaultGridSize));
    const long timeout_ms = config_timeout_ms(config);

    PlannedCell cell;
    std::string tiles_json;
    long long index = start;
    long tile_count = 0;
    for (; index < total; index++) {
        if (!cell_at_index(regions, min_level, index, &cell)) break;
        const Region& r = *cell.region;
        const double size = tile_size_deg(cell.level);
        const TileBlock block = region_block(r, cell.level);
        // Tiles of this level whose SOUTH-WEST CORNER lies in the cell.
        const long x0 = clampl(static_cast<long>(std::ceil((cell.lon + 180.0) / size - 1e-9)),
                               block.x0, block.x1);
        const long x1 = clampl(static_cast<long>(std::floor((cell.lon + 1 + 180.0) / size - 1e-9)),
                               block.x0, block.x1);
        const long y0 = clampl(static_cast<long>(std::ceil((cell.lat + 90.0) / size - 1e-9)),
                               block.y0, block.y1);
        const long y1 = clampl(static_cast<long>(std::floor((cell.lat + 1 + 90.0) / size - 1e-9)),
                               block.y0, block.y1);
        tiles_json.clear();
        tile_count = 0;
        for (long y = y0; y <= y1; y++) {
            for (long x = x0; x <= x1; x++) {
                const double west = -180.0 + x * size;
                const double south = -90.0 + y * size;
                if (west < cell.lon || west >= cell.lon + 1) continue;
                if (south < cell.lat || south >= cell.lat + 1) continue;
                // CHILD_AVAILABILITY is a STATEMENT ABOUT THIS TILESET, so it
                // is computed against the region's own block at level+1 rather
                // than assumed to be "all four".
                unsigned children = 0;
                if (cell.level < r.max_level) {
                    const TileBlock cb = region_block(r, cell.level + 1);
                    const long cx = x * 2, cy = y * 2;
                    const auto has = [&](long ax, long ay) {
                        return ax >= cb.x0 && ax <= cb.x1 && ay >= cb.y0 && ay <= cb.y1;
                    };
                    if (has(cx, cy)) children |= 1u;          // south-west
                    if (has(cx + 1, cy)) children |= 2u;      // south-east
                    if (has(cx, cy + 1)) children |= 4u;      // north-west
                    if (has(cx + 1, cy + 1)) children |= 8u;  // north-east
                }
                if (!tiles_json.empty()) tiles_json += ",";
                tiles_json += "{\"x\":" + std::to_string(x) + ",\"y\":" + std::to_string(y) +
                              ",\"childAvailability\":" + std::to_string(children) + "}";
                tile_count++;
            }
        }
        if (tile_count > 0) break;
    }
    if (tile_count == 0) {
        plugin_set_backlog_remaining(0);
        return 0;
    }

    // The 2x2 granule neighbourhood, ALWAYS four descriptors so the flow's
    // http nodes are fed unconditionally. Longitude wraps, latitude clamps.
    const std::string primary_dem =
        dem_url(base, static_cast<int>(cell.lat), static_cast<int>(wrap_lon(cell.lon)));
    for (int dy = 0; dy < 2; dy++) {
        for (int dx = 0; dx < 2; dx++) {
            const long lat = clampl(cell.lat + dy, -90, 89);
            const long lon = wrap_lon(cell.lon + dx);
            const int slot = dy * 2 + dx;
            char dem_port[16], wbm_port[16];
            std::snprintf(dem_port, sizeof(dem_port), "dem_%d", slot);
            std::snprintf(wbm_port, sizeof(wbm_port), "wbm_%d", slot);
            if (push_json(dem_port,
                          granule_request(dem_url(base, static_cast<int>(lat),
                                                  static_cast<int>(lon)),
                                          timeout_ms)) < 0) {
                return 500;
            }
            if (push_json(wbm_port,
                          granule_request(wbm_url(base, static_cast<int>(lat),
                                                  static_cast<int>(lon)),
                                          timeout_ms)) < 0) {
                return 500;
            }
        }
    }

    // The encoder's plan. Provenance keys are the ones DTTProvenance is built
    // from, verbatim — this is where the scheduler's snake_case config becomes
    // the record contract, and nothing in it is defaulted.
    const std::string provenance =
        std::string("{\"datasetId\":\"") + json_escape(dataset) + "\"" + ",\"datasetName\":\"" +
        json_escape(config_string(config, "dataset_name", kDefaultSourceName)) + "\"" +
        ",\"datasetEpoch\":\"" + json_escape(epoch) + "\"" + ",\"retrievedAt\":\"" +
        json_escape(retrieved_at) + "\"" + ",\"license\":\"" +
        json_escape(config_string(config, "license", kDefaultLicense)) + "\"" +
        ",\"licenseUrl\":\"" + json_escape(config_string(config, "license_url", kDefaultLicenseUrl)) +
        "\"" + ",\"attribution\":\"" +
        json_escape(config_string(config, "attribution", kDefaultAttribution)) + "\"" +
        ",\"sourceUrl\":\"" + json_escape(primary_dem) + "\"}";

    const std::string plan =
        std::string("{\"tilesetId\":\"") + json_escape(tileset) + "\"" +
        ",\"scheme\":\"GEOGRAPHIC_WGS84\",\"rowOriginNorth\":false" +
        ",\"level\":" + std::to_string(cell.level) + ",\"gridSize\":" + std::to_string(grid) +
        ",\"maxLevel\":" + std::to_string(cell.region->max_level) +
        // Ocean tiles are NOT stored: they are identical, there are millions of
        // them, and the serving lane synthesizes an unstored address inside
        // published availability as exactly that.
        ",\"skipOceanTiles\":true" +
        ",\"verticalDatumName\":\"" +
        json_escape(config_string(config, "vertical_datum_name", "EGM2008")) + "\"" +
        ",\"provenance\":" + provenance + ",\"tiles\":[" + tiles_json + "]}";
    if (push_json("plan", plan) < 0) return 500;

    const std::string job =
        std::string("{\"lane\":\"") + kLane + "\"" + ",\"dataset_id\":\"" +
        json_escape(dataset) + "\"" + ",\"tileset_id\":\"" + json_escape(tileset) + "\"" +
        ",\"dataset_epoch\":\"" + json_escape(epoch) + "\"" +
        ",\"first_tile_index\":" + std::to_string(index) +
        // THE MARK'S STRIDE, and it is 1 BY CONTRACT. publish_request advances
        // the durable mark by first_tile_index + tiles_planned, and the unit of
        // this enumeration is ONE CELL — so a stride of tile_count here would
        // skip every cell but the first and leave the rest of the pyramid
        // unbuilt with nothing to show for it. The tile count rides as
        // cell_tiles, for reporting.
        ",\"tiles_planned\":1" +
        ",\"cell_tiles\":" + std::to_string(tile_count) + ",\"total_tiles\":" +
        std::to_string(total) + ",\"cell_index\":" + std::to_string(index) +
        ",\"cell_lon\":" + std::to_string(cell.lon) + ",\"cell_lat\":" +
        std::to_string(cell.lat) + ",\"level\":" + std::to_string(cell.level) +
        ",\"region\":\"" + json_escape(cell.region->name) + "\"" + ",\"provider_id\":\"" +
        json_escape(config_string(config, "provider_id", kDefaultProviderId)) + "\"" +
        ",\"source_name\":\"" +
        json_escape(config_string(config, "source_name", kDefaultSourceName)) + "\"" +
        ",\"granule_base_url\":\"" + json_escape(base) + "\"" + ",\"license\":\"" +
        json_escape(config_string(config, "license", kDefaultLicense)) + "\"" +
        ",\"attribution\":\"" +
        json_escape(config_string(config, "attribution", kDefaultAttribution)) + "\"}";
    if (push_json("job", job) < 0) return 500;

    const long long backlog = total - (index + 1);
    plugin_set_backlog_remaining(
        backlog > 0xffffffffLL ? 0xffffffffu : static_cast<uint32_t>(backlog < 0 ? 0 : backlog));
    return 0;
}

// ingest_meta: the terrain-source `job`, the tile record stream, the optional
// build `decision` and raw http `response` -> the hostcap/storage-ingest
// `meta` frame and the records, forwarded untouched. This node exists to
// author the attribution the storage lane cannot invent — dataset, batch,
// epoch — and to read the ETag/Last-Modified only the response carries.
int ingest_meta(void) {
    if (refuse_batched()) return 500;

    const std::string job = input_text("job");
    if (job.empty()) {
        plugin_set_error("missing-job-frame", "ingest_meta requires the run-contract job frame.");
        return 400;
    }
    const plugin_input_frame_t* records = frame_for("records");
    if (!records || !records->payload) {
        plugin_set_error("missing-records-frame",
                         "ingest_meta requires the terrain tile record stream.");
        return 400;
    }

    const std::string config = load_config();
    std::string dataset, tileset, epoch;
    json_string_field(job, "dataset_id", &dataset);
    json_string_field(job, "tileset_id", &tileset);
    json_string_field(job, "dataset_epoch", &epoch);
    if (dataset.empty() || tileset.empty() || epoch.empty()) {
        plugin_set_error("incomplete-job-attribution",
                         "ingest_meta needs dataset_id, tileset_id and dataset_epoch on the job "
                         "frame; storage cannot invent the edition a tile belongs to.");
        return 400;
    }
    const long long first_index =
        static_cast<long long>(json_number_or(job, "first_tile_index", 0));
    const long tiles_planned = static_cast<long>(json_number_or(job, "tiles_planned", 0));

    const std::string response = input_text("response");
    const std::string headers = headers_object(response);
    const std::string etag = header_value(headers, "etag", "ETag");
    const std::string last_modified = header_value(headers, "last-modified", "Last-Modified");

    // The tile count this batch actually produced, from the builder's
    // decision; -1 (absent) disables the silent-nop check rather than faking
    // a count.
    const std::string decision = input_text("decision");
    const long records_in =
        decision.empty() ? -1 : static_cast<long>(json_number_or(decision, "recordsOut", -1));

    // ONE BATCH PER (tileset, epoch, batch start): re-running a batch is
    // idempotent at the storage lane and two batches never collide.
    const std::string batch_id =
        tileset + "@" + epoch + "#" + std::to_string(first_index);

    const std::string provenance =
        std::string("{\"tileset_id\":\"") + json_escape(tileset) + "\"" + ",\"lane\":\"" + kLane +
        "\"" + ",\"dataset_epoch\":\"" + json_escape(epoch) + "\"" +
        ",\"first_tile_index\":" + std::to_string(first_index) + "}";

    const std::string meta =
        std::string("{\"schema\":\"") + kSchema + "\"" + ",\"provider_id\":\"" +
        json_escape(config_string(config, "provider_id", kDefaultProviderId)) + "\"" +
        ",\"source_name\":\"" +
        json_escape(config_string(config, "source_name", kDefaultSourceName)) + "\"" +
        ",\"batch_id\":\"" + json_escape(batch_id) + "\"" +
        // `append`: a batch is a WINDOW of the pyramid, never the tileset's
        // complete set, so a source-batch reconcile on it would delete every
        // tile outside the window.
        ",\"reconcile\":\"append\"" + ",\"dataset_id\":\"" + json_escape(dataset) + "\"" +
        ",\"dataset_epoch\":\"" + json_escape(epoch) + "\"" + ",\"lane\":\"" + kLane + "\"" +
        ",\"tileset_id\":\"" + json_escape(tileset) + "\"" +
        ",\"first_tile_index\":" + std::to_string(first_index) +
        ",\"tiles_planned\":" + std::to_string(tiles_planned) + ",\"etag\":\"" +
        json_escape(etag) + "\"" + ",\"last_modified\":\"" + json_escape(last_modified) + "\"" +
        ",\"records_in\":" + std::to_string(records_in) +
        ",\"provenance\":{\"source\":\"terrain-ingest-wasm/v1\"" + ",\"json\":\"" +
        base64_encode(reinterpret_cast<const uint8_t*>(provenance.data()), provenance.size()) +
        "\"}}";

    if (push_json("meta", meta) < 0) return 500;
    // The record stream is OPAQUE to this scheduler — forwarded byte-for-byte.
    if (plugin_push_output_ex("records", nullptr, nullptr,
                              PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                              records->payload, records->payload_length) < 0) {
        return 500;
    }
    return 0;
}

// publish_request: the storage-ingest `result` joined with the `meta` that
// produced it -> the advanced resume mark, and (only when configured) the
// dataset-publication POST announcing the batch.
//
// The mark is emitted on its own port and is NOT gated on the publish URL: a
// node that stores without publishing must still make progress, or an
// unpublished deployment replans the same batch forever.
int publish_request(void) {
    if (refuse_batched()) return 500;

    const std::string result = input_text("result");
    if (result.empty()) {
        plugin_set_error("missing-result-frame",
                         "publish_request requires the storage-ingest result frame.");
        return 400;
    }
    const std::string meta = input_text("meta");
    if (meta.empty()) {
        plugin_set_error("missing-meta-frame", "publish_request requires the ingest meta frame.");
        return 400;
    }

    std::string dataset, tileset, epoch, batch_id, etag, last_modified;
    json_string_field(meta, "dataset_id", &dataset);
    json_string_field(meta, "tileset_id", &tileset);
    json_string_field(meta, "dataset_epoch", &epoch);
    json_string_field(meta, "batch_id", &batch_id);
    json_string_field(meta, "etag", &etag);
    json_string_field(meta, "last_modified", &last_modified);
    const long long first_index =
        static_cast<long long>(json_number_or(meta, "first_tile_index", 0));
    const long tiles_planned = static_cast<long>(json_number_or(meta, "tiles_planned", 0));

    // THE SILENT NOP, CAUGHT — same shape as the gazetteer lane:
    // hostcap/storage-ingest errors on ok:false, but ok:true with inserted=0
    // for a batch that carried tiles is byte-identical to a batch of pure
    // ocean no-data tiles the builder skipped. It is only distinguishable
    // against the count the run actually produced, so the mark does NOT
    // advance over tiles that were never stored.
    const long inserted = static_cast<long>(json_number_or(result, "inserted", -1));
    const long records_in = static_cast<long>(json_number_or(meta, "records_in", -1));
    if (inserted == 0 && records_in > 0) {
        char message[288];
        std::snprintf(message, sizeof(message),
                      "storage.ingest_with_source reported ok with inserted=0 for a batch "
                      "carrying %ld tiles (tileset %s, batch %s). The resume mark is NOT "
                      "advanced: advancing it would leave a permanent hole in the pyramid "
                      "that every later tick walks past.",
                      records_in, tileset.c_str(), batch_id.c_str());
        plugin_set_error("ingest-stored-nothing", message);
        return 502;
    }

    const std::string next_mark =
        mark_json(dataset, tileset, epoch, first_index + tiles_planned, etag, last_modified,
                  batch_id, tiles_planned);
    if (push_json("mark", next_mark) < 0) return 500;

    const std::string config = load_config();
    std::string publish_url;
    if (!json_string_field(config, "publish_url", &publish_url) || publish_url.empty()) {
        // Fail-closed. Absence of configuration is not permission to publish.
        return 0;
    }

    std::string schema;
    if (!json_string_field(result, "schema", &schema) || schema.empty()) {
        json_string_field(meta, "schema", &schema);
    }
    std::string provider, source;
    json_string_field(meta, "provider_id", &provider);
    json_string_field(meta, "source_name", &source);
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) {
        plugin_set_error("incomplete-publication-identity",
                         "publish_request needs schema, batchId, providerId and sourceName.");
        return 400;
    }

    const std::string body = std::string("{\"schema\":\"") + json_escape(schema) + "\"" +
                             ",\"providerId\":\"" + json_escape(provider) + "\"" +
                             ",\"sourceName\":\"" + json_escape(source) + "\"" +
                             ",\"batchId\":\"" + json_escape(batch_id) + "\"}";
    const std::string request =
        std::string("{\"method\":\"POST\",\"url\":\"") + json_escape(publish_url) + "\"" +
        ",\"headers\":{\"content-type\":\"application/json\"}" + ",\"bodyB64\":\"" +
        base64_encode(reinterpret_cast<const uint8_t*>(body.data()), body.size()) + "\"" +
        ",\"timeoutMs\":" + std::to_string(config_timeout_ms(config)) + "}";
    return push_json("request", request) < 0 ? 500 : 0;
}

}  // extern "C"
