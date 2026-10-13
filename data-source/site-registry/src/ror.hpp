// The Research Organization Registry (CC0): whether an organisation is
// active, joined to a site on its Wikidata id. Read from the newest data dump
// on Zenodo (ROR's release channel): the zip's CSV member is inflated in
// 32 KiB windows and parsed as it streams, so the 57 MB table is never held
// whole. "inactive" with a successor is a renaming or a merger (the work
// continues); "withdrawn" says nothing about the organisation.
#pragma once
#include <cstdint>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace sr {

struct RorRecord { std::string id; int status = UNSPECIFIED; bool successor = false; };

inline uint32_t le16(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8; }
inline uint32_t le32u(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }

// RFC 4180 records, fed in chunks.
class CsvStream {
 public:
  template <typename F>
  void feed(const char* p, size_t n, F&& onRecord) {
    for (size_t i = 0; i < n; ++i) {
      const char c = p[i];
      if (quoted_) {
        if (c == '"') { if (pendingQuote_) { field_ += '"'; pendingQuote_ = false; } else pendingQuote_ = true; continue; }
        if (pendingQuote_) { quoted_ = false; pendingQuote_ = false; }
        else { field_ += c; continue; }
      }
      if (c == '"' && field_.empty() && !afterQuote_) { quoted_ = true; continue; }
      if (c == ',') { record_.push_back(std::move(field_)); field_.clear(); afterQuote_ = false; continue; }
      if (c == '\n') {
        if (!field_.empty() && field_.back() == '\r') field_.pop_back();
        record_.push_back(std::move(field_));
        field_.clear();
        afterQuote_ = false;
        onRecord(record_);
        record_.clear();
        continue;
      }
      field_ += c;
    }
  }
  template <typename F>
  void end(F&& onRecord) {
    if (pendingQuote_) { quoted_ = false; pendingQuote_ = false; }
    if (!field_.empty() || !record_.empty()) { record_.push_back(std::move(field_)); onRecord(record_); }
    field_.clear();
    record_.clear();
  }

 private:
  std::string field_;
  std::vector<std::string> record_;
  bool quoted_ = false, pendingQuote_ = false, afterQuote_ = false;
};

