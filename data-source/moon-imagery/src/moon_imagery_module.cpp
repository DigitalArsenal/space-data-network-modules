/*
 * THE MOON'S IMAGERY: the USGS Astrogeology LRO LROC WAC global mosaic
 * (Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif, 100 m/px, public
 * domain), cut in WASM into the 256 px JPEG tiles the console draws, one unit
 * of the walk per tick (owner 2026-10-19: "Data Sources: Built from NASA's LRO
 * LROC (imagery) and LOLA (topography) datasets ok let's do it").
 *
 * THE SOURCE. A BigTIFF, 109164 x 54582 8-bit samples, uncompressed, one row
 * per strip, the strips contiguous from byte 874303 (row r at 874303 + 109164 r),
 * simple cylindrical on the 1737.4 km sphere from 180 W, 90 N (the GeoTIFF tie
 * point -5458203.08 m, 2729101.54 m; 100 m pixels). The geometry and the ETag
 * are pinned below: every range carries If-Match, so a reprocessed mosaic stops
 * the run instead of mixing editions.
 *
 * THE TILES. The Moon's two-root geographic scheme (GEOGRAPHIC_TWO_ROOT_BODY):
 * level L has 2^(L+1) x 2^L tiles of 256 px, rows counted from the SOUTH (as
 * the terrain lane's). One $DTT record per tile: PAYLOAD_FORMAT CUSTOM,
 * PAYLOAD.MEDIA_TYPE image/jpeg, the JPEG inline in PAYLOAD.BYTES, MAX_LEVEL the
 * deepest level of the set.
 *
 * THE FILES (FILE_NAME, one $PNM each, fetched by CID):
 *   imagery/301/root.dtts            levels 0-2 (42 tiles)
 *   imagery/301/<L>/<X16>_<Y>.dtts   16 tiles of one level-L row, X16 = x >> 4
 * each a size-prefixed $DTT stream ([u32 LE length][record]) ordered by x.
 *
 * THE WALK (481 units, the unit index is the mark's NEXT_CHUNK_INDEX):
 *   0-31     the 32 level-5 rows, read from the mosaic (186 MB of rows each)
 *   32       the coarse unit: levels 0-4 from the 2048 stored level-5 tiles,
 *            decoded and averaged 2 x 2 (so the whole Moon draws after 33 units)
 *   33-96    level 6, 97-224 level 7, 225-480 level 8, row by row from the
 *            mosaic (93, 47 and 23 MB of rows).
 * A direct unit area-averages: each output row is the coverage-weighted mean of
 * the source rows its latitude span covers, then each output pixel the
 * coverage-weighted mean of that row across its longitude span (level 8, finer
 * than the source, falls back to linear interpolation between pixel centers).
 * The level-5 tiles are also stored as $DTT records (source tags
 * <provider>/<tiles_source_name>) so the coarse unit can read them back.
 */
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <space_data_module_invoke.h>  // staged by the SDK compiler
#include <typedHostcall.hpp>  // staged by the SDK compiler
#include <TimerTick_generated.h>  // staged by the SDK compiler
#include <HttpRequest_generated.h>  // staged by the SDK compiler
#include <HttpResponse_generated.h>  // staged by the SDK compiler
#include <IngestRequest_generated.h>  // staged by the SDK compiler
#include <ModuleConfig_generated.h>  // staged by the SDK compiler

