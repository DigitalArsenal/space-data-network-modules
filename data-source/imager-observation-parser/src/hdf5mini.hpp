// Vendored from DigitalArsenal/Cesium_Weather orbpro-gaussian-clouds/native/hdf5mini/hdf5mini.hpp (commit 6c672cc); checked there against h5py and the
// reference producer (tools/raw_satellite.py). Edit there and re-vendor.
// hdf5mini: the part of HDF5 a satellite producer's NetCDF4 files need, read from bytes in memory - no library, no
// exceptions, no allocation beyond std::vector/std::string. The world-clouds retriever's parser node (spacedatanetwork-
// stack modules, world-clouds-modules-program-20261007) reads geostationary imager L1b/L2 files with it: chunked 2-D
// integer datasets (gzip + shuffle), their scale/offset/fill attributes, found by path.
//
// Covered: superblock versions 0-3; object header versions 1 and 2 (with continuation blocks); old-style groups
// (symbol table: B-tree v1 + local heap) and new-style compact groups (link messages); dataspace; fixed-point and
// floating-point datatypes; attribute messages versions 1-3, compact or dense; dense groups and attributes (fractal heap
// with direct and indirect blocks, version 2 B-tree name index); data layout versions 3 and 4 (contiguous,
// compact, chunked with a version 1 B-tree, single chunk or fixed array index); filter pipeline versions 1 and 2 with
// deflate (1) and shuffle (2); fill values. Anything else is reported as unsupported - never guessed.
//
// Inflate is supplied by the caller (zlib natively, the vendored miniz in the WASM module):
//   bool inflate(const uint8_t* in, size_t n, uint8_t* out, size_t outSize)  - zlib-wrapped stream, exact output size.
#pragma once
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

namespace hdf5mini {

using Inflate = std::function<bool(const uint8_t*, size_t, uint8_t*, size_t)>;

struct Datatype { int cls = -1; size_t size = 0; bool bigEndian = false, isSigned = false; };   // cls 0 fixed point, 1 float
struct Filter { int id = 0; std::vector<uint32_t> values; };
struct Attribute { std::string name; Datatype type; std::vector<uint64_t> dims; std::vector<uint8_t> data; };
struct Dataset {
  std::string path; Datatype type; std::vector<uint64_t> dims;
  int layout = -1;                      // 0 compact, 1 contiguous, 2 chunked
  int layoutVersion = 0, chunkIndex = 0; // chunkIndex (layout v4): 1 single, 2 implicit, 3 fixed array, 4 extensible, 5 btree2; v3: 0 (btree1)
  uint64_t address = UINT64_MAX, size = 0; // contiguous: data; chunked: index; single chunk: the chunk (size: its filtered size)
  uint32_t singleFilterMask = 0;
  std::vector<uint64_t> chunk;          // chunk dims (without the element-size dim)
  std::vector<uint8_t> compact;
  std::vector<uint8_t> fill;            // the fill value (datatype byte order): what never-written storage reads as
  std::vector<Filter> filters;
  std::vector<Attribute> attributes;
};

class File {
 public:
  File(const uint8_t* bytes, size_t n) : b_(bytes), n_(n) {}
  bool open();                                              // reads the superblock and walks every group
  const std::vector<Dataset>& datasets() const { return datasets_; }
  const Dataset* find(const std::string& path) const { for (auto& d : datasets_) if (d.path == path) return &d; return nullptr; }
  // A dataset's elements in its own type and byte order converted to little-endian (row-major, dims product x size).
  bool read(const Dataset& d, const Inflate& inflate, std::vector<uint8_t>& out);
  // visit(chunk offsets, chunk dims, elements): each stored chunk decoded, in row-major order; false from visit stops
  using ChunkVisitor = std::function<bool(const std::vector<uint64_t>&, const std::vector<uint64_t>&, const uint8_t*)>;
  bool forEachChunk(const Dataset& d, const Inflate& inflate, const ChunkVisitor& visit);
  const std::string& error() const { return err_; }
  std::string dump() const;                                // human-readable structure (tests, diagnostics)
  // a numeric attribute as double (first element), or the fallback
  static double attrNumber(const Dataset& d, const std::string& name, double fallback, bool* found = nullptr);
  static std::string attrString(const Dataset& d, const std::string& name);
  // a numeric attribute's elements as doubles (empty when absent or not numeric)
  static std::vector<double> attrNumbers(const Dataset& d, const std::string& name);

 private:
  const uint8_t* b_; size_t n_;
  int sbVersion_ = -1, offSize_ = 8, lenSize_ = 8; uint64_t base_ = 0;
  std::vector<Dataset> datasets_; std::string err_; std::string log_;
  std::vector<uint64_t> visited_;

  bool fail(const std::string& m) { if (err_.empty()) err_ = m; return false; }
  bool in(uint64_t at, uint64_t len) const { return at <= n_ && len <= n_ - at; }
  uint64_t u(uint64_t at, int bytes) const { uint64_t v = 0; for (int i = 0; i < bytes; i++) v |= uint64_t(b_[at + i]) << (8 * i); return v; }
  uint64_t addr(uint64_t at) const { uint64_t v = u(at, offSize_); return v == (offSize_ == 8 ? UINT64_MAX : (uint64_t(1) << (8 * offSize_)) - 1) ? UINT64_MAX : v + base_; }
  bool undefined(uint64_t a) const { return a == UINT64_MAX; }

