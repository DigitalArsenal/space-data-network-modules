/*
 * data-source/imager-observation-parser (typed contracts 1.0).
 *
 * A pure parser flow node (capabilities: none) for geostationary imager observations: each fetched NetCDF4 file of a
 * GOES ABI L1b/L2 product (NOAA Open Data Dissemination, anonymous public buckets) becomes its field's world product -
 * the area mean of the native pixels in each cell of a 4096 x 2048 latitude/longitude grid (cells no pixel centre falls
 * into take the field sampled at the cell centre; cloud phase the pixel nearest the cell centre), at 4096, 2048 and
 * 1024 wide - as size-prefixed $WXF records, one per 64-row band, quantized at the instrument's precision and coded as
 * SDS 1.238 defines (InlineEncodedChunk: delta, zigzag, shuffle; InlineQuantizedUint16 / InlineQuantizedUint8). One
 * satellite's fields, unblended (owner 2026-10-07: SDN carries raw per-satellite fields; the display derives the rest).
 *
 * The world product, quantization and codecs are the reference producer's (DigitalArsenal/Cesium_Weather
 * orbpro-gaussian-clouds/tools/raw_satellite.py), ported formula for formula: on full-disk GOES-18 and GOES-19 files of
 * every field the ported code and the reference agree in every float and every code (native/imagerworld/
 * compare_reference.py there); tests/ hold the reference's output for real mesoscale files.
 *
 * The file is read by hdf5mini (vendored; superblocks 0-3, dense and compact groups and attributes, chunked layouts,
 * deflate via the vendored miniz, shuffle), the values as netCDF4's mask-and-scale gives them, chunk by chunk.
 *
 * Method:
 *   parse : responses (HttpResponse, HRSP) -> wxf_meta (IngestRequest, INGQ) + wxf_records ($WXF stream)
 *       Each response echoes, in CONTEXT, the file job imager-observation-source:select_files put on its request: one
 *       size-prefixed $WXF header record - FIELD_ID the field, VARIABLE_NAME the NetCDF variable, SENSOR_ID, DATASET_ID
 *       the bucket, SOURCE_URL the object's https URL (the key follows the host), ORIGIN_ID, LICENSE_URL, CITATION,
 *       VALID_TIME_MS the frame hour, TILE_INDEX / TILE_COUNT the byte-range part / parts. A file fetched as byte ranges
 *       arrives as consecutive parts 0 .. n-1 and is joined before it is read. All files of the invocation make one
 *       ingest batch: one IngestRequest and one record stream.
 *   The widths are node config (imager_widths, default "4096,2048,1024"), read through plugin.getConfig (SDS $PIV,
 *   the builtin; no capability). The lane's attribution the $WXF job has no field for is this family's constant: the
 *   provider noaa-goes, the source <bucket>-world, the licence LicenseRef-NOAA-Open-Data.
 *
 * No JSON and no base64: the meta is an IngestRequest (SCHEMA, TAGS, RECONCILE Duplicates, PROVENANCE), the batch id
 * the SHA-256 of the fetched file bytes as before.
 */
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <string>
#include <string_view>
#include <vector>

#include <sys/time.h>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

constexpr const char* kContentKeyID = "public";
constexpr const char* kParser = "imager-observation-parser";
constexpr const char* kParserVersion = "imager-observation-parser/v1";
constexpr const char* kProviderID = "noaa-goes";
constexpr const char* kLicenseID = "LicenseRef-NOAA-Open-Data";

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_ws(s[b])) b++;
    while (e > b && is_ws(s[e - 1])) e--;
    return s.substr(b, e - b);
}

// ---------------------------------------------------------------------------
// SHA-256 (batch ids = sha256 of the fetched payload(s)).
// ---------------------------------------------------------------------------

struct Sha256 {
    uint32_t h[8];
    uint64_t total = 0;
    uint8_t buf[64];
    size_t buf_len = 0;

    Sha256() {
        static const uint32_t init[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                         0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
        std::memcpy(h, init, sizeof(init));
    }

    static uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }

