// HIGH-DEFINITION BODY IMAGERY TILES (com.digitalarsenal.data-source.body-imagery-tiles).
//
// A body's global mosaic as the console's tile pyramid, written as the files the engine's imageryFromTileFiles reads
// for the Moon (data-source/moon-imagery), whatever serves them:
//   imagery/<NAIF id>/root.dtts            levels 0-2 (42 tiles)
//   imagery/<NAIF id>/<L>/<X16>_<Y>.dtts   16 tiles of one level-L row, X16 = x >> 4, Y from the SOUTH
// each a size-prefixed $DTT stream ([u32 LE length][record]) ordered by x; one $DTT per 256 px baseline JPEG tile
// (GEOGRAPHIC_TWO_ROOT_BODY, PAYLOAD_FORMAT CUSTOM, MEDIA_TYPE image/jpeg, the JPEG inline).
//
// Three pure transforms, one unit each (the caller owns the walk, the ranged reads and the files):
//   tiles_plan    unit {level 9, row} -> the whole-row byte range of the mosaic that tile row needs (If-Match on the
//                 file's ETag) and the unit with first_row / row_count;
//   tiles_direct  unit + the range's HttpResponse -> the level-9 row's 1024 tiles in 64 files (area average);
//   tiles_reduce  unit {level L, row} + the child level's files of rows 2 row and 2 row + 1 -> level L's row (the 2 x 2
//                 mean of the measured pixels of the decoded children); level 2 takes all of level 3 and builds the
//                 root levels 0-2 in root.dtts.
// First source: Mars, the USGS Astrogeology THEMIS Day IR mosaic 100 m v12 (source.hpp).
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <space_data_module_invoke.h>  // staged by the SDK compiler
#include <typedHostcall.hpp>  // staged by the SDK compiler
#include <HttpRequest_generated.h>  // staged by the SDK compiler
#include <HttpResponse_generated.h>  // staged by the SDK compiler
#include <ModuleConfig_generated.h>  // staged by the SDK compiler

#include "sources_big.hpp"
#include "sources_small.hpp"

namespace {

namespace R = sdn::runtime;
using Bytes = std::vector<uint8_t>;

constexpr int kRowFile = 16, kRootMaxLevel = 2;
constexpr const char* kNoValidators = "Thu, 01 Jan 1970 00:00:00 GMT";
constexpr const char* kIngestorId = "body-imagery-tiles/v3";
constexpr int kDefaultNaif = 499;
constexpr double kPi = 3.14159265358979323846;

Bytes finished(const flatbuffers::FlatBufferBuilder& b) { return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize()); }
int push_typed(const char* port, const char* schema, const char* id, const char* root, const Bytes& bytes) {
    return plugin_push_output_ex(port, schema, id, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, bytes.data(),
                                 static_cast<uint32_t>(bytes.size()));
}
// The source of the unit's body: the NAIF id in the unit (499, Mars THEMIS, when it names none).
const bit::Source* find_source(int naif) {
    if (naif == kDefaultNaif) return &bit::themis_day_ir();
    size_t count = 0;
    const bit::Source* table = bit::small_sources(&count);
    for (size_t i = 0; i < count; i++)
        if (table[i].naif == naif) return &table[i];
    table = bit::big_sources(&count);  // the first of a body is its imagery; Venus' C3-MDIR (the fill) comes after it
    for (size_t i = 0; i < count; i++)
        if (table[i].naif == naif) return &table[i];
    return nullptr;
}
std::string text_of(const flatbuffers::String* s) { return s ? s->str() : std::string(); }
const plugin_input_frame_t* frame_for(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    return index < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(index));
}
void put_u32(Bytes* out, uint32_t v) {
    for (int i = 0; i < 4; i++) out->push_back(static_cast<uint8_t>(v >> (8 * i)));
}
uint32_t get_u32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