  struct Message { int type; uint64_t at, size; };
  bool objectMessages(uint64_t at, std::vector<Message>& out);
  struct Heap { int idLen = 0, flags = 0, width = 0, maxHeapBits = 0, rootRows = 0, offBytes = 0, lenBytes = 0, maxDirectRows = 0; uint64_t maxManaged = 0, startBlock = 0, maxDirect = 0, root = UINT64_MAX; };
  bool walkGroup(uint64_t headerAt, const std::string& path);
  bool linkAt(uint64_t at, const std::string& path);
  bool readHeap(uint64_t at, Heap& h);
  bool heapObject(const Heap& h, uint64_t idAt, uint64_t& at, uint64_t& len);
  bool btree2Records(uint64_t at, std::vector<uint64_t>& out, uint16_t& recSize);
  bool walkSymbolTable(uint64_t btreeAt, uint64_t heapAt, const std::string& path);
  bool objectAt(uint64_t headerAt, const std::string& path);
  bool parseDatatype(uint64_t at, uint64_t size, Datatype& t);
  bool parseDataspace(uint64_t at, uint64_t size, std::vector<uint64_t>& dims);
  bool parseLayout(uint64_t at, uint64_t size, Dataset& d);
  bool parseFilters(uint64_t at, uint64_t size, Dataset& d);
  bool parseAttribute(uint64_t at, uint64_t size, Attribute& a);
  bool chunkAddresses(const Dataset& d, std::vector<std::vector<uint64_t>>& offsets, std::vector<uint64_t>& addrs, std::vector<uint64_t>& sizes, std::vector<uint32_t>& masks);
  bool btree1Chunks(uint64_t at, size_t rank, std::vector<std::vector<uint64_t>>& offsets, std::vector<uint64_t>& addrs, std::vector<uint64_t>& sizes, std::vector<uint32_t>& masks, int depth);
  bool fixedArrayChunks(const Dataset& d, std::vector<std::vector<uint64_t>>& offsets, std::vector<uint64_t>& addrs, std::vector<uint64_t>& sizes, std::vector<uint32_t>& masks);
};

// ---------------------------------------------------------------------------------------------------------------------

inline bool File::open() {
  static const uint8_t sig[8] = {0x89, 'H', 'D', 'F', '\r', '\n', 0x1a, '\n'};
  uint64_t at = 0;
  for (;;) {   // the superblock is at 0, 512, 1024, ... (a user block may precede it)
    if (!in(at, 8)) return fail("no HDF5 signature");
    if (!memcmp(b_ + at, sig, 8)) break;
    at = at ? at * 2 : 512;
  }
  sbVersion_ = b_[at + 8];
  uint64_t rootHeader = UINT64_MAX;
  if (sbVersion_ == 0 || sbVersion_ == 1) {
    if (!in(at, 24)) return fail("short superblock");
    offSize_ = b_[at + 13]; lenSize_ = b_[at + 14];
    uint64_t p = at + 24 + (sbVersion_ == 1 ? 4 : 0);
    base_ = 0; base_ = u(p, offSize_); p += 4 * offSize_;           // base, free-space, end-of-file, driver
    p += offSize_;                                                  // root symbol table entry: link name offset
    rootHeader = addr(p); p += offSize_;
    int cache = int(u(p, 4)); p += 8;
    if (cache == 1) {                                               // scratch pad: the root group's B-tree and heap
      log_ += "root symbol table entry cached\n";
    }
  } else if (sbVersion_ == 2 || sbVersion_ == 3) {
    offSize_ = b_[at + 9]; lenSize_ = b_[at + 10];
    uint64_t p = at + 12;
    base_ = 0; base_ = u(p, offSize_); p += 3 * offSize_;           // base, extension, end of file
    rootHeader = addr(p);
  } else return fail("superblock version " + std::to_string(sbVersion_) + " unsupported");
  if (offSize_ < 2 || offSize_ > 8 || lenSize_ < 2 || lenSize_ > 8) return fail("odd offset/length sizes");
  if (undefined(rootHeader)) return fail("no root group");
  return walkGroup(rootHeader, "");
}

// Every message of an object header, continuation blocks followed.
inline bool File::objectMessages(uint64_t at, std::vector<Message>& out) {
  if (!in(at, 16)) return fail("object header out of range");
  std::vector<std::pair<uint64_t, uint64_t>> blocks;
  bool v2 = !memcmp(b_ + at, "OHDR", 4);
  int sizeBytes = 0; bool orders = false;
  if (v2) {
    int flags = b_[at + 5]; uint64_t p = at + 6;
    if (flags & 0x20) p += 16;
    if (flags & 0x10) p += 4;
    sizeBytes = 1 << (flags & 3); orders = flags & 0x04;
    uint64_t size = u(p, sizeBytes); p += sizeBytes;
    blocks.push_back({p, size});
  } else {
    if (b_[at] != 1) return fail("object header version " + std::to_string(b_[at]) + " unsupported");
    uint64_t size = u(at + 8, 4);
    blocks.push_back({at + 16, size});   // (the v1 prefix is 12 bytes, messages aligned to 8)
  }
  for (size_t bi = 0; bi < blocks.size(); bi++) {
    uint64_t p = blocks[bi].first, end = p + blocks[bi].second;
    if (v2 && bi > 0) { if (memcmp(b_ + p, "OCHK", 4)) return fail("bad continuation block"); p += 4; end -= 4; }
    if (!in(blocks[bi].first, blocks[bi].second)) return fail("object header block out of range");
    while (p + (v2 ? 4 : 8) <= end) {
      int type; uint64_t size;
      if (v2) {
        type = b_[p]; size = u(p + 1, 2); int mflags = b_[p + 3]; p += 4; if (orders) p += 2; (void)mflags;
        if (type == 0 && p + size > end) break;   // gap
      } else { type = int(u(p, 2)); size = u(p + 2, 2); p += 8; }
      if (p + size > end + (v2 ? 4 : 0)) return fail("message past its block");
      if (type == 0x10) blocks.push_back({addr(p), u(p + offSize_, lenSize_)});
      else out.push_back({type, p, size});
      p += size;
    }
  }
  return true;
}

inline bool File::walkGroup(uint64_t headerAt, const std::string& path) {
  for (auto v : visited_) if (v == headerAt) return true;
  visited_.push_back(headerAt);
  std::vector<Message> ms; if (!objectMessages(headerAt, ms)) return false;
  for (auto& m : ms) {
    if (m.type == 0x11) { if (!walkSymbolTable(addr(m.at), addr(m.at + offSize_), path)) return false; }
    else if (m.type == 0x06) { if (!linkAt(m.at, path)) return false; }   // link message (new-style compact group)
    else if (m.type == 0x02) {                                   // link info: dense storage when the heap is defined
      uint64_t p = m.at + 2 + ((b_[m.at + 1] & 1) ? 8 : 0), heapAt = addr(p), names = addr(p + offSize_);
      if (undefined(heapAt)) continue;
      Heap h; std::vector<uint64_t> recs; uint16_t recSize = 0;
      if (!readHeap(heapAt, h) || !btree2Records(names, recs, recSize)) return false;
      for (uint64_t r : recs) {                                  // name index records: hash (4), heap ID
        uint64_t at, len; if (!heapObject(h, r + 4, at, len)) return false;
        if (!linkAt(at, path)) return false;
      }
    }
  }
  return true;
}

inline bool File::linkAt(uint64_t p, const std::string& path) {
  int flags = b_[p + 1]; p += 2;
  int linkType = 0; if (flags & 0x08) linkType = b_[p++];
  if (flags & 0x04) p += 8;
  if (flags & 0x10) p += 1;
  int lb = 1 << (flags & 3); uint64_t len = u(p, lb); p += lb;
  if (!in(p, len)) return fail("link name out of range");
  std::string name(reinterpret_cast<const char*>(b_ + p), size_t(len)); p += len;
  if (linkType != 0) return true;                                // soft/external links: not followed
  return objectAt(addr(p), path + "/" + name);
}

// ---- fractal heap and version 2 B-tree (dense links and attributes) ----

inline int log2floor(uint64_t v) { int r = -1; while (v) { v >>= 1; r++; } return r; }

inline bool File::readHeap(uint64_t at, Heap& h) {
  if (!in(at, 64) || memcmp(b_ + at, "FRHP", 4)) return fail("bad fractal heap header");
  uint64_t p = at + 5;
  h.idLen = int(u(p, 2)); int filterLen = int(u(p + 2, 2)); h.flags = b_[p + 4]; h.maxManaged = u(p + 5, 4); p += 9;
  p += lenSize_ + offSize_ + lenSize_ + offSize_ + 4 * lenSize_ + 4 * lenSize_;   // huge id/tree, free space, managed counts, huge, tiny
  h.width = int(u(p, 2)); p += 2;
  h.startBlock = u(p, lenSize_); p += lenSize_; h.maxDirect = u(p, lenSize_); p += lenSize_;
  h.maxHeapBits = int(u(p, 2)); p += 2; p += 2;                  // starting rows of the root indirect block
  h.root = addr(p); p += offSize_; h.rootRows = int(u(p, 2));
  if (filterLen) return fail("filtered fractal heap unsupported");
  h.offBytes = (h.maxHeapBits + 7) / 8;
  h.lenBytes = std::min((log2floor(h.maxDirect) + 7) / 8, log2floor(h.maxManaged) / 8 + 1);
  h.maxDirectRows = log2floor(h.maxDirect) - log2floor(h.startBlock) + 2;
  if (h.width <= 0 || !h.startBlock || h.maxDirect < h.startBlock) return fail("odd fractal heap table");
  return true;
}

// The file position and length of the object a heap ID names (managed objects in their direct block, tiny objects in
// the ID itself; huge objects unsupported).
inline bool File::heapObject(const Heap& h, uint64_t idAt, uint64_t& at, uint64_t& len) {
  int kind = (b_[idAt] >> 4) & 3;
  if (kind == 2) { at = idAt + 1; len = (b_[idAt] & 0x0F) + 1; return true; }
  if (kind != 0) return fail("huge fractal heap objects unsupported");
  uint64_t off = u(idAt + 1, h.offBytes); len = u(idAt + 1 + h.offBytes, h.lenBytes);
  uint64_t block = h.root, blockOff = 0; int rows = h.rootRows;
  for (int depth = 0; rows > 0; depth++) {                       // down the indirect blocks to the direct block holding off
    if (depth > 16 || !in(block, 16) || memcmp(b_ + block, "FHIB", 4)) return fail("bad fractal heap indirect block");
    uint64_t entries = block + 5 + offSize_ + h.offBytes, acc = blockOff; bool found = false;
    int direct = std::min(rows, h.maxDirectRows);
    for (int r = 0; r < rows && !found; r++) {
      uint64_t size = r < 2 ? h.startBlock : h.startBlock << (r - 1), span = size * uint64_t(h.width);
      if (off >= acc + span) { acc += span; continue; }
      uint64_t c = (off - acc) / size, childOff = acc + c * size;
      if (r < h.maxDirectRows) { block = addr(entries + (uint64_t(r) * h.width + c) * offSize_); blockOff = childOff; rows = 0; }
      else {
        block = addr(entries + uint64_t(direct) * h.width * offSize_ + (uint64_t(r - h.maxDirectRows) * h.width + c) * offSize_);
        blockOff = childOff; rows = log2floor(size) - log2floor(h.startBlock * uint64_t(h.width)) + 1;
      }
      found = true;
    }
    if (!found) return fail("fractal heap offset past the heap");
  }
  if (undefined(block) || !in(block, 8) || memcmp(b_ + block, "FHDB", 4)) return fail("bad fractal heap direct block");
  at = block + (off - blockOff);
  if (!in(at, len)) return fail("fractal heap object out of range");
  return true;
}

// Every record of a version 2 B-tree, as file positions (each recSize bytes).
inline bool File::btree2Records(uint64_t at, std::vector<uint64_t>& out, uint16_t& recSize) {
  if (!in(at, 32) || memcmp(b_ + at, "BTHD", 4)) return fail("bad v2 B-tree header");
  uint32_t nodeSize = uint32_t(u(at + 6, 4)); recSize = uint16_t(u(at + 10, 2)); int depth = int(u(at + 12, 2));
  uint64_t root = addr(at + 16); uint64_t rootN = u(at + 16 + offSize_, 2);
  if (undefined(root)) return true;
  // the child pointers' field sizes, as the library derives them from the node size
  std::vector<uint64_t> maxN(depth + 1), cumN(depth + 1); std::vector<int> cumSize(depth + 1, 0);
  maxN[0] = (nodeSize - 10) / recSize; cumN[0] = maxN[0];
  const int nrecSize = log2floor(maxN[0]) / 8 + 1;
  for (int d = 1; d <= depth; d++) {
    uint64_t ptr = uint64_t(offSize_) + nrecSize + cumSize[d - 1];
    maxN[d] = (nodeSize - (10 + ptr)) / (recSize + ptr);
    cumN[d] = (maxN[d] + 1) * cumN[d - 1] + maxN[d];
    cumSize[d] = log2floor(cumN[d]) / 8 + 1;
  }
  std::function<bool(uint64_t, uint64_t, int)> node = [&](uint64_t a, uint64_t n, int d) -> bool {
    if (!in(a, 6 + n * recSize) || memcmp(b_ + a, d ? "BTIN" : "BTLF", 4)) return fail("bad v2 B-tree node");
    uint64_t p = a + 6;
    std::vector<uint64_t> recs; for (uint64_t i = 0; i < n; i++) recs.push_back(p + i * recSize);
    if (!d) { out.insert(out.end(), recs.begin(), recs.end()); return true; }
    p += n * recSize;
    for (uint64_t i = 0; i <= n; i++) {
      uint64_t child = addr(p); p += offSize_; uint64_t cn = u(p, nrecSize); p += nrecSize; if (d > 1) p += cumSize[d - 1];
      if (!node(child, cn, d - 1)) return false;
      if (i < n) out.push_back(recs[i]);
    }
    return true;
  };
  return node(root, rootN, depth);
}

inline bool File::objectAt(uint64_t headerAt, const std::string& path) {
  std::vector<Message> ms; if (!objectMessages(headerAt, ms)) return false;
  bool group = false; for (auto& m : ms) if (m.type == 0x11 || m.type == 0x06 || m.type == 0x02) group = true;
  bool hasLayout = false; for (auto& m : ms) if (m.type == 0x08) hasLayout = true;
  if (group && !hasLayout) return walkGroup(headerAt, path);
  if (!hasLayout) return true;                                   // a named datatype or the like
  Dataset d; d.path = path;
  for (auto& m : ms) {
    switch (m.type) {
      case 0x01: if (!parseDataspace(m.at, m.size, d.dims)) return false; break;
      case 0x03: if (!parseDatatype(m.at, m.size, d.type)) return false; break;
      case 0x08: if (!parseLayout(m.at, m.size, d)) return false; break;
      case 0x0B: if (!parseFilters(m.at, m.size, d)) return false; break;
      case 0x04: { uint64_t n = u(m.at, 4); if (n && n <= m.size - 4) d.fill.assign(b_ + m.at + 4, b_ + m.at + 4 + n); break; }   // fill value (old)
      case 0x05: {                                               // fill value: versions 1 and 2 (defined byte), 3 (flags)
        int version = b_[m.at]; uint64_t p = m.at; bool defined;
        if (version == 3) { defined = b_[m.at + 1] & 0x20; p += 2; } else { defined = b_[m.at + 3] == 1; p += 4; }
        if (!defined) break;
        uint64_t n = u(p, 4); if (n && n <= m.size - (p + 4 - m.at)) d.fill.assign(b_ + p + 4, b_ + p + 4 + n);
        break;
      }
      case 0x0C: { Attribute a; if (parseAttribute(m.at, m.size, a)) d.attributes.push_back(std::move(a)); else return false; break; }
      case 0x15: {                                               // attribute info: dense attributes when the heap is defined
        uint64_t p = m.at + 2 + ((b_[m.at + 1] & 1) ? 2 : 0), heapAt = addr(p), names = addr(p + offSize_);
        if (undefined(heapAt)) break;
        Heap h; std::vector<uint64_t> recs; uint16_t recSize = 0;
        if (!readHeap(heapAt, h) || !btree2Records(names, recs, recSize)) return false;
        for (uint64_t r : recs) {                                // name index records: heap ID (8), flags, order, hash
          uint64_t at, len; if (!heapObject(h, r, at, len)) return false;
          Attribute a; if (!parseAttribute(at, len, a)) return false; d.attributes.push_back(std::move(a));
        }
        break;
      }
      default: break;
    }
  }
  datasets_.push_back(std::move(d));
  return true;
}

// v1 B-tree of a symbol table (node type 0) with its local heap: each leaf is a symbol table node "SNOD".
inline bool File::walkSymbolTable(uint64_t btreeAt, uint64_t heapAt, const std::string& path) {
  if (!in(heapAt, 32) || memcmp(b_ + heapAt, "HEAP", 4)) return fail("bad local heap");
  uint64_t heapData = addr(heapAt + 8 + 2 * lenSize_);
  std::vector<uint64_t> stack{btreeAt};
  while (!stack.empty()) {
    uint64_t at = stack.back(); stack.pop_back();
    if (!in(at, 24) || memcmp(b_ + at, "TREE", 4)) return fail("bad group B-tree node");
    int level = b_[at + 5]; int entries = int(u(at + 6, 2)); uint64_t p = at + 8 + 2 * offSize_;
    p += lenSize_;                                               // key 0
    for (int i = 0; i < entries; i++) {
      uint64_t child = addr(p); p += offSize_; p += lenSize_;
      if (level > 0) { stack.push_back(child); continue; }
      if (!in(child, 8) || memcmp(b_ + child, "SNOD", 4)) return fail("bad symbol table node");
      int n = int(u(child + 6, 2)); uint64_t q = child + 8;
      for (int k = 0; k < n; k++) {
        uint64_t nameOff = u(q, offSize_), header = addr(q + offSize_);
        const char* name = reinterpret_cast<const char*>(b_ + heapData + nameOff);
        if (!objectAt(header, path + "/" + std::string(name))) return false;
        q += 2 * offSize_ + 8 + 16;
      }
    }
  }
  return true;
}

inline bool File::parseDataspace(uint64_t at, uint64_t size, std::vector<uint64_t>& dims) {
  int version = b_[at], rank = b_[at + 1];
  uint64_t p = at + (version == 1 ? 8 : 4);
  if (version == 2 && b_[at + 3] == 0) { dims.clear(); return true; }    // scalar
  for (int i = 0; i < rank; i++) { dims.push_back(u(p, lenSize_)); p += lenSize_; }
  (void)size; return true;
}

inline bool File::parseDatatype(uint64_t at, uint64_t size, Datatype& t) {
  int cv = b_[at]; t.cls = cv & 0x0F; int bits0 = b_[at + 1]; t.size = size_t(u(at + 4, 4));
  if (t.cls == 0) { t.bigEndian = bits0 & 1; t.isSigned = bits0 & 8; }
  else if (t.cls == 1) { t.bigEndian = bits0 & 1; t.isSigned = true; }
  (void)size; return true;
}

inline bool File::parseLayout(uint64_t at, uint64_t size, Dataset& d) {
  int version = b_[at]; d.layoutVersion = version;
  if (version < 3) return fail(d.path + ": data layout version " + std::to_string(version) + " unsupported");
  int cls = b_[at + 1]; d.layout = cls; uint64_t p = at + 2;
  if (cls == 0) { uint64_t n = u(p, 2); d.compact.assign(b_ + p + 2, b_ + p + 2 + n); return true; }
  if (cls == 1) { d.address = addr(p); d.size = u(p + offSize_, lenSize_); return true; }
  if (cls != 2) return fail(d.path + ": layout class " + std::to_string(cls) + " unsupported");
  if (version == 3) {
    int rank = b_[p++]; d.address = addr(p); p += offSize_;
    for (int i = 0; i < rank - 1; i++) d.chunk.push_back(u(p + 4 * i, 4));
    d.chunkIndex = 0; return true;
  }
  int flags = b_[p++]; int rank = b_[p++]; int encLen = b_[p++];
  for (int i = 0; i < rank - 1; i++) d.chunk.push_back(u(p + uint64_t(encLen) * i, encLen));
  p += uint64_t(encLen) * rank;
  d.chunkIndex = b_[p++];
  if (d.chunkIndex == 1) {                                       // single chunk: its filtered size and mask when filtered
    if (flags & 0x02) { d.size = u(p, lenSize_); p += lenSize_; d.singleFilterMask = uint32_t(u(p, 4)); p += 4; }
  } else if (d.chunkIndex == 3) p += 1;                          // fixed array: page bits
  else if (d.chunkIndex == 4) p += 5;
  else if (d.chunkIndex == 5) p += 6;
  d.address = addr(p);
  (void)size; return true;
}

inline bool File::parseFilters(uint64_t at, uint64_t size, Dataset& d) {
  int version = b_[at], n = b_[at + 1]; uint64_t p = at + (version == 1 ? 8 : 2);
  for (int i = 0; i < n; i++) {
    Filter f; f.id = int(u(p, 2)); p += 2;
    uint64_t nameLen = 0; if (version == 1 || f.id >= 256) { nameLen = u(p, 2); p += 2; }
    p += 2;                                                      // flags
    int nv = int(u(p, 2)); p += 2;
    if (version == 1) p += (nameLen + 7) & ~uint64_t(7); else p += nameLen;
    for (int k = 0; k < nv; k++) { f.values.push_back(uint32_t(u(p, 4))); p += 4; }
    if (version == 1 && (nv & 1)) p += 4;
    d.filters.push_back(f);
  }
  (void)size; return true;
}

inline bool File::parseAttribute(uint64_t at, uint64_t size, Attribute& a) {
  int version = b_[at]; uint64_t p = at + 2;
  uint64_t nameSize = u(p, 2), typeSize = u(p + 2, 2), spaceSize = u(p + 4, 2); p += 6;
  if (version == 3) p += 1;
  auto pad = [&](uint64_t v) { return version == 1 ? (v + 7) & ~uint64_t(7) : v; };
  a.name.assign(reinterpret_cast<const char*>(b_ + p), size_t(nameSize ? nameSize - 1 : 0)); p += pad(nameSize);
  if (!parseDatatype(p, typeSize, a.type)) return false; p += pad(typeSize);
  if (!parseDataspace(p, spaceSize, a.dims)) return false; p += pad(spaceSize);
  uint64_t count = 1; for (auto v : a.dims) count *= v;
  uint64_t bytes = count * a.type.size;
  if (!in(p, bytes) || p + bytes > at + size) bytes = (at + size > p) ? at + size - p : 0;
  a.data.assign(b_ + p, b_ + p + bytes);
  return true;
}

// ---- chunk indexes ----

inline bool File::btree1Chunks(uint64_t at, size_t rank, std::vector<std::vector<uint64_t>>& offsets, std::vector<uint64_t>& addrs, std::vector<uint64_t>& sizes, std::vector<uint32_t>& masks, int depth) {
  if (depth > 64) return fail("chunk B-tree too deep");
  if (!in(at, 24) || memcmp(b_ + at, "TREE", 4) || b_[at + 4] != 1) return fail("bad chunk B-tree node");
  int level = b_[at + 5]; int entries = int(u(at + 6, 2)); uint64_t p = at + 8 + 2 * offSize_;
  const uint64_t keySize = 8 + 8 * (rank + 1);
  for (int i = 0; i < entries; i++) {
    uint64_t key = p, child = addr(p + keySize);
    if (level > 0) { if (!btree1Chunks(child, rank, offsets, addrs, sizes, masks, depth + 1)) return false; }
    else {
      std::vector<uint64_t> off(rank); for (size_t k = 0; k < rank; k++) off[k] = u(key + 8 + 8 * k, 8);
      offsets.push_back(off); addrs.push_back(child); sizes.push_back(u(key, 4)); masks.push_back(uint32_t(u(key + 4, 4)));
    }
    p += keySize + offSize_;
  }
  return true;
}

// Fixed array index ("FAHD" header, "FADB" data block, unpaged): one entry per chunk in row-major chunk order.
inline bool File::fixedArrayChunks(const Dataset& d, std::vector<std::vector<uint64_t>>& offsets, std::vector<uint64_t>& addrs, std::vector<uint64_t>& sizes, std::vector<uint32_t>& masks) {
  uint64_t h = d.address;
  if (!in(h, 16) || memcmp(b_ + h, "FAHD", 4)) return fail(d.path + ": bad fixed array header");
  int clientId = b_[h + 5], entrySize = b_[h + 6], pageBits = b_[h + 7];
  uint64_t count = u(h + 8, lenSize_), block = addr(h + 8 + lenSize_);
  if (!in(block, 16) || memcmp(b_ + block, "FADB", 4)) return fail(d.path + ": bad fixed array data block");
  uint64_t pageElems = uint64_t(1) << pageBits;
  if (count > pageElems) return fail(d.path + ": paged fixed array unsupported");
  uint64_t p = block + 6 + offSize_;
  size_t rank = d.dims.size(); std::vector<uint64_t> per(rank); for (size_t k = 0; k < rank; k++) per[k] = (d.dims[k] + d.chunk[k] - 1) / d.chunk[k];
  for (uint64_t i = 0; i < count; i++) {
    std::vector<uint64_t> off(rank); uint64_t r = i;
    for (size_t k = rank; k-- > 0;) { off[k] = (r % per[k]) * d.chunk[k]; r /= per[k]; }
    if (clientId == 0) { offsets.push_back(off); addrs.push_back(addr(p)); sizes.push_back(0); masks.push_back(0); p += offSize_; }
    else {
      uint64_t a = addr(p); p += offSize_;
      int sizeBytes = entrySize - offSize_ - 4; uint64_t s = u(p, sizeBytes); p += sizeBytes; uint32_t m = uint32_t(u(p, 4)); p += 4;
      offsets.push_back(off); addrs.push_back(a); sizes.push_back(s); masks.push_back(m);
    }
  }
  return true;
}

inline bool File::chunkAddresses(const Dataset& d, std::vector<std::vector<uint64_t>>& offsets, std::vector<uint64_t>& addrs, std::vector<uint64_t>& sizes, std::vector<uint32_t>& masks) {
  if (d.layoutVersion == 3) return btree1Chunks(d.address, d.dims.size(), offsets, addrs, sizes, masks, 0);
  if (d.chunkIndex == 1) { offsets.push_back(std::vector<uint64_t>(d.dims.size(), 0)); addrs.push_back(d.address); sizes.push_back(d.size); masks.push_back(d.singleFilterMask); return true; }
  if (d.chunkIndex == 3) return fixedArrayChunks(d, offsets, addrs, sizes, masks);
  return fail(d.path + ": chunk index type " + std::to_string(d.chunkIndex) + " unsupported");
}

// Each stored chunk of a dataset decoded (filters undone, elements little-endian), in row-major order of the chunks'
// offsets (a contiguous or compact dataset: one chunk, the whole of it). A chunk at the dataset's edge carries its full
// chunk dims - the caller clips. Chunks never written are not visited (they hold the fill value).
inline bool File::forEachChunk(const Dataset& d, const Inflate& inflate, const ChunkVisitor& visit) {
  const size_t es = d.type.size, rank = d.dims.size();
  auto swap = [&](std::vector<uint8_t>& v) { if (!d.type.bigEndian || es == 1) return; for (size_t i = 0; i + es <= v.size(); i += es) for (size_t k = 0; k < es / 2; k++) std::swap(v[i + k], v[i + es - 1 - k]); };
  uint64_t count = 1; for (auto v : d.dims) count *= v;
  if (d.layout == 0 || d.layout == 1) {
    std::vector<uint8_t> all(size_t(count * es), 0);
    if (d.layout == 0) { if (d.compact.size() < all.size()) return fail(d.path + ": short compact data"); memcpy(all.data(), d.compact.data(), all.size()); }
    else if (!undefined(d.address)) { if (!in(d.address, all.size())) return fail(d.path + ": contiguous data out of range"); memcpy(all.data(), b_ + d.address, all.size()); }
    else if (d.fill.size() == es) for (size_t i = 0; i < all.size(); i += es) memcpy(all.data() + i, d.fill.data(), es);
    swap(all);
    return visit(std::vector<uint64_t>(rank, 0), d.dims, all.data());
  }
  std::vector<std::vector<uint64_t>> offs; std::vector<uint64_t> addrs, sizes; std::vector<uint32_t> masks;
  if (!chunkAddresses(d, offs, addrs, sizes, masks)) return false;
  std::vector<size_t> order(addrs.size()); for (size_t i = 0; i < order.size(); i++) order[i] = i;
  std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return offs[a] < offs[b]; });
  uint64_t chunkElems = 1; for (auto v : d.chunk) chunkElems *= v;
  const size_t chunkBytes = size_t(chunkElems * es);
  std::vector<uint8_t> raw(chunkBytes), stage, tmp;
  for (size_t c : order) {
    if (undefined(addrs[c])) continue;
    uint64_t stored = sizes[c] ? sizes[c] : (d.filters.empty() ? chunkBytes : 0);
    if (!stored) return fail(d.path + ": filtered chunk without a size");
    if (!in(addrs[c], stored)) return fail(d.path + ": chunk out of range");
    stage.assign(b_ + addrs[c], b_ + addrs[c] + stored);
    // the filter pipeline undone from the last filter back (a set mask bit: that filter was skipped)
    for (size_t f = d.filters.size(); f-- > 0;) {
      if (masks[c] & (1u << f)) continue;
      const Filter& fl = d.filters[f];
      if (fl.id == 1) { if (!inflate(stage.data(), stage.size(), raw.data(), chunkBytes)) return fail(d.path + ": inflate failed"); stage.assign(raw.begin(), raw.end()); }
      else if (fl.id == 2) {
        size_t n = stage.size() / es; tmp.resize(stage.size());
        for (size_t i = 0; i < n; i++) for (size_t k = 0; k < es; k++) tmp[i * es + k] = stage[k * n + i];
        stage.swap(tmp);
      } else if (fl.id == 3) { if (stage.size() >= 4) stage.resize(stage.size() - 4); }   // fletcher32: checksum dropped (not verified)
      else return fail(d.path + ": filter " + std::to_string(fl.id) + " unsupported");
    }
    if (stage.size() < chunkBytes) return fail(d.path + ": chunk shorter than its dims");
    swap(stage);
    if (!visit(offs[c], d.chunk, stage.data())) return true;
  }
  return true;
}

