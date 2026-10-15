// MPEG-2 transport stream demultiplexer (ISO/IEC 13818-1): PAT, PMT and
// PES reassembly for one video stream and its KLV metadata streams.
//
// Accepts 188-byte packets and 192-byte M2TS packets (a 4-byte timecode
// before each). PTS and DTS are 33-bit 90 kHz counters; they are unwrapped
// across the 2^33 rollover (about 26.5 h) in arrival order, so a long
// recording keeps increasing times.
#pragma once
#include <cstdint>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace ts {

enum class StreamKind { Other, H264, Hevc, Mpeg2Video, KlvSync, KlvAsync };

struct Pes {
  StreamKind kind = StreamKind::Other;
  bool hasPts = false;
  bool hasDts = false;
  int64_t pts = 0;  // unwrapped, 90 kHz
  int64_t dts = 0;
  uint64_t order = 0;  // arrival order of the PES start
  std::vector<uint8_t> data;
};

struct Demuxed {
  std::vector<Pes> video;
  std::vector<Pes> klv;
  StreamKind videoKind = StreamKind::Other;
  std::string error;
};

class Unwrapper {
 public:
  int64_t operator()(uint64_t raw) {
    const int64_t wrap = int64_t(1) << 33;
    if (!seen_) {
      seen_ = true;
      last_ = int64_t(raw);
      offset_ = 0;
      return last_;
    }
    int64_t value = int64_t(raw) + offset_;
    // A jump back by more than half the range is a rollover; forward likewise undoes one.
    if (value < last_ - wrap / 2) {
      offset_ += wrap;
      value += wrap;
    } else if (value > last_ + wrap / 2 && offset_ >= wrap) {
      offset_ -= wrap;
      value -= wrap;
    }
    last_ = value;
    return value;
  }

 private:
  bool seen_ = false;
  int64_t last_ = 0;
  int64_t offset_ = 0;
};

inline uint64_t readTimestamp(const uint8_t* p) {
  return (uint64_t(p[0] & 0x0E) << 29) | (uint64_t(p[1]) << 22) | (uint64_t(p[2] & 0xFE) << 14) |
         (uint64_t(p[3]) << 7) | (uint64_t(p[4]) >> 1);
}

// Packet size and the offset of the first sync byte, or {0,0}.
inline std::pair<size_t, size_t> packetLayout(const uint8_t* data, size_t size) {
  for (size_t packet : {size_t(188), size_t(192)}) {
    const size_t offset = packet == 192 ? 4 : 0;
    const size_t checks = std::min<size_t>(5, size / packet);
    if (checks < 2) continue;
    bool ok = true;
    for (size_t i = 0; i < checks && ok; ++i) ok = data[offset + i * packet] == 0x47;
    if (ok) return {packet, offset};
  }
  return {0, 0};
}

class Demuxer {
 public:
  Demuxed run(const uint8_t* data, size_t size) {
    Demuxed out;
    auto [packet, offset] = packetLayout(data, size);
    if (!packet) {
      out.error = "the bytes are not an MPEG transport stream";
      return out;
    }
    for (size_t at = offset; at + 188 <= size; at += packet) {
      const uint8_t* p = data + at;
      if (p[0] != 0x47) continue;  // lost sync: skip the packet
      packetIn(p, out);
    }
    for (auto& entry : open_) flush(entry.first, out);
    out.videoKind = videoKind_;
    if (!out.error.empty()) return out;
    if (videoPid_ < 0) out.error = "the stream carries no video";
    return out;
  }

 private:
  struct Open {
    bool active = false;
    Pes pes;
  };

  void packetIn(const uint8_t* p, Demuxed& out) {
    const bool start = (p[1] & 0x40) != 0;
    const int pid = ((p[1] & 0x1F) << 8) | p[2];
    const int afc = (p[3] >> 4) & 0x3;
    size_t pos = 4;
    if (afc == 2 || afc == 0) return;  // no payload
    if (afc == 3) pos += 1 + p[4];
    if (pos >= 188) return;
    const uint8_t* payload = p + pos;
    const size_t length = 188 - pos;
    if (pid == 0) {
      if (start) section(payload, length, true, -1);
      return;
    }
    if (pmtPids_.count(pid)) {
      if (start) section(payload, length, false, pid);
      return;
    }
    auto kind = kinds_.find(pid);
    if (kind == kinds_.end()) return;
    Open& o = open_[pid];
    if (start) {
      flush(pid, out);
      startPes(o, kind->second, payload, length);
    } else if (o.active) {
      o.pes.data.insert(o.pes.data.end(), payload, payload + length);
    }
  }

