// files/misb-klv: full-motion video with MISB ST 0601 metadata, for a video
// layer draped on the globe (owner 2026-10-13: "add arbitrary imagery layers
// as well, including video").
//
// remux       one MPEG transport stream -> a fragmented MP4 a browser plays
//             through Media Source Extensions (H.264 only), and the per-frame
//             footprint table the console redraws the layer with.
// footprints  the same stream -> one SDS $GDI per ST 0601 packet (time,
//             sensor, ground footprint as GeoJSON).
//
// Input (both methods): port "descriptor", a size-prefixed SDS $NCD, and
// port "stream", the transport stream's exact bytes (raw, video/mp2t).
// SOURCE_BYTE_LENGTH and SOURCE_SHA256 are checked against the stream when
// the descriptor states them.
//
// The frame table (port "frames", little-endian float64): a header
// [1, rows, epochMs, ticksPerSecond] then one row per video frame in
// presentation order: [key, valid, LL lon, LL lat, LR lon, LR lat, UR lon,
// UR lat, UL lon, UL lat]. key is the frame's presentation time in the MP4
// in 90 kHz ticks (the browser's media time x 90000, exactly); valid is 0
// when no ST 0601 packet within 1 s of the frame gives a footprint. epochMs
// is the UTC time (ms) of media time 0 from the first timed packet, NaN when
// none.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

constexpr int64_t kTicks = 90000;
constexpr int64_t kMaxGapTicks = kTicks;  // a footprint is used up to 1 s from its packet
constexpr size_t kMaxFragments = 60;

struct Input {
  const uint8_t* data = nullptr;
  size_t size = 0;
};

int32_t fail(const char* code, const char* message, int32_t status = 400) {
  plugin_set_error(code, message);
  return status;
}

const plugin_input_frame_t* inputFrame(const char* port) {
  const int32_t index = plugin_find_input_index(port, 0);
  return index >= 0 ? plugin_get_input_frame(uint32_t(index)) : nullptr;
}

// The stream on port "stream", checked against the $NCD on port "descriptor".
int32_t readInput(Input* in) {
  const plugin_input_frame_t* d = inputFrame("descriptor");
  if (!d || !d->payload || d->payload_length < 8) return fail("missing-descriptor", "A size-prefixed $NCD frame on port \"descriptor\" is required.");
  const uint8_t* descriptor = d->payload;
  const uint32_t prefix = uint32_t(descriptor[0]) | (uint32_t(descriptor[1]) << 8) | (uint32_t(descriptor[2]) << 16) | (uint32_t(descriptor[3]) << 24);
  if (size_t(prefix) + 4 != size_t(d->payload_length)) return fail("malformed-descriptor", "The $NCD size prefix does not match the frame.");
  if (!::flatbuffers::BufferHasIdentifier(descriptor, NCDIdentifier(), true)) return fail("malformed-descriptor", "The frame on port \"descriptor\" is not a size-prefixed $NCD.");
  ::flatbuffers::Verifier verifier(descriptor, size_t(d->payload_length));
  if (!VerifySizePrefixedNCDBuffer(verifier)) return fail("malformed-descriptor", "The $NCD descriptor does not verify.");
  const NCD* ncd = GetSizePrefixedNCD(descriptor);
  const plugin_input_frame_t* frame = inputFrame("stream");
  if (!frame || !frame->payload || frame->payload_length == 0) return fail("missing-stream", "The transport stream's bytes on port \"stream\" are required.");
  in->data = frame->payload;
  in->size = size_t(frame->payload_length);
  if (ncd->SOURCE_BYTE_LENGTH() != 0 && uint64_t(ncd->SOURCE_BYTE_LENGTH()) != uint64_t(in->size))
    return fail("source-length-mismatch", "SOURCE_BYTE_LENGTH does not match the stream bytes.");
  if (ncd->SOURCE_SHA256() && ncd->SOURCE_SHA256()->size() == 64) {
    const std::string got = ephem::sha256_hex(in->data, in->size);
    if (got != ncd->SOURCE_SHA256()->str()) return fail("source-hash-mismatch", "SOURCE_SHA256 does not match the stream bytes.");
  }
  return 0;
}

