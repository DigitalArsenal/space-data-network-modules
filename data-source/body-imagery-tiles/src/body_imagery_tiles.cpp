// HIGH-RESOLUTION BODY IMAGERY OVER SDN (com.digitalarsenal.data-source.body-imagery-tiles).
//
// retrieve_tiles, one cycle on a provider node, everything through host calls:
//  1. the source mosaic's header and georeference (source.hpp), checked against the table;
//  2. per band (16 rows of level-9 tiles, one level-5 tile row; config body_imagery_tiles_bands, default all 32),
//     per level-9 tile row: the source rows it covers as one whole-row byte range (If-Match on the file's ETag),
//     their strip offsets checked, resampled into the row (pyramid.hpp), cut into 256 px tiles (baseline JPEG,
//     quality body_imagery_tiles_quality, default 88), packed 16 a file and added to the node's IPFS; the row is
//     reduced into its parent, and every coarser row completed by it is cut, packed and added the same way;
//  3. each band's $PNM records (provider usgs-astrogeology, source mars-themis-day-ir) filed by
//     storage.ingest_with_source as one batch; the node's auto-publisher announces the lane.
// The whole body is one cycle (22.8 GB of source read once; level 0 completes with the last band). The source is
// fixed, so the cycle is yearly; an unchanged source makes the same files under the same CIDs.
#include <algorithm>
#include <chrono>
#include <cstring>
#include <ctime>
#include <string>
#include <vector>

namespace {
namespace R = sdn::runtime;

constexpr const char* kModule = "body-imagery-tiles";
constexpr const char* kVersion = "0.1.0";
constexpr const char* kProvider = "usgs-astrogeology";

int fail(const std::string& message) { plugin_set_error(kModule, message.c_str()); return 1; }

size_t frames_on(const char* port) {
    size_t n = 0;
    for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
        const auto* f = plugin_get_input_frame(i);
        if (f && f->port_id && std::strcmp(f->port_id, port) == 0) ++n;
    }
    return n;
}

int notice(const char* port, R::flowNoticeKind kind, const std::string& source, uint64_t count, const std::string& reason,
           std::vector<std::string> items = {}) {
    R::FlowNoticeT n;
    n.KIND = kind;
    n.SCHEMA = "PNM.fbs";
    n.PROVIDER_ID = kProvider;
    n.SOURCE_NAME = source;
    n.COUNT = count;
    n.REASON = reason;
    n.ITEMS = std::move(items);
    n.AT_MS = uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    flatbuffers::FlatBufferBuilder b(512);
    R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &n));
    return plugin_push_output_ex(port, "FlowNotice.fbs", R::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "FlowNotice", 0, 0, b.GetBufferPointer(), b.GetSize()) < 0 ? 1 : 0;
}

std::string iso_now() {
    const std::time_t t = std::time(nullptr);
    char buf[32];
    std::strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&t));
    return buf;
}

struct Settings {
    std::string peer, url, why;
    std::vector<uint32_t> bands;  // level-5 tile rows, ascending
    int quality = 88;
};

Settings settings(const bit::Source& src) {
    Settings s;
    const auto config = sdm_piv::get_config();
    if (!config.ok()) { s.why = "Host configuration unavailable: " + config.error_message(); return s; }
    if (!config.boolean("body_imagery_tiles_enabled")) return s;
    s.peer = std::string(config.string("body_imagery_tiles_producer_peer_id"));
    if (!bit::cid_token(s.peer)) { s.why = "body_imagery_tiles_producer_peer_id must name this node's peer ID."; s.peer.clear(); return s; }
    s.url = std::string(config.string("body_imagery_tiles_source_url", src.url));
    s.quality = int(config.number("body_imagery_tiles_quality", 88));
    const uint32_t band_count = uint32_t(1) << (src.max_level - 4);  // level-5 tile rows
    for (const double b : config.numbers("body_imagery_tiles_bands"))
        if (b >= 0 && b < band_count) s.bands.push_back(uint32_t(b));
    if (s.bands.empty()) for (uint32_t b = 0; b < band_count; ++b) s.bands.push_back(b);
    std::sort(s.bands.begin(), s.bands.end());
    s.bands.erase(std::unique(s.bands.begin(), s.bands.end()), s.bands.end());
    if (s.quality < 50 || s.quality > 98) s.why = "body_imagery_tiles_quality must lie in [50, 98].";
    return s;
}