// A dataset's elements in its own type, little-endian, row-major (dims product x size); never-written storage: the fill.
inline bool File::read(const Dataset& d, const Inflate& inflate, std::vector<uint8_t>& out) {
  const size_t es = d.type.size, rank = d.dims.size();
  uint64_t count = 1; for (auto v : d.dims) count *= v;
  out.assign(size_t(count * es), 0);
  if (d.fill.size() == es) for (size_t i = 0; i < out.size(); i += es) memcpy(out.data() + i, d.fill.data(), es);
  if (rank == 0) return forEachChunk(d, inflate, [&](const std::vector<uint64_t>&, const std::vector<uint64_t>&, const uint8_t* data) { memcpy(out.data(), data, es); return true; });
  return forEachChunk(d, inflate, [&](const std::vector<uint64_t>& off, const std::vector<uint64_t>& dims, const uint8_t* data) {
    // the chunk into place, clipped at the dataset's edge
    const uint64_t rowLen = dims[rank - 1]; uint64_t elems = 1; for (auto v : dims) elems *= v;
    std::vector<uint64_t> idx(rank, 0);
    for (uint64_t r = 0; r < elems / rowLen; r++) {
      uint64_t rr = r; bool inside = true; uint64_t dst = 0;
      for (size_t k = rank - 1; k-- > 0;) { idx[k] = rr % dims[k]; rr /= dims[k]; }
      for (size_t k = 0; k + 1 < rank; k++) { uint64_t g = off[k] + idx[k]; if (g >= d.dims[k]) { inside = false; break; } dst = dst * d.dims[k] + g; }
      if (!inside) continue;
      const uint64_t col0 = off[rank - 1]; if (col0 >= d.dims[rank - 1]) continue;
      const uint64_t n = std::min<uint64_t>(rowLen, d.dims[rank - 1] - col0);
      dst = dst * d.dims[rank - 1] + col0;
      memcpy(out.data() + dst * es, data + r * rowLen * es, size_t(n * es));
    }
    return true;
  });
}