// The CSV member of the ROR dump -> records for the wanted Wikidata ids.
inline bool readRorDump(const uint8_t* zip, size_t n, const std::set<std::string>& wanted, std::map<std::string, RorRecord>& out, std::string& member, std::string& error) {
  // End of central directory.
  if (n < 22) { error = "The ROR dump is not a zip file."; return false; }
  size_t eocd = std::string::npos;
  for (size_t i = n - 22 + 1; i-- > (n > 65557 ? n - 65557 : 0);) if (le32u(zip + i) == 0x06054b50) { eocd = i; break; }
  if (eocd == std::string::npos) { error = "The ROR dump has no zip directory."; return false; }
  const uint32_t entries = le16(zip + eocd + 10), dirSize = le32u(zip + eocd + 12), dirOffset = le32u(zip + eocd + 16);
  if (size_t(dirOffset) + dirSize > n) { error = "The ROR dump's zip directory is truncated."; return false; }
  size_t at = dirOffset;
  uint32_t method = 0, crc = 0, compSize = 0, rawSize = 0, localOffset = 0;
  bool found = false;
  for (uint32_t e = 0; e < entries && at + 46 <= n; ++e) {
    if (le32u(zip + at) != 0x02014b50) break;
    const uint32_t nameLen = le16(zip + at + 28), extraLen = le16(zip + at + 30), commentLen = le16(zip + at + 32);
    const std::string name(reinterpret_cast<const char*>(zip + at + 46), nameLen);
    if (endsWith(name, ".csv") && !found) {
      method = le16(zip + at + 10);
      crc = le32u(zip + at + 16);
      compSize = le32u(zip + at + 20);
      rawSize = le32u(zip + at + 24);
      localOffset = le32u(zip + at + 42);
      member = name;
      found = true;
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  if (!found) { error = "The ROR dump has no CSV table."; return false; }
  if (size_t(localOffset) + 30 > n || le32u(zip + localOffset) != 0x04034b50) { error = "The ROR dump's CSV entry is damaged."; return false; }
  const size_t data = localOffset + 30 + le16(zip + localOffset + 26) + le16(zip + localOffset + 28);
  if (data + compSize > n || method != 8) { error = "The ROR dump's CSV entry is truncated or not deflated."; return false; }
  // Inflate in a 32 KiB window, parsing as it streams.
  CsvStream csv;
  std::vector<std::string> header;
  int idCol = -1, wdCol = -1, statusCol = -1, relCol = -1;
  static const rx::Regex successor(R"(successor:\s*(https:\/\/ror\.org\/\w+))", false);
  auto onRecord = [&](const std::vector<std::string>& f) {
    if (header.empty()) {
      header = f;
      for (size_t i = 0; i < f.size(); ++i) {
        if (f[i] == "id") idCol = int(i);
        if (f[i] == "external_ids.type.wikidata.all") wdCol = int(i);
        if (f[i] == "status") statusCol = int(i);
        if (f[i] == "relationships") relCol = int(i);
      }
      return;
    }
    if (idCol < 0 || wdCol < 0 || statusCol < 0 || size_t(std::max({idCol, wdCol, statusCol})) >= f.size()) return;
    const std::string& status = f[size_t(statusCol)];
    int lifecycle = status == "active" ? OPERATING : status == "inactive" ? PERMANENT_SHUTDOWN : UNSPECIFIED;
    if (lifecycle == UNSPECIFIED) return;
    const std::string& qids = f[size_t(wdCol)];
    std::vector<std::string> ids;
    std::string cur;
    for (char c : qids + ";") {
      if (c == ';' || c == ' ' || c == '\t' || c == '\n') { if (cur.size() > 1 && cur[0] == 'Q' && std::all_of(cur.begin() + 1, cur.end(), [](char d) { return d >= '0' && d <= '9'; })) ids.push_back(cur); cur.clear(); }
      else cur += c;
    }
    bool any = false;
    for (const auto& q : ids) if (wanted.count(q)) any = true;
    if (!any) return;
    const bool succ = relCol >= 0 && size_t(relCol) < f.size() && successor.test(rx::utf32(f[size_t(relCol)]));
    if (lifecycle == PERMANENT_SHUTDOWN && succ) lifecycle = OPERATING;
    for (const auto& q : ids) if (wanted.count(q)) out[q] = RorRecord{f[size_t(idCol)], lifecycle, succ};  // a successor marks a renaming (ror.mjs)
  };
  tinfl_decompressor inflator;
  tinfl_init(&inflator);
  std::vector<uint8_t> window(TINFL_LZ_DICT_SIZE);
  size_t inAt = 0, outAt = 0, total = 0;
  uint32_t check = MZ_CRC32_INIT;
  for (;;) {
    size_t inBytes = compSize - inAt, outBytes = window.size() - outAt;
    const tinfl_status s = tinfl_decompress(&inflator, zip + data + inAt, &inBytes, window.data(), window.data() + outAt, &outBytes, 0);
    inAt += inBytes;
    if (outBytes) {
      check = uint32_t(mz_crc32(check, window.data() + outAt, outBytes));
      csv.feed(reinterpret_cast<const char*>(window.data() + outAt), outBytes, onRecord);
      total += outBytes;
    }
    outAt = (outAt + outBytes) & (TINFL_LZ_DICT_SIZE - 1);
    if (s == TINFL_STATUS_DONE) break;
    if (s < TINFL_STATUS_DONE || (s == TINFL_STATUS_NEEDS_MORE_INPUT)) { error = "The ROR dump's CSV table does not inflate."; return false; }
  }
  csv.end(onRecord);
  if (total != rawSize || check != crc) { error = "The ROR dump's CSV table fails its length or CRC-32 check."; return false; }
  return true;
}

inline bool absorbRor(State& st, const Response& r, const std::string& version, std::string& error) {
  if (r.status < 200 || r.status > 299) { error = "The ROR dump answered HTTP " + std::to_string(r.status) + "."; return false; }
  std::set<std::string> wanted;
  auto reads = [](const Site& s) { return organisationSet(s.catcode) || s.network == networkName("SPACE"); };  // space centres are organisations too
  for (const auto& s : st.sites) if (reads(s) && !s.qid().empty()) wanted.insert(s.qid());
  std::map<std::string, RorRecord> found;
  std::string member;
  if (!readRorDump(reinterpret_cast<const uint8_t*>(r.body.data()), r.body.size(), wanted, found, member, error)) return false;
  const std::string release = version.empty() ? replaceAll(member, "-ror-data.csv", "") : version;
  for (auto& s : st.sites) {
    if (!reads(s)) continue;
    auto it = found.find(s.qid());
    if (it == found.end()) continue;
    s.evidence.push_back({it->second.status, "", cite("ror", it->second.id, it->second.id, release, it->second.successor ? "successor" : "status", st.runAt)});
    s.refs.push_back({REF_REGISTRY_RECORD, "ror", it->second.id, it->second.id, "", ""});
  }
  return true;
}

}  // namespace sr