// The node config (plugin.getConfig) and the unit frame (a ModuleConfig): scalars by key.
struct Config {
    std::map<std::string, std::string> strings;
    std::map<std::string, double> numbers;
    std::string str(const char* key, const char* fallback) const {
        const auto it = strings.find(key);
        return it == strings.end() || it->second.empty() ? fallback : it->second;
    }
    double num(const char* key, double fallback) const {
        const auto it = numbers.find(key);
        return it == numbers.end() ? fallback : it->second;
    }
};
void read_entries(const flatbuffers::Vector<flatbuffers::Offset<R::ConfigEntry>>* entries, Config* c) {
    for (size_t i = 0; entries && i < entries->size(); i++) {
        const R::ConfigEntry* e = entries->Get(static_cast<flatbuffers::uoffset_t>(i));
        if (!e || !e->KEY()) continue;
        if (e->KIND() == R::configValueKind_String) c->strings[e->KEY()->str()] = text_of(e->STRING_VALUE());
        else if (e->KIND() == R::configValueKind_Number) c->numbers[e->KEY()->str()] = e->NUMBER_VALUE();
    }
}
Config load_config() {
    Config c;
    const sdm_piv::Config config = sdm_piv::get_config();
    if (config.ok()) read_entries(config.entries(), &c);
    return c;
}
bool read_mcfg(const char* port, Config* c) {
    const plugin_input_frame_t* f = frame_for(port);
    if (!f || !f->payload || f->payload_length < 8) return false;
    flatbuffers::Verifier verifier(f->payload, f->payload_length);
    if (!R::VerifyModuleConfigBuffer(verifier)) return false;
    read_entries(R::GetModuleConfig(f->payload)->ENTRIES(), c);
    return true;
}
int push_unit(const Config& u) {
    R::ModuleConfigT options;
    for (const auto& kv : u.numbers) {
        auto e = std::make_unique<R::ConfigEntryT>();
        e->KEY = kv.first;
        e->KIND = R::configValueKind_Number;
        e->NUMBER_VALUE = kv.second;
        options.ENTRIES.push_back(std::move(e));
    }
    flatbuffers::FlatBufferBuilder b(256);
    R::FinishModuleConfigBuffer(b, R::ModuleConfig::Pack(b, &options));
    return push_typed("unit", "ModuleConfig.fbs", R::ModuleConfigIdentifier(), "ModuleConfig", finished(b));
}

// Each record of a size-prefixed stream (zero-length prefixes are alignment padding).
template <typename F>
void each_record(const uint8_t* data, size_t size, F f) {
    for (size_t at = 0; at + 4 <= size;) {
        const uint32_t n = get_u32(data + at);
        at += 4;
        if (n == 0) continue;
        if (n > size - at) return;
        f(data + at, n);
        at += n;
    }
}

// ── tiles ──────────────────────────────────────────────────────────────────
struct TileOut {
    uint32_t level, x, y;  // y from the south
    Bytes jpeg;
};

