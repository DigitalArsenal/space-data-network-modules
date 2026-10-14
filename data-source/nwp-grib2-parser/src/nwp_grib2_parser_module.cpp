/*
 * data-source/nwp-grib2-parser (typed contracts 1.0: FlatBuffers only, no JSON and no base64).
 *
 * A pure parser flow node (capabilities: none, no hostcall) for numerical-weather-prediction model fields in GRIB2
 * (NOAA/NCEP GFS and GEFS from NOAA Open Data Dissemination's public buckets, fetched message by message through the .idx
 * inventory): each instantaneous field becomes $WXF record(s) carrying the GRIB2 packing's own integers - value = (R + X
 * 2^E) / 10^D, so SCALE_FACTOR = 2^E / 10^D and ADD_OFFSET = R / 10^D (times 1/100 for a percentage, the fraction $WXF
 * defines) - exactly, delta/zigzag/shuffle coded (InlineEncodedChunk). Rows south to north, longitude from 0 east,
 * every `stride`-th point (GEFS 0.5 deg spread at the 1 deg points), whole or in `band_rows` bands, or cut into tiles.
 * Raw: nothing is resampled or derived (owner 2026-10-02: SDN carries raw feeds; the display derives).
 *
 * GRIB2 is read by grib2mini (vendored; grid 3.0, product 4.0/4.1/4.2, packing 5.0/5.2/5.3, bitmaps), checked against
 * ecCodes on NOAA's own files. Interval statistics (4.8/4.11/4.12), other grids or packings, parameters it does not map
 * and integers wider than 16 bits are refused by name.
 *
 * Method:
 *   parse : responses (HttpResponse, HRSP) -> wxf_meta (IngestRequest, INGQ) + wxf_records ($WXF record stream)
 *       Each response is whole GRIB2 messages of one byte range, and carries ITS JOB in CONTEXT: the size-prefixed $WXF
 *       header record nwp-field-source's plan built for the (product, lead) - FIELD_ID "<model_key>:<run>:f<LLL>:
 *       <product>", VARIABLE_NAME the product (the lane's SOURCE_NAME), MODEL_CLASS / MODEL_ID, LEAD_HOURS, MEMBER_KIND
 *       (StandardDeviation: the GEFS spread) / ENSEMBLE_SIZE, GRID.DLAT the records' spacing (the stride is it over the
 *       field's own spacing), GRID.NLAT the rows a record (0 = whole), TILE_COUNT > 1 the square tiles (2n x n), SOURCE_URL
 *       and the attribution (ORIGIN_ID, DATASET_ID, LICENSE_CLASS, LICENSE_URL, CITATION). Pairing is by CONTEXT, never by
 *       position. One batch per invocation (a tiled job: one batch a tile, through the backlog).
 */
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include <sys/time.h>

#include "space_data_module_invoke.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
// $WXF (spacedatastandards.org lib/cpp/WXF/main_generated.h) and grib2mini are inlined ahead of this file by build.mjs.

