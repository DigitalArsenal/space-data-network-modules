// propagator/sgp4-xp: the US Space Force SGP4 and SGP4-XP, reached through its exports.
//
// The Space Force library reads two-line element text and nothing else (Astro Standards v9.1, Sgp4Prop WebAssembly
// 9.1.1.0, XP build): a satellite is added from the two lines, initialised, propagated to minutes since its epoch and
// removed. build.mjs joins the library, as released, to this module (see shim.wat), so these functions are imports that
// resolve inside the artifact; none reaches the host. The library's exports have minified names; each is named here
// by the function it is.
//
//   ussf.k  __wasm_call_ctors          ussf.s  malloc                    ussf.q  free
//   ussf.t  TleAddSatFrLines_wasm      ussf.u  Sgp4InitSats_wasm         ussf.v  Sgp4RemoveSats_wasm
//   ussf.A  Sgp4PropPosVel_wasm        ussf.E  TleRemoveSats_wasm        ussf.F  SetLogLevel_wasm
//
// Errors are return values, never exceptions: WasmEdge's interpreter loops in free() on a thrown C++ exception.
#pragma once

#include <algorithm>

#include "types.hpp"

// XP satellites between two restorations of the library's memory (build.mjs may override it for experiments).
#ifndef SGP4XP_RECYCLE_AFTER
#define SGP4XP_RECYCLE_AFTER 256
#endif

#define SGP4XP_USSF_IMPORT(name) __attribute__((import_module("ussf"), import_name(name)))

extern "C" {
SGP4XP_USSF_IMPORT("k") void ussf_start(void);
SGP4XP_USSF_IMPORT("s") uint32_t ussf_malloc(uint32_t bytes);
SGP4XP_USSF_IMPORT("q") void ussf_free(uint32_t pointer);
SGP4XP_USSF_IMPORT("t") int64_t ussf_tle_add(uint32_t line1, uint32_t line2);
SGP4XP_USSF_IMPORT("u") int32_t ussf_sgp4_init(uint32_t satKeys, int32_t count, uint32_t errorSatKey);
SGP4XP_USSF_IMPORT("v") int32_t ussf_sgp4_remove(uint32_t satKeys, int32_t count, uint32_t errorSatKey);
SGP4XP_USSF_IMPORT("A") int32_t ussf_propagate(uint32_t satKeys, int32_t count, double startMinutes, int32_t perSat,
                                               double stepMinutes, uint32_t result);
SGP4XP_USSF_IMPORT("E") int32_t ussf_tle_remove(uint32_t satKeys, int32_t count, uint32_t errorSatKey);
SGP4XP_USSF_IMPORT("F") int32_t ussf_log_level(int32_t level);
// shim.wat: copies between this module's memory and the library's.
__attribute__((import_module("a"), import_name("put"))) void ussf_put(uint32_t into, const void* from, uint32_t bytes);
__attribute__((import_module("a"), import_name("get"))) void ussf_get(void* into, uint32_t from, uint32_t bytes);
__attribute__((import_module("a"), import_name("pages"))) uint32_t ussf_pages(void);
__attribute__((import_module("a"), import_name("zero"))) void ussf_zero(uint32_t into, uint32_t bytes);
}

namespace sgp4xp {

// ---------------------------------------------------------------------------------------------------------------
// The library.
// ---------------------------------------------------------------------------------------------------------------
class Library {
 public:
  static Library& instance() {
    static Library library;
    return library;
  }
  bool ready() const { return scratch_ != 0; }