Bytes dtt_record(const bit::Source& src, const TileOut& t, const std::string& retrieved_at) {
    const double span = 180.0 / static_cast<double>(1u << t.level);
    flatbuffers::FlatBufferBuilder b(t.jpeg.size() + 1024);
    const auto bytes = b.CreateVector(t.jpeg);
    const auto media = b.CreateString("image/jpeg");
    DTTPayloadRefBuilder pb(b);
    pb.add_BYTES(bytes);
    pb.add_SIZE_BYTES(t.jpeg.size());
    pb.add_MEDIA_TYPE(media);
    const auto payload = pb.Finish();
    const auto dataset = b.CreateString(src.key), name = b.CreateString(src.dataset_name),
               epoch = b.CreateString(src.epoch), url = b.CreateString(src.url), when = b.CreateString(retrieved_at),
               license = b.CreateString(src.license), license_url = b.CreateString(src.license_url),
               attribution = b.CreateString(src.citation), processor = b.CreateString(kIngestorId);
    DTTProvenanceBuilder prov(b);
    prov.add_DATASET_ID(dataset);
    prov.add_DATASET_NAME(name);
    prov.add_DATASET_EPOCH(epoch);
    prov.add_SOURCE_URL(url);
    prov.add_RETRIEVED_AT(when);
    prov.add_LICENSE(license);
    prov.add_LICENSE_URL(license_url);
    prov.add_ATTRIBUTION(attribution);
    prov.add_PROCESSOR(processor);
    const auto provenance = prov.Finish();
    const auto tileset_off = b.CreateString(src.tileset), version = b.CreateString(bit::band_count(src) == 3 ? "jpeg-baseline-rgb-v1" : "jpeg-baseline-gray-v1"),
               center = b.CreateString(src.center), datum = b.CreateString(src.datum);
    const auto radii = b.CreateVector(std::vector<double>{src.sphere_m, src.sphere_m, src.sphere_m});
    DTTBuilder d(b);
    d.add_TILESET_ID(tileset_off);
    d.add_TILING_SCHEME(dttTilingScheme::GEOGRAPHIC_TWO_ROOT_BODY);
    d.add_LEVEL(t.level);
    d.add_X(t.x);
    d.add_Y(t.y);
    d.add_ROW_ORIGIN_NORTH(false);
    d.add_WEST_DEG(-180.0 + t.x * span);
    d.add_EAST_DEG(-180.0 + (t.x + 1) * span);
    d.add_SOUTH_DEG(-90.0 + t.y * span);
    d.add_NORTH_DEG(-90.0 + (t.y + 1) * span);
    d.add_PAYLOAD_FORMAT(dttPayloadFormat::CUSTOM);
    d.add_PAYLOAD_FORMAT_VERSION(version);
    d.add_PAYLOAD(payload);
    d.add_GRID_WIDTH(bit::kTile);
    d.add_GRID_HEIGHT(bit::kTile);
    d.add_POST_SPACING_M(span * kPi / 180.0 * src.sphere_m / bit::kTile);
    d.add_SOURCE_POST_SPACING_M(src.pixel_m);
    d.add_HORIZONTAL_DATUM_NAME(datum);
    d.add_MAX_LEVEL(static_cast<uint32_t>(src.max_level));
    d.add_PROVENANCE(provenance);
    d.add_CENTER_NAME(center);
    d.add_REFERENCE_RADII_M(radii);
    FinishDTTBuffer(b, d.Finish());
    return finished(b);
}

std::string file_name(const bit::Source& src, uint32_t level, uint32_t x, uint32_t y) {
    const std::string prefix = "imagery/" + std::to_string(src.naif);
    if (level <= static_cast<uint32_t>(kRootMaxLevel)) return prefix + "/root.dtts";
    char buf[64];
    std::snprintf(buf, sizeof(buf), "/%u/%u_%u.dtts", level, x / kRowFile, y);
    return prefix + buf;
}