    void block(const uint8_t* p) {
        static const uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
            0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
            0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
            0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
            0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
            0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
            0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; i++) {
            w[i] = (static_cast<uint32_t>(p[i * 4]) << 24) |
                   (static_cast<uint32_t>(p[i * 4 + 1]) << 16) |
                   (static_cast<uint32_t>(p[i * 4 + 2]) << 8) | p[i * 4 + 3];
        }
        for (int i = 16; i < 64; i++) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
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
        total += len;
        while (len > 0) {
            const size_t take = std::min(len, sizeof(buf) - buf_len);
            std::memcpy(buf + buf_len, data, take);
            buf_len += take;
            data += take;
            len -= take;
            if (buf_len == 64) {
                block(buf);
                buf_len = 0;
            }
        }
    }

    std::string hex_digest() {
        const uint64_t bit_len = total * 8;
        uint8_t pad = 0x80;
        update(&pad, 1);
        const uint8_t zero = 0;
        while (buf_len != 56) update(&zero, 1);
        uint8_t len_be[8];
        for (int i = 0; i < 8; i++) len_be[i] = static_cast<uint8_t>(bit_len >> (56 - i * 8));
        update(len_be, 8);
        static const char* hexd = "0123456789abcdef";
        std::string out;
        out.reserve(64);
        for (int i = 0; i < 8; i++) {
            for (int b = 24; b >= 0; b -= 8) {
                const uint8_t byte = static_cast<uint8_t>(h[i] >> b);
                out.push_back(hexd[byte >> 4]);
                out.push_back(hexd[byte & 0xf]);
            }
        }
        return out;
    }
};

// sha256 over (schemaName, 0x00, record bytes, 0x00) per record, in order.
void normalized_hash_record(Sha256* h, const char* schema, const std::vector<uint8_t>& record) {
    h->update(reinterpret_cast<const uint8_t*>(schema), std::strlen(schema));
    const uint8_t z = 0;
    h->update(&z, 1);
    h->update(record.data(), record.size());
    h->update(&z, 1);
}


// ---------------------------------------------------------------------------
// Civil time — UTC only. Epochs are Unix milliseconds throughout.
// ---------------------------------------------------------------------------

int64_t days_from_civil(int64_t y, int m, int d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153u * static_cast<unsigned>(m + (m > 2 ? -3 : 9)) + 2u) / 5u +
                         static_cast<unsigned>(d) - 1u;
    const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}


int64_t now_unix_ms() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return 0;
    return static_cast<int64_t>(tv.tv_sec) * 1000 + static_cast<int64_t>(tv.tv_usec / 1000);
}

// HTTP-date (RFC 1123: "Mon, 02 Jan 2006 15:04:05 GMT").
bool parse_http_date(const std::string& raw, int64_t* out_ms) {
    static const char* months[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    const std::string s = trim(raw);
    const size_t comma = s.find(',');
    if (comma == std::string::npos || s.size() < comma + 21) return false;
    const std::string rest = trim(s.substr(comma + 1));
    int d = 0, y = 0, hh = 0, mm = 0, ss = 0;
    char mon[4] = {0};
    if (std::sscanf(rest.c_str(), "%d %3s %d %d:%d:%d", &d, mon, &y, &hh, &mm, &ss) != 6) {
        return false;
    }
    int m = 0;
    for (int i = 0; i < 12; i++) {
        if (std::strncmp(mon, months[i], 3) == 0) { m = i + 1; break; }
    }
    if (m == 0) return false;
    *out_ms = (days_from_civil(y, m, d) * 86400 + hh * 3600 + mm * 60 + ss) * 1000;
    return true;
}


// ---------------------------------------------------------------------------
// Frame IO helpers.
// ---------------------------------------------------------------------------
const plugin_input_frame_t* frame_at(const char* port, uint32_t ordinal) {
    const int32_t idx = plugin_find_input_index(port, ordinal);
    if (idx < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(idx));
}

std::vector<const plugin_input_frame_t*> frames_on(const char* port) {
    std::vector<const plugin_input_frame_t*> out;
    for (uint32_t ordinal = 0;; ordinal++) {
        const plugin_input_frame_t* frame = frame_at(port, ordinal);
        if (!frame) break;
        out.push_back(frame);
    }
    return out;
}

// frame must carry it too (schema name, file identifier and root type).
int push_record_stream(const char* port, const char* schema, const char* identifier,
                       const char* root, const std::vector<uint8_t>& bytes) {
    return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 root, 0, 0, bytes.data(), static_cast<uint32_t>(bytes.size()));
}