namespace {

namespace R = sdn::runtime;

constexpr const char* kContentKeyID = "public";
constexpr const char* kParserName = "nwp-grib2-parser";
constexpr const char* kParserVersion = "nwp-grib2-parser/v2";

// ---------------------------------------------------------------------------
// Small string helpers.
// ---------------------------------------------------------------------------

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

std::vector<const plugin_input_frame_t*> frames_on(const char* port) {
    std::vector<const plugin_input_frame_t*> out;
    for (uint32_t ordinal = 0;; ordinal++) {
        const int32_t idx = plugin_find_input_index(port, ordinal);
        if (idx < 0) break;
        out.push_back(plugin_get_input_frame(static_cast<uint32_t>(idx)));
    }
    return out;
}

// The record streams declare their concrete SDS identity on the port, so the
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

// What the parser keeps of one HttpResponse (HRSP): the status, the validators and dates of its headers, the host's
// receive time and the body.
struct Fetched {
    long status = 0;
    std::string etag;
    std::string last_modified;
    std::string content_type;
    std::string date;
    int64_t retrieved_ms = 0;
    std::vector<uint8_t> body;
};

std::string header_of(const R::HttpResponse& r, const char* lower_name) {
    if (!r.HEADERS()) return std::string();
    for (const R::Header* h : *r.HEADERS())
        if (h && h->NAME() && h->NAME()->str() == lower_name) return h->VALUE() ? h->VALUE()->str() : std::string();
    return std::string();
}

// The records' retrieval time: the publisher's Date header, else the host's receive time, else the clock.
int64_t retrieved_at_ms(const Fetched& response) {
    int64_t ms = 0;
    if (!response.date.empty() && parse_http_date(response.date, &ms)) return ms;
    if (response.retrieved_ms > 0) return response.retrieved_ms;
    return now_unix_ms();
}

// ---------------------------------------------------------------------------
// The ingest request (IngestRequest, INGQ) for storage-ingest: source tags, reconcile mode and provenance.
// ---------------------------------------------------------------------------

struct Attribution {
    std::string provider_id;
    std::string source_name;
    std::string source_url;
    std::string origin_id;
    std::string dataset_id;
    std::string license_id;
    std::string license_url;
    std::string citation;
};

std::vector<uint8_t> build_ingest_request(const char* schema, const Attribution& attribution, const std::string& source_url,
                                          const std::string& batch_id, const Fetched& response, const std::string& source_sha256,
                                          const std::string& normalized_sha256, int normalized_count, int64_t retrieved_ms) {
    R::IngestRequestT q;
    q.SCHEMA = schema;
    q.TAGS = std::make_unique<R::SourceTagsT>();
    q.TAGS->PROVIDER_ID = attribution.provider_id;
    q.TAGS->SOURCE_NAME = attribution.source_name;
    q.TAGS->BATCH_ID = batch_id;
    q.TAGS->SOURCE_URL = source_url;
    q.TAGS->CONTENT_KEY_ID = kContentKeyID;
    q.TAGS->SOURCE_PEER = "source:" + attribution.origin_id;
    q.TAGS->LICENSE = attribution.license_id;
    q.TAGS->LICENSE_URL = attribution.license_url;
    q.TAGS->CITATION = attribution.citation;
    q.RECONCILE = R::reconcileMode_Duplicates;
    q.PROVENANCE = std::make_unique<R::ProvenanceT>();
    R::ProvenanceT& p = *q.PROVENANCE;
    p.SOURCE_URL = source_url;
    p.HTTP_STATUS = static_cast<int32_t>(response.status);
    p.ETAG = response.etag;
    p.LAST_MODIFIED = response.last_modified;
    p.CONTENT_TYPE = response.content_type;
    p.RETRIEVED_MS = static_cast<uint64_t>(retrieved_ms);
    p.PARSER = kParserName;
    p.PARSER_VERSION = kParserVersion;
    p.SOURCE_SHA256 = source_sha256;
    p.NORMALIZED_SHA256 = normalized_sha256;
    p.NORMALIZED_COUNT = static_cast<uint64_t>(normalized_count);
    p.SCHEMAS = {schema};
    p.SCHEMA_COUNTS = {static_cast<uint64_t>(normalized_count)};
    p.FROM_CACHE = false;
    ::flatbuffers::FlatBufferBuilder b(1024);
    R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, &q));
    return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

int push_ingest_request(const std::vector<uint8_t>& meta) {
    return plugin_push_output_ex("wxf_meta", "IngestRequest.fbs", R::IngestRequestIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "IngestRequest", 0, 0, meta.data(), static_cast<uint32_t>(meta.size()));
}

std::vector<uint8_t> finished_unprefixed(::flatbuffers::FlatBufferBuilder& fbb) {
    // The builder wrote [u32 size][record]; the stream re-prefixes, so strip
    // the four bytes (the identifier then sits at bytes 4..8 of the record).
    const uint8_t* p = fbb.GetBufferPointer();
    return std::vector<uint8_t>(p + 4, p + fbb.GetSize());
}

// CHUNK_CODECS ["delta", "zigzag", "shuffle"] over uint16 codes (SDS 1.238 InlineEncodedChunk).
std::vector<uint8_t> encode_chunk_u16(const std::vector<uint16_t>& codes) {
    const size_t n = codes.size();
    std::vector<uint8_t> out(n * 2);
    uint16_t prev = 0;
    for (size_t i = 0; i < n; i++) {
        const int16_t d = static_cast<int16_t>(static_cast<uint16_t>(i ? codes[i] - prev : codes[i]));
        prev = codes[i];
        const uint16_t z = static_cast<uint16_t>(d >= 0 ? 2 * int32_t(d) : -2 * int32_t(d) - 1);
        out[i] = static_cast<uint8_t>(z & 0xff);
        out[n + i] = static_cast<uint8_t>(z >> 8);
    }
    return out;
}

// ---------------------------------------------------------------------------
// GRIB2 parameter + level -> the record's name, SDS variable and level, units and unit factor (as the reference
// encoders name them: Cesium_Weather tools/fetch-motion-wxf.mjs, fetch-model-clouds-wxf.mjs, src/voxel/
// atmosphereColumns.js). The factor turns the field's units into the record's (percent -> the fraction $WXF defines).
// ---------------------------------------------------------------------------

struct Mapped {
    std::string name;
    wxfVariable variable = wxfVariable_Unspecified;
    wxfLevelKind level = wxfLevelKind_Surface;
    float level_value = 0;     // Pa (pressure levels), m (heights above ground)
    const char* units = "";
    double factor = 1;
};

std::string format_level_number(double v) {
    char buf[32];
    if (v == std::floor(v)) std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v));
    else std::snprintf(buf, sizeof(buf), "%g", v);
    return buf;
}