// The unit's files ("file" frames in order, one "names" $PNM stream) from its tiles (any order).
int emit_files(const bit::Source& src, std::vector<TileOut>& tiles, const std::string& retrieved_at) {
    std::sort(tiles.begin(), tiles.end(), [](const TileOut& a, const TileOut& b) {
        return a.level != b.level ? a.level < b.level : a.y != b.y ? a.y < b.y : a.x < b.x;
    });
    std::vector<std::pair<std::string, Bytes>> files;
    for (const TileOut& t : tiles) {
        const std::string name = file_name(src, t.level, t.x, t.y);
        auto it = std::find_if(files.begin(), files.end(), [&](const auto& f) { return f.first == name; });
        if (it == files.end()) {
            files.push_back({name, {}});
            it = files.end() - 1;
        }
        const Bytes record = dtt_record(src, t, retrieved_at);
        put_u32(&it->second, static_cast<uint32_t>(record.size()));
        it->second.insert(it->second.end(), record.begin(), record.end());
    }
    if (files.size() > 256) {
        plugin_set_error("too-many-files", "a unit made more than 256 files.");
        return 500;
    }
    Bytes names;
    for (const auto& f : files) {
        if (push_typed("file", "DTT.fbs", "$DTT", "DTT", f.second) < 0) return 500;
        flatbuffers::FlatBufferBuilder b(256);
        const auto name_off = b.CreateString(f.first);
        PNMBuilder pb(b);
        pb.add_FILE_NAME(name_off);
        FinishSizePrefixedPNMBuffer(b, pb.Finish());
        names.insert(names.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    }
    return push_typed("names", "PNM.fbs", "$PNM", "PNM", names) < 0 ? 500 : 0;
}

// One 256 x 256 tile of a grayscale image `img` (width w) at pixel (x0, y0, from the north), as JPEG.
Bytes tile_jpeg(const jpeg::Encoder& enc, const uint8_t* img, size_t w, size_t x0, size_t y0, int bands) {
    const size_t row = static_cast<size_t>(bit::kTile) * bands;
    std::vector<uint8_t> px(row * bit::kTile);
    for (int r = 0; r < bit::kTile; r++) std::memcpy(&px[static_cast<size_t>(r) * row], img + ((y0 + r) * w + x0) * bands, row);
    return enc.encode(px.data(), bit::kTile, bit::kTile, bands);
}

// The tiles of `level` cut from an image of the whole level (w x h) or of its rows [row0, row0 + h / 256) (from the south).
void cut_tiles(const jpeg::Encoder& enc, const std::vector<uint8_t>& img, size_t w, size_t h, uint32_t level, uint32_t row0,
               std::vector<TileOut>* out, int bands) {
    const size_t across = w / bit::kTile, down = h / bit::kTile;
    for (size_t r = 0; r < down; r++)
        for (size_t x = 0; x < across; x++)
            out->push_back({level, static_cast<uint32_t>(x), row0 + static_cast<uint32_t>(down - 1 - r),
                            tile_jpeg(enc, img.data(), w, x * bit::kTile, r * bit::kTile, bands)});
}

// A ranged GET of one source's bytes [at, at + bytes) pinned to its edition, pushed on `port`.
int push_range(const char* port, const bit::Source& s, uint64_t at, uint64_t bytes, double timeout_ms) {
    const std::string range = "bytes=" + std::to_string(at) + "-" + std::to_string(at + bytes - 1);
    flatbuffers::FlatBufferBuilder b(512);
    // If-Modified-Since epoch: the request states its own validator, so the host adds no If-None-Match from the last
    // 2xx it booked for this URL (every range of the mosaic shares it and would answer 304).
    std::vector<flatbuffers::Offset<R::Header>> headers{R::CreateHeaderDirect(b, "range", range.c_str()),
                                                       R::CreateHeaderDirect(b, "if-match", s.etag),
                                                       R::CreateHeaderDirect(b, "if-modified-since", kNoValidators)};
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", s.url, &headers, nullptr, static_cast<uint32_t>(timeout_ms), 0, nullptr));
    return push_typed(port, "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", finished(b));
}

}  // namespace