void append_size_prefixed(std::vector<uint8_t>* stream, const std::vector<uint8_t>& record) {
    const uint32_t len = static_cast<uint32_t>(record.size());
    stream->push_back(static_cast<uint8_t>(len & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 8) & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 16) & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 24) & 0xff));
    stream->insert(stream->end(), record.begin(), record.end());
}

// A decoded hostcap/http-request response: the default JSON lane
std::vector<uint8_t> finished_unprefixed(::flatbuffers::FlatBufferBuilder& fbb) {
    // The builder wrote [u32 size][record]; the stream re-prefixes, so strip
    // the four bytes (the identifier then sits at bytes 4..8 of the record).
    const uint8_t* p = fbb.GetBufferPointer();
    return std::vector<uint8_t>(p + 4, p + fbb.GetSize());
}


// ---------------------------------------------------------------------------
// Imager fields (as the reference producer publishes them: SDS variable and level, units, the step a code holds).
// Steps are the instruments' precision (owner 2026-10-06): brightness temperature 0.1 K, cloud-top height 34 m,
// reflectance 1/1024, optical depth and effective radius 0.25; the smooth fields coded InlineEncodedChunk.
// ---------------------------------------------------------------------------

struct FieldSpec {
    const char* name;
    wxfVariable variable;
    wxfLevelKind level;
    const char* units;
    bool u16;
    double scale, offset;
    bool codecs, categorical, world_mean, fine;
    float divisor;          // rain rate: mm h-1 -> kg m-2 s-1
    double wavelength_um;   // ABI channel the field is measured or retrieved at (0: none)
    const char* model_id;   // "<sensor> <this>"
};

const FieldSpec kFields[] = {
    {"brightness_temperature_10um", wxfVariable_BrightnessTemperature, wxfLevelKind_TopOfAtmosphere, "K", true, 0.1, 150, true, false, false, false, 1.0f, 10.33, "L1b/CMI"},
    {"cloud_top_height", wxfVariable_GeopotentialHeight, wxfLevelKind_CloudTop, "m", true, 34, -500, true, false, false, false, 1.0f, 0, "NOAA L2"},
    {"cloud_mask", wxfVariable_CloudMask, wxfLevelKind_EntireAtmosphere, "1", false, 3.0 / 254, 0, false, true, true, false, 1.0f, 0, "NOAA L2"},
    {"cloud_phase", wxfVariable_CloudPhase, wxfLevelKind_CloudTop, "1", false, 1, 0, false, true, false, false, 1.0f, 0, "NOAA L2"},
    {"cloud_optical_depth", wxfVariable_CloudOpticalDepth, wxfLevelKind_EntireAtmosphere, "1", true, 0.25, 0, true, false, false, false, 1.0f, 0.64, "NOAA L2"},
    {"cloud_effective_radius", wxfVariable_CloudEffectiveRadius, wxfLevelKind_CloudTop, "um", true, 0.25, 0, true, false, false, false, 1.0f, 0, "NOAA L2"},
    {"reflectance_064um", wxfVariable_Reflectance, wxfLevelKind_TopOfAtmosphere, "1", true, 1.0 / 1024, -0.01, true, false, false, true, 1.0f, 0.64, "NOAA L2"},
    {"rain_rate", wxfVariable_PrecipitationRate, wxfLevelKind_Surface, "kg m-2 s-1", true, 0.01 / 3600, 0, false, false, false, false, 3600.0f, 0, "NOAA L2"},
};

const FieldSpec* field_spec(const std::string& name) {
    for (const FieldSpec& f : kFields) if (name == f.name) return &f;
    return nullptr;
}


// ---------------------------------------------------------------------------
// Node CONFIG: plugin.getConfig answers with one ModuleConfig FlatBuffer (MCFG) on raw "config", read in place through
// sdm_piv::get_config(). The parser reads one key, imager_widths: a comma-separated String, a Number, or a list of
// Strings or Numbers; absent (or no config) = "4096,2048,1024".
// ---------------------------------------------------------------------------

std::string width_text(double v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    return buf;
}

