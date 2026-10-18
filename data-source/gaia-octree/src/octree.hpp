// The 3D layer: a magnitude-sorted heliocentric octree after Sagrista et al.
// 2019 (IEEE TVCG 25(1), 1099): every star sorted by absolute G; the root
// keeps the brightest kPerNode, and the rest go, brightest first, to the eight
// children of the cube they lie in, each of which does the same; a node at
// level 21 keeps all it is given. So a node's faintest star is brighter than
// (or as bright as) the brightest of any descendant, every star is in
// exactly one node, and a node and its ancestors hold every star in its cube
// down to its faintest. Axes ICRS, origin the Sun, parsecs; the root is the
// smallest power-of-two cube that holds every star.
#pragma once
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

namespace gaia_octree::octree {

constexpr uint32_t kPerNode = 4096;
constexpr int kMaxLevel = 21;

// 48 bytes a star: ten million stars are about 480 MB of linear memory.
// Positions are float32 pc (rounding 6e-8 of the distance, far inside any
// distance's uncertainty); G, BP and RP are millimagnitudes.
struct OctStar {
  uint64_t gaia;
  float x, y, z;       // heliocentric ICRS, pc, at J2016.0
  float absMag;        // M_G, set once the extinction table exists
  float d, lo, hi;     // distance and its interval, pc
  uint32_t hip;
  int16_t g, bp, rp;   // mmag; -32768 unknown
  uint16_t bits;       // SKTPoint3D FLAGS (low byte) | strDistanceEstimator << 8
  static int16_t mmag(double m) { return std::isfinite(m) && std::fabs(m) < 32.7 ? int16_t(std::lround(m * 1000)) : int16_t(-32768); }
  static double mag(int16_t v) { return v == -32768 ? NAN : v / 1000.0; }
  uint16_t flags() const { return bits & 0xFF; }
  uint8_t method() const { return uint8_t(bits >> 8); }
};
static_assert(sizeof(OctStar) == 48, "OctStar is 48 bytes");

// One contiguous array, reserved once for the whole sky before anything else
// is allocated (no growth copies, no holes between blocks), and sorted in
// place by the build: the tree needs no index arrays beside it.
class Store {
 public:
  void reserve(size_t n) { v_.reserve(n); }
  void push(const OctStar& s) { v_.push_back(s); }
  size_t size() const { return v_.size(); }
  OctStar& operator[](size_t i) { return v_[i]; }
  OctStar* data() { return v_.data(); }

 private:
  std::vector<OctStar> v_;
};

struct Node {
  uint8_t level;
  uint64_t key;
  double cx, cy, cz, half;
  uint32_t begin, end;  // the stars it is given, stars[begin, end), brightest first
};

struct Result {
  size_t nodes = 0, stars = 0;
  int depth = 0;
  double maxFloatError = 0;  // max |float32(offset) - offset| / node edge
  std::string error;
};

// Brightest first; ties by source id, then HIP, so the tree is the same every run.
inline bool brighter(const OctStar& a, const OctStar& b) {
  if (a.absMag != b.absMag) return a.absMag < b.absMag;
  return a.gaia != b.gaia ? a.gaia < b.gaia : a.hip < b.hip;
}

// Builds the tree over `stars` and hands each node, parents before children,
// to emit(node, keptCount, childMask): stars[node.begin, node.begin + kept)
// are its stars, brightest first. The stars a node passes on are sorted in
// place by (octant, brightness), which is the children's order.
template <class Emit>
Result build(Store& stars, Emit&& emit) {
  Result res;
  const size_t n = stars.size();
  OctStar* all = stars.data();
  double extent = 1;
  for (size_t i = 0; i < n; ++i)
    extent = std::max({extent, std::fabs(double(all[i].x)), std::fabs(double(all[i].y)), std::fabs(double(all[i].z))});
  std::sort(all, all + n, brighter);
  double half = 1;
  while (half < extent) half *= 2;
  std::vector<Node> stack{{0, 0, 0, 0, 0, half, 0, uint32_t(n)}};
  while (!stack.empty()) {
    const Node node = stack.back();
    stack.pop_back();
    const uint32_t given = node.end - node.begin;
    const uint32_t kept = node.level >= kMaxLevel ? given : std::min(given, kPerNode);
    const uint32_t rest = node.begin + kept;
    const auto octant = [&](const OctStar& s) { return (s.x >= node.cx ? 1 : 0) | (s.y >= node.cy ? 2 : 0) | (s.z >= node.cz ? 4 : 0); };
    std::sort(all + rest, all + node.end, [&](const OctStar& a, const OctStar& b) {
      const int oa = octant(a), ob = octant(b);
      return oa != ob ? oa < ob : brighter(a, b);
    });
    uint32_t counts[8] = {0};
    for (uint32_t i = rest; i < node.end; ++i) ++counts[octant(all[i])];
    uint32_t starts[8], at = rest;
    uint8_t mask = 0;
    for (int c = 0; c < 8; ++c) { starts[c] = at; at += counts[c]; if (counts[c]) mask |= uint8_t(1u << c); }
    for (uint32_t i = node.begin; i < rest; ++i) {
      const OctStar& s = all[i];
      const double edge = 2 * node.half;
      for (const double off : {s.x - node.cx, s.y - node.cy, s.z - node.cz})
        res.maxFloatError = std::max(res.maxFloatError, std::fabs(double(float(off)) - off) / edge);
    }
    const std::string why = emit(node, kept, mask);
    if (!why.empty()) { res.error = why; return res; }
    ++res.nodes;
    res.stars += kept;
    res.depth = std::max(res.depth, int(node.level));
    const double h = node.half / 2;
    for (int c = 7; c >= 0; --c) {
      if (!counts[c]) continue;
      stack.push_back({uint8_t(node.level + 1), node.key * 8 + uint64_t(c), node.cx + (c & 1 ? h : -h), node.cy + (c & 2 ? h : -h),
                       node.cz + (c & 4 ? h : -h), h, starts[c], starts[c] + counts[c]});
    }
  }
  return res;
}

}  // namespace gaia_octree::octree