  // The library keeps about 29 KB of every SGP4-XP satellite it has initialised, however the satellite is removed
  // (measured with the library's own JavaScript runtime: 28.6 KB per satellite, nothing for SGP4 sets), and a fit
  // propagates thousands of sets. So when no satellite is live and enough XP satellites have come and gone since the
  // library was last in its starting state, the library's memory is put back to that state: the bytes it held when it
  // was ready, zeros above them. Everything the library keeps is in that memory (its one global is the stack
  // pointer, which every call restores), so the restored library is the library after its start.
  void beforeCreate(bool xp) {
    if (live_ == 0 && xpSinceRecycle_ >= kRecycleAfter) recycle();
    if (xp) ++xpSinceRecycle_;
  }
  // The library holds one satellite at a time: removing one of several live XP satellites crashed it (memory access
  // out of bounds inside Sgp4RemoveSats, reproduced on the unmodified runtime, 2026-10-12), and every XP state is a
  // removal and a new satellite (Satellite::propagate).
  bool idle() const { return live_ == 0; }
  void satelliteAdded() { ++live_; }
  void satelliteRemoved() { if (live_ > 0) --live_; }

  // Space inside the library's memory for the bytes that cross: lines, keys, results. Grown, never shrunk.
  uint32_t scratch(uint32_t bytes) {
    if (bytes <= scratchBytes_) return scratch_;
    if (scratch_ != 0) ussf_free(scratch_);
    scratchBytes_ = 0;
    scratch_ = ussf_malloc(bytes);
    if (scratch_ != 0) scratchBytes_ = bytes;
    return scratch_;
  }

 private:
  static constexpr uint32_t kRecycleAfter = SGP4XP_RECYCLE_AFTER;  // XP satellites between restorations: 256 x 29 KB = 7 MB

  Library() {
    ussf_start();
    ussf_log_level(0);  // LOG_NONE: the library's messages go nowhere (shim.wat drops them anyway)
    scratch(4096);
    snapshot();
  }

  // What the library's memory holds now: everything up to its last non-zero byte.
  void snapshot() {
    const uint32_t total = ussf_pages() * 65536u;
    std::vector<uint8_t> chunk(65536);
    uint32_t end = 0;
    for (uint32_t at = total; at >= 65536u;) {
      at -= 65536u;
      ussf_get(chunk.data(), at, 65536u);
      uint32_t last = 65536u;
      while (last > 0 && chunk[last - 1] == 0) --last;
      if (last > 0) { end = at + last; break; }
    }
    snapshotBytes_ = (end + 4095u) & ~4095u;
    snapshot_.resize(snapshotBytes_);
    if (snapshotBytes_ > 0) ussf_get(snapshot_.data(), 0, snapshotBytes_);
    snapshotScratch_ = scratch_;
    snapshotScratchBytes_ = scratchBytes_;
  }

  void recycle() {
    if (snapshotBytes_ == 0) return;
    ussf_put(0, snapshot_.data(), snapshotBytes_);
    const uint32_t total = ussf_pages() * 65536u;
    if (total > snapshotBytes_) ussf_zero(snapshotBytes_, total - snapshotBytes_);
    scratch_ = snapshotScratch_;
    scratchBytes_ = snapshotScratchBytes_;
    xpSinceRecycle_ = 0;
  }

  uint32_t scratch_ = 0;
  uint32_t scratchBytes_ = 0;
  uint32_t live_ = 0;
  uint32_t xpSinceRecycle_ = 0;
  std::vector<uint8_t> snapshot_;
  uint32_t snapshotBytes_ = 0;
  uint32_t snapshotScratch_ = 0;
  uint32_t snapshotScratchBytes_ = 0;
};

// The step of the library's SGP4-XP integrator, measured black box against the oracle's 9.1.1.0 (README, "Dense
// grids"): from the epoch, 95 minutes for a set of mean motion 0.02 to 1.305 rev/day (a period of about 1,100 minutes
// or more) and two periods for one of 1.31 to 16.2 rev/day, eccentricity up to 0.85. A request on a satellite whose
// previous request lies in the same step comes back from a partial step (up to 0.81 km off on geosynchronous sets);
// any other request is the epoch-to-time propagation, bit for bit, after the epoch and, flown away from it, before.
// The bound is that step with a margin, in minutes; 0 outside the measured range.
inline double xpStepBound(const Elements& e) {
  const double n = e.meanMotion;
  if (!(e.eccentricity <= 0.85)) return 0;
  if (n >= 0.02 && n <= 1.305) return 100.0;
  if (n >= 1.31 && n <= 16.2) return 2.02 * 1440.0 / n + 1.0;  // two periods, minutes
  return 0;
}

// One element set inside the library: added to its TLE tree, initialised, and removed again when this goes out
// of scope. The library holds one at a time (Library::idle).
//
// Every state is the library's propagation from the set's epoch to that time. An SGP4 set (type 0) is flown on one
// satellite in the order given: its states are the same doubles either way. An SGP4-XP set is flown in chains: the
// times at or after the epoch in ascending order and those before it in descending order, each joining the chain
// whose last time is at least one step bound (xpStepBound) away, the earliest such, or starting a new one; every
// chain is flown on a new satellite, so no request lies in the step of the one before it. A time equal to an earlier
// one takes its state. Outside the measured range every time is a chain of its own, and after a refusal inside a chain
// the rest of that chain is flown one time per satellite.
class Satellite {
 public:
  Satellite() = default;
  Satellite(const Satellite&) = delete;
  Satellite& operator=(const Satellite&) = delete;
  ~Satellite() { release(); }

