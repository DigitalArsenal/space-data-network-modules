/*
 * data-source/geonames-ingest (graph task `geonames-ingest-flow`).
 *
 * The ORCHESTRATION half of the GeoNames gazetteer lane. `geonames-source` is
 * the request-scoped decoder — a dump in, a $GNP stream out, `capabilities: []`,
 * nothing persisted — which is the right shape for a browser and the wrong
 * shape for a scheduled ingest, and the two cannot be one plugin. So the
 * ingest-only decisions live here, mirroring the cell-tower-source /
 * cell-tower-ingest split exactly.
 *
 * Methods:
 *   mark_query      tick                     -> query               (read the mark)
 *   ingest_plan     tick + mark?             -> request(s), job     (seed | delta | no-op)
 *   ingest_meta     job + records + ...      -> meta, records       (storage-ingest input)
 *   publish_request result + meta            -> mark?, request?     (advance + announce)
 *
 * THE SCHEDULE, AND WHY ONE TICK IS ONE BOUNDED UNIT OF WORK.
 *
 * The flow's single trigger is a 24 h `host-cron` timer, which is the gazetteer's
 * own publication cadence: GeoNames cuts `modifications-YYYY-MM-DD.txt` and
 * `deletes-YYYY-MM-DD.txt` once a day. The FIRST tick has no mark and runs the
 * SEED: `cities15000.zip` plus the three division/country files, which is the
 * whole gazetteer this lane publishes. Every later tick runs the DELTA for the
 * tick's own UTC date. The unit of work is bounded either way, the loop's state
 * lives in the durable mark instead of in a guest instance a restart erases, and
 * an overrun tick is naturally skipped because the next one re-derives the same
 * date and finds the mark already there.
 *
 * THE MARK IS ALSO THE SAME-DATA LEDGER.
 *
 * `celestrak-fetch-policy` and the cellular lane both learned that a scheduled
 * fetch needs a record of what it already has, or it re-downloads the same bytes
 * forever. That record is not a second store here: the mark row carries the
 * upstream ETag, Last-Modified and the date last ingested, so
 *
 *   * a tick whose date already appears on the mark emits NOTHING — no fetch at
 *     all, the cheapest possible no-op;
 *   * every fetch it does make carries `If-None-Match` from the mark, so an
 *     unchanged file costs one conditional request and comes back 304, which
 *     `geonames-source::inflate` ends the run on without an error.
 *
 * WHY THE RESUME MARK ADVANCES WHERE IT DOES.
 *
 * The mark is written by `publish_request`, from the STORAGE RESULT — never by
 * `ingest_plan` at dispatch. A mark advanced when an edition is REQUESTED turns
 * a crash between fetch and store into a permanently skipped day, and the gap is
 * invisible: the next tick moves on to tomorrow. Advancing only on a verified
 * store makes a restart re-fetch at most one day.
 *
 * The mark's WRITE lane is the same measured gap the cellular lane recorded:
 * `hostcap/flatsql-store` is wasi-threads (the flow compiler refuses to mix
 * thread models) and admits only $OMM/$OCM/$OBD; `hostcap/file` has no Go host
 * handler; `storage.write` is schema-typed and would need an SDS record minted
 * for a bookkeeping row. So `publish_request` EMITS the advanced mark on its own
 * port and the flow lands it on egress. The READ side is real: `mark_query`
 * builds the flatsql-query that reads it back and `ingest_plan` consumes it.
 *
 * THE SEED IS RANGED BECAUSE THE HOST CAPS THE BODY.
 *
 * `hostcap/http-request`'s manifest records that the Go server host caps an http
 * response body at 4 MiB. The seed archive was measured at 3,306,445 bytes on
 * 2026-08-15, so it fits — but "fits today" is not a design. The request carries
 * an explicit Range under that ceiling and `ingest_meta` REFUSES the run when
 * Content-Range's denominator proves the object is larger, rather than inflating
 * a truncated archive into a plausible short gazetteer with no error anywhere.
 */

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