extern "C" {

int tiles_plan(void) {
    Config unit;
    if (!read_mcfg("unit", &unit)) {
        plugin_set_error("missing-unit-frame", "tiles_plan requires the unit frame (ModuleConfig).");
        return 400;
    }
    const bit::Source* source = find_source(static_cast<int>(unit.num("naif", kDefaultNaif)));
    if (!source) {
        plugin_set_error("unknown-body", "the unit's naif names no body this module has a source for.");
        return 400;
    }
    const bit::Source& src = *source;
    const int level = static_cast<int>(unit.num("level", -1));
    const double row = unit.num("row", -1);
    if (level != src.max_level || row < 0 || row >= static_cast<double>(1u << level)) {
        plugin_set_error("invalid-unit", "the unit names no tile row at its body's deepest level.");
        return 400;
    }
    const Config config = load_config();
    const bool whole = src.max_level <= kRootMaxLevel;  // a body of 1-2 levels is one unit: all its source rows
    const uint64_t y_north = (1u << level) - 1 - static_cast<uint64_t>(row);
    uint64_t first = 0, last = src.height - 1;
    if (!whole) bit::source_rows_for(src, level, y_north, &first, &last);
    const uint64_t count = last - first + 1;
    static const char* const kPorts[3] = {"rows_0", "rows_1", "rows_2"};
    const double timeout_ms = config.num("timeout_ms", 600000);
    for (int band = 0; band < bit::band_count(src); band++) {
        const uint64_t base = src.strip0 + static_cast<uint64_t>(band) * src.plane_stride;
        if (push_range(kPorts[band], src, base + first * src.width, count * src.width, timeout_ms) < 0) return 500;
    }
    unit.numbers["first_row"] = static_cast<double>(first);
    unit.numbers["row_count"] = static_cast<double>(count);
    // A source with a fill (a mosaic that stops short of the poles and has holes) also reads the fill source's rows of the tile row.
    unit.numbers["fill_row_count"] = 0;
    const bit::Source* fill = src.fill_key[0] ? bit::find_big_source(src.fill_key) : nullptr;
    if (fill && !whole) {
        uint64_t ffirst = 0, flast = 0;
        bit::source_rows_for(*fill, level, y_north, &ffirst, &flast);
        if (ffirst > 0) ffirst--;  // a row each side for the bilinear fill
        if (flast + 1 < fill->height) flast++;
        if (push_range("fill_0", *fill, fill->strip0 + ffirst * fill->width, (flast - ffirst + 1) * fill->width, timeout_ms) < 0) return 500;
        unit.numbers["fill_first_row"] = static_cast<double>(ffirst);
        unit.numbers["fill_row_count"] = static_cast<double>(flast - ffirst + 1);
    }
    return push_unit(unit) < 0 ? 500 : 0;
}

int tiles_direct(void) {
    Config unit;
    if (!read_mcfg("unit", &unit)) {
        plugin_set_error("missing-unit-frame", "tiles_direct requires the unit frame (ModuleConfig).");
        return 400;
    }
    const bit::Source* source = find_source(static_cast<int>(unit.num("naif", kDefaultNaif)));
    if (!source) {
        plugin_set_error("unknown-body", "the unit's naif names no body this module has a source for.");
        return 400;
    }
    const bit::Source& src = *source;
    const int level = static_cast<int>(unit.num("level", -1));
    const double row = unit.num("row", -1);
    if (level != src.max_level || row < 0 || row >= static_cast<double>(1u << level)) {
        plugin_set_error("invalid-unit", "the unit names no tile row at its body's deepest level.");
        return 400;
    }
    const uint64_t first = static_cast<uint64_t>(unit.num("first_row", 0)), count = static_cast<uint64_t>(unit.num("row_count", 0));
    const int bands = bit::band_count(src);
    static const char* const kPorts[3] = {"rows_0", "rows_1", "rows_2"};
    const uint8_t* planes[3] = {nullptr, nullptr, nullptr};
    for (int band = 0; band < bands; band++) {
        const plugin_input_frame_t* f = frame_for(kPorts[band]);
        if (!f || !f->payload) {
            plugin_set_error("missing-rows-frame", "tiles_direct requires a rows_<band> response for each band.");
            return 400;
        }
        flatbuffers::Verifier verifier(f->payload, f->payload_length);
        if (!R::VerifyHttpResponseBuffer(verifier)) {
            plugin_set_error("invalid-response-frame", "a rows_<band> frame is not an HttpResponse (HRSP).");
            return 400;
        }
        const R::HttpResponse* r = R::GetHttpResponse(f->payload);
        if (r->STATUS() != 206 || !r->BODY() || r->BODY()->size() != count * src.width) {
            char message[300];
            std::snprintf(message, sizeof(message), "the source rows did not arrive (HTTP %d, %zu of %llu bytes%s%s).",
                          static_cast<int>(r->STATUS()), r->BODY() ? static_cast<size_t>(r->BODY()->size()) : 0,
                          static_cast<unsigned long long>(count * src.width), r->ERROR() ? ", " : "", r->ERROR() ? r->ERROR()->c_str() : "");
            plugin_set_error("rows-not-delivered", message);
            return 502;
        }
        planes[band] = r->BODY()->data();
    }
    const Config config = load_config();
    const jpeg::Encoder enc(static_cast<int>(config.num("jpeg_quality", 88)));
    const std::vector<bit::ColumnTap> taps = bit::column_taps(src, level);
    const auto band_of = [&](uint64_t y_north, std::vector<uint8_t>* out) {
        if (bands == 3) bit::resample_row_rgb(src, level, y_north, planes, first, count, taps, out);
        else bit::resample_row(src, level, y_north, planes[0], first, count, taps, out);
    };
    std::vector<TileOut> tiles;
    if (src.max_level > kRootMaxLevel) {
        std::vector<uint8_t> img;
        band_of((1u << level) - 1 - static_cast<uint64_t>(row), &img);
        const uint64_t fill_count = static_cast<uint64_t>(unit.num("fill_row_count", 0));
        if (fill_count > 0) {  // the coarser source fills what the finer one lacks
            const bit::Source* fill = bit::find_big_source(src.fill_key);
            const plugin_input_frame_t* f = fill ? frame_for("fill_0") : nullptr;
            flatbuffers::Verifier fv(f ? f->payload : nullptr, f ? f->payload_length : 0);
            if (!f || !f->payload || !R::VerifyHttpResponseBuffer(fv)) {
                plugin_set_error("missing-fill-frame", "tiles_direct requires the fill_0 response the plan asked for.");
                return 400;
            }
            const R::HttpResponse* fr = R::GetHttpResponse(f->payload);
            if (fr->STATUS() != 206 || !fr->BODY() || fr->BODY()->size() != fill_count * fill->width) {
                plugin_set_error("rows-not-delivered", "the fill source's rows did not arrive.");
                return 502;
            }
            const uint8_t* fplanes[3] = {fr->BODY()->data(), nullptr, nullptr};
            bit::fill_gaps(*fill, level, (1u << level) - 1 - static_cast<uint64_t>(row), fplanes, static_cast<uint64_t>(unit.num("fill_first_row", 0)), fill_count, &img);
        }
        cut_tiles(enc, img, bit::level_width(level), bit::kTile, static_cast<uint32_t>(level), static_cast<uint32_t>(row), &tiles, bands);
    } else {
        // A body of 1-2 levels: the whole deepest level from this one unit, halved down to level 0, all in root.dtts.
        const size_t w = bit::level_width(level), h = static_cast<size_t>(bit::kTile) << level;
        std::vector<uint8_t> whole(w * h * bands), part;
        for (uint64_t y = 0; y < (1u << level); y++) {
            band_of(y, &part);
            std::memcpy(&whole[y * bit::kTile * w * bands], part.data(), part.size());
        }
        size_t cw = w, ch = h;
        for (int l = level; l >= 0; l--) {
            cut_tiles(enc, whole, cw, ch, static_cast<uint32_t>(l), 0, &tiles, bands);
            if (l > 0) {
                whole = bands == 3 ? bit::halve_rgb(whole, cw, ch) : bit::halve(whole, cw, ch);
                cw /= 2;
                ch /= 2;
            }
        }
    }
    return emit_files(src, tiles, config.str("retrieved_at", src.epoch));
}

int tiles_reduce(void) {
    Config unit;
    if (!read_mcfg("unit", &unit)) {
        plugin_set_error("missing-unit-frame", "tiles_reduce requires the unit frame (ModuleConfig).");
        return 400;
    }
    const bit::Source* source = find_source(static_cast<int>(unit.num("naif", kDefaultNaif)));
    if (!source) {
        plugin_set_error("unknown-body", "the unit's naif names no body this module has a source for.");
        return 400;
    }
    const bit::Source& src = *source;
    const int level = static_cast<int>(unit.num("level", -1));
    const double row_d = unit.num("row", -1);
    if (level < kRootMaxLevel || level >= src.max_level || row_d < 0 || row_d >= static_cast<double>(1u << level)) {
        plugin_set_error("invalid-unit", "the unit names no level this module reduces to (2 up to the body's deepest level, exclusive).");
        return 400;
    }
    const bool root = level == kRootMaxLevel;
    const int child = level + 1;
    const uint32_t row = static_cast<uint32_t>(row_d);
    // The child rows wanted, from the south: two, or all of level 3 for the root.
    const uint32_t c0 = root ? 0 : 2 * row, cn = root ? (1u << child) : 2;
    const size_t cw = bit::level_width(child), ch = static_cast<size_t>(cn) * bit::kTile;
    const int bands = bit::band_count(src);
    std::vector<uint8_t> img(cw * ch * bands, 0);
    std::vector<uint8_t> seen(static_cast<size_t>(cn) * (cw / bit::kTile), 0);
    size_t have = 0;
    for (uint32_t ordinal = 0;; ordinal++) {
        const int32_t idx = plugin_find_input_index("child", ordinal);
        if (idx < 0) break;
        const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
        if (!f || !f->payload) continue;
        each_record(f->payload, f->payload_length, [&](const uint8_t* rec, uint32_t size) {
            if (size < 8 || !DTTBufferHasIdentifier(rec)) return;
            flatbuffers::Verifier v(rec, size);
            if (!VerifyDTTBuffer(v)) return;
            const DTT* t = GetDTT(rec);
            if (t->LEVEL() != static_cast<uint32_t>(child) || t->Y() < c0 || t->Y() >= c0 + cn || t->X() >= cw / bit::kTile) return;
            const size_t slot = static_cast<size_t>(t->Y() - c0) * (cw / bit::kTile) + t->X();
            if (seen[slot] || !t->PAYLOAD() || !t->PAYLOAD()->BYTES()) return;
            int w = 0, h = 0, comp = 0;
            uint8_t* px = stbi_load_from_memory(t->PAYLOAD()->BYTES()->data(), static_cast<int>(t->PAYLOAD()->BYTES()->size()), &w, &h, &comp, bands);
            if (!px) return;
            if (w == bit::kTile && h == bit::kTile) {
                const size_t x0 = static_cast<size_t>(t->X()) * bit::kTile, y0 = static_cast<size_t>(cn - 1 - (t->Y() - c0)) * bit::kTile;
                for (int r = 0; r < bit::kTile; r++) std::memcpy(&img[((y0 + r) * cw + x0) * bands], px + static_cast<size_t>(r) * bit::kTile * bands, static_cast<size_t>(bit::kTile) * bands);
                seen[slot] = 1;
                have++;
            }
            stbi_image_free(px);
        });
    }
    if (have != seen.size()) {
        char message[200];
        std::snprintf(message, sizeof(message), "the reduction found %zu of the %zu level-%d tiles it needs.", have, seen.size(), child);
        plugin_set_error("children-incomplete", message);
        return 502;
    }
    const Config config = load_config();
    const jpeg::Encoder enc(static_cast<int>(config.num("jpeg_quality", 88)));
    std::vector<TileOut> tiles;
    size_t w = cw, h = ch;
    std::vector<uint8_t> cur = bands == 3 ? bit::halve_rgb(img, w, h) : bit::halve(img, w, h);
    w /= 2;
    h /= 2;
    if (!root) {
        cut_tiles(enc, cur, w, h, static_cast<uint32_t>(level), row, &tiles, bands);
    } else {
        for (int l = level; l >= 0; l--) {
            cut_tiles(enc, cur, w, h, static_cast<uint32_t>(l), 0, &tiles, bands);
            if (l > 0) {
                cur = bands == 3 ? bit::halve_rgb(cur, w, h) : bit::halve(cur, w, h);
                w /= 2;
                h /= 2;
            }
        }
    }
    return emit_files(src, tiles, config.str("retrieved_at", src.epoch));
}

}  // extern "C"
