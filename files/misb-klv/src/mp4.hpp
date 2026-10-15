// Fragmented MP4 (ISO/IEC 14496-12 and -15) for Media Source Extensions: an
// initialization segment (ftyp + moov with one avc1 track and mvex) and media
// fragments (moof + mdat). Timescale 90 kHz, so sample times are the
// transport stream's own ticks.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace mp4 {

class Box {
 public:
  explicit Box(std::vector<uint8_t>& out, const char* type) : out_(out), start_(out.size()) {
    u32(0);
    out_.insert(out_.end(), type, type + 4);
  }
  ~Box() {
    const uint32_t size = uint32_t(out_.size() - start_);
    out_[start_] = uint8_t(size >> 24);
    out_[start_ + 1] = uint8_t(size >> 16);
    out_[start_ + 2] = uint8_t(size >> 8);
    out_[start_ + 3] = uint8_t(size);
  }
  void u8(uint32_t v) { out_.push_back(uint8_t(v)); }
  void u16(uint32_t v) {
    u8(v >> 8);
    u8(v);
  }
  void u32(uint32_t v) {
    u16(v >> 16);
    u16(v);
  }
  void u64(uint64_t v) {
    u32(uint32_t(v >> 32));
    u32(uint32_t(v));
  }
  void bytes(const uint8_t* p, size_t n) { out_.insert(out_.end(), p, p + n); }
  void zeros(size_t n) { out_.insert(out_.end(), n, 0); }
  void full(uint32_t version, uint32_t flags) { u32((version << 24) | flags); }
  size_t at() const { return out_.size(); }
  std::vector<uint8_t>& out() { return out_; }

 private:
  std::vector<uint8_t>& out_;
  size_t start_;
};

inline void matrix(Box& b) {
  const uint32_t m[9] = {0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000};
  for (uint32_t v : m) b.u32(v);
}

struct Track {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> sps;
  std::vector<uint8_t> pps;
  uint8_t profile = 66, compatibility = 0, level = 30;
};

inline std::vector<uint8_t> initSegment(const Track& t) {
  std::vector<uint8_t> out;
  {
    Box ftyp(out, "ftyp");
    ftyp.bytes(reinterpret_cast<const uint8_t*>("isom"), 4);
    ftyp.u32(0x200);
    ftyp.bytes(reinterpret_cast<const uint8_t*>("isomiso6avc1mp41"), 16);
  }
  {
  Box moov(out, "moov");
  {
    Box mvhd(out, "mvhd");
    mvhd.full(0, 0);
    mvhd.u32(0);
    mvhd.u32(0);
    mvhd.u32(90000);
    mvhd.u32(0);
    mvhd.u32(0x00010000);
    mvhd.u16(0x0100);
    mvhd.zeros(10);
    matrix(mvhd);
    mvhd.zeros(24);
    mvhd.u32(2);
  }
  {
    Box trak(out, "trak");
    {
      Box tkhd(out, "tkhd");
      tkhd.full(0, 3);
      tkhd.u32(0);
      tkhd.u32(0);
      tkhd.u32(1);
      tkhd.u32(0);
      tkhd.u32(0);
      tkhd.zeros(8);
      tkhd.u16(0);
      tkhd.u16(0);
      tkhd.u16(0);
      tkhd.u16(0);
      matrix(tkhd);
      tkhd.u32(t.width << 16);
      tkhd.u32(t.height << 16);
    }
    Box mdia(out, "mdia");
    {
      Box mdhd(out, "mdhd");
      mdhd.full(0, 0);
      mdhd.u32(0);
      mdhd.u32(0);
      mdhd.u32(90000);
      mdhd.u32(0);
      mdhd.u16(0x55C4);  // 'und'
      mdhd.u16(0);
    }
    {
      Box hdlr(out, "hdlr");
      hdlr.full(0, 0);
      hdlr.u32(0);
      hdlr.bytes(reinterpret_cast<const uint8_t*>("vide"), 4);
      hdlr.zeros(12);
      hdlr.bytes(reinterpret_cast<const uint8_t*>("Video\0"), 6);
    }
    Box minf(out, "minf");
    {
      Box vmhd(out, "vmhd");
      vmhd.full(0, 1);
      vmhd.zeros(8);
    }
    {
      Box dinf(out, "dinf");
      Box dref(out, "dref");
      dref.full(0, 0);
      dref.u32(1);
      Box url(out, "url ");
      url.full(0, 1);
    }
    Box stbl(out, "stbl");
    {
      Box stsd(out, "stsd");
      stsd.full(0, 0);
      stsd.u32(1);
      Box avc1(out, "avc1");
      avc1.zeros(6);
      avc1.u16(1);
      avc1.zeros(16);
      avc1.u16(t.width);
      avc1.u16(t.height);
      avc1.u32(0x00480000);
      avc1.u32(0x00480000);
      avc1.u32(0);
      avc1.u16(1);
      avc1.zeros(32);
      avc1.u16(0x0018);
      avc1.u16(0xFFFF);
      Box avcC(out, "avcC");
      avcC.u8(1);
      avcC.u8(t.profile);
      avcC.u8(t.compatibility);
      avcC.u8(t.level);
      avcC.u8(0xFF);  // 4-byte NAL lengths
      avcC.u8(0xE1);  // one SPS
      avcC.u16(uint32_t(t.sps.size()));
      avcC.bytes(t.sps.data(), t.sps.size());
      avcC.u8(1);
      avcC.u16(uint32_t(t.pps.size()));
      avcC.bytes(t.pps.data(), t.pps.size());
    }
    for (const char* empty : {"stts", "stsc", "stco"}) {
      Box b(out, empty);
      b.full(0, 0);
      b.u32(0);
    }
    {
      Box stsz(out, "stsz");
      stsz.full(0, 0);
      stsz.u32(0);
      stsz.u32(0);
    }
  }
  {
    Box mvex(out, "mvex");
    Box trex(out, "trex");
    trex.full(0, 0);
    trex.u32(1);
    trex.u32(1);
    trex.u32(0);
    trex.u32(0);
    trex.u32(0);
  }
  }  // moov
  return out;
}