// One ranged GET of the source: `want` bytes from `first`, or empty and `why`.
std::vector<uint8_t> get_range(const std::string& url, const bit::Source& src, uint64_t first, uint64_t want, std::string& why) {
    for (int attempt = 0; attempt < 4; ++attempt) {
        R::Aligned::HttpParams params{};
        sdm_piv::put(params.METHOD, "GET");
        params.set_has_METHOD(true);
        params.TIMEOUT_MS = 600000;
        params.MAX_BYTES = want + 1024;
        const std::string headers = "Range: bytes=" + std::to_string(first) + "-" + std::to_string(first + want - 1) +
                                    "\r\nIf-Match: " + src.etag + "\r\n";
        const std::vector<sdm_piv::Frame> frames{
            {"params", reinterpret_cast<const uint8_t*>(&params), sizeof(params), "HttpParams", uint32_t(sizeof(params)),
             uint16_t(alignof(R::Aligned::HttpParams))},
            sdm_piv::raw("url", url), sdm_piv::raw("headers", headers), sdm_piv::raw("body", std::string())};
        const auto response = sdm_piv::call_frames("http.request", frames);
        if (!response.ok()) { why = "http.request: " + response.error_message(); continue; }
        const auto* result = response.result<R::Aligned::HttpResult>();
        const auto body = response.raw("body");
        if (result && result->STATUS == 206 && body.size() == want) return std::vector<uint8_t>(body.begin(), body.end());
        why = url + " answered " + std::to_string(result ? result->STATUS : 0) + " with " + std::to_string(body.size()) +
              " B to bytes " + std::to_string(first) + "+" + std::to_string(want);
        if (result && (result->STATUS == 412 || result->STATUS == 404)) break;  // another edition, or gone: stop
    }
    return {};
}

uint64_t le64(const uint8_t* p) { uint64_t v = 0; for (int i = 7; i >= 0; i--) v = (v << 8) | p[i]; return v; }
uint32_t le16(const uint8_t* p) { return uint32_t(p[0]) | (uint32_t(p[1]) << 8); }
double led(const uint8_t* p) { const uint64_t v = le64(p); double d; std::memcpy(&d, &v, 8); return d; }

// The header states the table's file: a little-endian BigTIFF, the dimensions, 8-bit, one sample, uncompressed,
// one row per strip with the LONG8 offset array where the table puts it, and the georeference.
std::string check_header(const std::string& url, const bit::Source& src) {
    std::string why;
    const auto head = get_range(url, src, 0, 4096, why);
    if (head.empty()) return why;
    if (head[0] != 'I' || head[1] != 'I' || le16(&head[2]) != 43) return "the source is not a little-endian BigTIFF";
    const uint64_t ifd = le64(&head[8]);
    if (ifd + 8 > head.size()) return "the source's first directory lies past its first 4 KiB";
    const uint64_t n = le64(&head[ifd]);
    uint64_t width = 0, height = 0, bits = 0, compression = 0, samples = 0, rows_per_strip = 0, strips_at = 0, strips = 0;
    for (uint64_t k = 0; k < n && ifd + 8 + 20 * (k + 1) <= head.size(); k++) {
        const uint8_t* e = &head[ifd + 8 + 20 * k];
        const uint32_t tag = le16(e), type = le16(e + 2);
        const uint64_t count = le64(e + 4), value = type == 3 ? le16(e + 12) : le64(e + 12);
        if (tag == 256) width = value;
        if (tag == 257) height = value;
        if (tag == 258) bits = value;
        if (tag == 259) compression = value;
        if (tag == 277) samples = value;
        if (tag == 278) rows_per_strip = value;
        if (tag == 273 && type == 16) { strips_at = value; strips = count; }
    }
    if (width != src.width || height != src.height || bits != 8 || compression != 1 || samples != 1 ||
        rows_per_strip != 1 || strips_at != src.strip_array || strips != src.height)
        return "the source's header is not the table's file (dimensions, 8-bit, uncompressed, one row per strip, "
               "the strip-offset array)";
    const auto geo = get_range(url, src, src.georef_at, 72, why);
    if (geo.empty()) return why;
    if (led(&geo[0]) != src.pixel_m || led(&geo[8]) != src.pixel_m || led(&geo[24 + 24]) != src.x0_m ||
        led(&geo[24 + 32]) != src.y0_m)
        return "the source's georeference (ModelPixelScale, ModelTiepoint) is not the table's";
    return {};
}

struct Run {
    const bit::Source* src = nullptr;
    Settings s;
    jpeg::Encoder* encoder = nullptr;
    bit::Lane lane;
    std::string at;
    std::vector<uint8_t> records;  // this band's $PNM records
    uint64_t files = 0, tiles = 0, bytes = 0, max_pack = 0, source_bytes = 0, filed = 0;
    uint64_t band_files = 0;
    std::string why;
};

std::string pack_name(const bit::Source& src, int level, uint64_t y, uint64_t k) {
    return "imagery/" + std::to_string(src.naif) + "/" + src.key + "/" + std::to_string(level) + "/" + std::to_string(y) +
           "_" + std::to_string(k) + ".pack";
}

