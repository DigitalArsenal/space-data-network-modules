// Baseline JPEG (ITU-T T.81, JFIF) encoder for 8-bit grayscale and RGB
// images: the standard Annex K quantisation tables scaled by quality (the IJG
// formula), the Annex K Huffman tables, the AAN floating-point forward DCT,
// 4:2:0 chroma for colour. Written for data-source/body-imagery (tiles and
// whole-body textures); no restart markers, no progressive mode.
#ifndef BODY_IMAGERY_JPEG_ENCODER_HPP
#define BODY_IMAGERY_JPEG_ENCODER_HPP
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

namespace jpeg {
namespace {

const uint8_t kZigzag[64] = {0,  1,  8,  16, 9,  2,  3,  10, 17, 24, 32, 25, 18, 11, 4,  5,  12, 19, 26, 33, 40, 48,
                             41, 34, 27, 20, 13, 6,  7,  14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23,
                             30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63};
const uint8_t kLumaQ[64] = {16, 11, 10, 16, 24,  40,  51,  61,  12, 12, 14, 19, 26,  58,  60,  55,
                            14, 13, 16, 24, 40,  57,  69,  56,  14, 17, 22, 29, 51,  87,  80,  62,
                            18, 22, 37, 56, 68,  109, 103, 77,  24, 35, 55, 64, 81,  104, 113, 92,
                            49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99};
const uint8_t kChromaQ[64] = {17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99,
                              99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
                              99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99};
// Annex K.3 Huffman tables: code counts per length 1..16, then the values.
const uint8_t kDcLumaBits[16] = {0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0};
const uint8_t kDcLumaVal[12] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
const uint8_t kDcChromaBits[16] = {0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0};
const uint8_t kDcChromaVal[12] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
const uint8_t kAcLumaBits[16] = {0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d};
const uint8_t kAcLumaVal[162] = {
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
    0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
    0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
    0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65,
    0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
    0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
    0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
    0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa};
const uint8_t kAcChromaBits[16] = {0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77};
const uint8_t kAcChromaVal[162] = {
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32,
    0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16,
    0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
    0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86,
    0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
    0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
    0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa};

struct Huffman {
  uint16_t code[256];
  uint8_t size[256];
  void build(const uint8_t bits[16], const uint8_t* values) {
    std::memset(size, 0, sizeof size);
    uint16_t c = 0;
    int k = 0;
    for (int len = 1; len <= 16; ++len) {
      for (int i = 0; i < bits[len - 1]; ++i, ++k) {
        code[values[k]] = c++;
        size[values[k]] = uint8_t(len);
      }
      c <<= 1;
    }
  }
};

class BitWriter {
 public:
  explicit BitWriter(std::vector<uint8_t>& out) : out_(out) {}
  void put(uint32_t bits, int count) {
    acc_ = (acc_ << count) | (bits & ((1u << count) - 1u));
    n_ += count;
    while (n_ >= 8) {
      const uint8_t byte = uint8_t(acc_ >> (n_ - 8));
      out_.push_back(byte);
      if (byte == 0xff) out_.push_back(0);  // byte stuffing
      n_ -= 8;
    }
  }
  void flush() {
    if (n_ > 0) put(0x7f, 7 - ((n_ - 1) % 8));  // pad with ones
    acc_ = 0;
    n_ = 0;
  }

