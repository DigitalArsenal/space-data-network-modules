// Security-bond attestation: a WHA request (ACCOUNTS only) in, the WHA attestation out. Public holdings and quotes
// through the host's http capability (sdm_piv "http.request", typed HttpParams/HttpResult); the clock gives AS_OF_MS.
// No keys or transactions. Free sources: mempool/Esplora, public chain RPC, Blockscout, Coinbase, CoinGecko,
// DEX Screener. Their answers are the providers' own JSON, parsed here and never passed on.
#define JSON_NOEXCEPTION 1
#include "../../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp"
#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "WHA_generated.h"  // spacedatastandards.org lib/cpp/WHA/main_generated.h, inlined by build.mjs
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>
using Json = nlohmann::json;
namespace {
constexpr const char* kAttester = "org.spacedatanetwork.bond-attestation";
constexpr size_t kMaxAccounts = 16;
struct ChainSpec { const char* name; const char* caip2; int decimals; };
const ChainSpec kChains[] = {{"BTC", "bip122:000000000019d6689c085ae165831e93", 8},
                             {"ETH", "eip155:1", 18},
                             {"SOL", "solana:5eykt4UsFv8P8NJdTREpY1vzQKqZKvdp", 9}};
const ChainSpec* chainOf(const std::string& id, const std::string& name) {
  for (const auto& c : kChains)
    if ((!id.empty() && id == c.caip2) || (id.empty() && name == c.name)) return &c;
  return nullptr;
}
// Explicit failure values keep network and parse failures out of C++ exception unwinding. They never become zero
// balances or poison the runtime instance.
const Json& field(const Json& j, const char* key) {
  static const Json absent = nullptr;
  return j.is_object() && j.contains(key) ? j[key] : absent;
}
std::string text(const Json& j) { return j.is_string() ? j.get<std::string>() : ""; }
double number(const Json& j) {
  double n = NAN;
  if (j.is_number()) n = j.get<double>();
  if (j.is_string()) {
    auto s = j.get<std::string>();
    char* end = nullptr;
    n = strtod(s.c_str(), &end);
    if (s.empty() || end != s.c_str() + s.size()) return NAN;
  }
  return std::isfinite(n) && n >= 0 ? n : NAN;
}
bool digits(const std::string& s) { return !s.empty() && s.find_first_not_of("0123456789") == std::string::npos; }
// Exact decimal-integer strings for AMOUNT_BASE_UNITS.
std::string addDec(const std::string& a, const std::string& b) {
  std::string out;
  int carry = 0;
  for (size_t i = 0; i < a.size() || i < b.size() || carry; ++i) {
    int d = carry + (i < a.size() ? a[a.size() - 1 - i] - '0' : 0) + (i < b.size() ? b[b.size() - 1 - i] - '0' : 0);
    out.insert(out.begin(), char('0' + d % 10));
    carry = d / 10;
  }
  auto nz = out.find_first_not_of('0');
  return nz == std::string::npos ? "0" : out.substr(nz);
}
std::string hexToDec(const std::string& hex) {  // without the 0x
  std::string dec = "0";
  for (char ch : hex) {
    int v = static_cast<int>(std::string("0123456789abcdef").find(static_cast<char>(tolower(ch))));
    int carry = v;
    for (size_t i = dec.size(); i-- > 0;) {  // dec = dec * 16 + v
      int d = (dec[i] - '0') * 16 + carry;
      dec[i] = char('0' + d % 10);
      carry = d / 10;
    }
    while (carry) { dec.insert(dec.begin(), char('0' + carry % 10)); carry /= 10; }
  }
  auto nz = dec.find_first_not_of('0');
  return nz == std::string::npos ? "0" : dec.substr(nz);
}
std::string hostOf(const std::string& url) {
  auto start = url.find("://");
  start = start == std::string::npos ? 0 : start + 3;
  return url.substr(start, url.find('/', start) - start);
}
// One GET (or JSON POST) through the host. Null unless the answer is 200 and JSON.
Json request(const std::string& url, const Json& body = nullptr, std::string* source = nullptr) {
  sdn::runtime::Aligned::HttpParams p{};
  const bool post = !body.is_null();
  sdm_piv::put(p.METHOD, post ? "POST" : "GET");
  p.set_has_METHOD(true);
  p.TIMEOUT_MS = 10000;
  p.MAX_BYTES = 4194304;
  // The host remembers validators but this short-lived module has no prior response body. Ask for a complete
  // snapshot rather than a bodyless 304.
  std::string headers = "If-Modified-Since: Thu, 01 Jan 1970 00:00:00 GMT\n";
  std::string payload;
  if (post) { headers += "Content-Type: application/json\n"; payload = body.dump(); }
  auto r = post ? sdm_piv::call("http.request", "HttpParams", p,
                                {sdm_piv::raw("url", url), sdm_piv::raw("headers", headers), sdm_piv::raw("body", payload)})
                : sdm_piv::call("http.request", "HttpParams", p, {sdm_piv::raw("url", url), sdm_piv::raw("headers", headers)});
  const auto* result = r.result<sdn::runtime::Aligned::HttpResult>();
  if (!result || result->STATUS != 200) return nullptr;
  auto raw = r.raw("body");
  auto parsed = Json::parse(raw.begin(), raw.end(), nullptr, false);
  if (parsed.is_discarded()) return nullptr;
  if (source) *source = hostOf(url);
  return parsed;
}
Json rpc(const std::string& chain, const std::string& method, const Json& params, std::string* source = nullptr) {
  const std::vector<std::string> urls =
      chain == "ETH" ? std::vector<std::string>{"https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"}
                     : std::vector<std::string>{"https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"};
  for (const auto& url : urls) {
    auto answer = request(url, {{"jsonrpc", "2.0"}, {"id", 1}, {"method", method}, {"params", params}});
    if (field(answer, "error").is_null() && !field(answer, "result").is_null()) {
      if (source) *source = hostOf(url);
      return answer["result"];
    }
  }
  return nullptr;
}
struct Row {
  std::string symbol, contract, baseUnits, priceSource, balanceSource;
  int kind = 1, decimals = 0;
  double amount = 0, price = NAN, value = NAN;
};
// Native balance in whole units (NAN when no source answered), its base units and the service that gave it.
double nativeBalance(const std::string& chain, const std::string& address, std::string& baseUnits, std::string& source) {
  if (chain == "BTC") {
    for (const auto& base : {"https://mempool.space/api/address/", "https://blockstream.info/api/address/"}) {
      auto answer = request(std::string(base) + address, nullptr, &source);
      const auto& stats = field(answer, "chain_stats");
      auto funded = number(field(stats, "funded_txo_sum")), spent = number(field(stats, "spent_txo_sum"));
      if (std::isfinite(funded) && std::isfinite(spent) && funded >= spent) {
        char buf[32];
        snprintf(buf, sizeof buf, "%.0f", funded - spent);
        baseUnits = buf;
        return (funded - spent) / 1e8;
      }
    }
    return NAN;
  }
  if (chain == "SOL") {
    auto lamports = number(field(rpc(chain, "getBalance", Json::array({address, {{"commitment", "finalized"}}}), &source), "value"));
    if (std::isfinite(lamports)) {
      char buf[32];
      snprintf(buf, sizeof buf, "%.0f", lamports);
      baseUnits = buf;
    }
    return lamports / 1e9;
  }
  auto hex = text(rpc(chain, "eth_getBalance", Json::array({address, "latest"}), &source));
  if (hex.size() < 3 || hex.substr(0, 2) != "0x") return NAN;
  double value = 0;
  for (size_t i = 2; i < hex.size(); ++i) {
    auto pos = std::string("0123456789abcdef").find(static_cast<char>(tolower(hex[i])));
    if (pos == std::string::npos) return NAN;
    value = value * 16 + pos;
  }
  if (!std::isfinite(value)) return NAN;
  baseUnits = hexToDec(hex.substr(2));
  return value / 1e18;
}
double nativePrice(const std::string& symbol, std::string& source) {
  auto answer = request("https://api.coinbase.com/v2/prices/" + symbol + "-USD/spot");
  double price = number(field(field(answer, "data"), "amount"));
  if (price > 0) { source = "coinbase"; return price; }
  const std::string id = symbol == "BTC" ? "bitcoin" : symbol == "ETH" ? "ethereum" : "solana";
  answer = request("https://api.coingecko.com/api/v3/simple/price?ids=" + id + "&vs_currencies=usd");
  price = number(field(field(answer, id.c_str()), "usd"));
  if (price > 0) { source = "coingecko"; return price; }
  return NAN;
}
bool ethTokens(const std::string& address, std::vector<Row>& rows) {
  // This endpoint returns all balances, without pagination. NFTs aren't money.
  auto result = request("https://eth.blockscout.com/api/v2/addresses/" + address + "/token-balances");
  if (!result.is_array() || result.size() > 2000) return false;
  for (const auto& entry : result) {
    const auto& token = field(entry, "token");
    if (text(field(token, "type")) != "ERC-20") continue;
    auto decimals = number(field(token, "decimals")), value = number(field(entry, "value"));
    if (!std::isfinite(decimals) || decimals > 255 || std::floor(decimals) != decimals || !std::isfinite(value)) return false;
    double amount = value / std::pow(10, decimals);
    if (amount == 0) continue;
    double price = number(field(token, "exchange_rate"));
    auto contract = text(field(token, "address_hash"));
    if (contract.empty()) return false;
    auto symbol = text(field(token, "symbol"));
    Row row;
    row.kind = 2;
    row.symbol = symbol.empty() ? "Token" : symbol;
    row.contract = contract;
    row.amount = amount;
    row.decimals = static_cast<int>(decimals);
    auto raw = text(field(entry, "value"));
    if (digits(raw)) row.baseUnits = raw;
    row.balanceSource = "eth.blockscout.com";
    if (price > 0 && std::isfinite(amount * price)) { row.price = price; row.value = amount * price; row.priceSource = "blockscout"; }
    rows.push_back(row);
  }
  return true;
}
bool solTokens(const std::string& address, std::vector<Row>& rows) {
  struct Mint { double amount = 0; std::string base = "0"; bool exact = true; int decimals = -1; std::string source; };
  std::map<std::string, Mint> balances;
  for (const auto& program : {"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"}) {
    std::string source;
    auto result = rpc("SOL", "getTokenAccountsByOwner",
                      Json::array({address, {{"programId", program}}, {{"encoding", "jsonParsed"}, {"commitment", "finalized"}}}), &source);
    const auto& entries = field(result, "value");
    if (!entries.is_array() || entries.size() > 2000) return false;
    for (const auto& entry : entries) {
      const auto& info = field(field(field(field(entry, "account"), "data"), "parsed"), "info");
      if (text(field(info, "owner")) != address) return false;
      auto mint = text(field(info, "mint"));
      const auto& tokenAmount = field(info, "tokenAmount");
      double amount = number(field(tokenAmount, "uiAmountString"));
      if (mint.empty() || !std::isfinite(amount)) return false;
      if (amount > 0) {
        auto& m = balances[mint];
        m.amount += amount;
        m.source = source;
        auto raw = text(field(tokenAmount, "amount"));
        if (digits(raw)) m.base = addDec(m.base, raw); else m.exact = false;
        auto d = number(field(tokenAmount, "decimals"));
        if (std::isfinite(d) && d <= 255 && std::floor(d) == d) m.decimals = static_cast<int>(d);
      }
    }
  }
  // At most 30 mints per price request. Match contracts, never ticker symbols.
  std::vector<std::string> mints;
  for (const auto& pair : balances) mints.push_back(pair.first);
  for (size_t start = 0; start < mints.size(); start += 30) {
    std::string ids;
    for (size_t i = start; i < mints.size() && i < start + 30; ++i) {
      if (!ids.empty()) ids += ",";
      ids += mints[i];
    }
    auto quotes = request("https://api.dexscreener.com/tokens/v1/solana/" + ids);
    for (size_t i = start; i < mints.size() && i < start + 30; ++i) {
      const auto& mint = mints[i];
      const auto& m = balances[mint];
      double liquidity = -1;
      Row row;
      row.kind = 2;
      row.symbol = mint.substr(0, 8) + "…";
      if (quotes.is_array())
        for (const auto& q : quotes) {
          if (text(field(q, "chainId")) != "solana" || text(field(field(q, "baseToken"), "address")) != mint) continue;
          auto l = number(field(field(q, "liquidity"), "usd")), price = number(field(q, "priceUsd"));
          if (l > liquidity && l > 0 && price > 0 && std::isfinite(m.amount * price)) {
            liquidity = l;
            row.price = price;
            row.value = m.amount * price;
            row.priceSource = "dexscreener";
            auto label = text(field(field(q, "baseToken"), "symbol"));
            if (!label.empty()) row.symbol = label;
          }
        }
      row.contract = mint;
      row.amount = m.amount;
      if (m.exact) row.baseUnits = m.base;
      if (m.decimals >= 0) row.decimals = m.decimals;
      row.balanceSource = m.source;
      rows.push_back(row);
    }
  }
  return true;
}
int64_t nowMs() {
  auto r = sdm_piv::call("clock.now");
  const auto* t = r.result<sdn::runtime::Aligned::TimeValue>();
  return t ? static_cast<int64_t>(t->UNIX_MS) : 0;
}
struct Account { const ChainSpec* chain; std::string address, accountId; };
// The attestation: what was read, or (refused) the accounts echoed with ERRORS "invalid request".
int pushAttestation(const std::vector<Account>& accounts, bool refused) {
  flatbuffers::FlatBufferBuilder b(4096);
  std::vector<flatbuffers::Offset<WHAAccount>> accountOffsets;
  std::vector<flatbuffers::Offset<WHAHolding>> holdings;
  std::vector<flatbuffers::Offset<WHAChain>> chains;
  std::vector<std::string> errors;
  double total = 0;
  for (const auto& a : accounts)
    accountOffsets.push_back(CreateWHAAccountDirect(b, a.chain->caip2, a.chain->name, a.address.c_str(),
                                                    a.accountId.empty() ? nullptr : a.accountId.c_str()));
  if (refused) errors.push_back("invalid request");
  else
    for (const auto& a : accounts) {
      const std::string chain = a.chain->name;
      std::vector<Row> rows;
      bool complete = true;
      Row native;
      native.kind = 1;
      native.symbol = chain;
      native.decimals = a.chain->decimals;
      native.amount = nativeBalance(chain, a.address, native.baseUnits, native.balanceSource);
      if (std::isfinite(native.amount)) {
        if (native.amount == 0) { native.price = NAN; native.value = 0; }
        else {
          native.price = nativePrice(chain, native.priceSource);
          native.value = native.amount * native.price;
        }
        rows.push_back(native);
      } else complete = false;
      if (chain == "ETH" && !ethTokens(a.address, rows)) complete = false;
      if (chain == "SOL" && !solTokens(a.address, rows)) complete = false;
      double sum = 0;
      uint32_t count = 0;
      for (const auto& row : rows) {
        if (row.amount > 0) ++count;
        const bool valued = std::isfinite(row.value);
        if (!valued) complete = false; else sum += row.value;
        holdings.push_back(CreateWHAHoldingDirect(
            b, a.chain->caip2, a.chain->name, a.address.c_str(), static_cast<whaAssetKind>(row.kind), row.symbol.c_str(),
            row.contract.empty() ? nullptr : row.contract.c_str(), nullptr, row.amount,
            row.baseUnits.empty() ? nullptr : row.baseUnits.c_str(), static_cast<uint8_t>(row.decimals), valued,
            valued ? row.value : 0.0, std::isfinite(row.price) ? row.price : 0.0,
            row.priceSource.empty() ? nullptr : row.priceSource.c_str(),
            row.balanceSource.empty() ? nullptr : row.balanceSource.c_str()));
      }
      std::string error = complete ? "" : chain + ": lookup incomplete";
      if (!complete) errors.push_back(error);
      chains.push_back(CreateWHAChainDirect(b, a.chain->caip2, a.chain->name, a.address.c_str(), count, complete, sum, 0,
                                            chain == "ETH" ? "latest" : chain == "SOL" ? "finalized" : "confirmed",
                                            error.empty() ? nullptr : error.c_str()));
      total += sum;
    }
  const bool attested = !chains.empty() && errors.empty() && std::isfinite(total);
  std::vector<flatbuffers::Offset<flatbuffers::String>> errorOffsets;
  for (const auto& e : errors) errorOffsets.push_back(b.CreateString(e));
  const int64_t asOf = refused ? 0 : nowMs();
  FinishWHABuffer(b, CreateWHADirect(b, nullptr, nullptr, "security-bond", &accountOffsets, &holdings, &chains, "USD",
                                     attested, std::isfinite(total) ? total : 0.0, &errorOffsets, asOf, kAttester));
  return plugin_push_output_ex("attestation", "WHA.fbs", "$WHA", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "WHA", 0, 0,
                               b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 1 : 0;
}
}  // namespace

extern "C" int attest(void) {
  if (plugin_get_input_count() != 1) {
    plugin_set_error("invalid-request", "exactly one WHA request is required on the request port.");
    return 1;
  }
  const auto* input = plugin_get_input_frame(0);
  if (!input || !input->port_id || std::strcmp(input->port_id, "request") || !input->payload || !input->payload_length) {
    plugin_set_error("invalid-request", "the input must be one WHA on the request port.");
    return 1;
  }
  flatbuffers::Verifier verifier(input->payload, input->payload_length);
  if (!VerifyWHABuffer(verifier)) {
    plugin_set_error("invalid-request-frame", "the request frame is not a WHA ($WHA).");
    return 1;
  }
  const auto* req = GetWHA(input->payload);
  std::vector<Account> accounts;
  // As before: an account without an address is skipped; an unknown chain or a malformed address refuses the request.
  bool refused = req->ACCOUNTS() && req->ACCOUNTS()->size() > kMaxAccounts;
  if (req->ACCOUNTS())
    for (const auto* a : *req->ACCOUNTS()) {
      if (accounts.size() == kMaxAccounts) break;
      const std::string id = a->CHAIN_ID() ? a->CHAIN_ID()->str() : "", name = a->CHAIN_NAME() ? a->CHAIN_NAME()->str() : "";
      const std::string address = a->ADDRESS() ? a->ADDRESS()->str() : "";
      if (address.empty()) continue;
      const ChainSpec* chain = chainOf(id, name);
      if (!chain || address.size() > 128 ||
          address.find_first_not_of("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") != std::string::npos) {
        refused = true;
        continue;
      }
      accounts.push_back({chain, address, a->ACCOUNT_ID() ? a->ACCOUNT_ID()->str() : ""});
    }
  return pushAttestation(accounts, refused);
}
