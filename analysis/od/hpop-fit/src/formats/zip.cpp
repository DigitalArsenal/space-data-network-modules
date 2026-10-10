// In-memory container readers: raw deflate (RFC 1951), gzip (RFC 1952) and zip
// (PKWARE APPNOTE) through the central directory. The inflater follows the
// canonical-Huffman scheme of zlib's contrib/puff.c (Mark Adler, zlib
// license), written fresh for this module. Nothing is written anywhere.
#include <cstring>

#include "formats_support.hpp"

namespace odhpop::formats::detail {
namespace {

uint32_t crc32_update(uint32_t crc, const uint8_t* p, std::size_t n) {
  static uint32_t table[256];
  static bool ready = false;
  if (!ready) {
    for (uint32_t i = 0; i < 256; ++i) {
      uint32_t c = i;
      for (int k = 0; k < 8; ++k) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
      table[i] = c;
    }
    ready = true;
  }
  crc = ~crc;
  for (std::size_t i = 0; i < n; ++i) crc = table[(crc ^ p[i]) & 0xFF] ^ (crc >> 8);
  return ~crc;
}

struct Huffman {
  uint16_t count[16];
  uint16_t symbol[320];
};

// >0 incomplete code, 0 complete, <0 over-subscribed.
int construct(Huffman* h, const uint16_t* length, int n) {
  std::memset(h->count, 0, sizeof h->count);
  for (int s = 0; s < n; ++s) ++h->count[length[s]];
  if (h->count[0] == n) return 0;
  int left = 1;
  for (int len = 1; len < 16; ++len) {
    left <<= 1;
    left -= h->count[len];
    if (left < 0) return left;
  }
  uint16_t offs[16];
  offs[1] = 0;
  for (int len = 1; len < 15; ++len) offs[len + 1] = static_cast<uint16_t>(offs[len] + h->count[len]);
  for (int s = 0; s < n; ++s)
    if (length[s] != 0) h->symbol[offs[length[s]]++] = static_cast<uint16_t>(s);
  return left;
}

class Inflater {
 public:
  Inflater(const uint8_t* in, std::size_t size, std::size_t limit, std::vector<uint8_t>* out)
      : in_(in), size_(size), limit_(limit), out_(out) {}

  std::string run() {
    int last;
    do {
      last = bits(1);
      if (!err_.empty()) return err_;
      const int type = bits(2);
      if (!err_.empty()) return err_;
      if (type == 0) stored();
      else if (type == 1) fixed();
      else if (type == 2) dynamic();
      else err_ = "reserved deflate block type";
      if (!err_.empty()) return err_;
    } while (!last);
    return {};
  }
  std::size_t consumed() const { return pos_; }

 private:
  const uint8_t* in_;
  std::size_t size_, limit_, pos_ = 0;
  std::vector<uint8_t>* out_;
  uint32_t buf_ = 0;
  int cnt_ = 0;
  std::string err_;

  int bits(int need) {
    uint32_t v = buf_;
    while (cnt_ < need) {
      if (pos_ >= size_) {
        if (err_.empty()) err_ = "truncated deflate stream";
        return 0;
      }
      v |= static_cast<uint32_t>(in_[pos_++]) << cnt_;
      cnt_ += 8;
    }
    buf_ = v >> need;
    cnt_ -= need;
    return static_cast<int>(v & ((1u << need) - 1));
  }

