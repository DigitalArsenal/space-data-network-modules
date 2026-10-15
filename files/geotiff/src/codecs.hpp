#pragma once
// TIFF chunk decompression: none (1), LZW (5), JPEG (7, through the vendored
// stb_image with the file's JPEGTables), DEFLATE (8 and 32946, through the
// vendored miniz inflate) and PackBits (32773). LZW and PackBits are the TIFF
// 6.0 specification's own algorithms (sections 13 and 9); no maintained
// single-file library carries them for this compiler lane.

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace codecs {

// TIFF LZW (MSB-first codes, 9 to 12 bits, the "early change" width step).
inline bool lzw(const uint8_t* in, size_t n, size_t expect, std::vector<uint8_t>* out) {
  out->clear();
  out->reserve(expect);
  std::vector<int16_t> prefix(4096, -1);
  std::vector<uint8_t> suffix(4096), firstByte(4096);
  std::vector<uint16_t> length(4096, 1);
  for (int i = 0; i < 256; ++i) suffix[i] = firstByte[i] = uint8_t(i);
  uint32_t bits = 0;
  int have = 0, width = 9, next = 258, prev = -1;
  size_t pos = 0;
  while (out->size() < expect) {
    while (have < width) {
      if (pos >= n) return out->size() >= expect;
      bits = (bits << 8) | in[pos++];
      have += 8;
    }
    const int code = int((bits >> (have - width)) & ((1u << width) - 1));
    have -= width;
    if (code == 257) break;
    if (code == 256) {
      width = 9;
      next = 258;
      prev = -1;
      continue;
    }
    if (prev < 0) {
      if (code > 255) return false;
      out->push_back(uint8_t(code));
      prev = code;
      continue;
    }
    if (code > next) return false;
    const uint8_t fb = code < next ? firstByte[code] : firstByte[prev];
    if (next < 4096) {
      prefix[next] = int16_t(prev);
      suffix[next] = fb;
      firstByte[next] = firstByte[prev];
      length[next] = uint16_t(length[prev] + 1);
      ++next;
    }
    if (code >= next) return false;
    const size_t at = out->size(), len = length[code];
    out->resize(at + len);
    for (int c = code, i = int(len) - 1; i >= 0; --i, c = prefix[c]) (*out)[at + i] = suffix[c];
    prev = code;
    if (next >= (1 << width) - 1 && width < 12) ++width;
  }
  return out->size() >= expect;
}

inline bool packbits(const uint8_t* in, size_t n, size_t expect, std::vector<uint8_t>* out) {
  out->clear();
  out->reserve(expect);
  size_t i = 0;
  while (i < n && out->size() < expect) {
    const int8_t h = int8_t(in[i++]);
    if (h >= 0) {
      const size_t c = size_t(h) + 1;
      if (i + c > n) return false;
      out->insert(out->end(), in + i, in + i + c);
      i += c;
    } else if (h != -128) {
      if (i >= n) return false;
      out->insert(out->end(), size_t(1 - h), in[i++]);
    }
  }
  return out->size() >= expect;
}

inline bool inflate(const uint8_t* in, size_t n, size_t expect, std::vector<uint8_t>* out) {
  out->assign(expect, 0);
  const size_t got = tinfl_decompress_mem_to_mem(out->data(), expect, in, n, TINFL_FLAG_PARSE_ZLIB_HEADER);
  return got != TINFL_DECOMPRESS_MEM_TO_MEM_FAILED && got >= expect;
}

// A JPEG chunk with the file's abbreviated tables (JPEGTables, tag 347)
// spliced in front: tables without their EOI, then the chunk without its SOI.
inline bool jpeg(const uint8_t* in, size_t n, const uint8_t* tables, size_t tablesLen, int channels, uint32_t w, uint32_t h,
                 std::vector<uint8_t>* out) {
  std::vector<uint8_t> stream;
  if (tables && tablesLen > 4 && n > 2) {
    stream.assign(tables, tables + tablesLen - 2);
    stream.insert(stream.end(), in + 2, in + n);
  } else {
    stream.assign(in, in + n);
  }
  int x = 0, y = 0, comp = 0;
  unsigned char* pixels = stbi_load_from_memory(stream.data(), int(stream.size()), &x, &y, &comp, channels);
  if (!pixels) return false;
  out->assign(size_t(w) * h * channels, 0);
  // A JPEG strip may be shorter than the chunk (the image's last rows).
  const uint32_t rows = std::min<uint32_t>(h, uint32_t(y));
  const uint32_t cols = std::min<uint32_t>(w, uint32_t(x));
  for (uint32_t r = 0; r < rows; ++r)
    std::memcpy(out->data() + size_t(r) * w * channels, pixels + size_t(r) * x * channels, size_t(cols) * channels);
  stbi_image_free(pixels);
  return true;
}

}  // namespace codecs
