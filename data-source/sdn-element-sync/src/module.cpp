// sdn-element-sync: the merge step of the SDN-AP element data path (typed contracts 1.0: FlatBuffers only).
// No hostcalls, no capabilities, no network, no clock, no physics: the host connectors move the bytes and the harness
// schedules; this module decides which sets are kept. One method, "merge", over two lanes:
//
//   window      ($QRP Request)  FROM_EPOCH_MS window start, AS_OF_MS now, TO_EPOCH_MS upper bound, LIMIT cap per lane
//   cached      ($OMM frames)   SGP4 lane: foreign sets read back from the cache
//   pulled      ($OMM frames)   SGP4 lane: sets pulled from a peer; kept only beside a signature-verified $PNV notice
//   cached_ocm  ($OCM frames)   element-set lane (SGP4XP, AP): sets read back from the cache
//   pulled_ocm  ($OCM frames)   element-set lane: sets pulled from a peer, under the same notice rule
//   notice      ($PNV frames)   the pulled batch's signed provenance, passed on byte for byte
//
// A frame holds one record or a size-prefixed stream of them. Sets with an EPOCH before the window start (or after TO)
// are dropped; the rest are de-duplicated on the lane's key with a pulled set winning over a cached one, and sorted by
// that key. $OMM key: (NORAD_CAT_ID, OBJECT_ID, MEAN_ELEMENT_THEORY, ORIGINATOR, EPOCH). $OCM key: (METADATA.NORAD_CAT_ID,
// METADATA.INTERNATIONAL_DESIGNATOR, MEAN_ELEMENTS.MEAN_ELEMENT_THEORY, HEADER.ORIGINATOR, MEAN_ELEMENTS.EPOCH). Records
// pass byte for byte. Refused by name, the whole call: any record with USER_DEFINED_PARAMETERS
// (user-defined-parameters:<count>); an $OCM without MEAN_ELEMENTS (mean-elements-missing) or with MEAN_ELEMENT_THEORY
// UNSPECIFIED (mean-element-theory-unspecified). Failures return a status after plugin_set_error; nothing is thrown.
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "space_data_module_invoke.h"
#include "sds_generated.h"  // QRP, OMM, OCM, PNV and the families they include, inlined by build.mjs

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