  int decode(const Huffman& h) {
    int code = 0, first = 0, index = 0;
    for (int len = 1; len < 16; ++len) {
      code |= bits(1);
      if (!err_.empty()) return -1;
      const int count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    err_ = "invalid Huffman code";
    return -1;
  }

  void stored() {
    buf_ = 0;
    cnt_ = 0;
    if (pos_ + 4 > size_) { err_ = "truncated stored block"; return; }
    const unsigned len = in_[pos_] | (in_[pos_ + 1] << 8);
    const unsigned nlen = in_[pos_ + 2] | (in_[pos_ + 3] << 8);
    pos_ += 4;
    if (len != (~nlen & 0xFFFF)) { err_ = "stored block length mismatch"; return; }
    if (pos_ + len > size_) { err_ = "truncated stored block"; return; }
    if (out_->size() + len > limit_) { err_ = "expansion limit exceeded"; return; }
    out_->insert(out_->end(), in_ + pos_, in_ + pos_ + len);
    pos_ += len;
  }

  void codes(const Huffman& lencode, const Huffman& distcode) {
    static const uint16_t lens[29] = {3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27,
                                      31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258};
    static const uint16_t lext[29] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2,
                                      2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
    static const uint16_t dists[30] = {1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129,
                                       193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
                                       8193, 12289, 16385, 24577};
    static const uint16_t dext[30] = {0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6,
                                      6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13};
    for (;;) {
      int sym = decode(lencode);
      if (sym < 0) return;
      if (sym < 256) {
        if (out_->size() + 1 > limit_) { err_ = "expansion limit exceeded"; return; }
        out_->push_back(static_cast<uint8_t>(sym));
      } else if (sym == 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) { err_ = "invalid length symbol"; return; }
        const int len = lens[sym] + bits(lext[sym]);
        const int ds = decode(distcode);
        if (ds < 0) return;
        if (ds >= 30) { err_ = "invalid distance symbol"; return; }
        const std::size_t dist = dists[ds] + static_cast<std::size_t>(bits(dext[ds]));
        if (!err_.empty()) return;
        if (dist > out_->size()) { err_ = "distance too far back"; return; }
        if (out_->size() + len > limit_) { err_ = "expansion limit exceeded"; return; }
        std::size_t from = out_->size() - dist;
        for (int i = 0; i < len; ++i) out_->push_back((*out_)[from + i]);
      }
    }
  }

  void fixed() {
    static Huffman lencode, distcode;
    static bool ready = false;
    if (!ready) {
      uint16_t l[288];
      int s = 0;
      for (; s < 144; ++s) l[s] = 8;
      for (; s < 256; ++s) l[s] = 9;
      for (; s < 280; ++s) l[s] = 7;
      for (; s < 288; ++s) l[s] = 8;
      construct(&lencode, l, 288);
      for (s = 0; s < 30; ++s) l[s] = 5;
      construct(&distcode, l, 30);
      ready = true;
    }
    codes(lencode, distcode);
  }