struct Timed {
  int64_t pts = 0;
  klv::Packet packet;
  ground::Footprint footprint;
};

// Every ST 0601 packet with the presentation time it belongs to. A packet in
// an asynchronous stream (no PTS) takes the time of the video PES before it.
std::vector<Timed> timedPackets(const ts::Demuxed& d) {
  std::vector<Timed> out;
  size_t v = 0;
  int64_t lastVideoPts = 0;
  bool haveVideo = false;
  for (const ts::Pes& pes : d.klv) {
    while (v < d.video.size() && d.video[v].order < pes.order) {
      if (d.video[v].hasPts) {
        lastVideoPts = d.video[v].pts;
        haveVideo = true;
      }
      ++v;
    }
    int64_t pts = 0;
    if (pes.hasPts) pts = pes.pts;
    else if (haveVideo) pts = lastVideoPts;
    else continue;
    const uint8_t* p = pes.data.data();
    size_t n = pes.data.size();
    // Synchronous metadata PES (stream type 0x15) carries a 5-byte metadata AU cell header.
    if (pes.kind == ts::StreamKind::KlvSync && n >= 5 && p[0] != 0x06) {
      p += 5;
      n -= 5;
    }
    size_t i = 0;
    while (i + 16 < n) {
      if (p[i] != 0x06 || std::memcmp(p + i, klv::kUasLsKey, 16) != 0) {
        ++i;
        continue;
      }
      Timed t;
      bool valid = false;
      const size_t used = klv::decode(p + i, n - i, &t.packet, &valid);
      if (!used) break;
      if (valid) {
        t.pts = pts;
        t.footprint = ground::footprint(t.packet);
        out.push_back(std::move(t));
      }
      i += used;
    }
  }
  std::stable_sort(out.begin(), out.end(), [](const Timed& a, const Timed& b) { return a.pts < b.pts; });
  return out;
}

int32_t demux(const Input& in, ts::Demuxed* out) {
  ts::Demuxer demuxer;
  *out = demuxer.run(in.data, in.size);
  if (!out->error.empty()) return fail("invalid-transport-stream", out->error.c_str());
  return 0;
}

void appendDouble(std::vector<uint8_t>& out, double v) {
  uint8_t b[8];
  std::memcpy(b, &v, 8);
  out.insert(out.end(), b, b + 8);
}

// Raw bytes on a wildcard port (the SDK's raw lane): plugin_push_output_ex with
// the aligned-binary wire format is the SDK's only way to emit variable-length
// bytes with no SDS identity.
int32_t pushBytes(const char* port, const std::vector<uint8_t>& bytes) {
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 8,
                               bytes.data(), uint32_t(bytes.size())) < 0
             ? 500
             : 0;
}

// UTC ISO 8601 from microseconds since 1970.
std::string isoTime(uint64_t us) {
  const int64_t seconds = int64_t(us / 1000000);
  const int64_t micros = int64_t(us % 1000000);
  int64_t days = seconds / 86400;
  int64_t rem = seconds % 86400;
  // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
  days += 719468;
  const int64_t era = (days >= 0 ? days : days - 146096) / 146097;
  const int64_t doe = days - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t y = yoe + era * 400;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  const int64_t d = doy - (153 * mp + 2) / 5 + 1;
  const int64_t m = mp + (mp < 10 ? 3 : -9);
  if (m <= 2) ++y;
  char buf[40];
  std::snprintf(buf, sizeof(buf), "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%06lldZ", (long long)y, (long long)m,
                (long long)d, (long long)(rem / 3600), (long long)((rem % 3600) / 60), (long long)(rem % 60),
                (long long)micros);
  return buf;
}

}  // namespace