bool config_widths(std::vector<int>* widths, std::string* err) {
    std::vector<std::string> items;
    const sdm_piv::Config config = sdm_piv::get_config();
    switch (config.kind("imager_widths", R::configValueKind_TableList)) {
        case R::configValueKind_String: {
            std::string current;
            for (const char c : std::string(config.string("imager_widths")) + ",") {
                if (c == ',') { if (!trim(current).empty()) items.push_back(trim(current)); current.clear(); }
                else current.push_back(c);
            }
            break;
        }
        case R::configValueKind_Number: items.push_back(width_text(config.number("imager_widths"))); break;
        case R::configValueKind_StringList:
            for (std::string_view item : config.strings("imager_widths")) items.push_back(trim(std::string(item)));
            break;
        case R::configValueKind_NumberList:
            for (double item : config.numbers("imager_widths")) items.push_back(width_text(item));
            break;
        default: break;
    }
    if (items.empty()) items = {"4096", "2048", "1024"};
    for (const std::string& item : items) {
        const int w = atoi(item.c_str());
        if (w != 4096 && w != 2048 && w != 1024) { *err = "imager_widths must be 4096, 2048 and/or 1024"; return false; }
        widths->push_back(w);
    }
    return true;
}

// ---------------------------------------------------------------------------
// One fetched part: its HttpResponse (status, provenance headers, body in place) and the file job it echoes.
// ---------------------------------------------------------------------------

struct Attribution {
    std::string source_name;
    std::string origin_id;
    std::string dataset_id;
    std::string license_url;
    std::string citation;
};

struct FileJob {
    std::string sensor, bucket, key, url, variable, field;
    int64_t frame_time_ms = 0;
    int part = 0, parts = 1;
    std::vector<int> widths;
    Attribution attribution;
};

struct Body {
    long status = 0;
    const uint8_t* data = nullptr;
    size_t size = 0;
    std::string etag, last_modified, content_type, date;
    uint64_t retrieved_ms = 0;
};

std::string str(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

bool read_part(const plugin_input_frame_t* frame, FileJob* job, Body* body, std::string* code, std::string* err) {
    *code = "invalid-response-frame";
    if (!frame || !frame->payload || frame->payload_length == 0) { *err = "http response frame is empty."; return false; }
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!R::VerifyHttpResponseBuffer(verifier)) { *err = "the frame is not an HttpResponse (HRSP)."; return false; }
    const R::HttpResponse& response = *R::GetHttpResponse(frame->payload);
    body->status = response.STATUS();
    if (response.BODY()) { body->data = response.BODY()->data(); body->size = response.BODY()->size(); }
    if (response.HEADERS()) {
        for (const auto* h : *response.HEADERS()) {
            const std::string name = str(h->NAME()), value = str(h->VALUE());
            if (name == "etag") body->etag = value;
            else if (name == "last-modified") body->last_modified = value;
            else if (name == "content-type") body->content_type = value;
            else if (name == "date") body->date = value;
        }
    }
    body->retrieved_ms = response.RETRIEVED_MS();

    *code = "invalid-file-job";
    const auto* context = response.CONTEXT();
    bool ok = false;
    if (context && context->size()) {
        flatbuffers::Verifier job_verifier(context->data(), context->size());
        ok = VerifySizePrefixedWXFBuffer(job_verifier);
    }
    if (!ok) { *err = "the response does not echo its file job (a size-prefixed $WXF) in CONTEXT"; return false; }
    const WXF& w = *GetSizePrefixedWXF(context->data());
    job->field = str(w.FIELD_ID());
    job->variable = str(w.VARIABLE_NAME());
    job->sensor = str(w.SENSOR_ID());
    job->bucket = str(w.DATASET_ID());
    job->url = str(w.SOURCE_URL());
    job->frame_time_ms = static_cast<int64_t>(w.VALID_TIME_MS());
    job->part = static_cast<int>(w.TILE_INDEX());
    job->parts = static_cast<int>(w.TILE_COUNT());
    job->attribution.origin_id = str(w.ORIGIN_ID());
    job->attribution.dataset_id = job->bucket;
    job->attribution.license_url = str(w.LICENSE_URL());
    job->attribution.citation = str(w.CITATION());
    job->attribution.source_name = job->bucket + "-world";
    const std::string host = "https://" + job->bucket + ".s3.amazonaws.com/";
    if (job->url.compare(0, host.size(), host) == 0) job->key = job->url.substr(host.size());
    if (job->sensor.empty() || job->bucket.empty() || job->key.empty() || job->variable.empty()) {
        *err = "a file job needs SENSOR_ID, DATASET_ID (bucket), SOURCE_URL (an object of the bucket) and VARIABLE_NAME";
        return false;
    }
    if (!field_spec(job->field)) { *err = "unknown field \"" + job->field + "\""; return false; }
    if (job->frame_time_ms <= 0) { *err = "VALID_TIME_MS (the frame time) is required"; return false; }
    if (job->parts < 1 || job->part < 0 || job->part >= job->parts) { *err = "TILE_INDEX must be 0 .. TILE_COUNT - 1"; return false; }
    return true;
}