  void dynamic() {
    static const uint8_t order[19] = {16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15};
    uint16_t lengths[320];
    const int nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
    if (!err_.empty()) return;
    if (nlen > 286 || ndist > 30) { err_ = "too many length or distance codes"; return; }
    int index = 0;
    for (; index < ncode; ++index) lengths[order[index]] = static_cast<uint16_t>(bits(3));
    for (; index < 19; ++index) lengths[order[index]] = 0;
    Huffman lencode, distcode;
    if (construct(&lencode, lengths, 19) != 0) { err_ = "incomplete code-length code"; return; }
    index = 0;
    while (index < nlen + ndist) {
      int sym = decode(lencode);
      if (sym < 0) return;
      if (sym < 16) {
        lengths[index++] = static_cast<uint16_t>(sym);
      } else {
        int len = 0, rep;
        if (sym == 16) {
          if (index == 0) { err_ = "repeat with no previous length"; return; }
          len = lengths[index - 1];
          rep = 3 + bits(2);
        } else if (sym == 17) {
          rep = 3 + bits(3);
        } else {
          rep = 11 + bits(7);
        }
        if (!err_.empty()) return;
        if (index + rep > nlen + ndist) { err_ = "too many code lengths"; return; }
        while (rep--) lengths[index++] = static_cast<uint16_t>(len);
      }
    }
    if (lengths[256] == 0) { err_ = "missing end-of-block code"; return; }
    int e = construct(&lencode, lengths, nlen);
    if (e < 0 || (e > 0 && nlen - lencode.count[0] != 1)) { err_ = "bad literal/length code"; return; }
    e = construct(&distcode, lengths + nlen, ndist);
    if (e < 0 || (e > 0 && ndist - distcode.count[0] != 1)) { err_ = "bad distance code"; return; }
    codes(lencode, distcode);
  }
};

uint32_t le32(const uint8_t* p) {
  return p[0] | (p[1] << 8) | (p[2] << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
uint16_t le16(const uint8_t* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }

}  // namespace

std::string inflate_raw(const uint8_t* in, std::size_t size, std::size_t limit,
                        std::vector<uint8_t>* out, std::size_t* consumed) {
  Inflater inflater(in, size, limit, out);
  std::string e = inflater.run();
  if (consumed) *consumed = inflater.consumed();
  return e;
}

std::string gunzip(const uint8_t* in, std::size_t size, std::size_t limit, std::vector<uint8_t>* out) {
  if (size < 18 || in[0] != 0x1f || in[1] != 0x8b || in[2] != 8) return "not a gzip deflate member";
  const unsigned flg = in[3];
  std::size_t pos = 10;
  if (flg & 4) {
    if (pos + 2 > size) return "truncated gzip header";
    pos += 2 + le16(in + pos);
  }
  for (unsigned bit : {8u, 16u}) {
    if (!(flg & bit)) continue;
    while (pos < size && in[pos] != 0) ++pos;
    ++pos;
  }
  if (flg & 2) pos += 2;
  if (pos + 8 > size) return "truncated gzip header";
  std::size_t used = 0;
  std::string e = inflate_raw(in + pos, size - pos, limit, out, &used);
  if (!e.empty()) return e;
  pos += used;
  if (pos + 8 > size) return "truncated gzip trailer";
  if (le32(in + pos) != crc32_update(0, out->data(), out->size())) return "gzip CRC-32 mismatch";
  if (le32(in + pos + 4) != static_cast<uint32_t>(out->size())) return "gzip length mismatch";
  return {};
}

std::string unzip(const uint8_t* bytes, std::size_t size, std::size_t limit,
                  std::vector<ZipMember>* members) {
  if (size < 22) return "not a zip archive";
  std::size_t eocd = std::string::npos;
  const std::size_t lowest = size > 22 + 65535 ? size - 22 - 65535 : 0;
  for (std::size_t i = size - 22 + 1; i-- > lowest;)
    if (le32(bytes + i) == 0x06054b50u) { eocd = i; break; }
  if (eocd == std::string::npos) return "zip end-of-central-directory record not found";
  const unsigned entries = le16(bytes + eocd + 10);
  const uint32_t cd_offset = le32(bytes + eocd + 16);
  if (entries == 0xFFFFu || cd_offset == 0xFFFFFFFFu) return "zip64 archives are not supported";
  std::size_t p = cd_offset, total = 0;
  for (unsigned n = 0; n < entries; ++n) {
    if (p + 46 > size || le32(bytes + p) != 0x02014b50u) return "bad zip central directory";
    const unsigned flags = le16(bytes + p + 8), method = le16(bytes + p + 10);
    const uint32_t crc = le32(bytes + p + 16), csize = le32(bytes + p + 20), usize = le32(bytes + p + 24);
    const std::size_t nlen = le16(bytes + p + 28), elen = le16(bytes + p + 30), clen = le16(bytes + p + 32);
    const std::size_t local = le32(bytes + p + 42);
    if (p + 46 + nlen > size) return "bad zip central directory";
    std::string name(reinterpret_cast<const char*>(bytes + p + 46), nlen);
    p += 46 + nlen + elen + clen;
    if (!name.empty() && name.back() == '/') continue;
    if (flags & 1) return "encrypted zip members are not supported";
    if (csize == 0xFFFFFFFFu || usize == 0xFFFFFFFFu || local == 0xFFFFFFFFu) return "zip64 archives are not supported";
    if (local + 30 > size || le32(bytes + local) != 0x04034b50u) return "bad zip local header";
    const std::size_t data = local + 30 + le16(bytes + local + 26) + le16(bytes + local + 28);
    if (data + csize > size) return "truncated zip member";
    total += usize;
    if (total > limit) return "zip exceeds the in-memory expansion limit";
    ZipMember m;
    m.name = name;
    if (method == 0) {
      if (csize != usize) return "stored zip member size mismatch";
      m.data.assign(bytes + data, bytes + data + csize);
    } else if (method == 8) {
      m.data.reserve(usize);
      const std::string e = inflate_raw(bytes + data, csize, usize, &m.data);
      if (!e.empty()) return "member " + name + ": " + e;
    } else {
      return "member " + name + ": unsupported zip method " + std::to_string(method);
    }
    if (m.data.size() != usize) return "member " + name + ": size mismatch";
    if (crc32_update(0, m.data.data(), m.data.size()) != crc) return "member " + name + ": CRC-32 mismatch";
    members->push_back(std::move(m));
  }
  return {};
}

}  // namespace odhpop::formats::detail
