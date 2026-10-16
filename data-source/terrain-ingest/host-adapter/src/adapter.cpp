#include "space_data_module_invoke.h"
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
using Json = nlohmann::json;

// Host side of the Moon terrain flow: adding terrain-source:pack's files to the
// node's IPFS through the existing "ipfs" host capability (ipfs.add, pinned).
// Planning, decoding, encoding, packing and the $PNM records stay in the
// portable modules; this adapter only moves bytes to the host and reports the
// CID it got back, as a $PNM (CID, FILE_NAME) per file - a FlatBuffer, so no
// JSON crosses a port (the JSON below is the host-call ABI, not a frame).

extern "C" {
__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t terrain_host_call(const uint8_t*, int32_t, const uint8_t*, int32_t);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t terrain_response_len();
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t terrain_read_response(uint8_t*, int32_t);
}

namespace {
// A packed block file is 16 tiles of at most 32 KiB each plus framing; the
// root file 42. 8 MiB leaves room and refuses anything that is not a pack.
constexpr size_t maxFileBytes = 8u * 1024u * 1024u;
int fail(const char* message) { plugin_set_error("terrain-host-adapter", message); return 1; }
#define CHECK(condition, message) do { if (!(condition)) return fail(message); } while (0)

std::vector<const plugin_input_frame_t*> frames(const char* port) {
  std::vector<const plugin_input_frame_t*> out;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && std::strcmp(f->port_id, port) == 0) out.push_back(f);
  }
  return out;
}

// One host call: [u32 meta length][meta JSON][u32 0 segments] -> [u32 n][JSON].
Json hostcall(const char* op, const std::string& meta) {
  std::vector<uint8_t> request(4 + meta.size() + 4, 0);
  const uint32_t n = uint32_t(meta.size());
  std::memcpy(request.data(), &n, 4);
  std::memcpy(request.data() + 4, meta.data(), meta.size());
  terrain_host_call(reinterpret_cast<const uint8_t*>(op), int32_t(std::strlen(op)), request.data(), int32_t(request.size()));
  const int32_t responseLength = terrain_response_len();
  if (responseLength < 4) return Json();
  std::vector<uint8_t> bytes(static_cast<size_t>(responseLength));
  terrain_read_response(bytes.data(), responseLength);
  uint32_t length;
  std::memcpy(&length, bytes.data(), 4);
  if (length > bytes.size() - 4) return Json();
  return Json::parse(bytes.data() + 4, bytes.data() + 4 + length, nullptr, false);
}

std::string b64(const uint8_t* p, size_t n) {
  static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string s;
  s.reserve((n + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < n; i += 3) {
    const uint32_t v = uint32_t(p[i]) << 16 | uint32_t(p[i + 1]) << 8 | p[i + 2];
    s += t[v >> 18]; s += t[(v >> 12) & 63]; s += t[(v >> 6) & 63]; s += t[v & 63];
  }
  if (i + 1 == n) { const uint32_t v = uint32_t(p[i]) << 16; s += t[v >> 18]; s += t[(v >> 12) & 63]; s += "=="; }
  else if (i + 2 == n) { const uint32_t v = uint32_t(p[i]) << 16 | uint32_t(p[i + 1]) << 8; s += t[v >> 18]; s += t[(v >> 12) & 63]; s += t[(v >> 6) & 63]; s += '='; }
  return s;
}

bool safe_name(const std::string& name) {
  if (name.empty() || name.size() > 128 || name.front() == '/' || name.find("..") != std::string::npos) return false;
  for (const char c : name)
    if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '/' || c == '-' || c == '_' || c == '.')) return false;
  return true;
}
}  // namespace

// terrain-source:pack's "file" frames (each a packed file: a size-prefixed $DTT
// stream) and its "names" frame (a size-prefixed $PNM stream, the k-th record
// naming the k-th file) -> one "added" frame per file: a size-prefixed $PNM with
// the CID ipfs.add returned and the file's name.
extern "C" int publish_files() {
  const auto list = frames("file");
  const auto names = frames("names");
  CHECK(!list.empty() && list.size() <= 64, "One to 64 terrain files are required.");
  CHECK(names.size() == 1 && names[0]->payload, "Exactly one names frame is required.");
  std::vector<std::string> named;
  for (size_t at = 0; at + 4 <= names[0]->payload_length;) {
    uint32_t size;
    std::memcpy(&size, names[0]->payload + at, 4);
    at += 4;
    if (size == 0) continue;
    CHECK(size <= names[0]->payload_length - at, "The names frame is malformed.");
    flatbuffers::Verifier verifier(names[0]->payload + at, size);
    CHECK(PNMBufferHasIdentifier(names[0]->payload + at) && VerifyPNMBuffer(verifier), "A file name is not a $PNM.");
    const PNM* pnm = GetPNM(names[0]->payload + at);
    named.push_back(pnm->FILE_NAME() ? pnm->FILE_NAME()->str() : std::string());
    at += size;
  }
  CHECK(named.size() == list.size(), "The names frame does not name every file.");
  for (size_t k = 0; k < list.size(); ++k) {
    const auto* f = list[k];
    const std::string& name = named[k];
    CHECK(safe_name(name), "A terrain file name is not a safe relative path.");
    CHECK(f->payload && f->payload_length > 0 && f->payload_length <= maxFileBytes, "A terrain file is empty or too large.");
    const Json result = hostcall("ipfs.add", Json({{"base64", b64(f->payload, f->payload_length)}}).dump());
    CHECK(result.is_object() && result.value("ok", false) == true, "ipfs.add refused a terrain file; nothing is announced.");
    const auto& r = result["result"];
    CHECK(r.is_object() && r.contains("Hash") && r["Hash"].is_string(), "ipfs.add returned no CID.");
    flatbuffers::FlatBufferBuilder b(256);
    const auto cid = b.CreateString(r["Hash"].get<std::string>());
    const auto file = b.CreateString(name);
    PNMBuilder pnm(b);
    pnm.add_CID(cid);
    pnm.add_FILE_NAME(file);
    FinishSizePrefixedPNMBuffer(b, pnm.Finish());
    CHECK(plugin_push_output_ex("added", "PNM.fbs", "$PNM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PNM", 0, 0,
                                b.GetBufferPointer(), b.GetSize()) >= 0,
          "Could not emit an add result.");
  }
  return 0;
}