// When the part was received: the host's RETRIEVED_MS, else the publisher's Date, else the node's clock.
int64_t retrieved_at_ms(const Body& body) {
    if (body.retrieved_ms) return static_cast<int64_t>(body.retrieved_ms);
    int64_t ms = 0;
    if (!body.date.empty() && parse_http_date(body.date, &ms)) return ms;
    return now_unix_ms();
}

bool inflate_miniz(const uint8_t* in, size_t n, uint8_t* out, size_t out_size) {
    const size_t got = tinfl_decompress_mem_to_mem(out, out_size, in, n, TINFL_FLAG_PARSE_ZLIB_HEADER);
    return got != TINFL_DECOMPRESS_MEM_TO_MEM_FAILED && got == out_size;
}

// "..._sYYYYJJJHHMMSSt_eYYYYJJJHHMMSSt_..." (the GOES file-name convention) -> scan start/end, Unix ms (whole seconds,
// as the reference reads them).
bool scan_times(const std::string& key, int64_t* start_ms, int64_t* end_ms) {
    auto stamp = [&](char tag, int64_t* out) {
        const std::string marker = std::string("_") + tag;
        size_t at = key.find(marker);
        while (at != std::string::npos) {
            const std::string digits = key.substr(at + 2, 14);
            if (digits.size() == 14 && std::all_of(digits.begin(), digits.end(), ::isdigit)) {
                const int year = atoi(digits.substr(0, 4).c_str()), doy = atoi(digits.substr(4, 3).c_str());
                const int hh = atoi(digits.substr(7, 2).c_str()), mm = atoi(digits.substr(9, 2).c_str()), ss = atoi(digits.substr(11, 2).c_str());
                *out = (days_from_civil(year, 1, 1) + doy - 1) * 86400000LL + (hh * 3600LL + mm * 60LL + ss) * 1000LL;
                return true;
            }
            at = key.find(marker, at + 1);
        }
        return false;
    };
    return stamp('s', start_ms) && stamp('e', end_ms);
}

// ---------------------------------------------------------------------------
// One band of a world level -> one $WXF record (as raw_satellite.py wxf_record writes it).
// ---------------------------------------------------------------------------

struct Platform { double lon0 = 0, height = 0; int64_t scan_start = 0, scan_end = 0; };