  bool valid() const { return live_; }

  // false: the text was refused, another satellite is live, or the library could not initialise it (its own error
  // code is in `error`).
  bool create(const Elements& elements, uint32_t satnum, int32_t* error = nullptr) {
    release();
    if (!formatTle(elements, satnum, &lines_)) { if (error) *error = -100; return false; }
    xp_ = elements.xp;
    bound_ = xp_ ? xpStepBound(elements) : 0;
    return add(error);
  }

  // Positions and velocities (TEME, km and km/s) at `count` times given as minutes from the epoch, each the
  // epoch-to-time propagation. states[8*i..8*i+7] = {library error, minutes, r, v}. false when any time failed (its
  // error code is states[8*i], nonzero).
  bool propagate(const double* minutes, size_t count, double* states) {
    if (!live_ || count == 0) return false;
    bool all = true;
    if (!xp_) {
      for (size_t i = 0; i < count; ++i)
        if (!request(minutes[i], states + i * 8)) all = false;
      return all;
    }
    for (size_t i = 0; i < count; ++i) { std::memset(states + i * 8, 0, 64); states[i * 8] = -1.0; }
    std::vector<size_t> after, before, alone;
    for (size_t i = 0; i < count; ++i) {
      if (!std::isfinite(minutes[i])) alone.push_back(i);
      else if (minutes[i] >= 0) after.push_back(i);
      else before.push_back(i);
    }
    std::stable_sort(after.begin(), after.end(), [&](size_t a, size_t b) { return minutes[a] < minutes[b]; });
    std::stable_sort(before.begin(), before.end(), [&](size_t a, size_t b) { return minutes[a] > minutes[b]; });
    std::vector<std::vector<size_t>> chains;
    std::vector<std::pair<size_t, size_t>> same;  // (time, the equal earlier time whose state it takes)
    deal(after, minutes, &chains, &same);
    deal(before, minutes, &chains, &same);
    for (size_t i : alone) chains.push_back({i});
    for (const auto& chain : chains) {
      const int flown = fly(chain, minutes, states);
      if (flown < 0) return false;  // no satellite: the times not flown keep error -1
      if (flown == 0) all = false;
    }
    for (const auto& [i, j] : same) {
      std::memcpy(states + i * 8, states + j * 8, 64);
      if (states[i * 8] != 0.0) all = false;
    }
    return all;
  }

 private:
  // Times in flight order into chains: a time joins the chain whose last time is at least one bound away (the earliest
  // such: the queue holds the chains by their last time) or starts one; a time equal to the one before takes its state.
  void deal(const std::vector<size_t>& order, const double* minutes, std::vector<std::vector<size_t>>* chains,
            std::vector<std::pair<size_t, size_t>>* same) const {
    std::vector<size_t> queue;
    size_t head = 0, previous = 0;
    for (size_t k = 0; k < order.size(); ++k) {
      const size_t i = order[k];
      if (k > 0 && minutes[i] == minutes[previous]) { same->push_back({i, previous}); continue; }
      previous = i;
      if (bound_ > 0 && head < queue.size() && std::fabs(minutes[i] - minutes[(*chains)[queue[head]].back()]) >= bound_) {
        const size_t c = queue[head++];
        (*chains)[c].push_back(i);
        queue.push_back(c);
      } else {
        chains->push_back({i});
        queue.push_back(chains->size() - 1);
      }
    }
  }