inline double File::attrNumber(const Dataset& d, const std::string& name, double fallback, bool* found) {
  if (found) *found = false;
  for (auto& a : d.attributes) {
    if (a.name != name || a.data.size() < a.type.size || !a.type.size) continue;
    std::vector<uint8_t> v(a.data.begin(), a.data.begin() + a.type.size);
    if (a.type.bigEndian) std::reverse(v.begin(), v.end());
    double x = 0;
    if (a.type.cls == 1 && a.type.size == 4) { float f; memcpy(&f, v.data(), 4); x = f; }
    else if (a.type.cls == 1 && a.type.size == 8) memcpy(&x, v.data(), 8);
    else if (a.type.cls == 0) {
      uint64_t raw = 0; for (size_t i = 0; i < a.type.size; i++) raw |= uint64_t(v[i]) << (8 * i);
      if (a.type.isSigned && a.type.size < 8 && (raw >> (8 * a.type.size - 1)) & 1) raw |= ~uint64_t(0) << (8 * a.type.size);
      x = a.type.isSigned ? double(int64_t(raw)) : double(raw);
    } else continue;
    if (found) *found = true;
    return x;
  }
  return fallback;
}

inline std::vector<double> File::attrNumbers(const Dataset& d, const std::string& name) {
  std::vector<double> out;
  for (auto& a : d.attributes) {
    if (a.name != name || !a.type.size || (a.type.cls != 0 && a.type.cls != 1)) continue;
    for (size_t at = 0; at + a.type.size <= a.data.size(); at += a.type.size) {
      std::vector<uint8_t> v(a.data.begin() + at, a.data.begin() + at + a.type.size);
      if (a.type.bigEndian) std::reverse(v.begin(), v.end());
      double x = 0;
      if (a.type.cls == 1 && a.type.size == 4) { float f; memcpy(&f, v.data(), 4); x = f; }
      else if (a.type.cls == 1 && a.type.size == 8) memcpy(&x, v.data(), 8);
      else if (a.type.cls == 0) {
        uint64_t raw = 0; for (size_t i = 0; i < a.type.size; i++) raw |= uint64_t(v[i]) << (8 * i);
        if (a.type.isSigned && a.type.size < 8 && (raw >> (8 * a.type.size - 1)) & 1) raw |= ~uint64_t(0) << (8 * a.type.size);
        x = a.type.isSigned ? double(int64_t(raw)) : double(raw);
      } else break;
      out.push_back(x);
    }
    break;
  }
  return out;
}