// The Go host caps an http response body at 4 MiB (hostcap/http-request
// manifest). The seed archive measured 3,306,445 bytes on 2026-08-15.
constexpr long kHostBodyCapBytes = 4L * 1024L * 1024L;
constexpr long kDefaultTimeoutMs = 90000;
constexpr const char* kMarkTable = "geonames_ingest_mark";
constexpr const char* kSchema = "GNP";
constexpr const char* kDefaultBaseUrl = "https://download.geonames.org/export/dump/";
constexpr const char* kDefaultSeedDataset = "cities15000";
constexpr const char* kDefaultDatasetId = "geonames";
constexpr const char* kDefaultProviderId = "geonames";
constexpr const char* kDefaultSourceName = "geonames-gazetteer";
// CC BY 4.0 is the licence GeoNames publishes these dumps under. It is carried
// verbatim into $GNP.SOURCE.LICENSE/ATTRIBUTION on EVERY record, which is where
// the obligation is actually discharged — the standard names no gazetteer, so
// the credit line has to ride in the data.
constexpr const char* kDefaultLicense = "CC BY 4.0";
constexpr const char* kDefaultLicenseUrl = "https://creativecommons.org/licenses/by/4.0/";
constexpr const char* kDefaultAttribution = "GeoNames (CC BY 4.0)";

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

bool json_bool_or(const std::string& json, const char* key, bool fallback) {
    const std::string needle = std::string("\"") + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return fallback;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return fallback;
    size_t i = colon + 1;
    while (i < json.size() && is_ws(json[i])) i++;
    if (json.compare(i, 4, "true") == 0) return true;
    if (json.compare(i, 5, "false") == 0) return false;
    return fallback;
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
        json_number_or(config, "geonames_http_timeout_ms", static_cast<double>(kDefaultTimeoutMs)));
    return v > 0 ? v : kDefaultTimeoutMs;
}