namespace {

namespace R = sdn::runtime;
using Bytes = std::vector<uint8_t>;

// ── the source, pinned ─────────────────────────────────────────────────────
constexpr const char* kSourceUrl =
    "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif";
constexpr const char* kSourceEtag = "\"47d026c2618ee60e92eda4f2e0e5347b-711\"";
constexpr const char* kSourceEpoch = "2013-06-01T00:00:00.000Z";
constexpr uint64_t kWidth = 109164, kHeight = 54582, kFirstRow = 874303;
constexpr double kSourcePixelM = 100.0, kRadiusM = 1737400.0;

// ── the pyramid and the walk ───────────────────────────────────────────────
constexpr int kTile = 256;
constexpr int kMaxLevel = 8, kFirstDirect = 5, kRootMaxLevel = 2, kRowFile = 16;
constexpr uint64_t kPartBytes = 48ull * 1024 * 1024;  // under the host's 100 MB body ceiling
constexpr int kMaxParts = 4;
constexpr const char* kPrefix = "imagery/301";
constexpr const char* kDataset = "usgs-lroc-wac";
constexpr const char* kIngestorId = "moon-imagery-wasm/v1";
constexpr const char* kLicense = "Public domain (NASA LRO LROC, USGS Astrogeology)";
constexpr const char* kLicenseUrl = "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits";
constexpr const char* kAttribution = "LROC WAC: NASA/GSFC/Arizona State University; mosaic: USGS Astrogeology";
constexpr double kPi = 3.14159265358979323846;

struct Unit {
    int level = 0;
    uint32_t row = 0;  // from the south
    bool coarse = false;
};
// The units in walk order; false past the end.
bool unit_at(long long index, Unit* u) {
    if (index < 0) return false;
    long long at = 0;
    const auto rows = [](int level) { return 1LL << level; };
    if (index < rows(5)) { *u = {5, static_cast<uint32_t>(index), false}; return true; }
    at = rows(5);
    if (index == at) { *u = {4, 0, true}; return true; }
    at += 1;
    for (int level = 6; level <= kMaxLevel; level++) {
        if (index < at + rows(level)) { *u = {level, static_cast<uint32_t>(index - at), false}; return true; }
        at += rows(level);
    }
    return false;
}
long long walk_length() {
    long long n = 1;
    for (int level = kFirstDirect; level <= kMaxLevel; level++) n += 1LL << level;
    return n;
}

// The source rows a level's tile row needs: [first, first + count).
void unit_rows(const Unit& u, uint64_t* first, uint64_t* count) {
    const double span = 180.0 / static_cast<double>(1u << u.level);
    const double north = -90.0 + (u.row + 1) * span, south = -90.0 + u.row * span;
    const double rows_per_deg = static_cast<double>(kHeight) / 180.0;
    // One row of margin each side for the linear fallback of the finest level.
    long long a = static_cast<long long>(std::floor((90.0 - north) * rows_per_deg)) - 1;
    long long b = static_cast<long long>(std::ceil((90.0 - south) * rows_per_deg)) + 1;
    a = std::max<long long>(a, 0);
    b = std::min<long long>(b, static_cast<long long>(kHeight));
    *first = static_cast<uint64_t>(a);
    *count = static_cast<uint64_t>(b - a);
}

// ── small helpers ──────────────────────────────────────────────────────────
Bytes finished(const flatbuffers::FlatBufferBuilder& b) { return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize()); }
int push_typed(const char* port, const char* schema, const char* id, const char* root, const Bytes& bytes) {
    return plugin_push_output_ex(port, schema, id, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, bytes.data(),
                                 static_cast<uint32_t>(bytes.size()));
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

// The node config (plugin.getConfig, one ModuleConfig): the few scalars this module reads, by key.
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
// A ModuleConfig frame on `port`, as a Config; false when absent or not one.
bool read_mcfg(const char* port, Config* c) {
    const plugin_input_frame_t* f = frame_for(port);
    if (!f || !f->payload || f->payload_length < 8) return false;
    flatbuffers::Verifier verifier(f->payload, f->payload_length);
    if (!R::VerifyModuleConfigBuffer(verifier)) return false;
    read_entries(R::GetModuleConfig(f->payload)->ENTRIES(), c);
    return true;
}

int64_t tick_ms() {
    const plugin_input_frame_t* f = frame_for("tick");
    if (!f || !f->payload || f->payload_length < 8) return -1;
    flatbuffers::Verifier verifier(f->payload, f->payload_length);
    if (!R::VerifyTimerTickBuffer(verifier)) return -1;
    const R::TimerTick* tick = R::GetTimerTick(f->payload);
    return static_cast<int64_t>(tick->FIRED_MS() ? tick->FIRED_MS() : tick->SCHEDULED_MS());
}

// $FSB chunks on `port` (CHUNK_SEQUENCE 0..n-1), joined in order; false on a non-$FSB frame or a hole.
bool fsb_stream(const char* port, Bytes* out) {
    std::vector<std::pair<uint32_t, const FSB*>> chunks;
    for (uint32_t ordinal = 0;; ordinal++) {
        const int32_t idx = plugin_find_input_index(port, ordinal);
        if (idx < 0) break;
        const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
        if (!f || !f->payload || f->payload_length < 8) return false;
        flatbuffers::Verifier verifier(f->payload, f->payload_length);
        if (!VerifyFSBBuffer(verifier)) return false;
        const FSB* chunk = GetFSB(f->payload);
        chunks.push_back({chunk->CHUNK_SEQUENCE(), chunk});
    }
    std::sort(chunks.begin(), chunks.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    for (size_t i = 0; i < chunks.size(); i++) {
        if (chunks[i].first != i) return false;
        if (const auto* d = chunks[i].second->DATA()) out->insert(out->end(), d->begin(), d->end());
    }
    return true;
}

// Each record of a size-prefixed stream (zero-length prefixes are alignment padding).
template <typename F>
void each_record(const Bytes& stream, F f) {
    for (size_t at = 0; at + 4 <= stream.size();) {
        const uint32_t size = get_u32(stream.data() + at);
        at += 4;
        if (size == 0) continue;
        if (size > stream.size() - at) return;
        f(stream.data() + at, size);
        at += size;
    }
}

// ── the job ($IRM, the mark-to-be), in the shape terrain-ingest's announce_files and publish_request read ──
struct Job {
    std::string job_id, provider, updated_at;
    long long index = 0, next_index = 0, records_committed = 0;
};
std::string job_id(const Config& c) {
    return std::string(kDataset) + "@" + c.str("tileset_id", "lroc-wac-moon") + "@" + c.str("dataset_epoch", kSourceEpoch);
}
Bytes build_irm(const Job& j) {
    flatbuffers::FlatBufferBuilder b(1024);
    const auto job_off = b.CreateString(j.job_id), provider_off = b.CreateString(j.provider),
               ingestor_off = b.CreateString(kIngestorId), updated_off = b.CreateString(j.updated_at),
               target_off = b.CreateString("DTT"), reconcile_off = b.CreateString("none"),
               url_off = b.CreateString(kSourceUrl), version_off = b.CreateString(kSourceEpoch), etag_off = b.CreateString(kSourceEtag);
    IRMSourceBuilder sb(b);
    sb.add_SOURCE_URL(url_off);
    sb.add_SOURCE_VERSION(version_off);
    sb.add_ENTITY_TAG(etag_off);
    const auto source_off = sb.Finish();
    IRMChunkBuilder cb(b);
    cb.add_CHUNK_INDEX(static_cast<uint32_t>(j.index));
    const auto chunk_off = cb.Finish();
    std::vector<flatbuffers::Offset<flatbuffers::String>> tags{b.CreateString("lane:imagery"), b.CreateString("walk:lroc-wac")};
    const auto tags_off = b.CreateVector(tags);
    IRMBuilder ib(b);
    ib.add_JOB_ID(job_off);
    ib.add_SEQUENCE(static_cast<uint64_t>(j.index));
    ib.add_PROVIDER_ID(provider_off);
    ib.add_INGESTOR_ID(ingestor_off);
    ib.add_SOURCE(source_off);
    ib.add_STATE(irmJobState::IN_PROGRESS);
    ib.add_RANGE_MODE(irmRangeMode::PART_INDEX);
    ib.add_NEXT_CHUNK_INDEX(static_cast<uint32_t>(j.next_index));
    ib.add_LAST_CHUNK(chunk_off);
    ib.add_CHUNKS_COMMITTED(static_cast<uint32_t>(j.index));
    ib.add_RECORDS_COMMITTED(static_cast<uint64_t>(j.records_committed));
    ib.add_TARGET_STANDARD(target_off);
    ib.add_RECONCILE_MODE(reconcile_off);
    ib.add_UPDATED_AT(updated_off);
    ib.add_TAGS(tags_off);
    FinishIRMBuffer(b, ib.Finish());
    return finished(b);
}
bool read_job(Job* j) {
    const plugin_input_frame_t* f = frame_for("job");
    if (!f || !f->payload || f->payload_length < 8) return false;
    flatbuffers::Verifier verifier(f->payload, f->payload_length);
    if (!IRMBufferHasIdentifier(f->payload) || !VerifyIRMBuffer(verifier)) return false;
    const IRM* irm = GetIRM(f->payload);
    j->job_id = text_of(irm->JOB_ID());
    j->provider = text_of(irm->PROVIDER_ID());
    j->updated_at = text_of(irm->UPDATED_AT());
    j->index = irm->LAST_CHUNK() ? static_cast<long long>(irm->LAST_CHUNK()->CHUNK_INDEX()) : 0;
    j->next_index = static_cast<long long>(irm->NEXT_CHUNK_INDEX());
    return true;
}

// ── tiles ──────────────────────────────────────────────────────────────────
struct TileOut {
    uint32_t level, x, y;  // y from the south
    Bytes jpeg;
};
Bytes dtt_record(const TileOut& t, const std::string& tileset, const std::string& retrieved_at) {
    const double span = 180.0 / static_cast<double>(1u << t.level);
    flatbuffers::FlatBufferBuilder b(t.jpeg.size() + 1024);
    const auto bytes = b.CreateVector(t.jpeg);
    const auto media = b.CreateString("image/jpeg");
    DTTPayloadRefBuilder pb(b);
    pb.add_BYTES(bytes);
    pb.add_SIZE_BYTES(t.jpeg.size());
    pb.add_MEDIA_TYPE(media);
    const auto payload = pb.Finish();
    const auto dataset = b.CreateString(kDataset), name = b.CreateString("LRO LROC WAC global mosaic 100 m (June 2013)"),
               epoch = b.CreateString(kSourceEpoch), url = b.CreateString(kSourceUrl), when = b.CreateString(retrieved_at),
               license = b.CreateString(kLicense), license_url = b.CreateString(kLicenseUrl),
               attribution = b.CreateString(kAttribution), processor = b.CreateString(kIngestorId);
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
    const auto tileset_off = b.CreateString(tileset), version = b.CreateString("jpeg-baseline-gray-v1"),
               center = b.CreateString("MOON"), datum = b.CreateString("MOON_ME (IAU 2015 lunar sphere 1737.4 km)");
    const auto radii = b.CreateVector(std::vector<double>{kRadiusM, kRadiusM, kRadiusM});
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
    d.add_GRID_WIDTH(kTile);
    d.add_GRID_HEIGHT(kTile);
    d.add_POST_SPACING_M(span * kPi / 180.0 * kRadiusM / kTile);
    d.add_SOURCE_POST_SPACING_M(kSourcePixelM);
    d.add_HORIZONTAL_DATUM_NAME(datum);
    d.add_MAX_LEVEL(kMaxLevel);
    d.add_PROVENANCE(provenance);
    d.add_CENTER_NAME(center);
    d.add_REFERENCE_RADII_M(radii);
    FinishDTTBuffer(b, d.Finish());
    return finished(b);
}

std::string file_name(uint32_t level, uint32_t x, uint32_t y) {
    if (level <= kRootMaxLevel) return std::string(kPrefix) + "/root.dtts";
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%s/%u/%u_%u.dtts", kPrefix, level, x / kRowFile, y);
    return buf;
}

// The unit's files ("file" frames in order, one "names" $PNM stream) from its tiles (any order).
int emit_files(std::vector<TileOut>& tiles, const std::string& tileset, const std::string& retrieved_at) {
    std::sort(tiles.begin(), tiles.end(), [](const TileOut& a, const TileOut& b) {
        return a.level != b.level ? a.level < b.level : a.y != b.y ? a.y < b.y : a.x < b.x;
    });
    std::vector<std::pair<std::string, Bytes>> files;
    for (const TileOut& t : tiles) {
        const std::string name = file_name(t.level, t.x, t.y);
        auto it = std::find_if(files.begin(), files.end(), [&](const auto& f) { return f.first == name; });
        if (it == files.end()) {
            files.push_back({name, {}});
            it = files.end() - 1;
        }
        const Bytes record = dtt_record(t, tileset, retrieved_at);
        put_u32(&it->second, static_cast<uint32_t>(record.size()));
        it->second.insert(it->second.end(), record.begin(), record.end());
    }
    if (files.size() > 64) {
        plugin_set_error("too-many-files", "a unit made more than the 64 files one publish_files call takes.");
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
Bytes tile_jpeg(const jpeg::Encoder& enc, const uint8_t* img, size_t w, size_t x0, size_t y0) {
    std::vector<uint8_t> px(static_cast<size_t>(kTile) * kTile);
    for (int r = 0; r < kTile; r++) std::memcpy(&px[static_cast<size_t>(r) * kTile], img + (y0 + r) * w + x0, kTile);
    return enc.encode(px.data(), kTile, kTile, 1);
}

// ── area averaging along one axis ──────────────────────────────────────────
// out[i] covers source coordinates [i * s, (i + 1) * s) + offset (s = source pixels per output pixel): the
// coverage-weighted mean when s >= 1, else linear interpolation at the output pixel's center.
struct Span {
    long long first;
    std::vector<float> weights;
};
Span span_of(double a, double b, long long limit) {
    Span s;
    if (b - a >= 1.0) {
        const long long i0 = std::max<long long>(0, static_cast<long long>(std::floor(a)));
        const long long i1 = std::min<long long>(limit, static_cast<long long>(std::ceil(b)));
        s.first = i0;
        double total = 0;
        for (long long i = i0; i < i1; i++) {
            const double w = std::min<double>(b, i + 1) - std::max<double>(a, i);
            s.weights.push_back(static_cast<float>(std::max(0.0, w)));
            total += std::max(0.0, w);
        }
        for (float& w : s.weights) w = static_cast<float>(w / (total > 0 ? total : 1));
    } else {
        const double c = (a + b) / 2 - 0.5;
        long long i0 = static_cast<long long>(std::floor(c));
        const double f = c - i0;
        i0 = std::max<long long>(0, std::min<long long>(i0, limit - 2));
        s.first = i0;
        s.weights = {static_cast<float>(1 - f), static_cast<float>(f)};
    }
    return s;
}

}  // namespace

extern "C" {

// wac_plan: tick (+ the stored mark) -> one unit's requests, the unit and the job.
int wac_plan(void) {
    const Config config = load_config();
    const int64_t now = tick_ms();
    if (now < 0) {
        plugin_set_error("invalid-tick-frame", "the tick frame is not a TimerTick (TICK).");
        return 400;
    }
    const std::string id = job_id(config);
    long long next = 0;
    Bytes mark;
    if (!fsb_stream("mark", &mark)) {
        plugin_set_error("invalid-mark-frame", "the mark frames are not a complete $FSB chunk sequence.");
        return 400;
    }
    bool found = false;
    each_record(mark, [&](const uint8_t* root, uint32_t size) {
        if (found || size < 8 || !IRMBufferHasIdentifier(root)) return;
        flatbuffers::Verifier verifier(root, size);
        if (!VerifyIRMBuffer(verifier)) return;
        const IRM* irm = GetIRM(root);
        if (text_of(irm->JOB_ID()) != id) return;
        found = true;
        if (irm->STATE() == irmJobState::ABANDONED || irm->STATE() == irmJobState::INVALIDATED) return;
        next = static_cast<long long>(irm->NEXT_CHUNK_INDEX());
    });
    Unit u;
    if (!unit_at(next, &u)) {
        plugin_set_backlog_remaining(0);
        return 0;  // the walk is drained: a clean no-op
    }
    plugin_set_backlog_remaining(static_cast<uint32_t>(walk_length() - next));
    const std::string tileset = config.str("tileset_id", "lroc-wac-moon");
    const long timeout_ms = static_cast<long>(config.num("timeout_ms", 240000));

    uint64_t first = 0, count = 0;
    if (u.coarse) {
        // The stored level-5 tiles, newest first (a rebuilt tile's newer record wins).
        const std::string sql = "SELECT _data FROM DTT WHERE TILESET_ID = ? AND LEVEL = ? ORDER BY _rowid DESC LIMIT ?";
        Bytes params;
        params.push_back(4);
        put_u32(&params, static_cast<uint32_t>(tileset.size()));
        params.insert(params.end(), tileset.begin(), tileset.end());
        for (const int64_t v : {static_cast<int64_t>(kFirstDirect), static_cast<int64_t>(8192)}) {
            params.push_back(2);
            put_u32(&params, 8);
            for (int i = 0; i < 8; i++) params.push_back(static_cast<uint8_t>((static_cast<uint64_t>(v) >> (8 * i)) & 0xff));
        }
        flatbuffers::FlatBufferBuilder b(512 + sql.size() + params.size());
        const auto query = b.CreateVector(reinterpret_cast<const uint8_t*>(sql.data()), sql.size());
        const auto parameters = b.CreateVector(params);
        FSOBuilder fso(b);
        fso.add_OPERATION(flatSqlNodeOperation::QUERY_RECORDS);
        fso.add_QUERY(query);
        fso.add_PARAMETERS(parameters);
        fso.add_PARAMETER_COUNT(3);
        FinishFSOBuffer(b, fso.Finish());
        if (push_typed("children", "FSO.fbs", FSOIdentifier(), "FSO", finished(b)) < 0) return 500;
    } else {
        unit_rows(u, &first, &count);
        const uint64_t rows_per_part = kPartBytes / kWidth;
        const uint64_t parts = (count + rows_per_part - 1) / rows_per_part;
        if (parts > static_cast<uint64_t>(kMaxParts)) {
            plugin_set_error("too-many-parts", "a unit's rows need more than the flow's 4 range requests.");
            return 500;
        }
        for (uint64_t p = 0; p < parts; p++) {
            const uint64_t a = first + p * rows_per_part, n = std::min(rows_per_part, first + count - a);
            const std::string range = "bytes=" + std::to_string(kFirstRow + a * kWidth) + "-" +
                                      std::to_string(kFirstRow + (a + n) * kWidth - 1);
            flatbuffers::FlatBufferBuilder b(512);
            std::vector<flatbuffers::Offset<R::Header>> headers{R::CreateHeaderDirect(b, "range", range.c_str()),
                                                               R::CreateHeaderDirect(b, "if-match", kSourceEtag)};
            R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "GET", kSourceUrl, &headers, nullptr,
                                                                     static_cast<uint32_t>(timeout_ms), 0, nullptr));
            char port[16];
            std::snprintf(port, sizeof(port), "rows_%u", static_cast<unsigned>(p));
            if (push_typed(port, "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", finished(b)) < 0) return 500;
        }
    }

    // The unit, for wac_tile.
    {
        R::ModuleConfigT options;
        const auto number = [](const char* key, double v) {
            auto e = std::make_unique<R::ConfigEntryT>();
            e->KEY = key;
            e->KIND = R::configValueKind_Number;
            e->NUMBER_VALUE = v;
            return e;
        };
        options.ENTRIES.push_back(number("level", u.level));
        options.ENTRIES.push_back(number("row", u.row));
        options.ENTRIES.push_back(number("first_row", static_cast<double>(first)));
        options.ENTRIES.push_back(number("row_count", static_cast<double>(count)));
        options.ENTRIES.push_back(number("coarse", u.coarse ? 1 : 0));
        flatbuffers::FlatBufferBuilder b(256);
        R::FinishModuleConfigBuffer(b, R::ModuleConfig::Pack(b, &options));
        if (push_typed("unit", "ModuleConfig.fbs", R::ModuleConfigIdentifier(), "ModuleConfig", finished(b)) < 0) return 500;
    }
    Job job;
    job.job_id = id;
    job.provider = config.str("provider_id", "usgs-astrogeology");
    job.updated_at = iso_ms(now);
    job.index = next;
    job.next_index = next + 1;
    return push_typed("job", "IRM.fbs", "$IRM", "IRM", build_irm(job)) < 0 ? 500 : 0;
}

// wac_tile: the unit, its job and its rows (or the stored level-5 tiles) -> its files and names, and for level 5
// the tiles as records to store.
int wac_tile(void) {
    Config unit_cfg;
    if (!read_mcfg("unit", &unit_cfg)) {
        plugin_set_error("missing-unit-frame", "wac_tile requires the unit frame (ModuleConfig).");
        return 400;
    }
    Job job;
    if (!read_job(&job)) {
        plugin_set_error("missing-job-frame", "wac_tile requires the job frame ($IRM).");
        return 400;
    }
    const Config config = load_config();
    const std::string tileset = config.str("tileset_id", "lroc-wac-moon");
    const jpeg::Encoder enc(static_cast<int>(config.num("jpeg_quality", 82)));
    const int level = static_cast<int>(unit_cfg.num("level", -1));
    const bool coarse = unit_cfg.num("coarse", 0) != 0;
    std::vector<TileOut> tiles;

    if (coarse) {
        // Levels 0-4 from the stored level-5 tiles: a 16384 x 8192 mosaic, halved level by level.
        Bytes stream;
        if (!fsb_stream("children", &stream)) {
            plugin_set_error("invalid-children-frame", "the children frames are not a complete $FSB chunk sequence.");
            return 400;
        }
        const size_t w5 = static_cast<size_t>(kTile) << 6, h5 = static_cast<size_t>(kTile) << 5;
        std::vector<uint8_t> img(w5 * h5, 0);
        std::vector<uint8_t> seen(64 * 32, 0);
        size_t have = 0;
        each_record(stream, [&](const uint8_t* root, uint32_t size) {
            if (size < 8 || !DTTBufferHasIdentifier(root)) return;
            flatbuffers::Verifier verifier(root, size);
            if (!VerifyDTTBuffer(verifier)) return;
            const DTT* t = GetDTT(root);
            if (t->LEVEL() != static_cast<uint32_t>(kFirstDirect) || t->X() >= 64 || t->Y() >= 32) return;
            const size_t slot = t->Y() * 64 + t->X();
            if (seen[slot] || !t->PAYLOAD() || !t->PAYLOAD()->BYTES()) return;
            int w = 0, h = 0, comp = 0;
            uint8_t* px = stbi_load_from_memory(t->PAYLOAD()->BYTES()->data(), static_cast<int>(t->PAYLOAD()->BYTES()->size()),
                                                &w, &h, &comp, 1);
            if (!px) return;
            if (w == kTile && h == kTile) {
                const size_t x0 = t->X() * kTile, y0 = (31 - t->Y()) * kTile;
                for (int r = 0; r < kTile; r++) std::memcpy(&img[(y0 + r) * w5 + x0], px + static_cast<size_t>(r) * kTile, kTile);
                seen[slot] = 1;
                have++;
            }
            stbi_image_free(px);
        });
        if (have != seen.size()) {
            char message[200];
            std::snprintf(message, sizeof(message),
                          "the coarse unit found %zu of the 2048 level-5 tiles in the store; it runs again on the next tick.", have);
            plugin_set_error("level-5-incomplete", message);
            return 502;
        }
        size_t w = w5, h = h5;
        for (int l = kFirstDirect - 1; l >= 0; l--) {
            const size_t nw = w / 2, nh = h / 2;
            std::vector<uint8_t> next(nw * nh);
            for (size_t r = 0; r < nh; r++)
                for (size_t c = 0; c < nw; c++) {
                    const size_t a = (2 * r) * w + 2 * c;
                    next[r * nw + c] = static_cast<uint8_t>((img[a] + img[a + 1] + img[a + w] + img[a + w + 1] + 2) / 4);
                }
            img.swap(next);
            w = nw;
            h = nh;
            const uint32_t nx = 2u << l, ny = 1u << l;
            for (uint32_t y = 0; y < ny; y++)
                for (uint32_t x = 0; x < nx; x++)
                    tiles.push_back({static_cast<uint32_t>(l), x, y, tile_jpeg(enc, img.data(), w, x * kTile, (ny - 1 - y) * kTile)});
        }
        return emit_files(tiles, tileset, job.updated_at);
    }

    // A direct unit: one row of `level` from the mosaic's rows.
    if (level < kFirstDirect || level > kMaxLevel) {
        plugin_set_error("invalid-unit", "the unit names no level this walk reads from the mosaic.");
        return 400;
    }
    const uint64_t first = static_cast<uint64_t>(unit_cfg.num("first_row", 0));
    const uint64_t count = static_cast<uint64_t>(unit_cfg.num("row_count", 0));
    const uint32_t row = static_cast<uint32_t>(unit_cfg.num("row", 0));
    // The source rows, part by part, verified complete.
    std::vector<const uint8_t*> rows(count, nullptr);
    uint64_t at = 0;
    for (int p = 0; p < kMaxParts && at < count; p++) {
        char port[16];
        std::snprintf(port, sizeof(port), "rows_%d", p);
        const plugin_input_frame_t* f = frame_for(port);
        if (!f || !f->payload) break;
        flatbuffers::Verifier verifier(f->payload, f->payload_length);
        if (!R::VerifyHttpResponseBuffer(verifier)) {
            plugin_set_error("invalid-response-frame", "a rows frame is not an HttpResponse (HRSP).");
            return 400;
        }
        const R::HttpResponse* r = R::GetHttpResponse(f->payload);
        if (r->STATUS() != 206 || !r->BODY() || r->BODY()->size() % kWidth != 0) {
            char message[300];
            std::snprintf(message, sizeof(message), "the mosaic's rows did not arrive (part %d: HTTP %d, %zu bytes%s%s).", p,
                          static_cast<int>(r->STATUS()), r->BODY() ? static_cast<size_t>(r->BODY()->size()) : 0,
                          r->ERROR() ? ", " : "", r->ERROR() ? r->ERROR()->c_str() : "");
            plugin_set_error("rows-not-delivered", message);
            return 502;
        }
        const size_t n = r->BODY()->size() / kWidth;
        for (size_t k = 0; k < n && at < count; k++) rows[at++] = r->BODY()->data() + k * kWidth;
    }
    if (at != count) {
        plugin_set_error("rows-incomplete", "the unit's row parts do not cover its rows.");
        return 502;
    }
    const size_t out_w = static_cast<size_t>(kTile) << (level + 1);
    const double span = 180.0 / static_cast<double>(1u << level);
    const double north = -90.0 + (row + 1) * span;
    const double rows_per_deg = static_cast<double>(kHeight) / 180.0, cols_per_out = static_cast<double>(kWidth) / out_w;
    const double deg_per_out = span / kTile;
    std::vector<uint8_t> band(out_w * kTile);
    std::vector<float> acc(kWidth);
    std::vector<Span> cols(out_w);
    for (size_t c = 0; c < out_w; c++) cols[c] = span_of(c * cols_per_out, (c + 1) * cols_per_out, static_cast<long long>(kWidth));
    for (int r = 0; r < kTile; r++) {
        // The output row's latitude span, in source rows (from the north).
        const double a = (90.0 - (north - r * deg_per_out)) * rows_per_deg, b = (90.0 - (north - (r + 1) * deg_per_out)) * rows_per_deg;
        const Span vs = span_of(a, b, static_cast<long long>(kHeight));
        std::fill(acc.begin(), acc.end(), 0.0f);
        for (size_t k = 0; k < vs.weights.size(); k++) {
            const long long src = vs.first + static_cast<long long>(k);
            const long long local = src - static_cast<long long>(first);
            if (local < 0 || local >= static_cast<long long>(count)) continue;
            const uint8_t* line = rows[static_cast<size_t>(local)];
            const float wv = vs.weights[k];
            for (size_t i = 0; i < kWidth; i++) acc[i] += wv * line[i];
        }
        uint8_t* out = &band[static_cast<size_t>(r) * out_w];
        for (size_t c = 0; c < out_w; c++) {
            float v = 0;
            const Span& hs = cols[c];
            for (size_t k = 0; k < hs.weights.size(); k++) v += hs.weights[k] * acc[static_cast<size_t>(hs.first) + k];
            out[c] = static_cast<uint8_t>(std::min(255.0f, std::max(0.0f, v + 0.5f)));
        }
    }
    const uint32_t nx = 2u << level;
    for (uint32_t x = 0; x < nx; x++) tiles.push_back({static_cast<uint32_t>(level), x, row, tile_jpeg(enc, band.data(), out_w, x * kTile, 0)});

    if (level == kFirstDirect) {
        // Stored as records too, so the coarse unit can read them back.
        Bytes records;
        for (const TileOut& t : tiles) {
            const Bytes record = dtt_record(t, tileset, job.updated_at);
            put_u32(&records, static_cast<uint32_t>(record.size()));
            records.insert(records.end(), record.begin(), record.end());
        }
        R::IngestRequestT meta;
        meta.SCHEMA = "DTT";
        meta.TAGS = std::make_unique<R::SourceTagsT>();
        meta.TAGS->PROVIDER_ID = config.str("provider_id", "usgs-astrogeology");
        meta.TAGS->SOURCE_NAME = config.str("tiles_source_name", "moon-lroc-wac-tiles");
        meta.TAGS->BATCH_ID = tileset + "@" + config.str("dataset_epoch", kSourceEpoch) + "#" + std::to_string(job.index);
        meta.TAGS->SOURCE_URL = kSourceUrl;
        meta.TAGS->LICENSE = kLicense;
        meta.TAGS->CITATION = kAttribution;
        meta.RECONCILE = R::reconcileMode_None;
        meta.PROVENANCE = std::make_unique<R::ProvenanceT>();
        meta.PROVENANCE->SOURCE_URL = kSourceUrl;
        meta.PROVENANCE->PARSER = "moon-imagery";
        meta.PROVENANCE->PARSER_VERSION = kIngestorId;
        meta.PROVENANCE->NORMALIZED_COUNT = static_cast<uint32_t>(tiles.size());
        meta.PROVENANCE->SCHEMAS = {"DTT.fbs"};
        meta.PROVENANCE->SCHEMA_COUNTS = {static_cast<uint32_t>(tiles.size())};
        flatbuffers::FlatBufferBuilder mb(1024);
        R::FinishIngestRequestBuffer(mb, R::IngestRequest::Pack(mb, &meta));
        if (push_typed("meta", "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest", finished(mb)) < 0) return 500;
        if (push_typed("records", "DTT.fbs", "$DTT", "DTT", records) < 0) return 500;
    }
    return emit_files(tiles, tileset, job.updated_at);
}

}  // extern "C"