// One completed tile row: tiles, packs of 16, IPFS, $PNM.
bool emit_row(Run& run, int level, uint64_t y, const std::vector<uint8_t>& row) {
    const uint64_t W = bit::level_width(level), across = W / bit::kTile;
    std::vector<uint8_t> tile(size_t(bit::kTile) * bit::kTile);
    for (uint64_t k = 0; k * bit::kPackTiles < across; k++) {
        std::vector<bit::PackTile> tiles;
        for (uint64_t x = k * bit::kPackTiles; x < std::min<uint64_t>(across, (k + 1) * bit::kPackTiles); x++) {
            for (int r = 0; r < bit::kTile; r++)
                std::memcpy(&tile[size_t(r) * bit::kTile], &row[uint64_t(r) * W + x * bit::kTile], bit::kTile);
            tiles.push_back({uint16_t(x), run.encoder->encode(tile.data(), bit::kTile, bit::kTile, 1)});
        }
        const std::vector<uint8_t> file = bit::pack(level, uint16_t(y), run.src->max_level, tiles);
        const std::string cid = bit::ipfs_add(file, run.why);
        if (cid.empty()) return false;
        bit::append_pnm(run.records, run.lane.provider, run.lane.source, pack_name(*run.src, level, y, k), cid, run.at);
        run.files++;
        run.band_files++;
        run.tiles += tiles.size();
        run.bytes += file.size();
        run.max_pack = std::max<uint64_t>(run.max_pack, file.size());
    }
    return true;
}

}  // namespace

extern "C" int prepare_scheduled() {
    if (plugin_get_input_count() != 1 || frames_on("tick") != 1) return fail("Exactly one timer tick is required.");
    const Settings s = settings(bit::themis_day_ir());
    if (!s.why.empty()) return fail(s.why);
    if (s.peer.empty()) return notice("status", R::flowNoticeKind_Skipped, "", 0, "disabled");
    return notice("cycle", R::flowNoticeKind_Info, "", 0, "cycle", {s.peer});
}

// One cycle: every band asked for, its tiles made and filed.
extern "C" int retrieve_tiles() {
    if (frames_on("cycle") != 1) return fail("Exactly one cycle is required.");
    Run run;
    run.src = &bit::themis_day_ir();
    const bit::Source& src = *run.src;
    run.s = settings(src);
    if (!run.s.why.empty()) return fail(run.s.why);
    if (run.s.peer.empty()) return fail("The imagery lane was disabled during the cycle; nothing was filed.");
    const auto t0 = std::chrono::steady_clock::now();
    run.at = iso_now();
    run.lane = {kProvider, std::string("mars-") + src.key, "", run.s.url, src.license, src.license_url, src.citation,
                std::string(kModule) + " " + kVersion, run.s.peer};
    std::string why = check_header(run.s.url, src);
    if (!why.empty()) return fail(why);
    jpeg::Encoder encoder(run.s.quality);
    run.encoder = &encoder;
    const int deepest = src.max_level;
    const std::vector<bit::ColumnTap> taps = bit::column_taps(src, deepest);
    bit::Pyramid pyramid(deepest);
    pyramid.emit = [&run](int level, uint64_t y, const std::vector<uint8_t>& row) { return emit_row(run, level, y, row); };
    const uint64_t rows_per_band = uint64_t(1) << (deepest - 5);
    std::vector<uint8_t> row;
    for (const uint32_t band : run.s.bands) {
        run.records.clear();
        run.band_files = 0;
        for (uint64_t y = band * rows_per_band; y < (band + 1) * rows_per_band; y++) {
            uint64_t first = 0, last = 0;
            bit::source_rows_for(src, deepest, y, &first, &last);
            const uint64_t rows = last - first + 1;
            // Each row's strip offset, as the header's array states it, is where the table puts it.
            const auto offsets = get_range(run.s.url, src, src.strip_array + 8 * first, 8 * rows, why);
            if (offsets.empty()) return fail(why);
            for (uint64_t j = 0; j < rows; j++)
                if (le64(&offsets[8 * j]) != src.strip0 + (first + j) * src.width)
                    return fail("the source's strips are not contiguous rows at row " + std::to_string(first + j));
            const auto px = get_range(run.s.url, src, src.strip0 + first * src.width, rows * src.width, why);
            if (px.empty()) return fail(why);
            run.source_bytes += px.size();
            bit::resample_row(src, deepest, y, px.data(), first, rows, taps, &row);
            if (!pyramid.complete(deepest, y, row)) return fail(run.why);
        }
        run.lane.batch = std::string(src.key) + "@" + src.epoch + "#band" + std::to_string(band);
        uint64_t inserted = 0;
        if (!(why = bit::ingest(run.lane, run.records, inserted)).empty()) return fail(why);
        if (inserted != run.band_files)
            return fail("storage.ingest_with_source stored " + std::to_string(inserted) + " of the band's " +
                        std::to_string(run.band_files) + " files");
        run.filed += inserted;
    }
    const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    const auto item = [](const char* k, uint64_t v) { return std::string(k) + "=" + std::to_string(v); };
    return notice("report", R::flowNoticeKind_Info, run.lane.source, run.filed, "filed",
                  {item("bands", run.s.bands.size()), item("files", run.files), item("tiles", run.tiles),
                   item("bytes", run.bytes), item("largest_pack_bytes", run.max_pack),
                   item("source_bytes", run.source_bytes), item("seconds", uint64_t(secs))});
}