struct Window {
  int64_t from, to;
  uint32_t limit;
  int64_t as_of;
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

// The records of one frame: a single record (its id at offset 4) or a size-prefixed stream (first record's id at 8).
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

int refuse(const char* code, const char* message, int status) {
  plugin_set_error(code, message);
  return status;
}

// One record read into its key. Malformed: not this lane's record (dropped and counted). Refused: the call fails.
enum class Read { ok, malformed, refused };
std::string refusal_code, refusal_message;
Read refused(std::string code, std::string message) {
  refusal_code = std::move(code);
  refusal_message = std::move(message);
  return Read::refused;
}
template <typename List>
Read user_defined(const List* list, const char* code) {
  if (!list || list->size() == 0) return Read::ok;
  return refused("user-defined-parameters:" + std::to_string(list->size()),
                 std::string("a $") + code + " carries USER_DEFINED_PARAMETERS; SDN records never do.");
}

Read read_omm(const Span& sp, Set* s) {
  flatbuffers::Verifier v(sp.bytes, sp.size);
  if (!OMMBufferHasIdentifier(sp.bytes) || !VerifyOMMBuffer(v)) return Read::malformed;
  const OMM* omm = GetOMM(sp.bytes);
  if (user_defined(omm->USER_DEFINED_PARAMETERS(), "OMM") == Read::refused) return Read::refused;
  *s = Set{omm->NORAD_CAT_ID(), static_cast<int8_t>(omm->MEAN_ELEMENT_THEORY()), 0, sv(omm->OBJECT_ID()),
           sv(omm->ORIGINATOR()), sv(omm->EPOCH()), sp.bytes, sp.size, false};
  return Read::ok;
}

Read read_ocm(const Span& sp, Set* s) {
  flatbuffers::Verifier v(sp.bytes, sp.size);
  if (!OCMBufferHasIdentifier(sp.bytes) || !VerifyOCMBuffer(v)) return Read::malformed;
  const OCM* ocm = GetOCM(sp.bytes);
  if (user_defined(ocm->USER_DEFINED_PARAMETERS(), "OCM") == Read::refused) return Read::refused;
  const OCMMeanElements* me = ocm->MEAN_ELEMENTS();
  if (!me) return refused("mean-elements-missing", "an $OCM on the element-set lane carries no MEAN_ELEMENTS.");
  if (me->MEAN_ELEMENT_THEORY() == meanElementSource::UNSPECIFIED)
    return refused("mean-element-theory-unspecified", "an $OCM's MEAN_ELEMENTS.MEAN_ELEMENT_THEORY is UNSPECIFIED.");
  const Metadata* md = ocm->METADATA();
  const Header* hd = ocm->HEADER();
  *s = Set{md ? md->NORAD_CAT_ID() : 0u, static_cast<int8_t>(me->MEAN_ELEMENT_THEORY()), 0,
           md ? sv(md->INTERNATIONAL_DESIGNATOR()) : std::string_view(), hd ? sv(hd->ORIGINATOR()) : std::string_view(),
           sv(me->EPOCH()), sp.bytes, sp.size, false};
  return Read::ok;
}

struct Lane {
  const char* code;  // OMM, OCM: the record type, its schema and the SCHEMA_NAME of the lane's $QRP frames
  const char* id;
  const char* cached_port;
  const char* pulled_port;
  const char* out_port;
  const char* store_port;
  const char* invalid_frame;
  Read (*read)(const Span&, Set*);
};
constexpr Lane kOmmLane{"OMM", "$OMM", "cached", "pulled", "omm", "store", "invalid-omm-frame", read_omm};
constexpr Lane kOcmLane{"OCM", "$OCM", "cached_ocm", "pulled_ocm", "ocm", "store_ocm", "invalid-ocm-frame", read_ocm};

struct Merged {
  std::vector<Set> sets;
  std::vector<const Set*> kept, fresh;
  uint64_t scanned = 0, refused_pulled = 0, expired = 0, malformed = 0;
  bool capped = false;
};

// The lane's window: every record of its ports read, expired dropped, de-duplicated, capped; nothing pushed.
int gather(const Lane& lane, const Window& w, bool notices_ok, Merged* m) {
  const uint32_t count = plugin_get_input_count();
  for (uint32_t i = 0; i < count; i++) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (!f || !f->port_id) continue;
    const bool pulled = std::strcmp(f->port_id, lane.pulled_port) == 0;
    if (!pulled && std::strcmp(f->port_id, lane.cached_port) != 0) continue;
    std::vector<Span> spans;
    if (!records_of(f, lane.id, &spans))
      return refuse(lane.invalid_frame, (std::string("a frame is neither a ") + lane.id + " nor a size-prefixed " + lane.id + " stream.").c_str(), 400);
    for (const Span& sp : spans) {
      m->scanned++;
      if (pulled && !notices_ok) { m->refused_pulled++; continue; }
      Set s;
      const Read r = lane.read(sp, &s);
      if (r == Read::refused) return refuse(refusal_code.c_str(), refusal_message.c_str(), 400);
      if (r == Read::malformed) { m->malformed++; continue; }
      s.pulled = pulled;
      s.epoch_ms = epoch_ms_of(s.epoch);
      if (s.epoch_ms == INT64_MIN) { m->malformed++; continue; }
      if ((w.from > 0 && s.epoch_ms < w.from) || (w.to > 0 && s.epoch_ms > w.to)) { m->expired++; continue; }
      m->sets.push_back(s);
    }
  }