inline std::string File::attrString(const Dataset& d, const std::string& name) {
  for (auto& a : d.attributes) if (a.name == name && a.type.cls == 3) { std::string s(a.data.begin(), a.data.end()); while (!s.empty() && !s.back()) s.pop_back(); return s; }
  return "";
}

inline std::string File::dump() const {
  std::string s = "superblock v" + std::to_string(sbVersion_) + ", offsets " + std::to_string(offSize_) + ", lengths " + std::to_string(lenSize_) + "\n" + log_;
  for (auto& d : datasets_) {
    s += d.path + " [";
    for (size_t i = 0; i < d.dims.size(); i++) s += (i ? "x" : "") + std::to_string(d.dims[i]);
    s += "] class " + std::to_string(d.type.cls) + " size " + std::to_string(d.type.size) + (d.type.isSigned ? " signed" : "") + " layout " + std::to_string(d.layout) + " v" + std::to_string(d.layoutVersion) + " index " + std::to_string(d.chunkIndex);
    if (!d.chunk.empty()) { s += " chunk "; for (size_t i = 0; i < d.chunk.size(); i++) s += (i ? "x" : "") + std::to_string(d.chunk[i]); }
    s += " filters"; for (auto& f : d.filters) s += " " + std::to_string(f.id);
    s += " attrs " + std::to_string(d.attributes.size()) + "\n";
  }
  return s;
}

}  // namespace hdf5mini