  void startPes(Open& o, StreamKind kind, const uint8_t* p, size_t n) {
    o.active = false;
    if (n < 9 || p[0] != 0 || p[1] != 0 || p[2] != 1) return;
    const uint8_t flags = p[7];
    const size_t headerLength = p[8];
    if (9 + headerLength > n) return;
    o.pes = Pes();
    o.pes.kind = kind;
    o.pes.order = order_++;
    if ((flags & 0x80) && headerLength >= 5) {
      o.pes.hasPts = true;
      o.pes.pts = unwrap_(readTimestamp(p + 9));
      if ((flags & 0x40) && headerLength >= 10) {
        o.pes.hasDts = true;
        // DTS shares the PTS unwrapper's offset: both ride the same clock.
        int64_t lead = int64_t(readTimestamp(p + 9)) - int64_t(readTimestamp(p + 14));
        const int64_t wrap = int64_t(1) << 33;
        if (lead < -wrap / 2) lead += wrap;
        if (lead > wrap / 2) lead -= wrap;
        o.pes.dts = o.pes.pts - lead;
      }
    }
    if (!o.pes.hasDts) o.pes.dts = o.pes.pts;
    o.pes.data.assign(p + 9 + headerLength, p + n);
    o.active = true;
  }

  void flush(int pid, Demuxed& out) {
    auto it = open_.find(pid);
    if (it == open_.end() || !it->second.active) return;
    Pes& pes = it->second.pes;
    if (pes.kind == StreamKind::KlvSync || pes.kind == StreamKind::KlvAsync) {
      out.klv.push_back(std::move(pes));
    } else if (pid == videoPid_) {
      out.video.push_back(std::move(pes));
    }
    it->second.active = false;
    it->second.pes = Pes();
    (void)out;
  }

  // One PSI section (PAT or PMT) starting in this packet.
  void section(const uint8_t* p, size_t n, bool pat, int pmtPid) {
    if (n < 1) return;
    const size_t pointer = p[0];
    if (1 + pointer + 8 > n) return;
    const uint8_t* s = p + 1 + pointer;
    const size_t avail = n - 1 - pointer;
    const size_t sectionLength = ((s[1] & 0x0F) << 8) | s[2];
    if (3 + sectionLength > avail || sectionLength < 9) return;
    const size_t end = 3 + sectionLength - 4;  // before the CRC
    if (pat) {
      for (size_t i = 8; i + 4 <= end; i += 4) {
        const int program = (s[i] << 8) | s[i + 1];
        const int pid = ((s[i + 2] & 0x1F) << 8) | s[i + 3];
        if (program != 0) pmtPids_[pid] = true;
      }
      return;
    }
    (void)pmtPid;
    const size_t infoLength = ((s[10] & 0x0F) << 8) | s[11];
    size_t i = 12 + infoLength;
    while (i + 5 <= end) {
      const int type = s[i];
      const int pid = ((s[i + 1] & 0x1F) << 8) | s[i + 2];
      const size_t esInfo = ((s[i + 3] & 0x0F) << 8) | s[i + 4];
      bool klva = false;
      for (size_t d = i + 5; d + 2 <= i + 5 + esInfo && d + 2 <= end;) {
        const int tag = s[d];
        const size_t len = s[d + 1];
        // registration_descriptor 'KLVA', or a metadata_descriptor naming KLV.
        if (tag == 0x05 && len >= 4 && std::memcmp(s + d + 2, "KLVA", 4) == 0) klva = true;
        if (tag == 0x26 && len >= 9 && std::memcmp(s + d + 2 + 5, "KLVA", 4) == 0) klva = true;
        d += 2 + len;
      }
      StreamKind kind = StreamKind::Other;
      if (type == 0x1B) kind = StreamKind::H264;
      else if (type == 0x24) kind = StreamKind::Hevc;
      else if (type == 0x02 || type == 0x01) kind = StreamKind::Mpeg2Video;
      else if (type == 0x15) kind = StreamKind::KlvSync;
      else if (type == 0x06 && klva) kind = StreamKind::KlvAsync;
      if (kind != StreamKind::Other) {
        kinds_[pid] = kind;
        if ((kind == StreamKind::H264 || kind == StreamKind::Hevc || kind == StreamKind::Mpeg2Video) && videoPid_ < 0) {
          videoPid_ = pid;
          videoKind_ = kind;
        }
      }
      i += 5 + esInfo;
    }
  }

 public:
  StreamKind videoKind() const { return videoKind_; }

 private:
  std::map<int, bool> pmtPids_;
  std::map<int, StreamKind> kinds_;
  std::map<int, Open> open_;
  int videoPid_ = -1;
  StreamKind videoKind_ = StreamKind::Other;
  uint64_t order_ = 0;
  Unwrapper unwrap_;
};

}  // namespace ts