 private:
  std::vector<uint8_t>& out_;
  uint64_t acc_ = 0;
  int n_ = 0;
};

// AAN scaled forward DCT on one 8x8 block (in place), then quantised with the
// folded AAN scale factors.
void fdct(float d[64]) {
  for (int pass = 0; pass < 2; ++pass) {
    for (int i = 0; i < 8; ++i) {
      float* p = pass == 0 ? d + 8 * i : d + i;
      const int s = pass == 0 ? 1 : 8;
      const float t0 = p[0] + p[7 * s], t7 = p[0] - p[7 * s];
      const float t1 = p[s] + p[6 * s], t6 = p[s] - p[6 * s];
      const float t2 = p[2 * s] + p[5 * s], t5 = p[2 * s] - p[5 * s];
      const float t3 = p[3 * s] + p[4 * s], t4 = p[3 * s] - p[4 * s];
      float t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
      p[0] = t10 + t11;
      p[4 * s] = t10 - t11;
      const float z1 = (t12 + t13) * 0.707106781f;
      p[2 * s] = t13 + z1;
      p[6 * s] = t13 - z1;
      t10 = t4 + t5;
      t11 = t5 + t6;
      t12 = t6 + t7;
      const float z5 = (t10 - t12) * 0.382683433f;
      const float z2 = 0.541196100f * t10 + z5;
      const float z4 = 1.306562965f * t12 + z5;
      const float z3 = t11 * 0.707106781f;
      const float z11 = t7 + z3, z13 = t7 - z3;
      p[5 * s] = z13 + z2;
      p[3 * s] = z13 - z2;
      p[s] = z11 + z4;
      p[7 * s] = z11 - z4;
    }
  }
}

class Encoder {
 public:
  explicit Encoder(int quality) {
    quality = quality < 1 ? 1 : (quality > 100 ? 100 : quality);
    const int scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
    static const float aan[8] = {1.0f, 1.387039845f, 1.306562965f, 1.175875602f,
                                 1.0f, 0.785694958f, 0.541196100f, 0.275899379f};
    for (int i = 0; i < 64; ++i) {
      int ql = (kLumaQ[i] * scale + 50) / 100, qc = (kChromaQ[i] * scale + 50) / 100;
      ql = ql < 1 ? 1 : (ql > 255 ? 255 : ql);
      qc = qc < 1 ? 1 : (qc > 255 ? 255 : qc);
      qLuma_[i] = uint8_t(ql);
      qChroma_[i] = uint8_t(qc);
    }
    for (int r = 0; r < 8; ++r) {
      for (int c = 0; c < 8; ++c) {
        const int i = 8 * r + c;
        fLuma_[i] = 1.0f / (qLuma_[i] * aan[r] * aan[c] * 8.0f);
        fChroma_[i] = 1.0f / (qChroma_[i] * aan[r] * aan[c] * 8.0f);
      }
    }
    dcLuma_.build(kDcLumaBits, kDcLumaVal);
    dcChroma_.build(kDcChromaBits, kDcChromaVal);
    acLuma_.build(kAcLumaBits, kAcLumaVal);
    acChroma_.build(kAcChromaBits, kAcChromaVal);
  }

  // pixels: width*height*channels bytes, row-major; channels 1 or 3.
  std::vector<uint8_t> encode(const uint8_t* pixels, int width, int height, int channels) const {
    std::vector<uint8_t> out;
    out.reserve(size_t(width) * height / 4 + 1024);
    header(out, width, height, channels);
    BitWriter bits(out);
    int prev[3] = {0, 0, 0};
    float block[64];
    if (channels == 1) {
      for (int by = 0; by < height; by += 8) {
        for (int bx = 0; bx < width; bx += 8) {
          for (int y = 0; y < 8; ++y) {
            const int sy = by + y < height ? by + y : height - 1;
            for (int x = 0; x < 8; ++x) {
              const int sx = bx + x < width ? bx + x : width - 1;
              block[8 * y + x] = float(pixels[size_t(sy) * width + sx]) - 128.0f;
            }
          }
          code(bits, block, fLuma_, prev[0], dcLuma_, acLuma_);
        }
      }
    } else {
      // 4:2:0: four luma blocks and one Cb, one Cr block per 16x16 MCU.
      for (int my = 0; my < height; my += 16) {
        for (int mx = 0; mx < width; mx += 16) {
          float cb[64] = {}, cr[64] = {};
          for (int k = 0; k < 4; ++k) {
            const int ox = mx + 8 * (k & 1), oy = my + 8 * (k >> 1);
            for (int y = 0; y < 8; ++y) {
              const int sy = oy + y < height ? oy + y : height - 1;
              for (int x = 0; x < 8; ++x) {
                const int sx = ox + x < width ? ox + x : width - 1;
                const uint8_t* p = pixels + (size_t(sy) * width + sx) * 3;
                const float r = p[0], g = p[1], b = p[2];
                block[8 * y + x] = 0.299f * r + 0.587f * g + 0.114f * b - 128.0f;
                const int ci = 8 * ((y + 8 * (k >> 1)) >> 1) + ((x + 8 * (k & 1)) >> 1);
                cb[ci] += 0.25f * (-0.168736f * r - 0.331264f * g + 0.5f * b);
                cr[ci] += 0.25f * (0.5f * r - 0.418688f * g - 0.081312f * b);
              }
            }
            code(bits, block, fLuma_, prev[0], dcLuma_, acLuma_);
          }
          code(bits, cb, fChroma_, prev[1], dcChroma_, acChroma_);
          code(bits, cr, fChroma_, prev[2], dcChroma_, acChroma_);
        }
      }
    }
    bits.flush();
    out.push_back(0xff);
    out.push_back(0xd9);  // EOI
    return out;
  }

