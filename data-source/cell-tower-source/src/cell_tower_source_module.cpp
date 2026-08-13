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
 * ─── FLOW-NODE SHAPE ────────────────────────────────────────────────────────
 * Three pure flow nodes. The module performs NO I/O of its own: fetching is the
 * generic hostcap/http-request connector node, exactly as satnogs-source and
 * mlab-starlink-connectivity do. No new host capability exists or is needed.
 *
 *   route     : $HTQ request        -> "requests" (N hostcap/http-request GETs)
 *                                      "job"      (the run contract for parse)
 *                                      "reply"    (early error reply, or empty)
 *   parse     : job + responses     -> "reports"  (normalized reports, JSON)
 *   deconflict: job + reports       -> "records"  (size-prefixed $TBS stream)
 *                                      "summary"  (counts for the HTTP reply)
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
#include <set>
#include <string>
#include <vector>

#include <sys/time.h>
#include <ctime>

#include "space_data_module_invoke.h"

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
// The flow's intra-node frames are UTF-8 JSON (the hostcap http-request
// descriptor shape is defined by the host op, not by SDS), so a small reader is
// all that is needed. Nothing here parses provider payloads: those go through
// the per-adapter decoders below.

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
  // the remaining 25 MiB cannot change the answer. Route therefore asks for
  // that prefix with Range and the streaming decoder below deliberately accepts
  // the incomplete JSON tail after it has emitted the bounded row set. Besides
  // wasting bandwidth, the full document occasionally pushed the buffered HTTP
  // flow beyond Cloudflare's response deadline (live 524 at 124 s).
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

  // ── Verified live, real, and NOT CONSUMABLE BY THIS MODULE YET ────────────
  // Each of the four below was reached with a successful fetch on 2026-08-10.
  // None is compiled in as a fetchable URL, because this module decodes only
  // CSV, Overpass JSON, SoQL JSON and the Swiss GeoJSON above — it has no ZIP
  // inflate and no protobuf decoder. Fetching them would return 200 and parse
  // to zero rows, which is precisely the failure mode this task was filed
  // about. They are carried as `unavailable` so the discovery is not lost and
  // the catalog can state the reason, and they are never fetched.
  // Follow-up: `cell-tower-bulk-archive-adapters`.
  {"anfr-cartoradio","Agence nationale des frequences",
   "https://static.data.gouv.fr/resources/donnees-sur-les-installations-radioelectriques-de-plus-de-5-watts-1/20260702-135014/20260630-export-etalab-data.zip",
   {nullptr,nullptr,nullptr},
   "","","csv",
   "Licence Ouverte 2.0","https://www.etalab.gouv.fr/licence-ouverte-open-licence","ANFR Cartoradio",false,true,
   "unavailable",
   "verified live (206, application/zip, 65,696,863 B): a ZIP of five ';'-delimited "
   "tables. Needs ZIP inflate, a STA_NM_ANFR join across SUP_STATION/SUP_SUPPORT, a "
   "further ADM_ID join for the operator name, and DMS-to-decimal conversion "
   "(coordinates are split across four degree/minute/second/hemisphere columns)"},

  {"acma-rrl","Australian Communications and Media Authority","https://cdn.acma.gov.au/rrl/spectra_rrl.zip",
   {nullptr,nullptr,nullptr},
   "","","csv",
   // CORRECTED 2026-08-10. This registry declared CC BY 4.0; the LICENCE.TXT
   // inside the live archive is ACMA's own non-transferable licence-to-use with
   // IP retained. An attribution string that overstates the grant is a licence
   // defect, not a cosmetic one — $TBS.SOURCES carries it into republication.
   "ACMA Licence to Use the Register of Radiocommunications Licences",
   "https://www.acma.gov.au/","ACMA Register of Radiocommunications Licences",false,true,
   "unavailable",
   "verified live (206, application/zip, 69,981,982 B, refreshed daily): 28 tables; "
   "site.csv carries clean decimal LATITUDE/LONGITUDE. Needs ZIP inflate plus a "
   "site-licence-client join for the operator name"},

  {"ised-sms-tafl","Innovation, Science and Economic Development Canada",
   "https://www.ic.gc.ca/engineering/SMS_TAFL_Files/TAFL_LTAF.zip",
   {nullptr,nullptr,nullptr},
   "","","csv",
   "Open Government Licence - Canada","https://open.canada.ca/en/open-government-licence-canada","ISED Spectrum Management System",false,true,
   "unavailable",
   "verified live (206, application/zip, 64,197,105 B): one HEADERLESS positional "
   "CSV. Needs ZIP inflate plus a column map taken from the companion field "
   "description document — there are no column names to look up"},

  {"comreg-siteviewer","Commission for Communications Regulation",
   "https://api-siteviewer.comreg.ie/mobile-masts/point",
   {nullptr,nullptr,nullptr},
   "","","json",
   "CC BY 4.0","https://creativecommons.org/licenses/by/4.0/","ComReg SiteViewer",false,true,
   "unavailable",
   "verified live and UNAUTHENTICATED (POST {} -> 200 with real national mast ids "
   "in the body): a bespoke backend that answers application/x-protobuf and ignores "
   "Accept: application/json. Needs a protobuf decoder and the schema; the best "
   "candidate to unblock first"},

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

// The connector's default response frame carries the body BASE64-ENCODED
// (`bodyB64`), because a raw body is not JSON-safe. This flow opts into the
// connector's raw-body-v1 lane for large provider documents; the base64 codec
// stays here for backward compatibility with already-published JSON frames and
// direct module tests.
int b64_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

bool base64_decode(const std::string& text, std::string* out) {
    out->clear();
    out->reserve((text.size() / 4) * 3);
    uint32_t acc = 0;
    int bits = 0;
    for (const char c : text) {
        if (c == '=' || c == '\n' || c == '\r') continue;
        const int v = b64_value(c);
        if (v < 0) return false;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->push_back(static_cast<char>((acc >> bits) & 0xff));
        }
    }
    return true;
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

