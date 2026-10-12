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

  // The library keeps about 29 KB of every SGP4-XP satellite it has propagated, however the satellite is removed
  // (measured with the library's own JavaScript runtime: 28.6 KB per satellite, nothing for SGP4 sets), and a fit
  // propagates thousands of sets. So when no satellite is live and enough XP satellites have come and gone since the
  // library was last in its starting state, the library's memory is put back to that state: the bytes it held when it
  // was ready, zeros above them. Everything the library keeps is in that memory (its one global is the stack
  // pointer, which every call restores), so the restored library is the library after its start.
  void beforeCreate(bool xp) {
    if (live_ == 0 && xpSinceRecycle_ >= kRecycleAfter) recycle();
    if (xp) ++xpSinceRecycle_;
  }
  // True when enough XP satellites have come and gone that the next creation should start from a restored library;
  // the caller releases every live satellite first, since the library is restored only when none is live.
  bool recycleDue() const { return xpSinceRecycle_ >= kRecycleAfter; }
  // Puts the library back in its starting state with satellites still live, which it then no longer knows: their
  // owners must abandon() them. Removing one of several live XP satellites crashed the library itself (memory access
  // out of bounds inside Sgp4RemoveSats, reproduced on the unmodified runtime, 2026-10-12); a restore removes nothing.
  void restore() {
    recycle();
    live_ = 0;
  }
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

// One element set inside the library: added to its TLE tree, initialised, and removed again when this goes out
// of scope. The library keys its tree by satellite number, epoch and type, so two live sets must differ in
// satellite number; a fit keeps one at a time and the entity table gives each its own.
class Satellite {
 public:
  Satellite() = default;
  Satellite(const Satellite&) = delete;
  Satellite& operator=(const Satellite&) = delete;
  Satellite(Satellite&& other) noexcept { *this = static_cast<Satellite&&>(other); }
  Satellite& operator=(Satellite&& other) noexcept {
    if (this != &other) {
      release();
      key_ = other.key_;
      live_ = other.live_;
      other.live_ = false;
    }
    return *this;
  }
  ~Satellite() { release(); }

  bool valid() const { return live_; }
  // Forgets the satellite without telling the library: only after Library::restore(), which already dropped it.
  void abandon() { live_ = false; }

  // false: the text was refused, or the library could not initialise it (its own error code is in `error`).
  bool create(const Elements& elements, uint32_t satnum, int32_t* error = nullptr) {
    release();
    TleLines lines;
    if (!formatTle(elements, satnum, &lines)) { if (error) *error = -100; return false; }
    Library& library = Library::instance();
    library.beforeCreate(elements.xp);
    // [0,80) line 1, [80,160) line 2, [160,168) key, [168,176) error satellite.
    const uint32_t base = library.scratch(4096);
    if (base == 0) { if (error) *error = -101; return false; }
    char staged[168] = {0};
    std::memcpy(staged, lines.line1, std::strlen(lines.line1));
    std::memcpy(staged + 80, lines.line2, std::strlen(lines.line2));
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
    library.satelliteAdded();
    return true;
  }

  // Positions and velocities (TEME, km and km/s) at `count` times given as minutes from the epoch, in the order
  // asked; ascending times are the library's fast path. states[8*i..8*i+7] = {library error, minutes, r, v}.
  // false when any time failed (its error code is states[8*i], nonzero).
  bool propagate(const double* minutes, size_t count, double* states) const {
    if (!live_ || count == 0) return false;
    Library& library = Library::instance();
    const uint32_t need = 4096 + static_cast<uint32_t>(count) * 64u;
    const uint32_t base = library.scratch(need);
    if (base == 0) return false;
    const uint32_t results = base + 256;
    const int64_t key = key_;
    ussf_put(base + 160, &key, 8);
    bool all = true;
    for (size_t i = 0; i < count; ++i) {
      if (ussf_propagate(base + 160, 1, minutes[i], 1, 1.0, results + static_cast<uint32_t>(i) * 64u) != 0) all = false;
    }
    ussf_get(states, results, static_cast<uint32_t>(count) * 64u);
    for (size_t i = 0; i < count; ++i) {
      if (states[i * 8] != 0.0) all = false;
    }
    return all;
  }

 private:
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
  int64_t key_ = 0;
  bool live_ = false;
};

}  // namespace sgp4xp