struct Sample {
  std::vector<uint8_t> data;  // length-prefixed NAL units
  uint32_t duration = 0;
  int32_t compositionOffset = 0;
  bool sync = false;
};

// One fragment: moof (mfhd, traf: tfhd, tfdt, trun) + mdat.
inline std::vector<uint8_t> fragment(uint32_t sequence, uint64_t baseDecodeTime, const std::vector<Sample>& samples) {
  std::vector<uint8_t> out;
  size_t dataOffsetAt = 0;
  {
    Box moof(out, "moof");
    {
      Box mfhd(out, "mfhd");
      mfhd.full(0, 0);
      mfhd.u32(sequence);
    }
    Box traf(out, "traf");
    {
      Box tfhd(out, "tfhd");
      tfhd.full(0, 0x020000);  // default-base-is-moof
      tfhd.u32(1);
    }
    {
      Box tfdt(out, "tfdt");
      tfdt.full(1, 0);
      tfdt.u64(baseDecodeTime);
    }
    Box trun(out, "trun");
    // data-offset, duration, size, flags, composition offset (signed: version 1).
    trun.full(1, 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800);
    trun.u32(uint32_t(samples.size()));
    dataOffsetAt = trun.at();
    trun.u32(0);
    for (const Sample& s : samples) {
      trun.u32(s.duration);
      trun.u32(uint32_t(s.data.size()));
      trun.u32(s.sync ? 0x02000000 : 0x01010000);
      trun.u32(uint32_t(s.compositionOffset));
    }
  }
  const uint32_t moofSize = uint32_t(out.size());
  const uint32_t dataOffset = moofSize + 8;
  out[dataOffsetAt] = uint8_t(dataOffset >> 24);
  out[dataOffsetAt + 1] = uint8_t(dataOffset >> 16);
  out[dataOffsetAt + 2] = uint8_t(dataOffset >> 8);
  out[dataOffsetAt + 3] = uint8_t(dataOffset);
  {
    Box mdat(out, "mdat");
    for (const Sample& s : samples) mdat.bytes(s.data.data(), s.data.size());
  }
  return out;
}

}  // namespace mp4