std::vector<uint8_t> build_record(const FileJob& job, const FieldSpec& spec, const Platform& platform, int width,
                                  int band_row, int rows, const float* values, int64_t retrieved_ms) {
    using namespace imagerworld;
    const size_t n = static_cast<size_t>(rows) * static_cast<size_t>(width);
    const double d = 360.0 / width;
    const int height = WORLD_H / (WORLD_W / width);
    imagerworld::Spec q;
    q.u16 = spec.u16; q.scale = spec.scale; q.offset = spec.offset; q.codecs = spec.codecs;
    std::vector<uint16_t> codes;
    const size_t missing = quantize(values, n, q, codes);
    float lo = 0, hi = 0; bool any = false;
    for (size_t i = 0; i < n; i++) {
        if (!std::isfinite(values[i])) continue;
        if (!any || values[i] < lo) lo = values[i];
        if (!any || values[i] > hi) hi = values[i];
        any = true;
    }

    ::flatbuffers::FlatBufferBuilder fbb(1024 + n * 2);
    const auto field_id = fbb.CreateString(job.sensor + ":" + std::to_string(job.frame_time_ms) + ":world" + std::to_string(width) + ":" + spec.name);
    const auto model_id = fbb.CreateString(job.sensor + " " + spec.model_id);
    const auto model_version = fbb.CreateString(kParserVersion);
    const auto variable_name = fbb.CreateString(spec.name);
    const auto units = fbb.CreateString(spec.units);
    const auto sensor = fbb.CreateString(job.sensor);
    const auto origin = fbb.CreateString(job.attribution.origin_id);
    const auto dataset = fbb.CreateString(job.attribution.dataset_id.empty() ? job.bucket : job.attribution.dataset_id);
    const auto source_url = fbb.CreateString("s3://" + job.bucket + "/" + job.key);
    const auto license_url = fbb.CreateString(job.attribution.license_url);
    const auto citation = fbb.CreateString(job.attribution.citation);
    ::flatbuffers::Offset<::flatbuffers::Vector<uint8_t>> u8;
    ::flatbuffers::Offset<::flatbuffers::Vector<uint16_t>> u16;
    ::flatbuffers::Offset<::flatbuffers::String> chunk_dtype;
    ::flatbuffers::Offset<::flatbuffers::Vector<::flatbuffers::Offset<::flatbuffers::String>>> chunk_codecs;
    size_t chunk_bytes = 0;
    if (spec.codecs) {
        const std::vector<uint8_t> chunk = encodeChunk(codes, spec.u16);
        chunk_bytes = chunk.size();
        u8 = fbb.CreateVector(chunk);
        chunk_dtype = fbb.CreateString(spec.u16 ? "uint16" : "uint8");
        chunk_codecs = fbb.CreateVectorOfStrings(std::vector<std::string>{"delta", "zigzag", "shuffle"});
    } else if (spec.u16) {
        u16 = fbb.CreateVector(codes);
    } else {
        std::vector<uint8_t> narrow(codes.begin(), codes.end());
        u8 = fbb.CreateVector(narrow);
    }

    WXFGridBuilder grid(fbb);
    grid.add_KIND(wxfGridKind_RegularLatLon);
    grid.add_LAT0(90 - (band_row + .5) * d);
    grid.add_LON0(-180 + .5 * d);
    grid.add_DLAT(-d);
    grid.add_DLON(d);
    grid.add_NLAT(static_cast<uint32_t>(rows));
    grid.add_NLON(static_cast<uint32_t>(width));
    grid.add_PERIODIC_LON(false);
    const auto grid_off = grid.Finish();

    WXFBuilder b(fbb);
    b.add_FIELD_ID(field_id);
    b.add_MODEL_CLASS(wxfModelClass_Analysis);
    b.add_MODEL_ID(model_id);
    b.add_MODEL_VERSION(model_version);
    b.add_TIME_BASIS(wxfTimeBasis_ValidTimeOnly);
    b.add_VALID_TIME_MS(static_cast<uint64_t>(platform.scan_start ? platform.scan_start : job.frame_time_ms));
    b.add_SCAN_END_TIME_MS(static_cast<uint64_t>(platform.scan_end));
    b.add_MEMBER_KIND(wxfMemberKind_Unspecified);
    b.add_VARIABLE(spec.variable);
    b.add_VARIABLE_NAME(variable_name);
    b.add_UNITS(units);
    b.add_LEVEL_KIND(spec.level);
    b.add_GRID(grid_off);
    b.add_TILE_INDEX(static_cast<uint32_t>(band_row / WORLD_ROWS));
    b.add_TILE_COUNT(static_cast<uint32_t>((height + WORLD_ROWS - 1) / WORLD_ROWS));
    if (spec.codecs) {
        b.add_VALUES_ENCODING(wxfValuesEncoding_InlineEncodedChunk);
        b.add_QUANTIZED_U8(u8);
        b.add_CHUNK_DTYPE(chunk_dtype);
        b.add_CHUNK_CODECS(chunk_codecs);
        b.add_CHUNK_BYTE_LENGTH(static_cast<uint64_t>(chunk_bytes));
    } else if (spec.u16) {
        b.add_VALUES_ENCODING(wxfValuesEncoding_InlineQuantizedUint16);
        b.add_QUANTIZED_U16(u16);
    } else {
        b.add_VALUES_ENCODING(wxfValuesEncoding_InlineQuantizedUint8);
        b.add_QUANTIZED_U8(u8);
    }
    b.add_SCALE_FACTOR(spec.scale);
    b.add_ADD_OFFSET(spec.offset);
    b.add_VALUE_MIN(lo);
    b.add_VALUE_MAX(hi);
    b.add_MISSING_COUNT(static_cast<uint32_t>(missing));
    b.add_SENSOR_ID(sensor);
    b.add_CHANNEL_WAVELENGTH_UM(static_cast<float>(spec.wavelength_um));
    b.add_PLATFORM_LONGITUDE_DEG(platform.lon0);
    b.add_PLATFORM_LATITUDE_DEG(0.0);
    b.add_PLATFORM_HEIGHT_M(platform.height);
    b.add_ORIGIN_ID(origin);
    b.add_DATASET_ID(dataset);
    b.add_SOURCE_URL(source_url);
    b.add_RETRIEVED_AT(static_cast<uint64_t>(retrieved_ms));
    b.add_LICENSE_CLASS(wxfLicenseClass_OpenAttribution);
    b.add_LICENSE_URL(license_url);
    b.add_CITATION(citation);
    const auto root = b.Finish();
    FinishSizePrefixedWXFBuffer(fbb, root);
    return finished_unprefixed(fbb);
}