void decode_csv(const ProviderSpec& spec, const std::string& body, std::vector<Report>* out) {
    size_t pos = 0, line_no = 0;
    std::vector<std::string> header;
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

// ── report <-> JSON (the intra-flow "reports" frame) ────────────────────────
std::string report_to_json(const Report& r) {
    std::string j = "{\"provider_id\":\"" + json_escape(r.provider_id) + "\"";
    j += ",\"radio\":" + std::to_string(static_cast<int>(r.radio));
    j += ",\"latitude\":" + std::to_string(r.latitude);
    j += ",\"longitude\":" + std::to_string(r.longitude);
    if (!r.native_id.empty()) j += ",\"native_id\":\"" + json_escape(r.native_id) + "\"";
    if (r.mcc >= 0) j += ",\"mcc\":" + std::to_string(r.mcc);
    if (r.mnc >= 0) j += ",\"mnc\":" + std::to_string(r.mnc);
    if (r.lac >= 0) j += ",\"lac\":" + std::to_string(r.lac);
    if (r.tac >= 0) j += ",\"tac\":" + std::to_string(r.tac);
    if (!r.cell_id.empty()) j += ",\"cell_id\":\"" + json_escape(r.cell_id) + "\"";
    if (r.range_m >= 0) j += ",\"range_m\":" + std::to_string(r.range_m);
    if (r.samples >= 0) j += ",\"samples\":" + std::to_string(r.samples);
    if (r.has_signal) j += ",\"average_signal_dbm\":" + std::to_string(r.average_signal_dbm);
    if (r.observed_at >= 0) j += ",\"observed_at\":" + std::to_string(r.observed_at);
    if (!r.site_name.empty()) j += ",\"site_name\":\"" + json_escape(r.site_name) + "\"";
    if (!r.operator_name.empty()) j += ",\"operator\":\"" + json_escape(r.operator_name) + "\"";
    if (!r.country_code.empty()) j += ",\"country_code\":\"" + json_escape(r.country_code) + "\"";
    return j + "}";
}

Report report_from_json(const std::string& j) {
    Report r;
    r.provider_id = json_string(j, "provider_id", "");
    r.native_id = json_string(j, "native_id", "");
    r.radio = static_cast<int8_t>(json_number(j, "radio", RC_UNKNOWN));
    r.latitude = json_number(j, "latitude", 0);
    r.longitude = json_number(j, "longitude", 0);
    r.mcc = static_cast<long>(json_number(j, "mcc", -1));
    r.mnc = static_cast<long>(json_number(j, "mnc", -1));
    r.lac = static_cast<long>(json_number(j, "lac", -1));
    r.tac = static_cast<long>(json_number(j, "tac", -1));
    r.cell_id = json_string(j, "cell_id", "");
    r.range_m = json_number(j, "range_m", -1);
    r.samples = static_cast<long>(json_number(j, "samples", -1));
    const double sig = json_number(j, "average_signal_dbm", 1e9);
    if (sig < 1e8) { r.average_signal_dbm = sig; r.has_signal = true; }
    r.observed_at = static_cast<long long>(json_number(j, "observed_at", -1));
    r.site_name = json_string(j, "site_name", "");
    r.operator_name = json_string(j, "operator", "");
    r.country_code = json_string(j, "country_code", "");
    return r;
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
        return nullptr;
    }
    // A CSV answer is not JSON and is deliberately NOT identified here. An
    // unrecognised body must fall through to positional attribution, which is
    // still corroborated downstream — never be vetoed by an unknown shape.
    return nullptr;
}

