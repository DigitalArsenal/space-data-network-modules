// -----------------------------------------------------------------------------
// Constants, gravity models and theory identifiers.
// -----------------------------------------------------------------------------

namespace sdnap {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kDeg = kPi / 180.0;
constexpr double kX2o3 = 2.0 / 3.0;
constexpr double kMinutesPerDay = 1440.0;
/// Julian date of 1950 January 0.0 (the SGP4 epoch origin).
constexpr double kJd1950 = 2433281.5;

/// Theories this module carries. The values are this module's own; an
/// element set says which theory it was fitted under and is propagated only
/// under that theory.
enum Theory : int32_t {
  kTheorySgp4 = 0,     ///< SGP4/SDP4 (STR#3, Vallado et al. 2006), ephemeris type 0.
  kTheorySgp4Xp = 4,   ///< SGP4-XP (US Space Force), ephemeris type 4: BTERM and AGOM.
};

/// Zonal gravity model of a theory (normalized to Earth radii and minutes).
struct Gravity {
  double mu;             ///< km^3/s^2
  double radius_km;      ///< equatorial radius, km
  double xke;            ///< sqrt(mu) in earth radii^1.5 per minute
  double tumin;          ///< 1 / xke
  double j2, j3, j4, j5;
  double j3oj2;
};

inline Gravity make_gravity(double mu, double radius_km, double j2, double j3, double j4, double j5) {
  Gravity g{};
  g.mu = mu;
  g.radius_km = radius_km;
  g.xke = 60.0 / std::sqrt(radius_km * radius_km * radius_km / mu);
  g.tumin = 1.0 / g.xke;
  g.j2 = j2;
  g.j3 = j3;
  g.j4 = j4;
  g.j5 = j5;
  g.j3oj2 = j3 / j2;
  return g;
}

/// WGS-72 (Vallado et al. 2006 "wgs72"), the SGP4 element-set convention.
inline Gravity gravity_wgs72() {
  return make_gravity(398600.8, 6378.135, 0.001082616, -0.00000253881, -0.00000165597, 0.0);
}

/// Memory accounting (SPEC 1.6; stack #497): every heap allocation of the module's own code goes through these, so a method
/// can tell an allocation that failed from a theory or a fit that failed, and refuse by name ("out-of-memory"). The count is
/// the instance's (every thread's); a method compares it with its own mark (CallMark). std::vector and operator new are not
/// counted: under -fno-exceptions their failure traps, as before.
namespace mem {
inline uint32_t g_failures = 0;
inline uint64_t g_largest_failed = 0;
inline void note_failure(size_t n) {
  __atomic_add_fetch(&g_failures, 1u, __ATOMIC_RELAXED);
  uint64_t cur = __atomic_load_n(&g_largest_failed, __ATOMIC_RELAXED);
  while (static_cast<uint64_t>(n) > cur &&
         !__atomic_compare_exchange_n(&g_largest_failed, &cur, static_cast<uint64_t>(n), false, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {
  }
}
inline void* malloc(size_t n) {
  void* p = std::malloc(n);
  if (p == nullptr && n > 0) note_failure(n);
  return p;
}
inline void* calloc(size_t k, size_t n) {
  void* p = std::calloc(k, n);
  if (p == nullptr && k > 0 && n > 0) note_failure(k * n);
  return p;
}
inline void* realloc(void* q, size_t n) {
  void* p = std::realloc(q, n);
  if (p == nullptr && n > 0) note_failure(n);
  return p;
}
inline void* aligned_alloc(size_t align, size_t n) {
  void* p = std::aligned_alloc(align, n);
  if (p == nullptr && n > 0) note_failure(n);
  return p;
}
/// A nothrow new's result, counted when it failed.
template <class T>
inline T* counted(T* p) {
  if (p == nullptr) note_failure(sizeof(T));
  return p;
}
/// A fixed-length initialization table; allocation failure is counted and leaves no elements.
template <class T> struct InitTable {
  T* data = nullptr;
  size_t count = 0;
  InitTable() = default;
  InitTable(const InitTable&) = delete;
  InitTable& operator=(const InitTable&) = delete;
  ~InitTable() { reset(); }
  void reset() {
    for (size_t i = 0; i < count; ++i) data[i].~T();
    std::free(data); data = nullptr; count = 0;
  }
  bool allocate(size_t n) {
    if (data) return count == n;
    data = static_cast<T*>(mem::malloc(n * sizeof(T)));
    if (!data) return false;
    count = n;
    for (size_t i = 0; i < n; ++i) new (data + i) T{};
    return true;
  }
  size_t size() const { return count; }
  bool empty() const { return count == 0; }
  T& operator[](size_t i) { return data[i]; }
  const T& operator[](size_t i) const { return data[i]; }
  T* begin() { return data; }
  T* end() { return data + count; }
};
inline uint32_t failures() { return __atomic_load_n(&g_failures, __ATOMIC_RELAXED); }
/// The failures counted when the calling thread's method began.
inline thread_local uint32_t g_call_mark = 0;
// The largest failed request is the instance's, reset by every method: were two methods ever to overlap on one instance, only
// the size the message names could be another call's (the count compared with each call's own mark stays right).
struct CallMark {
  CallMark() {
    g_call_mark = failures();
    __atomic_store_n(&g_largest_failed, 0, __ATOMIC_RELAXED);
  }
};
/// True, with the method's error set to "out-of-memory", when an allocation failed since the method began: a set the
/// theory could not initialize or a fit that could not finish for want of memory is refused as such, never as the theory's
/// refusal of the elements or a fit that did not converge.
inline bool refuse_if_out_of_memory() {
  const uint32_t now = failures();
  if (now == g_call_mark) return false;
  char why[200];
  std::snprintf(why, sizeof why,
                "An allocation failed (%u since the call began, the largest %llu bytes): the module's memory is exhausted.",
                now - g_call_mark, static_cast<unsigned long long>(__atomic_load_n(&g_largest_failed, __ATOMIC_RELAXED)));
  plugin_set_error("out-of-memory", why);
  return true;
}
/// A method's end (SPEC 1.6): a method during which one of the module's own allocations failed refuses by name, whatever it
/// would have answered. A fit can absorb a failed flight as a step that did not improve, a covariance that could not be
/// prepared can be dropped: such a call never returns success, and never another reason, and emits no output.
inline int finish(int rc) {
  if (failures() == g_call_mark) return rc;
  plugin_reset_output_state();
  refuse_if_out_of_memory();
  return 3;
}
}  // namespace mem

}  // namespace sdnap