// One fetched file -> its field's world product, every requested width, 64-row band records appended to the stream.
bool world_records(const FileJob& job, const uint8_t* bytes, size_t size, int64_t retrieved_ms, std::vector<uint8_t>* stream,
                   Sha256* normalized, int* count, std::string* code, std::string* message) {
    using namespace imagerworld;
    const FieldSpec& spec = *field_spec(job.field);
    hdf5mini::File file(bytes, size);
    if (!file.open()) { *code = "netcdf-unreadable"; *message = job.key + ": " + file.error(); return false; }
    Field field;
    std::string err;
    if (!readField(file, inflate_miniz, job.variable, spec.fine ? 4 : 1, spec.divisor, field, err)) {
        *code = "netcdf-unreadable"; *message = job.key + ": " + err; return false;
    }
    Platform platform;
    platform.lon0 = field.grid.lon0;
    platform.height = field.grid.H - field.grid.req;
    scan_times(job.key, &platform.scan_start, &platform.scan_end);
    World world = worldProduct(field, spec.categorical, spec.world_mean);
    field.data.clear(); field.data.shrink_to_fit();
    if (world.r1 <= world.r0) return true;   // (the disc reaches no cell: nothing to publish)
    const bool centre = spec.categorical && !spec.world_mean;
    for (int width : job.widths) {
        const int factor = WORLD_W / width;
        const std::vector<float> level = worldLevel(world.values, world.r1 - world.r0, factor, centre);
        const int l0 = world.r0 / factor, l1 = (world.r1 + factor - 1) / factor;
        for (int b = l0; b < l1; b += WORLD_ROWS) {
            const int rows = std::min(WORLD_ROWS, l1 - b);
            const std::vector<uint8_t> record = build_record(job, spec, platform, width, b, rows,
                                                             &level[static_cast<size_t>(b - l0) * static_cast<size_t>(width)], retrieved_ms);
            append_size_prefixed(stream, record);
            normalized_hash_record(normalized, "WXF.fbs", record);
            (*count)++;
        }
    }
    return true;
}

}  // namespace

// ---------------------------------------------------------------------------
// Method entry point.
// ---------------------------------------------------------------------------