extern "C" int remux() {
  Input in;
  if (int32_t status = readInput(&in)) return status;
  ts::Demuxed d;
  if (int32_t status = demux(in, &d)) return status;
  if (d.videoKind != ts::StreamKind::H264) {
    return fail("unsupported-video", d.videoKind == ts::StreamKind::Hevc
                                         ? "The video is HEVC; only H.264 is remuxed for playback."
                                         : "The video is MPEG-2; only H.264 is remuxed for playback.");
  }

  // Access units -> samples; the first SPS and PPS go to the avcC record.
  mp4::Track track;
  struct Unit {
    int64_t pts, dts;
    mp4::Sample sample;
  };
  std::vector<Unit> units;
  units.reserve(d.video.size());
  for (const ts::Pes& pes : d.video) {
    if (!pes.hasPts) continue;
    Unit u{pes.pts, pes.dts, {}};
    for (const h264::Nal& nal : h264::split(pes.data.data(), pes.data.size())) {
      const int type = nal.type();
      if (type == 9 || type == 12) continue;  // access unit delimiter, filler
      if (type == 7) {
        if (track.sps.empty()) {
          track.sps.assign(nal.data, nal.data + nal.size);
          const h264::SpsInfo info = h264::parseSps(nal);
          if (info.ok) {
            track.width = info.width;
            track.height = info.height;
            track.profile = info.profile;
            track.compatibility = info.compatibility;
            track.level = info.level;
          }
        }
        continue;
      }
      if (type == 8) {
        if (track.pps.empty()) track.pps.assign(nal.data, nal.data + nal.size);
        continue;
      }
      if (type == 5) u.sample.sync = true;
      const uint32_t size = uint32_t(nal.size);
      const uint8_t len[4] = {uint8_t(size >> 24), uint8_t(size >> 16), uint8_t(size >> 8), uint8_t(size)};
      u.sample.data.insert(u.sample.data.end(), len, len + 4);
      u.sample.data.insert(u.sample.data.end(), nal.data, nal.data + nal.size);
    }
    if (!u.sample.data.empty()) units.push_back(std::move(u));
  }
  if (track.sps.empty() || track.pps.empty() || track.width == 0) return fail("invalid-video", "The H.264 stream carries no usable sequence and picture parameter sets.");
  // Playback starts at the first sync sample.
  size_t first = 0;
  while (first < units.size() && !units[first].sample.sync) ++first;
  if (first == units.size()) return fail("invalid-video", "The H.264 stream carries no IDR frame to start from.");
  units.erase(units.begin(), units.begin() + long(first));
  std::stable_sort(units.begin(), units.end(), [](const Unit& a, const Unit& b) { return a.dts < b.dts; });
  const int64_t dts0 = units.front().dts;
  for (size_t i = 0; i < units.size(); ++i) {
    const int64_t next = i + 1 < units.size() ? units[i + 1].dts : -1;
    int64_t duration = next >= 0 ? next - units[i].dts : (i > 0 ? units[i].dts - units[i - 1].dts : 3000);
    if (duration <= 0 || duration > 10 * kTicks) duration = 3000;
    units[i].sample.duration = uint32_t(duration);
    units[i].sample.compositionOffset = int32_t(units[i].pts - units[i].dts);
  }

  // Fragments start at sync samples, about one second each, at most kMaxFragments.
  std::vector<std::pair<size_t, size_t>> ranges;
  const int64_t total = units.back().dts - dts0;
  const int64_t target = std::max<int64_t>(kTicks, total / int64_t(kMaxFragments) + 1);
  size_t start = 0;
  for (size_t i = 1; i <= units.size(); ++i) {
    const bool end = i == units.size();
    if (end || (units[i].sample.sync && units[i].dts - units[start].dts >= target)) {
      ranges.push_back({start, i});
      start = i;
    }
  }
  if (int32_t status = pushBytes("init", mp4::initSegment(track))) return status;
  uint32_t sequence = 1;
  for (const auto& [a, b] : ranges) {
    std::vector<mp4::Sample> samples;
    samples.reserve(b - a);
    for (size_t i = a; i < b; ++i) samples.push_back(std::move(units[i].sample));
    if (int32_t status = pushBytes("media", mp4::fragment(sequence++, uint64_t(units[a].dts - dts0), samples))) return status;
  }

  // The footprint for each frame: the nearest packet with a footprint, within 1 s.
  const std::vector<Timed> packets = timedPackets(d);
  std::vector<const Timed*> located;
  for (const Timed& t : packets)
    if (t.footprint.source != ground::Source::None) located.push_back(&t);
  std::vector<int64_t> frames;
  frames.reserve(units.size());
  for (const Unit& u : units) frames.push_back(u.pts);
  std::sort(frames.begin(), frames.end());
  double epochMs = std::numeric_limits<double>::quiet_NaN();
  for (const Timed& t : packets) {
    if (t.packet.timestampUs) {
      epochMs = double(*t.packet.timestampUs) / 1000.0 - double(t.pts - dts0) * 1000.0 / double(kTicks);
      break;
    }
  }
  std::vector<uint8_t> table;
  table.reserve((4 + frames.size() * 10) * 8);
  appendDouble(table, 1.0);
  appendDouble(table, double(frames.size()));
  appendDouble(table, epochMs);
  appendDouble(table, double(kTicks));
  size_t k = 0;
  for (int64_t pts : frames) {
    while (k + 1 < located.size() && std::llabs(located[k + 1]->pts - pts) <= std::llabs(located[k]->pts - pts)) ++k;
    const Timed* best = located.empty() ? nullptr : located[k];
    const bool valid = best && std::llabs(best->pts - pts) <= kMaxGapTicks;
    appendDouble(table, double(pts - dts0));
    appendDouble(table, valid ? 1.0 : 0.0);
    for (int j = 0; j < 8; ++j) appendDouble(table, valid ? best->footprint.quad[j] : 0.0);
  }
  return pushBytes("frames", table);
}

