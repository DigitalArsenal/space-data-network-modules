// Public holdings and quotes through the generic HTTP capability. No keys or
// transactions. Free sources: mempool/Esplora, public chain RPC, Blockscout,
// Coinbase, DEX Screener.
#include "../../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp"
#include "PIV_generated.h"
#include "provider_source.hpp"
#include <cmath>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>
namespace ps = provider_source;
using Json = nlohmann::json;
extern "C" {
__attribute__((visibility("default"))) uint8_t *plugin_alloc(uint32_t n) {
  return static_cast<uint8_t *>(malloc(n));
}
__attribute__((visibility("default"))) void plugin_free(uint8_t *p, uint32_t) {
  free(p);
}
}
namespace {
// Explicit failure values keep network and parse failures out of C++ exception
// unwinding. They never become zero balances or poison the runtime instance.
const Json &field(const Json &j, const char *key) {
  static const Json absent = nullptr;
  return j.is_object() && j.contains(key) ? j[key] : absent;
}
std::string text(const Json &j) {
  return j.is_string() ? j.get<std::string>() : "";
}
double number(const Json &j) {
  double n = NAN;
  if (j.is_number())
    n = j.get<double>();
  if (j.is_string()) {
    auto s = j.get<std::string>();
    char *end = nullptr;
    n = strtod(s.c_str(), &end);
    if (s.empty() || end != s.c_str() + s.size())
      return NAN;
  }
  return std::isfinite(n) && n >= 0 ? n : NAN;
}
Json request(const std::string &url, const Json &body = nullptr) {
  Json payload = {{"method", body.is_null() ? "GET" : "POST"},
                  {"url", url},
                  {"max_bytes", 4194304},
                  {"timeout_ms", 10000}};
  // The host remembers validators but this short-lived module has no prior
  // response body. Ask for a complete snapshot rather than a bodyless 304.
  payload["headers"] = {{"If-Modified-Since", "Thu, 01 Jan 1970 00:00:00 GMT"}};
  if (!body.is_null()) {
    payload["body"] = body.dump();
    payload["headers"]["Content-Type"] = "application/json";
  }
  auto env = ps::hostcall("http.request", payload.dump());
  auto meta = Json::parse(ps::envelope_meta_json(env), nullptr, false);
  // The native capability wraps successful replies in {ok,result}.
  if (field(meta, "result").is_object())
    meta = Json(field(meta, "result"));
  if (number(field(meta, "status")) != 200)
    return nullptr;
  auto raw = text(field(meta, "body"));
  std::vector<uint8_t> bytes;
  if (text(field(meta, "body_encoding")) == "base64")
    bytes = ps::base64_decode(raw);
  else
    bytes.assign(raw.begin(), raw.end());
  auto result = Json::parse(bytes.begin(), bytes.end(), nullptr, false);
  return result.is_discarded() ? Json(nullptr) : result;
}
Json rpc(const std::string &chain, const std::string &method,
         const Json &params) {
  const std::vector<std::string> urls =
      chain == "ETH"
          ? std::vector<std::string>{"https://ethereum-rpc.publicnode.com",
                                     "https://eth.llamarpc.com"}
          : std::vector<std::string>{"https://api.mainnet-beta.solana.com",
                                     "https://solana-rpc.publicnode.com"};
  for (const auto &url : urls) {
    auto answer = request(url, {{"jsonrpc", "2.0"},
                                {"id", 1},
                                {"method", method},
                                {"params", params}});
    if (field(answer, "error").is_null() && !field(answer, "result").is_null())
      return answer["result"];
  }
  return nullptr;
}
double nativeBalance(const std::string &chain, const std::string &address) {
  if (chain == "BTC") {
    for (const auto &base : {"https://mempool.space/api/address/",
                             "https://blockstream.info/api/address/"}) {
      auto answer = request(std::string(base) + address);
      const auto &stats = field(answer, "chain_stats");
      auto funded = number(field(stats, "funded_txo_sum")),
           spent = number(field(stats, "spent_txo_sum"));
      if (std::isfinite(funded) && std::isfinite(spent) && funded >= spent)
        return (funded - spent) / 1e8;
    }
    return NAN;
  }
  if (chain == "SOL")
    return number(
               field(rpc(chain, "getBalance",
                         Json::array({address, {{"commitment", "finalized"}}})),
                     "value")) /
           1e9;
  auto hex =
      text(rpc(chain, "eth_getBalance", Json::array({address, "latest"})));
  if (hex.size() < 3 || hex.substr(0, 2) != "0x")
    return NAN;
  double value = 0;
  for (size_t i = 2; i < hex.size(); ++i) {
    auto pos = std::string("0123456789abcdef")
                   .find(static_cast<char>(tolower(hex[i])));
    if (pos == std::string::npos)
      return NAN;
    value = value * 16 + pos;
  }
  return std::isfinite(value) ? value / 1e18 : NAN;
}
double nativePrice(const std::string &symbol) {
  auto answer =
      request("https://api.coinbase.com/v2/prices/" + symbol + "-USD/spot");
  double price = number(field(field(answer, "data"), "amount"));
  if (price > 0)
    return price;
  const std::string id = symbol == "BTC"   ? "bitcoin"
                         : symbol == "ETH" ? "ethereum"
                                           : "solana";
  answer = request("https://api.coingecko.com/api/v3/simple/price?ids=" + id +
                   "&vs_currencies=usd");
  price = number(field(field(answer, id.c_str()), "usd"));
  return price > 0 ? price : NAN;
}
bool ethTokens(const std::string &address, Json &rows) {
  // This endpoint returns all balances, without pagination. NFTs aren't money.
  auto result = request("https://eth.blockscout.com/api/v2/addresses/" +
                        address + "/token-balances");
  if (!result.is_array() || result.size() > 2000)
    return false;
  for (const auto &entry : result) {
    const auto &token = field(entry, "token");
    if (text(field(token, "type")) != "ERC-20")
      continue;
    auto decimals = number(field(token, "decimals")),
         value = number(field(entry, "value"));
    if (!std::isfinite(decimals) || decimals > 255 ||
        std::floor(decimals) != decimals || !std::isfinite(value))
      return false;
    double amount = value / std::pow(10, decimals);
    if (amount == 0)
      continue;
    double price = number(field(token, "exchange_rate"));
    auto contract = text(field(token, "address_hash"));
    if (contract.empty())
      return false;
    auto symbol = text(field(token, "symbol"));
    rows.push_back({{"symbol", symbol.empty() ? "Token" : symbol},
                    {"contract", contract},
                    {"amount", amount},
                    {"usd", price > 0 && std::isfinite(amount * price)
                                ? Json(amount * price)
                                : Json(nullptr)}});
  }
  return true;
}
bool solTokens(const std::string &address, Json &rows) {
  std::map<std::string, double> balances;
  for (const auto &program : {"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                              "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"}) {
    auto result = rpc("SOL", "getTokenAccountsByOwner",
                      Json::array({address,
                                   {{"programId", program}},
                                   {{"encoding", "jsonParsed"},
                                    {"commitment", "finalized"}}}));
    const auto &entries = field(result, "value");
    if (!entries.is_array() || entries.size() > 2000)
      return false;
    for (const auto &entry : entries) {
      const auto &info = field(
          field(field(field(entry, "account"), "data"), "parsed"), "info");
      if (text(field(info, "owner")) != address)
        return false;
      auto mint = text(field(info, "mint"));
      double amount =
          number(field(field(info, "tokenAmount"), "uiAmountString"));
      if (mint.empty() || !std::isfinite(amount))
        return false;
      if (amount > 0)
        balances[mint] += amount;
    }
  }
  // At most 30 mints per price request. Match contracts, never ticker symbols.
  std::vector<std::string> mints;
  for (const auto &pair : balances)
    mints.push_back(pair.first);
  for (size_t start = 0; start < mints.size(); start += 30) {
    std::string ids;
    for (size_t i = start; i < mints.size() && i < start + 30; ++i) {
      if (!ids.empty())
        ids += ",";
      ids += mints[i];
    }
    auto quotes =
        request("https://api.dexscreener.com/tokens/v1/solana/" + ids);
    for (size_t i = start; i < mints.size() && i < start + 30; ++i) {
      const auto &mint = mints[i];
      double liquidity = -1;
      Json usd = nullptr;
      std::string symbol = mint.substr(0, 8) + "…";
      if (quotes.is_array())
        for (const auto &q : quotes) {
          if (text(field(q, "chainId")) != "solana" ||
              text(field(field(q, "baseToken"), "address")) != mint)
            continue;
          auto l = number(field(field(q, "liquidity"), "usd")),
               price = number(field(q, "priceUsd"));
          if (l > liquidity && l > 0 && price > 0 &&
              std::isfinite(balances[mint] * price)) {
            liquidity = l;
            usd = balances[mint] * price;
            auto label = text(field(field(q, "baseToken"), "symbol"));
            if (!label.empty())
              symbol = label;
          }
        }
      rows.push_back({{"symbol", symbol},
                      {"contract", mint},
                      {"amount", balances[mint]},
                      {"usd", usd}});
    }
  }
  return true;
}
std::string invalid() {
  return R"({"attested":false,"bond_usd":null,"holdings":[],"chains":[],"errors":["invalid request"]})";
}
std::string run_attest(const uint8_t *req, uint32_t len) {
  flatbuffers::Verifier verifier(req, len);
  if (!VerifyPIVBuffer(verifier))
    return invalid();
  auto call = GetPIV(req)->REQUEST();
  if (!call || !call->METHOD_ID() || call->METHOD_ID()->str() != "attest" ||
      !call->INPUTS() || !call->PAYLOAD_ARENA())
    return invalid();
  auto arena = call->PAYLOAD_ARENA();
  const TAB *input = nullptr;
  for (const auto *frame : *call->INPUTS())
    if (frame->PORT_ID() && frame->PORT_ID()->str() == "request") {
      if (input)
        return invalid();
      input = frame;
    }
  if (!input || input->OFFSET() > arena->size() ||
      input->SIZE() > arena->size() - input->OFFSET())
    return invalid();
  req = arena->data() + input->OFFSET();
  len = input->SIZE();
  Json args = Json::parse(req, req + len, nullptr, false),
       holdings = Json::array(), chains = Json::array(), errors = Json::array();
  if (!args.is_object())
    return invalid();
  double total = 0;
  for (const auto &pair : std::vector<std::pair<std::string, std::string>>{
           {"btc", "BTC"}, {"eth", "ETH"}, {"sol", "SOL"}}) {
    std::string address = text(field(args, pair.first.c_str()));
    if (address.empty())
      continue;
    const auto &chain = pair.second;
    Json rows = Json::array();
    bool complete = true;
    if (address.size() > 128 ||
        address.find_first_not_of(
            "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") !=
            std::string::npos)
      return invalid();
    auto amount = nativeBalance(chain, address);
    if (std::isfinite(amount)) {
      double usd = amount == 0 ? 0 : amount * nativePrice(chain);
      rows.push_back({{"symbol", chain},
                      {"amount", amount},
                      {"usd", std::isfinite(usd) ? Json(usd) : Json(nullptr)}});
    } else
      complete = false;
    if (chain == "ETH" && !ethTokens(address, rows))
      complete = false;
    if (chain == "SOL" && !solTokens(address, rows))
      complete = false;
    double sum = 0;
    int count = 0;
    for (auto &row : rows) {
      row["chain"] = chain;
      row["address"] = address;
      if (number(row["amount"]) > 0)
        ++count;
      auto usd = number(row["usd"]);
      if (!std::isfinite(usd))
        complete = false;
      else
        sum += usd;
      holdings.push_back(row);
    }
    if (!complete)
      errors.push_back(chain + ": lookup incomplete");
    chains.push_back({{"chain", chain},
                      {"address", address},
                      {"token_count", count},
                      {"usd", complete ? Json(sum) : Json(nullptr)},
                      {"complete", complete}});
    total += sum;
  }
  bool complete = !chains.empty() && errors.empty() && std::isfinite(total);
  return Json{{"attested", complete},
              {"bond_usd", complete ? Json(total) : Json(nullptr)},
              {"total_usd", complete ? Json(total) : Json(nullptr)},
              {"holdings", holdings},
              {"chains", chains},
              {"errors", errors}}
      .dump();
}
std::vector<uint8_t> wrap_piv_response(const std::string &json) {
  flatbuffers::FlatBufferBuilder fbb(512 + json.size());
  std::vector<uint8_t> arena(json.begin(), json.end());
  std::vector<flatbuffers::Offset<TAB>> outputs;
  outputs.push_back(CreateTABDirect(
      fbb, 0, static_cast<uint32_t>(arena.size()), 1,
      payloadWireFormat::ALIGNED_BINARY, 0, bufferMutability::IMMUTABLE,
      bufferOwnership::HOST_OWNED, 0, "response"));
  auto response = CreatePIVResponseDirect(fbb, 0, pivStatus::OK, false, 0,
                                          &outputs, &arena);
  FinishPIVBuffer(fbb, CreatePIV(fbb, 0, response));
  return {fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize()};
}
} // namespace
extern "C" __attribute__((visibility("default"))) uint8_t *
plugin_invoke_stream(const uint8_t *req, uint32_t len, uint32_t *out_len) {
  auto bytes = wrap_piv_response(run_attest(req, len));
  auto out = static_cast<uint8_t *>(malloc(bytes.size()));
  if (out)
    memcpy(out, bytes.data(), bytes.size());
  if (out_len)
    *out_len = out ? bytes.size() : 0;
  return out;
}