  // One chain on a new satellite (this one, when nothing has been asked of it yet): 1 when every time was flown, 0 when
  // the library refused some (their codes are in their states), -1 when no satellite could be had.
  int fly(const std::vector<size_t>& chain, const double* minutes, double* states) {
    bool alone = false;  // each remaining time on a satellite of its own
    int status = 1;
    for (size_t k = 0; k < chain.size(); ++k) {
      double* state = states + chain[k] * 8;
      if ((k == 0 || alone) && propagated_ && !renew()) return -1;
      if (request(minutes[chain[k]], state)) continue;
      if (k > 0 && !alone) {  // refused inside the chain: this time again, and every later one, from a new satellite
        alone = true;
        if (!renew()) return -1;
        if (request(minutes[chain[k]], state)) continue;
      }
      alone = true;
      status = 0;
    }
    return status;
  }

  // One request on this satellite: false when the library refused it (its code is state[0]).
  bool request(double minutes, double* state) {
    Library& library = Library::instance();
    const uint32_t base = library.scratch(4096);
    if (base == 0) { std::memset(state, 0, 64); state[0] = -1.0; return false; }
    const int64_t key = key_;
    ussf_put(base + 160, &key, 8);
    const int32_t rc = ussf_propagate(base + 160, 1, minutes, 1, 1.0, base + 256);
    ussf_get(state, base + 256, 64);
    propagated_ = true;
    return rc == 0 && state[0] == 0.0;
  }

  bool renew() {
    release();
    return add(nullptr);
  }

  // The lines into the library, initialised: [0,80) line 1, [80,160) line 2, [160,168) key, [168,176) error satellite.
  bool add(int32_t* error) {
    Library& library = Library::instance();
    if (!library.idle()) { if (error) *error = -103; return false; }
    library.beforeCreate(xp_);
    const uint32_t base = library.scratch(4096);
    if (base == 0) { if (error) *error = -101; return false; }
    char staged[168] = {0};
    std::memcpy(staged, lines_.line1, std::strlen(lines_.line1));
    std::memcpy(staged + 80, lines_.line2, std::strlen(lines_.line2));
    ussf_put(base, staged, 160);
    const int64_t key = ussf_tle_add(base, base + 80);
    if (key < 0) { if (error) *error = -102; return false; }
    key_ = key;
    const int64_t zero = 0;
    ussf_put(base + 160, &key, 8);
    ussf_put(base + 168, &zero, 8);
    const int32_t status = ussf_sgp4_init(base + 160, 1, base + 168);
    if (status != 0) {
      ussf_tle_remove(base + 160, 1, base + 168);
      if (error) *error = status;
      return false;
    }
    live_ = true;
    propagated_ = false;
    library.satelliteAdded();
    return true;
  }
  void release() {
    if (!live_) return;
    Library& library = Library::instance();
    const uint32_t base = library.scratch(4096);
    const int64_t key = key_;
    const int64_t zero = 0;
    ussf_put(base + 160, &key, 8);
    ussf_put(base + 168, &zero, 8);
    ussf_sgp4_remove(base + 160, 1, base + 168);
    ussf_tle_remove(base + 160, 1, base + 168);
    live_ = false;
    library.satelliteRemoved();
  }
  TleLines lines_{};
  int64_t key_ = 0;
  bool xp_ = false;
  bool live_ = false;
  bool propagated_ = false;
  double bound_ = 0;  // xpStepBound of an SGP4-XP set, minutes; 0: every time on a satellite of its own
};

}  // namespace sgp4xp