 private:
  static void category(int v, int& size, uint32_t& bits) {
    int a = v < 0 ? -v : v;
    size = 0;
    while (a) {
      ++size;
      a >>= 1;
    }
    bits = uint32_t(v < 0 ? v + (1 << size) - 1 : v);
  }

  static void code(BitWriter& bits, float* block, const float* factor, int& prev, const Huffman& dc,
                   const Huffman& ac) {
    fdct(block);
    int q[64];
    for (int i = 0; i < 64; ++i) {
      const float v = block[kZigzag[i]] * factor[kZigzag[i]];
      q[i] = int(v < 0 ? v - 0.5f : v + 0.5f);
    }
    int size;
    uint32_t extra;
    const int diff = q[0] - prev;
    prev = q[0];
    category(diff, size, extra);
    bits.put(dc.code[size], dc.size[size]);
    if (size) bits.put(extra, size);
    int run = 0;
    int last = 63;
    while (last > 0 && q[last] == 0) --last;
    for (int i = 1; i <= last; ++i) {
      if (q[i] == 0) {
        ++run;
        continue;
      }
      while (run > 15) {
        bits.put(ac.code[0xf0], ac.size[0xf0]);  // ZRL
        run -= 16;
      }
      category(q[i], size, extra);
      const int symbol = (run << 4) | size;
      bits.put(ac.code[symbol], ac.size[symbol]);
      bits.put(extra, size);
      run = 0;
    }
    if (last < 63) bits.put(ac.code[0x00], ac.size[0x00]);  // EOB
  }

  void table(std::vector<uint8_t>& o, uint8_t id, const uint8_t* q) const {
    for (int i = 0; i < 64; ++i) o.push_back(q[kZigzag[i]]);
    (void)id;
  }

  static void huff(std::vector<uint8_t>& o, uint8_t cls, const uint8_t bits[16], const uint8_t* values) {
    int n = 0;
    for (int i = 0; i < 16; ++i) n += bits[i];
    const int len = 2 + 1 + 16 + n;
    o.insert(o.end(), {0xff, 0xc4, uint8_t(len >> 8), uint8_t(len), cls});
    o.insert(o.end(), bits, bits + 16);
    o.insert(o.end(), values, values + n);
  }

  void header(std::vector<uint8_t>& o, int w, int h, int channels) const {
    o.insert(o.end(), {0xff, 0xd8, 0xff, 0xe0, 0, 16, 'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0});
    const int dqtLen = channels == 1 ? 67 : 132;
    o.insert(o.end(), {0xff, 0xdb, uint8_t(dqtLen >> 8), uint8_t(dqtLen), 0});
    table(o, 0, qLuma_);
    if (channels == 3) {
      o.push_back(1);
      table(o, 1, qChroma_);
    }
    const int sofLen = 8 + 3 * channels;
    o.insert(o.end(), {0xff, 0xc0, uint8_t(sofLen >> 8), uint8_t(sofLen), 8, uint8_t(h >> 8), uint8_t(h),
                       uint8_t(w >> 8), uint8_t(w), uint8_t(channels)});
    if (channels == 1) {
      o.insert(o.end(), {1, 0x11, 0});
    } else {
      o.insert(o.end(), {1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1});
    }
    huff(o, 0x00, kDcLumaBits, kDcLumaVal);
    huff(o, 0x10, kAcLumaBits, kAcLumaVal);
    if (channels == 3) {
      huff(o, 0x01, kDcChromaBits, kDcChromaVal);
      huff(o, 0x11, kAcChromaBits, kAcChromaVal);
    }
    const int sosLen = 6 + 2 * channels;
    o.insert(o.end(), {0xff, 0xda, uint8_t(sosLen >> 8), uint8_t(sosLen), uint8_t(channels)});
    if (channels == 1) {
      o.insert(o.end(), {1, 0x00});
    } else {
      o.insert(o.end(), {1, 0x00, 2, 0x11, 3, 0x11});
    }
    o.insert(o.end(), {0, 63, 0});
  }

  uint8_t qLuma_[64], qChroma_[64];
  float fLuma_[64], fChroma_[64];
  Huffman dcLuma_, dcChroma_, acLuma_, acChroma_;
};

}  // namespace
}  // namespace jpeg
#endif  // BODY_IMAGERY_JPEG_ENCODER_HPP
