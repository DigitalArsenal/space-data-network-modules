// sdn-element-sync: the merge step of the SDN-AP element data path (typed contracts 1.0: FlatBuffers only).
// No hostcalls, no capabilities, no network, no clock, no physics: the host connectors move the bytes and the harness
// schedules; this module decides which sets are kept. One method, "merge":
//
//   window  ($QRP Request)  FROM_EPOCH_MS window start, AS_OF_MS now, TO_EPOCH_MS upper bound, LIMIT cap
//   cached  ($OMM frames)   sets read back from the cache
//   pulled  ($OMM frames)   sets pulled from a peer; kept only beside a signature-verified $PNV notice
//   notice  ($PNV frames)   the pulled batch's signed provenance, passed on byte for byte
//
// A frame holds one $OMM or a size-prefixed stream of them. Sets with an EPOCH before the window start (or after TO)
// are dropped; the rest are de-duplicated on (NORAD_CAT_ID, OBJECT_ID, MEAN_ELEMENT_THEORY, ORIGINATOR, EPOCH) with a
// pulled set winning over a cached one, and sorted by that key. Failures return a status after plugin_set_error;
// nothing is thrown.
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "space_data_module_invoke.h"
#include "sds_generated.h"  // QRP, OMM, PNV and the families they include, inlined by build.mjs

namespace {

constexpr size_t kChunkBytes = 4u << 20;

struct Set {
  uint32_t norad;
  int8_t theory;
  int64_t epoch_ms;
  std::string_view object_id, originator, epoch;
  const uint8_t* bytes;  // the record, without its size prefix
  uint32_t size;
  bool pulled;
};

// ISO 8601 UTC (YYYY-MM-DDTHH:MM:SS[.f...][Z]) to Unix ms; INT64_MIN when it does not parse.
int64_t epoch_ms_of(std::string_view s) {
  auto num = [&](size_t at, size_t n, int64_t* out) {
    if (at + n > s.size()) return false;
    int64_t v = 0;
    for (size_t i = 0; i < n; i++) {
      const char c = s[at + i];
      if (c < '0' || c > '9') return false;
      v = v * 10 + (c - '0');
    }
    *out = v;
    return true;
  };
  int64_t y, mo, d, h = 0, mi = 0, sec = 0;
  if (!num(0, 4, &y) || s.size() < 10 || s[4] != '-' || !num(5, 2, &mo) || s[7] != '-' || !num(8, 2, &d))
    return INT64_MIN;
  if (s.size() >= 19) {
    if ((s[10] != 'T' && s[10] != ' ') || !num(11, 2, &h) || !num(14, 2, &mi) || !num(17, 2, &sec)) return INT64_MIN;
  }
  int64_t ms = 0;
  if (s.size() > 19 && s[19] == '.') {
    int64_t scale = 100;
    for (size_t i = 20; i < s.size() && s[i] >= '0' && s[i] <= '9'; i++, scale /= 10) ms += (s[i] - '0') * scale;
  }
  // days from civil (H. Hinnant)
  const int64_t yy = y - (mo <= 2);
  const int64_t era = (yy >= 0 ? yy : yy - 399) / 400;
  const int64_t yoe = yy - era * 400;
  const int64_t doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  const int64_t days = era * 146097 + doe - 719468;
  return ((days * 24 + h) * 60 + mi) * 60000 + sec * 1000 + ms;
}

std::string_view sv(const flatbuffers::String* s) {
  return s ? std::string_view(s->c_str(), s->size()) : std::string_view();
}

bool has_id(const uint8_t* p, size_t n, size_t at, const char* id) {
  return n >= at + 4 && std::memcmp(p + at, id, 4) == 0;
}

// The records of one frame: a single record ($OMM at offset 4) or a size-prefixed stream (first record's id at 8).
struct Span { const uint8_t* bytes; uint32_t size; };
bool records_of(const plugin_input_frame_t* f, const char* id, std::vector<Span>* out) {
  const uint8_t* p = f->payload;
  const size_t n = f->payload_length;
  if (!p || n < 8) return false;
  if (has_id(p, n, 4, id)) { out->push_back({p, static_cast<uint32_t>(n)}); return true; }
  size_t at = 0;
  while (at + 4 <= n) {
    uint32_t size;
    std::memcpy(&size, p + at, 4);
    at += 4;
    if (size == 0) continue;
    if (size > n - at || !has_id(p + at, size, 4, id)) return false;
    out->push_back({p + at, size});
    at += size;
  }
  return at == n;
}

bool key_less(const Set& a, const Set& b) {
  if (a.norad != b.norad) return a.norad < b.norad;
  if (a.object_id != b.object_id) return a.object_id < b.object_id;
  if (a.theory != b.theory) return a.theory < b.theory;
  if (a.originator != b.originator) return a.originator < b.originator;
  if (a.epoch_ms != b.epoch_ms) return a.epoch_ms < b.epoch_ms;
  return a.epoch < b.epoch;
}
bool key_equal(const Set& a, const Set& b) { return !key_less(a, b) && !key_less(b, a); }

int push_stream(const char* port, const std::vector<const Set*>& sets, const char* code) {
  std::vector<uint8_t> frame;
  const std::string schema = std::string(code) + ".fbs", id = std::string("$") + code;
  auto flush = [&]() {
    if (frame.empty()) return 0;
    const int r = plugin_push_output_ex(port, schema.c_str(), id.c_str(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, code,
                                        0, 0, frame.data(), static_cast<uint32_t>(frame.size()));
    frame.clear();
    return r < 0 ? 1 : 0;
  };
  for (const Set* s : sets) {
    if (!frame.empty() && frame.size() + 4 + s->size > kChunkBytes && flush()) return 1;
    const size_t at = frame.size();
    frame.resize(at + 4 + s->size);
    std::memcpy(frame.data() + at, &s->size, 4);
    std::memcpy(frame.data() + at + 4, s->bytes, s->size);
  }
  return flush();
}

int push_qrp(const char* port, flatbuffers::FlatBufferBuilder& b) {
  return plugin_push_output_ex(port, "QRP.fbs", "$QRP", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "QRP", 0, 0,
                               b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0
             ? 1
             : 0;
}

int refuse(const char* code, const char* message, int status) {
  plugin_set_error(code, message);
  return status;
}

}  // namespace

extern "C" int merge() {
  plugin_reset_output_state();
  const plugin_input_frame_t* window = nullptr;
  const uint32_t count = plugin_get_input_count();
  for (uint32_t i = 0; i < count; i++) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f && f->port_id && std::strcmp(f->port_id, "window") == 0) {
      if (window) return refuse("batched-input-frames", "exactly one \"window\" $QRP Request is accepted.", 400);
      window = f;
    }
  }
  if (!window || !window->payload) return refuse("missing-window", "the \"window\" port requires one $QRP Request.", 400);
  flatbuffers::Verifier wv(window->payload, window->payload_length);
  if (!QRPBufferHasIdentifier(window->payload) || !VerifyQRPBuffer(wv))
    return refuse("invalid-window", "the \"window\" frame is not a $QRP.", 400);
  const QRP* req = GetQRP(window->payload);
  if (req->KIND() != qrpKind::Request) return refuse("invalid-window", "the \"window\" $QRP is not a Request.", 400);
  const int64_t from = req->FROM_EPOCH_MS(), to = req->TO_EPOCH_MS();
  const uint32_t limit = req->LIMIT();