extern "C" int footprints() {
  Input in;
  if (int32_t status = readInput(&in)) return status;
  ts::Demuxed d;
  if (int32_t status = demux(in, &d)) return status;
  const std::vector<Timed> packets = timedPackets(d);
  if (packets.empty()) return fail("no-st0601", "The stream carries no MISB ST 0601 packet with a valid checksum.");
  for (const Timed& t : packets) {
    GDIT gdi;
    gdi.NAME = t.packet.platform;
    gdi.ID_SENSOR = t.packet.sensor;
    if (t.packet.timestampUs) gdi.IMAGE_TIME = isoTime(*t.packet.timestampUs);
    gdi.FORMAT = imageFormat::OTHER;
    char id[96];
    std::snprintf(id, sizeof(id), "st0601-%lld", (long long)(t.packet.timestampUs ? int64_t(*t.packet.timestampUs) : t.pts));
    gdi.ID = id;
    if (t.footprint.source != ground::Source::None) {
      std::string json = "{\"type\":\"Polygon\",\"coordinates\":[[";
      char point[64];
      for (int j = 0; j <= 4; ++j) {
        const int c = j % 4;
        std::snprintf(point, sizeof(point), "%s[%.9f,%.9f]", j ? "," : "", t.footprint.quad[2 * c], t.footprint.quad[2 * c + 1]);
        json += point;
      }
      json += "]]}";
      gdi.REGION_GEO_JSON = json;
      gdi.REGION_TYPE = "Polygon";
      gdi.REGION_NDIMS = 2;
      gdi.REGION_SRID = 4326;
      gdi.NOTES = t.footprint.source == ground::Source::Corners ? "footprint: ST 0601 corner points (tags 82-89)"
                  : t.footprint.source == ground::Source::Offsets ? "footprint: frame centre and corner offsets (tags 23-33)"
                                                                  : "footprint: sensor corner rays on WGS84 at the frame-centre elevation";
    } else {
      gdi.NOTES = "no footprint: the packet does not locate the frame on the ground";
    }
    ::flatbuffers::FlatBufferBuilder fbb(1024);
    fbb.FinishSizePrefixed(CreateGDI(fbb, &gdi), GDIIdentifier());
    if (plugin_push_output_ex("footprints", "GDI.fbs", "$GDI", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "GDI", 0, 0,
                              fbb.GetBufferPointer(), uint32_t(fbb.GetSize())) < 0)
      return 500;
  }
  return 0;
}
