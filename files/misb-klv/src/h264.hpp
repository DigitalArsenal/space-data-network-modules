// H.264 (ISO/IEC 14496-10) Annex B access units -> length-prefixed samples,
// with the sequence and picture parameter sets an avcC record needs and the
// coded picture size from the SPS.
#pragma once
#include <cstdint>
#include <vector>

namespace h264 {

struct Nal {
  const uint8_t* data;
  size_t size;
  int type() const { return size ? data[0] & 0x1F : -1; }
};

// The NAL units of an Annex B byte stream (start codes 00 00 01 / 00 00 00 01).
inline std::vector<Nal> split(const uint8_t* p, size_t n) {
  std::vector<Nal> out;
  size_t i = 0;
  auto findStart = [&](size_t from) -> size_t {
    for (size_t k = from; k + 3 <= n; ++k) {
      if (p[k] == 0 && p[k + 1] == 0 && p[k + 2] == 1) return k;
    }
    return n;
  };
  i = findStart(0);
  while (i < n) {
    const size_t begin = i + 3;
    size_t next = findStart(begin);
    size_t end = next;
    // A four-byte start code leaves a zero before the next three-byte one.
    while (end > begin && p[end - 1] == 0) --end;
    if (end > begin) out.push_back({p + begin, end - begin});
    i = next;
  }
  return out;
}

class Bits {
 public:
  Bits(const std::vector<uint8_t>& rbsp) : d_(rbsp) {}
  uint32_t bit() {
    if (pos_ >= d_.size() * 8) {
      over_ = true;
      return 0;
    }
    const uint32_t b = (d_[pos_ >> 3] >> (7 - (pos_ & 7))) & 1;
    ++pos_;
    return b;
  }
  uint32_t bits(int n) {
    uint32_t v = 0;
    for (int i = 0; i < n; ++i) v = (v << 1) | bit();
    return v;
  }
  uint32_t ue() {
    int zeros = 0;
    while (bit() == 0 && !over_ && zeros < 32) ++zeros;
    return zeros ? ((1u << zeros) - 1 + bits(zeros)) : 0;
  }
  int32_t se() {
    const uint32_t k = ue();
    return (k & 1) ? int32_t((k + 1) / 2) : -int32_t(k / 2);
  }
  bool over() const { return over_; }

 private:
  const std::vector<uint8_t>& d_;
  size_t pos_ = 0;
  bool over_ = false;
};

// Removes emulation-prevention bytes (00 00 03 -> 00 00).
inline std::vector<uint8_t> rbsp(const uint8_t* p, size_t n) {
  std::vector<uint8_t> out;
  out.reserve(n);
  int zeros = 0;
  for (size_t i = 0; i < n; ++i) {
    if (zeros >= 2 && p[i] == 3) {
      zeros = 0;
      continue;
    }
    out.push_back(p[i]);
    zeros = p[i] == 0 ? zeros + 1 : 0;
  }
  return out;
}

struct SpsInfo {
  uint32_t width = 0;
  uint32_t height = 0;
  uint8_t profile = 0;
  uint8_t compatibility = 0;
  uint8_t level = 0;
  bool ok = false;
};

inline void skipScalingList(Bits& b, int size) {
  int last = 8, next = 8;
  for (int j = 0; j < size; ++j) {
    if (next != 0) next = (last + b.se() + 256) % 256;
    last = next == 0 ? last : next;
  }
}

inline SpsInfo parseSps(const Nal& nal) {
  SpsInfo info;
  if (nal.size < 4) return info;
  const std::vector<uint8_t> r = rbsp(nal.data + 1, nal.size - 1);
  Bits b(r);
  info.profile = uint8_t(b.bits(8));
  info.compatibility = uint8_t(b.bits(8));
  info.level = uint8_t(b.bits(8));
  b.ue();  // seq_parameter_set_id
  uint32_t chroma = 1;
  bool separateColour = false;
  const int p = info.profile;
  if (p == 100 || p == 110 || p == 122 || p == 244 || p == 44 || p == 83 || p == 86 || p == 118 || p == 128 ||
      p == 138 || p == 139 || p == 134 || p == 135) {
    chroma = b.ue();
    if (chroma == 3) separateColour = b.bit();
    b.ue();  // bit_depth_luma_minus8
    b.ue();  // bit_depth_chroma_minus8
    b.bit();  // qpprime_y_zero_transform_bypass_flag
    if (b.bit()) {  // seq_scaling_matrix_present_flag
      const int lists = chroma != 3 ? 8 : 12;
      for (int i = 0; i < lists; ++i) {
        if (b.bit()) skipScalingList(b, i < 6 ? 16 : 64);
      }
    }
  }
  b.ue();  // log2_max_frame_num_minus4
  const uint32_t pocType = b.ue();
  if (pocType == 0) {
    b.ue();
  } else if (pocType == 1) {
    b.bit();
    b.se();
    b.se();
    const uint32_t cycle = b.ue();
    for (uint32_t i = 0; i < cycle && !b.over(); ++i) b.se();
  }
  b.ue();   // max_num_ref_frames
  b.bit();  // gaps_in_frame_num_value_allowed_flag
  const uint32_t widthMbs = b.ue() + 1;
  const uint32_t heightMapUnits = b.ue() + 1;
  const uint32_t frameMbsOnly = b.bit();
  if (!frameMbsOnly) b.bit();  // mb_adaptive_frame_field_flag
  b.bit();                     // direct_8x8_inference_flag
  uint32_t cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
  if (b.bit()) {
    cropLeft = b.ue();
    cropRight = b.ue();
    cropTop = b.ue();
    cropBottom = b.ue();
  }
  const uint32_t chromaArray = separateColour ? 0 : chroma;
  const uint32_t subW = (chromaArray == 1 || chromaArray == 2) ? 2 : 1;
  const uint32_t subH = chromaArray == 1 ? 2 : 1;
  const uint32_t cropUnitX = chromaArray == 0 ? 1 : subW;
  const uint32_t cropUnitY = (chromaArray == 0 ? 1 : subH) * (2 - frameMbsOnly);
  info.width = widthMbs * 16 - cropUnitX * (cropLeft + cropRight);
  info.height = (2 - frameMbsOnly) * heightMapUnits * 16 - cropUnitY * (cropTop + cropBottom);
  info.ok = !b.over() && info.width > 0 && info.height > 0;
  return info;
}

}  // namespace h264