// false: a parameter / level this parser does not publish (refused by name, never guessed)
bool map_field(const grib2mini::Message& m, Mapped* out, std::string* why) {
    const int d = m.discipline, c = m.category, n = m.number, lt = m.levelType;
    const double lv = double(m.levelValue) / std::pow(10.0, m.levelScale);
    struct Quantity { int d, c, n; const char* stem; wxfVariable variable; const char* units; double factor; };
    static const Quantity kQuantities[] = {
        {0, 0, 0, "air_temperature", wxfVariable_Temperature, "K", 1},
        {0, 0, 6, "dew_point_temperature", wxfVariable_Unspecified, "K", 1},
        {0, 3, 5, "geopotential_height", wxfVariable_GeopotentialHeight, "gpm", 1},
        {0, 2, 2, "wind_east", wxfVariable_WindU, "m s-1", 1},
        {0, 2, 3, "wind_north", wxfVariable_WindV, "m s-1", 1},
        {0, 1, 1, "relative_humidity", wxfVariable_RelativeHumidity, "1", 0.01},
        {0, 2, 8, "vertical_velocity", wxfVariable_VerticalVelocity, "Pa s-1", 1},
        {0, 6, 1, "cloud_cover_total", wxfVariable_TotalCloudCover, "1", 0.01},
        {0, 6, 3, "cloud_cover_low", wxfVariable_LowCloudCover, "1", 0.01},
        {0, 6, 4, "cloud_cover_mid", wxfVariable_MediumCloudCover, "1", 0.01},
        {0, 6, 5, "cloud_cover_high", wxfVariable_HighCloudCover, "1", 0.01},
        {0, 3, 196, "boundary_layer_height", wxfVariable_Unspecified, "m", 1},
        {0, 7, 6, "convective_available_potential_energy", wxfVariable_Unspecified, "J kg-1", 1},
        {0, 3, 1, "mean_sea_level_pressure", wxfVariable_MeanSeaLevelPressure, "Pa", 1},
        // the air at the surface (the sea product): the instantaneous precipitation rate, the post-processor's visibility
        {0, 1, 7, "precipitation_rate", wxfVariable_Unspecified, "kg m-2 s-1", 1},
        {0, 19, 0, "visibility", wxfVariable_Unspecified, "m", 1},
    };
    const Quantity* q = nullptr;
    for (const Quantity& k : kQuantities) if (k.d == d && k.c == c && k.n == n) q = &k;
    if (!q) { *why = "parameter " + std::to_string(d) + "." + std::to_string(c) + "." + std::to_string(n); return false; }
    out->variable = q->variable; out->units = q->units; out->factor = q->factor;
    const std::string stem = q->stem;
    if (lt == 100) {                                   // isobaric surface (Pa)
        out->level = wxfLevelKind_PressureLevel; out->level_value = static_cast<float>(lv);
        out->name = stem + "_" + format_level_number(lv / 100.0) + "hPa";
    } else if (lt == 7) {                              // tropopause
        out->level = wxfLevelKind_Tropopause; out->name = stem + "_tropopause";
    } else if (lt == 103) {                            // height above ground (m)
        out->level = wxfLevelKind_HeightAboveGround; out->level_value = static_cast<float>(lv);
        out->name = stem + "_" + format_level_number(lv) + "m";
        if (stem == "air_temperature" && lv == 2) out->variable = wxfVariable_Temperature2m;
        if (stem == "dew_point_temperature" && lv == 2) out->variable = wxfVariable_DewpointTemperature2m;
        if (stem == "wind_east" && lv == 10) out->variable = wxfVariable_WindU10m;
        if (stem == "wind_north" && lv == 10) out->variable = wxfVariable_WindV10m;
    } else if (lt == 1) {                              // ground or water surface
        out->level = wxfLevelKind_Surface; out->name = stem + "_surface";
    } else if (lt == 101) {                            // mean sea level
        out->level = wxfLevelKind_MeanSeaLevel; out->name = stem;
    } else if (lt == 215) {                            // cloud ceiling (the ceiling's height: missing where there is none)
        out->level = wxfLevelKind_EntireAtmosphere; out->name = stem + "_cloud_ceiling";
    } else if (lt == 10 || lt == 200 || lt == 214 || lt == 224 || lt == 234) {   // entire atmosphere; low/middle/high cloud layer
        out->level = wxfLevelKind_EntireAtmosphere; out->name = stem;
    } else {
        *why = stem + " at level type " + std::to_string(lt);
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// A GRIB2 job: one byte range of one product file (whole messages), as the source's select node emitted it.
// ---------------------------------------------------------------------------

struct GribJob {
    std::string url, product, model_key, model_id, run;
    wxfModelClass model_class = wxfModelClass_Other;
    int64_t lead = 0;
    double grid_deg = 0;   // the records' spacing: the stride is it over the field's own spacing
    int band_rows = 0, ensemble_size = 0;
    double tile_deg = 0;   // > 0: level-4 style tiles of this many degrees, one batch a tile (the sea product)
    bool spread = false;
    Attribution attribution;
};

// The provider lane and licence of a dataset the job names (DATASET_ID: the NOAA Open Data Dissemination bucket). A
// dataset this parser has no attribution for is refused, never stored under a guessed provider.
struct DatasetAttribution { const char* dataset_id; const char* provider_id; const char* license_id; };
const DatasetAttribution kDatasets[] = {
    {"noaa-gfs-bdp-pds", "noaa-ncep", "LicenseRef-NOAA-Open-Data"},
    {"noaa-gefs-pds", "noaa-ncep", "LicenseRef-NOAA-Open-Data"},
};

std::string text_of(const ::flatbuffers::String* s) { return s ? s->str() : std::string(); }

// The job a response carries back in CONTEXT: the size-prefixed $WXF header record nwp-field-source's plan built.
bool read_grib_job(const R::HttpResponse& response, GribJob* job, std::string* err) {
    const auto* context = response.CONTEXT();
    if (!context || context->size() < 8) { *err = "the response carries no job ($WXF header) in CONTEXT"; return false; }
    ::flatbuffers::Verifier verifier(context->data(), context->size());
    if (!VerifySizePrefixedWXFBuffer(verifier)) { *err = "the response's CONTEXT is not a size-prefixed $WXF header record"; return false; }
    const WXF& h = *GetSizePrefixedWXF(context->data());
    const std::string field_id = text_of(h.FIELD_ID());
    const size_t c1 = field_id.find(':'), c2 = c1 == std::string::npos ? c1 : field_id.find(':', c1 + 1);
    if (c2 == std::string::npos) { *err = "the job's FIELD_ID is not <model_key>:<run>:...: " + field_id; return false; }
    job->model_key = field_id.substr(0, c1);
    job->run = field_id.substr(c1 + 1, c2 - c1 - 1);
    job->url = text_of(h.SOURCE_URL());
    job->product = text_of(h.VARIABLE_NAME());
    job->model_id = text_of(h.MODEL_ID());
    job->model_class = h.MODEL_CLASS();
    job->lead = static_cast<int64_t>(std::llround(h.LEAD_HOURS()));
    job->spread = h.MEMBER_KIND() == wxfMemberKind_StandardDeviation;
    job->ensemble_size = h.ENSEMBLE_SIZE();
    job->grid_deg = h.GRID()->DLAT();
    job->band_rows = static_cast<int>(h.GRID()->NLAT());
    Attribution& a = job->attribution;
    a.source_name = job->product;
    a.source_url = job->url;
    a.origin_id = text_of(h.ORIGIN_ID());
    a.dataset_id = text_of(h.DATASET_ID());
    a.license_url = text_of(h.LICENSE_URL());
    a.citation = text_of(h.CITATION());
    for (const DatasetAttribution& d : kDatasets)
        if (a.dataset_id == d.dataset_id) { a.provider_id = d.provider_id; a.license_id = d.license_id; }
    if (job->url.empty() || job->product.empty() || job->model_key.empty() || job->run.empty()) { *err = "a GRIB job needs SOURCE_URL, VARIABLE_NAME (the product) and FIELD_ID <model_key>:<run>"; return false; }
    if (a.provider_id.empty()) { *err = "dataset \"" + a.dataset_id + "\" has no provider attribution in this parser"; return false; }
    if (!(job->grid_deg > 0)) { *err = "the job's GRID.DLAT (the records' spacing) must be > 0"; return false; }
    const uint32_t tiles = h.TILE_COUNT();
    if (tiles > 1) {
        const long n = std::lround(std::sqrt(tiles / 2.0));
        if (n < 1 || static_cast<uint32_t>(2 * n * n) != tiles) { *err = "TILE_COUNT " + std::to_string(tiles) + " is not a 2n x n tiling of the globe"; return false; }
        job->tile_deg = 180.0 / static_cast<double>(n);
    }
    return true;
}

// ---------------------------------------------------------------------------
// One message -> its record(s): the packing integers, rows south to north, every `stride`-th point, whole or in bands.
// ---------------------------------------------------------------------------

// A tiled job's records, a batch a tile (job.tile_deg): key "<x>:<y>", x from 180 W, y from the north pole - the
// world-clouds demo's level-4 tiles (Cesium_Weather seaStateWorker.js tiled), read a tile at a time through the node's
// record index by batch.
struct TileBatch {
    int x = 0, y = 0, lead = 0;
    std::vector<uint8_t> stream;
    Sha256 normalized;
    int count = 0;
};
using TileSinks = std::map<std::string, TileBatch>;

bool message_records(const GribJob& job, const uint8_t* bytes, const grib2mini::Message& m, const grib2mini::Message* previous_bitmap,
                     int64_t retrieved_ms, std::vector<uint8_t>* stream, Sha256* normalized, int* count, std::string* code, std::string* message,
                     TileSinks* tiles) {
    Mapped f;
    std::string why;
    if (!map_field(m, &f, &why)) { *code = "unsupported-field"; *message = job.url + ": " + why + " is not one this parser publishes"; return false; }
    if (m.productTemplate == 8 || m.productTemplate == 11 || m.productTemplate == 12) {
        *code = "statistical-field-unsupported";
        *message = job.url + ": " + f.name + " is an interval statistic (product template 4." + std::to_string(m.productTemplate) + "); only instantaneous fields are published";
        return false;
    }
    if (m.scanMode != 0 || m.ni == 0 || m.nj < 2) { *code = "grid-unsupported"; *message = job.url + ": " + f.name + ": scan mode " + std::to_string(m.scanMode) + " (only +i, -j)"; return false; }
    // every `stride`-th point: the job's spacing over the field's own (1..8, whole, the same both ways)
    const long stride_l = std::lround(job.grid_deg / m.dj);
    if (stride_l < 1 || stride_l > 8 || std::fabs(stride_l * m.dj - job.grid_deg) > 1e-6 || std::fabs(stride_l * m.di - job.grid_deg) > 1e-6) {
        *code = "grid-unsupported";
        *message = job.url + ": " + f.name + ": the job asks for a " + std::to_string(job.grid_deg) + " deg grid; the field's spacing (" +
                   std::to_string(m.dj) + " x " + std::to_string(m.di) + " deg) is not 1..8 times into it";
        return false;
    }
    const int stride = static_cast<int>(stride_l);
    std::vector<uint32_t> X;
    std::string err;
    if (!grib2mini::unpack(bytes, m, previous_bitmap, X, err)) { *code = "grib2-unreadable"; *message = job.url + ": " + f.name + ": " + err; return false; }
    // the grid: GRIB rows north to south from La1; the record south to north from the southernmost row, lon from Lo1
    const double dlat = m.dj * stride, dlon = m.di * stride;
    const uint32_t nj = (m.nj - 1) / static_cast<uint32_t>(stride) + 1, ni = (m.ni + static_cast<uint32_t>(stride) - 1) / static_cast<uint32_t>(stride);
    const double lat0 = m.la1 - (m.nj - 1) * m.dj;   // southernmost row
    if (std::fabs(m.la1 - 90) > 1e-6 || std::fabs(lat0 + 90) > 1e-6 || std::fabs(m.lo1) > 1e-6) {
        *code = "grid-unsupported"; *message = job.url + ": " + f.name + ": only global grids from 90 N, 0 E are published"; return false;
    }
    const bool periodic = std::fabs(m.ni * m.di - 360.0) < 1e-6;
    std::vector<uint16_t> codes(static_cast<size_t>(ni) * nj);
    double lo = 0, hi = 0; bool any = false; uint32_t missing = 0;
    const double scale = std::ldexp(1.0, m.E) / std::pow(10.0, m.D) * f.factor, offset = double(m.R) / std::pow(10.0, m.D) * f.factor;
    for (uint32_t j = 0; j < nj; j++) {
        const uint32_t src_row = m.nj - 1 - j * static_cast<uint32_t>(stride);   // (record row j from the south)
        for (uint32_t i = 0; i < ni; i++) {
            const uint32_t x = X[static_cast<size_t>(src_row) * m.ni + static_cast<size_t>(i) * static_cast<uint32_t>(stride)];
            uint16_t c;
            if (x == grib2mini::MISSING) { c = 65535; missing++; }
            else if (x > 65534) { *code = "packing-too-wide"; *message = job.url + ": " + f.name + ": a packing integer (" + std::to_string(x) + ") does not fit 16 bits"; return false; }
            else {
                c = static_cast<uint16_t>(x);
                const double v = offset + scale * x;
                if (!any || v < lo) lo = v;
                if (!any || v > hi) hi = v;
                any = true;
            }
            codes[static_cast<size_t>(j) * ni + i] = c;
        }
    }
    const int64_t init_ms = m.referenceTimeMs, lead = m.forecastHours();
    if (lead < 0) { *code = "grib2-unreadable"; *message = job.url + ": " + f.name + ": time unit " + std::to_string(m.timeUnit) + " unsupported"; return false; }
    const std::string name = f.name + (job.spread ? "_spread" : "");
    // one record: the codes of a part of the field (rows south to north) on its own grid
    auto build = [&](const std::vector<uint16_t>& part, double glat0, double glon0, uint32_t grows, uint32_t gcols, bool gperiodic,
                     uint32_t tile_index, uint32_t tile_count, const std::string& id_suffix) {
        double plo = 0, phi = 0; bool pany = false; uint32_t pmiss = 0;
        for (uint16_t c : part) {
            if (c == 65535) { pmiss++; continue; }
            const double v = offset + scale * c;
            if (!pany || v < plo) plo = v;
            if (!pany || v > phi) phi = v;
            pany = true;
        }
            const std::vector<uint8_t> chunk = encode_chunk_u16(part);
            ::flatbuffers::FlatBufferBuilder fbb(1024 + chunk.size());
            const auto field_id = fbb.CreateString(job.model_key + ":" + job.run + ":f" + std::to_string(lead) + ":" + name + id_suffix);
            const auto model_id = fbb.CreateString(job.model_id);
            const auto model_version = fbb.CreateString(kParserVersion);
            const auto variable_name = fbb.CreateString(name);
            const auto units = fbb.CreateString(f.units);
            const auto values = fbb.CreateVector(chunk);
            const auto chunk_dtype = fbb.CreateString("uint16");
            const auto chunk_codecs = fbb.CreateVectorOfStrings(std::vector<std::string>{"delta", "zigzag", "shuffle"});
            const auto origin = fbb.CreateString(job.attribution.origin_id);
            const auto dataset = fbb.CreateString(job.attribution.dataset_id);
            const auto source_url = fbb.CreateString(job.url);
            const auto license_url = fbb.CreateString(job.attribution.license_url);
            const auto citation = fbb.CreateString(job.attribution.citation);
            WXFGridBuilder grid(fbb);
            grid.add_KIND(wxfGridKind_RegularLatLon);
            grid.add_LAT0(glat0);
            grid.add_LON0(glon0);
            grid.add_DLAT(dlat);
            grid.add_DLON(dlon);
            grid.add_NLAT(grows);
            grid.add_NLON(gcols);
            grid.add_PERIODIC_LON(gperiodic);
            const auto grid_off = grid.Finish();
            WXFBuilder r(fbb);
            r.add_FIELD_ID(field_id);
            r.add_MODEL_CLASS(job.model_class);
            r.add_MODEL_ID(model_id);
            r.add_MODEL_VERSION(model_version);
            r.add_TIME_BASIS(wxfTimeBasis_Initialization);
            r.add_INIT_TIME_MS(static_cast<uint64_t>(init_ms));
            r.add_LEAD_HOURS(static_cast<float>(lead));
            r.add_VALID_TIME_MS(static_cast<uint64_t>(init_ms + lead * 3600000));
            r.add_MEMBER_KIND(job.spread ? wxfMemberKind_StandardDeviation : wxfMemberKind_Unspecified);
            if (job.ensemble_size > 0) r.add_ENSEMBLE_SIZE(static_cast<uint16_t>(job.ensemble_size));
            r.add_VARIABLE(f.variable);
            r.add_VARIABLE_NAME(variable_name);
            r.add_UNITS(units);
            r.add_LEVEL_KIND(f.level);
            r.add_LEVEL_VALUE(f.level_value);
            r.add_TEMPORAL_KIND(wxfTemporalKind_Instantaneous);
            r.add_GRID(grid_off);
            r.add_TILE_INDEX(tile_index);
            r.add_TILE_COUNT(tile_count);
            r.add_VALUES_ENCODING(wxfValuesEncoding_InlineEncodedChunk);
            r.add_QUANTIZED_U8(values);
            r.add_CHUNK_DTYPE(chunk_dtype);
            r.add_CHUNK_CODECS(chunk_codecs);
            r.add_CHUNK_BYTE_LENGTH(static_cast<uint64_t>(chunk.size()));
            r.add_SCALE_FACTOR(scale);
            r.add_ADD_OFFSET(offset);
            r.add_VALUE_MIN(static_cast<float>(plo));
            r.add_VALUE_MAX(static_cast<float>(phi));
            r.add_MISSING_COUNT(pmiss);
            r.add_ORIGIN_ID(origin);
            r.add_DATASET_ID(dataset);
            r.add_SOURCE_URL(source_url);
            r.add_RETRIEVED_AT(static_cast<uint64_t>(retrieved_ms));
            r.add_LICENSE_CLASS(wxfLicenseClass_OpenAttribution);
            r.add_LICENSE_URL(license_url);
            r.add_CITATION(citation);
            const auto root = r.Finish();
            FinishSizePrefixedWXFBuffer(fbb, root);
            return finished_unprefixed(fbb);
    };
    if (job.tile_deg > 0 && tiles) {
        // tiles of tile_deg (x from 180 W, y from the north pole), both edges carried (a point on an edge in both tiles),
        // longitudes wrapping on a periodic grid
        if (!periodic) { *code = "grid-unsupported"; *message = job.url + ": " + f.name + ": tiles need a periodic global grid"; return false; }
        const int nx = static_cast<int>(std::lround(360.0 / job.tile_deg)), ny = static_cast<int>(std::lround(180.0 / job.tile_deg));
        const uint32_t tp = static_cast<uint32_t>(std::lround(job.tile_deg / dlat)) + 1, tq = static_cast<uint32_t>(std::lround(job.tile_deg / dlon)) + 1;
        for (int ty = 0; ty < ny; ty++) {
            const double south = 90.0 - (ty + 1) * job.tile_deg;
            const uint32_t r0 = static_cast<uint32_t>(std::lround((south - lat0) / dlat)), rows = std::min(tp, nj - r0);
            for (int tx = 0; tx < nx; tx++) {
                const double west = -180.0 + tx * job.tile_deg;
                const double west0 = std::fmod(std::fmod(west - m.lo1, 360.0) + 360.0, 360.0);
                const uint32_t c0 = static_cast<uint32_t>(std::lround(west0 / dlon));
                std::vector<uint16_t> part(static_cast<size_t>(rows) * tq);
                for (uint32_t j = 0; j < rows; j++)
                    for (uint32_t i = 0; i < tq; i++) part[static_cast<size_t>(j) * tq + i] = codes[static_cast<size_t>(r0 + j) * ni + (c0 + i) % ni];
                const std::string key = std::to_string(tx) + ":" + std::to_string(ty);
                const std::vector<uint8_t> record = build(part, lat0 + r0 * dlat, west, rows, tq, false, static_cast<uint32_t>(ty * nx + tx),
                                                          static_cast<uint32_t>(nx * ny), ":s4:" + key);
                TileBatch& t = (*tiles)[key];
                t.x = tx; t.y = ty; t.lead = static_cast<int>(lead);
                append_size_prefixed(&t.stream, record);
                normalized_hash_record(&t.normalized, "WXF.fbs", record);
                t.count++;
                (*count)++;
            }
        }
    } else {
        const uint32_t band = job.band_rows > 0 ? static_cast<uint32_t>(job.band_rows) : nj;
        const uint32_t bands = (nj + band - 1) / band;
        for (uint32_t b = 0; b < bands; b++) {
            const uint32_t r0 = b * band, rows = std::min(band, nj - r0);
            std::vector<uint16_t> part(codes.begin() + static_cast<ptrdiff_t>(r0) * ni, codes.begin() + static_cast<ptrdiff_t>(r0 + rows) * ni);
            const std::vector<uint8_t> record = build(part, lat0 + r0 * dlat, m.lo1, rows, ni, periodic, b, bands, "");
            append_size_prefixed(stream, record);
            normalized_hash_record(normalized, "WXF.fbs", record);
            (*count)++;
        }
    }
    (void)missing; (void)lo; (void)hi; (void)any;
    return true;
}

}  // namespace

// ---------------------------------------------------------------------------
// Method entry point.
// ---------------------------------------------------------------------------

extern "C" {

// A tiled parse's batches, handed out one an invocation (the rest yielded as backlog: the compiled runtime resumes a
// yielded node without input) - storage-ingest takes one meta + one record stream at a time. The runtime hands a node
// its queued frames on EVERY invocation, a resumed one too: a lead-file arriving while a lead's tiles are still going
// out is kept as its raw GRIB bytes (a few MB, not its ~20 MB of tile records) and cut when the tiles before it are out -
// nothing dropped, the memory one lead's tiles plus the waiting leads' bytes. (A whole-field or banded batch is parsed
// and emitted at once, as before.)
struct PendingBatch { std::vector<uint8_t> meta; std::vector<uint8_t> stream; };
struct PendingInput { std::vector<GribJob> jobs; std::vector<Fetched> responses; };
std::vector<PendingBatch> g_tile_backlog;
size_t g_tile_next = 0;
std::vector<PendingInput> g_raw_pending;
size_t g_raw_next = 0;
uint32_t g_tiles_per_lead = 512;

void set_backlog_state() {
    const uint32_t tiles = static_cast<uint32_t>(g_tile_backlog.size() - g_tile_next);
    const uint32_t raw = static_cast<uint32_t>(g_raw_pending.size() - g_raw_next);
    const uint32_t remaining = tiles + raw * g_tiles_per_lead;
    plugin_set_backlog_remaining(remaining);
    plugin_set_yielded(remaining > 0 ? 1 : 0);
}

// One input's records: a tiled job's into the tile backlog (tiled true), else the batch's ingest request + record
// stream. Returns 0, or the failing status with the error set.
int parse_input(const PendingInput& in, bool* tiled, std::vector<uint8_t>* meta_out, std::vector<uint8_t>* stream) {
    Sha256 batch, normalized;
    int count = 0;
    TileSinks tiles;
    for (size_t k = 0; k < in.jobs.size(); k++) {
        const std::vector<uint8_t>& body = in.responses[k].body;
        batch.update(body.data(), body.size());
        std::vector<grib2mini::Message> messages;
        std::string err;
        if (!grib2mini::parse(body.data(), body.size(), messages, err)) {
            plugin_set_error("grib2-unreadable", (in.jobs[k].url + ": " + err).c_str());
            return 422;
        }
        if (messages.empty()) {
            plugin_set_error("grib2-unreadable", (in.jobs[k].url + ": the range holds no GRIB2 message").c_str());
            return 422;
        }
        const grib2mini::Message* previous_bitmap = nullptr;
        for (const grib2mini::Message& m : messages) {
            std::string code, message;
            if (!message_records(in.jobs[k], body.data(), m, previous_bitmap, retrieved_at_ms(in.responses[k]), stream, &normalized, &count, &code, &message, &tiles)) {
                plugin_set_error(code.c_str(), message.c_str());
                return 422;
            }
            if (m.bitmapIndicator == 0) previous_bitmap = &m;
        }
    }
    const std::string batch_id = batch.hex_digest();
    const GribJob& first = in.jobs[0];
    const Fetched& response = in.responses[0];
    const int64_t retrieved = retrieved_at_ms(response);
    *tiled = !tiles.empty();
    if (*tiled) {
        g_tiles_per_lead = static_cast<uint32_t>(tiles.size());
        for (auto& [key, t] : tiles) {
            char lead[8];
            std::snprintf(lead, sizeof(lead), "%03d", t.lead);
            const std::string tile_batch = first.model_key + ":" + first.run + ":f" + lead + ":s4:" + key;
            g_tile_backlog.push_back({build_ingest_request("WXF.fbs", first.attribution, first.url, tile_batch, response, batch_id,
                                                           t.normalized.hex_digest(), t.count, retrieved),
                                      std::move(t.stream)});
        }
        return 0;
    }
    *meta_out = build_ingest_request("WXF.fbs", first.attribution, first.url, batch_id, response, batch_id, normalized.hex_digest(), count, retrieved);
    return 0;
}

// The next tile batch out - cutting the next waiting lead when the tiles before it are all out. Returns 0 (with or
// without a batch out), or the failing status.
int emit_next_tile_batch() {
    if (g_tile_next >= g_tile_backlog.size()) {
        g_tile_backlog.clear(); g_tile_next = 0;
        while (g_tile_backlog.empty() && g_raw_next < g_raw_pending.size()) {
            PendingInput in = std::move(g_raw_pending[g_raw_next++]);
            if (g_raw_next >= g_raw_pending.size()) { g_raw_pending.clear(); g_raw_next = 0; }
            bool tiled = false;
            std::vector<uint8_t> unused_meta, unused_stream;
            const int status = parse_input(in, &tiled, &unused_meta, &unused_stream);
            if (status != 0) return status;
        }
        if (g_tile_backlog.empty()) return 0;
    }
    PendingBatch b = std::move(g_tile_backlog[g_tile_next++]);
    if (push_ingest_request(b.meta) < 0) return 500;
    if (push_record_stream("wxf_records", "WXF.fbs", "$WXF", "WXF", b.stream) < 0) return 500;
    if (g_tile_next >= g_tile_backlog.size()) { g_tile_backlog.clear(); g_tile_next = 0; }
    return 0;
}

// parse: the responses (each whole GRIB2 messages of one byte range, its job a $WXF header in CONTEXT) -> wxf_meta
// (IngestRequest) + wxf_records (one batch for the invocation). A tiled job (TILE_COUNT) -> one batch a tile, batch_id
// <model>:<run>:f<LLL>:s4:<x>:<y>, handed out one an invocation; resumed without input, the next.
int parse(void) {
    if (plugin_get_input_count() == 0) {
        const int status = emit_next_tile_batch();
        set_backlog_state();
        return status;
    }
    const std::vector<const plugin_input_frame_t*> response_frames = frames_on("responses");
    if (response_frames.empty()) {
        plugin_set_error("missing-response-frame", "parse requires at least one HttpResponse frame on \"responses\".");
        return 400;
    }
    PendingInput in;
    in.jobs.resize(response_frames.size());
    in.responses.resize(response_frames.size());
    bool tiled_job = false;
    for (size_t k = 0; k < response_frames.size(); k++) {
        const plugin_input_frame_t* frame = response_frames[k];
        if (!frame || !frame->payload || frame->payload_length == 0) {
            plugin_set_error("invalid-response-frame", ("response " + std::to_string(k) + ": the frame is empty.").c_str());
            return 400;
        }
        ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
        if (!R::VerifyHttpResponseBuffer(verifier)) {
            plugin_set_error("invalid-response-frame", ("response " + std::to_string(k) + ": not an HttpResponse (HRSP).").c_str());
            return 400;
        }
        const R::HttpResponse& r = *R::GetHttpResponse(frame->payload);
        std::string err;
        if (!read_grib_job(r, &in.jobs[k], &err)) {
            plugin_set_error("invalid-grib-job", ("response " + std::to_string(k) + " (" + text_of(r.URL()) + "): " + err).c_str());
            return 400;
        }
        Fetched& f = in.responses[k];
        f.status = r.STATUS();
        if (f.status != 200 && f.status != 206) {
            const std::string why = r.ERROR() && r.ERROR()->size() ? " (" + r.ERROR()->str() + ")" : std::string();
            plugin_set_error("fetch-failed", (in.jobs[k].url + " returned HTTP status " + std::to_string(f.status) + why).c_str());
            return 502;
        }
        f.etag = header_of(r, "etag");
        f.last_modified = header_of(r, "last-modified");
        f.content_type = header_of(r, "content-type");
        f.date = header_of(r, "date");
        f.retrieved_ms = static_cast<int64_t>(r.RETRIEVED_MS());
        if (r.BODY()) f.body.assign(r.BODY()->data(), r.BODY()->data() + r.BODY()->size());
        if (in.jobs[k].tile_deg > 0) tiled_job = true;
    }
    if (tiled_job) {
        // (kept raw until the tiles before it are out; then cut, and the next tile batch out)
        g_raw_pending.push_back(std::move(in));
        const int status = emit_next_tile_batch();
        set_backlog_state();
        return status;
    }
    bool tiled = false;
    std::vector<uint8_t> meta, stream;
    const int status = parse_input(in, &tiled, &meta, &stream);
    if (status != 0) return status;
    if (push_ingest_request(meta) < 0) return 500;
    if (push_record_stream("wxf_records", "WXF.fbs", "$WXF", "WXF", stream) < 0) return 500;
    set_backlog_state();   // (tiles still going out: yielded, resumed for them)
    return 0;
}

}  // extern "C"
