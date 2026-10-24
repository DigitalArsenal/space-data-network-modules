/*
 * data-source/terrain-ingest (graph task `sdn-terrain-serving-module`).
 *
 * The ORCHESTRATION half of the terrain lane. `terrain-source` (a sibling
 * module, built separately) is the request-scoped decoder — DEM/WBM bytes in,
 * terrain tiles out, nothing persisted — and this module is the scheduler that
 * decides WHICH tiles to build, in WHAT order, and where to resume after a
 * restart. Same split, same reasoning as geonames-source / geonames-ingest.
 *
 * Methods (typed contracts 1.0: FlatBuffers only, no JSON and no base64 between modules):
 *   mark_query      TimerTick                     -> $FSO query           (read the mark through flatsql-query)
 *   ingest_plan     TimerTick + $FSB mark?        -> $DTT plan headers, $IRM job   (tile-major, bounded batch)
 *   granule_plan    TimerTick + $FSB mark?        -> 8 HttpRequests, $DTT plan headers, MCFG options, $IRM job
 *   ingest_meta     $IRM job + $DTT records + FlowNotice report? + HttpResponse? -> IngestRequest meta, $DTT records
 *   publish_request IngestResult + IngestRequest + $IRM job -> $IRM mark (storage-write + egress), HttpRequest?
 *   import_plan     TimerTick + $FSB mark?        -> HttpRequests (a walk unit's staged files), $PNM names, $IRM job
 *   import_files    HttpResponses + $PNM names    -> the files ($DTT streams, checked against their names), $PNM names
 *
 * THE JOB IS THE MARK-TO-BE. The planners emit, per batch, the $IRM this batch will make durable once it is stored:
 * JOB_ID (dataset@tileset@epoch), PROVIDER_ID, SOURCE (SOURCE_URL, SOURCE_VERSION = the edition), STATE IN_PROGRESS,
 * RANGE_MODE PART_INDEX, LAST_CHUNK.CHUNK_INDEX = the first index of the batch, NEXT_CHUNK_INDEX = that index plus
 * the batch's stride (1 for a granule cell, the tile count for a tile-major batch), RECORDS_COMMITTED = what the mark
 * this run resumed from had already committed, TARGET_STANDARD, RECONCILE_MODE, UPDATED_AT/STARTED_AT = the run's
 * clock, TAGS (walk:cell | walk:tile, lane:terrain) and NOTES (region, level, cell, tiles planned). publish_request
 * completes it FROM THE VERIFIED STORE RESULT - RECORDS_COMMITTED += inserted, LAST_CHUNK.BATCH_ID / RECORDS_STORED /
 * COMMITTED_AT, SOURCE.ENTITY_TAG / LAST_MODIFIED from the IngestRequest's provenance, STATE COMPLETE when the walk is
 * done - and emits it as the durable $IRM. No JSON state rides in DECODE_CONTEXT any more: the resume position is the
 * record's own NEXT_CHUNK_INDEX / RECORDS_COMMITTED (an older mark that carried the JSON state also carried those, so
 * it still resumes; one whose stamps disagree is still refused).
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

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <map>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "TimerTick_generated.h"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"
#include "FlowNotice_generated.h"
#include "ModuleConfig_generated.h"
// $IRM, $DTT, $FSO and $FSB (spacedatastandards.org lib/cpp/<CODE>/main_generated.h) are inlined ahead of this file by
// build.mjs.


namespace {

constexpr long kDefaultTimeoutMs = 90000;
constexpr long kDefaultBatchTiles = 64;
constexpr long kMaxBatchTiles = 256;
constexpr long kDefaultGlobalMaxLevel = 10;
constexpr const char* kSchema = "DTT";
constexpr const char* kIngestorId = "terrain-ingest-wasm/v1";
// ── THE DURABLE RESUME MARK IS $IRM ────────────────────────────────────────
//
// It used to be ad-hoc JSON read back with
// `SELECT * FROM terrain_ingest_mark WHERE dataset_id = ? LIMIT 1`, and that
// query could never return a row on any real node. Every embedded standard is
// served through a generated FlatSQL unified view named by its SDS CODE over
// `_data`/`_rowid` (owner law 2026-08-25; sdn storage/engine_records.go builds
// the view graph), and `terrain_ingest_mark` is not an SDS code, so no relation
// by that name exists. Worse, nothing WROTE it: the flow routed publish.mark to
// egress and declared no storage-write capability, so granule_plan restarted at
// cell 0 on every tick — silently, because an absent mark is a valid first run
// and never an error. It only appeared to resume because the off-fleet runner
// substituted a local resume-mark.json for the storage op.
//
// $IRM was minted and ratified in SDS 1.196.0 — the version this lane pins —
// for exactly this record. The mark is authored here, hostcap/storage-write
// persists it under the storage_write grant, and hostcap/flatsql-query reads it
// back through the code-named view. Same lane, same shape, same reasoning as
// data-source/cell-tower-ingest.
constexpr const char* kDefaultMarkSql = "SELECT _data FROM IRM ORDER BY _rowid DESC LIMIT ?";
constexpr long kDefaultMarkScanRows = 32;
// MARKS WRITTEN BEFORE TYPED CONTRACTS 1.0 carried a JSON copy of the resume state in DECODE_CONTEXT.DECODER_STATE
// under these stamps. This build writes no DECODER_STATE (the position is the record's own NEXT_CHUNK_INDEX and
// RECORDS_COMMITTED, which those marks also state), but it still COMPARES the stamps of a mark that carries them, as
// $IRM requires: a stamp that is present and different restarts the walk rather than resuming into an unknown shape.
constexpr const char* kIrmResumeStateFormat = "terrain-ingest/resume-v1";
constexpr const char* kIrmResumeStateVersion = "1";
constexpr const char* kIrmResumeStateMediaType = "application/json";
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

// Preserve the existing omitted-ocean default; retaining observed native
// records is an explicit boolean opt-in for complete sibling reduction.
bool ocean_skip_option(const std::string& config, bool* out) {
    *out = true;
    const std::string key = "\"skipOceanTiles\"";
    const size_t at = config.find(key);
    if (at == std::string::npos) return true;
    size_t pos = at + key.size();
    while (pos < config.size() && is_ws(config[pos])) pos++;
    if (pos == config.size() || config[pos++] != ':') return false;
    while (pos < config.size() && is_ws(config[pos])) pos++;
    size_t length = 0;
    if (config.compare(pos, 4, "true") == 0) length = 4;
    else if (config.compare(pos, 5, "false") == 0) { length = 5; *out = false; }
    else return false;
    pos += length;
    while (pos < config.size() && is_ws(config[pos])) pos++;
    return pos < config.size() && (config[pos] == ',' || config[pos] == '}');
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




// SURPLUS-FRAME REFUSAL — see the long note in cell_tower_ingest_module.cpp.
// The compiled flow runtime drains a node's queue PORT-BLIND up to a budget of
// 64 while maxStreams/maxBatch/drainPolicy are declarative only, so a guest
// that reads ordinal 0 and returns destroys every other frame it was handed.
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        // "mark" carries hostcap/flatsql-query's answer as ordered $FSB chunks: several frames there are one answer.
        if (std::strcmp(frame->port_id, "mark") == 0) continue;
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


// ── $IRM: the durable mark, read and written ───────────────────────────────

// SHA-256, for the DECODER_STATE_SHA256 stamp. $IRM asks for 64 lowercase hex
// characters over the DECODER_STATE bytes, so this is the raw digest and not
// the multihash form the tile records use for payload DIGEST.
struct Sha256 {
    uint32_t h[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                     0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
    uint8_t block[64] = {0};
    size_t block_len = 0;
    uint64_t total_bits = 0;

    static uint32_t rotr(uint32_t v, int n) { return (v >> n) | (v << (32 - n)); }

    void compress(const uint8_t* p) {
        static const uint32_t k[64] = {
            0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,
            0x923f82a4u,0xab1c5ed5u,0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,
            0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,0xe49b69c1u,0xefbe4786u,
            0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
            0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,
            0x06ca6351u,0x14292967u,0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,
            0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,0xa2bfe8a1u,0xa81a664bu,
            0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
            0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,
            0x5b9cca4fu,0x682e6ff3u,0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,
            0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
        uint32_t w[64];
        for (int i = 0; i < 16; i++) {
            w[i] = (static_cast<uint32_t>(p[i * 4]) << 24) |
                   (static_cast<uint32_t>(p[i * 4 + 1]) << 16) |
                   (static_cast<uint32_t>(p[i * 4 + 2]) << 8) |
                   static_cast<uint32_t>(p[i * 4 + 3]);
        }
        for (int i = 16; i < 64; i++) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
        uint32_t e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; i++) {
            const uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const uint32_t ch = (e & f) ^ (~e & g);
            const uint32_t t1 = hh + S1 + ch + k[i] + w[i];
            const uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t t2 = S0 + maj;
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d;
        h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }

    void update(const uint8_t* data, size_t len) {
        total_bits += static_cast<uint64_t>(len) * 8u;
        while (len > 0) {
            const size_t take = std::min(len, static_cast<size_t>(64) - block_len);
            std::memcpy(block + block_len, data, take);
            block_len += take;
            data += take;
            len -= take;
            if (block_len == 64) { compress(block); block_len = 0; }
        }
    }

    std::string hex() {
        const uint64_t bits = total_bits;
        uint8_t pad = 0x80;
        update(&pad, 1);
        total_bits = bits;  // the padding is not message length
        pad = 0x00;
        while (block_len != 56) { update(&pad, 1); total_bits = bits; }
        uint8_t tail[8];
        for (int i = 0; i < 8; i++) tail[i] = static_cast<uint8_t>((bits >> (56 - 8 * i)) & 0xff);
        std::memcpy(block + block_len, tail, 8);
        compress(block);
        block_len = 0;
        static const char* digits = "0123456789abcdef";
        std::string out;
        out.reserve(64);
        for (int i = 0; i < 8; i++) {
            for (int b = 3; b >= 0; b--) {
                const uint8_t byte = static_cast<uint8_t>((h[i] >> (8 * b)) & 0xff);
                out.push_back(digits[byte >> 4]);
                out.push_back(digits[byte & 0x0f]);
            }
        }
        return out;
    }
};

std::string sha256_hex(const std::string& bytes) {
    Sha256 sha;
    if (!bytes.empty())
        sha.update(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
    return sha.hex();
}




// One job, one lane: the dataset, the tileset and the EDITION. A new epoch is a
// new job rather than a mark that has to be sanity-checked, which is what makes
// "resuming tileset A from tileset B's index" unrepresentable instead of
// merely refused.
std::string mark_job_id(const std::string& dataset, const std::string& tileset,
                        const std::string& epoch) {
    return dataset + "@" + tileset + "@" + epoch;
}





// ── typed frame IO ─────────────────────────────────────────────────────────

namespace R = sdn::runtime;
namespace A = sdn::runtime::Aligned;
using Bytes = std::vector<uint8_t>;

Bytes finished(const flatbuffers::FlatBufferBuilder& b) { return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize()); }

int push_typed(const char* port, const char* schema, const char* id, const char* root, const Bytes& bytes) {
    return plugin_push_output_ex(port, schema, id, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, bytes.data(),
                                 static_cast<uint32_t>(bytes.size()));
}

std::string text_of(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

// RFC 3339 UTC, fixed milliseconds.
std::string iso_ms(int64_t ms) {
    const int64_t days = (ms >= 0 ? ms : ms - 86399999) / 86400000;
    const int64_t z = days + 719468, era = (z >= 0 ? z : z - 146096) / 146097, doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365, doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153, d = doy - (153 * mp + 2) / 5 + 1, m = mp < 10 ? mp + 3 : mp - 9;
    const int64_t y = yoe + era * 400 + (m <= 2);
    const int64_t rem = ms - days * 86400000;
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%03lldZ", static_cast<long long>(y),
                  static_cast<long long>(m), static_cast<long long>(d), static_cast<long long>(rem / 3600000),
                  static_cast<long long>((rem / 60000) % 60), static_cast<long long>((rem / 1000) % 60),
                  static_cast<long long>(rem % 1000));
    return buf;
}

// The run's clock: the TimerTick's FIRED_MS (else SCHEDULED_MS), never a guest clock read. 0 = the tick states none
// (or no TimerTick arrived); -1 = the frame is present and is not a TimerTick.
int64_t tick_ms() {
    const plugin_input_frame_t* f = frame_for("tick");
    if (!f) return 0;
    flatbuffers::Verifier verifier(f->payload ? f->payload : reinterpret_cast<const uint8_t*>(""),
                                   f->payload ? f->payload_length : 0);
    if (!f->payload || f->payload_length < 8 || !R::VerifyTimerTickBuffer(verifier)) return -1;
    const R::TimerTick* tick = R::GetTimerTick(f->payload);
    return static_cast<int64_t>(tick->FIRED_MS() ? tick->FIRED_MS() : tick->SCHEDULED_MS());
}

// ── THE NODE CONFIG, TYPED ─────────────────────────────────────────────────
//
// plugin.getConfig is an SDS $PIV hostcall answering one ModuleConfig FlatBuffer (MCFG) on raw "config"
// (sdm_piv::get_config, read in place). The readers below were written against the config as ONE nested object, so
// the ModuleConfig is rendered as exactly that object - scalars as themselves, NumberList / StringList as arrays, a
// TableList (regions: [{west, south, ...}]) as an array of objects - and read by the same code. The config is a few
// scalars and a short region list; nothing JSON crosses a port.
std::string config_number_literal(double v) {
    char buf[40];
    if (std::isfinite(v) && v == std::floor(v) && std::fabs(v) < 1e15) {
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v));
        return buf;
    }
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    return buf;
}

std::string config_table_json(const sdm_piv::ConfigEntries* entries, int depth = 0) {
    std::string out = "{";
    bool first = true;
    for (size_t i = 0; entries && depth < 32 && i < entries->size(); i++) {
        const R::ConfigEntry* e = entries->Get(static_cast<flatbuffers::uoffset_t>(i));
        if (!e || !e->KEY() || e->KEY()->size() == 0) continue;
        std::string value;
        switch (e->KIND()) {
            case R::configValueKind_String:
                value = "\"" + json_escape(e->STRING_VALUE() ? e->STRING_VALUE()->str() : std::string()) + "\"";
                break;
            case R::configValueKind_Number: value = config_number_literal(e->NUMBER_VALUE()); break;
            case R::configValueKind_Bool: value = e->BOOL_VALUE() ? "true" : "false"; break;
            case R::configValueKind_NumberList:
                value = "[";
                if (e->NUMBERS())
                    for (flatbuffers::uoffset_t k = 0; k < e->NUMBERS()->size(); k++)
                        value += (k ? "," : "") + config_number_literal(e->NUMBERS()->Get(k));
                value += "]";
                break;
            case R::configValueKind_StringList:
                value = "[";
                if (e->STRINGS())
                    for (flatbuffers::uoffset_t k = 0; k < e->STRINGS()->size(); k++)
                        value += std::string(k ? "," : "") + "\"" + json_escape(e->STRINGS()->Get(k)->str()) + "\"";
                value += "]";
                break;
            case R::configValueKind_TableList:
                value = "[";
                if (e->TABLES())
                    for (flatbuffers::uoffset_t k = 0; k < e->TABLES()->size(); k++)
                        value += (k ? "," : "") + config_table_json(e->TABLES()->Get(k)->ENTRIES(), depth + 1);
                value += "]";
                break;
            default: continue;
        }
        out += (first ? "\"" : ",\"") + json_escape(e->KEY()->str()) + "\":" + value;
        first = false;
    }
    return out + "}";
}

std::string load_config() {
    const sdm_piv::Config config = sdm_piv::get_config();
    if (!config.ok()) return "{}";
    return config_table_json(config.entries());
}

// ── the durable mark, read ─────────────────────────────────────────────────

struct MarkState {
    bool found = false;
    long long next_index = 0;
    long long stored_total = 0;
    std::string etag;
};

// hostcap/flatsql-query's answer on the "mark" port: $FSB chunks (CHUNK_SEQUENCE 0..n-1) whose DATA, in order, is
// the aligned size-prefixed record stream the engine returned (zero-length prefixes are alignment padding). false:
// a frame that is not an $FSB, or a chunk sequence with a hole.
bool mark_stream(Bytes* out) {
    std::vector<std::pair<uint32_t, const FSB*>> chunks;
    for (uint32_t ordinal = 0;; ordinal++) {
        const int32_t idx = plugin_find_input_index("mark", ordinal);
        if (idx < 0) break;
        const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
        flatbuffers::Verifier verifier(f && f->payload ? f->payload : reinterpret_cast<const uint8_t*>(""),
                                       f && f->payload ? f->payload_length : 0);
        if (!f || !f->payload || f->payload_length < 8 || !VerifyFSBBuffer(verifier)) return false;
        const FSB* chunk = GetFSB(f->payload);
        chunks.push_back({chunk->CHUNK_SEQUENCE(), chunk});
    }
    std::sort(chunks.begin(), chunks.end(),
              [](const std::pair<uint32_t, const FSB*>& a, const std::pair<uint32_t, const FSB*>& b) { return a.first < b.first; });
    for (size_t i = 0; i < chunks.size(); i++) {
        if (chunks[i].first != i) return false;
        if (const auto* d = chunks[i].second->DATA()) out->insert(out->end(), d->begin(), d->end());
    }
    return true;
}

// The newest mark for this JOB_ID (the query returns the newest few rows first, so several lanes can share one
// relation; a mark for another job is skipped, never half-applied). ABANDONED and INVALIDATED marks are not resume
// points ($IRM): the walk restarts.
MarkState read_mark(const Bytes& stream, const std::string& want_job) {
    MarkState m;
    size_t at = 0;
    while (at + 4 <= stream.size()) {
        const uint32_t size = static_cast<uint32_t>(stream[at]) | (static_cast<uint32_t>(stream[at + 1]) << 8) |
                              (static_cast<uint32_t>(stream[at + 2]) << 16) | (static_cast<uint32_t>(stream[at + 3]) << 24);
        at += 4;
        if (size == 0) continue;
        if (size > stream.size() - at) break;
        const uint8_t* root = stream.data() + at;
        at += size;
        flatbuffers::Verifier verifier(root, size);
        if (size < 8 || !IRMBufferHasIdentifier(root) || !VerifyIRMBuffer(verifier)) continue;
        const IRM* irm = GetIRM(root);
        if (text_of(irm->JOB_ID()) != want_job) continue;
        if (irm->STATE() == irmJobState_ABANDONED || irm->STATE() == irmJobState_INVALIDATED) return m;
        if (const IRMDecodeContext* decode = irm->DECODE_CONTEXT()) {
            // A mark written before typed contracts 1.0: every stamp it carries is compared before it is trusted.
            const auto disagrees = [](const flatbuffers::String* stamped, const std::string& expected) {
                return stamped != nullptr && stamped->str() != expected;
            };
            if (decode->DECODER_STATE()) {
                const std::string state(reinterpret_cast<const char*>(decode->DECODER_STATE()->Data()),
                                        decode->DECODER_STATE()->size());
                if (decode->DECODER_STATE_FORMAT() == nullptr ||
                    disagrees(decode->DECODER_STATE_FORMAT(), kIrmResumeStateFormat) ||
                    disagrees(decode->DECODER_STATE_VERSION(), kIrmResumeStateVersion) ||
                    disagrees(decode->DECODER_STATE_MEDIA_TYPE(), kIrmResumeStateMediaType) ||
                    (decode->DECODER_STATE_BYTE_LENGTH() != 0 && decode->DECODER_STATE_BYTE_LENGTH() != state.size()) ||
                    disagrees(decode->DECODER_STATE_SHA256(), sha256_hex(state))) {
                    return m;
                }
            }
        }
        m.found = true;
        m.next_index = static_cast<long long>(irm->NEXT_CHUNK_INDEX());
        m.stored_total = static_cast<long long>(irm->RECORDS_COMMITTED());
        if (irm->SOURCE() && irm->SOURCE()->ENTITY_TAG()) m.etag = irm->SOURCE()->ENTITY_TAG()->str();
        return m;
    }
    return m;
}

// ── the job ($IRM, the mark-to-be) ─────────────────────────────────────────

struct Job {
    std::string job_id, provider, source_url, epoch, updated_at, walk, notes, etag, last_modified, batch_id;
    long long first_index = 0, next_index = 0, records_committed = 0, chunk_records = -1;
    bool complete = false;
};

Bytes build_irm(const Job& j, bool committed) {
    flatbuffers::FlatBufferBuilder b(2048);
    const auto job_off = b.CreateString(j.job_id);
    const auto provider_off = b.CreateString(j.provider);
    const auto ingestor_off = b.CreateString(kIngestorId);
    const auto updated_off = b.CreateString(j.updated_at);
    const auto target_off = b.CreateString(kSchema);
    // The mode the storage lane is actually asked for; see ingest_meta.
    const auto reconcile_off = b.CreateString("none");
    const auto source_url_off = b.CreateString(j.source_url);
    const auto version_off = j.epoch.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(j.epoch);
    const auto etag_off = j.etag.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(j.etag);
    const auto modified_off = j.last_modified.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(j.last_modified);
    IRMSourceBuilder sb(b);
    sb.add_SOURCE_URL(source_url_off);
    if (!version_off.IsNull()) sb.add_SOURCE_VERSION(version_off);
    if (!etag_off.IsNull()) sb.add_ENTITY_TAG(etag_off);
    if (!modified_off.IsNull()) sb.add_LAST_MODIFIED(modified_off);
    const auto source_off = sb.Finish();
    const auto batch_off = j.batch_id.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(j.batch_id);
    const auto committed_off = committed ? b.CreateString(j.updated_at) : flatbuffers::Offset<flatbuffers::String>();
    IRMChunkBuilder cb(b);
    cb.add_CHUNK_INDEX(static_cast<uint32_t>(j.first_index));
    if (!batch_off.IsNull()) cb.add_BATCH_ID(batch_off);
    if (committed && j.chunk_records >= 0) cb.add_RECORDS_STORED(static_cast<uint32_t>(j.chunk_records));
    if (!committed_off.IsNull()) cb.add_COMMITTED_AT(committed_off);
    const auto chunk_off = cb.Finish();
    std::vector<flatbuffers::Offset<flatbuffers::String>> tags;
    tags.push_back(b.CreateString("lane:terrain"));
    tags.push_back(b.CreateString("walk:" + j.walk));
    const auto tags_off = b.CreateVector(tags);
    const auto notes_off = j.notes.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(j.notes);
    IRMBuilder ib(b);
    ib.add_JOB_ID(job_off);
    ib.add_SEQUENCE(static_cast<uint64_t>(committed ? j.next_index : j.first_index));
    ib.add_PROVIDER_ID(provider_off);
    ib.add_INGESTOR_ID(ingestor_off);
    ib.add_SOURCE(source_off);
    ib.add_STATE(j.complete ? irmJobState_COMPLETE : irmJobState_IN_PROGRESS);
    // The position IS a numbered part: this lane walks granule CELLS (or tiles) and no byte offset addresses them,
    // which is exactly what PART_INDEX states.
    ib.add_RANGE_MODE(irmRangeMode_PART_INDEX);
    ib.add_NEXT_CHUNK_INDEX(static_cast<uint32_t>(j.next_index));
    ib.add_LAST_CHUNK(chunk_off);
    ib.add_CHUNKS_COMMITTED(static_cast<uint32_t>(committed ? j.next_index : j.first_index));
    ib.add_RECORDS_COMMITTED(static_cast<uint64_t>(j.records_committed < 0 ? 0 : j.records_committed));
    ib.add_TARGET_STANDARD(target_off);
    ib.add_RECONCILE_MODE(reconcile_off);
    ib.add_UPDATED_AT(updated_off);
    if (j.complete) ib.add_COMPLETED_AT(updated_off);
    ib.add_TAGS(tags_off);
    if (!notes_off.IsNull()) ib.add_NOTES(notes_off);
    FinishIRMBuffer(b, ib.Finish());
    return finished(b);
}

// The job frame on `port` (an $IRM), or false when absent / not one.
bool read_job(const char* port, Job* j) {
    const plugin_input_frame_t* f = frame_for(port);
    if (!f || !f->payload || f->payload_length < 8) return false;
    flatbuffers::Verifier verifier(f->payload, f->payload_length);
    if (!IRMBufferHasIdentifier(f->payload) || !VerifyIRMBuffer(verifier)) return false;
    const IRM* irm = GetIRM(f->payload);
    j->job_id = text_of(irm->JOB_ID());
    j->provider = text_of(irm->PROVIDER_ID());
    j->source_url = irm->SOURCE() ? text_of(irm->SOURCE()->SOURCE_URL()) : std::string();
    j->epoch = irm->SOURCE() ? text_of(irm->SOURCE()->SOURCE_VERSION()) : std::string();
    j->updated_at = text_of(irm->UPDATED_AT());
    j->notes = text_of(irm->NOTES());
    j->first_index = irm->LAST_CHUNK() ? static_cast<long long>(irm->LAST_CHUNK()->CHUNK_INDEX()) : 0;
    j->next_index = static_cast<long long>(irm->NEXT_CHUNK_INDEX());
    j->records_committed = static_cast<long long>(irm->RECORDS_COMMITTED());
    j->walk = "cell";
    if (irm->TAGS())
        for (const auto* t : *irm->TAGS())
            if (t && t->str().rfind("walk:", 0) == 0) j->walk = t->str().substr(5);
    return true;
}

// dataset@tileset@epoch, as mark_job_id writes it (neither id carries an '@'; the epoch never does).
void split_job_id(const std::string& job_id, std::string* dataset, std::string* tileset, std::string* epoch) {
    const size_t first = job_id.find('@'), last = job_id.rfind('@');
    if (first == std::string::npos || last == first) return;
    *dataset = job_id.substr(0, first);
    *tileset = job_id.substr(first + 1, last - first - 1);
    *epoch = job_id.substr(last + 1);
}

// ── plan headers ($DTT, no mesh) ───────────────────────────────────────────

struct PlanHeader {
    std::string tileset, dataset, dataset_name, epoch, retrieved_at, license, license_url, attribution, source_url;
    std::string source_query, water_source_query, vertical_datum_name, etag, remarks;
    // A body other than Earth (GEOGRAPHIC_TWO_ROOT_BODY on a reference sphere): set only by body_plan, so an Earth
    // header's bytes are unchanged.
    bool body = false;
    std::string center_name, horizontal_datum_name, native_id;
    double radius_m = 0;
    dttSourceClass source_class = dttSourceClass_UNSPECIFIED;
    uint32_t level = 0, x = 0, y = 0, grid = 0, max_level = 0, child_availability = 0;
    bool has_extent = false;
    double west = 0, south = 0, east = 0, north = 0;
};

flatbuffers::Offset<DTTProvenance> plan_provenance(flatbuffers::FlatBufferBuilder& b, const PlanHeader& h,
                                                   const std::string& source_query) {
    const auto opt = [&b](const std::string& v) { return v.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(v); };
    const auto id = b.CreateString(h.dataset), epoch = b.CreateString(h.epoch), retrieved = b.CreateString(h.retrieved_at),
               license = b.CreateString(h.license);
    const auto name = opt(h.dataset_name), license_url = opt(h.license_url), attribution = opt(h.attribution),
               source_url = opt(h.source_url), query = opt(source_query), native_id = opt(h.native_id);
    DTTProvenanceBuilder pb(b);
    pb.add_DATASET_ID(id);
    pb.add_DATASET_EPOCH(epoch);
    pb.add_RETRIEVED_AT(retrieved);
    pb.add_LICENSE(license);
    if (!name.IsNull()) pb.add_DATASET_NAME(name);
    if (!license_url.IsNull()) pb.add_LICENSE_URL(license_url);
    if (!attribution.IsNull()) pb.add_ATTRIBUTION(attribution);
    if (!source_url.IsNull()) pb.add_SOURCE_URL(source_url);
    if (!query.IsNull()) pb.add_SOURCE_QUERY(query);
    if (!native_id.IsNull()) pb.add_NATIVE_ID(native_id);
    return pb.Finish();
}

// One header record, appended to `stream` size-prefixed.
void append_plan_header(Bytes* stream, const PlanHeader& h) {
    flatbuffers::FlatBufferBuilder b(1024);
    const auto tileset = b.CreateString(h.tileset);
    const auto datum = h.vertical_datum_name.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(h.vertical_datum_name);
    const auto etag = h.etag.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(h.etag);
    const auto remarks = h.remarks.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(h.remarks);
    const auto provenance = plan_provenance(b, h, h.source_query);
    const auto water_provenance = h.water_source_query.empty() ? flatbuffers::Offset<DTTProvenance>()
                                                                : plan_provenance(b, h, h.water_source_query);
    const auto center = h.body ? b.CreateString(h.center_name) : flatbuffers::Offset<flatbuffers::String>();
    const auto radii = h.body ? b.CreateVector(std::vector<double>{h.radius_m}) : flatbuffers::Offset<flatbuffers::Vector<double>>();
    const auto horizontal = h.body && !h.horizontal_datum_name.empty() ? b.CreateString(h.horizontal_datum_name)
                                                                         : flatbuffers::Offset<flatbuffers::String>();
    DTTPayloadRefBuilder payload_builder(b);
    const auto payload = payload_builder.Finish();
    DTTBuilder d(b);
    d.add_TILESET_ID(tileset);
    d.add_TILING_SCHEME(h.body ? dttTilingScheme_GEOGRAPHIC_TWO_ROOT_BODY : dttTilingScheme_GEOGRAPHIC_WGS84);
    d.add_LEVEL(h.level);
    d.add_X(h.x);
    d.add_Y(h.y);
    d.add_ROW_ORIGIN_NORTH(false);
    if (h.has_extent) {
        d.add_WEST_DEG(h.west);
        d.add_SOUTH_DEG(h.south);
        d.add_EAST_DEG(h.east);
        d.add_NORTH_DEG(h.north);
    }
    d.add_PAYLOAD(payload);
    if (h.grid) {
        d.add_GRID_WIDTH(h.grid);
        d.add_GRID_HEIGHT(h.grid);
    }
    if (!datum.IsNull()) d.add_VERTICAL_DATUM_NAME(datum);
    if (!water_provenance.IsNull()) d.add_WATER_MASK_PROVENANCE(water_provenance);
    d.add_CHILD_AVAILABILITY(static_cast<uint8_t>(h.child_availability));
    d.add_MAX_LEVEL(h.max_level);
    d.add_SOURCE_CLASS(h.source_class);
    d.add_PROVENANCE(provenance);
    if (!etag.IsNull()) d.add_ETAG(etag);
    if (!remarks.IsNull()) d.add_REMARKS(remarks);
    if (h.body) {
        d.add_VERTICAL_DATUM(dttVerticalDatum_REFERENCE_SPHERE);
        d.add_CENTER_NAME(center);
        d.add_REFERENCE_RADII_M(radii);
        if (!horizontal.IsNull()) d.add_HORIZONTAL_DATUM_NAME(horizontal);
    }
    FinishSizePrefixedDTTBuffer(b, d.Finish());
    stream->insert(stream->end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

dttSourceClass source_class_named(const std::string& name, bool* known) {
    *known = true;
    for (int v = dttSourceClass_MIN; v <= dttSourceClass_MAX; v++)
        if (name == EnumNamedttSourceClass(static_cast<dttSourceClass>(v))) return static_cast<dttSourceClass>(v);
    *known = name.empty();
    return dttSourceClass_UNSPECIFIED;
}

// An HttpRequest (HREQ) for one granule: GET, the configured timeout, nothing else. A 404 is the dataset publishing
// no granule over open ocean - the encoder treats it as sea level, never as an error - and the body arrives verbatim.
// A body product's requests carry their own validator, so the host never adds the If-None-Match it books per URL:
// the label and the ranges of one image share a URL, and the host's last 2xx ETag for it would answer every later
// range 304 (seen on host-01 2026-10-19: ldem_4_float.img ranges 304, the first unit refused). Any edition of the
// product was modified after the epoch, so the server always answers the bytes; If-Match still pins the edition.
constexpr const char* kNoValidators = "Thu, 01 Jan 1970 00:00:00 GMT";

Bytes granule_request(const std::string& url, long timeout_ms) {
    flatbuffers::FlatBufferBuilder b(256 + url.size());
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", url.c_str(), nullptr, nullptr,
                                                             static_cast<uint32_t>(timeout_ms), 0, nullptr));
    return finished(b);
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
    // ...and one cell FURTHER SOUTH than that, because a tile whose south edge
    // falls exactly on a whole-degree parallel is assigned to the granule cell
    // BELOW it (that granule is the one holding the edge post). Without this
    // the southmost such tile row is never planned at all.
    b.lat0 = clampl(static_cast<long>(std::floor(-90.0 + first_y * size)) - 1, -90, 89);
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


// ── a body's walk (body_plan.hpp, with terrain-source's polar_stereo.hpp) ──

#include "polar_stereo.hpp"
#include "body_plan.hpp"

// The file terrain-source:pack writes a tile into: <prefix>/root.dtts.gz at level <= rootMaxLevel, else
// <prefix>/<L>/<X>_<Y>.dtts.gz with X = x >> 2, Y = y >> 2 (row 0 at the south, as the tiles).
std::string pack_file_name(const std::string& prefix, long level, long x, long y) {
    if (level <= kBodyRootMaxLevel) return prefix + "/root.dtts.gz";
    return prefix + "/" + std::to_string(level) + "/" + std::to_string(x >> 2) + "_" + std::to_string(y >> 2) + ".dtts.gz";
}

constexpr uint64_t kImportMaxFileBytes = 8u * 1024u * 1024u;  // the host adapter's own bound

}  // namespace

extern "C" {

// mark_query: the timer tick -> the $FSO (QUERY_RECORDS) hostcap/flatsql-query runs to read this lane's durable $IRM
// back. A SEPARATE node from the planners on purpose: a planner takes the mark as an INPUT, and a node that emitted its
// own input would be a cycle in the flow graph. The ENGINE-ROUTED read form (the code-named view over _data/_rowid),
// newest first, a few rows so one shared relation can hold several lanes; the planner picks this lane's by JOB_ID.
int mark_query(void) {
    if (refuse_batched()) return 500;
    const std::string config = load_config();
    const std::string sql = config_string(config, "mark_sql", kDefaultMarkSql);
    long scan_rows = static_cast<long>(json_number_or(config, "mark_scan_rows", static_cast<double>(kDefaultMarkScanRows)));
    if (scan_rows <= 0) scan_rows = kDefaultMarkScanRows;
    // FlatSQL's tagged parameter encoding: [u8 tag][u32le size][bytes]; tag 2 = int64.
    Bytes params = {2, 8, 0, 0, 0};
    for (int i = 0; i < 8; i++) params.push_back(static_cast<uint8_t>((static_cast<uint64_t>(scan_rows) >> (8 * i)) & 0xff));
    flatbuffers::FlatBufferBuilder b(256 + sql.size());
    const auto query = b.CreateVector(reinterpret_cast<const uint8_t*>(sql.data()), sql.size());
    const auto parameters = b.CreateVector(params);
    FSOBuilder fso(b);
    fso.add_OPERATION(flatSqlNodeOperation_QUERY_RECORDS);
    fso.add_QUERY(query);
    fso.add_PARAMETERS(parameters);
    fso.add_PARAMETER_COUNT(1);
    FinishFSOBuffer(b, fso.Finish());
    return push_typed("query", "FSO.fbs", FSOIdentifier(), "FSO", finished(b)) < 0 ? 500 : 0;
}

// ingest_plan: tick (+ the resume mark, when one is stored) -> at most `batch_tiles` plan frames - one $DTT HEADER
// record per tile: the address and extent, the granule files it needs (PROVENANCE.SOURCE_QUERY for the elevation
// granules, WATER_MASK_PROVENANCE.SOURCE_QUERY for the water-body ones, space-separated URLs - a 404 is open ocean, never
// an error), the mark's upstream ETag as the record's ETAG (the If-None-Match its granule fetches present) and the
// verbatim licence/attribution provenance - plus the job ($IRM, the mark-to-be), with the remainder of the pyramid
// reported as backlog. A mark whose enumeration is already drained is a completed pyramid and the tick is a clean no-op.
int ingest_plan(void) {
    if (refuse_batched()) return 500;

    const std::string config = load_config();
    const std::string tileset = config_string(config, "tileset_id", "");
    if (tileset.empty()) {
        // Fail-closed: without a tileset identity there is nothing this plan could be FOR.
        plugin_set_error("missing-tileset-id", "ingest_plan requires tileset_id in node CONFIG.");
        return 400;
    }
    const long global_max_level = static_cast<long>(json_number_or(
        config, "global_max_level", static_cast<double>(kDefaultGlobalMaxLevel)));
    const std::vector<Region> regions = parse_regions(config, global_max_level < 0 ? 0 : global_max_level);
    if (regions.empty()) {
        plugin_set_error("missing-regions",
                         "ingest_plan requires a non-empty regions array in node CONFIG; an "
                         "empty region list plans nothing and a whole-earth default would "
                         "enumerate millions of tiles nobody asked for.");
        return 400;
    }
    const std::string dataset = config_string(config, "dataset_id", kDefaultDatasetId);

    const int64_t clock = tick_ms();
    if (clock < 0) {
        plugin_set_error("invalid-tick-frame", "the tick frame is not a TimerTick (TICK).");
        return 400;
    }
    // The epoch is the EDITION boundary: config override first (a pinned release), else the tick's own UTC day -
    // never a guest clock.
    std::string epoch = config_string(config, "dataset_epoch", "");
    if (epoch.empty()) {
        if (clock == 0) {
            plugin_set_error("missing-dataset-epoch",
                             "ingest_plan needs config dataset_epoch or the tick's FIRED_MS to "
                             "date this edition; an epoch guessed in-guest would make two "
                             "editions falsely comparable.");
            return 400;
        }
        epoch = iso_ms(clock).substr(0, 10) + "T00:00:00.000Z";
    }
    const std::string retrieved_at = clock > 0 ? iso_ms(clock) : config_string(config, "retrieved_at", "");
    if (retrieved_at.empty()) {
        plugin_set_error("missing-retrieved-at",
                         "DTTProvenance.RETRIEVED_AT is required on every plan header and is never invented: "
                         "the tick's FIRED_MS states the run's clock, or config retrieved_at.");
        return 400;
    }

    // Resume. A mark for a different dataset, tileset or epoch is a different JOB_ID and is IGNORED.
    Bytes stream;
    if (!mark_stream(&stream)) {
        plugin_set_error("invalid-mark-frame", "the mark frames are not a complete $FSB chunk sequence.");
        return 400;
    }
    const std::string job_id = mark_job_id(dataset, tileset, epoch);
    const MarkState mark = read_mark(stream, job_id);
    const long long start = mark.found && mark.next_index > 0 ? mark.next_index : 0;

    const long long total = total_tiles(regions);
    if (start >= total) {
        // The pyramid for this epoch is fully stored; nothing is planned. Completion is not an error.
        plugin_set_backlog_remaining(0);
        return 0;
    }
    const long batch = config_batch_tiles(config);
    long long end = start + batch;
    if (end > total) end = total;

    const std::string base = config_string(config, "granule_base_url", kDefaultGranuleBase);
    PlanHeader header;
    header.tileset = tileset;
    header.dataset = dataset;
    header.dataset_name = config_string(config, "dataset_name", kDefaultSourceName);
    header.epoch = epoch;
    header.retrieved_at = retrieved_at;
    header.license = config_string(config, "license", kDefaultLicense);
    header.license_url = config_string(config, "license_url", kDefaultLicenseUrl);
    header.attribution = config_string(config, "attribution", kDefaultAttribution);
    header.etag = mark.etag;
    header.has_extent = true;

    for (long long i = start; i < end; i++) {
        PlannedTile t;
        if (!tile_at_index(regions, i, &t)) break;  // unreachable given end <= total
        // Granule cells: the tile's extent CLIPPED to the region bbox, expanded outward to whole-degree cells. A
        // GRANULE'S TIEPOINT IS ITS NORTH-WEST CORNER AND ITS POSTS STOP ONE SPACING SHORT OF ITS SOUTH AND EAST
        // EDGES, so granule (lat, lon) holds latitudes (lat, lat+1] and longitudes [lon, lon+1).
        const double gw = t.west > t.region->west ? t.west : t.region->west;
        const double ge = t.east < t.region->east ? t.east : t.region->east;
        const double gs = t.south > t.region->south ? t.south : t.region->south;
        const double gn = t.north < t.region->north ? t.north : t.region->north;
        std::string dem_urls, wbm_urls;
        if (ge > gw && gn > gs) {
            const long lon0 = clampl(static_cast<long>(std::floor(gw)), -180, 179);
            const long lon1 = clampl(static_cast<long>(std::floor(ge)), -180, 179);
            const long lat0 = clampl(static_cast<long>(std::floor(gs - 1e-9)), -90, 89);
            const long lat1 = clampl(static_cast<long>(std::floor(gn - 1e-9)), -90, 89);
            for (long lat = lat0; lat <= lat1; lat++) {
                for (long lon = lon0; lon <= lon1; lon++) {
                    if (!dem_urls.empty()) { dem_urls += " "; wbm_urls += " "; }
                    dem_urls += dem_url(base, static_cast<int>(lat), static_cast<int>(lon));
                    wbm_urls += wbm_url(base, static_cast<int>(lat), static_cast<int>(lon));
                }
            }
        }
        PlanHeader h = header;
        h.level = static_cast<uint32_t>(t.level);
        h.x = static_cast<uint32_t>(t.x);
        h.y = static_cast<uint32_t>(t.y);
        h.west = t.west;
        h.south = t.south;
        h.east = t.east;
        h.north = t.north;
        h.source_query = dem_urls;
        h.water_source_query = wbm_urls;
        h.remarks = "region " + t.region->name + ", tile index " + std::to_string(i);
        Bytes record;
        append_plan_header(&record, h);
        if (push_typed("plan", "DTT.fbs", "$DTT", "DTT", record) < 0) return 500;
    }

    Job job;
    job.job_id = job_id;
    job.provider = config_string(config, "provider_id", kDefaultProviderId);
    job.source_url = base;
    job.epoch = epoch;
    job.updated_at = retrieved_at;
    job.walk = "tile";
    job.first_index = start;
    job.next_index = end;
    job.records_committed = mark.found ? mark.stored_total : 0;
    job.notes = "tiles " + std::to_string(start) + ".." + std::to_string(end - 1) + " of " + std::to_string(total);
    if (push_typed("job", "IRM.fbs", "$IRM", "IRM", build_irm(job, false)) < 0) return 500;

    const long long backlog = total - end;
    plugin_set_backlog_remaining(backlog > 0xffffffffLL ? 0xffffffffu : static_cast<uint32_t>(backlog));
    return 0;
}

// ---------------------------------------------------------------------------
// granule_plan — the GRANULE-MAJOR planner, and the one the pyramid builder runs.
//
// ingest_plan above is TILE-MAJOR: one plan frame per tile. The encoder amortizes a granule decode across every tile
// the granule covers, and a tile-major plan can never hand it more than one tile at a time (a z11 tile is 0.088
// degrees and a granule a whole degree: tile-major planning re-fetches and re-decodes the SAME granule ~130 times per
// cell). This planner inverts it. The unit of work is ONE GRANULE CELL at one level: the 2x2 granule neighbourhood is
// fetched (four DEM + four water-body HttpRequests, always exactly four so the flow's http nodes are fed
// unconditionally), and ONE plan frame - a $DTT header record per tile - carries every tile of that level whose
// SOUTH-WEST CORNER POST is HELD by the cell. "HELD BY", NOT "INSIDE": a granule's tiepoint is its north-west corner
// and its posts stop one spacing short of its south edge, so granule (lat, lon) holds latitudes (lat, lat+1] and
// longitudes [lon, lon+1); a tile assigned to cell (lat, lon) then needs posts only in latitudes (lat, lat+2] and
// longitudes [lon, lon+2) - exactly the 2x2 neighbourhood. LEVEL FLOOR: that holds only while a tile is no wider than
// a granule (level 8 and deeper); shallower levels are built by DOWNSAMPLING and a plan asking for them is REFUSED.
// The enumeration - regions by priority, then level, then cell row-major - is a pure function of the config, so the
// durable mark is a single integer: the next CELL index. CHILD_AVAILABILITY is not claimed (a clear bit is an absence
// of claim): the planner cannot know which children the encoder will store.
// ---------------------------------------------------------------------------
int granule_plan(void) {
    if (refuse_batched()) return 500;

    const std::string config = load_config();
    bool skip_ocean_tiles = true;
    if (!ocean_skip_option(config, &skip_ocean_tiles)) {
        plugin_set_error("invalid-ocean-skip-option", "skipOceanTiles must be a boolean");
        return 400;
    }
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
    // RETRIEVED_AT is required on every record and is never invented here: the config states it, or the tick
    // carries the run's clock.
    const int64_t clock = tick_ms();
    if (clock < 0) {
        plugin_set_error("invalid-tick-frame", "the tick frame is not a TimerTick (TICK).");
        return 400;
    }
    std::string retrieved_at = config_string(config, "retrieved_at", "");
    if (retrieved_at.empty() && clock > 0) retrieved_at = iso_ms(clock);
    if (retrieved_at.empty()) {
        plugin_set_error("missing-retrieved-at",
                         "DTTProvenance.RETRIEVED_AT is required on every record and this "
                         "scheduler will not invent a clock: state retrieved_at in the flow "
                         "config or fire the tick with FIRED_MS.");
        return 400;
    }

    const long global_max_level = static_cast<long>(json_number_or(config, "max_level", -1));
    const std::vector<Region> regions = parse_regions(config, global_max_level < 0 ? 0 : global_max_level);
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

    Bytes stream;
    if (!mark_stream(&stream)) {
        plugin_set_error("invalid-mark-frame", "the mark frames are not a complete $FSB chunk sequence.");
        return 400;
    }
    const std::string job_id = mark_job_id(dataset, tileset, epoch);
    const MarkState mark = read_mark(stream, job_id);
    long long start = mark.found && mark.next_index > 0 ? mark.next_index : 0;
    const long long stored_tiles_total = mark.found && mark.stored_total > 0 ? mark.stored_total : 0;
    if (start >= total) {
        // A drained enumeration is a clean no-op, not an error.
        plugin_set_backlog_remaining(0);
        return 0;
    }

    const std::string base = config_string(config, "granule_base_url", kDefaultGranuleBase);
    const long grid = static_cast<long>(json_number_or(config, "grid_size", kDefaultGridSize));
    // The top of the encoder's density ladder (defaults to grid_size: the fixed-density behaviour).
    const long max_grid = static_cast<long>(json_number_or(config, "max_grid_size", static_cast<double>(grid)));
    const long timeout_ms = config_timeout_ms(config);
    bool class_known = true;
    const dttSourceClass source_class =
        source_class_named(config_string(config, "source_class", "SPACEBORNE_RADAR_INTERFEROMETRIC"), &class_known);
    if (!class_known) {
        plugin_set_error("unknown-source-class",
                         "source_class must name a dttSourceClass member exactly (e.g. "
                         "SPACEBORNE_RADAR_INTERFEROMETRIC); an unrecognised name is refused "
                         "rather than published as a different production technique.");
        return 400;
    }

    // Scan forward to the next cell that actually holds tiles for its region (a cell the region bbox clips to
    // nothing would otherwise cost four granule fetches to build zero tiles).
    PlannedCell cell;
    std::vector<std::pair<long, long>> tiles;
    long long index = start;
    for (; index < total; index++) {
        if (!cell_at_index(regions, min_level, index, &cell)) break;
        const Region& r = *cell.region;
        const double size = tile_size_deg(cell.level);
        const TileBlock block = region_block(r, cell.level);
        const long x0 = clampl(static_cast<long>(std::ceil((cell.lon + 180.0) / size - 1e-9)), block.x0, block.x1);
        const long x1 = clampl(static_cast<long>(std::floor((cell.lon + 1 + 180.0) / size - 1e-9)), block.x0, block.x1);
        // The bracket is one row wider than the rule on each side; the exact test decides membership.
        const long y0 = clampl(static_cast<long>(std::floor((cell.lat + 90.0) / size)) - 1, block.y0, block.y1);
        const long y1 = clampl(static_cast<long>(std::floor((cell.lat + 1 + 90.0) / size)) + 1, block.y0, block.y1);
        tiles.clear();
        for (long y = y0; y <= y1; y++) {
            for (long x = x0; x <= x1; x++) {
                const double west = -180.0 + x * size;
                const double south = -90.0 + y * size;
                // Longitude half-open WEST-inclusive, latitude half-open NORTH-inclusive (the granule that HOLDS the
                // corner post); the south pole stays in cell -90.
                if (west < cell.lon || west >= cell.lon + 1) continue;
                const double south_cell = (south == std::floor(south) && south > -90.0) ? south - 1.0 : std::floor(south);
                if (south_cell != static_cast<double>(cell.lat)) continue;
                // A TILE BELONGS TO THE HIGHEST-PRIORITY REGION THAT CONTAINS IT: an earlier region claimed it.
                bool claimed = false;
                for (const Region& other : regions) {
                    if (&other == &r) break;
                    if (cell.level > other.max_level) continue;
                    const TileBlock ob = region_block(other, cell.level);
                    if (x >= ob.x0 && x <= ob.x1 && y >= ob.y0 && y <= ob.y1) { claimed = true; break; }
                }
                if (claimed) continue;
                tiles.push_back({x, y});
            }
        }
        if (!tiles.empty()) break;
    }
    if (tiles.empty()) {
        plugin_set_backlog_remaining(0);
        return 0;
    }

    // The 2x2 granule neighbourhood, ALWAYS four requests a lane so the flow's http nodes are fed unconditionally.
    // Longitude wraps, latitude clamps.
    const std::string primary_dem = dem_url(base, static_cast<int>(cell.lat), static_cast<int>(wrap_lon(cell.lon)));
    for (int dy = 0; dy < 2; dy++) {
        for (int dx = 0; dx < 2; dx++) {
            const long lat = clampl(cell.lat + dy, -90, 89);
            const long lon = wrap_lon(cell.lon + dx);
            const int slot = dy * 2 + dx;
            char dem_port[16], wbm_port[16];
            std::snprintf(dem_port, sizeof(dem_port), "dem_%d", slot);
            std::snprintf(wbm_port, sizeof(wbm_port), "wbm_%d", slot);
            if (push_typed(dem_port, "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest",
                           granule_request(dem_url(base, static_cast<int>(lat), static_cast<int>(lon)), timeout_ms)) < 0)
                return 500;
            if (push_typed(wbm_port, "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest",
                           granule_request(wbm_url(base, static_cast<int>(lat), static_cast<int>(lon)), timeout_ms)) < 0)
                return 500;
        }
    }

    // The encoder's plan: one $DTT header per tile, the provenance DTTProvenance is built from, verbatim - this is
    // where the scheduler's config becomes the record contract, and nothing in it is defaulted.
    PlanHeader header;
    header.tileset = tileset;
    header.dataset = dataset;
    header.dataset_name = config_string(config, "dataset_name", kDefaultSourceName);
    header.epoch = epoch;
    header.retrieved_at = retrieved_at;
    header.license = config_string(config, "license", kDefaultLicense);
    header.license_url = config_string(config, "license_url", kDefaultLicenseUrl);
    header.attribution = config_string(config, "attribution", kDefaultAttribution);
    header.source_url = primary_dem;
    header.vertical_datum_name = config_string(config, "vertical_datum_name", "EGM2008");
    header.source_class = source_class;
    header.level = static_cast<uint32_t>(cell.level);
    header.grid = static_cast<uint32_t>(grid);
    header.max_level = static_cast<uint32_t>(cell.region->max_level);
    Bytes plan;
    for (const auto& [x, y] : tiles) {
        PlanHeader h = header;
        h.x = static_cast<uint32_t>(x);
        h.y = static_cast<uint32_t>(y);
        append_plan_header(&plan, h);
    }
    if (push_typed("plan", "DTT.fbs", "$DTT", "DTT", plan) < 0) return 500;

    // The encoder's options (ModuleConfig): the top of the density ladder, and whether all-ocean tiles are stored -
    // native coarsening needs four actual sibling records including observed water, so that is a config choice.
    {
        R::ModuleConfigT options;
        auto entry = [](const char* key) { auto e = std::make_unique<R::ConfigEntryT>(); e->KEY = key; return e; };
        auto max_entry = entry("maxGridSize");
        max_entry->KIND = R::configValueKind_Number;
        max_entry->NUMBER_VALUE = static_cast<double>(max_grid);
        auto skip_entry = entry("skipOceanTiles");
        skip_entry->KIND = R::configValueKind_Bool;
        skip_entry->BOOL_VALUE = skip_ocean_tiles;
        options.ENTRIES.push_back(std::move(max_entry));
        options.ENTRIES.push_back(std::move(skip_entry));
        flatbuffers::FlatBufferBuilder b(256);
        R::FinishModuleConfigBuffer(b, R::ModuleConfig::Pack(b, &options));
        if (push_typed("options", "ModuleConfig.fbs", R::ModuleConfigIdentifier(), "ModuleConfig", finished(b)) < 0) return 500;
    }

    // The job: the mark this cell will make durable once stored. THE MARK'S STRIDE IS 1 BY CONTRACT (the unit of
    // this enumeration is ONE CELL): NEXT_CHUNK_INDEX = this cell + 1.
    Job job;
    job.job_id = job_id;
    job.provider = config_string(config, "provider_id", kDefaultProviderId);
    job.source_url = base;
    job.epoch = epoch;
    job.updated_at = retrieved_at;
    job.walk = "cell";
    job.first_index = index;
    job.next_index = index + 1;
    job.records_committed = stored_tiles_total;
    job.notes = "region " + cell.region->name + ", level " + std::to_string(cell.level) + ", cell " +
                std::to_string(cell.lon) + "," + std::to_string(cell.lat) + ", " + std::to_string(tiles.size()) +
                " tiles of " + std::to_string(total) + " cells";
    if (push_typed("job", "IRM.fbs", "$IRM", "IRM", build_irm(job, false)) < 0) return 500;

    const long long backlog = total - (index + 1);
    plugin_set_backlog_remaining(backlog > 0xffffffffLL ? 0xffffffffu : static_cast<uint32_t>(backlog < 0 ? 0 : backlog));
    return 0;
}

// ingest_meta: the job ($IRM), the tile record stream ($DTT), the encoder's report (FlowNotice; supplies the batch's
// record count) and the primary granule's HttpResponse (its ETag / Last-Modified, the ledger) -> the hostcap/
// storage-ingest IngestRequest and the records, forwarded byte-for-byte. This node exists to author the attribution
// the storage lane cannot invent: dataset, batch, epoch.
int ingest_meta(void) {
    if (refuse_batched()) return 500;

    Job job;
    if (!read_job("job", &job)) {
        plugin_set_error("missing-job-frame", "ingest_meta requires the run-contract job frame ($IRM).");
        return 400;
    }
    const plugin_input_frame_t* records = frame_for("records");
    if (!records || !records->payload) {
        plugin_set_error("missing-records-frame", "ingest_meta requires the terrain tile record stream.");
        return 400;
    }
    std::string dataset, tileset, epoch;
    split_job_id(job.job_id, &dataset, &tileset, &epoch);
    if (dataset.empty() || tileset.empty() || epoch.empty()) {
        plugin_set_error("incomplete-job-attribution",
                         "ingest_meta needs dataset, tileset and epoch on the job's JOB_ID; storage cannot "
                         "invent the edition a tile belongs to.");
        return 400;
    }
    const std::string config = load_config();

    // The primary granule response: the ETag / Last-Modified the ledger turns on.
    std::string etag, last_modified, response_url;
    int32_t http_status = 0;
    uint64_t retrieved_ms = 0;
    if (const plugin_input_frame_t* f = frame_for("response")) {
        flatbuffers::Verifier verifier(f->payload ? f->payload : reinterpret_cast<const uint8_t*>(""),
                                       f->payload ? f->payload_length : 0);
        if (!f->payload || f->payload_length < 8 || !R::VerifyHttpResponseBuffer(verifier)) {
            plugin_set_error("invalid-response-frame", "the response frame is not an HttpResponse (HRSP).");
            return 400;
        }
        const R::HttpResponse* r = R::GetHttpResponse(f->payload);
        http_status = r->STATUS();
        retrieved_ms = r->RETRIEVED_MS();
        response_url = text_of(r->URL());
        if (r->HEADERS())
            for (const auto* h : *r->HEADERS()) {
                const std::string name = text_of(h->NAME());
                if (name == "etag") etag = text_of(h->VALUE());
                else if (name == "last-modified") last_modified = text_of(h->VALUE());
            }
    }
    // The tile count this batch actually produced, from the encoder's report; -1 (absent) disables the silent-nop
    // check rather than faking a count.
    long long records_in = -1;
    if (const plugin_input_frame_t* f = frame_for("decision")) {
        flatbuffers::Verifier verifier(f->payload ? f->payload : reinterpret_cast<const uint8_t*>(""),
                                       f->payload ? f->payload_length : 0);
        if (!f->payload || f->payload_length < 8 || !R::VerifyFlowNoticeBuffer(verifier)) {
            plugin_set_error("invalid-decision-frame", "the decision frame is not a FlowNotice (FNTC).");
            return 400;
        }
        records_in = static_cast<long long>(R::GetFlowNotice(f->payload)->COUNT());
    }

    // ONE BATCH PER (tileset, epoch, batch start): re-running a batch is idempotent at the storage lane and two
    // batches never collide.
    const std::string batch_id = tileset + "@" + epoch + "#" + std::to_string(job.first_index);

    R::IngestRequestT meta;
    meta.SCHEMA = kSchema;
    meta.TAGS = std::make_unique<R::SourceTagsT>();
    meta.TAGS->PROVIDER_ID = config_string(config, "provider_id", kDefaultProviderId);
    meta.TAGS->SOURCE_NAME = config_string(config, "source_name", kDefaultSourceName);
    meta.TAGS->BATCH_ID = batch_id;
    meta.TAGS->SOURCE_URL = job.source_url;
    // `None` (append): a batch is a WINDOW of the pyramid, never the tileset's complete set, so a source-batch
    // reconcile on it would delete every tile outside the window.
    meta.RECONCILE = R::reconcileMode_None;
    meta.PROVENANCE = std::make_unique<R::ProvenanceT>();
    meta.PROVENANCE->SOURCE_URL = response_url.empty() ? job.source_url : response_url;
    meta.PROVENANCE->HTTP_STATUS = http_status;
    meta.PROVENANCE->ETAG = etag;
    meta.PROVENANCE->LAST_MODIFIED = last_modified;
    meta.PROVENANCE->RETRIEVED_MS = retrieved_ms;
    meta.PROVENANCE->PARSER = "terrain-source";
    meta.PROVENANCE->PARSER_VERSION = kIngestorId;
    // The count, when the report gave one: SCHEMAS / SCHEMA_COUNTS state it per standard (absent = unknown, never 0).
    if (records_in >= 0) {
        meta.PROVENANCE->NORMALIZED_COUNT = static_cast<uint64_t>(records_in);
        meta.PROVENANCE->SCHEMAS = {"DTT.fbs"};
        meta.PROVENANCE->SCHEMA_COUNTS = {static_cast<uint64_t>(records_in)};
    }
    flatbuffers::FlatBufferBuilder b(1024);
    R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, &meta));
    if (push_typed("meta", "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest", finished(b)) < 0) return 500;
    // The record stream is OPAQUE to this scheduler - forwarded byte-for-byte.
    if (plugin_push_output_ex("records", "DTT.fbs", "$DTT", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "DTT", 0, 0,
                              records->payload, records->payload_length) < 0)
        return 500;
    return 0;
}

// ---------------------------------------------------------------------------
// body_plan - a body's planner (body_plan.hpp; config `body`, default moon):
// TimerTick + $FSB mark? -> per file of the unit's product, its PDS3 label and
// `range_parts` whole-line ranges of its image (dem_0..dem_15) as HttpRequests,
// the $DTT plan headers of one unit (a body plan: GEOGRAPHIC_TWO_ROOT_BODY,
// CENTER_NAME, REFERENCE_RADII_M, REFERENCE_SPHERE), the encoder's options
// (MCFG), pack's options (MCFG: pathPrefix, rootMaxLevel) and the job ($IRM,
// walk:<the body's walk>, stride 1).
// ---------------------------------------------------------------------------
int body_plan(void) {
    if (refuse_batched()) return 500;
    const std::string config = load_config();
    const std::string body_name = config_string(config, "body", "moon");
    const Body* body = body_named(body_name);
    if (!body) {
        plugin_set_error("unknown-body", ("body_plan has no table for body \"" + body_name + "\" (moon, mars).").c_str());
        return 400;
    }
    const std::string tileset = config_string(config, "tileset_id", "");
    const std::string epoch = config_string(config, "dataset_epoch", "");
    if (tileset.empty() || epoch.empty()) {
        plugin_set_error("missing-tileset-id",
                         "body_plan needs tileset_id and dataset_epoch: a walk with no identity or edition cannot be "
                         "resumed or superseded.");
        return 400;
    }
    const std::string dataset = config_string(config, "dataset_id", body->dataset_id);
    const int64_t clock = tick_ms();
    if (clock < 0) {
        plugin_set_error("invalid-tick-frame", "the tick frame is not a TimerTick (TICK).");
        return 400;
    }
    std::string retrieved_at = config_string(config, "retrieved_at", "");
    if (retrieved_at.empty() && clock > 0) retrieved_at = iso_ms(clock);
    if (retrieved_at.empty()) {
        plugin_set_error("missing-retrieved-at",
                         "DTTProvenance.RETRIEVED_AT is required on every record: state retrieved_at in the flow "
                         "config or fire the tick with FIRED_MS.");
        return 400;
    }
    std::string error;
    const std::vector<BodyCap> caps = body_caps(*body, config, &error);
    if (caps.empty()) {
        plugin_set_error("invalid-caps", error.c_str());
        return 400;
    }
    const long grid = static_cast<long>(json_number_or(config, "grid_size", 65));
    // 321 posts (320 intervals) puts 41, 65 and 81 on the density ladder: a tile whose relief needs a little more
    // than 65 posts takes 81 (1.6x the vertices, under the 32 KiB ceiling) rather than jumping to 129, which never
    // fits (measured on the LOLA sample: every tile the 65 rung left over its RMS target was within 1.45x of it).
    const double max_grid = json_number_or(config, "max_grid_size", 321);
    const double range_bytes = json_number_or(config, "max_range_bytes", kBodyDefaultRangeBytes);
    if (grid < 5 || grid > 255 || max_grid < grid || max_grid > 511 || !(range_bytes >= 1024.0 * 1024.0)) {
        plugin_set_error("invalid-body-options",
                         "grid_size must lie in [5, 255], max_grid_size in [grid_size, 511] and "
                         "max_range_bytes be at least 1 MiB.");
        return 400;
    }

    Bytes stream;
    if (!mark_stream(&stream)) {
        plugin_set_error("invalid-mark-frame", "the mark frames are not a complete $FSB chunk sequence.");
        return 400;
    }
    const std::string job_id = mark_job_id(dataset, tileset, epoch);
    const MarkState mark = read_mark(stream, job_id);
    const long long start = mark.found && mark.next_index > 0 ? mark.next_index : 0;
    BodyUnit unit;
    long long total = 0;
    if (!body_unit_at(*body, caps, max_grid, range_bytes, start, &unit, &total)) {
        plugin_set_backlog_remaining(0);  // the walk is drained: a clean no-op
        return 0;
    }
    const BodyProduct& product = *unit.cap->product;
    const std::string base = config_string(config, "base_url", body->base_url);
    const bool if_match = json_number_or(config, "verify_etag", 1) != 0;
    const long timeout_ms = config_timeout_ms(config);

    // Per file the unit's lines cross: the label (so the geometry the encoder decodes with is the source's own), then
    // the file's share of the lines as `range_parts` whole-line ranges.
    size_t frame = 0;
    std::string files_read, tiff_headers, tiff_layouts;
    const bool with_fill = body_unit_needs_fill(*body, unit, max_grid);
    const double fill_spacing = with_fill ? body_post_spacing(*body, *unit.cap->fill) : 0;
    const double band_m = unit.cap->feather_posts * fill_spacing;
    const BodyUnit primary_window = with_fill ? body_product_window(*body, unit, product, max_grid, band_m) : unit;
    const BodyUnit fill_window = with_fill ? body_product_window(*body, unit, *unit.cap->fill, max_grid, band_m) : unit;
    // Short fill bands need one range per file. Reduce primary segmentation if necessary;
    // segmentation changes neither the requested lines nor the unit's complete block files.
    uint32_t primary_parts = product.range_parts;
    const size_t primary_files = body_window_files(product, primary_window, max_grid);
    const size_t fill_files = with_fill ? body_window_files(*unit.cap->fill, fill_window, max_grid) : 0;
    const BodyProduct* backing = with_fill && unit.cap->fill->fallback ? body_product(*body, unit.cap->fill->fallback) : nullptr;
    const double backing_spacing = backing ? body_post_spacing(*body, *backing) : 0;
    const double backing_band = backing ? unit.cap->fill->fallback_posts * backing_spacing : 0;
    const BodyUnit backing_window = backing ? body_product_window(*body, unit, *backing, max_grid, band_m + backing_band) : unit;
    const size_t backing_frames = backing ? 2 * body_window_files(*backing, backing_window, max_grid) : 0;
    const BodyProduct* datum = body_product(*body, product.datum ? product.datum :
        (with_fill && unit.cap->fill->datum ? unit.cap->fill->datum : (backing&&backing->datum?backing->datum:"")));
    const BodyUnit datum_window = datum ? body_product_window(*body, unit, *datum, max_grid, band_m) : unit;
    const size_t datum_frames = datum ? 2 * body_window_files(*datum, datum_window, max_grid) : 0;
    if (with_fill && primary_files * (1 + primary_parts) + 2 * fill_files + datum_frames + backing_frames > kBodyMaxDemFrames) primary_parts = 1;
    if (primary_files * (1 + primary_parts) + 2 * fill_files + datum_frames + backing_frames > kBodyMaxDemFrames) {
        plugin_set_error("too-many-files", "a complete body block needs more than 16 DEM frames including fill.");
        return 422;
    }
    const BodyProduct* mask=nullptr;
    if(with_fill&&product.inset&&std::strncmp(product.key,"hrsc_",5)!=0) {
        const std::string key=std::strncmp(product.key,"msl_",4)==0?"msl_gale_dem_1m_v3_ovr32":"msr_trn_hirise_dtm_1m_v003_ovr32";
        mask=body_product(*body,key);if(mask==&product)mask=nullptr;
    }
    size_t fill_frame = 0, backing_frame = 0, datum_frame = 0, mask_frame = 0;
    for (int group = 0; group < 5; group++) {
        if (group == 1 && !with_fill) continue;
        if (group == 2 && !backing) continue;
        if (group == 3 && !datum) continue;
        if (group == 4 && !mask) continue;
        if (group == 4) mask_frame = frame;
        if (group == 1) fill_frame = frame;
        if (group == 2) backing_frame = frame;
        if (group == 3) datum_frame = frame;
        const BodyProduct& requested = group == 0 ? product : group == 1 ? *unit.cap->fill : group == 2 ? *backing : group == 3 ? *datum : *mask;
        const BodyUnit& window = group == 0 ? primary_window : group == 1 ? fill_window : group == 2 ? backing_window : datum_window;
        const uint32_t range_parts = group == 0 ? primary_parts : 1;
        for (const BodyFile& file : requested.files) {
            if(requested.inset) {
                auto* in=body_inset(file.path);BodyTiffWindow w;
                if(!in){plugin_set_error("inset-catalog-invalid",file.path);return 422;}
                const double halo=group==4?band_m:group==1?backing_band:group==0&&!mask?band_m:0;
                if(!body_inset_window(*in,unit,max_grid,&w,halo)) {
                    // A descendant of a covered coarse tile may contain no fine
                    // pixels. Keep its product identity; every post uses backing.
                    if(group!=0||requested.files.size()!=1)continue;
                    w={0,0,0,0};
                }
                auto ranges=in->tiff.ranges(w,static_cast<uint64_t>(range_bytes));
                if(frame+ranges.size()>kBodyMaxDemFrames){plugin_set_error("too-many-inset-ranges","inset block exceeds 16 DEM frames");return 422;}
                const auto append=[&](std::string* text,const std::string& value){if(!text->empty())*text+=';';*text+=std::to_string(frame);*text+='=';*text+=value;};
                append(&tiff_headers,file.path);append(&tiff_layouts,in->descriptor());
                if(!files_read.empty())files_read+=' ';files_read+=file.path;
                const std::string inset_base=config_string(config,"inset_base_url","");
                if(inset_base.empty()||inset_base.back()!='/'){plugin_set_error("missing-inset-base","inset_base_url must name the raw/499/ mirror ending in /");return 400;}
                const std::string url=inset_base+file.image_url;
                const std::string inset_etag=config_string(config,("inset_etag_"+std::string(file.path)).c_str(),"");
                if(if_match&&inset_etag.empty()){plugin_set_error("missing-inset-etag","set inset_etag_<filename> from the mirrored object's ETag");return 400;}
                for(const auto& range:ranges) {
                    flatbuffers::FlatBufferBuilder b(512+url.size());
                    const std::string value="bytes="+std::to_string(range.first)+"-"+std::to_string(range.first+range.second-1);
                    std::vector<flatbuffers::Offset<R::Header>> headers{R::CreateHeaderDirect(b,"range",value.c_str()),R::CreateHeaderDirect(b,"if-modified-since",kNoValidators)};
                    if(if_match)headers.push_back(R::CreateHeaderDirect(b,"if-match",inset_etag.c_str()));
                    R::FinishHttpRequestBuffer(b,R::CreateHttpRequestDirect(b,"GET",url.c_str(),&headers,nullptr,static_cast<uint32_t>(timeout_ms),0,nullptr));
                    char port[8];std::snprintf(port,sizeof(port),"dem_%zu",frame++);
                    if(push_typed(port,"HttpRequest.fbs",R::HttpRequestIdentifier(),"HttpRequest",finished(b))<0)return 500;
                }
                continue;
            }
            uint64_t first = 0, last = 0;
            if (!body_file_lines(requested, file, window, &first, &last)) continue;
            if (frame + 1 + range_parts > kBodyMaxDemFrames) {
                plugin_set_error("too-many-files", "a unit's files need more than the flow's 16 dem requests.");
                return 500;
            }
            const std::string img_url = file.image_url ? file.image_url : base + file.path + ".img";
            const std::string lbl_url = file.label_url ? file.label_url : base + file.path + ".lbl";
            files_read += (files_read.empty() ? "" : " ") + std::string(file.path);
            char port[8];
            std::snprintf(port, sizeof(port), "dem_%zu", frame++);
            {
                flatbuffers::FlatBufferBuilder b1(512 + lbl_url.size());
                std::vector<flatbuffers::Offset<R::Header>> lbl_headers{R::CreateHeaderDirect(b1, "if-modified-since", kNoValidators)};
                R::FinishHttpRequestBuffer(b1, R::CreateHttpRequestDirect(b1, "GET", lbl_url.c_str(), &lbl_headers, nullptr,
                                                                          static_cast<uint32_t>(timeout_ms), 0, nullptr));
                if (push_typed(port, "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", finished(b1)) < 0)
                    return 500;
            }
            const uint64_t record_bytes = requested.samples * requested.sample_bytes, lines = last - first + 1;
            const uint64_t parts = range_parts, per = (lines + parts - 1) / parts;
            for (uint64_t part = 0; part < parts; part++) {
                const uint64_t a = first + std::min<uint64_t>(lines - 1, per * part);
                const uint64_t b = std::min<uint64_t>(last, first + per * (part + 1) - 1);
                const std::string range = "bytes=" + std::to_string(file.image_offset + a * record_bytes) + "-" +
                                          std::to_string(file.image_offset + (std::max(a, b) + 1) * record_bytes - 1);
                flatbuffers::FlatBufferBuilder b2(512 + img_url.size());
                std::vector<flatbuffers::Offset<R::Header>> headers;
                headers.push_back(R::CreateHeaderDirect(b2, "range", range.c_str()));
                headers.push_back(R::CreateHeaderDirect(b2, "if-modified-since", kNoValidators));
                if (if_match && file.etag[0]) headers.push_back(R::CreateHeaderDirect(b2, "if-match", file.etag));
                R::FinishHttpRequestBuffer(b2, R::CreateHttpRequestDirect(b2, "GET", img_url.c_str(), &headers, nullptr,
                                                                          static_cast<uint32_t>(timeout_ms), 0, nullptr));
                std::snprintf(port, sizeof(port), "dem_%zu", frame++);
                if (push_typed(port, "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", finished(b2)) < 0)
                    return 500;
            }
        }
    }

    long max_level = 0;
    for (const BodyCap& c : caps) max_level = std::max(max_level, c.max_level);
    PlanHeader header;
    header.tileset = tileset;
    header.dataset = dataset;
    header.dataset_name = config_string(config, "dataset_name", body->dataset_name);
    header.epoch = std::string(product.created) + "T00:00:00.000Z";
    header.retrieved_at = retrieved_at;
    header.license = config_string(config, "license", "Public domain (NASA)");
    header.license_url = config_string(config, "license_url", "https://www.nasa.gov/nasa-brand-center/images-and-media/");
    header.attribution = config_string(config, "attribution", body->attribution);
    // The product's one file, or its directory when the product is a set of files.
    const std::string first_path = product.files[0].path;
    header.source_url = product.files[0].image_url ? product.files[0].image_url : product.files.size() == 1 ? base + first_path + ".img"
                                                  : base + first_path.substr(0, first_path.rfind('/') + 1);
    if(product.inset)header.source_url=config_string(config,"inset_base_url","")+product.files[0].image_url;
    if (product.datum || (with_fill && unit.cap->fill->datum)) {
        header.license = "CC BY-SA 3.0 IGO";
        header.license_url = "https://creativecommons.org/licenses/by-sa/3.0/igo/";
        header.attribution = "HRSC: ESA/DLR/FU Berlin, CC BY-SA 3.0 IGO; MOLA: NASA/GSFC; blend: USGS Astrogeology (Fergason et al. 2018)";
    }
    header.native_id = product.native_id;
    header.vertical_datum_name = config_string(config, "vertical_datum_name", body->vertical_datum_name);
    header.source_class = dttSourceClass_SPACEBORNE_ALTIMETRIC;
    header.grid = static_cast<uint32_t>(grid);
    header.max_level = static_cast<uint32_t>(max_level);
    header.body = true;
    header.center_name = config_string(config, "center_name", body->center_name);
    header.radius_m = body->radius_m;
    header.horizontal_datum_name = config_string(config, "horizontal_datum_name", body->horizontal_datum_name);
    Bytes plan;
    for (const auto& t : unit.tiles) {
        PlanHeader h = header;
        h.level = static_cast<uint32_t>(t[0]);
        h.x = static_cast<uint32_t>(t[1]);
        h.y = static_cast<uint32_t>(t[2]);
        append_plan_header(&plan, h);
    }
    if (push_typed("plan", "DTT.fbs", "$DTT", "DTT", plan) < 0) return 500;

    const auto module_config = [](std::vector<std::unique_ptr<R::ConfigEntryT>> entries) {
        R::ModuleConfigT options;
        options.ENTRIES = std::move(entries);
        flatbuffers::FlatBufferBuilder b(256);
        R::FinishModuleConfigBuffer(b, R::ModuleConfig::Pack(b, &options));
        return finished(b);
    };
    const auto number = [](const char* key, double v) {
        auto e = std::make_unique<R::ConfigEntryT>();
        e->KEY = key;
        e->KIND = R::configValueKind_Number;
        e->NUMBER_VALUE = v;
        return e;
    };
    {
        std::vector<std::unique_ptr<R::ConfigEntryT>> entries;
        entries.push_back(number("maxGridSize", max_grid));
        if(!tiff_headers.empty()) {
            auto names=std::make_unique<R::ConfigEntryT>();names->KEY="bodyTiffFiles";names->KIND=R::configValueKind_String;names->STRING_VALUE=tiff_headers;entries.push_back(std::move(names));
            auto layouts=std::make_unique<R::ConfigEntryT>();layouts->KEY="bodyTiffLayouts";layouts->KIND=R::configValueKind_String;layouts->STRING_VALUE=tiff_layouts;entries.push_back(std::move(layouts));
        }
        if(mask_frame)entries.push_back(number("bodyMaskFrame",static_cast<double>(mask_frame)));
        if (body_despike_m(product) > 0) entries.push_back(number("bodyDespikeM", body_despike_m(product)));
        // The level-0 RMS target (15 m at level 7), judged as RMS over the source posts.
        entries.push_back(number("levelZeroErrorM", json_number_or(config, "level_zero_error_m", 1920)));
        auto metric = std::make_unique<R::ConfigEntryT>();
        metric->KEY = "errorMetric";
        metric->KIND = R::configValueKind_String;
        metric->STRING_VALUE = config_string(config, "error_metric", "rms");
        entries.push_back(std::move(metric));
        if (backing) {
            entries.push_back(number("bodyBackingFrame", static_cast<double>(backing_frame)));
            entries.push_back(number("bodyBackingDatum", backing->datum?1:0));
            entries.push_back(number("bodyBackingPosts", unit.cap->fill->fallback_posts));
            entries.push_back(number("bodyBackingSpacingM", backing_spacing));
        }
        if (datum) {
            entries.push_back(number("bodyDatumFrame", static_cast<double>(datum_frame)));
            entries.push_back(number("bodyPrimaryDatum", product.datum ? 1 : 0));
            entries.push_back(number("bodyFillDatum", with_fill && unit.cap->fill->datum ? 1 : 0));
        }
        if (with_fill) {
            entries.push_back(number("bodyFillEdges", unit.cap->fill_edges ? 1 : 0));
            entries.push_back(number("bodyFillFrame", static_cast<double>(fill_frame)));
            entries.push_back(number("bodyLatMin", unit.cap->lat_min));
            entries.push_back(number("bodyLatMax", unit.cap->lat_max));
            entries.push_back(number("featherPosts", unit.cap->feather_posts));
            entries.push_back(number("fillSpacingM", fill_spacing));
            auto fill = std::make_unique<R::ConfigEntryT>();
            fill->KEY = "bodyFillProduct";
            fill->KIND = R::configValueKind_String;
            fill->STRING_VALUE = unit.cap->fill->key;
            entries.push_back(std::move(fill));
        }
        if (json_number_or(config, "fill_diagnostics", 0) != 0)
            entries.push_back(number("fillDiagnostics", 1));
        if (push_typed("options", "ModuleConfig.fbs", R::ModuleConfigIdentifier(), "ModuleConfig",
                       module_config(std::move(entries))) < 0)
            return 500;
    }
    {
        std::vector<std::unique_ptr<R::ConfigEntryT>> entries;
        auto prefix = std::make_unique<R::ConfigEntryT>();
        prefix->KEY = "pathPrefix";
        prefix->KIND = R::configValueKind_String;
        prefix->STRING_VALUE = config_string(config, "path_prefix", body->path_prefix);
        entries.push_back(std::move(prefix));
        entries.push_back(number("rootMaxLevel", static_cast<double>(kBodyRootMaxLevel)));
        if (push_typed("pack", "ModuleConfig.fbs", R::ModuleConfigIdentifier(), "ModuleConfig",
                       module_config(std::move(entries))) < 0)
            return 500;
    }

    Job job;
    job.job_id = job_id;
    job.provider = config_string(config, "provider_id", body->provider_id);
    job.source_url = base;
    job.epoch = epoch;
    job.updated_at = retrieved_at;
    job.walk = body->walk;
    job.first_index = start;
    job.next_index = start + 1;
    job.records_committed = mark.found && mark.stored_total > 0 ? mark.stored_total : 0;
    const std::string where = product.files.size() == 1 ? std::string() : " (" + files_read + ")";
    job.notes = std::string("product ") + product.key + where +
                (unit.root ? ", levels 0-2" : ", level " + std::to_string(unit.level)) + ", lines " +
                std::to_string(unit.first_line) + "-" + std::to_string(unit.last_line) + ", " +
                std::to_string(unit.tiles.size()) + " tiles in " + std::to_string(unit.blocks) + " files, unit " +
                std::to_string(start) + " of " + std::to_string(total);
    if (push_typed("job", "IRM.fbs", "$IRM", "IRM", build_irm(job, false)) < 0) return 500;
    const long long backlog = total - (start + 1);
    plugin_set_backlog_remaining(backlog > 0xffffffffLL ? 0xffffffffu : static_cast<uint32_t>(backlog < 0 ? 0 : backlog));
    return 0;
}

// ---------------------------------------------------------------------------
// announce_files - the job ($IRM), the files the host adapter added to IPFS
// ("added": one size-prefixed $PNM each, CID + FILE_NAME) and the encoder's
// report (FlowNotice, optional) -> the $PNM records to publish (completed:
// /ipfs/ address, PUBLISH_TIMESTAMP = the run's retrieval time, FILE_ID
// provider:source:name:CID) and the IngestRequest the storage lane stores them
// under (provider nasa-lola, source moon-terrain, one batch per unit).
// ---------------------------------------------------------------------------
int announce_files(void) {
    Job job;
    if (!read_job("job", &job)) {
        plugin_set_error("missing-job-frame", "announce_files requires the job frame ($IRM).");
        return 400;
    }
    const std::string config = load_config();
    const Body* body = body_of_walk(job.walk);
    if (!body) body = body_named(config_string(config, "body", "moon"));
    if (!body) {
        plugin_set_error("unknown-body", "announce_files: the job's walk names no body this module has a table for.");
        return 400;
    }
    const std::string provider = config_string(config, "provider_id", body->provider_id);
    const std::string source = config_string(config, "source_name", body->source_name);
    Bytes records;
    uint32_t files = 0;
    for (uint32_t i = 0; i < plugin_get_input_count(); i++) {
        const plugin_input_frame_t* f = plugin_get_input_frame(i);
        if (!f || !f->port_id || std::strcmp(f->port_id, "added") != 0) continue;
        if (++files > 64) {
            plugin_set_error("batched-input-frames", "announce_files takes at most 64 added files.");
            return 500;
        }
        const uint8_t* data = f->payload;
        const size_t length = f->payload_length;
        if (!data || length < 8) {
            plugin_set_error("invalid-added-frame", "an added frame is not a size-prefixed $PNM.");
            return 400;
        }
        const uint32_t size = static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8) |
                              (static_cast<uint32_t>(data[2]) << 16) | (static_cast<uint32_t>(data[3]) << 24);
        flatbuffers::Verifier verifier(data + 4, length - 4);
        if (size != length - 4 || !PNMBufferHasIdentifier(data + 4) || !VerifyPNMBuffer(verifier)) {
            plugin_set_error("invalid-added-frame", "an added frame is not a size-prefixed $PNM.");
            return 400;
        }
        const PNM* added = GetPNM(data + 4);
        const std::string cid = text_of(added->CID()), name = text_of(added->FILE_NAME());
        if (cid.empty() || name.empty()) {
            plugin_set_error("invalid-added-frame", "an added file states no CID or FILE_NAME; nothing is announced.");
            return 400;
        }
        flatbuffers::FlatBufferBuilder b(512);
        const auto address = b.CreateString("/ipfs/" + cid), when = b.CreateString(job.updated_at),
                   cid_off = b.CreateString(cid), name_off = b.CreateString(name),
                   id_off = b.CreateString(provider + ":" + source + ":" + name + ":" + cid);
        PNMBuilder pb(b);
        pb.add_MULTIFORMAT_ADDRESS(address);
        pb.add_PUBLISH_TIMESTAMP(when);
        pb.add_CID(cid_off);
        pb.add_FILE_NAME(name_off);
        pb.add_FILE_ID(id_off);
        FinishSizePrefixedPNMBuffer(b, pb.Finish());
        records.insert(records.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    }
    if (files == 0) {
        plugin_set_error("missing-added-frame", "announce_files needs at least one added file.");
        return 400;
    }
    std::string dataset, tileset, epoch;
    split_job_id(job.job_id, &dataset, &tileset, &epoch);
    R::IngestRequestT meta;
    meta.SCHEMA = "PNM";
    meta.TAGS = std::make_unique<R::SourceTagsT>();
    meta.TAGS->PROVIDER_ID = provider;
    meta.TAGS->SOURCE_NAME = source;
    meta.TAGS->BATCH_ID = tileset + "@" + epoch + "#" + std::to_string(job.first_index);
    meta.TAGS->SOURCE_URL = job.source_url;
    meta.TAGS->LICENSE = config_string(config, "license", "Public domain (NASA)");
    meta.TAGS->CITATION = config_string(config, "attribution", body->attribution);
    meta.RECONCILE = R::reconcileMode_None;  // a unit is a window of the tileset, never its whole set
    meta.PROVENANCE = std::make_unique<R::ProvenanceT>();
    meta.PROVENANCE->SOURCE_URL = job.source_url;
    meta.PROVENANCE->PARSER = "terrain-source";
    meta.PROVENANCE->PARSER_VERSION = kIngestorId;
    meta.PROVENANCE->NORMALIZED_COUNT = files;
    meta.PROVENANCE->SCHEMAS = {"PNM.fbs"};
    meta.PROVENANCE->SCHEMA_COUNTS = {files};
    flatbuffers::FlatBufferBuilder mb(1024);
    R::FinishIngestRequestBuffer(mb, R::IngestRequest::Pack(mb, &meta));
    if (push_typed("meta", "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest", finished(mb)) < 0) return 500;
    return push_typed("records", "PNM.fbs", "$PNM", "PNM", records) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// THE IMPORT: a body's walk encoded ELSEWHERE, published HERE. import_plan
// plans the walk's own unit (body_unit_at over the same config: body, caps,
// max_grid_size, max_range_bytes) at the import's mark, which is its own job
// (dataset_id + "+import"), never below import_from_unit, and asks for the
// unit's files, named by terrain-source:pack's rule, from import_base_url
// (the finished files, staged on this node). import_files checks each answer
// is the file it names and hands the files and their names to the host
// adapter exactly as pack does, so announce_files, the storage lane and
// publish_request publish an imported unit as the walk publishes its own:
// the same names, the same provider and source, BATCH_ID tileset@epoch#unit.
// The files' bytes are the walk's for the same unit and run clock (the clock
// is the only per-run input; RETRIEVED_AT states when the encoder read the
// source). A file not staged yet answers non-200: the unit stops, the mark
// stays, the next tick asks again.
// ---------------------------------------------------------------------------

int import_plan(void) {
    if (refuse_batched()) return 500;
    const std::string config = load_config();
    const std::string body_name = config_string(config, "body", "moon");
    const Body* body = body_named(body_name);
    if (!body) {
        plugin_set_error("unknown-body", ("import_plan has no table for body \"" + body_name + "\" (moon, mars).").c_str());
        return 400;
    }
    const std::string tileset = config_string(config, "tileset_id", "");
    const std::string epoch = config_string(config, "dataset_epoch", "");
    if (tileset.empty() || epoch.empty()) {
        plugin_set_error("missing-tileset-id", "import_plan needs tileset_id and dataset_epoch, the walk's own.");
        return 400;
    }
    std::string base = config_string(config, "import_base_url", "");
    while (!base.empty() && base.back() == '/') base.pop_back();
    if (base.rfind("http://", 0) != 0 && base.rfind("https://", 0) != 0) {
        plugin_set_error("missing-import-base-url",
                         "import_plan needs import_base_url (http or https), where the staged files are served.");
        return 400;
    }
    const int64_t clock = tick_ms();
    if (clock < 0) {
        plugin_set_error("invalid-tick-frame", "the tick frame is not a TimerTick (TICK).");
        return 400;
    }
    std::string retrieved_at = config_string(config, "retrieved_at", "");
    if (retrieved_at.empty() && clock > 0) retrieved_at = iso_ms(clock);
    if (retrieved_at.empty()) {
        plugin_set_error("missing-retrieved-at", "state retrieved_at in the flow config or fire the tick with FIRED_MS.");
        return 400;
    }
    std::string error;
    const std::vector<BodyCap> caps = body_caps(*body, config, &error);
    if (caps.empty()) {
        plugin_set_error("invalid-caps", error.c_str());
        return 400;
    }
    const double max_grid = json_number_or(config, "max_grid_size", 321);
    const double range_bytes = json_number_or(config, "max_range_bytes", kBodyDefaultRangeBytes);
    const long long from_unit = static_cast<long long>(json_number_or(config, "import_from_unit", 0));
    if (from_unit < 0) {
        plugin_set_error("invalid-import-from-unit", "import_from_unit must be a unit index (>= 0).");
        return 400;
    }
    Bytes stream;
    if (!mark_stream(&stream)) {
        plugin_set_error("invalid-mark-frame", "the mark frames are not a complete $FSB chunk sequence.");
        return 400;
    }
    const std::string dataset = config_string(config, "dataset_id", body->dataset_id);
    const std::string job_id = mark_job_id(dataset + "+import", tileset, epoch);
    const MarkState mark = read_mark(stream, job_id);
    const long long start = std::max(from_unit, mark.found && mark.next_index > 0 ? mark.next_index : 0LL);
    // As many of the walk's consecutive units as fit one adapter call (import_max_files, at most 32 files): a unit of
    // the 5 m south pole is one block file, a unit of LDEM_512 32 of them, and a tick moves the same file budget.
    const long max_files = static_cast<long>(std::clamp(json_number_or(config, "import_max_files", kBodyMaxBlocks), 1.0,
                                                        static_cast<double>(kBodyMaxBlocks)));
    const std::string prefix = config_string(config, "path_prefix", body->path_prefix);
    std::vector<std::string> names;
    long long total = 0, next = start;
    std::string first_product, levels;
    std::vector<std::string> level_list;
    // Every unit holds at least one file, so the budget never spans more than max_files units: one pass plans them.
    std::vector<BodyUnit> units;
    body_units_in(*body, caps, max_grid, range_bytes, start, start + max_files, &units, &total);
    for (const BodyUnit& unit : units) {
        std::vector<std::string> unit_names;
        for (const auto& t : unit.tiles) {
            const std::string name = pack_file_name(prefix, t[0], t[1], t[2]);
            if (std::find(unit_names.begin(), unit_names.end(), name) == unit_names.end()) unit_names.push_back(name);
        }
        if (unit_names.empty() || unit_names.size() > static_cast<size_t>(kBodyMaxBlocks)) {
            plugin_set_error("invalid-import-unit", "an import unit names no file, or more than the adapter's 32.");
            return 500;
        }
        if (!names.empty() && names.size() + unit_names.size() > static_cast<size_t>(max_files)) break;
        names.insert(names.end(), unit_names.begin(), unit_names.end());
        if (first_product.empty()) first_product = unit.cap->product->key;
        const std::string level = unit.root ? "0-2" : std::to_string(unit.level);
        if (std::find(level_list.begin(), level_list.end(), level) == level_list.end()) {
            levels += (levels.empty() ? "" : ",") + level;
            level_list.push_back(level);
        }
        next++;
        if (names.size() >= static_cast<size_t>(max_files)) break;
    }
    if (names.empty()) {
        plugin_set_backlog_remaining(0);  // every unit imported: a clean no-op
        return 0;
    }
    const long timeout_ms = config_timeout_ms(config);
    Bytes named;
    for (const std::string& name : names) {
        const std::string url = base + "/" + name;
        flatbuffers::FlatBufferBuilder b(512 + url.size());
        // A stated validator keeps the host from adding its own If-None-Match: a staged file always answers whole.
        std::vector<flatbuffers::Offset<R::Header>> headers{R::CreateHeaderDirect(b, "if-modified-since", kNoValidators)};
        R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", url.c_str(), &headers, nullptr,
                                                                 static_cast<uint32_t>(timeout_ms), kImportMaxFileBytes, nullptr));
        if (push_typed("files", "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", finished(b)) < 0) return 500;
        flatbuffers::FlatBufferBuilder nb(128 + name.size());
        const auto name_off = nb.CreateString(name);
        PNMBuilder pb(nb);
        pb.add_FILE_NAME(name_off);
        FinishSizePrefixedPNMBuffer(nb, pb.Finish());
        named.insert(named.end(), nb.GetBufferPointer(), nb.GetBufferPointer() + nb.GetSize());
    }
    if (push_typed("names", "PNM.fbs", "$PNM", "PNM", named) < 0) return 500;

    Job job;
    job.job_id = job_id;
    job.provider = config_string(config, "provider_id", body->provider_id);
    job.source_url = base;
    job.epoch = epoch;
    job.updated_at = retrieved_at;
    job.walk = body->walk;
    job.first_index = start;
    job.next_index = next;
    job.records_committed = mark.found && mark.stored_total > 0 ? mark.stored_total : 0;
    job.notes = std::string("import of product ") + first_product + ", level " + levels + ", " +
                std::to_string(names.size()) + " files, units " + std::to_string(start) + "-" + std::to_string(next - 1) +
                " of " + std::to_string(total);
    if (push_typed("job", "IRM.fbs", "$IRM", "IRM", build_irm(job, false)) < 0) return 500;
    const long long backlog = total - next;
    plugin_set_backlog_remaining(backlog > 0xffffffffLL ? 0xffffffffu : static_cast<uint32_t>(backlog < 0 ? 0 : backlog));
    return 0;
}

// Accept exactly the gzip envelope emitted by terrain-source:pack. Bound allocation before inflation,
// consume the complete raw deflate stream, and verify both CRC and ISIZE before examining DTT records.
bool inflate_packed_file(const uint8_t* data, size_t length, Bytes* out) {
    const uint8_t header[10] = {31, 139, 8, 0, 0, 0, 0, 0, 0, 255};
    if (!data || length < 18 || std::memcmp(data, header, 10)) return false;
    const auto little = [](const uint8_t* p) {
        return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
    };
    const size_t size = little(data + length - 4);
    if (!size || size > kImportMaxFileBytes) return false;
    out->resize(size);
    tinfl_decompressor inflater;
    tinfl_init(&inflater);
    size_t consumed = length - 18, produced = size;
    const auto status = tinfl_decompress(&inflater, data + 10, &consumed, out->data(), out->data(), &produced,
                                         TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
    return status == TINFL_STATUS_DONE && consumed == length - 18 && produced == size &&
           uint32_t(mz_crc32(MZ_CRC32_INIT, out->data(), out->size())) == little(data + length - 8);
}

int import_files(void) {
    const auto fail = [](const char* code, const std::string& message) {
        plugin_set_error(code, message.c_str());
        return 400;
    };
    const plugin_input_frame_t* names_frame = nullptr;
    std::vector<const plugin_input_frame_t*> responses;
    for (uint32_t i = 0; i < plugin_get_input_count(); i++) {
        const plugin_input_frame_t* f = plugin_get_input_frame(i);
        if (!f || !f->port_id) continue;
        if (std::strcmp(f->port_id, "names") == 0) {
            if (names_frame) return fail("batched-input-frames", "import_files takes one names frame per unit.");
            names_frame = f;
        } else if (std::strcmp(f->port_id, "responses") == 0) {
            responses.push_back(f);
        }
    }
    if (!names_frame || !names_frame->payload) return fail("missing-names-frame", "import_files needs import_plan's names.");
    std::vector<std::string> names;
    for (size_t at = 0; at + 4 <= names_frame->payload_length;) {
        uint32_t size;
        std::memcpy(&size, names_frame->payload + at, 4);
        at += 4;
        if (size == 0) continue;
        if (size > names_frame->payload_length - at) return fail("invalid-names-frame", "the names frame is malformed.");
        flatbuffers::Verifier verifier(names_frame->payload + at, size);
        if (!PNMBufferHasIdentifier(names_frame->payload + at) || !VerifyPNMBuffer(verifier))
            return fail("invalid-names-frame", "a name is not a $PNM.");
        names.push_back(text_of(GetPNM(names_frame->payload + at)->FILE_NAME()));
        at += size;
    }
    if (names.empty() || names.size() > static_cast<size_t>(kBodyMaxBlocks) || responses.size() != names.size())
        return fail("invalid-import-unit", "import_files needs one response per named file (1 to 32).");
    const std::string config = load_config();
    const std::string tileset = config_string(config, "tileset_id", "");
    const Body* named_body = body_named(config_string(config, "body", "moon"));
    if (!named_body) return fail("unknown-body", "import_files: the config names no body this module has a table for.");
    const std::string prefix = config_string(config, "path_prefix", named_body->path_prefix);
    for (size_t k = 0; k < names.size(); k++) {
        const plugin_input_frame_t* f = responses[k];
        const std::string& name = names[k];
        flatbuffers::Verifier verifier(f->payload ? f->payload : reinterpret_cast<const uint8_t*>(""), f->payload_length);
        if (!f->payload || f->payload_length < 8 || !R::VerifyHttpResponseBuffer(verifier))
            return fail("invalid-response-frame", "a response frame is not an HttpResponse (HRSP).");
        const R::HttpResponse& r = *R::GetHttpResponse(f->payload);
        const std::string url = text_of(r.URL());
        if (url.size() < name.size() + 1 || url.compare(url.size() - name.size() - 1, std::string::npos, "/" + name) != 0)
            return fail("import-out-of-order", "the response for " + name + " came from " + url + ".");
        if (r.STATUS() != 200) {
            return fail(r.STATUS() == 404 ? "import-not-staged" : "import-fetch-failed",
                        name + " answered " + std::to_string(r.STATUS()) +
                            (r.ERROR() && r.ERROR()->size() ? " (" + r.ERROR()->str() + ")" : std::string()) +
                            ": the unit is not imported and its mark stays; it is asked for again on the next tick.");
        }
        const auto* body = r.BODY();
        if (!body || body->size() == 0 || body->size() > kImportMaxFileBytes)
            return fail("import-file-size", name + " is empty or larger than 8 MiB.");
        Bytes inflated;
        if (!inflate_packed_file(body->data(), body->size(), &inflated))
            return fail("import-file-malformed", name + " is not a complete canonical gzip DTT file (header, deflate, CRC or size).");
        // Validate the inflated records, then forward the stored gzip bytes unchanged.
        const uint8_t* data = inflated.data();
        const size_t length = inflated.size();
        size_t tiles = 0;
        for (size_t at = 0; at < length;) {
            if (length - at < 4) return fail("import-file-malformed", name + " ends inside a size prefix.");
            uint32_t size;
            std::memcpy(&size, data + at, 4);
            at += 4;
            if (size == 0) continue;
            if (size > length - at) return fail("import-file-malformed", name + " is not a size-prefixed $DTT stream.");
            flatbuffers::Verifier dv(data + at, size);
            if (!DTTBufferHasIdentifier(data + at) || !VerifyDTTBuffer(dv))
                return fail("import-file-malformed", name + " holds a record that is not a $DTT.");
            const DTT* t = GetDTT(data + at);
            if (t->TILING_SCHEME() != dttTilingScheme_GEOGRAPHIC_TWO_ROOT_BODY || !t->PAYLOAD() ||
                text_of(t->PAYLOAD()->CONTENT_ENCODING()) != "qm-edge-matched-planes-v1")
                return fail("import-file-mismatch", name + " requires body records encoded as qm-edge-matched-planes-v1.");
            if (pack_file_name(prefix, t->LEVEL(), t->X(), t->Y()) != name)
                return fail("import-file-mismatch", name + " holds a tile of another file (level " +
                                                       std::to_string(t->LEVEL()) + ", " + std::to_string(t->X()) + "/" +
                                                       std::to_string(t->Y()) + ").");
            if (!tileset.empty() && text_of(t->TILESET_ID()) != tileset)
                return fail("import-file-mismatch", name + " belongs to tileset " + text_of(t->TILESET_ID()) + ", not " + tileset + ".");
            tiles++;
            at += size;
        }
        if (tiles == 0) return fail("import-file-malformed", name + " holds no tile.");
        if (plugin_push_output_ex("file", "DTT.fbs", "$DTT", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "DTT", 0, 0, body->data(),
                                  body->size()) < 0)
            return 500;
    }
    return push_typed("names", "PNM.fbs", "$PNM", "PNM",
                      Bytes(names_frame->payload, names_frame->payload + names_frame->payload_length)) < 0 ? 500 : 0;
}

// publish_request: the storage-ingest IngestResult, the IngestRequest that produced it and the job ($IRM) -> the
// advanced durable mark ($IRM, for hostcap/storage-write and egress) and, only when publish_url is configured, the
// dataset-publication POST (body: the IngestResult naming the stored batch). The mark advances FROM THE VERIFIED STORE
// RESULT, never at dispatch: a crash between fetch and store re-runs the cell instead of leaving an invisible hole.
int publish_request(void) {
    if (refuse_batched()) return 500;

    const plugin_input_frame_t* result_frame = frame_for("result");
    const plugin_input_frame_t* meta_frame = frame_for("meta");
    if (!result_frame || !result_frame->payload || result_frame->payload_length == 0) {
        plugin_set_error("missing-result-frame", "publish_request requires the storage-ingest result frame.");
        return 400;
    }
    if (!meta_frame || !meta_frame->payload || meta_frame->payload_length == 0) {
        plugin_set_error("missing-meta-frame", "publish_request requires the ingest meta frame.");
        return 400;
    }
    flatbuffers::Verifier result_verifier(result_frame->payload, result_frame->payload_length);
    if (!R::VerifyIngestResultBuffer(result_verifier)) {
        plugin_set_error("invalid-result-frame", "the result frame is not an IngestResult (INGR).");
        return 400;
    }
    flatbuffers::Verifier meta_verifier(meta_frame->payload, meta_frame->payload_length);
    if (!R::VerifyIngestRequestBuffer(meta_verifier)) {
        plugin_set_error("invalid-meta-frame", "the meta frame is not an IngestRequest (INGQ).");
        return 400;
    }
    Job job;
    if (!read_job("job", &job)) {
        plugin_set_error("missing-job-frame", "publish_request requires the job frame ($IRM) the batch was planned under.");
        return 400;
    }
    const R::IngestResult& result = *R::GetIngestResult(result_frame->payload);
    const R::IngestRequest& meta = *R::GetIngestRequest(meta_frame->payload);
    const std::string batch_id = text_of(meta.TAGS()->BATCH_ID());

    // A REFUSED batch stored nothing: the mark does NOT advance (the store refused it - policy, disk guardrail or a
    // value over its bound - and the cell must be built again, not skipped).
    if (result.REFUSED() && result.REFUSED()->size()) {
        plugin_set_error("ingest-refused", ("storage.ingest_with_source refused batch " + batch_id + ": " +
                                            result.REFUSED()->str() + ". The resume mark is NOT advanced.").c_str());
        return 502;
    }
    // THE SILENT NOP, CAUGHT: inserted=0 for a batch that carried tiles is byte-identical to a batch of pure ocean the
    // builder skipped, and only the count the run produced tells them apart.
    const long long inserted = static_cast<long long>(result.INSERTED());
    const auto* provenance = meta.PROVENANCE();
    const bool counted = provenance && provenance->SCHEMA_COUNTS() && provenance->SCHEMA_COUNTS()->size() > 0;
    const long long records_in = counted ? static_cast<long long>(provenance->NORMALIZED_COUNT()) : -1;
    if (inserted == 0 && records_in > 0) {
        char message[320];
        std::snprintf(message, sizeof(message),
                      "storage.ingest_with_source reported inserted=0 for a batch carrying %lld tiles (batch %s). "
                      "The resume mark is NOT advanced: advancing it would leave a permanent hole in the pyramid "
                      "that every later tick walks past.",
                      records_in, batch_id.c_str());
        plugin_set_error("ingest-stored-nothing", message);
        return 502;
    }

    const std::string config = load_config();
    // THE DURABLE MARK: the job, completed from the verified result. CUMULATIVE, and only what STORAGE confirmed.
    job.records_committed += inserted > 0 ? inserted : 0;
    job.chunk_records = job.next_index - job.first_index >= 0 ? inserted : -1;
    job.batch_id = batch_id;
    if (provenance) {
        job.etag = text_of(provenance->ETAG());
        job.last_modified = text_of(provenance->LAST_MODIFIED());
    }
    const std::string stamped = config_string(config, "retrieved_at", "");
    if (!stamped.empty()) job.updated_at = stamped;
    if (const Body* body = body_of_walk(job.walk)) {
        // A body's walk: its length is the same pure function of the config body_plan walks.
        std::string error;
        const std::vector<BodyCap> caps = body_caps(*body, config, &error);
        long long total = 0;
        BodyUnit unused;
        if (!caps.empty())
            body_unit_at(*body, caps, json_number_or(config, "max_grid_size", 321),
                         json_number_or(config, "max_range_bytes", kBodyDefaultRangeBytes), -1, &unused, &total);
        job.complete = total > 0 && job.next_index >= total;
    } else if (job.walk == "cell") {
        // The walk's length is a pure function of the config, re-derived exactly as granule_plan derives it.
        const long global_max_level = static_cast<long>(json_number_or(config, "max_level", -1));
        const std::vector<Region> regions = parse_regions(config, global_max_level < 0 ? 0 : global_max_level);
        const long min_level = static_cast<long>(json_number_or(config, "min_level", kGranuleMinLevel));
        const long long walk_cells = regions.empty() ? 0 : total_cells(regions, min_level);
        job.complete = walk_cells > 0 && job.next_index >= walk_cells;
    }
    if (push_typed("mark", "IRM.fbs", "$IRM", "IRM", build_irm(job, true)) < 0) return 500;

    const std::string publish_url = config_string(config, "publish_url", "");
    // Fail-closed. Absence of configuration is not permission to publish.
    if (publish_url.empty()) return 0;
    std::string schema = text_of(result.SCHEMA());
    if (schema.empty()) schema = text_of(meta.SCHEMA());
    const std::string provider = text_of(meta.TAGS()->PROVIDER_ID()), source = text_of(meta.TAGS()->SOURCE_NAME());
    if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) {
        plugin_set_error("incomplete-publication-identity",
                         "publish_request needs schema, batchId, providerId and sourceName.");
        return 400;
    }
    flatbuffers::FlatBufferBuilder body_builder(512);
    R::FinishIngestResultBuffer(
        body_builder, R::CreateIngestResultDirect(body_builder, schema.c_str(), provider.c_str(), source.c_str(),
                                                  batch_id.c_str(), result.INSERTED(), result.RECONCILED_DUPLICATES(),
                                                  result.RECONCILED_OLD_BATCHES(),
                                                  result.ARCHIVED() && result.ARCHIVED()->size() ? result.ARCHIVED()->c_str() : nullptr,
                                                  nullptr));
    const Bytes body = finished(body_builder);
    std::vector<flatbuffers::Offset<R::Header>> headers;
    flatbuffers::FlatBufferBuilder b(512 + body.size() + publish_url.size());
    headers.push_back(R::CreateHeaderDirect(b, "content-type", "application/octet-stream"));
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "POST", publish_url.c_str(), &headers, &body,
                                                             static_cast<uint32_t>(config_timeout_ms(config)), 0, nullptr));
    return push_typed("request", "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", finished(b)) < 0 ? 500 : 0;
}

}  // extern "C"