extern "C" {

// parse: responses (each echoing its file job; a file's byte-range parts consecutive) -> wxf_meta + wxf_records.
int parse(void) {
    const std::vector<const plugin_input_frame_t*> response_frames = frames_on("responses");
    if (response_frames.empty()) {
        plugin_set_error("missing-response-frame", "parse requires at least one HttpResponse frame on \"responses\".");
        return 400;
    }
    std::vector<int> widths;
    std::string widths_err;
    if (!config_widths(&widths, &widths_err)) {
        plugin_set_error("invalid-widths", widths_err.c_str());
        return 400;
    }
    std::vector<FileJob> jobs(response_frames.size());
    std::vector<Body> bodies(response_frames.size());
    for (size_t k = 0; k < jobs.size(); k++) {
        std::string code, err;
        if (!read_part(response_frames[k], &jobs[k], &bodies[k], &code, &err)) {
            plugin_set_error(code.c_str(), ("response " + std::to_string(k) + ": " + err).c_str());
            return 400;
        }
        jobs[k].widths = widths;
        const bool ranged = jobs[k].parts > 1;
        if (bodies[k].status != 200 && !(ranged && bodies[k].status == 206)) {
            const std::string msg = jobs[k].key + " part " + std::to_string(jobs[k].part) + " fetch returned HTTP status " +
                                    std::to_string(bodies[k].status);
            plugin_set_error("fetch-failed", msg.c_str());
            return 502;
        }
    }

    Sha256 batch, normalized;
    std::vector<uint8_t> stream;
    int count = 0;
    for (size_t k = 0; k < jobs.size();) {
        // a file: its parts 0 .. parts - 1, consecutive
        const FileJob& job = jobs[k];
        if (job.part != 0 || k + job.parts > jobs.size()) {
            plugin_set_error("incomplete-file", (job.key + ": its byte-range parts must arrive together, in order").c_str());
            return 400;
        }
        for (int p = 1; p < job.parts; p++) {
            if (jobs[k + p].key != job.key || jobs[k + p].part != p || jobs[k + p].parts != job.parts) {
                plugin_set_error("incomplete-file", (job.key + ": its byte-range parts must arrive together, in order").c_str());
                return 400;
            }
        }
        const uint8_t* bytes = bodies[k].data;
        size_t size = bodies[k].size;
        std::vector<uint8_t> joined;
        if (job.parts > 1) {
            for (int p = 0; p < job.parts; p++) size += p ? bodies[k + p].size : 0;
            joined.reserve(size);
            for (int p = 0; p < job.parts; p++) joined.insert(joined.end(), bodies[k + p].data, bodies[k + p].data + bodies[k + p].size);
            bytes = joined.data();
        }
        batch.update(bytes, size);
        std::string code, message;
        if (!world_records(job, bytes, size, retrieved_at_ms(bodies[k]), &stream, &normalized, &count, &code, &message)) {
            plugin_set_error(code.c_str(), message.c_str());
            return 422;
        }
        k += static_cast<size_t>(job.parts);
    }

    const std::string batch_id = batch.hex_digest();
    const FileJob& first = jobs[0];
    const Body& first_body = bodies[0];
    const std::string source_url = "s3://" + first.bucket + "/" + first.key;
    const std::string source_peer = "source:" + first.attribution.origin_id;
    const std::string normalized_sha = normalized.hex_digest();

    flatbuffers::FlatBufferBuilder b(1024);
    const auto opt = [&](const std::string& s) { return s.empty() ? 0 : b.CreateString(s); };
    const auto schemas = b.CreateVectorOfStrings(std::vector<std::string>{"WXF.fbs"});
    const auto schema_counts = b.CreateVector(std::vector<uint64_t>{static_cast<uint64_t>(count)});
    const auto provenance = R::CreateProvenance(
        b, b.CreateString(source_url), 200, opt(first_body.etag), opt(first_body.last_modified), opt(first_body.content_type),
        static_cast<uint64_t>(retrieved_at_ms(first_body)), b.CreateString(kParser), b.CreateString(kParserVersion),
        b.CreateString(batch_id), b.CreateString(normalized_sha), static_cast<uint64_t>(count), schemas, schema_counts, 0, false);
    const auto tags = R::CreateSourceTagsDirect(b, kProviderID, first.attribution.source_name.c_str(), batch_id.c_str(),
                                                source_url.c_str(), kContentKeyID, source_peer.c_str(), kLicenseID,
                                                first.attribution.license_url.c_str(), first.attribution.citation.c_str());
    R::FinishIngestRequestBuffer(b, R::CreateIngestRequest(b, b.CreateString("WXF.fbs"), tags, R::reconcileMode_Duplicates, 0, provenance));
    if (plugin_push_output_ex("wxf_meta", "IngestRequest.fbs", R::IngestRequestIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                              "IngestRequest", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0) {
        return 500;
    }
    if (push_record_stream("wxf_records", "WXF.fbs", "$WXF", "WXF", stream) < 0) return 500;
    return 0;
}

}  // extern "C"