  // Sorted by key; a pulled set wins over a cached one with the same key.
  std::vector<Set>& sets = m->sets;
  std::stable_sort(sets.begin(), sets.end(), [](const Set& a, const Set& b) {
    if (key_less(a, b)) return true;
    if (key_less(b, a)) return false;
    return a.pulled && !b.pulled;
  });
  std::vector<const Set*> kept;
  std::vector<bool> cached_has;  // per kept entry: the cache holds this exact set (same key, same bytes)
  for (size_t i = 0; i < sets.size();) {
    size_t j = i + 1;
    // the cache already holds this exact set: a cached member of the group with the same bytes as the winner
    bool cached = !sets[i].pulled;
    while (j < sets.size() && key_equal(sets[i], sets[j])) {
      if (!sets[j].pulled && sets[j].size == sets[i].size && std::memcmp(sets[j].bytes, sets[i].bytes, sets[i].size) == 0) cached = true;
      j++;
    }
    kept.push_back(&sets[i]);
    cached_has.push_back(cached);
    i = j;
  }
  if (w.limit > 0 && kept.size() > w.limit) {
    // the cap drops the oldest epochs first
    std::vector<size_t> order(kept.size());
    for (size_t i = 0; i < order.size(); i++) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return kept[a]->epoch_ms > kept[b]->epoch_ms; });
    std::vector<bool> drop(kept.size(), false);
    for (size_t i = w.limit; i < order.size(); i++) drop[order[i]] = true;
    std::vector<const Set*> k2;
    std::vector<bool> c2;
    for (size_t i = 0; i < kept.size(); i++) if (!drop[i]) { k2.push_back(kept[i]); c2.push_back(cached_has[i]); }
    kept.swap(k2);
    cached_has.swap(c2);
    m->capped = true;
  }
  for (size_t i = 0; i < kept.size(); i++) if (kept[i]->pulled && !cached_has[i]) m->fresh.push_back(kept[i]);
  m->kept.swap(kept);
  return 0;
}

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

int push_expire(const Lane& lane, const Window& w) {
  flatbuffers::FlatBufferBuilder b(256);
  QRPBuilder q(b);
  q.add_KIND(qrpKind::Request);
  q.add_SCHEMA_NAME(b.CreateString(lane.code));
  q.add_TO_EPOCH_MS(w.from);
  q.add_AS_OF_MS(w.as_of);
  FinishQRPBuffer(b, q.Finish());
  return push_qrp("expire", b);
}

int push_summary(const Lane& lane, const Window& w, const Merged& m) {
  flatbuffers::FlatBufferBuilder b(512);
  const std::string message = "kept=" + std::to_string(m.kept.size()) + " new=" + std::to_string(m.fresh.size()) +
                              " expired=" + std::to_string(m.expired) + " unsigned-refused=" + std::to_string(m.refused_pulled) +
                              " malformed=" + std::to_string(m.malformed);
  auto msg = b.CreateString(message);
  const bool partial = m.refused_pulled > 0 || m.capped;
  QRPBuilder q(b);
  q.add_KIND(qrpKind::Page);
  q.add_STATUS(partial ? qrpStatus::Partial : qrpStatus::Ok);
  q.add_SCHEMA_NAME(b.CreateString(lane.code));
  q.add_MESSAGE(msg);
  q.add_SCANNED(m.scanned);
  q.add_RECORD_COUNT(static_cast<uint32_t>(m.kept.size()));
  q.add_STORED(m.fresh.size());
  q.add_TOTAL_COUNT(m.kept.size());
  q.add_PARTIAL(partial);
  q.add_TRUNCATED(m.capped);
  q.add_AS_OF_MS(w.as_of);
  FinishQRPBuffer(b, q.Finish());
  return push_qrp("summary", b);
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
  const Window w{req->FROM_EPOCH_MS(), req->TO_EPOCH_MS(), req->LIMIT(), req->AS_OF_MS()};

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

  // Every record of both lanes is read before anything is pushed: a refusal leaves no output.
  Merged omm, ocm;
  if (const int r = gather(kOmmLane, w, notices_ok, &omm)) return r;
  if (const int r = gather(kOcmLane, w, notices_ok, &ocm)) return r;

  if (push_stream(kOmmLane.out_port, omm.kept, "OMM") || push_stream(kOmmLane.store_port, omm.fresh, "OMM") ||
      push_stream(kOcmLane.out_port, ocm.kept, "OCM") || push_stream(kOcmLane.store_port, ocm.fresh, "OCM"))
    return refuse("push-failed", "an output frame could not be pushed.", 500);
  if (omm.refused_pulled + ocm.refused_pulled == 0 || notices_ok)
    for (const plugin_input_frame_t* f : notices)
      if (plugin_push_output_ex("notice", "PNV.fbs", "$PNV", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PNV", 0, 0, f->payload,
                                f->payload_length) < 0)
        return refuse("push-failed", "a notice frame could not be pushed.", 500);
  if (push_expire(kOmmLane, w) || push_expire(kOcmLane, w)) return refuse("push-failed", "the expire request could not be pushed.", 500);
  if (push_summary(kOmmLane, w, omm) || push_summary(kOcmLane, w, ocm)) return refuse("push-failed", "the summary could not be pushed.", 500);
  return 0;
}