// The seed byte budget is CLAMPED, not merely defaulted. An operator who sets
// 64 MiB "so the whole file fits" would get a silently truncated body from the
// host and an archive that either fails to inflate or inflates short.
long config_seed_max_bytes(const std::string& config) {
    long v = static_cast<long>(json_number_or(config, "geonames_seed_max_bytes",
                                              static_cast<double>(kHostBodyCapBytes)));
    if (v <= 0 || v > kHostBodyCapBytes) return kHostBodyCapBytes;
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

// The records port is TYPED $GNP on both sides of this node, so the forwarded
// stream is re-announced with its schema rather than as opaque aligned bytes: an
// untyped push does not match the declared type and the frame is refused before
// it can reach storage.
int push_gnp_stream(const char* port, const uint8_t* data, uint32_t length) {
    return plugin_push_output_ex(port, "GNP.fbs", "$GNP", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "GNP", 0, 0, data, length);
}

// SURPLUS-FRAME REFUSAL — see the long note in cell_tower_ingest_module.cpp.
// The compiled flow runtime drains a node's queue PORT-BLIND up to a budget of
// 64 while maxStreams/maxBatch/drainPolicy are declarative only, so a guest that
// reads ordinal 0 and returns destroys every other frame it was handed.
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

// Content-Range: "bytes 0-3145727/3306445" -> the total after the slash. The
// DENOMINATOR is the only authority on the object's size: Content-Length on a
// 206 describes the CHUNK.
bool total_from_content_range(const std::string& headers_json, long* total) {
    std::string value;
    if (!json_string_field(headers_json, "content-range", &value) &&
        !json_string_field(headers_json, "Content-Range", &value)) {
        return false;
    }
    const size_t slash = value.rfind('/');
    if (slash == std::string::npos || slash + 1 >= value.size()) return false;
    if (value[slash + 1] == '*') return false;  // unknown total; not an answer
    const long parsed = std::atol(value.c_str() + slash + 1);
    if (parsed <= 0) return false;
    *total = parsed;
    return true;
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

// The UTC date (YYYY-MM-DD) this tick is ingesting. It is taken from the TICK,
// never from a clock read inside the guest: two nodes of one flow reading the
// clock a millisecond apart across midnight would plan one date and store
// another, and the mark would then skip a day forever. `firedAt` is an RFC 3339
// instant, so its first ten characters are the date.
std::string tick_date(const std::string& tick) {
    std::string fired;
    if (json_string_field(tick, "firedAt", &fired) && fired.size() >= 10) {
        return fired.substr(0, 10);
    }
    return std::string();
}

std::string mark_json(const std::string& dataset_id, const std::string& lane, bool seeded,
                      const std::string& dataset_epoch, const std::string& delta_date,
                      const std::string& etag, const std::string& last_modified,
                      const std::string& batch_id, long records) {
    return std::string("{\"dataset_id\":\"") + json_escape(dataset_id) + "\"" + ",\"lane\":\"" +
           json_escape(lane) + "\"" + ",\"seeded\":" + (seeded ? "true" : "false") +
           ",\"dataset_epoch\":\"" + json_escape(dataset_epoch) + "\"" + ",\"delta_date\":\"" +
           json_escape(delta_date) + "\"" + ",\"etag\":\"" + json_escape(etag) + "\"" +
           ",\"last_modified\":\"" + json_escape(last_modified) + "\"" + ",\"batch_id\":\"" +
           json_escape(batch_id) + "\"" + ",\"records\":" + std::to_string(records) + "}";
}

// One http-request descriptor. `conditional` attaches If-None-Match from the
// mark, which is what turns an unchanged upstream file into one cheap 304
// instead of a full re-download and a re-store of identical rows.
std::string http_get(const std::string& url, long timeout_ms, const std::string& range,
                     const std::string& if_none_match) {
    std::string headers;
    if (!range.empty()) headers += "\"Range\":\"" + json_escape(range) + "\"";
    if (!if_none_match.empty()) {
        if (!headers.empty()) headers += ",";
        headers += "\"If-None-Match\":\"" + json_escape(if_none_match) + "\"";
    }
    return std::string("{\"method\":\"GET\",\"url\":\"") + json_escape(url) + "\"" +
           ",\"headers\":{" + headers + "}" + ",\"timeoutMs\":" + std::to_string(timeout_ms) + "}";
}

}  // namespace

extern "C" {

// mark_query: the daily timer tick -> the flatsql-query JSON that reads this
// dataset's resume mark back. A SEPARATE node from ingest_plan on purpose: the
// plan takes the mark as an INPUT, and a node that emitted its own input would
// be a cycle in the flow graph.
//
// EMITS {"sql","params"}, never {"table","where"} — hostcap/flatsql-query's
// `query` reads `sql` and returns 400 `missing-sql` for anything else.
int mark_query(void) {
    if (refuse_batched()) return 500;
    const std::string config = load_config();
    const std::string dataset = config_string(config, "geonames_dataset_id", kDefaultDatasetId);
    const std::string query = std::string("{\"sql\":\"SELECT * FROM ") + kMarkTable +
                              " WHERE dataset_id = ? LIMIT 1\"" +
                              ",\"params\":[{\"t\":\"str\",\"v\":\"" + json_escape(dataset) +
                              "\"}]}";
    return push_json("query", query) < 0 ? 500 : 0;
}

// ingest_plan: tick (+ the resume mark, when one exists) -> the fetch
// descriptors and the geonames-source run contract for THIS tick.
//
// Three outcomes, and only three:
//
//   SEED   (no mark, or a mark that has never seeded) — the archive plus the
//          three division/country files. This is the whole gazetteer.
//   DELTA  (seeded) — the tick's own UTC day: modifications + deletes, both
//          plain text, both full geoname/tombstone rows.
//   NO-OP  (the mark already carries this date) — NOTHING is emitted, the http
//          nodes never become ready and the run ends without a fetch. A day
//          already ingested is not an error.
int ingest_plan(void) {
    if (refuse_batched()) return 500;

    const std::string config = load_config();
    const std::string base = config_string(config, "geonames_base_url", kDefaultBaseUrl);
    if (base.empty()) {
        // Fail-closed: with no source configured there is nothing to fetch, and
        // inventing a default here would ingest a gazetteer nobody selected.
        plugin_set_error("missing-ingest-url",
                         "ingest_plan requires geonames_base_url in node CONFIG.");
        return 400;
    }
    const std::string dataset = config_string(config, "geonames_dataset_id", kDefaultDatasetId);
    const std::string seed_name =
        config_string(config, "geonames_seed_dataset", kDefaultSeedDataset);
    const long timeout = config_timeout_ms(config);

    const std::string tick = input_text("tick");
    const std::string date = tick_date(tick);

    const std::string mark = input_text("mark");
    bool seeded = false;
    std::string mark_date;
    std::string mark_etag;
    if (!mark.empty()) {
        std::string mark_dataset;
        // A mark belonging to a DIFFERENT dataset is ignored rather than
        // trusted: resuming dataset A from dataset B's date would skip A's seed
        // and never report it.
        if (json_string_field(mark, "dataset_id", &mark_dataset) && mark_dataset == dataset) {
            seeded = json_bool_or(mark, "seeded", false);
            json_string_field(mark, "delta_date", &mark_date);
            json_string_field(mark, "etag", &mark_etag);
        }
    }

    // LEDGERED NO-OP. The cheapest possible tick: the day this tick would fetch
    // is already on the mark, so nothing is requested at all. This is what makes
    // an overrun tick harmless and a restart free.
    if (seeded && !date.empty() && date == mark_date) return 0;

    const std::string epoch = date.empty() ? std::string() : date + "T00:00:00.000Z";
    if (epoch.empty()) {
        // $GNP.SOURCE.DATASET_EPOCH is REQUIRED on every record and the epoch is
        // the EDITION boundary, so it comes from the tick and is never guessed.
        plugin_set_error("missing-tick-date",
                         "ingest_plan needs the tick's firedAt to date this edition; "
                         "$GNP.SOURCE.DATASET_EPOCH is required on every record and an epoch "
                         "guessed in-guest would make two editions falsely comparable.");
        return 400;
    }

    const std::string license = config_string(config, "geonames_license", kDefaultLicense);
    const std::string license_url =
        config_string(config, "geonames_license_url", kDefaultLicenseUrl);
    const std::string attribution =
        config_string(config, "geonames_attribution", kDefaultAttribution);
    const long limit = static_cast<long>(json_number_or(config, "geonames_limit", 0));

    const std::string lane = seeded ? "delta" : "seed";
    const std::string container = seeded ? "plain" : "zip";
    const std::string member = seeded ? std::string() : seed_name + ".txt";
    const std::string url = seeded ? base + "modifications-" + date + ".txt"
                                   : base + seed_name + ".zip";

    // The seed carries an explicit Range under the host's 4 MiB response-body
    // cap; the delta files are tens of kilobytes and are fetched whole.
    std::string range;
    if (!seeded) {
        char buf[48];
        std::snprintf(buf, sizeof(buf), "bytes=0-%ld", config_seed_max_bytes(config) - 1);
        range = buf;
    }

    const std::string job =
        std::string("{\"lane\":\"") + json_escape(lane) + "\"" + ",\"container\":\"" +
        json_escape(container) + "\"" + ",\"member\":\"" + json_escape(member) + "\"" +
        ",\"dataset_id\":\"" + json_escape(dataset) + "\"" + ",\"dataset_name\":\"" +
        json_escape(config_string(config, "geonames_dataset_name", "GeoNames gazetteer")) + "\"" +
        ",\"dataset_url\":\"" + json_escape(base) + "\"" + ",\"dataset_epoch\":\"" +
        json_escape(epoch) + "\"" + ",\"source_url\":\"" + json_escape(url) + "\"" +
        ",\"source_query\":\"" + json_escape(seeded ? "modifications-" + date + ".txt"
                                                    : seed_name + ".zip") +
        "\"" + ",\"license\":\"" + json_escape(license) + "\"" + ",\"license_url\":\"" +
        json_escape(license_url) + "\"" + ",\"attribution\":\"" + json_escape(attribution) + "\"" +
        ",\"share_alike\":" + (json_bool_or(config, "geonames_share_alike", false) ? "true"
                                                                                   : "false") +
        ",\"non_commercial_only\":" +
        (json_bool_or(config, "geonames_non_commercial_only", false) ? "true" : "false") +
        ",\"id_prefix\":\"" +
        json_escape(config_string(config, "geonames_id_prefix", kDefaultDatasetId)) + "\"" +
        ",\"provider_id\":\"" +
        json_escape(config_string(config, "geonames_provider_id", kDefaultProviderId)) + "\"" +
        ",\"delta_date\":\"" + json_escape(date) + "\"" + ",\"limit\":" + std::to_string(limit) +
        ",\"seed_max_bytes\":" + std::to_string(config_seed_max_bytes(config)) + "}";

    // Job FIRST: every downstream decoder needs the run contract, and a response
    // arriving before it would have nothing to be interpreted against.
    if (push_json("job", job) < 0) return 500;
    if (push_json("request", http_get(url, timeout, range, mark_etag)) < 0) return 500;

    if (seeded) {
        // The tombstone lane. Only the delta has one: a seed edition IS the
        // gazetteer's current state and has nothing to remove.
        if (push_json("request_deletes",
                      http_get(base + "deletes-" + date + ".txt", timeout, "", "")) < 0) {
            return 500;
        }
        return 0;
    }

    // The division and country tables. Fetched only with the seed, because $GNP
    // needs them to resolve names and they change on the gazetteer's own slow
    // cadence, not daily.
    if (push_json("request_admin1", http_get(base + "admin1CodesASCII.txt", timeout, "", "")) < 0) {
        return 500;
    }
    if (push_json("request_admin2", http_get(base + "admin2Codes.txt", timeout, "", "")) < 0) {
        return 500;
    }
    if (push_json("request_country", http_get(base + "countryInfo.txt", timeout, "", "")) < 0) {
        return 500;
    }
    return 0;
}

// ingest_meta: the geonames-source `job`, the $GNP record stream, the parse
// `decision` and the raw http `response` -> the hostcap/storage-ingest `meta`
// frame and the records, forwarded.
//
// The records pass through untouched. This node exists to author the attribution
// the storage lane cannot invent — dataset, source, batch and the epoch state —
// and to read the three facts only the RESPONSE carries: Content-Range's total,
// the ETag and Last-Modified that the ledger turns on.
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
                         "ingest_meta requires the decoded $GNP record stream.");
        return 400;
    }

    const std::string config = load_config();
    std::string dataset;
    std::string source_url;
    std::string epoch;
    json_string_field(job, "dataset_id", &dataset);
    json_string_field(job, "source_url", &source_url);
    json_string_field(job, "dataset_epoch", &epoch);
    if (dataset.empty() || source_url.empty() || epoch.empty()) {
        plugin_set_error("incomplete-job-attribution",
                         "ingest_meta needs dataset_id, source_url and dataset_epoch on the job "
                         "frame; storage cannot invent the edition a record belongs to.");
        return 400;
    }

    std::string lane;
    std::string delta_date;
    json_string_field(job, "lane", &lane);
    json_string_field(job, "delta_date", &delta_date);

    const std::string response = input_text("response");
    const std::string headers = headers_object(response);
    const std::string etag = header_value(headers, "etag", "ETag");
    const std::string last_modified = header_value(headers, "last-modified", "Last-Modified");

    long total_bytes = 0;
    if (!headers.empty()) total_from_content_range(headers, &total_bytes);

    // THE SEED MUST NOT BE SILENTLY TRUNCATED. The host caps a response body at
    // 4 MiB; if Content-Range's denominator proves the archive is larger than
    // the range that was asked for, the bytes in hand are a PREFIX of a ZIP and
    // decoding them further would either fail obscurely or, worse, succeed on a
    // subset and report a gazetteer that is simply missing places.
    const long seed_max = static_cast<long>(
        json_number_or(job, "seed_max_bytes", static_cast<double>(kHostBodyCapBytes)));
    if (lane == "seed" && total_bytes > seed_max) {
        char message[288];
        std::snprintf(message, sizeof(message),
                      "the seed archive is %ld bytes but the host caps a response body at %ld; "
                      "the bytes in hand are a PREFIX of the archive. Decoding a prefix would "
                      "report a gazetteer that is merely missing places, so the run stops here. "
                      "Split the seed across ticks or select a smaller edition.",
                      total_bytes, seed_max);
        plugin_set_error("seed-exceeds-host-body-cap", message);
        return 502;
    }

    // The record count this tick actually produced, from parse_places' decision.
    // publish_request needs it to tell a genuinely empty day from a stored-
    // nothing refusal; -1 (absent) disables that check rather than faking one.
    const std::string decision = input_text("decision");
    const long records_in =
        decision.empty() ? -1 : static_cast<long>(json_number_or(decision, "recordsOut", -1));

    // ONE BATCH PER EDITION. The batch id is the dataset and the epoch's date,
    // so re-running a day is idempotent at the storage lane and two days never
    // collide.
    const std::string batch_id = dataset + "@" + (delta_date.empty() ? epoch : delta_date);

    char prov_buf[320];
    std::snprintf(prov_buf, sizeof(prov_buf),
                  "{\"source_url\":\"%s\",\"lane\":\"%s\",\"dataset_epoch\":\"%s\"}",
                  json_escape(source_url).c_str(), json_escape(lane).c_str(),
                  json_escape(epoch).c_str());
    const std::string provenance = prov_buf;

    const std::string meta =
        std::string("{\"schema\":\"") + kSchema + "\"" + ",\"provider_id\":\"" +
        json_escape(config_string(config, "geonames_provider_id", kDefaultProviderId)) + "\"" +
        ",\"source_name\":\"" +
        json_escape(config_string(config, "geonames_source_name", kDefaultSourceName)) + "\"" +
        ",\"source_url\":\"" + json_escape(source_url) + "\"" + ",\"batch_id\":\"" +
        json_escape(batch_id) + "\"" +
        // `append`, for BOTH lanes. The delta is an upsert of a few thousand
        // rows and not the gazetteer's complete set, so a source-batch reconcile
        // on it would delete the entire rest of the world; the seed is append
        // for symmetry, and a re-seed reconciles by its own batch id.
        ",\"reconcile\":\"append\"" + ",\"dataset_id\":\"" + json_escape(dataset) + "\"" +
        ",\"dataset_epoch\":\"" + json_escape(epoch) + "\"" + ",\"lane\":\"" + json_escape(lane) +
        "\"" + ",\"delta_date\":\"" + json_escape(delta_date) + "\"" + ",\"etag\":\"" +
        json_escape(etag) + "\"" + ",\"last_modified\":\"" + json_escape(last_modified) + "\"" +
        ",\"total_bytes\":" + std::to_string(total_bytes) +
        ",\"records_in\":" + std::to_string(records_in) +
        ",\"provenance\":{\"source\":\"geonames-ingest-wasm/v1\"" + ",\"json\":\"" +
        base64_encode(reinterpret_cast<const uint8_t*>(provenance.data()), provenance.size()) +
        "\"}}";

    if (push_json("meta", meta) < 0) return 500;
    if (push_gnp_stream("records", records->payload, records->payload_length) < 0) return 500;
    return 0;
}

