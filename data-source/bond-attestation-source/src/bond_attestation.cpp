/*
 * Bond attestation module (owner 2026-08-03: "use a free service to get the
 * balance of SOL, BTC, and ETH ... in a wasm module (using the external API
 * accesses wired up)").
 *
 * The `attest` method takes the node's own EPM-derived chain addresses as its
 * invoke payload, queries FREE, keyless public services for each balance over
 * the generic `http` capability (WASM-not-Go-host-boundary law: chain RPC
 * lives here, never in the host), prices the totals in USD, and returns one
 * JSON attestation the host caches and serves at GET /api/v1/trust/bond.
 *
 * Sources (all free, no API key):
 *   BTC — blockstream.info Esplora: GET /api/address/<addr>
 *         (chain_stats.funded_txo_sum − chain_stats.spent_txo_sum, satoshis)
 *   ETH — publicnode JSON-RPC: eth_getBalance (hex wei)
 *   SOL — api.mainnet-beta.solana.com JSON-RPC: getBalance (lamports)
 *   USD — CoinGecko simple/price for bitcoin, ethereum, solana
 *
 * HONESTY: a chain that fails to answer contributes NOTHING and is named in
 * `errors[]` — the module never invents a balance. `attested` is true only
 * when at least one balance AND the price feed answered.
 *
 * PER-KEY ATTESTATION (owner ruling 2026-08-07, graph task
 * sdn-managed-key-registry-api): the server manages several keys (purpose
 * children of the node root, plus operator-configured external keys), and the
 * rollup must cover "all value across all keys that are being managed by a
 * server". The request therefore optionally carries `keys` — one address
 * triple per managed key, keyed by purpose label — and the response answers
 * per key AND in total. The legacy flat fields remain the ROOT's addresses so
 * an old host and an old module keep interoperating in both directions.
 *
 * Request payload (JSON):
 *   {"btc":"bc1...","eth":"0x...","sol":"...",              // the ROOT's
 *    "keys":{"identity-signing":{"btc":"...","eth":"..."},  // per managed key
 *            "licensing-grant":{"eth":"..."}}}              // (optional)
 * Response (JSON): {
 *   "attested": bool,
 *   "bond_usd": number,        // the ROOT key's bond (what backs the node id)
 *   "bond_native": "0.1234 BTC",
 *   "total_usd": number,       // the ROLLUP: every managed key, each funded
 *                              // (chain,address) counted exactly once
 *   "holdings": [{"symbol":"BTC","name":"Bitcoin","amount":n,"usd":n}, ...],
 *   "keys": [{"purpose":"identity-signing","attested":bool,"bond_usd":n,
 *             "holdings":[...]}, ...],
 *   "errors": ["..."]
 * }
 *
 * Hostcall ABI (space_data_module_host): see common/sdm_hostcall_wire.hpp.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string>
#include <vector>

#include "provider_source.hpp"

// $PIV invoke envelope (generated SDS): the host's InvokeMethod decodes ONLY a
// PIV response (modulert/invoke_codec.go), so the JSON rides in its payload
// arena on an output frame named "response".
#include "PIV_generated.h"

namespace ps = provider_source;

extern "C" {
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) { return static_cast<uint8_t*>(malloc(size)); }
__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) { free(ptr); }
}  // extern "C"

namespace {

// ── endpoints ────────────────────────────────────────────────────────────────

static const char* kBtcApiBase = "https://blockstream.info/api/address/";
static const char* kEthRpcUrl = "https://ethereum-rpc.publicnode.com";
static const char* kSolRpcUrl = "https://api.mainnet-beta.solana.com";
static const char* kPriceUrl =
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd";

// ── small JSON/number helpers (module-local) ────────────────────────────────

// Double-valued field lookup starting at `from` (first occurrence of `key`).
bool json_double_at(const std::string& json, const std::string& key, size_t from, double* out) {
    std::string needle = "\"" + key + "\"";
    size_t k = json.find(needle, from);
    if (k == std::string::npos) return false;
    size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    *out = strtod(json.c_str() + colon + 1, nullptr);
    return true;
}

// Hex quantity ("0x...") to double. Wei exceeds 64-bit for >18 ETH, so
// accumulate in floating point — sub-wei precision is irrelevant at USD scale.
double hex_to_double(const std::string& hex) {
    size_t i = 0;
    if (hex.size() >= 2 && hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) i = 2;
    double v = 0.0;
    for (; i < hex.size(); ++i) {
        char c = hex[i];
        int d;
        if (c >= '0' && c <= '9') d = c - '0';
        else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
        else break;
        v = v * 16.0 + d;
    }
    return v;
}

ps::HttpResult http_post_json(const std::string& url, const std::string& body) {
    ps::HttpResult r;
    std::string payload = "{\"method\":\"POST\",\"url\":\"" + ps::json_escape(url) +
                          "\",\"headers\":{\"Content-Type\":\"application/json\"},\"body\":\"" +
                          ps::json_escape(body) + "\"}";
    std::vector<uint8_t> env = ps::hostcall("http.request", payload);
    std::string meta = ps::envelope_meta_json(env);
    r.status = ps::json_number_field(meta, "status", 0);
    std::string encoding, respBody;
    ps::json_string_field(meta, "body_encoding", &encoding);
    if (!ps::json_string_field(meta, "body", &respBody)) return r;
    if (encoding == "base64") r.body = ps::base64_decode(respBody);
    else r.body = std::vector<uint8_t>(respBody.begin(), respBody.end());
    return r;
}

std::string body_str(const ps::HttpResult& r) {
    return std::string(r.body.begin(), r.body.end());
}

// ── per-chain balances (native units; ok=false on any failure) ──────────────

bool btc_balance(const std::string& addr, double* out, std::string* err) {
    ps::HttpResult r = ps::http_get(std::string(kBtcApiBase) + addr);
    if (r.status != 200 || r.body.empty()) {
        *err = "BTC: blockstream answered " + std::to_string(r.status);
        return false;
    }
    std::string j = body_str(r);
    // First occurrences of funded/spent sums are chain_stats (confirmed).
    size_t cs = j.find("\"chain_stats\"");
    if (cs == std::string::npos) {
        *err = "BTC: no chain_stats in answer";
        return false;
    }
    double funded = 0, spent = 0;
    if (!json_double_at(j, "funded_txo_sum", cs, &funded) ||
        !json_double_at(j, "spent_txo_sum", cs, &spent)) {
        *err = "BTC: txo sums missing";
        return false;
    }
    *out = (funded - spent) / 1e8;
    return true;
}

bool eth_balance(const std::string& addr, double* out, std::string* err) {
    std::string req = "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBalance\",\"params\":[\"" +
                      ps::json_escape(addr) + "\",\"latest\"],\"id\":1}";
    ps::HttpResult r = http_post_json(kEthRpcUrl, req);
    if (r.status != 200 || r.body.empty()) {
        *err = "ETH: rpc answered " + std::to_string(r.status);
        return false;
    }
    std::string hex;
    if (!ps::json_string_field(body_str(r), "result", &hex) || hex.empty()) {
        *err = "ETH: no result in answer";
        return false;
    }
    *out = hex_to_double(hex) / 1e18;
    return true;
}

bool sol_balance(const std::string& addr, double* out, std::string* err) {
    std::string req = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"" +
                      ps::json_escape(addr) + "\"]}";
    ps::HttpResult r = http_post_json(kSolRpcUrl, req);
    if (r.status != 200 || r.body.empty()) {
        *err = "SOL: rpc answered " + std::to_string(r.status);
        return false;
    }
    std::string j = body_str(r);
    size_t res = j.find("\"result\"");
    double lamports = 0;
    if (res == std::string::npos || !json_double_at(j, "value", res, &lamports)) {
        *err = "SOL: no result.value in answer";
        return false;
    }
    *out = lamports / 1e9;
    return true;
}

// USD prices; ok only if all three parse (one fetch, three sections).
bool usd_prices(double* btc, double* eth, double* sol, std::string* err) {
    ps::HttpResult r = ps::http_get(kPriceUrl);
    if (r.status != 200 || r.body.empty()) {
        *err = "PRICES: coingecko answered " + std::to_string(r.status);
        return false;
    }
    std::string j = body_str(r);
    size_t b = j.find("\"bitcoin\""), e = j.find("\"ethereum\""), s = j.find("\"solana\"");
    if (b == std::string::npos || e == std::string::npos || s == std::string::npos ||
        !json_double_at(j, "usd", b, btc) || !json_double_at(j, "usd", e, eth) ||
        !json_double_at(j, "usd", s, sol)) {
        *err = "PRICES: price fields missing";
        return false;
    }
    return true;
}

// ── request parsing (per-key address sets) ──────────────────────────────────

// One managed key's address triple, as requested by the host.
struct KeyAddresses {
    std::string purpose;
    std::string btc, eth, sol;
    bool empty() const { return btc.empty() && eth.empty() && sol.empty(); }
};

// object_span finds the '}' matching the '{' at `open`, skipping over quoted
// strings (an address or label must never unbalance the scan). Returns false
// on malformed input.
bool object_span(const std::string& j, size_t open, size_t* close) {
    if (open >= j.size() || j[open] != '{') return false;
    int depth = 0;
    bool inString = false;
    for (size_t i = open; i < j.size(); ++i) {
        char c = j[i];
        if (inString) {
            if (c == '\\') { ++i; continue; }
            if (c == '"') inString = false;
            continue;
        }
        if (c == '"') { inString = true; continue; }
        if (c == '{') ++depth;
        else if (c == '}') {
            if (--depth == 0) { *close = i; return true; }
        }
    }
    return false;
}

// parse_keys extracts the `keys` object: {"<purpose>":{"btc":...},...}. On
// success *keysStart/*keysEnd bound the object (inclusive) so the caller can
// keep flat-field parsing OUTSIDE it. Tolerant: a malformed keys object yields
// no entries rather than a crash — the host is trusted but versions skew.
void parse_keys(const std::string& j, std::vector<KeyAddresses>* out, size_t* keysStart, size_t* keysEnd) {
    *keysStart = std::string::npos;
    *keysEnd = std::string::npos;
    size_t k = j.find("\"keys\"");
    if (k == std::string::npos) return;
    size_t colon = j.find(':', k + 6);
    if (colon == std::string::npos) return;
    size_t open = j.find_first_not_of(" \t\r\n", colon + 1);
    if (open == std::string::npos || j[open] != '{') return;
    size_t close = 0;
    if (!object_span(j, open, &close)) return;
    *keysStart = k;
    *keysEnd = close;

    size_t i = open + 1;
    while (i < close) {
        size_t q1 = j.find('"', i);
        if (q1 == std::string::npos || q1 >= close) break;
        size_t q2 = j.find('"', q1 + 1);
        if (q2 == std::string::npos || q2 >= close) break;
        std::string purpose = j.substr(q1 + 1, q2 - q1 - 1);
        size_t pcolon = j.find(':', q2 + 1);
        if (pcolon == std::string::npos || pcolon >= close) break;
        size_t popen = j.find_first_not_of(" \t\r\n", pcolon + 1);
        if (popen == std::string::npos || popen >= close || j[popen] != '{') break;
        size_t pclose = 0;
        if (!object_span(j, popen, &pclose) || pclose > close) break;

        std::string sub = j.substr(popen, pclose - popen + 1);
        KeyAddresses entry;
        entry.purpose = purpose;
        ps::json_string_field(sub, "btc", &entry.btc);
        ps::json_string_field(sub, "eth", &entry.eth);
        ps::json_string_field(sub, "sol", &entry.sol);
        if (!entry.purpose.empty() && !entry.empty()) out->push_back(entry);
        i = pclose + 1;
    }
}

// ── the attest method ────────────────────────────────────────────────────────

// kRootPurpose is the purpose label of the node identity — the key whose bond
// the legacy top-level fields describe.
static const char* kRootPurpose = "identity-signing";

std::string run_attest(const uint8_t* req, uint32_t len) {
    std::vector<KeyAddresses> keys;
    std::string btcAddr, ethAddr, solAddr;
    if (req != nullptr && len > 0) {
        std::string json(reinterpret_cast<const char*>(req), len);
        size_t keysStart = std::string::npos, keysEnd = std::string::npos;
        parse_keys(json, &keys, &keysStart, &keysEnd);
        // Flat fields are parsed OUTSIDE the keys object, so a request whose
        // only "btc" lives inside some key's triple never mislabels it as the
        // root's.
        std::string flat = json;
        if (keysStart != std::string::npos && keysEnd != std::string::npos && keysEnd >= keysStart) {
            flat = json.substr(0, keysStart) + json.substr(keysEnd + 1);
        }
        ps::json_string_field(flat, "btc", &btcAddr);
        ps::json_string_field(flat, "eth", &ethAddr);
        ps::json_string_field(flat, "sol", &solAddr);
    }

    // The legacy flat triple IS the root's addresses. If the host did not send
    // an explicit identity-signing entry (an old host, or a legacy identity
    // that publishes EPM addresses without an HD inventory), synthesize one so
    // per-key and legacy answers stay one arithmetic.
    bool haveRootEntry = false;
    for (const KeyAddresses& k : keys) {
        if (k.purpose == kRootPurpose) { haveRootEntry = true; break; }
    }
    if (!haveRootEntry && !(btcAddr.empty() && ethAddr.empty() && solAddr.empty())) {
        KeyAddresses root;
        root.purpose = kRootPurpose;
        root.btc = btcAddr;
        root.eth = ethAddr;
        root.sol = solAddr;
        keys.insert(keys.begin(), root);
    }

    std::vector<std::string> errors;
    std::string err;

    double pBtc = 0, pEth = 0, pSol = 0;
    bool havePrices = usd_prices(&pBtc, &pEth, &pSol, &err);
    if (!havePrices) errors.push_back(err);

    // Balance cache: each unique (chain, address) is queried EXACTLY once, so
    // two keys sharing an address can never double-count it in the rollup and
    // the free APIs see the minimum number of requests.
    struct Balance {
        std::string chain, addr;
        bool ok = false;
        double amount = 0;
    };
    std::vector<Balance> cache;
    auto lookup = [&](const std::string& chain, const std::string& addr) -> Balance* {
        if (addr.empty()) return nullptr;
        for (Balance& b : cache) {
            if (b.chain == chain && b.addr == addr) return &b;
        }
        Balance b;
        b.chain = chain;
        b.addr = addr;
        std::string berr;
        if (chain == "btc") b.ok = btc_balance(addr, &b.amount, &berr);
        else if (chain == "eth") b.ok = eth_balance(addr, &b.amount, &berr);
        else b.ok = sol_balance(addr, &b.amount, &berr);
        if (!b.ok) errors.push_back(berr);
        cache.push_back(b);
        return &cache.back();
    };

    struct ChainSpec {
        const char* chain;
        const char* symbol;
        const char* name;
        double price;
    };
    ChainSpec chains[3] = {
        {"btc", "BTC", "Bitcoin", pBtc},
        {"eth", "ETH", "Ethereum", pEth},
        {"sol", "SOL", "Solana", pSol},
    };

    // Per-key answers.
    double rootUsd = 0;
    bool rootAttested = false;
    std::string rootHoldings = "[]";
    std::string keysJson = "[";
    bool firstKey = true;
    for (const KeyAddresses& key : keys) {
        const std::string addrs[3] = {key.btc, key.eth, key.sol};
        double keyUsd = 0;
        bool anyBalance = false;
        std::string holdings = "[";
        bool firstRow = true;
        for (int c = 0; c < 3; ++c) {
            Balance* b = lookup(chains[c].chain, addrs[c]);
            if (b == nullptr || !b->ok) continue;
            anyBalance = true;
            double usd = havePrices ? b->amount * chains[c].price : 0;
            keyUsd += usd;
            if (!firstRow) holdings += ",";
            firstRow = false;
            holdings += "{\"symbol\":\"" + std::string(chains[c].symbol) + "\",\"name\":\"" +
                        std::string(chains[c].name) + "\",\"amount\":" + ps::double_to_json(b->amount) +
                        ",\"usd\":" + ps::double_to_json(usd) + "}";
        }
        holdings += "]";
        bool keyAttested = anyBalance && havePrices;
        if (key.purpose == kRootPurpose) {
            rootUsd = keyAttested ? keyUsd : 0;
            rootAttested = keyAttested;
            rootHoldings = holdings;
        }
        if (!firstKey) keysJson += ",";
        firstKey = false;
        keysJson += "{\"purpose\":\"" + ps::json_escape(key.purpose) +
                    "\",\"attested\":" + (keyAttested ? "true" : "false") +
                    ",\"bond_usd\":" + ps::double_to_json(keyAttested ? keyUsd : 0) +
                    ",\"holdings\":" + holdings + "}";
    }
    keysJson += "]";

    // THE ROLLUP: every unique funded (chain, address) exactly once — "the
    // rollup of all value across all keys that are being managed by a server".
    bool anyBalance = false;
    double total = 0;
    for (const Balance& b : cache) {
        if (!b.ok) continue;
        anyBalance = true;
        for (int c = 0; c < 3; ++c) {
            if (b.chain == chains[c].chain) total += havePrices ? b.amount * chains[c].price : 0;
        }
    }
    bool attested = anyBalance && havePrices;

    // The bond in native terms: the BTC equivalent of the USD rollup, only
    // stated when prices are real.
    std::string native;
    if (attested && pBtc > 0) {
        char buf[64];
        snprintf(buf, sizeof(buf), "%.4f BTC", total / pBtc);
        native = buf;
    }

    std::string errJson = "[";
    for (size_t i = 0; i < errors.size(); ++i) {
        if (i) errJson += ",";
        errJson += "\"" + ps::json_escape(errors[i]) + "\"";
    }
    errJson += "]";

    // Legacy fields keep their meaning for a single-key node (root bond ==
    // rollup); with N keys, `bond_usd`/`holdings` stay the ROOT's — the number
    // that prices trust in the node identity — and `total_usd` is the rollup.
    (void)rootAttested;
    return "{\"attested\":" + std::string(attested ? "true" : "false") +
           ",\"bond_usd\":" + ps::double_to_json(rootUsd) +
           ",\"bond_native\":\"" + ps::json_escape(native) + "\"" +
           ",\"total_usd\":" + ps::double_to_json(attested ? total : 0) +
           ",\"holdings\":" + rootHoldings +
           ",\"keys\":" + keysJson +
           ",\"errors\":" + errJson + "}";
}

}  // namespace

namespace {

// Wrap the attestation JSON in the $PIV response envelope the host decodes:
// STATUS_CODE 0, one output frame "response" spanning the whole arena.
std::vector<uint8_t> wrap_piv_response(const std::string& json) {
    flatbuffers::FlatBufferBuilder fbb(512 + json.size());
    std::vector<uint8_t> arena(json.begin(), json.end());
    std::vector<flatbuffers::Offset<TAB>> outputs;
    outputs.push_back(CreateTABDirect(
        fbb, /*OFFSET=*/0, /*SIZE=*/static_cast<uint32_t>(arena.size()),
        /*ALIGNMENT=*/1, payloadWireFormat::ALIGNED_BINARY, /*TYPE_REF=*/0,
        bufferMutability::IMMUTABLE, bufferOwnership::HOST_OWNED,
        /*FRAME_ID=*/0, /*PORT_ID=*/"response"));
    auto resp = CreatePIVResponseDirect(fbb, /*STATUS_CODE=*/0, pivStatus::OK,
                                        /*YIELDED=*/false, /*BACKLOG_REMAINING=*/0,
                                        &outputs, &arena);
    auto root = CreatePIV(fbb, /*REQUEST=*/0, resp);
    FinishPIVBuffer(fbb, root);
    return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

}  // namespace

extern "C" {

__attribute__((visibility("default")))
uint8_t* plugin_invoke_stream(const uint8_t* req_ptr, uint32_t req_len, uint32_t* out_len_ptr) {
    std::vector<uint8_t> result = wrap_piv_response(run_attest(req_ptr, req_len));
    uint8_t* out = static_cast<uint8_t*>(malloc(result.size()));
    if (out != nullptr) {
        for (size_t i = 0; i < result.size(); i++) out[i] = result[i];
    }
    if (out_len_ptr != nullptr) *out_len_ptr = static_cast<uint32_t>(result.size());
    return out;
}

}  // extern "C"
