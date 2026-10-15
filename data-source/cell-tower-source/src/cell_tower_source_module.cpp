/*
 * data-source/cell-tower-source — many cellular-provider registries -> one
 * deconflicted SDS $TBS site stream.
 *
 * OWNER DIRECTIVE 2026-08-08: "the entire point is to grab from all providers
 * in the wasm module deployed to sdn.spaceaware.io, and have as options there
 * (configurable through the GUI here) which providers to use and how to
 * deconflict them, and have the final result sent using a spacedatastandard
 * streamed to OrbPro and displayed."
 *
 * ─── FLOW-NODE SHAPE (typed contracts 1.0: FlatBuffers only) ────────────────
 * Three pure flow nodes. The module performs NO I/O of its own: fetching is the
 * generic hostcap/http-request connector node. No host capability is needed.
 *
 *   route     : $HTQ request        -> "requests" (N HttpRequest, each carrying
 *                                                  the run contract $APR in CONTEXT)
 *                                      "decision"/"availability" (refusal $APR, or
 *                                                  the answer of a run with nothing
 *                                                  to fetch: $APR + empty $DAV)
 *                                      "catalog"  ($QRP projection page -> mediator)
 *                                      "credential" ($APR task -> mediator)
 *   parse     : HttpResponses        -> "job"     (the $APR contract, passed on)
 *                                      "reports" ($TBS, one SINGLE_SOURCE record each)
 *                                      "resume"  ($IRM: the bulk lane's next mark)
 *   deconflict: job + reports        -> "records" (size-prefixed $TBS stream)
 *                                      "decision" ($APR + the run's counters)
 *                                      "availability" ($DAV of the dataset)
 *
 * The BROWSER supplies the configuration per request and renders the result. It
 * never fetches a provider, never merges, never scores. That inversion is the
 * whole point of the directive.
 *
 * ─── WHY REQUEST-SCOPED CONFIG, NOT NODE OPTIONS ────────────────────────────
 * The node's module-runtime options API is admin-only and node-global. A demo
 * viewer choosing his own provider set must not rewrite operator config for
 * every other viewer, so the provider set and merge method arrive on the
 * request and die with it. Credentials are the exception: those are node state
 * by nature and live in the node's credential store (see the CREDENTIALS note).
 *
 * ─── THE $TBS CONTRACT THIS ENCODES (SDS 1.184.0, ratified 2026-08-08) ──────
 * 1. SOURCES and CONSENSUS are BOTH `required` in the IDL. A deconflicted site
 *    that cannot say who reported it and how it was merged is unrepresentable
 *    by construction — every record written here carries both, always.
 * 2. Every provider in a merge group appears in SOURCES, winners and losers,
 *    each with its own LICENSE and ATTRIBUTION. That is a share-alike
 *    obligation surviving republication, not decoration.
 * 3. RADIO defaults to UNKNOWN and METHOD to UNSPECIFIED in the IDL precisely
 *    so an unset enum never decodes as ordinal-0 GSM / SINGLE_SOURCE. This
 *    module always writes both explicitly anyway.
 * 4. CELL_ID is a STRING: a 16-bit CI, a 28-bit LTE ECI and a 36-bit NR NCI are
 *    not the same number space and must not be coerced into one integer.
 *
 * ─── DECONFLICTION ──────────────────────────────────────────────────────────
 * The normative semantics live in
 * packages/cell-towers-worldwide/src/deconflict.mjs and are mirrored here
 * exactly; tests/parity.test.mjs drives BOTH over the same fixtures and fails
 * the build on any divergence, so this comment can never quietly drift from the
 * code. Summary of the rules that are judgement calls rather than mechanics:
 *   - Identity is the network identifiers where a provider supplies them.
 *     LAC and TAC are the same slot in different generations, so keying on both
 *     would split an agreement into two sites.
 *   - A report with no identifiers is matched by proximity and NEVER folded
 *     into an identifier group: being near a cell is not evidence of being it.
 *   - Ties break on provider id ascending. The parity gate needs determinism
 *     more than it needs a cleverer rule.
 *   - Providers CONSULTED counts every provider asked, including ones that
 *     returned nothing. Absent is not zero.
 *
 * ─── CREDENTIALS (owner directive #2, IMPLEMENTED HERE) ────────────────────
 * "If it needs a login, it should have somewhere to put a username / password,
 * and if those are entered, it should send them encrypted to the module, and
 * then the module should store them securely using our plugin secure storage."
 *
 * THE PLAINTEXT NEVER CROSSES THE WIRE AND NEVER TOUCHES THIS MODULE'S OUTPUT.
 * The browser seals `{"username","secret"}` to the node's `provider-wrapping`
 * X25519 slot; the sealed envelope arrives on `PUT /credentials/<providerId>`;
 * this module asks the HOST to open it (`keyslot.unwrap`, a crypto oracle that
 * returns the plaintext but never the slot key) and immediately hands the
 * result to the host keystore (`secrets.put`), which encrypts it at rest under
 * the machine-bound root. Nothing is echoed back: the response says only that
 * the lane is stored. `DELETE` is `secrets.clear`.
 *
 * FOUR THINGS THIS DELIBERATELY DOES NOT DO:
 *   1. It never accepts an unsealed credential. There is no plaintext branch to
 *      fall back to, so a browser that cannot seal cannot send.
 *   2. It never logs, echoes or re-emits a value — not in the reply, not in the
 *      catalog, not in a skip reason. `credentialConfigured` is presence only.
 *   3. It never invents a key slot. `keySlot` is emitted ONLY when the host
 *      answers `node.publicKey`; absent it, the catalog omits the field and the
 *      GUI must (and does) refuse to collect a credential.
 *   4. It does not fetch a credentialed provider yet. See below — that is an
 *      account problem, not a code one, and pretending otherwise would ship a
 *      guess compiled into a URL.
 *
 * CAPABILITY POSTURE. Three grants, each per-lane and each an explicit operator
 * row in capability_policy.json keyed to this artifact's content hash:
 *   - `wallet_sign`             gates keyslot.unwrap (the host has no separate
 *                               `keyslot` capability name; caps/keyslot.go).
 *   - `secrets:cell_<id>:write` gates secrets.put/secrets.clear. It is a
 *                               SEPARATE grant from the read lane by Seal
 *                               Council condition: capability_policy.json is an
 *                               append-only ledger and rows approved for
 *                               READING must never gain write on an upgrade.
 *   - `secrets:cell_<id>`       gates secrets.get/secrets.status — needed so
 *                               `credentialConfigured` can be TRUE rather than
 *                               a guess, and so a stored credential can later
 *                               reach the request that needs it. Holding write
 *                               confers no read and vice versa.
 *
 * WHY THE CREDENTIALED PROVIDERS ARE STILL SKIPPED AT FETCH TIME. Both auth
 * MECHANISMS were verified live on 2026-08-09 before anything was written here:
 *   - OpenCelliD `GET https://opencellid.org/cell/getInArea?key=<token>&...`
 *     answers 200 `{"error":"API Key not known: test","code":2}` — the token is
 *     a query parameter and the endpoint is real.
 *   - WiGLE `GET https://api.wigle.net/api/v2/cell/search?...` answers 401
 *     "Not Authorized (WiGLE.net)" — HTTP Basic, and the endpoint is real.
 * What could NOT be verified without an account is the ROW-QUERY shape (bbox
 * parameter order, paging, field names), and this module's own history says
 * what happens when that is guessed: `fcc-asr` was compiled in against a page
 * that serves no rows and returned nothing for weeks. So a configured
 * credential changes the skip REASON — proving the store round-trip end to end
 * — and the query template lands when an account exists to verify it against.
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <set>
#include <utility>
#include <string>
#include <vector>

#include <sys/time.h>
#include <ctime>

#include "space_data_module_invoke.h"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"

namespace {

// ── tbsRadioClass / tbsMergeMethod ordinals (schema/TBS/main.fbs) ───────────
// Verified against the published 1.184.0 IDL, not against a summary of it.
enum RadioClass : int8_t { RC_GSM = 0, RC_CDMA, RC_UMTS, RC_LTE, RC_NR, RC_OTHER, RC_UNKNOWN };
enum MergeMethod : int8_t {
    MM_SINGLE_SOURCE = 0,
    MM_HIGHEST_SAMPLE_COUNT,
    MM_MOST_RECENT,
    MM_AUTHORITY_PRECEDENCE,
    MM_CENTROID,
    MM_UNSPECIFIED
};

// Matches DEFAULT_POSITION_TOLERANCE_M in deconflict.mjs. Deliberately
// conservative: collapsing two real masts on one street is a worse error than
// leaving a duplicate visible.
constexpr double kPositionToleranceM = 250.0;
constexpr double kEarthRadiusM = 6378137.0;

// ── minimal JSON helpers ───────────────────────────────────────────────────
// JSON exists here ONLY as an external representation: the client's own HTTP
// request body (PROVIDERS, METHOD, LIMIT, ...) and the providers' own JSON
// payloads. Nothing between flow nodes is JSON — every intra-flow frame is a
// FlatBuffer.

std::string json_escape(const std::string& in) {
    std::string out;
    out.reserve(in.size() + 8);
    for (char c : in) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

// Reverses json_escape for the one level of nesting the http mount introduces.
std::string json_unescape(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] != '\\' || i + 1 >= in.size()) { out += in[i]; continue; }
        switch (in[++i]) {
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case '"': out += '"'; break;
            case '\\': out += '\\'; break;
            case '/': out += '/'; break;
            case 'u': {
                if (i + 4 < in.size()) {
                    const std::string hex = in.substr(i + 1, 4);
                    const long cp = std::strtol(hex.c_str(), nullptr, 16);
                    i += 4;
                    // Only the ASCII range appears in these control frames;
                    // anything above it is passed through as a replacement
                    // rather than silently mangled into a wrong byte.
                    out += (cp < 0x80) ? static_cast<char>(cp) : '?';
                }
                break;
            }
            default: out += in[i];
        }
    }
    return out;
}

// Finds "key": and returns the raw value slice. Depth-aware enough for the
// flat frames this flow uses; it is never pointed at arbitrary provider JSON.
bool json_raw_field(const std::string& src, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    size_t at = src.find(needle);
    if (at == std::string::npos) return false;
    at = src.find(':', at + needle.size());
    if (at == std::string::npos) return false;
    ++at;
    while (at < src.size() && (src[at] == ' ' || src[at] == '\n' || src[at] == '\t')) ++at;
    if (at >= src.size()) return false;
    size_t end = at;
    if (src[at] == '"') {
        end = at + 1;
        while (end < src.size() && !(src[end] == '"' && src[end - 1] != '\\')) ++end;
        if (end >= src.size()) return false;
        // UNESCAPED, deliberately. The http mount hands the request BODY through
        // as a JSON string field, so the caller's own JSON arrives escaped one
        // level deep. Returning the raw slice would leave \" in place and every
        // subsequent key lookup would silently miss, which reads exactly like
        // "the caller sent nothing".
        *out = json_unescape(src.substr(at + 1, end - at - 1));
        return true;
    }
    int depth = 0;
    while (end < src.size()) {
        const char c = src[end];
        if (c == '[' || c == '{') ++depth;
        if (c == ']' || c == '}') {
            if (depth == 0) break;
            --depth;
        }
        if (c == ',' && depth == 0) break;
        ++end;
    }
    *out = src.substr(at, end - at);
    return true;
}

std::string json_string(const std::string& src, const std::string& key, const std::string& fallback) {
    std::string raw;
    if (!json_raw_field(src, key, &raw)) return fallback;
    return raw;
}

double json_number(const std::string& src, const std::string& key, double fallback) {
    std::string raw;
    if (!json_raw_field(src, key, &raw)) return fallback;
    if (raw.empty() || raw == "null") return fallback;
    return std::atof(raw.c_str());
}

// A JSON boolean. Anything that is not literally `true` is false, including a
// missing key — the FULL_POPULATION lane must be opted INTO explicitly, never
// inferred, because it lifts the caps that bound what an anonymous caller can
// make this node fetch and merge.
bool json_bool(const std::string& src, const std::string& key, bool fallback) {
    std::string raw;
    if (!json_raw_field(src, key, &raw)) return fallback;
    return raw == "true";
}

// Splits a JSON array of strings. Used for the PROVIDERS list.
std::vector<std::string> json_string_array(const std::string& src, const std::string& key) {
    std::vector<std::string> out;
    std::string raw;
    if (!json_raw_field(src, key, &raw)) return out;
    size_t i = 0;
    while (i < raw.size()) {
        if (raw[i] != '"') { ++i; continue; }
        size_t end = i + 1;
        while (end < raw.size() && !(raw[end] == '"' && raw[end - 1] != '\\')) ++end;
        if (end >= raw.size()) break;
        out.push_back(raw.substr(i + 1, end - i - 1));
        i = end + 1;
    }
    return out;
}

// ── provider registry (mirrors packages/cell-towers-worldwide/providers.json) ──
// Only the fields this module needs to FETCH and ATTRIBUTE. The full registry
// with terms/notes stays in the JS package; duplicating prose here would let
// the two drift. tests/registry-parity.test.mjs asserts the id set matches.
struct ProviderSpec {
    const char* id;
    const char* authority;
    const char* url;
    // Additional MIRRORS of the same service, fetched in the SAME run rather
    // than as retry-on-failure. A flow node is stateless per invocation, so
    // "try the next mirror" has nowhere to keep its place; issuing all of them
    // and keeping whatever answers is redundancy that needs no state. They are
    // ONE provider — same provider_id, counted once as consulted — and their
    // duplicate rows collapse in deconfliction like any other agreement.
    const char* mirrors[3];
    // How this provider's query string is assembled. "" = bare GET, "overpass"
    // = ?data=<program>, "soql" = ?$where=<filter>&$limit=<n>. The KIND decides
    // the escaping, so it is declared rather than inferred from the template:
    // an Overpass program and a SoQL filter need different encoding, and
    // guessing wrong returns 200 carrying an error page — which parses to zero
    // rows and is indistinguishable from a region that genuinely has none.
    const char* query_kind;
    // Query template. {{bbox}} substitutes south,west,north,east together;
    // {{south}} {{west}} {{north}} {{east}} {{limit}} substitute individually.
    const char* query_template;
    const char* format;       // "csv" | "osm-json" | "soql-json" | "swiss-geojson"
    const char* license;
    const char* license_url;
    const char* attribution;
    bool login_required;
    bool authoritative;       // administration/regulator register, not a crowd
    // HOW this provider can be reached, which decides whether a WORLDWIDE
    // request can include it at all:
    //   "bulk"        the endpoint serves its whole dataset in one file, so it
    //                 answers a worldwide request in full.
    //   "query"       the endpoint only answers a BOUNDED region. Included when
    //                 the caller names a box; skipped WITH A REASON when the
    //                 request is worldwide, because an unbounded query against
    //                 a public interpreter either times out or is simply rude.
    //   "unavailable" a real endpoint was found and verified live, but this
    //                 module cannot consume its payload yet (see `blocked_by`).
    //                 It is carried so the finding is not lost and so the
    //                 catalog can say WHY, and it is never fetched. Marking it
    //                 bulk-ingest-only is the honest alternative to compiling
    //                 in a URL that would parse to nothing.
    const char* lane;
    // For `lane == "unavailable"`: the capability that is missing, named in the
    // catalog and in the skip reason. Never a vague "unsupported".
    const char* blocked_by;
};

// clang-format off
constexpr ProviderSpec kProviders[] = {
  // ── OpenCelliD ────────────────────────────────────────────────────────────
  // The compiled-in `downloads.php` was a human download PAGE — the original
  // defect this task was filed for. The row endpoint below was verified live
  // against the owner's account on 2026-08-09 (200, `{"count":5,"cells":[...]}`)
  // and re-verified unauthenticated on 2026-08-10 (200 with
  // `{"error":"API Key not known","code":2}`, which proves the ROUTE is real).
  //
  // TWO TRAPS, both recorded because either one silently produces garbage:
  //  1. `BBOX` here is lat,lon,lat,lon — NOT the south,west,north,east this
  //     module uses everywhere else. They read identically for a square box and
  //     differently for every real one, so the template converts explicitly.
  //  2. The API's CSV header is NOT the bulk-export header `decode_csv` was
  //     written for. `column_of` accepts both spellings (see decode_csv).
  {"opencellid","OpenCelliD contributors","https://opencellid.org/cell/getInArea",
   {nullptr,nullptr,nullptr},
   "opencellid",
   "key={{credential}}&BBOX={{south}},{{west}},{{north}},{{east}}&format=csv&limit={{limit}}","csv",
   "CC BY-SA 4.0","https://wiki.opencellid.org/wiki/Menu_map_view","OpenCelliD Project",true,false,
   "query",nullptr},

  // ── OpenCelliD BULK export ────────────────────────────────────────────────
  // The whole register in one gzip: ~40 million CELLS, which this module
  // collapses to SITES as it decodes (decode_opencellid_bulk_gz). Storing the
  // cells is refused — at ~1.43 KB/site the per-cell form is ~57 GB.
  //
  // ROUTE VERIFIED LIVE, UNAUTHENTICATED, 2026-08-14 (the same proof technique
  // the row endpoint above carries, and the only one available without
  // spending the owner's daily quota):
  //   GET https://opencellid.org/ocid/downloads?token=INVALID&type=full
  //       &file=cell_towers.csv.gz
  //   -> 200, application/json, 44 bytes, {"status":"error","message":"INVALID_TOKEN"}
  // That proves the path, the parameter names and the token check are real.
  // The compiled-in `downloads.php` this task was filed against is, still, a
  // human HTML page (200, text/html, 14,729 bytes on the same date).
  //
  // ⚠ THE TRAP THIS PROBE EXPOSES: a bad token answers **200 with JSON**, not
  // 4xx. Handed to a gzip decoder that returns 200 and zero rows, an expired
  // token would read exactly like "the register is empty" — the failure this
  // registry exists to prevent. `detect_body_format` therefore refuses to let
  // a JSON body reach this provider's decoder, and the gzip magic check in
  // `gzip_header_length` is the second gate.
  //
  // STILL UNVERIFIED, and it needs the owner's token: the response SIZE, the
  // `accept-ranges` header, and whether the export is one gzip member or
  // several. The chunked lane below assumes single-member (see BulkResume) —
  // which is the SAFE assumption, because a multi-member file decodes correctly
  // under a single-member reader while the reverse silently truncates.
  {"opencellid-bulk","OpenCelliD contributors","https://opencellid.org/ocid/downloads",
   {nullptr,nullptr,nullptr},
   "opencellid-bulk",
   "token={{credential}}&type=full&file=cell_towers.csv.gz","csv-gz",
   "CC BY-SA 4.0","https://wiki.opencellid.org/wiki/Menu_map_view","OpenCelliD Project",true,false,
   "bulk",nullptr},

  // ── Mozilla Location Service, final full cell export ──────────────────────
  // THE PROVIDER THE WORLDWIDE INGEST LANE ACTUALLY RUNS, and the one whose
  // absence from this table made three host-02 runs land nothing in silence
  // (graph: sdn-cellular-ingest-lands-no-batch). The retriever's flow config
  // named a provider this table did not have; `find_provider` returned nullptr;
  // `parse` dropped the body.
  // A registry that cannot name the source an operator configured does not
  // prevent a wrong ingest — it produces an empty one that reports success.
  //
  // THE ID IS `mls-archive`, which is the id packages/cell-towers-worldwide
  // already published for this source. Two names for one provider is how a
  // registry and a catalog drift apart; the catalog's entry is updated with the
  // endpoint and licence verified here rather than a second id being minted.
  //
  // MLS was retired in 2024 and its register was published ONCE as a final
  // export. That is why the URL is an archive item and not a live service
  // endpoint: there is no newer copy to point at, and a dead upstream would be
  // the dishonest alternative. Verified live 2026-08-26: 302 -> 200,
  // 1,565,271,921 B, `Range: bytes=0-3145727` answers 206 with exactly
  // 3,145,728 B, and that chunk inflates to 9,749,556 B / 127,940 lines.
  //
  // The FORMAT is byte-identical to the OpenCelliD bulk export — verified
  // against the live header row, `radio,mcc,net,area,cell,unit,lon,lat,range,
  // samples,changeable,created,updated,averageSignal` — so it decodes through
  // `decode_opencellid_bulk_gz` with no new decoder. Sharing a decoder is NOT
  // sharing an identity: the rows are Mozilla's, published under a public
  // domain mark, and attributing them to OpenCelliD's CC BY-SA register would
  // put a licence and an authority on stored records that never asserted them.
  //
  // No login: the archive item is anonymously downloadable, which is what makes
  // this the worldwide lane that runs today while the OpenCelliD bulk route
  // waits on a credential.
  {"mls-archive","Mozilla Corporation",
   "https://archive.org/download/MLS_Full_Cell_Export_Final/MLS-full-cell-export-final.csv.gz",
   {nullptr,nullptr,nullptr},
   "","","csv-gz",
   "Public Domain Mark 1.0","https://creativecommons.org/publicdomain/mark/1.0/",
   "Mozilla Location Service contributors",false,false,
   "bulk",nullptr},

  // ── OpenStreetMap via Overpass ────────────────────────────────────────────
  // Bounded-region only: an unbounded Overpass program against a public
  // interpreter times out and is an abuse of a donated service. Three mirrors
  // are issued in the SAME run rather than as retry-on-failure, because a
  // stateless flow node has nowhere to remember where a retry got to; over one
  // session the main endpoint 504'd while a mirror answered 200, and later the
  // reverse.
  {"openstreetmap-overpass","OpenStreetMap contributors","https://overpass-api.de/api/interpreter",
   {"https://maps.mail.ru/osm/tools/overpass/api/interpreter","https://overpass.kumi.systems/api/interpreter",nullptr},
   "overpass",
   "[out:json][timeout:25];("
   "node[\"communication:mobile_phone\"]({{bbox}});"
   "node[\"tower:type\"=\"communication\"]({{bbox}});"
   "node[\"man_made\"=\"mast\"][\"communication:mobile_phone\"]({{bbox}});"
   ");out center {{limit}};","osm-json",
   "ODbL 1.0","https://www.openstreetmap.org/copyright","OpenStreetMap contributors",false,false,
   "query",nullptr},

  // ── FCC ULS 3650 MHz licensed base stations (United States) ───────────────
  // Verified live 2026-08-10: `?$limit=3` -> 200 application/json with real
  // rows; `$select=count(*)` -> 7,829 total, i.e. the WHOLE dataset is small
  // enough to serve a worldwide request in full through $limit/$offset. That is
  // why this is `bulk` and not `query`: the bbox filter is an optimisation, not
  // a requirement.
  //
  // TRAP: u_latitude/u_longitude are TEXT columns, so a numeric comparison must
  // cast (`::number`). Comparing them as text returns 200 and matches nothing —
  // exactly the failure this task exists to prevent.
  {"fcc-uls-3650","Federal Communications Commission","https://opendata.fcc.gov/resource/euz5-46g2.json",
   {nullptr,nullptr,nullptr},
   "soql",
   "u_latitude::number between {{south}} and {{north}}"
   " AND u_longitude::number between {{west}} and {{east}}"
   " AND u_yn_base_station='true'","soql-json",
   "Public domain (US Government work)","https://www.fcc.gov/","FCC Universal Licensing System (3650 MHz base stations)",false,true,
   "bulk",nullptr},

  // ── BAKOM mobile transmitter sites (Switzerland) ──────────────────────────
  // The ledger recorded this provider as unreachable via the geo.admin
  // `identify` endpoint ("No GeoTable was found"). That was the wrong lane AND
  // the wrong layer id. The STAC collection is
  // `ch.bakom.standorte-mobilfunkanlagen` (not `ch.bakom.mobil-antennenstandorte`,
  // which is only the FeatureCollection's internal `name`), and it publishes a
  // single national GeoJSON asset.
  //
  // Verified live 2026-08-10 by ranged GET: 206, `application/geo+json`,
  // 27,261,289 bytes, last-modified the previous day. A whole country in one
  // file, so it answers a worldwide request in full.
  //
  // The file is ordered as an ordinary FeatureCollection, and this module's
  // anonymous per-provider contract accepts at most 1,000 rows. A 2 MiB prefix
  // contains about 1,700 complete features (measured 2026-08-13), so fetching
  // the remaining 25 MiB cannot change THAT capped answer. Route therefore asks
  // for the prefix with Range on the anonymous lane, and the streaming decoder
  // below deliberately accepts the incomplete JSON tail after it has emitted the
  // bounded row set. Besides wasting bandwidth, the full document occasionally
  // pushed the buffered HTTP flow beyond Cloudflare's response deadline (live
  // 524 at 124 s), so the ingest lane also asks for a longer timeout.
  //
  // "Cannot change the answer" was true of the CAPPED answer and false of the
  // register: the prefix is a crop by DOCUMENT ORDER, which for a national
  // FeatureCollection is a geographic crop. Measured 2026-08-14 against the live
  // asset — 27,273,745 bytes, EXACTLY 22,347 features — the anonymous lane's
  // three caps (2 MiB Range, 1,000-row decode cap, LIMIT on emit) compounded to
  // ~364 sites at the live-probe's LIMIT=400. FULL_POPULATION lifts all three;
  // see the ingest-lane note in `route`.
  //
  // TRAP: coordinates are EPSG:2056 (Swiss LV95) EASTING/NORTHING in metres,
  // not degrees. Read as lat/lon they are silently out of range and every row
  // is dropped by the range guard — a provider that fetches perfectly and
  // contributes nothing. `decode_swiss_geojson` transforms them.
  {"bakom-mobile-sites","Bundesamt fuer Kommunikation",
   "https://data.geo.admin.ch/ch.bakom.standorte-mobilfunkanlagen/standorte-mobilfunkanlagen/standorte-mobilfunkanlagen_2056.json",
   {nullptr,nullptr,nullptr},
   "","","swiss-geojson",
   "opendata.swiss terms","https://opendata.swiss/en/terms-of-use","BAKOM mobile transmitter sites",false,true,
   "bulk",nullptr},

  // ── National bulk archives, UNLOCKED 2026-08-14 ───────────────────────────
  // These four were carried as `unavailable` because the module decoded only
  // CSV, Overpass JSON, SoQL JSON and the Swiss GeoJSON — no ZIP inflate and no
  // protobuf. `cell-tower-bulk-archive-adapters` added both: miniz 3.1.2 is
  // vendored (sha-pinned, MINIZ_NO_ARCHIVE_APIS, hand-walked central directory,
  // 32 KiB streaming window — see zip_find_member/zip_stream_lines) and the
  // ComReg wire shape was recovered from a live unauthenticated response.
  // Each was re-verified against the LIVE archive on 2026-08-14 and each has an
  // exact-count decode test over a captured slice.
  {"anfr-cartoradio","Agence nationale des frequences",
   "https://static.data.gouv.fr/resources/donnees-sur-les-installations-radioelectriques-de-plus-de-5-watts-1/20260702-135014/20260630-export-etalab-data.zip",
   {nullptr,nullptr,nullptr},
   "","","zip-anfr",
   "Licence Ouverte 2.0","https://www.etalab.gouv.fr/licence-ouverte-open-licence","ANFR Cartoradio",false,true,
   // Verified live 2026-08-14: 200, application/zip, 65,696,863 B, five
   // ';'-delimited tables. Positions come from SUP_SUPPORT.txt (198,524
   // supports, 18.6 MB inflated) through the four-column DMS conversion; the
   // 203 MB SUP_BANDE and 117 MB SUP_EMETTEUR members are never touched. No
   // operator name: the ADM_ID affectataire code has no name table in-archive.
   "bulk",nullptr},

  {"acma-rrl","Australian Communications and Media Authority","https://cdn.acma.gov.au/rrl/spectra_rrl.zip",
   {nullptr,nullptr,nullptr},
   "","","zip-acma",
   // CORRECTED 2026-08-10, RE-CONFIRMED FROM THE ARCHIVE 2026-08-14. This
   // registry declared CC BY 4.0; the LICENCE.TXT inside the live archive is
   // ACMA's own non-transferable licence-to-use with IP retained ("Intellectual
   // Property in the Register is retained by the ACMA"). An attribution string
   // that overstates the grant is a licence defect, not a cosmetic one —
   // $TBS.SOURCES carries it into republication.
   "ACMA Licence to Use the Register of Radiocommunications Licences",
   "https://www.acma.gov.au/","ACMA Register of Radiocommunications Licences",false,true,
   // Verified live 2026-08-14: 200, application/zip, 69,940,117 B, refreshed
   // daily, 31 members. site.csv (13.5 MB inflated) carries clean decimal
   // LATITUDE/LONGITUDE; the 383 MB device_details and 175 MB
   // applic_text_block members are never touched, which is also why no
   // licensee name is emitted (that join runs through device_details).
   "bulk",nullptr},

  {"ised-sms-tafl","Innovation, Science and Economic Development Canada",
   "https://www.ic.gc.ca/engineering/SMS_TAFL_Files/TAFL_LTAF.zip",
   {nullptr,nullptr,nullptr},
   "","","zip-ised",
   "Open Government Licence - Canada","https://open.canada.ca/en/open-government-licence-canada","ISED Spectrum Management System",false,true,
   // Verified live 2026-08-14: 200, application/zip, 64,197,105 B, ONE member
   // (TAFL_LTAF.csv) that inflates to 428,229,263 B — more than three times the
   // whole memory ceiling, so it is only ever streamed. Headerless/positional;
   // the ordinal map and the 99.5% province/coordinate corroboration that
   // establishes it are recorded at decode_ised_zip.
   "bulk",nullptr},

  {"comreg-siteviewer","Commission for Communications Regulation",
   "https://api-siteviewer.comreg.ie/mobile-masts/point",
   {nullptr,nullptr,nullptr},
   "post-json","{}","comreg-protobuf",
   "CC BY 4.0","https://creativecommons.org/licenses/by/4.0/","ComReg SiteViewer",false,true,
   // Verified live and UNAUTHENTICATED 2026-08-14: POST {} -> 200,
   // application/x-protobuf, 401,836 B carrying 9,646 masts (8,107
   // operator-named, 1,539 licence-referenced). No .proto is published; the
   // recovered wire shape and the negative-longitude trap are at
   // decode_comreg_protobuf.
   "bulk",nullptr},

  // ── WiGLE ─────────────────────────────────────────────────────────────────
  // Endpoint real (401 "Not Authorized (WiGLE.net)" proves the route). Kept as
  // credentialed and NOT default-selected. Note for whoever wires a key: WiGLE's
  // terms restrict bulk redistribution, so this is not a grab-and-republish
  // source even once authenticated, and $TBS.SOURCES would carry that
  // obligation onward.
  {"wigle","WiGLE.net contributors","https://api.wigle.net/api/v2/cell/search",
   {nullptr,nullptr,nullptr},
   "","","json",
   "WiGLE terms of use","https://wigle.net/tos","WiGLE.net",true,false,
   "query",nullptr},
};

// REMOVED 2026-08-10, each with a live measurement rather than an assumption.
// An honest smaller list beats twelve dead ones — the whole point of this task.
//
//   bnetza-emf         the EMF database is serving a maintenance page;
//                      datenportal.bundesnetzagentur.de times out; the only
//                      govdata.de hit is one municipal dataset, not a national
//                      register. No successful data fetch by any route.
//   nl-antenneregister the official viewer ships
//                      "PUBLIC_EXPORT_DATA_ENABLED":"false" in its own config,
//                      and every PDOK/WFS and own-domain API probe 404s.
//   nz-rsm-rrf         both the CSV export and the bulk Data Extracts are
//                      documented as requiring an APPROVED RSM account, and the
//                      data.govt.nz catalogue is behind a bot challenge.
//   mls-archive        Mozilla Location Service is shut down; the CloudFront
//                      host does not resolve (dig @8.8.8.8 returns nothing).
//                      A 2019 Wayback capture confirms it was once live.

constexpr size_t kProviderCount = sizeof(kProviders) / sizeof(kProviders[0]);

const ProviderSpec* find_provider(const std::string& id) {
    for (size_t i = 0; i < kProviderCount; ++i) {
        if (id == kProviders[i].id) return &kProviders[i];
    }
    return nullptr;
}

// ── normalized report ──────────────────────────────────────────────────────
struct Report {
    std::string provider_id;
    std::string native_id;
    int8_t radio = RC_UNKNOWN;
    long mcc = -1, mnc = -1, lac = -1, tac = -1;
    std::string cell_id;
    double latitude = 0, longitude = 0;
    double range_m = -1;
    long samples = -1;
    double average_signal_dbm = 0;
    bool has_signal = false;
    long long observed_at = -1;   // epoch seconds
    std::string site_name;
    std::string operator_name;
    std::string country_code;
};

int8_t radio_from_text(const std::string& raw) {
    std::string v;
    for (char c : raw) v += static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    if (v == "GSM" || v == "2G") return RC_GSM;
    if (v == "CDMA") return RC_CDMA;
    if (v == "UMTS" || v == "3G" || v == "WCDMA") return RC_UMTS;
    if (v == "LTE" || v == "4G") return RC_LTE;
    if (v == "NR" || v == "5G" || v == "NR5G") return RC_NR;
    if (v.empty()) return RC_UNKNOWN;
    return RC_OTHER;
}

// RETRIEVED_AT / MERGED_AT. Read from the host clock through the standard
// wasi clock, not invented: a provenance timestamp that is not a real time is
// worse than an absent one, because it looks authoritative.
std::string iso_now() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return std::string();
    const time_t secs = static_cast<time_t>(tv.tv_sec);
    struct tm utc;
    if (gmtime_r(&secs, &utc) == nullptr) return std::string();
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.000Z", utc.tm_year + 1900,
                  utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec);
    return std::string(buf);
}

double haversine_m(double lat1, double lon1, double lat2, double lon2) {
    const double to_rad = 3.14159265358979323846 / 180.0;
    const double dlat = (lat2 - lat1) * to_rad;
    const double dlon = (lon2 - lon1) * to_rad;
    const double a = std::sin(dlat / 2) * std::sin(dlat / 2) +
                     std::cos(lat1 * to_rad) * std::cos(lat2 * to_rad) *
                         std::sin(dlon / 2) * std::sin(dlon / 2);
    return 2 * kEarthRadiusM * std::asin(std::min(1.0, std::sqrt(a)));
}

// ── ZIP member access (stored + deflate), STREAMING ────────────────────────
//
// Four national registers publish as one ZIP each. They are NOT small, and the
// numbers are why every byte below is streamed rather than extracted:
//
//   archive          compressed   the member we want   the members we must NOT touch
//   acma-rrl          69,940,117   site.csv  13.5 MB   device_details.csv 383 MB,
//                                                      applic_text_block.csv 175 MB
//   ised-sms-tafl     64,197,105   TAFL_LTAF.csv 428 MB (the only member)
//   anfr-cartoradio   65,696,863   SUP_SUPPORT.txt 18.6 MB  SUP_BANDE.txt 203 MB,
//                                                      SUP_EMETTEUR.txt 117 MB
//
// The compressed body is ALREADY resident as `payload` when these run, inside
// the flow's 128 MB linear-memory ceiling (see decode_raw_http_response). So
// `mz_zip_reader_extract_*` is not merely wasteful here, it is impossible:
// extracting ISED's single member alone asks for 428 MB. Every decoder below
// therefore inflates through a fixed 32 KiB window and is handed ONE LINE AT A
// TIME, and selects its member by name so the giant siblings are never touched.
//
// miniz is vendored at vendor/miniz-3.1.2 and compiled with
// MINIZ_NO_ARCHIVE_APIS (see miniz-source.mjs), which removes mz_zip_* — the
// central directory is therefore walked by hand below. tinfl_* survives that
// define (it is gated by MINIZ_NO_INFLATE_APIS, which is NOT set).

struct ZipEntry {
    size_t data_offset = 0;      // offset of the member's compressed bytes
    uint32_t compressed_size = 0;
    uint32_t uncompressed_size = 0;
    uint16_t method = 0;         // 0 = stored, 8 = deflate
    bool found = false;
};

uint16_t le16(const std::string& b, size_t at) {
    return static_cast<uint16_t>(static_cast<uint8_t>(b[at])) |
           (static_cast<uint16_t>(static_cast<uint8_t>(b[at + 1])) << 8);
}

uint32_t le32(const std::string& b, size_t at) {
    return static_cast<uint32_t>(static_cast<uint8_t>(b[at])) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 1])) << 8) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 2])) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(b[at + 3])) << 24);
}

// Locate one member by exact name through the CENTRAL DIRECTORY.
//
// The central directory is the authority for the sizes, never the local header:
// a ZIP written with a data descriptor (general-purpose flag bit 3) carries
// zeroes for both sizes in the local header, and reading those would inflate
// zero bytes and report an empty register — the parse-to-nothing failure this
// module's whole provider registry exists to prevent. The three live archives
// were checked on 2026-08-14 and use flags=0/method=8 throughout, but the code
// does not depend on that holding.
ZipEntry zip_find_member(const std::string& body, const char* want) {
    ZipEntry e;
    if (body.size() < 22) return e;
    // End of central directory: scan backwards over the permitted 64 KiB
    // comment. Searching FORWARD for the signature is wrong — the bytes
    // "PK\x05\x06" can occur inside compressed data.
    const size_t floor_at = body.size() > 66000 ? body.size() - 66000 : 0;
    size_t eocd = std::string::npos;
    for (size_t i = body.size() - 22 + 1; i-- > floor_at;) {
        if (body[i] == 'P' && body[i + 1] == 'K' &&
            static_cast<uint8_t>(body[i + 2]) == 0x05 &&
            static_cast<uint8_t>(body[i + 3]) == 0x06) {
            eocd = i;
            break;
        }
    }
    if (eocd == std::string::npos || eocd + 22 > body.size()) return e;

    const uint16_t entries = le16(body, eocd + 10);
    const uint32_t cd_offset = le32(body, eocd + 16);
    if (cd_offset == 0xFFFFFFFFu) return e;  // ZIP64: refused, never guessed
    size_t p = cd_offset;

    for (uint16_t n = 0; n < entries; ++n) {
        if (p + 46 > body.size()) return e;
        if (!(body[p] == 'P' && body[p + 1] == 'K' &&
              static_cast<uint8_t>(body[p + 2]) == 0x01 &&
              static_cast<uint8_t>(body[p + 3]) == 0x02)) {
            return e;
        }
        const uint16_t flags = le16(body, p + 8);
        const uint16_t method = le16(body, p + 10);
        const uint32_t csize = le32(body, p + 20);
        const uint32_t usize = le32(body, p + 24);
        const uint16_t name_len = le16(body, p + 28);
        const uint16_t extra_len = le16(body, p + 30);
        const uint16_t comment_len = le16(body, p + 32);
        const uint32_t local_at = le32(body, p + 42);
        if (p + 46 + name_len > body.size()) return e;
        const std::string name = body.substr(p + 46, name_len);
        p += 46u + name_len + extra_len + comment_len;

        if (name != want) continue;
        // Encrypted (bit 0) is refused rather than decoded into noise.
        if (flags & 0x0001) return e;
        if (csize == 0xFFFFFFFFu || usize == 0xFFFFFFFFu ||
            local_at == 0xFFFFFFFFu) {
            return e;  // ZIP64 member
        }
        if (method != 0 && method != 8) return e;
        // The LOCAL header is read only for its own name/extra lengths, which
        // are permitted to differ from the central directory's.
        if (local_at + 30 > body.size()) return e;
        if (!(body[local_at] == 'P' && body[local_at + 1] == 'K' &&
              static_cast<uint8_t>(body[local_at + 2]) == 0x03 &&
              static_cast<uint8_t>(body[local_at + 3]) == 0x04)) {
            return e;
        }
        const uint16_t l_name = le16(body, local_at + 26);
        const uint16_t l_extra = le16(body, local_at + 28);
        const size_t data_at = local_at + 30u + l_name + l_extra;
        if (data_at + csize > body.size()) return e;
        e.data_offset = data_at;
        e.compressed_size = csize;
        e.uncompressed_size = usize;
        e.method = method;
        e.found = true;
        return e;
    }
    return e;
}

// ── Streaming deflate -> lines, RESUMABLE ──────────────────────────────────
//
// Inflate a raw deflate stream and hand the caller ONE LINE AT A TIME.
//
// `on_line(line)` returns false to stop early, which is what makes a capped
// request cheap: the anonymous lane's 1,000-row bound stops after a few hundred
// KiB of a 428 MB member instead of inflating all of it.
//
// The output window is exactly TINFL_LZ_DICT_SIZE and WRAPS — that is the
// contract for tinfl's non-TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF mode, and
// it is the entire reason a 428 MB member costs 32 KiB of memory here. The only
// unbounded accumulation is `pending`, one line.
//
// WHY THIS IS A STRUCT AND NOT A FUNCTION (mod-cell-tower-opencellid-bulk).
// The four ZIP members arrive whole, so a single call sufficed. The OpenCelliD
// bulk gzip does NOT: it is fetched as a sequence of byte ranges across
// SEPARATE flow invocations, and a flow node keeps nothing between them. A raw
// deflate stream cannot be restarted at an arbitrary offset — there is no
// sync point and the back-references reach up to 32 KiB behind — so resuming
// means carrying the decoder's state forward explicitly. Everything needed for
// that is here and is POD or a byte buffer: `tinfl_decompressor` contains no
// pointers (miniz.h:1037-1043, counters + tables + `m_raw_header`/`m_len_codes`
// arrays), the 32 KiB window IS the dictionary, and `pending` is the partial
// line straddling the chunk boundary. See `BulkResume`.
struct DeflateLineStream {
    tinfl_decompressor* inflator = nullptr;
    std::vector<uint8_t> window;
    size_t out_pos = 0;   // write cursor inside the wrapping window
    std::string pending;  // bytes of the line currently being assembled
    bool ok = true;
    bool done = false;     // the stream reached its natural end
    bool stopped = false;  // on_line asked to stop

    DeflateLineStream() : window(TINFL_LZ_DICT_SIZE, 0) {
        // tinfl_decompressor is ~11 KiB; it is heap-allocated rather than placed
        // on the guest stack, which is small in this thread model.
        inflator = tinfl_decompressor_alloc();
        if (inflator) tinfl_init(inflator);
        else ok = false;
    }
    ~DeflateLineStream() { if (inflator) tinfl_decompressor_free(inflator); }
    DeflateLineStream(const DeflateLineStream&) = delete;
    DeflateLineStream& operator=(const DeflateLineStream&) = delete;

    // Feed one compressed span. `more_after` says whether further bytes of this
    // SAME deflate stream will arrive in a later call — it is the difference
    // between "input exhausted for now" and "input exhausted for good", and
    // getting it wrong makes tinfl declare a truncated stream corrupt.
    // Returns the number of input bytes consumed.
    template <typename OnLine>
    size_t feed(const uint8_t* data, size_t size, bool more_after, OnLine on_line) {
        if (!ok || done || stopped || !inflator) return 0;
        size_t in_pos = 0;
        for (;;) {
            size_t in_avail = size - in_pos;
            size_t out_avail = TINFL_LZ_DICT_SIZE - out_pos;
            mz_uint32 flags = 0;
            if (in_avail || more_after) flags |= TINFL_FLAG_HAS_MORE_INPUT;
            const tinfl_status status =
                tinfl_decompress(inflator, reinterpret_cast<const mz_uint8*>(data + in_pos),
                                 &in_avail, window.data(), window.data() + out_pos, &out_avail,
                                 flags);
            in_pos += in_avail;

            // Split whatever this pass produced into lines.
            for (size_t i = 0; i < out_avail && !stopped; ++i) {
                const char c = static_cast<char>(window[out_pos + i]);
                if (c == '\n') {
                    if (!pending.empty() && pending[pending.size() - 1] == '\r') {
                        pending.resize(pending.size() - 1);
                    }
                    if (!pending.empty() && !on_line(pending)) stopped = true;
                    pending.clear();
                } else {
                    pending += c;
                }
            }
            out_pos = (out_pos + out_avail) & (TINFL_LZ_DICT_SIZE - 1);

            if (stopped) break;
            if (status == TINFL_STATUS_DONE) {
                // The last line of a file with no trailing newline.
                if (!pending.empty()) {
                    if (pending[pending.size() - 1] == '\r') pending.resize(pending.size() - 1);
                    if (!pending.empty()) on_line(pending);
                    pending.clear();
                }
                done = true;
                break;
            }
            if (status < TINFL_STATUS_DONE) { ok = false; break; }  // corrupt input
            // NEEDS_MORE_INPUT with nothing left to give: this span is spent and
            // the caller will bring the next one.
            if (status == TINFL_STATUS_NEEDS_MORE_INPUT && in_pos >= size) break;
            if (in_pos >= size && out_avail == 0 && status == TINFL_STATUS_HAS_MORE_OUTPUT) continue;
            if (in_pos >= size && status != TINFL_STATUS_HAS_MORE_OUTPUT) break;
        }
        return in_pos;
    }
};

// Inflate a ZIP member and hand the caller ONE LINE AT A TIME. The member is
// resident whole, so this is one `feed` with `more_after = false`.
template <typename OnLine>
bool zip_stream_lines(const std::string& body, const ZipEntry& entry, OnLine on_line) {
    if (!entry.found) return false;

    if (entry.method == 0) {  // stored
        const char* base = body.data() + entry.data_offset;
        size_t start = 0;
        for (size_t i = 0; i <= entry.compressed_size; ++i) {
            if (i == entry.compressed_size || base[i] == '\n') {
                if (i > start || i != entry.compressed_size) {
                    std::string line(base + start, i - start);
                    if (!line.empty() && line[line.size() - 1] == '\r') line.resize(line.size() - 1);
                    if (!line.empty() && !on_line(line)) return true;
                }
                start = i + 1;
            }
        }
        return true;
    }

    DeflateLineStream stream;
    stream.feed(reinterpret_cast<const uint8_t*>(body.data() + entry.data_offset),
                entry.compressed_size, false, on_line);
    return stream.ok;
}

// ── gzip ───────────────────────────────────────────────────────────────────
//
// A gzip member is a 10-byte fixed header, optional variable fields, then RAW
// DEFLATE — which is why the tinfl streamer above is reused verbatim rather
// than a second inflate implementation being vendored. miniz's `tinfl_*`
// speaks raw deflate (and zlib, with a flag); it does NOT skip a gzip header,
// so that is done here. Feeding a gzip stream straight to tinfl produces
// TINFL_STATUS_FAILED on the first call — a whole register decoding to zero
// rows, which is the failure this module's registry exists to prevent.
//
// Returns the header length, or 0 if this is not a gzip member this module
// will decode. Never guesses: an unknown compression method is refused rather
// than fed to the deflate decoder.
size_t gzip_header_length(const uint8_t* data, size_t size) {
    if (size < 10) return 0;
    if (data[0] != 0x1F || data[1] != 0x8B) return 0;
    if (data[2] != 8) return 0;  // CM: only deflate is defined
    const uint8_t flg = data[3];
    if (flg & 0xE0) return 0;    // reserved bits set: not a gzip we understand
    size_t at = 10;
    if (flg & 0x04) {            // FEXTRA
        if (at + 2 > size) return 0;
        const size_t xlen = static_cast<size_t>(data[at]) | (static_cast<size_t>(data[at + 1]) << 8);
        at += 2 + xlen;
    }
    if (flg & 0x08) {            // FNAME, NUL-terminated
        while (at < size && data[at] != 0) ++at;
        if (at >= size) return 0;
        ++at;
    }
    if (flg & 0x10) {            // FCOMMENT, NUL-terminated
        while (at < size && data[at] != 0) ++at;
        if (at >= size) return 0;
        ++at;
    }
    if (flg & 0x02) at += 2;     // FHCRC
    return at <= size ? at : 0;
}

// ── THE BULK RESUME MARK ───────────────────────────────────────────────────
//
// The OpenCelliD bulk export is ONE gzip member of roughly 40 million cells.
// It cannot be fetched in one response — the flow's linear memory ceiling is
// 128 MB (see decode_raw_http_response) — so it is fetched as a sequence of
// byte RANGES across separate invocations, and this is the state that travels
// between them, in the JOB, exactly like `request_providers` does.
//
// WHY THE STATE IS THE WHOLE DECODER AND NOT JUST AN OFFSET. A raw deflate
// stream has no restart point. Huffman codes are bit-packed across byte
// boundaries, and a back-reference may reach 32 KiB behind the cursor, so byte
// N of the compressed stream is meaningless without everything that preceded
// it. Two alternatives were considered and rejected:
//
//   - Re-fetch `bytes=0-N` each time and skip the lines already emitted. This
//     is correct but quadratic: a 32-chunk file inflates its own prefix 32
//     times and re-downloads it too. On a ~2 GB export that is not a cost, it
//     is a refusal to finish.
//   - Assume the export is a MULTI-MEMBER gzip whose members can be decoded
//     independently. Nothing published says it is, and being wrong produces
//     zero rows silently. This module does not guess about a wire format.
//
// So the decoder state is carried. It is safe to memcpy because
// `tinfl_decompressor` holds no pointers (miniz.h:1037-1043), and the 32 KiB
// window IS the LZ dictionary the back-references need. `pending` is the CSV
// line straddling the chunk boundary, which is the other thing a naive
// byte-range split silently corrupts: half a row at each seam, parsed as a row.
//
// The mark is version-and-size stamped and a mismatch RESTARTS the download
// rather than resuming into a differently-shaped struct. A rebuilt module is
// exactly when that would otherwise go wrong.
// The stamps the $IRM resume mark carries (IRMDecodeContext). cell-tower-ingest
// writes the same literals: it forwards the decode context of a stored mark only
// when DECODER_STATE_FORMAT is this one.
constexpr const char* kDecoderStateFormat = "cell-tower-source/tinfl-v1";
constexpr const char* kDecoderStateVersion = "1";
constexpr const char* kDecoderStateMediaType = "application/octet-stream";
constexpr const char* kDecoderBuildId = "miniz-3.1.2";

struct BulkResume {
    bool valid = false;
    bool header_done = false;   // the gzip header has been consumed
    uint64_t next_byte = 0;     // next COMPRESSED byte to request (absolute)
    uint64_t rows_seen = 0;     // CSV data rows decoded in THIS chunk
    uint64_t sites_emitted = 0; // sites emitted in THIS chunk
    bool complete = false;      // the deflate stream reached its end
    // The decoder at the seam, as the $IRM carries it: DECODER_STATE (the raw
    // tinfl_decompressor), WINDOW (the 32 KiB dictionary), WINDOW_POSITION and
    // PARTIAL_RECORD (the line straddling the seam). Empty = not resumable.
    std::string state;
    std::string window;
    uint32_t window_pos = 0;
    std::string pending;
    // The stamps as read off an incoming mark (validated by bulk_state_decode).
    std::string state_format;
    std::string state_version;
    uint64_t state_byte_length = 0;
    uint64_t window_byte_length = 0;
};

// Capture the decoder half of the mark.
void bulk_state_encode(const DeflateLineStream& s, BulkResume* r) {
    r->state.assign(reinterpret_cast<const char*>(s.inflator), sizeof(tinfl_decompressor));
    r->window.assign(reinterpret_cast<const char*>(s.window.data()), TINFL_LZ_DICT_SIZE);
    r->window_pos = static_cast<uint32_t>(s.out_pos);
    r->pending = s.pending;
    r->state_format = kDecoderStateFormat;
    r->state_version = kDecoderStateVersion;
    r->state_byte_length = sizeof(tinfl_decompressor);
    r->window_byte_length = TINFL_LZ_DICT_SIZE;
}

void bulk_state_clear(BulkResume* r) {
    r->state.clear();
    r->window.clear();
    r->window_pos = 0;
    r->pending.clear();
}

// Restore a decoder from a mark. Returns false — meaning RESTART, never
// "resume anyway" — on any format, version, size or length disagreement.
bool bulk_state_decode(const BulkResume& r, DeflateLineStream* s) {
    if (!s || !s->inflator || r.state.empty()) return false;
    if (r.state_format != kDecoderStateFormat || r.state_version != kDecoderStateVersion) return false;
    if (r.state_byte_length != sizeof(tinfl_decompressor) || r.state.size() != sizeof(tinfl_decompressor)) return false;
    if (r.window_byte_length != TINFL_LZ_DICT_SIZE || r.window.size() != TINFL_LZ_DICT_SIZE) return false;
    if (r.window_pos >= TINFL_LZ_DICT_SIZE) return false;
    std::memcpy(s->inflator, r.state.data(), sizeof(tinfl_decompressor));
    std::memcpy(s->window.data(), r.window.data(), TINFL_LZ_DICT_SIZE);
    s->out_pos = r.window_pos;
    s->pending = r.pending;
    return true;
}


// Split a ';'-delimited line (ANFR). Kept separate from split_csv_line rather
// than parameterised: the ANFR exports are not RFC4180 and do not quote, so
// treating '"' as a quote character there would swallow real content.
std::vector<std::string> split_semicolon_line(const std::string& line) {
    std::vector<std::string> cells;
    std::string cur;
    for (size_t i = 0; i < line.size(); ++i) {
        const char c = line[i];
        if (c == ';') { cells.push_back(cur); cur.clear(); }
        else if (c != '\r') cur += c;
    }
    cells.push_back(cur);
    return cells;
}

// ── CSV decoding (the OpenCelliD/MLS column contract) ──────────────────────
std::vector<std::string> split_csv_line(const std::string& line) {
    std::vector<std::string> cells;
    std::string cur;
    bool quoted = false;
    for (size_t i = 0; i < line.size(); ++i) {
        const char c = line[i];
        if (quoted) {
            if (c == '"' && i + 1 < line.size() && line[i + 1] == '"') { cur += '"'; ++i; }
            else if (c == '"') quoted = false;
            else cur += c;
        } else if (c == '"') {
            quoted = true;
        } else if (c == ',') {
            cells.push_back(cur);
            cur.clear();
        } else if (c != '\r') {
            cur += c;
        }
    }
    cells.push_back(cur);
    return cells;
}

int column_of(const std::vector<std::string>& header, const char* name) {
    for (size_t i = 0; i < header.size(); ++i) {
        if (header[i] == name) return static_cast<int>(i);
    }
    return -1;
}

// The same column under EITHER of two spellings.
//
// OpenCelliD publishes TWO different CSV contracts and they disagree on five of
// nine identity columns. The BULK export (which `decode_csv` was written for)
// says `net, area, cell, averageSignal`; the getInArea API says
// `mnc, lac, cellid, averageSignalStrength`, and has no `updated` at all.
//
// This matters more than a rename: fed the API's CSV, the bulk spellings all
// miss, and the rows still parse — 200, real coordinates, no error — as towers
// with EMPTY mcc/mnc/lac/cell_id. That silently breaks deconfliction (identity
// is what groups reports across providers) and `native_id`. A tower with no
// identity is worse than a missing tower, because it looks like data.
int column_of_either(const std::vector<std::string>& header, const char* a, const char* b) {
    const int at = column_of(header, a);
    return at >= 0 ? at : column_of(header, b);
}

// THE HEADER OF A CHUNK THAT HAS NO HEADER.
//
// A ranged bulk fetch puts the CSV header row in chunk 0 and NOWHERE ELSE. Read
// without one, this decoder consumes the first DATA row of chunk N>0 as the
// column contract and then measures every later row against it: `lat`/`lon`
// miss, the function returns having emitted nothing, and a headerless chunk is
// byte-for-byte indistinguishable from a clean tail. That is the "second gap"
// of `mod-cell-tower-ingest-flow`, and it is why a multi-chunk row ingest could
// not be attempted before the durable mark existed to carry the header forward.
//
// `injected_header` is that carried header. When it is present EVERY line of
// the body is a data row — including the first, which would otherwise be eaten.
// When it is empty the behaviour is exactly what it always was, so chunk 0 and
// every single-shot request path are untouched.
void decode_csv(const ProviderSpec& spec, const std::string& body, std::vector<Report>* out,
                const std::string& injected_header = std::string()) {
    size_t pos = 0, line_no = 0;
    std::vector<std::string> header;
    if (!injected_header.empty()) {
        header = split_csv_line(injected_header);
        line_no = 1;  // the header slot is already filled; no line is consumed for it
    }
    while (pos < body.size()) {
        size_t nl = body.find('\n', pos);
        if (nl == std::string::npos) nl = body.size();
        const std::string line = body.substr(pos, nl - pos);
        pos = nl + 1;
        if (line.empty()) continue;
        const std::vector<std::string> cells = split_csv_line(line);
        if (line_no++ == 0) { header = cells; continue; }

        const int c_lat = column_of(header, "lat");
        const int c_lon = column_of(header, "lon");
        if (c_lat < 0 || c_lon < 0) return;  // not the expected contract; emit nothing
        if (c_lat >= static_cast<int>(cells.size()) || c_lon >= static_cast<int>(cells.size())) continue;

        Report r;
        r.provider_id = spec.id;
        r.latitude = std::atof(cells[c_lat].c_str());
        r.longitude = std::atof(cells[c_lon].c_str());
        // A row whose coordinates are out of range is DROPPED, not clamped: a
        // clamped tower is a tower in the wrong place, silently.
        if (r.latitude < -90 || r.latitude > 90 || r.longitude < -180 || r.longitude > 180) continue;

        // Both OpenCelliD contracts. See column_of_either.
        const int c_radio = column_of(header, "radio");
        const int c_mcc = column_of(header, "mcc");
        const int c_net = column_of_either(header, "net", "mnc");
        const int c_area = column_of_either(header, "area", "lac");
        const int c_cell = column_of_either(header, "cell", "cellid");
        const int c_range = column_of(header, "range");
        const int c_samples = column_of(header, "samples");
        const int c_updated = column_of(header, "updated");
        const int c_signal =
            column_of_either(header, "averageSignal", "averageSignalStrength");

        auto cell_at = [&](int idx) -> std::string {
            return (idx >= 0 && idx < static_cast<int>(cells.size())) ? cells[idx] : std::string();
        };
        r.radio = radio_from_text(cell_at(c_radio));
        if (!cell_at(c_mcc).empty()) r.mcc = std::atol(cell_at(c_mcc).c_str());
        if (!cell_at(c_net).empty()) r.mnc = std::atol(cell_at(c_net).c_str());
        if (!cell_at(c_area).empty()) r.lac = std::atol(cell_at(c_area).c_str());
        r.cell_id = cell_at(c_cell);
        if (!cell_at(c_range).empty()) r.range_m = std::atof(cell_at(c_range).c_str());
        if (!cell_at(c_samples).empty()) r.samples = std::atol(cell_at(c_samples).c_str());
        if (!cell_at(c_updated).empty()) r.observed_at = std::atoll(cell_at(c_updated).c_str());
        if (!cell_at(c_signal).empty()) {
            r.average_signal_dbm = std::atof(cell_at(c_signal).c_str());
            r.has_signal = true;
        }
        r.native_id = r.cell_id;
        out->push_back(r);
    }
}

// ── The OpenCelliD BULK export: CELLS IN, SITES OUT ────────────────────────
//
// The bulk export is roughly 40 million CELLS. This module does not store them
// and must not: at ~1.43 KB per stored site the per-cell form is ~57 GB, which
// the owning task refuses outright. A cell is not a thing in the world anyway —
// a mast carrying three sectors on two radios publishes six cells at one
// place, and six towers at one place is worse than one tower, because it looks
// like data.
//
// So the decode collapses to SITES as it streams, and the collapse happens
// HERE rather than downstream for a memory reason: emitting 40 M Reports to let
// deconflict merge them would need the 57 GB this exists to avoid.
//
// THE KEY is rounded position plus the identity that distinguishes co-located
// operators:
//
//   round(lat, 3), round(lon, 3)   ~111 m — one mast, not one sector. Sector
//                                  centroids in this dataset are trilaterated
//                                  per cell and scatter by tens of metres
//                                  around the structure, so a tighter round
//                                  (1e-4, ~11 m) leaves the same mast as three
//                                  sites and a looser one (1e-2, ~1.1 km) eats
//                                  genuinely distinct urban masts.
//   radio                          GSM/UMTS/LTE/NR at one mast are one site,
//                                  but they are kept apart in the key because
//                                  the record carries a radio and a merged one
//                                  would have to invent which.
//   mcc, net                       two operators sharing a tower are two sites
//                                  with two operators, never one averaged one.
//
// WITHIN a key the winner is the highest `samples` — the same rule the
// HIGHEST_SAMPLE_COUNT deconfliction method uses, so the site this emits is the
// one that method would have chosen anyway. `samples` is SUMMED across the
// collapsed cells, because the mast really was observed that many times, and
// `range_m` takes the widest cell: a site's footprint is the union of its
// sectors', never the narrowest.
//
// PER-CHUNK, DELIBERATELY. The collapse map lives for one chunk and is not
// carried in the resume mark: carrying it would mean holding a key per site for
// the whole 40 M-cell stream, which is the unbounded state this design exists
// to avoid. Sites that straddle a chunk seam therefore arrive as two Reports
// with the same identity — which is exactly what `deconflict` already merges
// across providers. The bounded thing is done here; the global thing is done
// where a global pass already happens.
constexpr double kSiteGridDegrees = 1000.0;  // 3 decimal places

struct SiteAccumulator {
    Report report;
    long samples_total = 0;
    long best_samples = -1;
};

std::string site_key(const Report& r) {
    char buf[96];
    std::snprintf(buf, sizeof(buf), "%lld:%lld:%d:%ld:%ld",
                  static_cast<long long>(std::llround(r.latitude * kSiteGridDegrees)),
                  static_cast<long long>(std::llround(r.longitude * kSiteGridDegrees)),
                  static_cast<int>(r.radio), r.mcc, r.mnc);
    return buf;
}

// Decode ONE CHUNK of the bulk gzip. `resume` is read for the decoder state and
// written with the state the NEXT chunk needs. Returns false only on a stream
// this module cannot decode — never on "the chunk ended", which is the normal
// case and is what `resume->complete == false` means.
bool decode_opencellid_bulk_gz(const ProviderSpec& spec, const std::string& body, size_t row_cap,
                               BulkResume* resume, std::vector<Report>* out, bool* hit_cap) {
    if (!resume) return false;

    DeflateLineStream stream;
    if (!stream.ok) return false;

    const uint8_t* data = reinterpret_cast<const uint8_t*>(body.data());
    size_t size = body.size();

    // Is this a CONTINUATION? Read before `header_done` is set below, because
    // it is also the answer to "has the CSV header row already gone past?".
    // Deriving that from `rows_seen > 0` instead would be wrong for a first
    // chunk that ended after the header and before any data row: the next
    // chunk would then eat a real row as a header. A 32 MiB window makes that
    // impossible in practice, which is exactly why it would never be found.
    const bool resuming = resume->header_done;

    if (resume->header_done) {
        // Mid-stream. A mark this build cannot read means RESTART, announced by
        // leaving next_byte at 0, never a resume into a foreign struct.
        if (!bulk_state_decode(*resume, &stream)) {
            resume->valid = false;
            resume->next_byte = 0;
            resume->header_done = false;
            bulk_state_clear(resume);
            return false;
        }
    } else {
        const size_t header = gzip_header_length(data, size);
        if (header == 0) return false;  // not a gzip this module decodes
        data += header;
        size -= header;
        resume->header_done = true;
    }

    // The collapse map for THIS chunk only. See the note above.
    std::map<std::string, SiteAccumulator> sites;
    std::vector<std::string> order;  // emission order = first sighting, stable
    std::vector<std::string> header_cells;
    bool header_seen = resuming;  // a later chunk has no header row
    bool capped = false;

    const size_t header_bytes = body.size() - size;  // 0 on a resumed chunk
    const size_t consumed = stream.feed(data, size, true, [&](const std::string& line) -> bool {
        if (line.empty()) return true;
        const std::vector<std::string> cells = split_csv_line(line);
        if (!header_seen) {
            header_cells = cells;
            header_seen = true;
            return true;
        }
        // A resumed chunk never saw the header row, so the column contract is
        // the bulk export's, which is fixed and documented. It is asserted
        // rather than assumed on the FIRST chunk (where the header IS present)
        // and reconstructed on later ones.
        if (header_cells.empty()) {
            header_cells = {"radio", "mcc",     "net",     "area",    "cell", "unit",         "lon",
                            "lat",   "range",   "samples", "changeable", "created", "updated",
                            "averageSignal"};
        }
        const int c_lat = column_of(header_cells, "lat");
        const int c_lon = column_of(header_cells, "lon");
        if (c_lat < 0 || c_lon < 0) return false;  // not the expected contract
        if (c_lat >= static_cast<int>(cells.size()) || c_lon >= static_cast<int>(cells.size())) {
            return true;
        }

        Report r;
        r.provider_id = spec.id;
        r.latitude = std::atof(cells[c_lat].c_str());
        r.longitude = std::atof(cells[c_lon].c_str());
        // Out of range is DROPPED, not clamped: a clamped tower is a tower in
        // the wrong place, silently.
        if (r.latitude < -90 || r.latitude > 90 || r.longitude < -180 || r.longitude > 180) {
            return true;
        }
        auto cell_at = [&](int idx) -> std::string {
            return (idx >= 0 && idx < static_cast<int>(cells.size())) ? cells[idx] : std::string();
        };
        // Both OpenCelliD contracts, exactly as decode_csv accepts them.
        r.radio = radio_from_text(cell_at(column_of(header_cells, "radio")));
        const std::string mcc = cell_at(column_of(header_cells, "mcc"));
        const std::string net = cell_at(column_of_either(header_cells, "net", "mnc"));
        const std::string area = cell_at(column_of_either(header_cells, "area", "lac"));
        const std::string cell = cell_at(column_of_either(header_cells, "cell", "cellid"));
        const std::string range = cell_at(column_of(header_cells, "range"));
        const std::string samples = cell_at(column_of(header_cells, "samples"));
        const std::string updated = cell_at(column_of(header_cells, "updated"));
        const std::string signal =
            cell_at(column_of_either(header_cells, "averageSignal", "averageSignalStrength"));
        if (!mcc.empty()) r.mcc = std::atol(mcc.c_str());
        if (!net.empty()) r.mnc = std::atol(net.c_str());
        if (!area.empty()) r.lac = std::atol(area.c_str());
        r.cell_id = cell;
        if (!range.empty()) r.range_m = std::atof(range.c_str());
        if (!samples.empty()) r.samples = std::atol(samples.c_str());
        if (!updated.empty()) r.observed_at = std::atoll(updated.c_str());
        if (!signal.empty()) {
            r.average_signal_dbm = std::atof(signal.c_str());
            r.has_signal = true;
        }
        r.native_id = r.cell_id;
        ++resume->rows_seen;

        const std::string key = site_key(r);
        auto it = sites.find(key);
        if (it == sites.end()) {
            // A NEW site is what the row cap bounds — the cap counts sites, the
            // unit this lane emits, not cells, the unit it consumes. Capping on
            // cells would make the answer depend on how many sectors happened
            // to sit on the masts read first.
            if (sites.size() >= row_cap) {
                capped = true;
                return false;
            }
            SiteAccumulator acc;
            acc.report = r;
            acc.samples_total = r.samples > 0 ? r.samples : 0;
            acc.best_samples = r.samples;
            sites.emplace(key, acc);
            order.push_back(key);
            return true;
        }
        SiteAccumulator& acc = it->second;
        if (r.samples > 0) acc.samples_total += r.samples;
        if (r.samples > acc.best_samples) {
            const long total = acc.samples_total;
            const double widest = acc.report.range_m > r.range_m ? acc.report.range_m : r.range_m;
            acc.report = r;
            acc.samples_total = total;
            acc.best_samples = r.samples;
            acc.report.range_m = widest;
        } else if (r.range_m > acc.report.range_m) {
            acc.report.range_m = r.range_m;
        }
        // The newest observation wins the timestamp: a site is current if ANY
        // of its cells is.
        if (r.observed_at > acc.report.observed_at) acc.report.observed_at = r.observed_at;
        return true;
    });

    for (const std::string& key : order) {
        SiteAccumulator& acc = sites[key];
        acc.report.samples = acc.samples_total > 0 ? acc.samples_total : acc.report.samples;
        out->push_back(acc.report);
        ++resume->sites_emitted;
    }

    if (hit_cap && capped) *hit_cap = true;
    resume->complete = stream.done;
    resume->valid = true;
    if (!stream.done && stream.ok && !capped) {
        bulk_state_encode(stream, resume);
        // Advance by what was actually CONSUMED, not by the chunk length. The
        // two differ whenever tinfl stops holding a partial symbol, and paying
        // that difference forward would drop those bytes — a silent corruption
        // at every seam rather than a visible failure.
        resume->next_byte += header_bytes + consumed;
    } else {
        bulk_state_clear(resume);
    }
    return stream.ok;
}

// Replace every occurrence of `token` in place. Written as a loop that advances
// PAST the substitution rather than re-searching from the start, so a value that
// happens to contain the token cannot loop forever.
void substitute_all(std::string* s, const std::string& token, const std::string& value) {
    size_t at = s->find(token);
    while (at != std::string::npos) {
        s->replace(at, token.size(), value);
        at = s->find(token, at + value.size());
    }
}

// Percent-encode for a query string. Overpass takes its program in `?data=`,
// and the program is full of characters that would otherwise terminate or
// re-key the query.
std::string url_encode(const std::string& in) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    out.reserve(in.size() * 3);
    for (unsigned char c : in) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~') {
            out += static_cast<char>(c);
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 0x0f];
        }
    }
    return out;
}

// The browser percent-encodes the provider id into the credential path
// (`encodeURIComponent`), so it is decoded before it is compared against the
// compiled registry. A malformed escape yields the literal characters rather
// than a partial byte: the result is then simply not a known provider id, which
// is the refusal we want, instead of a decode that fabricates one.
std::string url_decode(const std::string& in) {
    auto hex_value = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] == '%' && i + 2 < in.size()) {
            const int hi = hex_value(in[i + 1]);
            const int lo = hex_value(in[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out += static_cast<char>((hi << 4) | lo);
                i += 2;
                continue;
            }
        }
        out += in[i];
    }
    return out;
}

std::string upper_ascii(const std::string& in) {
    std::string out = in;
    for (char& c : out) {
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    }
    return out;
}

// ── report <-> $TBS (the intra-flow "reports" stream) ──────────────────────
//
// One normalized report = one $TBS record whose CONSENSUS says SINGLE_SOURCE
// ("exactly one provider reported the site; nothing was reconciled") and whose
// SOURCES holds that one provider. It asserts no deconfliction: that is
// deconflict's job, and its records say which merge they came from.
//
// PRESENCE IS THE SENTINEL. The builder forces defaults, so a field written as
// 0 survives as present; a field the source did not report is never written.
// The reader tests presence, never value == 0 — MCC 0 and "no MCC" stay apart
// across the hop, exactly as -1 kept them apart in the old JSON frame.
void append_size_prefixed(std::vector<uint8_t>* stream, const uint8_t* data, size_t size) {
    const uint32_t len = static_cast<uint32_t>(size);
    stream->push_back(static_cast<uint8_t>(len & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 8) & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 16) & 0xff));
    stream->push_back(static_cast<uint8_t>((len >> 24) & 0xff));
    stream->insert(stream->end(), data, data + size);
}

void report_to_tbs(const Report& r, const std::string& retrieved_at, std::vector<uint8_t>* stream) {
    flatbuffers::FlatBufferBuilder b(1024);
    b.ForceDefaults(true);
    const ProviderSpec* spec = find_provider(r.provider_id);
    const auto provider_id = b.CreateString(r.provider_id);
    const auto retrieved = b.CreateString(retrieved_at);
    const auto license = b.CreateString(spec ? spec->license : "unknown");
    const auto authority = spec ? b.CreateString(spec->authority) : 0;
    const auto source_url = spec ? b.CreateString(spec->url) : 0;
    const auto license_url = spec ? b.CreateString(spec->license_url) : 0;
    const auto attribution = spec ? b.CreateString(spec->attribution) : 0;
    const auto source_native = r.native_id.empty() ? 0 : b.CreateString(r.native_id);
    TBSProvenanceBuilder pb(b);
    pb.add_PROVIDER_ID(provider_id);
    pb.add_RETRIEVED_AT(retrieved);
    pb.add_LICENSE(license);
    if (authority.o) pb.add_AUTHORITY(authority);
    if (source_url.o) pb.add_SOURCE_URL(source_url);
    if (license_url.o) pb.add_LICENSE_URL(license_url);
    if (attribution.o) pb.add_ATTRIBUTION(attribution);
    if (source_native.o) pb.add_NATIVE_ID(source_native);
    pb.add_REPORTED_LATITUDE(r.latitude);
    pb.add_REPORTED_LONGITUDE(r.longitude);
    pb.add_CONTRIBUTED(true);
    const auto source = pb.Finish();
    const auto sources = b.CreateVector(&source, 1);

    const auto winner = b.CreateString(r.provider_id);
    TBSConsensusBuilder cb(b);
    cb.add_METHOD(tbsMergeMethod_SINGLE_SOURCE);
    cb.add_PROVIDERS_CONSULTED(1);
    cb.add_PROVIDERS_AGREEING(1);
    cb.add_WINNING_PROVIDER_ID(winner);
    const auto consensus = cb.Finish();

    const auto id = b.CreateString(r.provider_id + ":" + (r.cell_id.empty() ? "geo" : r.cell_id));
    const auto native_id = r.native_id.empty() ? 0 : b.CreateString(r.native_id);
    const auto cell_id = r.cell_id.empty() ? 0 : b.CreateString(r.cell_id);
    const auto last_observed = r.observed_at >= 0 ? b.CreateString(std::to_string(r.observed_at)) : 0;
    const auto operator_name = r.operator_name.empty() ? 0 : b.CreateString(r.operator_name);
    const auto site_name = r.site_name.empty() ? 0 : b.CreateString(r.site_name);
    const auto country_code = r.country_code.empty() ? 0 : b.CreateString(r.country_code);

    TBSBuilder tb(b);
    tb.add_ID(id);
    tb.add_RADIO(static_cast<tbsRadioClass>(r.radio));
    tb.add_LATITUDE(r.latitude);
    tb.add_LONGITUDE(r.longitude);
    if (native_id.o) tb.add_NATIVE_ID(native_id);
    if (r.mcc >= 0) tb.add_MCC(static_cast<uint32_t>(r.mcc));
    if (r.mnc >= 0) tb.add_MNC(static_cast<uint32_t>(r.mnc));
    if (r.lac >= 0) tb.add_LAC(static_cast<uint32_t>(r.lac));
    if (r.tac >= 0) tb.add_TAC(static_cast<uint32_t>(r.tac));
    if (cell_id.o) tb.add_CELL_ID(cell_id);
    if (r.range_m >= 0) tb.add_RANGE_M(r.range_m);
    if (r.samples >= 0) tb.add_SAMPLES(static_cast<uint32_t>(r.samples));
    if (r.has_signal) tb.add_AVERAGE_SIGNAL_DBM(r.average_signal_dbm);
    if (last_observed.o) tb.add_LAST_OBSERVED(last_observed);
    if (operator_name.o) tb.add_OPERATOR(operator_name);
    if (site_name.o) tb.add_SITE_NAME(site_name);
    if (country_code.o) tb.add_COUNTRY_CODE(country_code);
    tb.add_SOURCES(sources);
    tb.add_CONSENSUS(consensus);
    FinishTBSBuffer(b, tb.Finish());
    append_size_prefixed(stream, b.GetBufferPointer(), b.GetSize());
}

// Presence of a scalar the builder may have elided: the table's own vtable says
// whether the field was written (the generated tables keep CheckField private).
bool has_field(const void* table, flatbuffers::voffset_t vt) {
    const uint8_t* t = reinterpret_cast<const uint8_t*>(table);
    const uint8_t* vtable = t - flatbuffers::ReadScalar<flatbuffers::soffset_t>(t);
    const flatbuffers::voffset_t vtable_len = flatbuffers::ReadScalar<flatbuffers::voffset_t>(vtable);
    return vt < vtable_len && flatbuffers::ReadScalar<flatbuffers::voffset_t>(vtable + vt) != 0;
}

Report report_from_tbs(const TBS* t) {
    Report r;
    const auto str = [](const flatbuffers::String* s) { return s ? s->str() : std::string(); };
    if (t->SOURCES() && t->SOURCES()->size() && t->SOURCES()->Get(0)->PROVIDER_ID()) {
        r.provider_id = t->SOURCES()->Get(0)->PROVIDER_ID()->str();
    } else if (t->CONSENSUS() && t->CONSENSUS()->WINNING_PROVIDER_ID()) {
        r.provider_id = t->CONSENSUS()->WINNING_PROVIDER_ID()->str();
    }
    r.native_id = str(t->NATIVE_ID());
    r.radio = static_cast<int8_t>(t->RADIO());
    r.latitude = t->LATITUDE();
    r.longitude = t->LONGITUDE();
    if (has_field(t, TBS::VT_MCC)) r.mcc = static_cast<long>(t->MCC());
    if (has_field(t, TBS::VT_MNC)) r.mnc = static_cast<long>(t->MNC());
    if (has_field(t, TBS::VT_LAC)) r.lac = static_cast<long>(t->LAC());
    if (has_field(t, TBS::VT_TAC)) r.tac = static_cast<long>(t->TAC());
    r.cell_id = str(t->CELL_ID());
    if (has_field(t, TBS::VT_RANGE_M)) r.range_m = t->RANGE_M();
    if (has_field(t, TBS::VT_SAMPLES)) r.samples = static_cast<long>(t->SAMPLES());
    if (has_field(t, TBS::VT_AVERAGE_SIGNAL_DBM)) {
        r.average_signal_dbm = t->AVERAGE_SIGNAL_DBM();
        r.has_signal = true;
    }
    if (t->LAST_OBSERVED() && t->LAST_OBSERVED()->size()) {
        r.observed_at = std::strtoll(t->LAST_OBSERVED()->c_str(), nullptr, 10);
    }
    r.site_name = str(t->SITE_NAME());
    r.operator_name = str(t->OPERATOR());
    r.country_code = str(t->COUNTRY_CODE());
    return r;
}

// Walk a size-prefixed stream; zero-length prefixes are padding. Each frame is
// handed to `fn` from an 8-aligned copy when its address is not aligned.
template <typename Fn>
bool for_each_frame(const uint8_t* data, size_t size, Fn fn) {
    size_t at = 0;
    std::vector<uint8_t> scratch;
    while (at + 4 <= size) {
        const uint32_t len = static_cast<uint32_t>(data[at]) | (static_cast<uint32_t>(data[at + 1]) << 8) |
                             (static_cast<uint32_t>(data[at + 2]) << 16) |
                             (static_cast<uint32_t>(data[at + 3]) << 24);
        at += 4;
        if (len == 0) continue;
        if (len > size - at) return false;
        const uint8_t* frame = data + at;
        if (reinterpret_cast<uintptr_t>(frame) % 8) {
            scratch.assign(frame, frame + len);
            frame = scratch.data();
        }
        if (!fn(frame, static_cast<size_t>(len))) return false;
        at += len;
    }
    return at == size;
}


// Splits a JSON array of objects into its top-level object slices.
std::vector<std::string> split_json_objects(const std::string& src) {
    std::vector<std::string> out;
    int depth = 0;
    size_t start = 0;
    bool in_string = false;
    for (size_t i = 0; i < src.size(); ++i) {
        const char c = src[i];
        if (in_string) {
            if (c == '"' && src[i - 1] != '\\') in_string = false;
            continue;
        }
        if (c == '"') { in_string = true; continue; }
        if (c == '{') { if (depth++ == 0) start = i; }
        else if (c == '}') { if (--depth == 0) out.push_back(src.substr(start, i - start + 1)); }
    }
    return out;
}

// What SHAPE is this response body, judged only by structure?
//
// Used to corroborate a positional attribution before decoding (see parse).
// Returns nullptr when the body says nothing decisive — an unknown shape must
// not veto an attribution, only contradict one, or a provider whose adapter
// has not landed yet could never be added.
const char* detect_body_format(const std::string& body) {
    size_t i = 0;
    while (i < body.size() && (body[i] == ' ' || body[i] == '\n' || body[i] == '\r' || body[i] == '\t')) ++i;
    if (i >= body.size()) return nullptr;
    // A top-level array is a row API answer (`soql-json`).
    if (body[i] == '[') return "soql-json";
    // A top-level object carrying `elements` is an Overpass answer; one
    // carrying `features` is a GeoJSON FeatureCollection. The two keys are
    // disjoint, so this stays a corroboration rather than a guess.
    if (body[i] == '{') {
        // Do not extract the arrays merely to prove their keys exist. On the
        // BAKOM national document that copied 27 MiB twice before parsing.
        if (body.find("\"elements\"") != std::string::npos) return "osm-json";
        if (body.find("\"features\"") != std::string::npos) return "swiss-geojson";
        // A PROVIDER ERROR ENVELOPE SERVED AS 200.
        //
        // OpenCelliD answers a bad, expired or quota-exhausted token with
        // status 200 and `{"status":"error","message":"INVALID_TOKEN"}`
        // (verified live 2026-08-14). The HTTP status carries no signal at all,
        // so the only place this can be caught is the body. Naming it a format
        // no provider declares makes the corroboration check below VETO the
        // frame, which is what keeps a dead credential from reading as a
        // register with nothing in it.
        if (body.find("\"status\":\"error\"") != std::string::npos ||
            body.find("\"error\"") != std::string::npos) {
            return "provider-error";
        }
        return nullptr;
    }
    // A ZIP is identified DOWN TO THE PROVIDER, not merely as "a zip".
    //
    // The three bulk archives share one magic number, so magic alone would make
    // them mutually ambiguous and push all three back onto positional
    // attribution — the exact fragility the format check exists to remove. A
    // member NAME is unambiguous instead: only ACMA ships `site.csv`, only ISED
    // ships `TAFL_LTAF.csv`, only ANFR ships `SUP_SUPPORT.txt`. Reading the
    // central directory to check is cheap (a backward scan over the last 64 KiB
    // plus one walk of the entry table) and inflates nothing.
    // gzip. Unlike the ZIPs a gzip member carries no member table to walk, so
    // the magic number is all there is. It identifies the FORMAT, not the
    // provider: two providers now serve `csv-gz` (the OpenCelliD bulk export
    // and the MLS final export), which is why the unique-format attribution
    // above checks for ambiguity and falls back to position. The corroboration
    // check is unaffected — both providers declare `csv-gz`, so neither is ever
    // vetoed by the other's body.
    //
    // This check earns its keep on the FAILURE path, not the success one.
    // OpenCelliD answers a bad or expired token with **200 and a JSON body**
    // (`{"status":"error","message":"INVALID_TOKEN"}`, verified live
    // 2026-08-14), so without a format veto an expired credential would decode
    // to zero sites and be reported as a register that had nothing to say. The
    // JSON branch above already claims a `{` body, so such a response can never
    // reach the gzip decoder: it is attributed to no format and dropped, and
    // the run reports the provider as consulted-and-silent rather than empty.
    if (body.size() > 2 && static_cast<uint8_t>(body[0]) == 0x1F &&
        static_cast<uint8_t>(body[1]) == 0x8B) {
        return "csv-gz";
    }
    if (body.size() > 4 && body[0] == 'P' && body[1] == 'K' &&
        static_cast<uint8_t>(body[2]) == 0x03 && static_cast<uint8_t>(body[3]) == 0x04) {
        if (zip_find_member(body, "site.csv").found) return "zip-acma";
        if (zip_find_member(body, "TAFL_LTAF.csv").found) return "zip-ised";
        if (zip_find_member(body, "SUP_SUPPORT.txt").found) return "zip-anfr";
        return nullptr;  // a ZIP this module does not know: never guessed at
    }
    // A CSV answer is not JSON and is deliberately NOT identified here, and
    // neither is ComReg's protobuf: a protobuf stream has no magic number, and
    // any byte pattern claimed for one would also match some CSV. Both fall
    // through to positional attribution, which is still corroborated
    // downstream — never be vetoed by an unknown shape.
    return nullptr;
}

// Decode an Overpass `elements` array into reports.
//
// OSM does not publish MCC/MNC/cell ids — these are MASTS, not cells — so the
// records carry position, operator and radio class only, and their identity is
// the OSM node id. That means they group GEOMETRICALLY, which is the correct
// behaviour: a mast is not a cell and claiming otherwise would fabricate
// network identifiers the source never stated.
void decode_osm_json(const ProviderSpec& spec, const std::string& body, std::vector<Report>* out) {
    // Split the ELEMENTS ARRAY, never the document. `split_json_objects` returns
    // objects at bracket depth 0, and an Overpass response is ONE top-level
    // object — so splitting the body yields exactly one "element": the whole
    // document. Every field lookup then returned the FIRST match anywhere in the
    // response, which decoded one site per fetch wearing another site's operator
    // and name. Two failures at once, and both look like plausible data:
    // 26 of 27 masts silently vanish, and the survivor carries an attribution
    // the source never made about it. Scoping to the array makes each lookup
    // element-local, which is the only reason the tag reads below are sound.
    const std::string elements = json_string(body, "elements", "");
    if (elements.empty()) return;
    for (const std::string& element : split_json_objects(elements)) {
        const double lat = json_number(element, "lat", 1e9);
        const double lon = json_number(element, "lon", 1e9);
        if (lat > 90 || lat < -90 || lon > 180 || lon < -180) continue;

        Report r;
        r.provider_id = spec.id;
        r.latitude = lat;
        r.longitude = lon;
        const double id = json_number(element, "id", 0);
        if (id > 0) {
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%.0f", id);
            r.native_id = buf;
        }
        // `operator` and the radio generation live in the tags.
        const std::string op = json_string(element, "operator", "");
        if (!op.empty()) r.operator_name = op;
        const std::string generation = json_string(element, "communication:mobile_phone", "");
        const std::string mast = json_string(element, "man_made", "");
        if (generation == "lte" || generation == "4g") r.radio = RC_LTE;
        else if (generation == "5g" || generation == "nr") r.radio = RC_NR;
        else if (generation == "umts" || generation == "3g") r.radio = RC_UMTS;
        else if (generation == "gsm" || generation == "2g") r.radio = RC_GSM;
        else r.radio = RC_UNKNOWN;
        const std::string name = json_string(element, "name", "");
        if (!name.empty()) r.site_name = name;
        else if (!mast.empty()) r.site_name = mast;
        out->push_back(r);
    }
    (void)elements;
}


// Decode an open-data row API response: a top-level ARRAY of flat objects, so
// unlike the Overpass body these ARE the depth-0 objects and split directly.
//
// A licensed fixed base station is not a cellular cell: the register publishes
// no MCC/MNC/cell id, so these records carry site identity and position only and
// their radio class is OTHER, not a guessed generation. Claiming LTE here would
// invent a fact the regulator never stated — and because these sites are the
// AUTHORITATIVE half of the merge, that invention would then WIN deconfliction
// against the crowd-sourced provider and be exported as though a regulator had
// asserted it.
// ── EPSG:2056 (Swiss LV95) -> WGS84 ────────────────────────────────────────
//
// swisstopo's approximate formulas. Accurate to about a metre, which is far
// inside a base-station position's own uncertainty, and they need no datum
// grid file — a WASM module with no filesystem cannot carry one.
//
// This transform is NOT optional garnish. The published coordinates are
// easting/northing in metres (e.g. 2732413, 1219730). Read as degrees they fail
// the module's own -90/-180 range guard, so every Swiss row is DROPPED and the
// provider fetches 27 MB perfectly and contributes exactly nothing — a failure
// that looks identical to a country with no masts.
//
// Verified against known points before being compiled in: the LV95 origin
// (2600000, 1200000) transforms to 46.95108, 7.43864, which is the Bern
// reference point to five decimals; and a fixture feature whose station name
// carries the canton code GE transforms into Geneva. A transform that lands the
// right rows in the wrong country is the kind of error that renders beautifully.
void lv95_to_wgs84(double easting, double northing, double* lat_out, double* lon_out) {
    const double y = (easting - 2600000.0) / 1000000.0;
    const double x = (northing - 1200000.0) / 1000000.0;
    const double lambda = 2.6779094 + 4.728982 * y + 0.791484 * y * x +
                          0.1306 * y * x * x - 0.0436 * y * y * y;
    const double phi = 16.9023892 + 3.238272 * x - 0.270978 * y * y -
                       0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x * x * x;
    *lon_out = lambda * 100.0 / 36.0;
    *lat_out = phi * 100.0 / 36.0;
}

// Radio class from BAKOM's free-text technology label, e.g. "Technology 4G,5G".
// The HIGHEST generation present wins: a site carrying 4G and 5G is a 5G site
// that also serves 4G, and reporting it as 4G would understate it against a
// provider that reports NR for the same mast, which then loses deconfliction
// for the wrong reason.
int8_t swiss_radio_from_techno(const std::string& techno) {
    if (techno.find("5G") != std::string::npos) return RC_NR;
    if (techno.find("4G") != std::string::npos) return RC_LTE;
    if (techno.find("3G") != std::string::npos) return RC_UMTS;
    if (techno.find("2G") != std::string::npos) return RC_GSM;
    return RC_UNKNOWN;
}

// `hit_cap` reports whether the decoder STOPPED at report_limit with body
// left over, as opposed to running out of features. That distinction is the
// difference between "Switzerland has this many masts" and "you asked for this
// many" — the ambiguity this whole task exists to remove — so it is an output,
// not an inference the caller makes from a count.
void decode_swiss_geojson(const ProviderSpec& spec, const std::string& body,
                          size_t report_limit, std::vector<Report>* out,
                          bool* hit_cap) {
    // Split the FEATURES ARRAY, not the document — same lesson the Overpass
    // decoder records: a GeoJSON FeatureCollection is one top-level object, so
    // splitting the body yields one "feature" (the whole file) and every field
    // read returns the first match anywhere in 27 MB.
    const std::string needle = "\"features\"";
    size_t at = body.find(needle);
    if (at == std::string::npos) return;
    at = body.find(':', at + needle.size());
    if (at == std::string::npos) return;
    at = body.find('[', at + 1);
    if (at == std::string::npos) return;

    // Stream object slices out of the array and stop at the request's bounded
    // per-provider row cap. The old json_string + split_json_objects path first
    // copied the entire 27 MiB array and then allocated every feature object,
    // even though route had already capped useful rows at 1,000.
    size_t emitted = 0;
    size_t object_start = 0;
    int depth = 0;
    bool in_string = false;
    bool escaped = false;
    for (++at; at < body.size(); ++at) {
        const char c = body[at];
        if (in_string) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') { in_string = true; continue; }
        if (c == '{') {
            // The cap is enforced at the START of the NEXT feature, never on
            // the trailing bytes of the array: stopping here means a feature
            // really was left undecoded, which is what `hit_cap` promises.
            if (depth == 0 && emitted >= report_limit) {
                if (hit_cap) *hit_cap = true;
                break;
            }
            if (depth++ == 0) object_start = at;
            continue;
        }
        if (c != '}' || depth <= 0 || --depth != 0) continue;
        const std::string feature = body.substr(object_start, at - object_start + 1);
        // `coordinates` is a two-number ARRAY, so it is read positionally
        // rather than by key. Order is [easting, northing].
        const size_t at = feature.find("\"coordinates\"");
        if (at == std::string::npos) continue;
        const size_t open = feature.find('[', at);
        if (open == std::string::npos) continue;
        const size_t close = feature.find(']', open);
        if (close == std::string::npos) continue;
        const std::string pair = feature.substr(open + 1, close - open - 1);
        const size_t comma = pair.find(',');
        if (comma == std::string::npos) continue;
        const double easting = std::atof(pair.substr(0, comma).c_str());
        const double northing = std::atof(pair.substr(comma + 1).c_str());
        // A plausibility guard on the SOURCE units. If these ever arrive as
        // degrees the transform would produce confident nonsense, so a value
        // that is not an LV95 metre coordinate is dropped rather than fed in.
        if (easting < 2000000.0 || easting > 3000000.0 ||
            northing < 1000000.0 || northing > 1400000.0) {
            continue;
        }
        double lat = 0, lon = 0;
        lv95_to_wgs84(easting, northing, &lat, &lon);
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

        Report r;
        r.provider_id = spec.id;
        r.latitude = lat;
        r.longitude = lon;
        r.country_code = "CH";
        // `station` is the operator's own site designator, e.g. "Salt BE_1014A".
        // It is both the site name and the closest thing to a native id this
        // register publishes; there is no cell id and none is invented.
        const std::string station = json_string(feature, "station", "");
        if (!station.empty()) {
            r.site_name = station;
            r.native_id = station;
        }
        r.radio = swiss_radio_from_techno(json_string(feature, "techno_en", ""));
        out->push_back(r);
        ++emitted;
    }
}

void decode_soql_json(const ProviderSpec& spec, const std::string& body, std::vector<Report>* out) {
    for (const std::string& row : split_json_objects(body)) {
        const double lat = json_number(row, "u_latitude", 1e9);
        const double lon = json_number(row, "u_longitude", 1e9);
        if (lat > 90 || lat < -90 || lon > 180 || lon < -180) continue;

        Report r;
        r.provider_id = spec.id;
        r.latitude = lat;
        r.longitude = lon;
        r.radio = RC_OTHER;
        // The location id is unique per licensed site; the call sign is not.
        const std::string loc_id = json_string(row, "u_location_id", "");
        if (!loc_id.empty()) r.native_id = loc_id;
        const std::string op = json_string(row, "u_license_name", "");
        if (!op.empty()) r.operator_name = op;
        const std::string name = json_string(row, "u_location_name", "");
        if (!name.empty()) r.site_name = name;
        out->push_back(r);
    }
}

// ── ACMA Register of Radiocommunications Licences (Australia) ──────────────
//
// `site.csv` is the whole adapter: SITE_ID,LATITUDE,LONGITUDE,NAME,STATE,... in
// clean decimal degrees, verified against the live archive 2026-08-14.
//
// NO OPERATOR NAME IS EMITTED, and that is a measurement rather than an
// omission. The site->licence->client join that would name the licensee runs
// through `device_details.csv`, which is the member carrying both SITE_ID and
// LICENCE_NO — and it inflates to 383,353,349 bytes. Streaming it is possible;
// holding the resulting SITE_ID->CLIENT_NO map for millions of device rows,
// plus client.csv, is not, inside a 128 MB ceiling that already contains a
// 70 MB compressed body. So this decoder emits what the register states about
// the SITE and invents no licensee, exactly as the BAKOM lane emits masts with
// no cell identity rather than fabricating one.
//
// LICENCE, re-read from LICENCE.TXT INSIDE the live archive on 2026-08-14 as
// the task required: "Intellectual Property in the Register is retained by the
// ACMA", granting a "non-transferable, non-exclusive Licence to use, reproduce
// and adapt". It is NOT CC BY 4.0. The registry string was already corrected to
// match; this run confirms the correction against the bytes.
void decode_acma_zip(const ProviderSpec& spec, const std::string& body,
                     size_t report_limit, std::vector<Report>* out, bool* hit_cap) {
    const ZipEntry entry = zip_find_member(body, "site.csv");
    if (!entry.found) return;

    int c_id = -1, c_lat = -1, c_lon = -1, c_name = -1, c_state = -1;
    bool have_header = false;
    size_t emitted = 0;
    zip_stream_lines(body, entry, [&](const std::string& line) -> bool {
        const std::vector<std::string> cells = split_csv_line(line);
        if (!have_header) {
            have_header = true;
            c_id = column_of(cells, "SITE_ID");
            c_lat = column_of(cells, "LATITUDE");
            c_lon = column_of(cells, "LONGITUDE");
            c_name = column_of(cells, "NAME");
            c_state = column_of(cells, "STATE");
            // A header that is not the expected contract emits NOTHING rather
            // than decoding positionally against a guess.
            return c_lat >= 0 && c_lon >= 0;
        }
        if (emitted >= report_limit) { if (hit_cap) *hit_cap = true; return false; }
        const int need = std::max(c_lat, c_lon);
        if (need >= static_cast<int>(cells.size())) return true;
        const std::string& lat_s = cells[c_lat];
        const std::string& lon_s = cells[c_lon];
        if (lat_s.empty() || lon_s.empty()) return true;

        Report r;
        r.provider_id = spec.id;
        r.latitude = std::atof(lat_s.c_str());
        r.longitude = std::atof(lon_s.c_str());
        if (r.latitude < -90 || r.latitude > 90 || r.longitude < -180 || r.longitude > 180) return true;
        if (r.latitude == 0.0 && r.longitude == 0.0) return true;
        r.country_code = "AU";
        r.radio = RC_UNKNOWN;
        if (c_id >= 0 && c_id < static_cast<int>(cells.size())) r.native_id = cells[c_id];
        if (c_name >= 0 && c_name < static_cast<int>(cells.size())) r.site_name = cells[c_name];
        (void)c_state;
        out->push_back(r);
        ++emitted;
        return true;
    });
}

// ── ISED Technical and Administrative Frequency List (Canada) ──────────────
//
// TAFL_LTAF.csv is the archive's ONLY member and inflates to 428,229,263 bytes,
// so it is the strongest case for the streaming window: fully extracting it is
// more than three times the entire memory ceiling.
//
// It is HEADERLESS AND POSITIONAL — there are no names to look up, so the
// ordinals below are the contract. They were established on 2026-08-14 against
// the live file and are recorded with their evidence, because a positional map
// that is off by one decodes silently into confident nonsense:
//
//   2   frequency record identifier   "0001403864"
//   14  frequency (MHz)               "23.35156"
//   31  station location name         "CASTLEGAR BC (ILS LOCALIZER)"
//   39  province code                 "BC"
//   40  latitude (decimal degrees)    "49.2525"
//   41  longitude (decimal degrees)   "-117.6625"
//   54  licensee                      "NAV CANADA - BRITISH COLUMBIA"
//
// CORROBORATION, not assertion: over the first 200,000 rows, 166,139 of the
// 166,948 rows carrying both a province code and a coordinate pair fall inside
// that province's bounding box (99.5%); the residue sits on inter-provincial
// borders. A column map shifted by one puts essentially none of them in the
// right province, so this test distinguishes the right map from a plausible
// wrong one — which reading three rows by eye cannot.
//
// The file has a UTF-8 BOM, which would otherwise ride into the first field.
void decode_ised_zip(const ProviderSpec& spec, const std::string& body,
                     size_t report_limit, std::vector<Report>* out, bool* hit_cap) {
    const ZipEntry entry = zip_find_member(body, "TAFL_LTAF.csv");
    if (!entry.found) return;

    const size_t kColId = 2, kColFreq = 14, kColName = 31, kColProv = 39;
    const size_t kColLat = 40, kColLon = 41, kColLicensee = 54, kMinCols = 55;
    size_t emitted = 0;
    bool first = true;
    zip_stream_lines(body, entry, [&](const std::string& raw) -> bool {
        if (emitted >= report_limit) { if (hit_cap) *hit_cap = true; return false; }
        const char* start = raw.c_str();
        size_t skip = 0;
        if (first) {
            first = false;
            if (raw.size() >= 3 && static_cast<uint8_t>(raw[0]) == 0xEF &&
                static_cast<uint8_t>(raw[1]) == 0xBB && static_cast<uint8_t>(raw[2]) == 0xBF) {
                skip = 3;
            }
        }
        (void)start;
        const std::vector<std::string> cells =
            split_csv_line(skip ? raw.substr(skip) : raw);
        if (cells.size() < kMinCols) return true;
        const std::string& lat_s = cells[kColLat];
        const std::string& lon_s = cells[kColLon];
        if (lat_s.empty() || lon_s.empty()) return true;

        Report r;
        r.provider_id = spec.id;
        r.latitude = std::atof(lat_s.c_str());
        r.longitude = std::atof(lon_s.c_str());
        if (r.latitude < -90 || r.latitude > 90 || r.longitude < -180 || r.longitude > 180) return true;
        if (r.latitude == 0.0 && r.longitude == 0.0) return true;
        r.country_code = "CA";
        r.radio = RC_UNKNOWN;
        r.native_id = cells[kColId];
        if (!cells[kColName].empty()) r.site_name = cells[kColName];
        if (!cells[kColLicensee].empty()) r.operator_name = cells[kColLicensee];
        (void)kColFreq;
        (void)kColProv;
        out->push_back(r);
        ++emitted;
        return true;
    });
}

// ── ANFR Cartoradio (France) ───────────────────────────────────────────────
//
// Positions live in SUP_SUPPORT.txt (18.6 MB inflated, 198,524 supports),
// ';'-delimited and unquoted. SUP_BANDE.txt (203 MB) and SUP_EMETTEUR.txt
// (117 MB) are siblings in the same archive and are never touched.
//
// THE DMS TRAP, which is the reason this provider needs a decoder of its own:
// each coordinate is FOUR columns — degrees, minutes, seconds, hemisphere:
//   COR_NB_DG_LAT COR_NB_MN_LAT COR_NB_SC_LAT COR_CD_NS_LAT
//   COR_NB_DG_LON COR_NB_MN_LON COR_NB_SC_LON COR_CD_EW_LON
// Reading the degree column alone yields a coordinate that is IN RANGE and
// plausible and wrong by up to a degree — a site placed in the wrong commune
// rather than a row that gets dropped. That failure is invisible to a
// row-count test, so it is covered by an exact-value fixture assertion.
//
// NO OPERATOR NAME IS EMITTED. The ADM_ID that SUP_STATION.txt joins on is a
// numeric affectataire code (6, 23, 240, 137, 39, 2, ...) and the archive ships
// NO table mapping those codes to names. Emitting "ADM_ID 6" as an operator
// would be a fabricated attribution riding into $TBS.SOURCES, so the join is
// deliberately not performed for naming and the station id is carried instead.
double dms_to_decimal(const std::string& d, const std::string& m, const std::string& s,
                      const std::string& hemi) {
    const double deg = std::atof(d.c_str());
    const double min = std::atof(m.c_str());
    const double sec = std::atof(s.c_str());
    double v = deg + (min / 60.0) + (sec / 3600.0);
    if (!hemi.empty() && (hemi[0] == 'S' || hemi[0] == 'W' || hemi[0] == 'O')) v = -v;
    return v;
}

void decode_anfr_zip(const ProviderSpec& spec, const std::string& body,
                     size_t report_limit, std::vector<Report>* out, bool* hit_cap) {
    const ZipEntry entry = zip_find_member(body, "SUP_SUPPORT.txt");
    if (!entry.found) return;

    int c_sta = -1, c_dlat = -1, c_mlat = -1, c_slat = -1, c_hlat = -1;
    int c_dlon = -1, c_mlon = -1, c_slon = -1, c_hlon = -1, c_lieu = -1;
    bool have_header = false;
    size_t emitted = 0;
    zip_stream_lines(body, entry, [&](const std::string& line) -> bool {
        const std::vector<std::string> cells = split_semicolon_line(line);
        if (!have_header) {
            have_header = true;
            c_sta = column_of(cells, "STA_NM_ANFR");
            c_dlat = column_of(cells, "COR_NB_DG_LAT");
            c_mlat = column_of(cells, "COR_NB_MN_LAT");
            c_slat = column_of(cells, "COR_NB_SC_LAT");
            c_hlat = column_of(cells, "COR_CD_NS_LAT");
            c_dlon = column_of(cells, "COR_NB_DG_LON");
            c_mlon = column_of(cells, "COR_NB_MN_LON");
            c_slon = column_of(cells, "COR_NB_SC_LON");
            c_hlon = column_of(cells, "COR_CD_EW_LON");
            c_lieu = column_of(cells, "ADR_LB_LIEU");
            return c_dlat >= 0 && c_dlon >= 0 && c_hlat >= 0 && c_hlon >= 0;
        }
        if (emitted >= report_limit) { if (hit_cap) *hit_cap = true; return false; }
        int need = c_hlon;
        if (c_slon > need) need = c_slon;
        if (need >= static_cast<int>(cells.size())) return true;
        auto at = [&](int i) -> std::string {
            return (i >= 0 && i < static_cast<int>(cells.size())) ? cells[i] : std::string();
        };
        if (at(c_dlat).empty() || at(c_dlon).empty()) return true;

        Report r;
        r.provider_id = spec.id;
        r.latitude = dms_to_decimal(at(c_dlat), at(c_mlat), at(c_slat), at(c_hlat));
        r.longitude = dms_to_decimal(at(c_dlon), at(c_mlon), at(c_slon), at(c_hlon));
        if (r.latitude < -90 || r.latitude > 90 || r.longitude < -180 || r.longitude > 180) return true;
        if (r.latitude == 0.0 && r.longitude == 0.0) return true;
        r.country_code = "FR";
        r.radio = RC_UNKNOWN;
        r.native_id = at(c_sta);
        const std::string lieu = at(c_lieu);
        if (!lieu.empty()) r.site_name = lieu;
        out->push_back(r);
        ++emitted;
        return true;
    });
}

// ── ComReg SiteViewer (Ireland), application/x-protobuf ────────────────────
//
// The backend ignores `Accept: application/json` and always answers protobuf,
// so this is a decoder rather than a header negotiation. No .proto is
// published; the wire shape below was recovered from the live response on
// 2026-08-14 (`POST {}` -> 200, 401,836 bytes, unauthenticated) and is narrow
// enough to read directly:
//
//   response { repeated Mast masts = 1; }
//   Mast { string id = 1; uint32 class = 2; sint-as-int64 lat_e6 = 3; lon_e6 = 4; }
//
// Field 3/4 are degrees scaled by 1e6, encoded as plain varints in two's
// complement — NOT zigzag — so a negative longitude arrives as a ten-byte
// varint that must be reinterpreted as int64. Ireland's longitudes are all
// negative, so reading them as unsigned would place every Irish mast near
// +18,446,744,073,709 degrees and drop the entire national register through the
// range guard: a provider that fetches perfectly and contributes nothing.
//
// The id, e.g. "1-EIR_CE_1135-3GQQVUXZ", carries the operator token before the
// first '_'. That token (EIR / THR / VOD / IMA) is emitted VERBATIM and is not
// expanded into a company name — "THR" is evidently Three and "VOD" evidently
// Vodafone, but evidently is not stated, and this module does not fabricate
// attribution. Class 2 records (1,539 of 9,646) are licence-referenced sites
// whose id is a licence number rather than an operator token; they yield no
// operator, which is why the token is taken only when it is alphabetic.
bool pb_varint(const std::string& b, size_t* at, uint64_t* out) {
    uint64_t result = 0;
    int shift = 0;
    while (*at < b.size() && shift <= 63) {
        const uint8_t byte = static_cast<uint8_t>(b[*at]);
        ++(*at);
        result |= static_cast<uint64_t>(byte & 0x7F) << shift;
        if (!(byte & 0x80)) { *out = result; return true; }
        shift += 7;
    }
    return false;
}

void decode_comreg_protobuf(const ProviderSpec& spec, const std::string& body,
                            size_t report_limit, std::vector<Report>* out, bool* hit_cap) {
    size_t at = 0;
    size_t emitted = 0;
    while (at < body.size()) {
        uint64_t key = 0;
        if (!pb_varint(body, &at, &key)) return;
        const uint64_t field = key >> 3;
        const uint64_t wire = key & 0x7;
        if (wire != 2) {  // skip anything that is not a length-delimited mast
            uint64_t skip = 0;
            if (wire == 0) { if (!pb_varint(body, &at, &skip)) return; continue; }
            if (wire == 5) { at += 4; continue; }
            if (wire == 1) { at += 8; continue; }
            return;
        }
        uint64_t len = 0;
        if (!pb_varint(body, &at, &len)) return;
        if (at + len > body.size()) return;
        const size_t rec_start = at;
        const size_t rec_end = at + static_cast<size_t>(len);
        at = rec_end;
        if (field != 1) continue;

        if (emitted >= report_limit) { if (hit_cap) *hit_cap = true; return; }

        std::string id;
        bool have_lat = false, have_lon = false;
        double lat = 0, lon = 0;
        size_t p = rec_start;
        while (p < rec_end) {
            uint64_t k = 0;
            if (!pb_varint(body, &p, &k)) break;
            const uint64_t f = k >> 3;
            const uint64_t w = k & 0x7;
            if (w == 2) {
                uint64_t n = 0;
                if (!pb_varint(body, &p, &n)) break;
                if (p + n > rec_end) break;
                if (f == 1) id.assign(body, p, static_cast<size_t>(n));
                p += static_cast<size_t>(n);
                continue;
            }
            if (w != 0) break;
            uint64_t v = 0;
            if (!pb_varint(body, &p, &v)) break;
            if (f == 3) { lat = static_cast<double>(static_cast<int64_t>(v)) / 1e6; have_lat = true; }
            else if (f == 4) { lon = static_cast<double>(static_cast<int64_t>(v)) / 1e6; have_lon = true; }
        }
        if (!have_lat || !have_lon) continue;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
        if (lat == 0.0 && lon == 0.0) continue;

        Report r;
        r.provider_id = spec.id;
        r.latitude = lat;
        r.longitude = lon;
        r.country_code = "IE";
        r.radio = RC_UNKNOWN;
        r.native_id = id;
        // Operator token: the run of letters after the leading "<n>-" and
        // before the first '_'. Taken only when it is wholly alphabetic, so a
        // licence-numbered id ("1-07/81_...") yields no operator rather than a
        // fragment of a licence number presented as a carrier.
        const size_t dash = id.find('-');
        const size_t underscore = id.find('_');
        if (dash != std::string::npos && underscore != std::string::npos && underscore > dash + 1) {
            const std::string token = id.substr(dash + 1, underscore - dash - 1);
            bool alpha = !token.empty();
            for (size_t i = 0; i < token.size(); ++i) {
                if (token[i] < 'A' || token[i] > 'Z') { alpha = false; break; }
            }
            if (alpha) r.operator_name = token;
        }
        // "-3G" / "-4G" / "-5G" appears in the id for the operator-named class.
        if (id.find("-5G") != std::string::npos) r.radio = RC_NR;
        else if (id.find("-4G") != std::string::npos) r.radio = RC_LTE;
        else if (id.find("-3G") != std::string::npos) r.radio = RC_UMTS;
        else if (id.find("-2G") != std::string::npos) r.radio = RC_GSM;
        out->push_back(r);
        ++emitted;
    }
}

// ── deconfliction (mirror of deconflict.mjs; parity-gated) ─────────────────
std::string network_identity(const Report& r) {
    if (r.mcc < 0 || r.mnc < 0 || r.cell_id.empty()) return std::string();
    const long area = (r.lac >= 0) ? r.lac : r.tac;  // same slot, different era
    return std::to_string(static_cast<int>(r.radio)) + "|" + std::to_string(r.mcc) + "|" +
           std::to_string(r.mnc) + "|" + (area >= 0 ? std::to_string(area) : "") + "|" + r.cell_id;
}

std::vector<std::vector<size_t>> group_reports(const std::vector<Report>& reports) {
    std::vector<std::vector<size_t>> groups;
    std::map<std::string, size_t> by_identity;
    // Geometric group HEADS bucketed by (lat cell, lon cell) — values are
    // indices INTO groups, exactly as the old flat `geometric` list held.
    std::map<std::pair<long, long>, std::vector<size_t>> head_grid;
    for (size_t i = 0; i < reports.size(); ++i) {
        const std::string identity = network_identity(reports[i]);
        if (!identity.empty()) {
            auto it = by_identity.find(identity);
            if (it == by_identity.end()) {
                by_identity[identity] = groups.size();
                groups.push_back({i});
            } else {
                groups[it->second].push_back(i);
            }
            continue;
        }
        // SPATIAL BUCKETS, NOT A LINEAR SCAN.
        //
        // This used to compare every identity-less report against every
        // geometric group HEAD, which is O(n^2): the national BAKOM register
        // publishes no MCC/MNC/cell id, so all 22,347 Swiss masts take this
        // path and the scan is ~2.5e8 haversine calls inside ONE wasm
        // invocation. That cost is precisely why the lane was capped at 1,000
        // rows, so bounding it is a PRECONDITION of emitting the full
        // population — not an optimisation.
        //
        // Heads are indexed on a lat/lon grid whose cell is the match
        // tolerance, so a candidate can only lie in the 3x3 neighbourhood of
        // its own cell. The winner is still the NEAREST head within tolerance,
        // scanning that neighbourhood in ascending cell order, so the grouping
        // is identical to the linear scan's — the grid changes which heads are
        // CONSIDERED, never which one wins. (Longitude cells widen by
        // 1/cos(lat) so a cell stays at least the tolerance wide in metres;
        // near the poles cos(lat) is floored to keep the divisor finite.)
        const double lat_cell = kPositionToleranceM / 111320.0;
        const double coslat = std::fabs(std::cos(reports[i].latitude * (3.14159265358979323846 / 180.0)));
        const double lon_cell = lat_cell / (coslat < 1e-6 ? 1e-6 : coslat);
        const long gy = static_cast<long>(std::floor(reports[i].latitude / lat_cell));
        const long gx = static_cast<long>(std::floor(reports[i].longitude / lon_cell));

        size_t matched = SIZE_MAX;
        double best = 1e18;
        for (long dy = -1; dy <= 1; ++dy) {
            for (long dx = -1; dx <= 1; ++dx) {
                auto bucket = head_grid.find(std::make_pair(gy + dy, gx + dx));
                if (bucket == head_grid.end()) continue;
                for (size_t g : bucket->second) {
                    const Report& head = reports[groups[g][0]];
                    const double d = haversine_m(head.latitude, head.longitude,
                                                 reports[i].latitude, reports[i].longitude);
                    if (d <= kPositionToleranceM && d < best) { best = d; matched = g; }
                }
            }
        }
        if (matched != SIZE_MAX) { groups[matched].push_back(i); continue; }
        head_grid[std::make_pair(gy, gx)].push_back(groups.size());
        groups.push_back({i});
    }
    return groups;
}

long sample_count(const Report& r) { return r.samples >= 0 ? r.samples : 0; }

size_t select_winner(const std::vector<Report>& reports, const std::vector<size_t>& group,
                     int8_t method) {
    size_t best = group[0];
    for (size_t idx : group) {
        const Report& a = reports[idx];
        const Report& b = reports[best];
        bool better = false;
        if (method == MM_MOST_RECENT) {
            if (a.observed_at != b.observed_at) better = a.observed_at > b.observed_at;
            else better = a.provider_id < b.provider_id;
        } else if (method == MM_AUTHORITY_PRECEDENCE) {
            const ProviderSpec* pa = find_provider(a.provider_id);
            const ProviderSpec* pb = find_provider(b.provider_id);
            const int aa = (pa && pa->authoritative) ? 1 : 0;
            const int ab = (pb && pb->authoritative) ? 1 : 0;
            if (aa != ab) better = aa > ab;
            else if (sample_count(a) != sample_count(b)) better = sample_count(a) > sample_count(b);
            else better = a.provider_id < b.provider_id;
        } else {
            if (sample_count(a) != sample_count(b)) better = sample_count(a) > sample_count(b);
            else better = a.provider_id < b.provider_id;
        }
        if (better) best = idx;
    }
    return best;
}

double position_spread(const std::vector<Report>& reports, const std::vector<size_t>& group) {
    double worst = 0;
    for (size_t i = 0; i < group.size(); ++i) {
        for (size_t j = i + 1; j < group.size(); ++j) {
            worst = std::max(worst, haversine_m(reports[group[i]].latitude, reports[group[i]].longitude,
                                                reports[group[j]].latitude, reports[group[j]].longitude));
        }
    }
    return worst;
}

double confidence_of(const std::vector<Report>& reports, const std::vector<size_t>& group,
                     size_t consulted, double spread) {
    std::set<std::string> agreeing;
    for (size_t i : group) agreeing.insert(reports[i].provider_id);
    const double corroboration =
        consulted <= 1 ? 0.5
                       : 0.5 + 0.5 * (static_cast<double>(agreeing.size() - 1) /
                                      static_cast<double>(consulted - 1));
    const double dispersion = spread <= 0 ? 1.0 : std::max(0.0, 1.0 - spread / (kPositionToleranceM * 2));
    const double raw = std::min(1.0, corroboration * (0.6 + 0.4 * dispersion));
    return std::round(raw * 1000.0) / 1000.0;
}

// ── frame helpers ──────────────────────────────────────────────────────────
using Bytes = std::vector<uint8_t>;
namespace R = sdn::runtime;

int push_frame(const char* port, const char* schema, const char* identifier, const char* root,
               const uint8_t* data, size_t size) {
    return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0,
                                 data, static_cast<uint32_t>(size));
}

int push_tbs_stream(const char* port, const std::vector<uint8_t>& bytes) {
    return push_frame(port, "TBS.fbs", "$TBS", "TBS", bytes.data(), bytes.size());
}

int64_t now_ms() {
    struct timeval tv;
    if (gettimeofday(&tv, nullptr) != 0) return 0;
    return static_cast<int64_t>(tv.tv_sec) * 1000 + static_cast<int64_t>(tv.tv_usec / 1000);
}

// RFC 3339 UTC fixed-millisecond, the $TBS provenance timestamp form.
std::string iso_of_ms(uint64_t ms) {
    const time_t secs = static_cast<time_t>(ms / 1000);
    struct tm utc;
    if (gmtime_r(&secs, &utc) == nullptr) return std::string();
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", utc.tm_year + 1900,
                  utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec,
                  static_cast<int>(ms % 1000));
    return std::string(buf);
}

// Presence of a scalar the builder may have elided. The generated tables
// inherit flatbuffers::Table privately, so the check goes through the base.

const plugin_input_frame_t* frame_for(const char* port_id) {
    const int32_t idx = plugin_find_input_index(port_id, 0);
    return idx < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(idx));
}

// SURPLUS-FRAME REFUSAL on a single-stream port (graph task
// modules-guest-nodes-drop-batched-frames): the compiled runtime drains a
// node's queue port-blind, so two frames on one of these ports are refused by
// name rather than one of them silently destroyed.
bool refuse_batched(const char* port) {
    uint32_t on_port = 0;
    for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
        const plugin_input_frame_t* f = plugin_get_input_frame(i);
        if (f && f->port_id && std::strcmp(f->port_id, port) == 0) ++on_port;
    }
    if (on_port <= 1) return false;
    char message[256];
    std::snprintf(message, sizeof(message),
                  "This invocation carries %u frames on single-stream input port \"%s\"; the surplus is "
                  "refused rather than silently discarded.",
                  on_port, port);
    plugin_set_error("batched-input-frames", message);
    return true;
}

// ── the run contract ($APR) ────────────────────────────────────────────────
//
// The client's request, normalized once by `route` (or authored by the ingest
// planner) and carried in every provider HttpRequest's CONTEXT. Every later
// stage reads the APR instead of re-parsing the transport, and the stage that
// answers passes it on beside its answer — which is the APR's own design. Stage
// observations ride as RESPONSE_HEADERS: they are what the answer carries.
Bytes apr_bytes(const APRT& apr) {
    flatbuffers::FlatBufferBuilder b(1024);
    FinishAPRBuffer(b, APR::Pack(b, &apr));
    return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

// A record of a size-prefixed stream may have been written either way: Finish<X>Buffer then prefixed (its alignment
// is relative to its own first byte) or FinishSizePrefixed<X>Buffer (its alignment is relative to the PREFIX). The
// second fails the verifier when read from its first byte, so it is re-read as the prefix-inclusive buffer, copied to
// an 8-aligned scratch. Returns the record's root bytes (in `scratch` when re-aligned), or nullptr when it verifies
// neither way.
template <typename VerifyPlain, typename VerifyPrefixed>
const uint8_t* verified_record(const uint8_t* data, size_t size, std::vector<uint64_t>* scratch, VerifyPlain plain,
                               VerifyPrefixed prefixed) {
    {
        flatbuffers::Verifier v(data, size);
        if (plain(v)) return data;
    }
    scratch->assign((size + 4 + 7) / 8, 0);
    uint8_t* bytes = reinterpret_cast<uint8_t*>(scratch->data());
    const uint32_t n = static_cast<uint32_t>(size);
    bytes[0] = static_cast<uint8_t>(n);
    bytes[1] = static_cast<uint8_t>(n >> 8);
    bytes[2] = static_cast<uint8_t>(n >> 16);
    bytes[3] = static_cast<uint8_t>(n >> 24);
    std::memcpy(bytes + 4, data, size);
    flatbuffers::Verifier v(bytes, size + 4);
    return prefixed(v) ? bytes + 4 : nullptr;
}

std::unique_ptr<APRT> apr_unpack(const uint8_t* data, size_t size) {
    std::vector<uint64_t> scratch;
    const uint8_t* root = verified_record(
        data, size, &scratch, [](flatbuffers::Verifier& v) { return VerifyAPRBuffer(v); },
        [](flatbuffers::Verifier& v) { return VerifySizePrefixedAPRBuffer(v); });
    if (!root) return nullptr;
    return std::unique_ptr<APRT>(GetAPR(root)->UnPack());
}

std::string apr_param(const APRT& apr, const char* name, const std::string& fallback = std::string()) {
    for (const auto& p : apr.PARAMETERS)
        if (p && p->NAME == name) return p->VALUE;
    return fallback;
}

bool apr_has_param(const APRT& apr, const char* name) {
    for (const auto& p : apr.PARAMETERS)
        if (p && p->NAME == name) return true;
    return false;
}

void apr_add_param(APRT* apr, const std::string& name, const std::string& value) {
    auto p = std::make_unique<APRParameterT>();
    p->NAME = name;
    p->VALUE = value;
    apr->PARAMETERS.push_back(std::move(p));
}

void apr_drop_param(APRT* apr, const char* name) {
    auto& v = apr->PARAMETERS;
    v.erase(std::remove_if(v.begin(), v.end(), [&](const std::unique_ptr<APRParameterT>& p) { return p && p->NAME == name; }),
            v.end());
}

std::string apr_header(const APRT& apr, const char* name) {
    for (const auto& h : apr.RESPONSE_HEADERS)
        if (h && h->NAME == name) return h->VALUE;
    return std::string();
}

void apr_set_header(APRT* apr, const std::string& name, const std::string& value) {
    for (auto& h : apr->RESPONSE_HEADERS) {
        if (h && h->NAME == name) { h->VALUE = value; return; }
    }
    auto h = std::make_unique<APRParameterT>();
    h->NAME = name;
    h->VALUE = value;
    apr->RESPONSE_HEADERS.push_back(std::move(h));
}

int push_apr(const char* port, const APRT& apr) {
    const Bytes bytes = apr_bytes(apr);
    return push_frame(port, "APR.fbs", "$APR", "APR", bytes.data(), bytes.size());
}

std::vector<std::string> split_list(const std::string& text) {
    std::vector<std::string> out;
    std::string cur;
    for (size_t i = 0; i <= text.size(); ++i) {
        if (i == text.size() || text[i] == ',') {
            if (!cur.empty()) out.push_back(cur);
            cur.clear();
        } else {
            cur += text[i];
        }
    }
    return out;
}

// A CONTEXT stream: size-prefixed records, padded to 8 with zero-length prefixes.
void stream_append(Bytes* stream, const Bytes& record) {
    append_size_prefixed(stream, record.data(), record.size());
    while (stream->size() % 8) stream->insert(stream->end(), {0, 0, 0, 0});
}

bool has_identifier(const uint8_t* buf, size_t size, const char* id) {
    return size >= 8 && std::memcmp(buf + 4, id, 4) == 0;
}

// ── $HTQ request envelope ──────────────────────────────────────────────────
//
// The host is a DUMB PIPE (module-sdk schemas/HttpRequestAbi.fbs): it delivers
// exactly one $HTQ frame and streams back one $HTR. ALL HTTP semantics —
// routing, query parsing, content negotiation — live in here. That is also why
// this flow has ONE http trigger and dispatches on PATH internally: the host
// takes the FIRST http-request trigger and breaks (flowrt/httpmount.go:562-570),
// so a second trigger is silently unreachable rather than a second route.
struct Htq {
    std::string method, path, query, body, if_none_match, accept, content_type;
};

bool read_htq(const plugin_input_frame_t* frame, Htq* out) {
    if (!frame || !frame->payload || frame->payload_length < 8) return false;
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!sdn::http::HttpRequestBufferHasIdentifier(frame->payload) || !sdn::http::VerifyHttpRequestBuffer(verifier)) {
        return false;
    }
    const sdn::http::HttpRequest* r = sdn::http::GetHttpRequest(frame->payload);
    if (r->METHOD()) out->method = r->METHOD()->str();
    if (r->PATH()) out->path = r->PATH()->str();
    if (r->QUERY()) out->query = r->QUERY()->str();
    if (r->BODY()) out->body.assign(reinterpret_cast<const char*>(r->BODY()->data()), r->BODY()->size());
    if (const auto* headers = r->HEADERS()) {
        for (const auto* h : *headers) {
            if (!h || !h->NAME()) continue;
            std::string name = h->NAME()->str();
            for (char& c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            const std::string value = h->VALUE() ? h->VALUE()->str() : std::string();
            if (name == "if-none-match" && out->if_none_match.empty()) out->if_none_match = value;
            if (name == "accept" && out->accept.empty()) out->accept = value;
            if (name == "content-type" && out->content_type.empty()) out->content_type = value;
        }
    }
    return true;
}

aprMethod method_of(const std::string& m) {
    const std::string v = upper_ascii(m);
    if (v == "GET") return aprMethod_GET;
    if (v == "HEAD") return aprMethod_HEAD;
    if (v == "POST") return aprMethod_POST;
    if (v == "PUT") return aprMethod_PUT;
    if (v == "PATCH") return aprMethod_PATCH;
    if (v == "DELETE") return aprMethod_DELETE;
    if (v == "OPTIONS") return aprMethod_OPTIONS;
    return aprMethod_Unspecified;
}

// Representation, exactly as foundation/http-route decides it: ?format wins,
// then the Accept header, else the service default.
aprRepresentation representation_of(const Htq& h) {
    size_t at = 0;
    while (at <= h.query.size()) {
        size_t end = h.query.find('&', at);
        if (end == std::string::npos) end = h.query.size();
        const std::string pair = h.query.substr(at, end - at);
        const size_t eq = pair.find('=');
        if (eq != std::string::npos && url_decode(pair.substr(0, eq)) == "format") {
            std::string v = url_decode(pair.substr(eq + 1));
            for (char& c : v) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            if (v == "json") return aprRepresentation_Json;
            if (v == "flatbuffer" || v == "flatbuffers" || v == "fb") return aprRepresentation_FlatBuffer;
            if (!v.empty()) return aprRepresentation_Default;
        }
        at = end + 1;
    }
    std::string accept = h.accept;
    for (char& c : accept) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (accept.find("flatbuffers") != std::string::npos) return aprRepresentation_FlatBuffer;
    if (accept.find("application/json") != std::string::npos) return aprRepresentation_Json;
    return aprRepresentation_Default;
}

APRT base_apr(const Htq& h, const char* route) {
    APRT a;
    a.RECEIVED_AT_MS = now_ms();
    a.METHOD = method_of(h.method);
    a.PATH = h.path;
    a.ROUTE = route;
    a.SCHEMA_NAME = "TBS.fbs";
    a.ACCEPT = representation_of(h);
    a.IF_NONE_MATCH = h.if_none_match;
    a.CONTENT_TYPE = h.content_type;
    return a;
}

// $TBS encoding of a deconflicted site.
// SOURCES and CONSENSUS are `required` in the IDL, so both are always built.
// Optional scalars are only added when the source actually reported them:
// FlatBuffers omits default-valued fields, which is what keeps "the provider
// did not say" distinguishable from "the provider said zero".
void build_tbs_record(const std::vector<Report>& reports, const std::vector<size_t>& group,
                      size_t win, int8_t method, double lat, double lon, double spread,
                      uint32_t consulted, uint32_t agreeing, double confidence,
                      const std::string& stamp, std::vector<uint8_t>* out) {
    flatbuffers::FlatBufferBuilder b(2048);

    std::vector<flatbuffers::Offset<TBSProvenance>> sources;
    sources.reserve(group.size());
    for (size_t idx : group) {
        const Report& r = reports[idx];
        const ProviderSpec* spec = find_provider(r.provider_id);
        const auto provider_id = b.CreateString(r.provider_id);
        const auto retrieved_at = b.CreateString(stamp);
        const auto license = b.CreateString(spec ? spec->license : "unknown");
        const auto authority = spec ? b.CreateString(spec->authority) : 0;
        const auto source_url = spec ? b.CreateString(spec->url) : 0;
        const auto license_url = spec ? b.CreateString(spec->license_url) : 0;
        const auto attribution = spec ? b.CreateString(spec->attribution) : 0;
        const auto native_id = r.native_id.empty() ? 0 : b.CreateString(r.native_id);

        TBSProvenanceBuilder pb(b);
        pb.add_PROVIDER_ID(provider_id);
        pb.add_RETRIEVED_AT(retrieved_at);
        pb.add_LICENSE(license);
        if (authority.o) pb.add_AUTHORITY(authority);
        if (source_url.o) pb.add_SOURCE_URL(source_url);
        if (license_url.o) pb.add_LICENSE_URL(license_url);
        if (attribution.o) pb.add_ATTRIBUTION(attribution);
        if (native_id.o) pb.add_NATIVE_ID(native_id);
        pb.add_REPORTED_LATITUDE(r.latitude);
        pb.add_REPORTED_LONGITUDE(r.longitude);
        pb.add_CONTRIBUTED(idx == win);
        sources.push_back(pb.Finish());
    }
    const auto sources_vec = b.CreateVector(sources);

    const Report& w = reports[win];
    const auto winner_id = b.CreateString(w.provider_id);
    const auto merged_at = b.CreateString(stamp);
    TBSConsensusBuilder cb(b);
    cb.add_METHOD(static_cast<tbsMergeMethod>(method));
    cb.add_PROVIDERS_CONSULTED(consulted);
    cb.add_PROVIDERS_AGREEING(agreeing);
    cb.add_WINNING_PROVIDER_ID(winner_id);
    cb.add_POSITION_SPREAD_M(spread);
    cb.add_CONFIDENCE(confidence);
    cb.add_MERGED_AT(merged_at);
    const auto consensus = cb.Finish();

    // The site id is the WINNER's, so a site that keeps winning keeps its id
    // across runs and the globe does not churn between requests.
    const std::string site_id = w.provider_id + ":" + (w.cell_id.empty() ? "geo" : w.cell_id);
    const auto id = b.CreateString(site_id);
    const auto cell_id = w.cell_id.empty() ? 0 : b.CreateString(w.cell_id);
    const auto native_id = w.native_id.empty() ? 0 : b.CreateString(w.native_id);
    const auto site_name = w.site_name.empty() ? 0 : b.CreateString(w.site_name);
    const auto operator_name = w.operator_name.empty() ? 0 : b.CreateString(w.operator_name);
    const auto country_code = w.country_code.empty() ? 0 : b.CreateString(w.country_code);
    const auto last_observed =
        w.observed_at >= 0 ? b.CreateString(std::to_string(w.observed_at)) : 0;

    TBSBuilder tb(b);
    tb.add_ID(id);
    tb.add_RADIO(static_cast<tbsRadioClass>(w.radio));
    tb.add_LATITUDE(lat);
    tb.add_LONGITUDE(lon);
    if (native_id.o) tb.add_NATIVE_ID(native_id);
    if (w.mcc >= 0) tb.add_MCC(static_cast<uint32_t>(w.mcc));
    if (w.mnc >= 0) tb.add_MNC(static_cast<uint32_t>(w.mnc));
    if (w.lac >= 0) tb.add_LAC(static_cast<uint32_t>(w.lac));
    if (w.tac >= 0) tb.add_TAC(static_cast<uint32_t>(w.tac));
    if (cell_id.o) tb.add_CELL_ID(cell_id);
    if (w.range_m >= 0) tb.add_RANGE_M(w.range_m);
    if (w.samples >= 0) tb.add_SAMPLES(static_cast<uint32_t>(w.samples));
    if (w.has_signal) tb.add_AVERAGE_SIGNAL_DBM(w.average_signal_dbm);
    if (last_observed.o) tb.add_LAST_OBSERVED(last_observed);
    if (operator_name.o) tb.add_OPERATOR(operator_name);
    if (site_name.o) tb.add_SITE_NAME(site_name);
    if (country_code.o) tb.add_COUNTRY_CODE(country_code);
    tb.add_SOURCES(sources_vec);
    tb.add_CONSENSUS(consensus);
    FinishTBSBuffer(b, tb.Finish());

    out->assign(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

// ── the resume mark ($IRM) ─────────────────────────────────────────────────
//
// parse writes the next mark of a bulk (csv-gz) lane: the mark it was handed in
// CONTEXT, copied field for field, with the position, the state and the
// decoder at the new seam. Fields this node does not own are carried untouched.
flatbuffers::Offset<flatbuffers::String> copy_str(flatbuffers::FlatBufferBuilder& b, const flatbuffers::String* s) {
    return s ? b.CreateString(s->c_str(), s->size()) : 0;
}

flatbuffers::Offset<flatbuffers::Vector<uint8_t>> copy_bytes(flatbuffers::FlatBufferBuilder& b,
                                                             const flatbuffers::Vector<uint8_t>* v) {
    return v ? b.CreateVector(v->data(), v->size()) : 0;
}

Bytes build_resume_irm(const IRM* in, const std::string& provider, const std::string& source_url,
                       const BulkResume& resume, const std::string& header_line) {
    flatbuffers::FlatBufferBuilder b(2048 + resume.state.size() + resume.window.size() + resume.pending.size());
    const std::string stamp = iso_of_ms(static_cast<uint64_t>(now_ms()));

    // SOURCE
    const IRMSource* src = in ? in->SOURCE() : nullptr;
    const auto s_url = src && src->SOURCE_URL() ? copy_str(b, src->SOURCE_URL()) : b.CreateString(source_url);
    const auto s_obj = src ? copy_str(b, src->SOURCE_OBJECT_ID()) : 0;
    const auto s_cid = src ? copy_str(b, src->SOURCE_CID()) : 0;
    const auto s_media = src ? copy_str(b, src->MEDIA_TYPE()) : 0;
    const auto s_etag = src ? copy_str(b, src->ENTITY_TAG()) : 0;
    const auto s_lm = src ? copy_str(b, src->LAST_MODIFIED()) : 0;
    const auto s_sha = src ? copy_str(b, src->SOURCE_SHA256()) : 0;
    const auto s_ver = src ? copy_str(b, src->SOURCE_VERSION()) : 0;
    const auto s_vat = src ? copy_str(b, src->VALIDATED_AT()) : 0;
    IRMSourceBuilder sb(b);
    sb.add_SOURCE_URL(s_url);
    if (s_obj.o) sb.add_SOURCE_OBJECT_ID(s_obj);
    if (s_cid.o) sb.add_SOURCE_CID(s_cid);
    if (s_media.o) sb.add_MEDIA_TYPE(s_media);
    if (src) sb.add_TOTAL_BYTES(src->TOTAL_BYTES());
    if (s_etag.o) sb.add_ENTITY_TAG(s_etag);
    if (s_lm.o) sb.add_LAST_MODIFIED(s_lm);
    if (s_sha.o) sb.add_SOURCE_SHA256(s_sha);
    if (s_ver.o) sb.add_SOURCE_VERSION(s_ver);
    if (src) sb.add_VALIDATOR_MATCH(src->VALIDATOR_MATCH());
    if (s_vat.o) sb.add_VALIDATED_AT(s_vat);
    const auto source_off = sb.Finish();

    // DECODE_CONTEXT: the decoder at the new seam (only while resumable).
    const bool resumable = !resume.state.empty();
    const IRMDecodeContext* dc = in ? in->DECODE_CONTEXT() : nullptr;
    const auto d_format = b.CreateString("text/csv");
    const auto d_header = header_line.empty() ? 0 : b.CreateString(header_line);
    const auto d_compression = b.CreateString("gzip");
    flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<flatbuffers::String>>> d_columns = 0;
    if (dc && dc->COLUMN_NAMES()) {
        std::vector<flatbuffers::Offset<flatbuffers::String>> cols;
        for (const auto* c : *dc->COLUMN_NAMES()) cols.push_back(copy_str(b, c));
        d_columns = b.CreateVector(cols);
    }
    const auto d_delim = dc ? copy_str(b, dc->DELIMITER()) : 0;
    const auto d_quote = dc ? copy_str(b, dc->QUOTE()) : 0;
    const auto d_escape = dc ? copy_str(b, dc->ESCAPE()) : 0;
    const auto d_term = dc ? copy_str(b, dc->LINE_TERMINATOR()) : 0;
    const auto d_charset = dc ? copy_str(b, dc->CHARSET()) : 0;
    flatbuffers::Offset<flatbuffers::Vector<uint8_t>> d_state = 0, d_window = 0, d_partial = 0;
    flatbuffers::Offset<flatbuffers::String> d_sfmt = 0, d_sver = 0, d_build = 0, d_smedia = 0;
    if (resumable) {
        d_state = b.CreateVector(reinterpret_cast<const uint8_t*>(resume.state.data()), resume.state.size());
        d_window = b.CreateVector(reinterpret_cast<const uint8_t*>(resume.window.data()), resume.window.size());
        d_partial = b.CreateVector(reinterpret_cast<const uint8_t*>(resume.pending.data()), resume.pending.size());
        d_sfmt = b.CreateString(kDecoderStateFormat);
        d_sver = b.CreateString(kDecoderStateVersion);
        d_build = b.CreateString(kDecoderBuildId);
        d_smedia = b.CreateString(kDecoderStateMediaType);
    }
    IRMDecodeContextBuilder db(b);
    db.add_FORMAT(d_format);
    if (d_header.o) {
        db.add_HEADER_LINE(d_header);
        db.add_HEADER_BYTE_LENGTH(static_cast<uint64_t>(header_line.size()));
    }
    if (d_columns.o) db.add_COLUMN_NAMES(d_columns);
    if (d_delim.o) db.add_DELIMITER(d_delim);
    if (d_quote.o) db.add_QUOTE(d_quote);
    if (d_escape.o) db.add_ESCAPE(d_escape);
    if (d_term.o) db.add_LINE_TERMINATOR(d_term);
    if (d_charset.o) db.add_CHARSET(d_charset);
    db.add_COMPRESSION(d_compression);
    if (resumable) {
        db.add_DECODER_STATE(d_state);
        db.add_DECODER_STATE_FORMAT(d_sfmt);
        db.add_DECODER_STATE_VERSION(d_sver);
        db.add_DECODER_STATE_BYTE_LENGTH(static_cast<uint64_t>(resume.state.size()));
        db.add_DECODER_BUILD_ID(d_build);
        db.add_DECODER_STATE_MEDIA_TYPE(d_smedia);
        db.add_WINDOW(d_window);
        db.add_WINDOW_BYTE_LENGTH(static_cast<uint64_t>(resume.window.size()));
        db.add_WINDOW_POSITION(resume.window_pos);
        db.add_PARTIAL_RECORD(d_partial);
    }
    const auto decode_off = db.Finish();

    // LAST_CHUNK: the chunk this mark was advanced from.
    const IRMChunk* lc = in ? in->LAST_CHUNK() : nullptr;
    const auto c_batch = lc ? copy_str(b, lc->BATCH_ID()) : 0;
    IRMChunkBuilder cb(b);
    cb.add_CHUNK_INDEX(in ? in->NEXT_CHUNK_INDEX() : 0);
    if (c_batch.o) cb.add_BATCH_ID(c_batch);
    cb.add_RANGE_FIRST_BYTE(in ? in->NEXT_OFFSET() : 0);
    cb.add_RECORDS_DECODED(static_cast<uint32_t>(resume.rows_seen));
    const auto chunk_off = cb.Finish();

    // FAULT, carried.
    flatbuffers::Offset<IRMFault> fault_off = 0;
    if (in && in->FAULT()) {
        const IRMFault* f = in->FAULT();
        const auto code = f->CODE() ? copy_str(b, f->CODE()) : b.CreateString("");
        const auto msg = copy_str(b, f->MESSAGE());
        const auto at = copy_str(b, f->OCCURRED_AT());
        const auto retry = copy_str(b, f->RETRY_NOT_BEFORE());
        IRMFaultBuilder fb(b);
        fb.add_CODE(code);
        if (msg.o) fb.add_MESSAGE(msg);
        fb.add_CHUNK_INDEX(f->CHUNK_INDEX());
        fb.add_CONSECUTIVE_FAILURES(f->CONSECUTIVE_FAILURES());
        if (at.o) fb.add_OCCURRED_AT(at);
        if (retry.o) fb.add_RETRY_NOT_BEFORE(retry);
        fault_off = fb.Finish();
    }

    const auto job_id = in && in->JOB_ID() ? copy_str(b, in->JOB_ID()) : b.CreateString(provider + "@" + source_url);
    const auto provider_off = in && in->PROVIDER_ID() ? copy_str(b, in->PROVIDER_ID()) : b.CreateString(provider);
    const auto ingestor = in && in->INGESTOR_ID() ? copy_str(b, in->INGESTOR_ID()) : b.CreateString("cell-tower-source");
    const auto target = in ? copy_str(b, in->TARGET_STANDARD()) : 0;
    const auto reconcile = in ? copy_str(b, in->RECONCILE_MODE()) : 0;
    const auto merge = in ? copy_str(b, in->MERGE_POLICY()) : 0;
    const auto created = in ? copy_str(b, in->CREATED_AT()) : 0;
    const auto started = in ? copy_str(b, in->STARTED_AT()) : 0;
    const auto updated = b.CreateString(stamp);
    const auto completed = resume.complete ? b.CreateString(stamp) : (in ? copy_str(b, in->COMPLETED_AT()) : 0);
    const auto expires = in ? copy_str(b, in->EXPIRES_AT()) : 0;
    const auto notes = in ? copy_str(b, in->NOTES()) : 0;
    flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<flatbuffers::String>>> tags = 0;
    if (in && in->TAGS()) {
        std::vector<flatbuffers::Offset<flatbuffers::String>> t;
        for (const auto* s : *in->TAGS()) t.push_back(copy_str(b, s));
        tags = b.CreateVector(t);
    }

    IRMBuilder ib(b);
    ib.add_JOB_ID(job_id);
    ib.add_SEQUENCE(in ? in->SEQUENCE() : 0);
    ib.add_PROVIDER_ID(provider_off);
    ib.add_INGESTOR_ID(ingestor);
    ib.add_SOURCE(source_off);
    ib.add_STATE(resume.complete ? irmJobState_COMPLETE : irmJobState_IN_PROGRESS);
    ib.add_RANGE_MODE(in ? in->RANGE_MODE() : irmRangeMode_INCLUSIVE_BYTE_RANGE);
    ib.add_NEXT_OFFSET(resume.next_byte);
    ib.add_NEXT_CHUNK_INDEX(in ? in->NEXT_CHUNK_INDEX() : 0);
    if (in) ib.add_CHUNK_BYTE_BUDGET(in->CHUNK_BYTE_BUDGET());
    ib.add_DECODE_CONTEXT(decode_off);
    ib.add_LAST_CHUNK(chunk_off);
    if (in) {
        ib.add_CHUNKS_COMMITTED(in->CHUNKS_COMMITTED());
        ib.add_BYTES_COMMITTED(in->BYTES_COMMITTED());
        ib.add_RECORDS_COMMITTED(in->RECORDS_COMMITTED());
    }
    if (target.o) ib.add_TARGET_STANDARD(target);
    if (reconcile.o) ib.add_RECONCILE_MODE(reconcile);
    if (merge.o) ib.add_MERGE_POLICY(merge);
    if (fault_off.o) ib.add_FAULT(fault_off);
    if (created.o) ib.add_CREATED_AT(created);
    if (started.o) ib.add_STARTED_AT(started);
    ib.add_UPDATED_AT(updated);
    if (completed.o) ib.add_COMPLETED_AT(completed);
    if (expires.o) ib.add_EXPIRES_AT(expires);
    if (tags.o) ib.add_TAGS(tags);
    if (notes.o) ib.add_NOTES(notes);
    FinishIRMBuffer(b, ib.Finish());
    return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

// ---------------------------------------------------------------------------
// Credential lanes.
//
// The lane id is derived, never supplied by the caller: `cell_<providerId>`
// where the provider id came out of THIS module's compiled registry. A caller
// therefore cannot name a lane — it names a provider, and an unknown provider
// is refused before any host call. That is what stops a request from reaching
// `secrets:spacetrack` or any other operator lane through this route, whatever
// the policy rows happen to say.
// ---------------------------------------------------------------------------
std::string credential_lane(const std::string& provider_id) {
    return "cell_" + provider_id;
}

// ---------------------------------------------------------------------------
// catalog: the provider list this node can actually reach, as a $QRP
// projection page (one row per provider) for the credential mediator.
//
// The GUI calls this FIRST and renders exactly what it is told, so the catalog
// is the module's, never a list compiled into the page. It reports each
// provider's access posture and whether a credential is currently held, so the
// page can disable what it cannot use instead of offering a control that fails.
//
// It reports NO credential values and no key material — only whether a lane is
// configured, and that is FALSE HERE BY CONSTRUCTION: this plugin holds no
// credential capability and must not (`secrets.status` has no browser-host
// implementation). The credential MEDIATOR — the wasmedge-only sibling that the
// operator grants secrets/keyslot to — flips credentialConfigured per lane and
// fills the keySlot cells. The three keySlot cells are Null here: this node
// never invents a key slot.
// ---------------------------------------------------------------------------
std::unique_ptr<QRPValueT> qv_text(const std::string& v) {
    auto q = std::make_unique<QRPValueT>();
    q->KIND = qrpValueKind_Text;
    q->TEXT_VALUE = v;
    return q;
}
std::unique_ptr<QRPValueT> qv_bool(bool v) {
    auto q = std::make_unique<QRPValueT>();
    q->KIND = qrpValueKind_Bool;
    q->BOOL_VALUE = v;
    return q;
}
std::unique_ptr<QRPValueT> qv_null() {
    auto q = std::make_unique<QRPValueT>();
    q->KIND = qrpValueKind_Null;
    return q;
}

int emit_catalog(const Htq& h) {
    QRPT page;
    page.KIND = qrpKind_Page;
    page.STATUS = qrpStatus_Ok;
    page.REPRESENTATION = static_cast<qrpRepresentation>(representation_of(h));
    page.GENERATED_AT_MS = now_ms();
    static const char* kColumns[][2] = {
        {"id", "string"}, {"name", "string"}, {"authority", "string"}, {"license", "string"},
        {"attribution", "string"}, {"credentialRequired", "bool"}, {"credentialConfigured", "bool"},
        {"credentialLane", "string"}, {"authoritative", "bool"}, {"defaultSelected", "bool"},
        {"methods", "string"}, {"keySlotId", "string"}, {"keySlotPublicKey", "bytes"},
        {"keySlotAlgorithm", "string"}};
    for (const auto& c : kColumns) {
        auto col = std::make_unique<QRPColumnT>();
        col->NAME = c[0];
        col->TYPE = c[1];
        page.COLUMNS.push_back(std::move(col));
    }
    const std::string methods = "SINGLE_SOURCE,HIGHEST_SAMPLE_COUNT,MOST_RECENT,AUTHORITY_PRECEDENCE,CENTROID";
    for (size_t i = 0; i < kProviderCount; ++i) {
        const ProviderSpec& p = kProviders[i];
        auto row = std::make_unique<QRPRowT>();
        row->CELLS.push_back(qv_text(p.id));
        row->CELLS.push_back(qv_text(p.authority));
        row->CELLS.push_back(qv_text(p.authority));
        row->CELLS.push_back(qv_text(p.license));
        row->CELLS.push_back(qv_text(p.attribution));
        row->CELLS.push_back(qv_bool(p.login_required));
        row->CELLS.push_back(qv_bool(false));
        row->CELLS.push_back(qv_text(credential_lane(p.id)));
        row->CELLS.push_back(qv_bool(p.authoritative));
        // A provider needing a login is not pre-ticked: offering it would
        // produce a run that silently skips it. The mediator flips this too,
        // for a provider whose credential IS held.
        row->CELLS.push_back(qv_bool(!p.login_required));
        row->CELLS.push_back(qv_text(methods));
        row->CELLS.push_back(qv_null());
        row->CELLS.push_back(qv_null());
        row->CELLS.push_back(qv_null());
        page.ROWS.push_back(std::move(row));
    }
    flatbuffers::FlatBufferBuilder b(4096);
    FinishSizePrefixedQRPBuffer(b, QRP::Pack(b, &page));
    Bytes stream(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    while (stream.size() % 8) stream.insert(stream.end(), {0, 0, 0, 0});
    // THE CATALOG IS NOT ANSWERED FROM HERE. It goes to the credential
    // mediator, which can ask the host for the wrapping key slot and the
    // per-lane configured flags, and which owns the reply. Answering here as
    // well would race two bodies into one responder.
    return push_frame("catalog", "QRP.fbs", "$QRP", "QRP", stream.data(), stream.size()) < 0 ? 500 : 0;
}

// A REFUSAL is the request's $APR with STATUS + ERROR_CODE + ERROR_MESSAGE, for
// foundation/http-respond's `respond` (it answers the status itself).
int emit_refusal(APRT apr, uint16_t status, const char* code, const std::string& message) {
    apr.STATUS = status;
    apr.ERROR_CODE = code;
    apr.ERROR_MESSAGE = message;
    return push_apr("decision", apr) < 0 ? 500 : 0;
}

// PUT|DELETE /credentials/<providerId>. The lane id is DERIVED, never supplied:
// `cell_<providerId>` where the provider id came out of THIS module's compiled
// registry. A caller therefore cannot name a lane — it names a provider, and an
// unknown provider is refused right here, before anything with a capability
// sees it.
int dispatch_credential(const Htq& h, const std::string& verb, const std::string& provider_id) {
    const ProviderSpec* spec = find_provider(provider_id);
    APRT apr = base_apr(h, verb == "DELETE" ? "credential-clear" : "credential-put");
    if (!spec) {
        return emit_refusal(std::move(apr), 404, "unknown-provider",
                            "no provider \"" + provider_id + "\" in this node's registry");
    }
    if (!spec->login_required) {
        return emit_refusal(std::move(apr), 400, "credential-not-required",
                            std::string("provider \"") + spec->id +
                                "\" is reachable without a login; it has no credential lane");
    }
    apr.METHOD = verb == "DELETE" ? aprMethod_DELETE : aprMethod_PUT;
    apr_add_param(&apr, "providerId", spec->id);
    apr_add_param(&apr, "credentialLane", credential_lane(spec->id));
    // The body is the browser's keyslot envelope, verbatim. It is NOT parsed
    // here: this node cannot open it and has no business inspecting it. It is
    // forwarded whole to the one node that can.
    if (verb != "DELETE") apr.BODY.assign(h.body.begin(), h.body.end());
    return push_apr("credential", apr) < 0 ? 500 : 0;
}

struct Descriptor {
    std::string provider_id;
    std::string method;
    std::string url;
    std::vector<std::pair<std::string, std::string>> headers;
    std::string body;
    uint32_t timeout_ms = 40000;
    std::string credential_lane;
};

Bytes http_request(const Descriptor& d, const Bytes& context) {
    flatbuffers::FlatBufferBuilder b(1024 + context.size() + d.body.size());
    auto headers = d.headers;
    std::sort(headers.begin(), headers.end());
    std::vector<flatbuffers::Offset<R::Header>> header_offsets;
    for (const auto& kv : headers) header_offsets.push_back(R::CreateHeaderDirect(b, kv.first.c_str(), kv.second.c_str()));
    const std::vector<uint8_t> body(d.body.begin(), d.body.end());
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, d.method.c_str(), d.url.c_str(), &header_offsets,
                                                             d.body.empty() ? nullptr : &body, d.timeout_ms, 0,
                                                             &context));
    return Bytes(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// route: one $HTQ request -> N provider HttpRequests (each carrying the run
// contract $APR in CONTEXT), or a refusal, or a hand-off to the mediator.
//
// The provider set and merge method are read from the REQUEST, never from node
// config, so two viewers can ask for different things at the same time without
// either of them changing what the node is.
// ---------------------------------------------------------------------------
int route(void) {
    if (refuse_batched("request")) return 500;
    const plugin_input_frame_t* frame = frame_for("request");
    Htq h;
    if (!read_htq(frame, &h)) {
        APRT apr;
        apr.RECEIVED_AT_MS = now_ms();
        apr.SCHEMA_NAME = "TBS.fbs";
        return emit_refusal(std::move(apr), 400, "bad-envelope",
                            "request envelope is not a readable $HTQ frame");
    }
    const std::string method_verb = upper_ascii(h.method);
    const std::string& path = h.path;
    const std::string& body = h.body;

    // ONE trigger, dispatched here. The catalog read, the credential lane and
    // the aggregation are three routes of one flow, because the host mounts one
    // trigger per flow.
    if (path.size() >= 10 && path.compare(path.size() - 10, 10, "/providers") == 0) {
        return emit_catalog(h);
    }

    // /credentials/<providerId>. Matched on the SEGMENT, not with a suffix
    // test: "/credentials" with no provider must be a 404, never a prefix match
    // that silently addresses whatever the last segment happens to be.
    {
        constexpr const char* kCredentialsSegment = "/credentials/";
        const size_t at = path.rfind(kCredentialsSegment);
        if (at != std::string::npos) {
            const std::string provider_id =
                url_decode(path.substr(at + std::strlen(kCredentialsSegment)));
            if (provider_id.empty() || provider_id.find('/') != std::string::npos) {
                return emit_refusal(
                    base_apr(h, "credential-put"), 404, "no-provider",
                    "the credential route addresses one provider: /credentials/<providerId>");
            }
            if (method_verb == "PUT" || method_verb == "POST" || method_verb == "DELETE") {
                return dispatch_credential(h, method_verb == "DELETE" ? "DELETE" : "PUT", provider_id);
            }
            return emit_refusal(
                base_apr(h, "credential-put"), 405, "method-not-allowed",
                "the credential route takes PUT (store) and DELETE (clear); a credential is "
                "never readable back");
        }
    }

    APRT apr = base_apr(h, "aggregate");
    std::vector<std::string> wanted = json_string_array(body, "PROVIDERS");
    const std::string method_name = json_string(body, "METHOD", "HIGHEST_SAMPLE_COUNT");
    const double limit = json_number(body, "LIMIT", 2000);
    // THE RECEIVED PARAMETERS, in the contract every later stage reads.
    {
        std::string raw;
        if (json_raw_field(body, "PROVIDERS", &raw)) {
            std::string joined;
            for (size_t i = 0; i < wanted.size(); ++i) joined += (i ? "," : "") + wanted[i];
            apr_add_param(&apr, "PROVIDERS", joined);
        }
        if (json_raw_field(body, "METHOD", &raw)) apr_add_param(&apr, "METHOD", method_name);
        if (json_raw_field(body, "LIMIT", &raw)) {
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%.0f", limit);
            apr_add_param(&apr, "LIMIT", buf);
        }
        if (json_raw_field(body, "FULL_POPULATION", &raw))
            apr_add_param(&apr, "FULL_POPULATION", json_bool(body, "FULL_POPULATION", false) ? "true" : "false");
        if (json_raw_field(body, "CREDENTIAL_MEDIATOR", &raw))
            apr_add_param(&apr, "CREDENTIAL_MEDIATOR", json_bool(body, "CREDENTIAL_MEDIATOR", false) ? "true" : "false");
        if (json_raw_field(body, "BBOX", &raw)) {
            std::string parts[4];
            const char* keys[4] = {"south", "west", "north", "east"};
            std::string joined;
            for (int k = 0; k < 4; ++k) {
                json_raw_field(raw, keys[k], &parts[k]);
                joined += (k ? "," : "") + parts[k];
            }
            apr_add_param(&apr, "BBOX", joined);
        }
        if (json_raw_field(body, "REFRESH", &raw))
            apr_add_param(&apr, "REFRESH", json_bool(body, "REFRESH", false) ? "true" : "false");
    }
    // THE INGEST LANE. Opt-in, never a default.
    //
    // Every cap below this line exists to bound what an ANONYMOUS caller can
    // make this node fetch and merge, and together they are why the BAKOM lane
    // answered a worldwide request with ~364 of 22,347 Swiss sites: route asked
    // for a 2 MiB Range, parse stopped decoding at the per-provider row cap, and
    // deconflict stopped writing at LIMIT. FULL_POPULATION is the ingest path
    // saying "I am not a page; give me the whole register." It lifts all three
    // caps, and a capped run SAYS it was capped (x-sdn-truncated).
    const bool full_population = json_bool(body, "FULL_POPULATION", false);

    // THE CREDENTIAL MEDIATOR IS WIRED. Opt-in, never a default. A caller that
    // sets this is asserting that a `cell-tower-credentials` node sits between
    // this one and the http node and will substitute `{{credential}}` before
    // anything is fetched.
    const bool credential_mediator = json_bool(body, "CREDENTIAL_MEDIATOR", false);

    // BBOX in Overpass order (south,west,north,east).
    //
    // THE DEFAULT IS THE WHOLE PLANET (owner 2026-08-10: "should not be
    // viewport, should just be world-wide"). A DEFAULT WHICH CROPS IS
    // INDISTINGUISHABLE FROM A COMPLETE ANSWER, so providers that cannot serve an
    // unbounded region are skipped and SAY so rather than being given a
    // substitute box.
    double bb_south = -90.0, bb_west = -180.0, bb_north = 90.0, bb_east = 180.0;
    bool bbox_named = false;
    const std::string bbox_raw = json_string(body, "BBOX", "");
    if (!bbox_raw.empty()) {
        const double south = json_number(bbox_raw, "south", 1e9);
        const double west = json_number(bbox_raw, "west", 1e9);
        const double north = json_number(bbox_raw, "north", 1e9);
        const double east = json_number(bbox_raw, "east", 1e9);
        // An INVERTED box is rejected rather than compiled into a filter that
        // matches nothing: `between 30 and 29` is valid SQL and returns zero
        // rows, which reads exactly like an empty region.
        if (south <= 90 && west <= 180 && north <= 90 && east <= 180 && south < north && west < east) {
            bb_south = south; bb_west = west; bb_north = north; bb_east = east;
            bbox_named = true;
        }
    }
    const bool worldwide =
        !bbox_named || (bb_north - bb_south > 170.0 && bb_east - bb_west > 340.0);
    auto fmt_coord = [](double v) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.6f", v);
        return std::string(buf);
    };
    const std::string bbox = fmt_coord(bb_south) + "," + fmt_coord(bb_west) + "," +
                             fmt_coord(bb_north) + "," + fmt_coord(bb_east);

    int8_t method = MM_HIGHEST_SAMPLE_COUNT;
    if (method_name == "SINGLE_SOURCE") method = MM_SINGLE_SOURCE;
    else if (method_name == "MOST_RECENT") method = MM_MOST_RECENT;
    else if (method_name == "AUTHORITY_PRECEDENCE") method = MM_AUTHORITY_PRECEDENCE;
    else if (method_name == "CENTROID") method = MM_CENTROID;
    else if (method_name == "HIGHEST_SAMPLE_COUNT") method = MM_HIGHEST_SAMPLE_COUNT;
    else {
        // An unknown strategy is REFUSED, never silently defaulted: answering a
        // question the caller did not ask, under a name they chose, is worse
        // than saying no.
        return emit_refusal(std::move(apr), 400, "unknown-method", "unknown METHOD \"" + method_name + "\"");
    }
    (void)method;

    if (wanted.empty()) {
        return emit_refusal(std::move(apr), 400, "no-providers", "PROVIDERS must name at least one provider");
    }

    std::vector<Descriptor> descriptors;
    std::string consulted, skipped;
    size_t emitted = 0;
    auto skip = [&](const std::string& id, const char* code) {
        skipped += (skipped.empty() ? "" : ",") + id + "=" + code;
    };
    for (const std::string& id : wanted) {
        const ProviderSpec* spec = find_provider(id);
        if (!spec) { skip(id, "unknown-provider"); continue; }
        // A provider whose real endpoint this module cannot decode yet is
        // skipped WITH THE MISSING CAPABILITY NAMED, never fetched.
        if (std::strcmp(spec->lane, "unavailable") == 0) { skip(spec->id, "unavailable"); continue; }
        // A bounded-region provider cannot answer a worldwide request. Say so
        // instead of substituting a region the caller never asked for.
        if (worldwide && std::strcmp(spec->lane, "query") == 0 && !spec->login_required) {
            skip(spec->id, "needs-region");
            continue;
        }
        // FAIL CLOSED ON THE WIRING, not on the credential. The credentialed
        // descriptor leaves here with `{{credential}}` UNSUBSTITUTED (this module
        // holds no secrets capability) and the mediator completes it — so it is
        // emitted ONLY when the caller declares the mediator is wired. Fetched
        // verbatim, OpenCelliD answers 200 INVALID_TOKEN: quota spent for zero rows.
        if (spec->login_required && !credential_mediator) { skip(spec->id, "needs-mediator"); continue; }
        if (emitted++) consulted += ",";
        consulted += spec->id;

        // Primary plus mirrors, fetched in the SAME run (a flow node has no state
        // between invocations to remember where a retry got to). All carry the
        // SAME provider id, so they count as one provider consulted and their
        // overlapping rows collapse in deconfliction.
        std::vector<std::string> urls;
        urls.push_back(spec->url);
        for (size_t m = 0; m < 3; ++m) {
            if (spec->mirrors[m] && spec->mirrors[m][0]) urls.push_back(spec->mirrors[m]);
        }

        // Per-provider row cap at the EXPENSIVE end (fetch + merge).
        double rows = limit;
        if (rows < 1) rows = 1;
        if (rows > 1000 && !full_population) rows = 1000;
        char rows_buf[16];
        std::snprintf(rows_buf, sizeof(rows_buf), "%.0f", rows);

        for (const std::string& base : urls) {
            Descriptor d;
            d.provider_id = spec->id;
            std::string url = base;
            if (spec->query_template && spec->query_template[0]) {
                std::string q = spec->query_template;
                substitute_all(&q, "{{bbox}}", bbox);
                substitute_all(&q, "{{south}}", fmt_coord(bb_south));
                substitute_all(&q, "{{west}}", fmt_coord(bb_west));
                substitute_all(&q, "{{north}}", fmt_coord(bb_north));
                substitute_all(&q, "{{east}}", fmt_coord(bb_east));
                substitute_all(&q, "{{limit}}", rows_buf);
                if (std::strcmp(spec->query_kind, "overpass") == 0) {
                    url += "?data=" + url_encode(q);
                } else if (std::strcmp(spec->query_kind, "opencellid") == 0 ||
                           std::strcmp(spec->query_kind, "opencellid-bulk") == 0) {
                    // The template is ALREADY in `name=value&...` form, so it is
                    // appended whole; `{{credential}}` stays for the mediator.
                    // BBOX ORDER: OpenCelliD's lat,lon,lat,lon is the same
                    // latmin,lonmin,latmax,lonmax as everyone's south,west,north,east.
                    url += "?" + q;
                } else if (std::strcmp(spec->query_kind, "soql") == 0) {
                    // `$where`/`$limit` are the API's own parameter NAMES and
                    // stay literal; only the filter value is encoded.
                    url += "?$where=" + url_encode(q) + "&$limit=" + rows_buf;
                }
            }
            d.url = url;
            // ComReg's SiteViewer is a POST-only RPC that returns the national
            // mast list for an empty JSON body: verb and body are its contract.
            const bool post_json = std::strcmp(spec->query_kind, "post-json") == 0;
            d.method = post_json ? "POST" : "GET";
            // ComReg always answers protobuf, so the honest Accept says what the
            // module will decode.
            d.headers.push_back({"accept", std::strcmp(spec->format, "comreg-protobuf") == 0
                                               ? "application/x-protobuf"
                                               : "application/json"});
            d.headers.push_back({"user-agent", "spacedatanetwork-cell-tower-source/0.2"});
            // The 2 MiB Range prefix is the anonymous lane's bandwidth bound on
            // BAKOM's one national FeatureCollection; the ingest lane fetches the
            // whole asset. A ZIP never gets a prefix (its directory is at the END).
            if (std::strcmp(spec->format, "swiss-geojson") == 0 && !full_population) {
                d.headers.push_back({"range", "bytes=0-2097151"});
            }
            // THE BULK gzip CHUNK WINDOW: a gzip is a forward stream, so a PREFIX
            // is always decodable. The request-scoped lane reads the export's
            // first 32 MiB window; continuation past it is the ingest lane's
            // durable $IRM resume mark, not a request parameter.
            if (std::strcmp(spec->format, "csv-gz") == 0) {
                constexpr long long kBulkChunkBytes = 32ll * 1024 * 1024;
                char window[64];
                std::snprintf(window, sizeof(window), "bytes=0-%lld", kBulkChunkBytes - 1);
                d.headers.push_back({"range", window});
            }
            if (post_json) {
                d.headers.push_back({"content-type", "application/json"});
                d.body = spec->query_template && spec->query_template[0] ? spec->query_template : "{}";
            }
            d.timeout_ms = full_population ? 300000 : 40000;
            // THE MEDIATOR'S MARK: a URL still carrying `{{credential}}` names the
            // lane that fills it (in CONTEXT), so the mediator needs no registry.
            if (spec->login_required) d.credential_lane = credential_lane(spec->id);
            descriptors.push_back(std::move(d));
        }
    }

    if (!consulted.empty()) apr_set_header(&apr, "x-sdn-providers-consulted", consulted);
    if (!skipped.empty()) apr_set_header(&apr, "x-sdn-providers-skipped", skipped);

    // ZERO FETCHABLE PROVIDERS — ANSWER, never start the pipeline: parse's
    // `responses` would never fill and the chain would stall into a silent 502.
    // The request was valid and the honest answer is an empty dataset WITH the
    // reasons (x-sdn-providers-skipped).
    if (descriptors.empty()) {
        apr_set_header(&apr, "x-sdn-sites-out", "0");
        if (push_apr("decision", apr) < 0) return 500;
        DAVT dav;
        dav.STANDARD = "TBS";
        dav.SCHEMA_NAME = "TBS.fbs";
        dav.SOURCE_NAME = "cellular-aggregate";
        dav.KNOWN = true;
        dav.AVAILABLE = true;
        dav.FRESH = true;
        dav.RECORD_COUNT = 0;
        dav.PUBLISHED_AT_MS = now_ms();
        flatbuffers::FlatBufferBuilder b(512);
        FinishDAVBuffer(b, DAV::Pack(b, &dav));
        return push_frame("availability", "DAV.fbs", "$DAV", "DAV", b.GetBufferPointer(), b.GetSize()) < 0 ? 500 : 0;
    }

    // ONE HttpRequest PER DESCRIPTOR, each carrying the run contract with the
    // fetch's own provider bound in CONTEXT. hostcap/http-request echoes CONTEXT
    // on every answer (failures included), so parse attributes a body by what
    // the frame SAYS, never by its position in the queue.
    const std::string fetches = std::to_string(descriptors.size());
    for (const Descriptor& d : descriptors) {
        APRT copy;
        GetAPR(apr_bytes(apr).data())->UnPackTo(&copy);
        apr_add_param(&copy, "provider", d.provider_id);
        apr_add_param(&copy, "fetches", fetches);
        if (!d.credential_lane.empty()) apr_add_param(&copy, "credentialLane", d.credential_lane);
        Bytes context;
        stream_append(&context, apr_bytes(copy));
        const Bytes request = http_request(d, context);
        if (push_frame("requests", "HttpRequest.fbs", "HREQ", "HttpRequest", request.data(), request.size()) < 0) {
            return 500;
        }
    }
    return 0;
}

// ---------------------------------------------------------------------------
// parse: N HttpResponses (each carrying its run contract in CONTEXT) ->
// normalized reports ($TBS SINGLE_SOURCE stream), the contract, and the bulk
// lane's next resume mark.
//
// parse is a FAN-IN node, and the run does not fit in one invocation: it is
// invoked as soon as ONE response is queued. So the run accumulates across
// invocations and is emitted ONCE: when every fetch of the run (the contract's
// "fetches") is accounted for, or — the backstop — on a quiet tick
// (plugin_set_yielded + backlog_remaining make this node ready again with an
// empty queue; an invocation that brings no new frame means nothing further is
// coming). State resets after that one emission, so a pooled instance never
// carries a run into the next.
// ---------------------------------------------------------------------------
static Bytes g_job;                   // the run contract, as the first response carried it
static Bytes g_irm;                   // the resume mark the run continues (ingest lane)
static size_t g_irm_base = 0;         // its root's offset in g_irm (4 when kept with its size prefix)
static std::vector<std::string> g_providers_consulted;
static std::vector<Report> g_reports;
static std::vector<std::string> g_report_retrieved;  // parallel to g_reports
static size_t g_response_cursor = 0;
static size_t g_expected = 0;
static bool g_have_job = false;
static bool g_row_capped = false;
static bool g_full_population = false;
static size_t g_provider_row_cap = SIZE_MAX;
static std::string g_csv_header;
static std::string g_bulk_provider;
static std::string g_bulk_url;
static BulkResume g_bulk_resume;
static uint32_t g_idle_ticks = 0;

void reset_run_state(void) {
    g_job.clear();
    g_irm.clear();
    g_irm_base = 0;
    g_providers_consulted.clear();
    g_reports.clear();
    g_report_retrieved.clear();
    g_response_cursor = 0;
    g_expected = 0;
    g_have_job = false;
    g_row_capped = false;
    g_full_population = false;
    g_provider_row_cap = SIZE_MAX;
    g_csv_header.clear();
    g_bulk_provider.clear();
    g_bulk_url.clear();
    g_bulk_resume = BulkResume();
    g_idle_ticks = 0;
}

// Adopt the resume mark a fetch continues ($IRM in CONTEXT).
void adopt_irm(const IRM* irm) {
    g_bulk_resume = BulkResume();
    g_bulk_resume.next_byte = irm->NEXT_OFFSET();
    g_bulk_resume.complete = irm->STATE() == irmJobState_COMPLETE;
    if (const IRMDecodeContext* dc = irm->DECODE_CONTEXT()) {
        if (dc->HEADER_LINE()) g_csv_header = dc->HEADER_LINE()->str();
        if (dc->DECODER_STATE() && dc->DECODER_STATE()->size()) {
            g_bulk_resume.state.assign(reinterpret_cast<const char*>(dc->DECODER_STATE()->data()),
                                       dc->DECODER_STATE()->size());
            if (dc->WINDOW())
                g_bulk_resume.window.assign(reinterpret_cast<const char*>(dc->WINDOW()->data()), dc->WINDOW()->size());
            if (dc->PARTIAL_RECORD())
                g_bulk_resume.pending.assign(reinterpret_cast<const char*>(dc->PARTIAL_RECORD()->data()),
                                             dc->PARTIAL_RECORD()->size());
            g_bulk_resume.window_pos = static_cast<uint32_t>(dc->WINDOW_POSITION());
            if (dc->DECODER_STATE_FORMAT()) g_bulk_resume.state_format = dc->DECODER_STATE_FORMAT()->str();
            if (dc->DECODER_STATE_VERSION()) g_bulk_resume.state_version = dc->DECODER_STATE_VERSION()->str();
            g_bulk_resume.state_byte_length = dc->DECODER_STATE_BYTE_LENGTH();
            g_bulk_resume.window_byte_length = dc->WINDOW_BYTE_LENGTH();
        }
    }
    // A mark past byte 0 is past the gzip header, decoder or not. A mark that
    // is past the header but carries no usable decoder RESTARTS (exactly as an
    // undecodable mark always did) instead of inflating mid-symbol.
    g_bulk_resume.header_done = !g_bulk_resume.state.empty() || g_bulk_resume.next_byte > 0;
}

int parse(void) {
    const uint32_t count = plugin_get_input_count();
    size_t new_responses = 0;
    for (uint32_t i = 0; i < count; ++i) {
        const plugin_input_frame_t* f = plugin_get_input_frame(i);
        if (!f || !f->port_id || std::strcmp(f->port_id, "responses") != 0) continue;
        if (!f->payload || f->payload_length == 0) continue;
        flatbuffers::Verifier verifier(f->payload, f->payload_length);
        if (!R::VerifyHttpResponseBuffer(verifier)) {
            plugin_set_error("invalid-response-frame", "a responses frame is not an HttpResponse (HRSP).");
            return 400;
        }
        const R::HttpResponse* response = R::GetHttpResponse(f->payload);

        // THE CONTEXT: the run contract ($APR), and on the ingest lane the mark
        // the fetch continues ($IRM). A response that cannot say which run and
        // which provider it answers is refused, never guessed at.
        std::unique_ptr<APRT> apr;
        const IRM* irm = nullptr;
        Bytes irm_copy;
        size_t irm_base = 0;
        if (const auto* ctx = response->CONTEXT()) {
            for_each_frame(ctx->data(), ctx->size(), [&](const uint8_t* rec, size_t len) {
                if (has_identifier(rec, len, "$APR") && !apr) {
                    apr = apr_unpack(rec, len);
                } else if (has_identifier(rec, len, "$IRM") && !irm) {
                    std::vector<uint64_t> scratch;
                    const uint8_t* root = verified_record(
                        rec, len, &scratch, [](flatbuffers::Verifier& v) { return VerifyIRMBuffer(v); },
                        [](flatbuffers::Verifier& v) { return VerifySizePrefixedIRMBuffer(v); });
                    if (root) {
                        // Kept with its alignment base (the record, or its size prefix) so it outlives the scratch.
                        irm_base = root == rec ? 0 : 4;
                        irm_copy.assign(root - irm_base, root + len);
                        irm = GetIRM(irm_copy.data() + irm_base);
                    }
                }
                return true;
            });
        }
        if (!apr) {
            plugin_set_error("missing-context",
                             "an HttpResponse carries no $APR run contract in CONTEXT; it cannot be attributed "
                             "to a run or a provider, and is refused rather than guessed at.");
            return 400;
        }
        std::string provider_id = apr_param(*apr, "provider");

        if (!g_have_job) {
            // A NEW RUN. The contract is adopted once; its per-fetch bindings are
            // stripped from the copy that travels on.
            APRT job;
            GetAPR(apr_bytes(*apr).data())->UnPackTo(&job);
            apr_drop_param(&job, "provider");
            apr_drop_param(&job, "fetches");
            apr_drop_param(&job, "credentialLane");
            g_job = apr_bytes(job);
            g_expected = static_cast<size_t>(std::strtoul(apr_param(*apr, "fetches", "0").c_str(), nullptr, 10));
            g_providers_consulted = split_list(apr_header(*apr, "x-sdn-providers-consulted"));
            g_full_population = apr_param(*apr, "FULL_POPULATION") == "true";
            // Per-provider decode cap. The ingest lane decodes every row the body
            // carries; the anonymous lane keeps its 1,000-row bound.
            if (!g_full_population) {
                long capped = static_cast<long>(std::atof(apr_param(*apr, "LIMIT", "2000").c_str()));
                if (capped < 1) capped = 1;
                if (capped > 1000) capped = 1000;
                g_provider_row_cap = static_cast<size_t>(capped);
            }
            if (irm) {
                g_irm = irm_copy;
                g_irm_base = irm_base;
                adopt_irm(GetIRM(g_irm.data() + g_irm_base));
            }
            g_have_job = true;
        }

        // A RUN CONTRACT NAMING A PROVIDER THIS BUILD DOES NOT HAVE IS REFUSED
        // HERE, LOUDLY (graph: sdn-cellular-ingest-lands-no-batch — an ingest
        // configured for `mls` fetched 3 MB, decoded nothing and booked "landed
        // no batch" with no cause anywhere, three days running). A configuration
        // fault cannot heal on the next tick and must never read as success.
        if (!provider_id.empty() && !find_provider(provider_id)) {
            std::string message = "run contract names provider \"" + provider_id +
                                  "\", which is not in this module's registry. Known providers:";
            for (size_t k = 0; k < kProviderCount; ++k) {
                message += (k ? ", " : " ");
                message += kProviders[k].id;
            }
            message += ". Nothing was decoded and nothing will be: fix the configured provider id.";
            plugin_set_error("unknown-provider", message.c_str());
            return 400;
        }

        ++g_response_cursor;
        ++new_responses;
        const int status = response->STATUS();
        std::string payload;
        if (response->BODY()) payload.assign(reinterpret_cast<const char*>(response->BODY()->data()), response->BODY()->size());

        // A context without a provider binding (a hand-authored contract) falls
        // back to what the body IS: among the providers this run consulted, if
        // exactly ONE uses this body's format, the body can only be that one.
        const char* observed_format = payload.empty() ? nullptr : detect_body_format(payload);
        if (provider_id.empty() && observed_format) {
            const ProviderSpec* only = nullptr;
            bool ambiguous = false;
            for (const std::string& c : g_providers_consulted) {
                const ProviderSpec* candidate = find_provider(c);
                if (!candidate || std::strcmp(candidate->format, observed_format) != 0) continue;
                if (only && only != candidate) { ambiguous = true; break; }
                only = candidate;
            }
            if (only && !ambiguous) provider_id = only->id;
        }
        const ProviderSpec* spec = find_provider(provider_id);
        if (!spec) continue;  // unattributable: dropped, per-frame, never guessed
        // A provider that failed is simply absent from the answer. It stays in
        // providers consulted, so "asked and got nothing" never reads as "agreed".
        if (status < 200 || status >= 300) continue;
        if (payload.empty()) continue;

        // FAIL CLOSED ON A CONTRADICTED ATTRIBUTION: the body must corroborate
        // the provider it is attributed to (an Overpass answer carries
        // `elements`, a row API answers an array, an OpenCelliD error envelope
        // is a format no provider declares). On a mismatch the frame is dropped
        // rather than decoded against a guess.
        if (observed_format && std::strcmp(observed_format, spec->format) != 0) continue;

        const size_t before = g_reports.size();
        std::vector<Report>& reports = g_reports;
        const size_t provider_row_cap = g_provider_row_cap;
        // `csv_header` is the header row a PREVIOUS chunk saw, carried on the
        // durable resume mark. Empty on chunk 0 and on every request-scoped path.
        if (std::strcmp(spec->format, "csv") == 0)
            decode_csv(*spec, payload, &reports, g_csv_header);
        else if (std::strcmp(spec->format, "osm-json") == 0) decode_osm_json(*spec, payload, &reports);
        else if (std::strcmp(spec->format, "soql-json") == 0) decode_soql_json(*spec, payload, &reports);
        else if (std::strcmp(spec->format, "swiss-geojson") == 0) {
            decode_swiss_geojson(*spec, payload, provider_row_cap, &reports, &g_row_capped);
        }
        // The four national bulk archives: "you asked for this many" and "the
        // register has this many" must never be confused, hence `hit_cap`.
        else if (std::strcmp(spec->format, "zip-acma") == 0) {
            decode_acma_zip(*spec, payload, provider_row_cap, &reports, &g_row_capped);
        }
        else if (std::strcmp(spec->format, "zip-ised") == 0) {
            decode_ised_zip(*spec, payload, provider_row_cap, &reports, &g_row_capped);
        }
        else if (std::strcmp(spec->format, "zip-anfr") == 0) {
            decode_anfr_zip(*spec, payload, provider_row_cap, &reports, &g_row_capped);
        }
        else if (std::strcmp(spec->format, "comreg-protobuf") == 0) {
            decode_comreg_protobuf(*spec, payload, provider_row_cap, &reports, &g_row_capped);
        }
        // The bulk gzip. Unlike every other decoder this one is STATEFUL across
        // chunks: it reads the resume mark the fetch continues and writes the
        // one the next chunk needs.
        else if (std::strcmp(spec->format, "csv-gz") == 0) {
            g_bulk_provider = spec->id;
            g_bulk_url = response->URL() ? response->URL()->str() : std::string(spec->url);
            decode_opencellid_bulk_gz(*spec, payload, provider_row_cap, &g_bulk_resume, &reports,
                                      &g_row_capped);
        }
        // An unsupported format contributes nothing rather than a guess.
        const std::string retrieved =
            response->RETRIEVED_MS() ? iso_of_ms(response->RETRIEVED_MS()) : iso_of_ms(static_cast<uint64_t>(now_ms()));
        g_report_retrieved.resize(g_reports.size(), retrieved);
        (void)before;
    }

    if (!g_have_job) {
        // Nothing has arrived at all; nothing to answer with.
        return 0;
    }
    const bool all_accounted_for = g_expected > 0 && g_response_cursor >= g_expected;
    if (!all_accounted_for && new_responses > 0) {
        // Something arrived but not provably everything: ask for another look.
        if (++g_idle_ticks < 64) {
            plugin_set_yielded(1);
            plugin_set_backlog_remaining(1);
            return 0;
        }
        // Runaway guard. Answer short rather than never.
    }
    // else: every fetch accounted for, or a quiet tick after real responses.

    std::vector<uint8_t> stream;
    for (size_t i = 0; i < g_reports.size(); ++i) {
        report_to_tbs(g_reports[i], i < g_report_retrieved.size() ? g_report_retrieved[i] : iso_now(), &stream);
    }

    APRT job;
    GetAPR(g_job.data())->UnPackTo(&job);
    if (g_row_capped) apr_set_header(&job, "x-sdn-row-capped", "true");

    Bytes resume;
    if (g_bulk_resume.valid) {
        const IRM* in = g_irm.empty() ? nullptr : GetIRM(g_irm.data() + g_irm_base);
        resume = build_resume_irm(in, g_bulk_provider, g_bulk_url, g_bulk_resume, g_csv_header);
    }
    reset_run_state();

    if (push_apr("job", job) < 0) return 500;
    if (push_tbs_stream("reports", stream) < 0) return 500;
    if (!resume.empty() &&
        push_frame("resume", "IRM.fbs", "$IRM", "IRM", resume.data(), resume.size()) < 0) {
        return 500;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// deconflict: the run contract + reports -> size-prefixed $TBS stream, the
// contract passed on with this run's counters, and the dataset's availability.
// ---------------------------------------------------------------------------
int deconflict(void) {
    if (refuse_batched("job") || refuse_batched("reports")) return 500;
    const plugin_input_frame_t* job_frame = frame_for("job");
    std::unique_ptr<APRT> job = job_frame && job_frame->payload ? apr_unpack(job_frame->payload, job_frame->payload_length) : nullptr;
    if (!job) {
        plugin_set_error("missing-job-frame", "deconflict requires the $APR run contract on port \"job\".");
        return 400;
    }
    const std::string method_name = apr_param(*job, "METHOD", "HIGHEST_SAMPLE_COUNT");
    int8_t method;
    if (method_name == "SINGLE_SOURCE") method = MM_SINGLE_SOURCE;
    else if (method_name == "HIGHEST_SAMPLE_COUNT") method = MM_HIGHEST_SAMPLE_COUNT;
    else if (method_name == "MOST_RECENT") method = MM_MOST_RECENT;
    else if (method_name == "AUTHORITY_PRECEDENCE") method = MM_AUTHORITY_PRECEDENCE;
    else if (method_name == "CENTROID") method = MM_CENTROID;
    else {
        const std::string message = "the run contract names merge METHOD \"" + method_name + "\", which $TBS does not define";
        plugin_set_error("unknown-method", message.c_str());
        return 400;
    }
    // The ingest lane writes every deconflicted site; the anonymous lane stops
    // at LIMIT. Either way the answer reports whether it stopped early.
    const bool full_population = apr_param(*job, "FULL_POPULATION") == "true";
    const long limit = full_population ? 0  // 0 == unbounded
                                        : static_cast<long>(std::atof(apr_param(*job, "LIMIT", "2000").c_str()));
    const size_t consulted = split_list(apr_header(*job, "x-sdn-providers-consulted")).size();

    std::vector<Report> reports;
    if (const plugin_input_frame_t* rf = frame_for("reports")) {
        if (rf->payload && rf->payload_length) {
            bool well_formed = true;
            const bool framed = for_each_frame(rf->payload, rf->payload_length, [&](const uint8_t* rec, size_t len) {
                flatbuffers::Verifier v(rec, len);
                if (!has_identifier(rec, len, "$TBS") || !VerifyTBSBuffer(v)) { well_formed = false; return false; }
                reports.push_back(report_from_tbs(GetTBS(rec)));
                return true;
            });
            if (!framed || !well_formed) {
                plugin_set_error("invalid-reports", "the reports frame is not a size-prefixed $TBS record stream.");
                return 400;
            }
        }
    }

    std::vector<std::vector<size_t>> groups;
    if (method == MM_SINGLE_SOURCE) {
        for (size_t i = 0; i < reports.size(); ++i) groups.push_back({i});
    } else {
        groups = group_reports(reports);
    }

    const std::string stamp = iso_now();
    std::vector<uint8_t> stream;
    size_t multi = 0;
    size_t written = 0;
    // TRUNCATED means "this answer is not the whole population", whichever cap
    // did it: the decoder stopping at the per-provider row cap (parse's
    // x-sdn-row-capped) or the writer stopping at LIMIT below.
    bool truncated = apr_header(*job, "x-sdn-row-capped") == "true";
    for (const std::vector<size_t>& group : groups) {
        if (limit > 0 && static_cast<long>(written) >= limit) { truncated = true; break; }
        const size_t win = select_winner(reports, group, method);
        const double spread = position_spread(reports, group);
        std::set<std::string> agreeing;
        for (size_t i : group) agreeing.insert(reports[i].provider_id);
        if (agreeing.size() > 1) ++multi;

        double lat = reports[win].latitude, lon = reports[win].longitude;
        if (method == MM_CENTROID) {
            lat = 0; lon = 0;
            for (size_t i : group) { lat += reports[i].latitude; lon += reports[i].longitude; }
            lat /= static_cast<double>(group.size());
            lon /= static_cast<double>(group.size());
        }
        const double confidence = confidence_of(reports, group, consulted, spread);
        std::vector<uint8_t> record;
        build_tbs_record(reports, group, win, method, lat, lon, spread,
                         static_cast<uint32_t>(consulted), static_cast<uint32_t>(agreeing.size()),
                         confidence, stamp, &record);
        append_size_prefixed(&stream, record.data(), record.size());
        ++written;
    }

    // A CROPPED ANSWER MUST SAY SO — and the counters ride the answer as headers.
    apr_set_header(job.get(), "x-sdn-reports-in", std::to_string(reports.size()));
    apr_set_header(job.get(), "x-sdn-sites-out", std::to_string(written));
    apr_set_header(job.get(), "x-sdn-collapsed",
                   std::to_string(reports.size() > written ? reports.size() - written : 0));
    apr_set_header(job.get(), "x-sdn-multi-provider-sites", std::to_string(multi));
    apr_set_header(job.get(), "x-sdn-merge-method", method_name);
    apr_set_header(job.get(), "x-sdn-full-population", full_population ? "true" : "false");
    apr_set_header(job.get(), "x-sdn-truncated", truncated ? "true" : "false");

    DAVT dav;
    dav.STANDARD = "TBS";
    dav.SCHEMA_NAME = "TBS.fbs";
    dav.SOURCE_NAME = "cellular-aggregate";
    dav.KNOWN = true;
    dav.AVAILABLE = true;
    dav.FRESH = true;
    dav.RECORD_COUNT = written;
    dav.BYTE_COUNT = stream.size();
    dav.PUBLISHED_AT_MS = now_ms();
    flatbuffers::FlatBufferBuilder b(512);
    FinishDAVBuffer(b, DAV::Pack(b, &dav));

    if (push_tbs_stream("records", stream) < 0) return 500;
    if (push_apr("decision", *job) < 0) return 500;
    if (push_frame("availability", "DAV.fbs", "$DAV", "DAV", b.GetBufferPointer(), b.GetSize()) < 0) return 500;
    return 0;
}

}  // extern "C"