// publish_request: the storage-ingest `result` joined with the `meta` that
// produced it -> the advanced resume mark, and (only when configured) the
// dataset-publication POST that announces the epoch.
//
// The epoch announce mints NO new record type: DATASET_EPOCH and DATASET_CID
// already ride in $GNP.SOURCE on every stored record, so the announcement is the
// node's normal per-(provider, standard) publication of the batch.
//
// The mark is emitted on its own port and is NOT gated on the publish URL: a
// node that stores without publishing must still make progress, or an
// unpublished deployment re-ingests the same day forever.
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

    std::string dataset;
    std::string batch_id;
    std::string epoch;
    std::string lane;
    std::string delta_date;
    std::string etag;
    std::string last_modified;
    json_string_field(meta, "dataset_id", &dataset);
    json_string_field(meta, "batch_id", &batch_id);
    json_string_field(meta, "dataset_epoch", &epoch);
    json_string_field(meta, "lane", &lane);
    json_string_field(meta, "delta_date", &delta_date);
    json_string_field(meta, "etag", &etag);
    json_string_field(meta, "last_modified", &last_modified);

    // THE SILENT NOP, CAUGHT. hostcap/storage-ingest already errors on
    // `ok:false`, which covers the disk-floor errCapJSON refusal. What survives
    // that check is `ok:true, inserted:0` — byte-identical to a day on which the
    // gazetteer changed nothing. It is only distinguishable against the count
    // the run actually produced, so the mark does NOT advance (and the ETag is
    // NOT ledgered) when records went in and nothing came out. Ledgering the
    // ETag there would be the worse half of the failure: every later tick would
    // then no-op against data that was never stored.
    const long inserted = static_cast<long>(json_number_or(result, "inserted", -1));
    const long records_in = static_cast<long>(json_number_or(meta, "records_in", -1));
    if (inserted == 0 && records_in > 0) {
        char message[288];
        std::snprintf(message, sizeof(message),
                      "storage.ingest_with_source reported ok with inserted=0 for an edition "
                      "carrying %ld records (dataset %s, batch %s). The resume mark is NOT "
                      "advanced and the upstream ETag is NOT ledgered: doing either would make "
                      "every later tick no-op against places that were never stored.",
                      records_in, dataset.c_str(), batch_id.c_str());
        plugin_set_error("ingest-stored-nothing", message);
        return 502;
    }

    const std::string next_mark =
        mark_json(dataset, lane, true, epoch, delta_date, etag, last_modified, batch_id,
                  inserted < 0 ? records_in : inserted);
    if (push_json("mark", next_mark) < 0) return 500;

    const std::string config = load_config();
    std::string publish_url;
    if (!json_string_field(config, "geonames_publish_url", &publish_url) || publish_url.empty()) {
        // Fail-closed. Absence of configuration is not permission to publish.
        return 0;
    }

    std::string schema;
    if (!json_string_field(result, "schema", &schema) || schema.empty()) {
        json_string_field(meta, "schema", &schema);
    }
    std::string provider;
    std::string source;
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
