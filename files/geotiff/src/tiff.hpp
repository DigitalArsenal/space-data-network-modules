#pragma once
// TIFF / BigTIFF structure over a sparse byte source: the file's byte ranges
// the caller has (a COG's header, then the tiles a window needs). A read that
// falls outside them records the range in `need` and fails, so the caller
// fetches exactly what is missing and calls again.

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace tiff {

struct Sparse {
  struct Range {
    uint64_t off = 0;
    const uint8_t* data = nullptr;
    uint64_t len = 0;
  };
  std::vector<Range> ranges;
  std::vector<std::pair<uint64_t, uint64_t>> need;
  std::vector<std::vector<uint8_t>> spans;  // reads assembled across abutting ranges

  const Range* at(uint64_t off) const {
    for (const Range& r : ranges)
      if (off >= r.off && off < r.off + r.len) return &r;
    return nullptr;
  }

  // A pointer to [off, off + len), or nullptr (and the range noted as needed).
  const uint8_t* view(uint64_t off, uint64_t len) {
    static const uint8_t empty = 0;
    if (len == 0) return &empty;
    if (len > (uint64_t(1) << 31)) return nullptr;
    for (const Range& r : ranges)
      if (off >= r.off && off + len <= r.off + r.len) return r.data + (off - r.off);
    std::vector<uint8_t> buf(static_cast<size_t>(len));
    for (uint64_t pos = off; pos < off + len;) {
      const Range* hit = at(pos);
      if (!hit) {
        need.emplace_back(off, len);
        return nullptr;
      }
      const uint64_t n = std::min(off + len, hit->off + hit->len) - pos;
      std::memcpy(buf.data() + (pos - off), hit->data + (pos - hit->off), size_t(n));
      pos += n;
    }
    spans.push_back(std::move(buf));
    return spans.back().data();
  }
};

enum Type : uint16_t { BYTE = 1, ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5, SBYTE = 6, UNDEFINED = 7, SSHORT = 8, SLONG = 9, SRATIONAL = 10, FLOAT = 11, DOUBLE = 12, IFD = 13, LONG8 = 16, SLONG8 = 17, IFD8 = 18 };

inline size_t typeSize(uint16_t t) {
  switch (t) {
    case BYTE: case ASCII: case SBYTE: case UNDEFINED: return 1;
    case SHORT: case SSHORT: return 2;
    case LONG: case SLONG: case FLOAT: case IFD: return 4;
    case RATIONAL: case SRATIONAL: case DOUBLE: case LONG8: case SLONG8: case IFD8: return 8;
    default: return 0;
  }
}

struct Tag {
  uint16_t type = 0;
  uint64_t count = 0;
  uint64_t offset = 0;  // where the values are (inline values: the entry's own value field)
};

struct File {
  Sparse* src = nullptr;
  bool be = false;
  bool big = false;
  std::vector<std::map<uint16_t, Tag>> ifds;
  std::string error;  // a refusal (not a missing range)

  uint16_t u16(const uint8_t* p) const { return be ? uint16_t(p[0] << 8 | p[1]) : uint16_t(p[1] << 8 | p[0]); }
  uint32_t u32(const uint8_t* p) const {
    return be ? (uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16 | uint32_t(p[2]) << 8 | p[3])
              : (uint32_t(p[3]) << 24 | uint32_t(p[2]) << 16 | uint32_t(p[1]) << 8 | p[0]);
  }
  uint64_t u64(const uint8_t* p) const {
    return be ? (uint64_t(u32(p)) << 32 | u32(p + 4)) : (uint64_t(u32(p + 4)) << 32 | u32(p));
  }

  // Header and the IFD chain. false: refused (error set) or bytes missing (src->need).
  bool open() {
    const uint8_t* h = src->view(0, 16);
    if (!h) {
      if (src->at(0) && src->at(0)->len >= 8) {
        src->need.clear();
        h = src->view(0, 8);
      }
      if (!h) return false;
    }
    if (h[0] == 'I' && h[1] == 'I') be = false;
    else if (h[0] == 'M' && h[1] == 'M') be = true;
    else return fail("not a TIFF file");
    const uint16_t magic = u16(h + 2);
    uint64_t next = 0;
    if (magic == 42) next = u32(h + 4);
    else if (magic == 43) {
      if (!src->view(0, 16)) return false;
      h = src->view(0, 16);
      if (u16(h + 4) != 8) return fail("malformed BigTIFF header");
      big = true;
      next = u64(h + 8);
    } else return fail("not a TIFF file");
    while (next && ifds.size() < 64) {
      const uint8_t* c = src->view(next, big ? 8 : 2);
      if (!c) return false;
      const uint64_t n = big ? u64(c) : u16(c);
      if (n == 0 || n > 4096) return fail("malformed TIFF directory");
      const size_t entry = big ? 20 : 12;
      const uint64_t start = next + (big ? 8 : 2);
      const uint8_t* e = src->view(start, n * entry + (big ? 8 : 4));
      if (!e) return false;
      std::map<uint16_t, Tag> tags;
      for (uint64_t i = 0; i < n; ++i) {
        const uint8_t* p = e + i * entry;
        Tag t;
        const uint16_t id = u16(p);
        t.type = u16(p + 2);
        t.count = big ? u64(p + 4) : u32(p + 4);
        const size_t field = big ? 8 : 4;
        const uint64_t bytes = typeSize(t.type) * t.count;
        const uint64_t valueAt = start + i * entry + (big ? 12 : 8);
        t.offset = bytes <= field ? valueAt : (big ? u64(p + 12) : u32(p + 8));
        if (typeSize(t.type)) tags[id] = t;
      }
      ifds.push_back(std::move(tags));
      const uint8_t* q = e + n * entry;
      next = big ? u64(q) : u32(q);
    }
    if (ifds.empty()) return fail("the TIFF file has no image");
    return true;
  }

  bool fail(const char* message) {
    error = message;
    return false;
  }

  const Tag* tag(size_t ifd, uint16_t id) const {
    auto it = ifds[ifd].find(id);
    return it == ifds[ifd].end() ? nullptr : &it->second;
  }

  // Every value of a tag as integers (or doubles). false: absent or missing bytes.
  bool uints(size_t ifd, uint16_t id, std::vector<uint64_t>* out) {
    const Tag* t = tag(ifd, id);
    if (!t) return false;
    const size_t s = typeSize(t->type);
    const uint8_t* p = src->view(t->offset, s * t->count);
    if (!p) return false;
    out->resize(size_t(t->count));
    for (uint64_t i = 0; i < t->count; ++i) {
      const uint8_t* v = p + i * s;
      switch (t->type) {
        case BYTE: case UNDEFINED: case ASCII: (*out)[i] = v[0]; break;
        case SHORT: (*out)[i] = u16(v); break;
        case LONG: case IFD: (*out)[i] = u32(v); break;
        case LONG8: case IFD8: (*out)[i] = u64(v); break;
        default: return false;
      }
    }
    return true;
  }

  uint64_t uint(size_t ifd, uint16_t id, uint64_t fallback) {
    std::vector<uint64_t> v;
    return uints(ifd, id, &v) && !v.empty() ? v[0] : fallback;
  }

  bool doubles(size_t ifd, uint16_t id, std::vector<double>* out) {
    const Tag* t = tag(ifd, id);
    if (!t) return false;
    const size_t s = typeSize(t->type);
    const uint8_t* p = src->view(t->offset, s * t->count);
    if (!p) return false;
    out->resize(size_t(t->count));
    for (uint64_t i = 0; i < t->count; ++i) {
      const uint8_t* v = p + i * s;
      if (t->type == DOUBLE) {
        const uint64_t bits = u64(v);
        std::memcpy(&(*out)[i], &bits, 8);
      } else if (t->type == FLOAT) {
        const uint32_t bits = u32(v);
        float f;
        std::memcpy(&f, &bits, 4);
        (*out)[i] = f;
      } else if (t->type == SHORT) (*out)[i] = u16(v);
      else if (t->type == LONG) (*out)[i] = u32(v);
      else if (t->type == RATIONAL) (*out)[i] = u32(v + 4) ? double(u32(v)) / u32(v + 4) : 0.0;
      else return false;
    }
    return true;
  }

  bool bytes(size_t ifd, uint16_t id, const uint8_t** data, size_t* size) {
    const Tag* t = tag(ifd, id);
    if (!t) return false;
    *size = size_t(typeSize(t->type) * t->count);
    *data = src->view(t->offset, *size);
    return *data != nullptr;
  }
};

}  // namespace tiff