// Decode hostcap/http-request's opt-in raw response lane. Keeping the status in
// an eight-byte prefix and the body verbatim avoids inflating a 27 MB national
// GeoJSON document to 36 MB of base64 plus several same-sized JSON/string
// copies inside the flow's 128 MB linear-memory ceiling.
//
//   0..3  "$HRB"
//   4..7  signed HTTP status, little endian
//   8..N  response body
bool decode_raw_http_response(const plugin_input_frame_t* frame, int* status,
                              std::string* body) {
    if (!frame || !frame->payload || frame->payload_length < 8) return false;
    const uint8_t* p = frame->payload;
    if (p[0] != '$' || p[1] != 'H' || p[2] != 'R' || p[3] != 'B') return false;
    const uint32_t raw_status = static_cast<uint32_t>(p[4]) |
                                (static_cast<uint32_t>(p[5]) << 8) |
                                (static_cast<uint32_t>(p[6]) << 16) |
                                (static_cast<uint32_t>(p[7]) << 24);
    *status = static_cast<int32_t>(raw_status);
    body->assign(reinterpret_cast<const char*>(p + 8), frame->payload_length - 8);
    return true;
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

void decode_swiss_geojson(const ProviderSpec& spec, const std::string& body,
                          size_t report_limit, std::vector<Report>* out) {
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
    for (++at; at < body.size() && emitted < report_limit; ++at) {
        const char c = body[at];
        if (in_string) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') { in_string = true; continue; }
        if (c == '{') {
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
    std::vector<size_t> geometric;  // indices INTO groups
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
        size_t matched = SIZE_MAX;
        double best = 1e18;
        for (size_t g : geometric) {
            const Report& head = reports[groups[g][0]];
            const double d = haversine_m(head.latitude, head.longitude,
                                         reports[i].latitude, reports[i].longitude);
            if (d <= kPositionToleranceM && d < best) { best = d; matched = g; }
        }
        if (matched != SIZE_MAX) { groups[matched].push_back(i); continue; }
        geometric.push_back(groups.size());
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

// ── $HTQ request envelope ──────────────────────────────────────────────────
//
// The host is a DUMB PIPE (module-sdk schemas/HttpRequestAbi.fbs): it delivers
// exactly one $HTQ frame and streams back one $HTR. ALL HTTP semantics —
// routing, query parsing, content negotiation — live in here. That is also why
// this flow has ONE http trigger and dispatches on PATH internally: the host
// takes the FIRST http-request trigger and breaks (flowrt/httpmount.go:562-570),
// so a second trigger is silently unreachable rather than a second route.
//
// Hand-decoded rather than inlining the generated header: the envelope is one
// table with six fields, and the module already inlines $TBS. Slots are
// METHOD=0, PATH=1, QUERY=2, HEADERS=3, BODY=4, REMOTE=5.
struct HtqReader {
    const uint8_t* buf = nullptr;
    uint32_t len = 0;
    uint32_t root = 0;
    uint32_t vtable = 0;
    uint16_t vtable_len = 0;

    bool init(const uint8_t* data, uint32_t size) {
        if (!data || size < 8) return false;
        buf = data; len = size;
        root = rd32(0);
        if (root + 4 > len) return false;
        const int32_t soffset = static_cast<int32_t>(rd32(root));
        const int64_t vt = static_cast<int64_t>(root) - soffset;
        if (vt < 0 || vt + 4 > len) return false;
        vtable = static_cast<uint32_t>(vt);
        vtable_len = rd16(vtable);
        return true;
    }
    uint32_t rd32(uint32_t at) const {
        return static_cast<uint32_t>(buf[at]) | (static_cast<uint32_t>(buf[at + 1]) << 8) |
               (static_cast<uint32_t>(buf[at + 2]) << 16) | (static_cast<uint32_t>(buf[at + 3]) << 24);
    }
    uint16_t rd16(uint32_t at) const {
        return static_cast<uint16_t>(buf[at]) | (static_cast<uint16_t>(buf[at + 1]) << 8);
    }
    uint16_t slot(int index) const {
        const uint32_t at = vtable + 4 + static_cast<uint32_t>(index) * 2;
        if (at + 2 > vtable + vtable_len || at + 2 > len) return 0;
        return rd16(at);
    }
    std::string str(int index) const {
        const uint16_t rel = slot(index);
        if (!rel) return std::string();
        const uint32_t at = root + rel;
        if (at + 4 > len) return std::string();
        const uint32_t off = at + rd32(at);
        if (off + 4 > len) return std::string();
        const uint32_t n = rd32(off);
        if (off + 4 + n > len) return std::string();
        return std::string(reinterpret_cast<const char*>(buf + off + 4), n);
    }
    std::string bytes(int index) const { return str(index); }  // same layout for [ubyte]
};


// ── $TBS encoding ──────────────────────────────────────────────────────────
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

// ── frame helpers ──────────────────────────────────────────────────────────
int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 nullptr, 0, 0, reinterpret_cast<const uint8_t*>(json.data()),
                                 static_cast<uint32_t>(json.size()));
}

int push_tbs_stream(const char* port, const std::vector<uint8_t>& bytes) {
    return plugin_push_output_ex(port, "TBS.fbs", "$TBS", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "TBS", 0, 0, bytes.data(), static_cast<uint32_t>(bytes.size()));
}

std::string input_text(const char* port_id, uint32_t ordinal) {
    const int32_t idx = plugin_find_input_index(port_id, ordinal);
    if (idx < 0) return std::string();
    const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!f || !f->payload) return std::string();
    return std::string(reinterpret_cast<const char*>(f->payload), f->payload_length);
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
// catalog: the provider list this node can actually reach.
//
// The GUI calls this FIRST and renders exactly what it is told, so the catalog
// is the module's, never a list compiled into the page. It reports each
// provider's access posture and whether a credential is currently held, so the
// page can disable what it cannot use instead of offering a control that fails.
//
// It reports NO credential values and no key material — only whether a lane is
// configured. `keySlot` is emitted ONLY when the node published a real slot to
// seal to; while it is absent the GUI must refuse to collect a credential
// rather than show a form with nowhere safe to send it.
// ---------------------------------------------------------------------------
int emit_catalog(void) {
    std::string out = "{\"providers\":[";
    for (size_t i = 0; i < kProviderCount; ++i) {
        const ProviderSpec& p = kProviders[i];
        if (i) out += ",";
        out += std::string("{\"id\":\"") + p.id + "\"";
        out += ",\"name\":\"" + json_escape(p.authority) + "\"";
        out += ",\"authority\":\"" + json_escape(p.authority) + "\"";
        out += ",\"license\":\"" + json_escape(p.license) + "\"";
        out += ",\"attribution\":\"" + json_escape(p.attribution) + "\"";
        out += ",\"credentialRequired\":" + std::string(p.login_required ? "true" : "false");
        // FALSE HERE BY CONSTRUCTION, and finished downstream. This plugin holds
        // no credential capability and must not: `secrets.status` has no
        // browser-host implementation, so calling it from a method the browser
        // harness instantiates would trap the very tests that keep the adapters
        // honest (Janus ruling, 2026-08-09). The credential MEDIATOR — a
        // wasmedge-only sibling plugin, the only node in this flow the operator
        // grants secrets/keyslot to — flips this per lane and appends `keySlot`.
        out += ",\"credentialConfigured\":false";
        out += ",\"credentialLane\":\"" + json_escape(credential_lane(p.id)) + "\"";
        out += ",\"authoritative\":" + std::string(p.authoritative ? "true" : "false");
        // A provider needing a login is not pre-ticked: offering it would
        // produce a run that silently skips it. The mediator flips this too,
        // for a provider whose credential IS held.
        out += ",\"defaultSelected\":" + std::string(p.login_required ? "false" : "true");
        out += "}";
    }
    out += "],\"methods\":[\"SINGLE_SOURCE\",\"HIGHEST_SAMPLE_COUNT\",\"MOST_RECENT\""
           ",\"AUTHORITY_PRECEDENCE\",\"CENTROID\"]";
    out += "}";
    // THE CATALOG IS NOT ANSWERED FROM HERE. It goes to the credential
    // mediator, which is the node that can ask the host for the wrapping key
    // slot and the per-lane configured flags, and which owns the reply.
    // Emitting a `catalog`/`reply` pair here as well would race two bodies into
    // one responder — and the port name matters for the reason recorded on the
    // 2026-08-08 defect: `decision` is NOT a declared output of `route`, and a
    // frame pushed to an undeclared port is not dropped, it survives in the
    // pooled instance and is served to a later, unrelated caller.
    return push_json("credential", "{\"op\":\"catalog\",\"catalog\":" + out + "}") < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// The credential route's REFUSALS — the ones decidable without any capability.
//
// An unknown provider, a provider that needs no login, and a wrong verb are all
// answerable from the compiled registry alone, so they are answered here rather
// than spent as a hop into the mediator. Everything that needs the host (open
// the envelope, write the lane, clear the lane) goes to the mediator.
//
// `route` MUST be the string "error" for any non-200, because
// foundation/http-respond reads decision.status ONLY in that branch
// (http_respond_module.cpp:395-401); naming anything else turns a refusal into
// a silent empty 200.
// ---------------------------------------------------------------------------
int emit_route_error(int status, const char* code, const std::string& message) {
    if (push_json("reply", std::string("{\"route\":\"error\",\"format\":\"json\",\"status\":") +
                               std::to_string(status) + "}") < 0) {
        return 500;
    }
    return push_json("catalog", std::string("{\"code\":\"") + code + "\",\"error\":\"" +
                                    json_escape(message) + "\"}") < 0
               ? 500
               : 0;
}

// PUT|DELETE /credentials/<providerId>. The lane id is DERIVED, never supplied:
// `cell_<providerId>` where the provider id came out of THIS module's compiled
// registry. A caller therefore cannot name a lane — it names a provider, and an
// unknown provider is refused right here, before anything with a capability
// sees it. That is what stops a request reaching `secrets:spacetrack` or any
// other operator lane through this route, whatever the policy rows say.
int dispatch_credential(const std::string& verb, const std::string& provider_id,
                        const std::string& body) {
    const ProviderSpec* spec = find_provider(provider_id);
    if (!spec) {
        return emit_route_error(404, "unknown-provider",
                                "no provider \"" + provider_id + "\" in this node's registry");
    }
    if (!spec->login_required) {
        return emit_route_error(400, "credential-not-required",
                                std::string("provider \"") + spec->id +
                                    "\" is reachable without a login; it has no credential lane");
    }
    const std::string lane = credential_lane(spec->id);
    if (verb == "DELETE") {
        return push_json("credential", std::string("{\"op\":\"clear\",\"providerId\":\"") +
                                           json_escape(spec->id) + "\",\"lane\":\"" +
                                           json_escape(lane) + "\"}") < 0
                   ? 500
                   : 0;
    }
    // The body is the browser's keyslot envelope, verbatim. It is NOT parsed
    // here: this node cannot open it and has no business inspecting it. It is
    // forwarded whole to the one node that can.
    return push_json("credential", std::string("{\"op\":\"put\",\"providerId\":\"") +
                                       json_escape(spec->id) + "\",\"lane\":\"" +
                                       json_escape(lane) + "\",\"envelope\":" +
                                       (body.empty() ? std::string("{}") : body) + "}") < 0
               ? 500
               : 0;
}

}  // namespace

extern "C" {

// ---------------------------------------------------------------------------
// route: one $HTQ request -> N provider fetch descriptors + the run contract.
//
// The provider set and merge method are read from the REQUEST, never from node
// config, so two viewers can ask for different things at the same time without
// either of them changing what the node is.
// ---------------------------------------------------------------------------
int route(void) {
    const int32_t idx = plugin_find_input_index("request", 0);
    if (idx < 0) return 400;
    const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!frame || !frame->payload) return 400;

    HtqReader htq;
    if (!htq.init(frame->payload, frame->payload_length)) {
        push_json("reply",
                  "{\"route\":\"error\",\"format\":\"json\",\"status\":400"
                  ",\"code\":\"bad-envelope\""
                  ",\"error\":\"request envelope is not a readable $HTQ frame\"}");
        return 0;
    }
    // $HTQ vtable slots (HttpRequestAbi.fbs): 0 METHOD, 1 PATH, 2 QUERY,
    // 3 HEADERS, 4 BODY, 5 REMOTE.
    const std::string method_verb = upper_ascii(htq.str(0));
    const std::string path = htq.str(1);
    const std::string body = htq.bytes(4);

    // ONE trigger, dispatched here. The catalog read, the credential lane and
    // the aggregation are three routes of one flow, because the host mounts one
    // trigger per flow.
    if (path.size() >= 10 && path.compare(path.size() - 10, 10, "/providers") == 0) {
        return emit_catalog();
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
                return emit_route_error(
                    404, "no-provider",
                    "the credential route addresses one provider: /credentials/<providerId>");
            }
            if (method_verb == "PUT" || method_verb == "POST" || method_verb == "DELETE") {
                return dispatch_credential(method_verb == "DELETE" ? "DELETE" : "PUT", provider_id,
                                           body);
            }
            return emit_route_error(
                405, "method-not-allowed",
                "the credential route takes PUT (store) and DELETE (clear); a credential is "
                "never readable back");
        }
    }

    std::vector<std::string> wanted = json_string_array(body, "PROVIDERS");
    const std::string method_name = json_string(body, "METHOD", "HIGHEST_SAMPLE_COUNT");
    const double limit = json_number(body, "LIMIT", 2000);

    // BBOX in Overpass order (south,west,north,east).
    //
    // THE DEFAULT IS THE WHOLE PLANET (owner 2026-08-10: "should not be
    // viewport, should just be world-wide").
    //
    // It used to be a small box around Houston, and that single line is what
    // the owner saw as "a square in Texas / Louisiana" on a world globe. The
    // demo sent no BBOX, so every run silently answered for one US metro. The
    // lesson is not "the box was too small" — it is that a DEFAULT WHICH CROPS
    // IS INDISTINGUISHABLE FROM A COMPLETE ANSWER. Nothing in the response said
    // a region had been chosen on the caller's behalf.
    //
    // Providers that genuinely cannot serve an unbounded region are not
    // silently given a substitute box: they are skipped and SAY so (see the
    // `lane` field and the skip below). A named region is still honoured
    // exactly as before, which is what keeps the bounded providers usable.
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
    // "Worldwide" for the purpose of provider eligibility means the caller did
    // not name a workable region, OR named one that spans essentially the whole
    // planet. Both are unbounded as far as a public interpreter is concerned.
    const bool worldwide =
        !bbox_named || (bb_north - bb_south > 170.0 && bb_east - bb_west > 340.0);
    auto fmt_coord = [](double v) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.6f", v);
        return std::string(buf);
    };
    // Overpass order is south,west,north,east.
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
        // route MUST be "error": foundation/http-respond reads decision.status
        // ONLY in that branch (http_respond_module.cpp:395-401). Naming any
        // other route made this 400 fall through as a silent empty 200 on the
        // live mount — a refusal that reports success is worse than no refusal.
        push_json("reply",
                  std::string("{\"route\":\"error\",\"format\":\"json\",\"status\":400"
                              ",\"code\":\"unknown-method\",\"error\":\"unknown METHOD \\\"") +
                      json_escape(method_name) + "\\\"\"}");
        return 0;
    }

    if (wanted.empty()) {
        push_json("reply",
                  "{\"route\":\"error\",\"format\":\"json\",\"status\":400"
                  ",\"code\":\"no-providers\""
                  ",\"error\":\"PROVIDERS must name at least one provider\"}");
        return 0;
    }

    std::vector<std::string> descriptors;
    // Parallel to `descriptors`: which provider each one belongs to. See the
    // correlation-list note where the job is built.
    std::vector<std::string> descriptor_providers;
    std::string consulted = "[";
    std::string skipped = "[";
    size_t emitted = 0, skipped_count = 0;
    for (const std::string& id : wanted) {
        const ProviderSpec* spec = find_provider(id);
        if (!spec) {
            if (skipped_count++) skipped += ",";
            skipped += "{\"provider_id\":\"" + json_escape(id) + "\",\"reason\":\"unknown provider\"}";
            continue;
        }
        // A provider whose real endpoint this module cannot decode yet is
        // skipped WITH THE MISSING CAPABILITY NAMED. It is never fetched: its
        // payload is a ZIP or a protobuf, and handing that to a CSV/JSON
        // decoder returns 200 and parses to zero rows — the precise failure
        // this task exists to prevent, reproduced one layer along.
        if (std::strcmp(spec->lane, "unavailable") == 0) {
            if (skipped_count++) skipped += ",";
            skipped += std::string("{\"provider_id\":\"") + spec->id +
                       "\",\"bulkIngestOnly\":true,\"reason\":\"" +
                       json_escape(spec->blocked_by ? spec->blocked_by
                                                    : "not consumable by this module yet") +
                       "\"}";
            continue;
        }
        // A bounded-region provider cannot answer a worldwide request. Say so
        // instead of substituting a region the caller never asked for — the
        // silent substitution is exactly what put one US metro on a world globe.
        if (worldwide && std::strcmp(spec->lane, "query") == 0 && !spec->login_required) {
            if (skipped_count++) skipped += ",";
            skipped += std::string("{\"provider_id\":\"") + spec->id +
                       "\",\"needsRegion\":true,\"reason\":\"this endpoint answers a BOUNDED "
                       "region only; an unbounded query against a public interpreter times out "
                       "and is an abuse of a donated service. Name a BBOX to include it.\"}";
            continue;
        }
        if (spec->login_required) {
            // Skip loudly, never fetch unauthenticated and pretend the answer is
            // complete — but say WHICH of the two situations this is. The two
            // reasons are the observable difference a stored credential makes,
            // and the only end-to-end proof of the store round trip that does
            // not require an account with the provider. See the CREDENTIALS
            // note at the top for why the query template is not compiled in.
            if (skipped_count++) skipped += ",";
            skipped += std::string("{\"provider_id\":\"") + spec->id +
                       "\",\"credentialLane\":\"" + json_escape(credential_lane(spec->id)) +
                       "\",\"reason\":\"this provider needs a login; its authenticated row-query "
                       "endpoint is not verified against a live account yet, so it is not "
                       "fetched even when a credential is stored\"}";
            continue;
        }
        if (emitted++) { consulted += ","; }
        consulted += std::string("\"") + spec->id + "\"";

        // Build this provider's URL list: primary plus any mirrors. Mirrors are
        // fetched in the SAME run, not as retry-on-failure — a flow node has no
        // state between invocations to remember where a retry got to. All of
        // them carry the SAME provider_id, so they count as one provider
        // consulted and their overlapping rows collapse in deconfliction.
        std::vector<std::string> urls;
        urls.push_back(spec->url);
        for (size_t m = 0; m < 3; ++m) {
            if (spec->mirrors[m] && spec->mirrors[m][0]) urls.push_back(spec->mirrors[m]);
        }

        // Per-provider row cap. Bounds the work an anonymous caller can ask the
        // node to do at the EXPENSIVE end — the fetch and the merge — where the
        // job's LIMIT only caps records emitted at the cheap end.
        double rows = limit;
        if (rows < 1) rows = 1;
        if (rows > 1000) rows = 1000;
        char rows_buf[16];
        std::snprintf(rows_buf, sizeof(rows_buf), "%.0f", rows);

        for (const std::string& base : urls) {
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
                } else if (std::strcmp(spec->query_kind, "soql") == 0) {
                    // `$where`/`$limit` are the API's own parameter NAMES and
                    // stay literal; only the filter value is encoded.
                    url += "?$where=" + url_encode(q) + "&$limit=" + rows_buf;
                }
            }
            const std::string bounded_headers =
                std::strcmp(spec->format, "swiss-geojson") == 0
                    ? ",\"range\":\"bytes=0-2097151\""
                    : "";
            descriptors.push_back(std::string("{\"provider_id\":\"") + spec->id +
                                  "\",\"method\":\"GET\",\"url\":\"" + json_escape(url) +
                                  "\",\"headers\":{\"accept\":\"application/json\"" +
                                  bounded_headers +
                                  ",\"user-agent\":\"spacedatanetwork-cell-tower-source/0.1\"}" +
                                  ",\"timeoutMs\":40000,\"responseWire\":\"raw-body-v1\"}");
            descriptor_providers.push_back(spec->id);
        }
    }
    consulted += "]";
    skipped += "]";

    // THE CORRELATION LIST — one entry per descriptor, in emission order.
    //
    // `parse` cannot read the provider off a response frame, because the frame
    // is not ours: `hostcap/http-request` emits EXACTLY
    // {"status","headers","bodyB64"} (http_request_module.cpp:399) and echoes
    // nothing from the request it was handed. `parse` used to read
    // `provider_id` straight off that frame, found "" on every one, and skipped
    // all of them — so the node fetched every provider for real and answered
    // 200 with zero records and no error line, live on host-01.
    //
    // It passed every local run because `tests/live-probe.mjs` performs the
    // fetch in JS and SYNTHESISES `provider_id` into the response object it
    // feeds parse; the probe never instantiates the hostcap node whose output
    // shape is the whole question. A stand-in that supplies the field under
    // test cannot fail the way production does.
    //
    // So the correlation travels through the job, which route and parse both
    // see, instead of through a frame neither of them owns.
    std::string request_providers = "[";
    for (size_t i = 0; i < descriptor_providers.size(); ++i) {
        if (i) request_providers += ",";
        request_providers += "\"" + json_escape(descriptor_providers[i]) + "\"";
    }
    request_providers += "]";

    const std::string job = std::string("{\"method\":") + std::to_string(static_cast<int>(method)) +
                            ",\"method_name\":\"" + json_escape(method_name) + "\"" +
                            ",\"limit\":" + std::to_string(static_cast<long>(limit)) +
                            ",\"providers_consulted\":" + consulted +
                            ",\"request_providers\":" + request_providers +
                            ",\"skipped\":" + skipped + "}";

    // ZERO FETCHABLE PROVIDERS — SHORT-CIRCUIT, never start the pipeline.
    //
    // `parse.responses` is a REQUIRED input with minStreams 1, so a run with no
    // fetches leaves that node unable to fire, the chain stalls, and the host
    // finds nothing to send: a silent 502 with no log line anywhere (host-01,
    // 2026-08-08, `opencellid` as the sole provider — it needs a credential the
    // node cannot yet store, so every selected provider was skipped).
    //
    // The request was valid and the honest answer is an empty result WITH the
    // reasons, so this emits a decision and no body. `respond.body` is optional
    // and absent means an empty 200, which is exactly the shape wanted here.
    // Starting a pipeline that cannot complete is never better than answering.
    if (descriptors.empty()) {
        const std::string empty_reply =
            std::string("{\"route\":\"cellular-aggregate\",\"format\":\"record-stream\""
                        ",\"status\":200,\"reportsIn\":0,\"sitesOut\":0,\"collapsed\":0"
                        ",\"multiProviderSites\":0,\"providersConsulted\":0"
                        ",\"method\":\"") + json_escape(method_name) + "\"" +
            ",\"skipped\":" + skipped + "}";
        if (push_json("reply", empty_reply) < 0) return 500;
        return 0;
    }

    // The job goes FIRST: parse and deconflict both need the run contract, and a
    // response frame arriving before it would have nothing to be interpreted
    // against.
    if (push_json("job", job) < 0) return 500;
    // ONE FRAME PER DESCRIPTOR. hostcap/http-request consumes a single
    // {method,url,headers,timeoutMs}; the earlier single-frame JSON array
    // matched nothing, so ZERO fetches were attempted and the route answered
    // 200-with-no-records in 27 ms without ever contacting a provider. An empty
    // answer that never asked is indistinguishable from an honest empty answer,
    // which is exactly why this was invisible.
    for (const std::string& descriptor : descriptors) {
        if (push_json("requests", descriptor) < 0) return 500;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// parse: job + N http responses -> normalized reports.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// parse is a FAN-IN node, and the run does not fit in one invocation.
//
// route emits ONE `job` frame and N `requests` frames. The runtime FIFO-consumes
// `job` on the first invocation and NEVER re-delivers it, so everything derived
// from it has to survive between invocations — hence this state. It is reset
// when a `job` frame arrives, which is exactly once per run, and again after the
// run's single emission, so a pooled instance never carries a run into the next.
//
// (Two defects lived here at once. `job` was declared required:true, so draining
// that one frame left this node permanently unready and every later response sat
// in the queue forever; and `responses` was capped at maxStreams 1, so only the
// first descriptor's body was ever delivered. Together they made a two-provider
// request return precisely the first-named provider's answer — the order of the
// PROVIDERS array decided the result.)
static std::string g_job;
static std::vector<std::string> g_request_providers;
// Providers this run actually consulted — the candidate set for format-based
// attribution when a body can only belong to one of them.
static std::vector<std::string> g_providers_consulted;
static std::vector<Report> g_reports;
static size_t g_response_cursor = 0;
static bool g_have_job = false;
// Emit exactly once per run: respond/egress carry ONE HTTP body.
static bool g_emitted = false;
// Bounds the yield loop so a lost frame can never hang the request forever.
static uint32_t g_idle_ticks = 0;

void reset_run_state(void) {
    g_job.clear();
    g_request_providers.clear();
    g_providers_consulted.clear();
    g_reports.clear();
    g_response_cursor = 0;
    g_have_job = false;
    g_emitted = false;
    g_idle_ticks = 0;
}

int parse(void) {
    const std::string job = input_text("job", 0);
    if (!job.empty()) {
        // A new run begins. Never accumulate across runs.
        reset_run_state();
        g_job = job;
        g_request_providers = json_string_array(job, "request_providers");
        g_providers_consulted = json_string_array(job, "providers_consulted");
        g_have_job = true;
    }

    // Emission-order provider list written by route (see the correlation-list
    // note there). Response frame k answers descriptor k, and the cursor is
    // RUN-scoped rather than invocation-scoped: a per-invocation counter
    // restarted at 0 every time and mapped later batches onto provider 0.
    const std::vector<std::string>& request_providers = g_request_providers;
    std::vector<Report>& reports = g_reports;
    long provider_row_cap = static_cast<long>(json_number(g_job, "limit", 2000));
    if (provider_row_cap < 1) provider_row_cap = 1;
    if (provider_row_cap > 1000) provider_row_cap = 1000;

    const uint32_t count = plugin_get_input_count();
    size_t new_responses = 0;
    for (uint32_t i = 0; i < count; ++i) {
        const plugin_input_frame_t* f = plugin_get_input_frame(i);
        if (!f || !f->port_id || std::strcmp(f->port_id, "responses") != 0) continue;
        std::string frame;
        std::string payload;
        int status = 0;
        const bool raw_response = decode_raw_http_response(f, &status, &payload);
        if (!raw_response) {
            frame.assign(reinterpret_cast<const char*>(f->payload), f->payload_length);
            status = static_cast<int>(json_number(frame, "status", 0));
            const std::string body_b64 = json_string(frame, "bodyB64", "");
            if (!body_b64.empty() && !base64_decode(body_b64, &payload)) payload.clear();
        }
        const size_t k = g_response_cursor++;
        ++new_responses;

        // Prefer a provider the frame states about ITSELF. No host emits this
        // today, so this is forward compatibility, not the live path: if the
        // hostcap ever grows a correlation echo, attribution stops depending on
        // frame order the moment it does, with no change here.
        std::string provider_id = raw_response ? std::string() : json_string(frame, "provider_id", "");

        // POSITION IS THE FALLBACK, NOT THE PRIMARY. It cannot be the primary:
        // `hostcap/http-request` pushes NO frame for a failed fetch, so one
        // slow mirror silently removes a slot and every later body inherits the
        // wrong provider's index. That is not hypothetical here — Overpass
        // publishes three endpoints precisely because they fail, and one of
        // them answered a five-node query in 30.7 s from this host, so it
        // times out on real ones routinely.
        //
        // So attribute by what the body IS, whenever that is unambiguous:
        // among the providers this run actually consulted, if exactly ONE uses
        // the format this body is in, the body can only be that provider's, no
        // matter which slot it arrived in or how many siblings went missing.
        // Ambiguity (two consulted providers sharing a format) falls back to
        // position, still corroborated below.
        const char* observed_format = payload.empty() ? nullptr : detect_body_format(payload);
        if (provider_id.empty() && observed_format) {
            const ProviderSpec* only = nullptr;
            bool ambiguous = false;
            for (size_t c = 0; c < g_providers_consulted.size(); ++c) {
                const ProviderSpec* candidate = find_provider(g_providers_consulted[c]);
                if (!candidate) continue;
                if (std::strcmp(candidate->format, observed_format) != 0) continue;
                if (only && only != candidate) { ambiguous = true; break; }
                only = candidate;
            }
            if (only && !ambiguous) provider_id = only->id;
        }
        if (provider_id.empty() && k < request_providers.size()) {
            provider_id = request_providers[k];
        }
        const ProviderSpec* spec = find_provider(provider_id);
        if (!spec) continue;
        // A provider that failed is simply absent from the answer. It stays in
        // providers_consulted, so "asked and got nothing" remains visible and
        // never reads as "agreed".
        if (status < 200 || status >= 300) continue;
        if (payload.empty()) continue;

        // FAIL CLOSED ON A CONTRADICTED ATTRIBUTION.
        //
        // Positional correlation is only as good as the flow preserving frame
        // order along route.requests -> http -> parse.responses. These
        // descriptors have very different latencies (an Overpass mirror runs
        // seconds behind a Socrata row query), so if the runtime ever emits in
        // COMPLETION order instead, index k would name the wrong provider —
        // and this record type's whole point is that a deconflicted site
        // cannot be re-serialized unattributed. Exporting a mast under a
        // regulator's name that never asserted it is the one outcome worth
        // losing data to avoid.
        //
        // So the body must corroborate the provider the index named. The
        // signatures are structural, not heuristic: an Overpass answer is one
        // object carrying `elements`, an open-data row answer is a top-level
        // array. On a mismatch this drops the frame rather than decoding it
        // against a guess — the run reports fewer providers, never a wrong one.
        const char* observed = detect_body_format(payload);
        if (observed && std::strcmp(observed, spec->format) != 0) continue;

        if (std::strcmp(spec->format, "csv") == 0) decode_csv(*spec, payload, &reports);
        else if (std::strcmp(spec->format, "osm-json") == 0) decode_osm_json(*spec, payload, &reports);
        else if (std::strcmp(spec->format, "soql-json") == 0) decode_soql_json(*spec, payload, &reports);
        else if (std::strcmp(spec->format, "swiss-geojson") == 0) {
            decode_swiss_geojson(*spec, payload,
                                 static_cast<size_t>(provider_row_cap), &reports);
        }
        // JSON adapters land with the per-provider decoders; until each is
        // written and fixtured, an unsupported format contributes nothing
        // rather than a guess.
    }

    // IS THE FAN-IN DONE? Emit exactly once per run, or not at all yet.
    //
    // Counting to N (= descriptors emitted) is NOT a safe completion test:
    // `hostcap/http-request` answers a failed fetch with
    // `plugin_set_error(...); return 502` and pushes NO response frame
    // (http_request_module.cpp:368-370), so any provider or mirror that 504s
    // leaves the count permanently short. Mirrors exist precisely BECAUSE
    // upstreams fail — this session alone saw the main Overpass endpoint 504
    // while a mirror answered — so a count-based wait would hang on the normal
    // case, and a hung chain on this mount is a silent 502
    // (graph: sdn-cellular-sole-provider-508 / sdn-cellular-sole-provider-502).
    //
    // The sound signal is the scheduler's own ordering. Ready nodes are taken
    // FIRST-BY-INDEX and nothing runs concurrently (HERMES, flow_runtime.cpp:
    // 1045-1047), and `http` sits at a LOWER index than `parse`. So `parse`
    // only ever runs when `http` has nothing left to do: an invocation that
    // brings NO new response frame means every request has already been either
    // answered or failed, and nothing further is coming.
    //
    // `plugin_set_yielded` + `plugin_set_backlog_remaining` are what buy that
    // extra tick — they make this node ready again with an EMPTY queue
    // (JANUS, flow_runtime.cpp:381-388) — so the quiet invocation always
    // happens rather than being waited for.
    // Emit at the end of the first invocation that carries responses.
    //
    // Waiting for a count of N descriptors is NOT safe: `hostcap/http-request`
    // answers a failed fetch with `plugin_set_error(...); return 502` and pushes
    // NO response frame (http_request_module.cpp:368-370), so any provider or
    // mirror that 504s leaves a count-based wait permanently short. Mirrors
    // exist precisely BECAUSE upstreams fail — this session alone saw the main
    // Overpass endpoint 504 while a mirror answered — so counting to N would
    // hang on the ordinary case, and a hung chain on this mount is a silent 502
    // (graph: sdn-cellular-sole-provider-502).
    //
    // Waiting is also unnecessary. Ready nodes are taken FIRST-BY-INDEX and
    // nothing runs concurrently (HERMES, flow_runtime.cpp:1045-1047,1337-1338),
    // and `http` sits at a LOWER index than `parse`. So `http` drains its whole
    // request queue before `parse` is ever chosen, and every response that will
    // exist is already queued when `parse` first runs. With `responses` no
    // longer capped at maxStreams 1, one invocation sees all of them.
    //
    // The accumulator above still spans invocations, so this stays correct if
    // that ordering ever loosens; `g_emitted` is what keeps "once per run" true
    // either way, because `merge` -> `respond` -> `egress` can only carry ONE
    // HTTP body and a second emission would corrupt the transport.
    if (g_emitted) return 0;

    // WAIT FOR THE WHOLE FAN-IN. `parse` is invoked as soon as ONE response is
    // queued — it does NOT get to see them all in a single invocation, which
    // was measured live: emitting on the first batch produced exactly the
    // first-named provider's answer and dropped every later frame, and swapping
    // the PROVIDERS order swapped the result (88 vs 332 records).
    //
    // Emit as soon as every descriptor is accounted for. When some are NOT —
    // `hostcap/http-request` pushes NO frame for a failed fetch
    // (http_request_module.cpp:368-370), and Overpass ships three endpoints
    // precisely because they fail — the count never completes, so waiting on it
    // alone would hang, and a hung chain on this mount is a silent 502
    // (graph: sdn-cellular-sole-provider-502).
    //
    // So the count is the fast path and a QUIET TICK is the backstop:
    // `plugin_set_yielded` + `plugin_set_backlog_remaining` make this node ready
    // again with an EMPTY queue (JANUS, flow_runtime.cpp:381-388), and an
    // invocation that brings no new frame means nothing further is coming.
    const size_t expected = g_request_providers.size();
    const bool all_accounted_for = expected > 0 && g_response_cursor >= expected;
    if (!all_accounted_for) {
        if (new_responses > 0) {
            // Something arrived but not everything: ask for another look.
            if (++g_idle_ticks < 64) {
                plugin_set_yielded(1);
                plugin_set_backlog_remaining(1);
                return 0;
            }
            // Runaway guard. Answer short rather than never.
        } else if (g_response_cursor == 0) {
            // Nothing has arrived at all yet; nothing to answer with.
            return 0;
        }
        // else: a quiet tick after real responses — the fan-in is finished with
        // fewer frames than descriptors, which is the failed-fetch case.
    }

    if (!g_have_job) {
        // Responses with no run contract: nothing can be attributed, and
        // guessing is the one thing this record type must not do. Stay quiet
        // rather than emit an unattributed stream.
        return 0;
    }

    std::string out = "[";
    for (size_t i = 0; i < reports.size(); ++i) {
        if (i) out += ",";
        out += report_to_json(reports[i]);
    }
    out += "]";

    // Mark BEFORE pushing. A pooled instance is reset by the next run's `job`
    // frame; what must not happen is a SECOND emission inside this run.
    g_emitted = true;

    if (push_json("job", g_job) < 0) return 500;
    if (push_json("reports", out) < 0) return 500;
    return 0;
}

// ---------------------------------------------------------------------------
// deconflict: job + reports -> size-prefixed $TBS stream + run summary.
// ---------------------------------------------------------------------------
int deconflict(void) {
    const std::string job = input_text("job", 0);
    const std::string reports_json = input_text("reports", 0);

    const int8_t method = static_cast<int8_t>(json_number(job, "method", MM_HIGHEST_SAMPLE_COUNT));
    const long limit = static_cast<long>(json_number(job, "limit", 2000));
    const std::vector<std::string> consulted_ids = json_string_array(job, "providers_consulted");
    const size_t consulted = consulted_ids.size();

    std::vector<Report> reports;
    for (const std::string& obj : split_json_objects(reports_json)) {
        reports.push_back(report_from_json(obj));
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
    for (const std::vector<size_t>& group : groups) {
        if (limit > 0 && static_cast<long>(written) >= limit) break;
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
        const uint32_t len = static_cast<uint32_t>(record.size());
        stream.push_back(static_cast<uint8_t>(len & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 8) & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 16) & 0xff));
        stream.push_back(static_cast<uint8_t>((len >> 24) & 0xff));
        stream.insert(stream.end(), record.begin(), record.end());
        ++written;
    }

    const std::string summary =
        std::string("{\"route\":\"cellular-aggregate\",\"format\":\"record-stream\""
                    ",\"status\":200,\"reportsIn\":") + std::to_string(reports.size()) +
        ",\"sitesOut\":" + std::to_string(written) +
        ",\"collapsed\":" + std::to_string(reports.size() > written ? reports.size() - written : 0) +
        ",\"multiProviderSites\":" + std::to_string(multi) +
        ",\"providersConsulted\":" + std::to_string(consulted) +
        ",\"method\":\"" + json_escape(json_string(job, "method_name", "")) + "\"" +
        ",\"skipped\":" + json_string(job, "skipped", "[]") + "}";

    if (push_tbs_stream("records", stream) < 0) return 500;
    if (push_json("decision", summary) < 0) return 500;
    return 0;
}

}  // extern "C"
