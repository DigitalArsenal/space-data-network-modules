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
 * Request payload (JSON): {"btc":"bc1...","eth":"0x...","sol":"..."}
 * Response (JSON): {
 *   "attested": bool,
 *   "bond_usd": number, "bond_native": "0.1234 BTC", "total_usd": number,
 *   "holdings": [{"symbol":"BTC","name":"Bitcoin","amount":n,"usd":n}, ...],
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

// ── the attest method ────────────────────────────────────────────────────────

std::string run_attest(const uint8_t* req, uint32_t len) {
    std::string btcAddr, ethAddr, solAddr;
    if (req != nullptr && len > 0) {
        std::string json(reinterpret_cast<const char*>(req), len);
        ps::json_string_field(json, "btc", &btcAddr);
        ps::json_string_field(json, "eth", &ethAddr);
        ps::json_string_field(json, "sol", &solAddr);
    }

    std::vector<std::string> errors;
    std::string err;

    double pBtc = 0, pEth = 0, pSol = 0;
    bool havePrices = usd_prices(&pBtc, &pEth, &pSol, &err);
    if (!havePrices) errors.push_back(err);

    struct Row {
        const char* symbol;
        const char* name;
        bool have = false;
        double amount = 0;
        double price = 0;
    };
    Row rows[3] = {{"BTC", "Bitcoin"}, {"ETH", "Ethereum"}, {"SOL", "Solana"}};
    rows[0].price = pBtc;
    rows[1].price = pEth;
    rows[2].price = pSol;

    if (!btcAddr.empty()) {
        if (btc_balance(btcAddr, &rows[0].amount, &err)) rows[0].have = true;
        else errors.push_back(err);
    }
    if (!ethAddr.empty()) {
        if (eth_balance(ethAddr, &rows[1].amount, &err)) rows[1].have = true;
        else errors.push_back(err);
    }
    if (!solAddr.empty()) {
        if (sol_balance(solAddr, &rows[2].amount, &err)) rows[2].have = true;
        else errors.push_back(err);
    }

    bool anyBalance = rows[0].have || rows[1].have || rows[2].have;
    bool attested = anyBalance && havePrices;

    double total = 0;
    std::string holdings = "[";
    bool first = true;
    for (const Row& row : rows) {
        if (!row.have) continue;
        double usd = havePrices ? row.amount * row.price : 0;
        total += usd;
        if (!first) holdings += ",";
        first = false;
        holdings += "{\"symbol\":\"" + std::string(row.symbol) + "\",\"name\":\"" +
                    std::string(row.name) + "\",\"amount\":" + ps::double_to_json(row.amount) +
                    ",\"usd\":" + ps::double_to_json(usd) + "}";
    }
    holdings += "]";

    // The bond in native terms: the BTC equivalent of the USD total (the
    // template's own presentation), only stated when prices are real.
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

    return "{\"attested\":" + std::string(attested ? "true" : "false") +
           ",\"bond_usd\":" + ps::double_to_json(attested ? total : 0) +
           ",\"bond_native\":\"" + ps::json_escape(native) + "\"" +
           ",\"total_usd\":" + ps::double_to_json(attested ? total : 0) +
           ",\"holdings\":" + holdings + ",\"errors\":" + errJson + "}";
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