  // Provenance first: the pulled batch is accepted only beside signed, verified notices.
  std::vector<const plugin_input_frame_t*> notices;
  bool notices_ok = true;
  for (uint32_t i = 0; i < count; i++) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, "notice") != 0) continue;
    flatbuffers::Verifier v(f->payload, f->payload_length);
    if (!f->payload || !PNVBufferHasIdentifier(f->payload) || !VerifyPNVBuffer(v)) { notices_ok = false; continue; }
    const PNV* pnv = GetPNV(f->payload);
    if (!pnv->ENTRIES() || pnv->ENTRIES()->size() == 0) notices_ok = false;
    else for (const auto* e : *pnv->ENTRIES()) if (!e->SIGNATURE_VERIFIED()) notices_ok = false;
    notices.push_back(f);
  }
  if (notices.empty()) notices_ok = false;

  std::vector<Set> sets;
  uint64_t scanned = 0, refused_pulled = 0, expired = 0, malformed = 0;
  for (uint32_t i = 0; i < count; i++) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (!f || !f->port_id) continue;
    const bool pulled = std::strcmp(f->port_id, "pulled") == 0;
    if (!pulled && std::strcmp(f->port_id, "cached") != 0) continue;
    std::vector<Span> spans;
    if (!records_of(f, "$OMM", &spans)) return refuse("invalid-omm-frame", "a frame is neither a $OMM nor a size-prefixed $OMM stream.", 400);
    for (const Span& sp : spans) {
      scanned++;
      if (pulled && !notices_ok) { refused_pulled++; continue; }
      flatbuffers::Verifier v(sp.bytes, sp.size);
      if (!OMMBufferHasIdentifier(sp.bytes) || !VerifyOMMBuffer(v)) { malformed++; continue; }
      const OMM* omm = GetOMM(sp.bytes);
      Set s{omm->NORAD_CAT_ID(), static_cast<int8_t>(omm->MEAN_ELEMENT_THEORY()), 0, sv(omm->OBJECT_ID()),
            sv(omm->ORIGINATOR()), sv(omm->EPOCH()), sp.bytes, sp.size, pulled};
      s.epoch_ms = epoch_ms_of(s.epoch);
      if (s.epoch_ms == INT64_MIN) { malformed++; continue; }
      if ((from > 0 && s.epoch_ms < from) || (to > 0 && s.epoch_ms > to)) { expired++; continue; }
      sets.push_back(s);
    }
  }

  // Sorted by key; a pulled set wins over a cached one with the same key.
  std::stable_sort(sets.begin(), sets.end(), [](const Set& a, const Set& b) {
    if (key_less(a, b)) return true;
    if (key_less(b, a)) return false;
    return a.pulled && !b.pulled;
  });
  std::vector<const Set*> kept, fresh;
  std::vector<bool> cached_has;  // per kept entry: a cached set with the same key exists
  for (size_t i = 0; i < sets.size();) {
    size_t j = i + 1;
    bool cached = !sets[i].pulled;
    while (j < sets.size() && key_equal(sets[i], sets[j])) { cached = cached || !sets[j].pulled; j++; }
    kept.push_back(&sets[i]);
    cached_has.push_back(cached);
    i = j;
  }
  bool capped = false;
  if (limit > 0 && kept.size() > limit) {
    // the cap drops the oldest epochs first
    std::vector<size_t> order(kept.size());
    for (size_t i = 0; i < order.size(); i++) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return kept[a]->epoch_ms > kept[b]->epoch_ms; });
    std::vector<bool> drop(kept.size(), false);
    for (size_t i = limit; i < order.size(); i++) drop[order[i]] = true;
    std::vector<const Set*> k2;
    std::vector<bool> c2;
    for (size_t i = 0; i < kept.size(); i++) if (!drop[i]) { k2.push_back(kept[i]); c2.push_back(cached_has[i]); }
    kept.swap(k2);
    cached_has.swap(c2);
    capped = true;
  }
  for (size_t i = 0; i < kept.size(); i++) if (kept[i]->pulled && !cached_has[i]) fresh.push_back(kept[i]);

  if (push_stream("omm", kept, "OMM") || push_stream("store", fresh, "OMM")) return refuse("push-failed", "an output frame could not be pushed.", 500);
  if (refused_pulled == 0 || notices_ok)
    for (const plugin_input_frame_t* f : notices)
      if (plugin_push_output_ex("notice", "PNV.fbs", "$PNV", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PNV", 0, 0, f->payload,
                                f->payload_length) < 0)
        return refuse("push-failed", "a notice frame could not be pushed.", 500);

  {
    flatbuffers::FlatBufferBuilder b(256);
    QRPBuilder q(b);
    q.add_KIND(qrpKind::Request);
    q.add_SCHEMA_NAME(b.CreateString("OMM"));
    q.add_TO_EPOCH_MS(from);
    q.add_AS_OF_MS(req->AS_OF_MS());
    FinishQRPBuffer(b, q.Finish());
    if (push_qrp("expire", b)) return refuse("push-failed", "the expire request could not be pushed.", 500);
  }
  {
    flatbuffers::FlatBufferBuilder b(512);
    const std::string message = "kept=" + std::to_string(kept.size()) + " new=" + std::to_string(fresh.size()) +
                                " expired=" + std::to_string(expired) + " unsigned-refused=" + std::to_string(refused_pulled) +
                                " malformed=" + std::to_string(malformed);
    auto msg = b.CreateString(message);
    QRPBuilder q(b);
    q.add_KIND(qrpKind::Page);
    q.add_STATUS((refused_pulled || capped) ? qrpStatus::Partial : qrpStatus::Ok);
    q.add_SCHEMA_NAME(b.CreateString("OMM"));
    q.add_MESSAGE(msg);
    q.add_SCANNED(scanned);
    q.add_RECORD_COUNT(static_cast<uint32_t>(kept.size()));
    q.add_STORED(fresh.size());
    q.add_TOTAL_COUNT(kept.size());
    q.add_PARTIAL(refused_pulled > 0 || capped);
    q.add_TRUNCATED(capped);
    q.add_AS_OF_MS(req->AS_OF_MS());
    FinishQRPBuffer(b, q.Finish());
    if (push_qrp("summary", b)) return refuse("push-failed", "the summary could not be pushed.", 500);
  }
  return 0;
}
