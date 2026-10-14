// =============================================================================
// THE REFERENCE PROPAGATOR
// =============================================================================
//
// A two-body Keplerian propagator, implemented as a real WASM module against
// the official OrbPro propagator ABI. This file exists to be COPIED. Every
// export below is annotated with the section of `docs/propagator-abi.md` it
// implements, and the comments explain the OBLIGATION being met rather than
// the arithmetic being done.
//
// It is deliberately the simplest physics that is still honest: pure two-body
// motion from mean elements. No drag, no J2, no third bodies. It will not
// track a real satellite for long — that is not its job. Its job is to be a
// correct, complete, minimal example of the ABI, so that a third party can
// diff their own module against it and see exactly which parts are contract
// and which parts are physics.
//
// ABI obligations met here, in the order the document states them:
//
//   §4  Exports .............. plugin_init, plugin_init_omm, plugin_propagate,
//                              plugin_propagate_batch, plugin_destroy,
//                              plugin_entity_count
//   §5  Wire layout .......... every struct comes from the GENERATED header;
//                              this file declares no ABI struct of its own
//   §6  Units ................ METERS and METERS/SECOND on output
//   §7  Frames ............... reference_frame is SET, never left implicit,
//                              and the TEME->ECEF rotation is done IN HERE
//   §8  Identity ............. NORAD_CAT_ID is the authority; entity index is
//                              a local handle returned by ingest
//   §9  Threading ............ propagate_batch shards by stride, writes only
//                              its own rows
//   §10 Error codes .......... every failure returns a documented negative code
//   §11 Lifetime ............. plugin_destroy actually frees; N x
//                              init/destroy returns to baseline
//
// Build: `npm run build` -> dist/isomorphic/module.wasm
//        (SDK compiler lane, clang wasm32-wasip1-threads per the
//         isomorphic-pthreads law; NEVER emcc -pthread)
//
// Task: graph/tasks/harness-w1-propagator-abi-and-reference.md (W1.2)
// =============================================================================

#include "space_data_module_invoke.h"

// The ONE source of the ABI. Generated from schemas/orbpro/Propagator.fbs in
// space-data-module-sdk and inlined here by build.js. Do not retype these
// structs — the five hand-vendored copies of OrbProStateVector are precisely
// what the W1.1 generation lane exists to end.
#include "orbpro/orbpro_propagator_abi.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

// -----------------------------------------------------------------------------
// ABI §4 — export macro.
//
// `export_name` puts the symbol in the module's export table directly. The SDK
// compiler exports the invoke-surface symbols and every declared methodId for
// you; the PROPAGATOR ABI entry points are not methodIds, so they announce
// themselves here. (Same mechanism poly-coverage uses.)
// -----------------------------------------------------------------------------
#define ORBPRO_ABI_EXPORT(name) __attribute__((export_name(name))) extern "C"

// Forward declarations: the ABI entry points call each other, and the exported
// definitions appear at the bottom of the file where a reader looks for them.
extern "C" int32_t plugin_init_omm(const OrbProOMMRecord* records, uint32_t count);
extern "C" int32_t plugin_ingest_omm_one(const OrbProOMMRecord* record);

namespace {

// -----------------------------------------------------------------------------
// Constants. WGS-72 is used deliberately: it is the gravity model the OMM mean
// elements were FITTED under, so consuming a mean motion under WGS-84 would
// introduce a bias that has nothing to do with the two-body simplification.
// -----------------------------------------------------------------------------
constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kDegToRad = kPi / 180.0;

/// WGS-72 gravitational parameter, m^3/s^2.
constexpr double kMu = 398600.8e9;
/// Earth rotation rate, rad/s (IAU 1982).
constexpr double kEarthRotationRate = 7.292115146706979e-5;
constexpr double kSecondsPerDay = 86400.0;
/// Julian date of the J2000.0 epoch.
constexpr double kJ2000 = 2451545.0;

// -----------------------------------------------------------------------------
// ABI §10 — error codes.
//
// Every one of these is a NAMED, documented, negative return. A propagator
// that returns -1 for everything is unconformable: the host cannot tell a bad
// entity index from an uninitialized module, so it cannot decide whether to
// retry, skip or latch (the degradation ladder in the conformance kit).
// -----------------------------------------------------------------------------
constexpr int32_t kOk = 0;
constexpr int32_t kErrNotInitialized = -1;   // no elements ingested yet
constexpr int32_t kErrBadEntityIndex = -2;   // index >= entity count
constexpr int32_t kErrNullOutput = -3;       // caller passed a null out pointer
constexpr int32_t kErrBadInput = -4;         // malformed / short input buffer
constexpr int32_t kErrNotConverged = -5;     // Kepler solve failed to converge
constexpr int32_t kErrUnphysical = -6;       // elements describe no orbit

// -----------------------------------------------------------------------------
// ABI §8 — identity.
//
// NORAD_CAT_ID is the identity authority and it is carried, not invented. The
// entity index is a LOCAL handle into this module's own array; it is returned
// by ingest and is meaningless outside this module instance. The two are kept
// side by side so a host can map either way without guessing.
//
// Note what this module does NOT do: it never derives "the entity I just
// created" as `count - 1`. Ingest RETURNS the handle it assigned. That is the
// create-returns-handle primitive from the finding §4; three families in this
// stack independently reinvented the count-1 derivation and all three are
// race-unsafe.
// -----------------------------------------------------------------------------
struct Entity {
  uint32_t norad_cat_id = 0;
  double epoch_jd = 0.0;
  double mean_motion_rad_s = 0.0;
  double semi_major_axis_m = 0.0;
  double eccentricity = 0.0;
  double inclination_rad = 0.0;
  double raan_rad = 0.0;
  double arg_pericenter_rad = 0.0;
  double mean_anomaly_rad = 0.0;
};

// The module's entire mutable state. `plugin_destroy` returns this to exactly
// the shape it has at load time — see ABI §11 and tests/lifecycle.test.mjs.
std::vector<Entity>* g_entities = nullptr;

std::vector<Entity>& entities() {
  if (g_entities == nullptr) {
    g_entities = new std::vector<Entity>();
  }
  return *g_entities;
}

// -----------------------------------------------------------------------------
// Physics. Small, closed-form, and separated from every ABI concern above and
// below it so a reader can replace exactly this block.
// -----------------------------------------------------------------------------

/// Solve Kepler's equation M = E - e*sin(E) for the eccentric anomaly.
///
/// Newton-Raphson from a standard starting guess. Returns false rather than a
/// wrong answer if it fails to converge: ABI §10 requires a named failure, and
/// the conformance kit's rule is that a `converged` flag is never trusted, so
/// non-convergence must be reportable rather than smoothed over.
bool solve_kepler(double mean_anomaly, double eccentricity, double* out_E) {
  // Wrap into [0, 2pi) so the starting guess is in the right basin.
  double M = std::fmod(mean_anomaly, kTwoPi);
  if (M < 0.0) {
    M += kTwoPi;
  }

  double E = (eccentricity < 0.8) ? M : kPi;
  for (int iteration = 0; iteration < 64; ++iteration) {
    const double f = E - eccentricity * std::sin(E) - M;
    const double f_prime = 1.0 - eccentricity * std::cos(E);
    if (std::fabs(f_prime) < 1e-15) {
      return false;
    }
    const double delta = f / f_prime;
    E -= delta;
    if (std::fabs(delta) < 1e-14) {
      *out_E = E;
      return true;
    }
  }
  return false;
}

/// Greenwich Mean Sidereal Time in radians (IAU 1982), for the TEME->ECEF
/// rotation in ABI §7.
double gmst_radians(double julian_date) {
  const double tut1 = (julian_date - kJ2000) / 36525.0;
  double gmst_seconds = 67310.54841 +
                        (876600.0 * 3600.0 + 8640184.812866) * tut1 +
                        0.093104 * tut1 * tut1 -
                        6.2e-6 * tut1 * tut1 * tut1;
  double gmst = std::fmod(gmst_seconds * (kTwoPi / kSecondsPerDay), kTwoPi);
  if (gmst < 0.0) {
    gmst += kTwoPi;
  }
  return gmst;
}

/// Propagate one entity to `julian_date` and write an ABI state vector.
///
/// This is the function that has to be right. Everything above it is bookkeeping.
int32_t propagate_entity(const Entity& entity, double julian_date, OrbProStateVector* out) {
  if (entity.semi_major_axis_m <= 0.0 || entity.eccentricity < 0.0 ||
      entity.eccentricity >= 1.0) {
    return kErrUnphysical;
  }

  const double dt_seconds = (julian_date - entity.epoch_jd) * kSecondsPerDay;
  const double mean_anomaly = entity.mean_anomaly_rad + entity.mean_motion_rad_s * dt_seconds;

  double E = 0.0;
  if (!solve_kepler(mean_anomaly, entity.eccentricity, &E)) {
    return kErrNotConverged;
  }

  const double e = entity.eccentricity;
  const double a = entity.semi_major_axis_m;
  const double cosE = std::cos(E);
  const double sinE = std::sin(E);
  const double radius = a * (1.0 - e * cosE);
  if (radius <= 0.0) {
    return kErrUnphysical;
  }

  // Position and velocity in the perifocal (PQW) frame.
  const double sqrt_one_minus_e2 = std::sqrt(1.0 - e * e);
  const double x_pqw = a * (cosE - e);
  const double y_pqw = a * sqrt_one_minus_e2 * sinE;

  const double edot = entity.mean_motion_rad_s / (1.0 - e * cosE);
  const double vx_pqw = -a * sinE * edot;
  const double vy_pqw = a * sqrt_one_minus_e2 * cosE * edot;

  // Perifocal -> inertial (TEME) by the classical 3-1-3 rotation.
  const double cos_raan = std::cos(entity.raan_rad);
  const double sin_raan = std::sin(entity.raan_rad);
  const double cos_incl = std::cos(entity.inclination_rad);
  const double sin_incl = std::sin(entity.inclination_rad);
  const double cos_argp = std::cos(entity.arg_pericenter_rad);
  const double sin_argp = std::sin(entity.arg_pericenter_rad);

  const double r11 = cos_raan * cos_argp - sin_raan * sin_argp * cos_incl;
  const double r12 = -cos_raan * sin_argp - sin_raan * cos_argp * cos_incl;
  const double r21 = sin_raan * cos_argp + cos_raan * sin_argp * cos_incl;
  const double r22 = -sin_raan * sin_argp + cos_raan * cos_argp * cos_incl;
  const double r31 = sin_argp * sin_incl;
  const double r32 = cos_argp * sin_incl;

  const double x_teme = r11 * x_pqw + r12 * y_pqw;
  const double y_teme = r21 * x_pqw + r22 * y_pqw;
  const double z_teme = r31 * x_pqw + r32 * y_pqw;
  const double vx_teme = r11 * vx_pqw + r12 * vy_pqw;
  const double vy_teme = r21 * vx_pqw + r22 * vy_pqw;
  const double vz_teme = r31 * vx_pqw + r32 * vy_pqw;

  // ---------------------------------------------------------------------------
  // ABI §7 — FRAMES. The transform happens HERE, inside the module.
  //
  // The ABI requires ECEF output. TEME->ECEF is a rotation about Z by GMST,
  // and the velocity picks up the -omega x r term because the target frame is
  // rotating. Doing this in the host instead is the defect the engine's own
  // `toICRF` still carries (an ECEF input there is wrong by up to a full Earth
  // rotation) — a plugin that skips it renders its satellites on a smeared
  // ring.
  // ---------------------------------------------------------------------------
  const double theta = gmst_radians(julian_date);
  const double cos_theta = std::cos(theta);
  const double sin_theta = std::sin(theta);

  const double x_ecef = cos_theta * x_teme + sin_theta * y_teme;
  const double y_ecef = -sin_theta * x_teme + cos_theta * y_teme;
  const double z_ecef = z_teme;

  const double vx_rot = cos_theta * vx_teme + sin_theta * vy_teme;
  const double vy_rot = -sin_theta * vx_teme + cos_theta * vy_teme;
  const double vx_ecef = vx_rot + kEarthRotationRate * y_ecef;
  const double vy_ecef = vy_rot - kEarthRotationRate * x_ecef;
  const double vz_ecef = vz_teme;

  // ---------------------------------------------------------------------------
  // ABI §5/§6/§11 — WRITING THE STATE VECTOR.
  //
  // orbpro_state_init() zeroes the WHOLE struct including the three reserved
  // bytes at offsets 57..59, which the IDL requires to be zero. The host reuses
  // one scratch buffer across every call, so a partial write leaves the
  // previous call's bytes behind. Start from the initializer, always.
  //
  // Units are METERS and METERS/SECOND. There is no km variant. See the
  // normative units block in the generated header.
  // ---------------------------------------------------------------------------
  orbpro_state_init(out);
  out->epoch = julian_date;
  out->position[0] = x_ecef;
  out->position[1] = y_ecef;
  out->position[2] = z_ecef;
  out->velocity[0] = vx_ecef;
  out->velocity[1] = vy_ecef;
  out->velocity[2] = vz_ecef;
  // Use the GENERATED setter, not a bare assignment: it clears the three
  // padding bytes that a consumer reading offset 56 as a 32-bit word would
  // otherwise see as garbage.
  orbpro_state_set_reference_frame(out, ORBPRO_FRAME_ECEF);
  out->flags |= (uint32_t)ORBPRO_STATE_VALID;
  return kOk;
}

/// Adopt one binary OMM record into an entity. Angles arrive in DEGREES and
/// mean motion in REV/DAY (ABI §5, OrbProOMMRecord) and are converted once,
/// here, on the way in — never on the way out.
bool adopt_omm(const OrbProOMMRecord& record, Entity* out) {
  const double mean_motion_rad_s = record.mean_motion * kTwoPi / kSecondsPerDay;
  if (!(mean_motion_rad_s > 0.0) || !std::isfinite(mean_motion_rad_s)) {
    return false;
  }
  if (!(record.eccentricity >= 0.0) || record.eccentricity >= 1.0) {
    return false;
  }
  if (!std::isfinite(record.epoch_jd)) {
    return false;
  }

  // a = (mu / n^2)^(1/3) — the two-body relation between mean motion and
  // semi-major axis. This is where WGS-72's mu matters.
  out->semi_major_axis_m = std::cbrt(kMu / (mean_motion_rad_s * mean_motion_rad_s));
  out->mean_motion_rad_s = mean_motion_rad_s;
  out->epoch_jd = record.epoch_jd;
  out->eccentricity = record.eccentricity;
  out->inclination_rad = record.inclination * kDegToRad;
  out->raan_rad = record.ra_of_asc_node * kDegToRad;
  out->arg_pericenter_rad = record.arg_of_pericenter * kDegToRad;
  out->mean_anomaly_rad = record.mean_anomaly * kDegToRad;
  out->norad_cat_id = record.norad_cat_id;
  return true;
}

// -----------------------------------------------------------------------------
// Reading the ratified SDS $OMM FlatBuffer.
//
// The manifest declares a TYPED `$OMM` port, so this module has to actually
// honour it. There is no wildcard escape hatch here on purpose: six
// first-party manifests declare `acceptsAnyFlatbuffer` on both faces, and a
// wildcard port cannot be conformance-tested at all.
//
// This is a deliberately small hand-rolled reader rather than a linked
// FlatBuffers runtime, because the SDK compiles ONE translation unit and a
// reference module should be readable end to end. FlatBuffers table access is
// four rules:
//
//   1. the root table offset is a uint32 at buffer[0];
//   2. an int32 at the table start points BACKWARDS to the vtable;
//   3. the vtable is [vtable_size, table_size, slot0, slot1, ...] as uint16;
//   4. a slot value of 0 means "field absent — use the default".
//
// The slot numbers themselves are NOT written here; build.js derives them from
// the pinned, released $OMM schema and injects them below.
// -----------------------------------------------------------------------------

// __ORBPRO_OMM_VTABLE_SLOTS__

/// A bounds-checked view over one FlatBuffer table.
class FlatTable {
 public:
  FlatTable(const uint8_t* buffer, uint32_t length, uint32_t table_offset)
      : buffer_(buffer), length_(length), table_(table_offset) {
    if (table_ + 4 > length_) {
      valid_ = false;
      return;
    }
    int32_t soffset = 0;
    std::memcpy(&soffset, buffer_ + table_, sizeof(soffset));
    const int64_t vtable = static_cast<int64_t>(table_) - soffset;
    if (vtable < 0 || static_cast<uint64_t>(vtable) + 4 > length_) {
      valid_ = false;
      return;
    }
    vtable_ = static_cast<uint32_t>(vtable);
    std::memcpy(&vtable_size_, buffer_ + vtable_, sizeof(vtable_size_));
    if (vtable_ + vtable_size_ > length_) {
      valid_ = false;
    }
  }

  bool valid() const { return valid_; }

  /// Byte offset of a field within the buffer, or 0 when absent.
  uint32_t field_offset(uint16_t slot) const {
    if (!valid_ || slot + 2u > vtable_size_) {
      return 0;
    }
    uint16_t relative = 0;
    std::memcpy(&relative, buffer_ + vtable_ + slot, sizeof(relative));
    if (relative == 0) {
      return 0;
    }
    const uint32_t absolute = table_ + relative;
    return absolute < length_ ? absolute : 0;
  }

  double read_double(uint16_t slot, double fallback) const {
    const uint32_t offset = field_offset(slot);
    if (offset == 0 || offset + sizeof(double) > length_) {
      return fallback;
    }
    double value = 0.0;
    std::memcpy(&value, buffer_ + offset, sizeof(value));
    return value;
  }

  uint32_t read_uint32(uint16_t slot, uint32_t fallback) const {
    const uint32_t offset = field_offset(slot);
    if (offset == 0 || offset + sizeof(uint32_t) > length_) {
      return fallback;
    }
    uint32_t value = 0;
    std::memcpy(&value, buffer_ + offset, sizeof(value));
    return value;
  }

  uint8_t read_uint8(uint16_t slot, uint8_t fallback) const {
    const uint32_t offset = field_offset(slot);
    if (offset == 0 || offset + 1 > length_) {
      return fallback;
    }
    return buffer_[offset];
  }

  /// Absolute offset of a sub-table (or union value) field; 0 when absent.
  uint32_t read_table(uint16_t slot) const {
    const uint32_t offset = field_offset(slot);
    if (offset == 0 || offset + 4 > length_) {
      return 0;
    }
    uint32_t indirect = 0;
    std::memcpy(&indirect, buffer_ + offset, sizeof(indirect));
    const uint64_t target = static_cast<uint64_t>(offset) + indirect;
    return target + 4 <= length_ ? static_cast<uint32_t>(target) : 0;
  }

  /// Returns a pointer to the string bytes and its length; null when absent.
  const char* read_string(uint16_t slot, uint32_t* out_length) const {
    *out_length = 0;
    const uint32_t offset = field_offset(slot);
    if (offset == 0 || offset + 4 > length_) {
      return nullptr;
    }
    uint32_t indirect = 0;
    std::memcpy(&indirect, buffer_ + offset, sizeof(indirect));
    const uint32_t start = offset + indirect;
    if (start + 4 > length_) {
      return nullptr;
    }
    uint32_t string_length = 0;
    std::memcpy(&string_length, buffer_ + start, sizeof(string_length));
    if (start + 4 + string_length > length_) {
      return nullptr;
    }
    *out_length = string_length;
    return reinterpret_cast<const char*>(buffer_ + start + 4);
  }

 private:
  const uint8_t* buffer_ = nullptr;
  uint32_t length_ = 0;
  uint32_t table_ = 0;
  uint32_t vtable_ = 0;
  uint16_t vtable_size_ = 0;
  bool valid_ = true;
};

/// Convert an ISO 8601 UTC timestamp to a Julian date.
///
/// $OMM carries EPOCH as a STRING, so a propagator consuming the ratified
/// record has to parse it. Accepts `YYYY-MM-DDTHH:MM:SS[.ffffff][Z]`.
bool iso8601_to_julian_date(const char* text, uint32_t length, double* out_jd) {
  if (text == nullptr || length < 19) {
    return false;
  }
  int year = 0, month = 0, day = 0, hour = 0, minute = 0;
  double second = 0.0;

  auto digits = [&](uint32_t start, uint32_t count, int* out) {
    int value = 0;
    for (uint32_t i = 0; i < count; ++i) {
      const char c = text[start + i];
      if (c < '0' || c > '9') return false;
      value = value * 10 + (c - '0');
    }
    *out = value;
    return true;
  };

  if (!digits(0, 4, &year) || !digits(5, 2, &month) || !digits(8, 2, &day) ||
      !digits(11, 2, &hour) || !digits(14, 2, &minute)) {
    return false;
  }
  int whole_seconds = 0;
  if (!digits(17, 2, &whole_seconds)) {
    return false;
  }
  second = whole_seconds;
  if (length > 19 && text[19] == '.') {
    double scale = 0.1;
    for (uint32_t i = 20; i < length; ++i) {
      const char c = text[i];
      if (c < '0' || c > '9') break;
      second += (c - '0') * scale;
      scale *= 0.1;
    }
  }

  // Fliegel-Van Flandern, valid across the Gregorian calendar.
  const long a = (14 - month) / 12;
  const long y = year + 4800 - a;
  const long m = month + 12 * a - 3;
  const long jdn = day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;

  *out_jd = static_cast<double>(jdn) - 0.5 +
            (hour * 3600.0 + minute * 60.0 + second) / kSecondsPerDay;
  return true;
}

/// Decode one ratified `$OMM` FlatBuffer into the ABI's binary OMM record.
bool decode_omm_flatbuffer(const uint8_t* buffer, uint32_t length, OrbProOMMRecord* out) {
  if (buffer == nullptr || length < 8) {
    return false;
  }
  uint32_t root_offset = 0;
  std::memcpy(&root_offset, buffer, sizeof(root_offset));
  if (root_offset + 4 > length) {
    return false;
  }
  const FlatTable table(buffer, length, root_offset);
  if (!table.valid()) {
    return false;
  }

  uint32_t epoch_length = 0;
  const char* epoch_text = table.read_string(ORBPRO_OMM_VT_EPOCH, &epoch_length);
  double epoch_jd = 0.0;
  if (!iso8601_to_julian_date(epoch_text, epoch_length, &epoch_jd)) {
    return false;
  }

  std::memset(out, 0, sizeof(*out));
  out->epoch_jd = epoch_jd;
  out->mean_motion = table.read_double(ORBPRO_OMM_VT_MEAN_MOTION, 0.0);
  out->eccentricity = table.read_double(ORBPRO_OMM_VT_ECCENTRICITY, 0.0);
  out->inclination = table.read_double(ORBPRO_OMM_VT_INCLINATION, 0.0);
  out->ra_of_asc_node = table.read_double(ORBPRO_OMM_VT_RA_OF_ASC_NODE, 0.0);
  out->arg_of_pericenter = table.read_double(ORBPRO_OMM_VT_ARG_OF_PERICENTER, 0.0);
  out->mean_anomaly = table.read_double(ORBPRO_OMM_VT_MEAN_ANOMALY, 0.0);
  out->bstar = table.read_double(ORBPRO_OMM_VT_BSTAR, 0.0);
  out->mean_motion_dot = table.read_double(ORBPRO_OMM_VT_MEAN_MOTION_DOT, 0.0);
  out->mean_motion_ddot = table.read_double(ORBPRO_OMM_VT_MEAN_MOTION_DDOT, 0.0);
  out->norad_cat_id = table.read_uint32(ORBPRO_OMM_VT_NORAD_CAT_ID, 0);
  return true;
}

/// Does this payload carry the ratified `$OMM` file identifier at offset 4?
bool has_omm_file_identifier(const uint8_t* buffer, uint32_t length) {
  return length >= 8 && buffer[4] == '$' && buffer[5] == 'O' && buffer[6] == 'M' &&
         buffer[7] == 'M';
}

const plugin_input_frame_t* find_frame(const char* port_id) {
  const uint32_t input_count = plugin_get_input_count();
  for (uint32_t index = 0; index < input_count; ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (frame != nullptr && frame->port_id != nullptr &&
        std::strcmp(frame->port_id, port_id) == 0) {
      return frame;
    }
  }
  return nullptr;
}

}  // namespace

// =============================================================================
// ABI §4 — THE EXPORTED SURFACE
// =============================================================================

/// ABI §4.1 — `plugin_init(data, len)`.
///
/// The generic initializer. This module accepts a packed array of
/// OrbProOMMRecord, which is what the engine's OMM ingest path hands over, and
/// refuses anything that is not a whole number of records rather than
/// silently truncating.
///
/// Returns the number of entities initialized (>0), or a negative error code.
ORBPRO_ABI_EXPORT("plugin_init")
int32_t plugin_init(const uint8_t* data, size_t len) {
  if (data == nullptr || len == 0) {
    return kErrBadInput;
  }
  if (len % sizeof(OrbProOMMRecord) != 0) {
    // A partial trailing record means the caller and this module disagree
    // about the struct size. Refusing is the only safe answer: the size lock
    // in the generated header cannot see across the boundary.
    return kErrBadInput;
  }
  const uint32_t count = static_cast<uint32_t>(len / sizeof(OrbProOMMRecord));
  return plugin_init_omm(reinterpret_cast<const OrbProOMMRecord*>(data), count);
}

/// ABI §4.2 — `plugin_init_omm(records, count)`: the typed ingest.
///
/// REPLACES the existing element set. Returns the number of entities now held,
/// or a negative error code. See `plugin_ingest_omm_one` for the
/// create-returns-handle form.
ORBPRO_ABI_EXPORT("plugin_init_omm")
int32_t plugin_init_omm(const OrbProOMMRecord* records, uint32_t count) {
  if (records == nullptr) {
    return kErrBadInput;
  }
  std::vector<Entity>& store = entities();
  store.clear();
  store.reserve(count);
  for (uint32_t index = 0; index < count; ++index) {
    Entity entity{};
    if (!adopt_omm(records[index], &entity)) {
      return kErrBadInput;
    }
    store.push_back(entity);
  }
  return static_cast<int32_t>(store.size());
}

/// ABI §8 — create-returns-handle.
///
/// Appends ONE record and RETURNS THE HANDLE IT ASSIGNED. A caller never has
/// to derive "the entity I just created" from the count, which is the
/// race-unsafe pattern the finding names three times. Negative return = error.
ORBPRO_ABI_EXPORT("plugin_ingest_omm_one")
int32_t plugin_ingest_omm_one(const OrbProOMMRecord* record) {
  if (record == nullptr) {
    return kErrBadInput;
  }
  Entity entity{};
  if (!adopt_omm(*record, &entity)) {
    return kErrBadInput;
  }
  std::vector<Entity>& store = entities();
  store.push_back(entity);
  return static_cast<int32_t>(store.size() - 1);
}

/// ABI §4.3 — `plugin_propagate(julian_date, entity_index, out)`.
ORBPRO_ABI_EXPORT("plugin_propagate")
int32_t plugin_propagate(double julian_date, uint32_t entity_index, OrbProStateVector* out) {
  if (out == nullptr) {
    return kErrNullOutput;
  }
  std::vector<Entity>& store = entities();
  if (store.empty()) {
    return kErrNotInitialized;
  }
  if (entity_index >= store.size()) {
    return kErrBadEntityIndex;
  }
  return propagate_entity(store[entity_index], julian_date, out);
}

/// ABI §4.4 / §9 — `plugin_propagate_batch(julian_date, out, count)`.
///
/// THREADING DISCIPLINE. When the host runs this across a worker pool it hands
/// each shard the SAME base pointer and a disjoint index range; a module must
/// write ONLY its own rows and must never read a neighbour's. This
/// implementation writes strictly `out[i]` for `i` in `[0, count)` and holds
/// no cross-row state, so it is safe under any sharding the host chooses —
/// which is the property the ABI actually requires. See ABI §9.
ORBPRO_ABI_EXPORT("plugin_propagate_batch")
int32_t plugin_propagate_batch(double julian_date, OrbProStateVector* out, uint32_t count) {
  if (out == nullptr) {
    return kErrNullOutput;
  }
  std::vector<Entity>& store = entities();
  if (store.empty()) {
    return kErrNotInitialized;
  }
  if (count > store.size()) {
    return kErrBadEntityIndex;
  }
  for (uint32_t index = 0; index < count; ++index) {
    const int32_t status = propagate_entity(store[index], julian_date, &out[index]);
    if (status != kOk) {
      // Mark the row invalid so a host that ignores the return value still
      // sees a state that says "not valid" rather than stale bytes, and stop:
      // a partially-written batch with no signal is the silent-wrong-numbers
      // failure this ABI is designed to prevent.
      orbpro_state_init(&out[index]);
      return status;
    }
  }
  return kOk;
}

/// ABI §4.5 — how many entities are currently held.
ORBPRO_ABI_EXPORT("plugin_entity_count")
int32_t plugin_entity_count(void) {
  return static_cast<int32_t>(entities().size());
}

/// ABI §11 — `plugin_destroy()`. THIS ONE IS REAL.
///
/// Both first-party propagators ship `destroySource()` as `{}` and both fail
/// the lifecycle leak test because of it (finding §4.5). This module releases
/// its storage and returns to its load-time shape, so N x
/// ingest/propagate/destroy returns to baseline — which is what
/// tests/lifecycle.test.mjs measures.
ORBPRO_ABI_EXPORT("plugin_destroy")
void plugin_destroy(void) {
  delete g_entities;
  g_entities = nullptr;
}

// =============================================================================
// The SDN invoke surface.
//
// One method, `ingest_omm`, declared in plugin-manifest.json with a TYPED
// input port carrying the ratified SDS `$OMM` file identifier. Note what is
// absent: no `acceptsAnyFlatbuffer` wildcard, and no invented four-byte type.
// A bare (non-`$`) identifier is a vendor invention and a harness must refuse
// it — the live sgp4 manifest still declares `PROP`/`PRST`/`CQRQ`, which exist
// in no schema.
//
// Declaring a typed port means honouring it: this module decodes the ratified
// `$OMM` FlatBuffer itself rather than demanding the host pre-unpack it.
// =============================================================================

extern "C" int ingest_omm(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_frame("omm");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-omm", "An 'omm' input frame is required.");
    return 3;
  }

  if (!has_omm_file_identifier(frame->payload, frame->payload_length)) {
    // Refuse rather than guess. A payload without the ratified identifier is
    // not an $OMM, and treating unknown bytes as elements is how a propagator
    // ends up producing confident, silently wrong numbers.
    plugin_set_error(
        "invalid-omm",
        "The 'omm' payload does not carry the ratified SDS $OMM file identifier.");
    return 3;
  }

  OrbProOMMRecord record{};
  if (!decode_omm_flatbuffer(frame->payload, frame->payload_length, &record)) {
    plugin_set_error("invalid-omm",
                     "The 'omm' payload is not a decodable $OMM record.");
    return 3;
  }

  if (plugin_ingest_omm_one(&record) < 0) {
    plugin_set_error("unphysical-omm",
                     "The $OMM record describes no closed orbit.");
    return 3;
  }
  return 0;
}

// =============================================================================
// SMALL BODIES: heliocentric osculating elements, many at once.
//
// Asteroids (and later comets) arrive as ratified SDS $SBD small-body records
// (never $OMM: they do not orbit the Earth) with CENTER_NAME = SUN, osculating
// elements in REF_FRAME ECLIPJ2000 (the mean ecliptic and equinox of J2000) or
// ICRF / EME2000 / J2000 axes, TIME_SYSTEM TT or TDB, SEMI_MAJOR_AXIS (or a
// comet's PERICENTER_DISTANCE and PERICENTER_EPOCH) in km and GM in km^3/s^2
// (the CCSDS 502.0-B-3 OPM keywords and units), H and G. This store is separate from the ABI entity
// table above: the ABI's state vector is Earth-fixed by contract, while these
// rows are Sun-centred and number in the hundreds of thousands.
//
// Everything a viewer needs is computed here: positions for a frame snapshot
// (float32, heliocentric ICRF metres) with the apparent V magnitude from the
// observer (H-G system, Bowell et al. 1989), one double-precision state for
// the selected body, and a diameter from H and an albedo. The host shards
// rows across its own workers (caller-level parallelism, as for the ABI
// batch): each worker instance holds a disjoint set of rows.
//
// TT is taken as TDB: the two differ by at most 1.7 ms, 34 m along a 20 km/s
// orbit. UTC epochs are refused (they would need leap seconds).
// =============================================================================

namespace {

constexpr double kAuMeters = 149597870700.0;
/// DE440 GM of the Sun (gm_de440.tpc BODY10_GM), m^3/s^2.
constexpr double kGmSun = 1.3271244004127942e20;
/// Obliquity of the ecliptic at J2000 (IAU 1976, 84381.448"), the angle of
/// the SPICE ECLIPJ2000 frame about the J2000 x-axis.
constexpr double kObliquityJ2000 = 84381.448 / 3600.0 * kDegToRad;
constexpr int32_t kErrUnsupportedCenter = -7;
constexpr int32_t kErrUnsupportedFrame = -8;
constexpr int32_t kErrUnsupportedTime = -9;
/// The epoch is farther from the row's element epoch than the validity span.
constexpr int32_t kErrOutsideValidity = -10;

/// Osculating elements are a two-body orbit only near their epoch: away from
/// it the planets pull the body off the conic. Measured against JPL Horizons
/// on the test sample (tests/small-bodies.e2e.test.mjs): about 2,200 km worst
/// at 26 days, 13,000 to 384,000 km at one year, 13.6 million km at five
/// years. Beyond this span a row is refused (NaN in a snapshot, an error for a
/// state); the host refreshes the catalog instead of drawing a wrong place.
constexpr double kDefaultSmallValiditySeconds = 60.0 * 86400.0;
double g_small_validity = kDefaultSmallValiditySeconds;

/// The perturbed path is carried on a fixed grid of checkpoints keyed to each
/// row's element epoch, epoch_et + k * kCheckpointStep: a snapshot at et uses
/// the conic osculating at the nearest checkpoint (at most 2 days away).
constexpr double kCheckpointStep = 4.0 * 86400.0;

struct SmallBody {
  // The record's osculating elements at its element epoch, exactly as decoded
  // and never changed afterwards (keplerian-reference 1.8.1: the drawn place
  // must not depend on where the clock has been).
  double epoch_et = 0.0;        // TDB seconds past J2000: the record's element epoch (validity)
  double a = 0.0;               // m
  double e = 0.0;
  double n = 0.0;               // rad/s
  double m0 = 0.0;              // rad at epoch
  double p[3] = {0, 0, 0};      // perifocal x (to pericentre), ICRF
  double q[3] = {0, 0, 0};      // perifocal y, ICRF
  // A cache of the perturbed path: the osculating elements at checkpoint k as
  // float32 differences from the epoch elements carried there on their own
  // conic (mean anomaly) or kept as they are (the rest). Checkpoint k is only
  // ever reached from checkpoint k -/+ 1 through these rounded values, so its
  // elements are the same whatever order the clock asked for them in.
  float da = 0.0f, de = 0.0f, dn = 0.0f, dm = 0.0f;
  float dp[3] = {0.0f, 0.0f, 0.0f};
  float dq[3] = {0.0f, 0.0f, 0.0f};
  int32_t k = 0;
  float h = NAN;
  float g = 0.15f;
};

/// A two-body conic: the elements a row's places are computed from.
struct Conic {
  double osc_et;  // the epoch the elements osculate at
  double a, e, n, m0;
  double p[3], q[3];
};

/// The row's conic at its cached checkpoint (the epoch elements at k = 0).
inline void conic_of(const SmallBody& b, Conic& c) {
  c.osc_et = b.epoch_et + b.k * kCheckpointStep;
  c.a = b.a + b.da;
  c.e = b.e + b.de;
  c.n = b.n + b.dn;
  c.m0 = b.m0 + b.n * (b.k * kCheckpointStep) + b.dm;
  for (int i = 0; i < 3; ++i) {
    c.p[i] = b.p[i] + b.dp[i];
    c.q[i] = b.q[i] + b.dq[i];
  }
}

/// The rows, in blocks of 65,536: a catalog grows shard by shard without the
/// reallocations (and the transient double copy) of one contiguous vector,
/// whose high-water mark a module's linear memory keeps for good (multi-body
/// round 2: the console's desktop memory budget with every numbered asteroid).
class SmallStore {
 public:
  static constexpr uint32_t kBlockShift = 16;
  static constexpr uint32_t kBlockRows = 1u << kBlockShift;
  size_t size() const { return size_; }
  bool empty() const { return size_ == 0; }
  SmallBody& operator[](size_t i) { return blocks_[i >> kBlockShift][i & (kBlockRows - 1)]; }
  const SmallBody& operator[](size_t i) const { return blocks_[i >> kBlockShift][i & (kBlockRows - 1)]; }
  void push_back(const SmallBody& b) {
    if ((size_ >> kBlockShift) >= blocks_.size()) blocks_.push_back(new SmallBody[kBlockRows]);
    (*this)[size_++] = b;
  }
  /// Allocates the blocks for n rows now, so no later push_back allocates
  /// (the threaded catalog's pool threads never meet the caller on the
  /// allocator's lock). Reserved blocks stay through truncate.
  void reserve(size_t n) {
    while (blocks_.size() * kBlockRows < n) blocks_.push_back(new SmallBody[kBlockRows]);
    reserved_ = blocks_.size();
  }
  /// Drops rows past n (a refused ingest leaves the store as it was).
  void truncate(size_t n) {
    if (n >= size_) return;
    size_ = n;
    const size_t keep = std::max<size_t>((n + kBlockRows - 1) >> kBlockShift, reserved_);
    while (blocks_.size() > keep) {
      delete[] blocks_.back();
      blocks_.pop_back();
    }
  }
  ~SmallStore() {
    reserved_ = 0;
    truncate(0);
  }

 private:
  std::vector<SmallBody*> blocks_;
  size_t size_ = 0;
  size_t reserved_ = 0;
};

SmallStore* g_small = nullptr;
int32_t g_small_failed_record = -1;

SmallStore& small_bodies() {
  if (g_small == nullptr) {
    g_small = new SmallStore();
  }
  return *g_small;
}

bool center_is_sun(const char* text, uint32_t length) {
  if (text == nullptr || length != 3) return false;
  return (text[0] == 'S' || text[0] == 's') && (text[1] == 'U' || text[1] == 'u') &&
         (text[2] == 'N' || text[2] == 'n');
}

bool text_is(const char* text, uint32_t length, const char* want) {
  const uint32_t n = static_cast<uint32_t>(std::strlen(want));
  if (text == nullptr || length != n) return false;
  for (uint32_t i = 0; i < n; ++i) {
    char c = text[i];
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    if (c != want[i]) return false;
  }
  return true;
}

/// REF_FRAME -> 0: equatorial J2000 / ICRF axes; 1: mean ecliptic and equinox
/// of J2000 (SPICE ECLIPJ2000); -1: anything else.
int frame_axes(const char* text, uint32_t length) {
  if (text_is(text, length, "ICRF") || text_is(text, length, "EME2000") || text_is(text, length, "J2000")) return 0;
  if (text_is(text, length, "ECLIPJ2000")) return 1;
  return -1;
}

/// Does this payload carry the ratified `$SBD` file identifier at offset 4?
bool has_sbd_file_identifier(const uint8_t* buffer, uint32_t length) {
  return length >= 8 && buffer[4] == '$' && buffer[5] == 'S' && buffer[6] == 'B' && buffer[7] == 'D';
}

/// One size-prefixed $SBD record into a small body.
int32_t decode_small_body(const uint8_t* buffer, uint32_t length, SmallBody* out) {
  if (!has_sbd_file_identifier(buffer, length)) return kErrBadInput;
  uint32_t root_offset = 0;
  std::memcpy(&root_offset, buffer, sizeof(root_offset));
  if (root_offset + 4 > length) return kErrBadInput;
  const FlatTable sbd(buffer, length, root_offset);
  if (!sbd.valid()) return kErrBadInput;

  uint32_t text_length = 0;
  const char* center = sbd.read_string(ORBPRO_SBD_VT_CENTER_NAME, &text_length);
  if (!center_is_sun(center, text_length)) return kErrUnsupportedCenter;
  const char* frame = sbd.read_string(ORBPRO_SBD_VT_REF_FRAME, &text_length);
  const int axes = frame_axes(frame, text_length);
  if (axes < 0) return kErrUnsupportedFrame;
  const char* time_system = sbd.read_string(ORBPRO_SBD_VT_TIME_SYSTEM, &text_length);
  if (!text_is(time_system, text_length, "TDB") && !text_is(time_system, text_length, "TT")) return kErrUnsupportedTime;

  uint32_t epoch_length = 0;
  const char* epoch_text = sbd.read_string(ORBPRO_SBD_VT_EPOCH, &epoch_length);
  double epoch_jd = 0.0;
  if (!iso8601_to_julian_date(epoch_text, epoch_length, &epoch_jd)) return kErrBadInput;

  double gm = sbd.read_double(ORBPRO_SBD_VT_GM, NAN) * 1e9;  // km^3/s^2 -> m^3/s^2
  if (!(gm > 0.0)) gm = kGmSun;
  const double e = sbd.read_double(ORBPRO_SBD_VT_ECCENTRICITY, NAN);
  if (!(e >= 0.0) || e >= 1.0) return kErrUnphysical;
  double a = sbd.read_double(ORBPRO_SBD_VT_SEMI_MAJOR_AXIS, NAN) * 1000.0;  // km -> m
  double m0 = sbd.read_double(ORBPRO_SBD_VT_MEAN_ANOMALY, NAN) * kDegToRad;
  if (!(a > 0.0)) {
    // A comet: q and the time of pericentre give a and the mean anomaly.
    const double q = sbd.read_double(ORBPRO_SBD_VT_PERICENTER_DISTANCE, NAN) * 1000.0;
    if (!(q > 0.0)) return kErrUnphysical;
    a = q / (1.0 - e);
    uint32_t tp_length = 0;
    const char* tp_text = sbd.read_string(ORBPRO_SBD_VT_PERICENTER_EPOCH, &tp_length);
    double tp_jd = 0.0;
    if (!iso8601_to_julian_date(tp_text, tp_length, &tp_jd)) return kErrBadInput;
    m0 = std::sqrt(gm / (a * a * a)) * (epoch_jd - tp_jd) * kSecondsPerDay;
  }
  const double inc = sbd.read_double(ORBPRO_SBD_VT_INCLINATION, NAN) * kDegToRad;
  const double node = sbd.read_double(ORBPRO_SBD_VT_RA_OF_ASC_NODE, NAN) * kDegToRad;
  const double argp = sbd.read_double(ORBPRO_SBD_VT_ARG_OF_PERICENTER, NAN) * kDegToRad;
  if (!std::isfinite(a) || !std::isfinite(inc) || !std::isfinite(node) || !std::isfinite(argp) ||
      !std::isfinite(m0)) {
    return kErrBadInput;
  }
  const double h = sbd.read_double(ORBPRO_SBD_VT_ABSOLUTE_MAGNITUDE, NAN);
  const double g = sbd.read_double(ORBPRO_SBD_VT_SLOPE_PARAMETER, NAN);
  out->h = static_cast<float>(h);
  out->g = std::isnan(g) ? 0.15f : static_cast<float>(g);

  // Perifocal axes in the element frame (3-1-3 rotation).
  const double cn = std::cos(node), sn = std::sin(node);
  const double ci = std::cos(inc), si = std::sin(inc);
  const double cw = std::cos(argp), sw = std::sin(argp);
  double p[3] = {cn * cw - sn * sw * ci, sn * cw + cn * sw * ci, sw * si};
  double q[3] = {-cn * sw - sn * cw * ci, -sn * sw + cn * cw * ci, cw * si};
  if (axes == 1) {
    // Ecliptic J2000 -> equatorial J2000 (ICRF axes): rotate about x by -eps.
    const double ce = std::cos(kObliquityJ2000), se = std::sin(kObliquityJ2000);
    const double py = ce * p[1] - se * p[2], pz = se * p[1] + ce * p[2];
    const double qy = ce * q[1] - se * q[2], qz = se * q[1] + ce * q[2];
    p[1] = py; p[2] = pz; q[1] = qy; q[2] = qz;
  }
  out->epoch_et = (epoch_jd - kJ2000) * kSecondsPerDay;
  out->a = a;
  out->e = e;
  out->n = std::sqrt(gm / (a * a * a));
  out->m0 = m0;
  for (int c = 0; c < 3; ++c) {
    out->p[c] = p[c];
    out->q[c] = q[c];
  }
  return kOk;
}

/// Kepler's equation for the snapshot path: Newton from a third-order start,
/// converged to 1e-12 rad (sub-millimetre at 50 AU).
bool small_eccentric_anomaly(double mean_anomaly, double e, double* out) {
  double m = std::fmod(mean_anomaly, kTwoPi);
  if (m > kPi) m -= kTwoPi;
  if (m < -kPi) m += kTwoPi;
  double ecc = m + e * std::sin(m) * (1.0 + e * std::cos(m));
  if (e > 0.8) ecc = m < 0.0 ? -kPi : kPi;
  for (int i = 0; i < 50; ++i) {
    const double f = ecc - e * std::sin(ecc) - m;
    const double fp = 1.0 - e * std::cos(ecc);
    const double d = f / fp;
    ecc -= d;
    if (std::fabs(d) < 1e-12) {
      *out = ecc;
      return true;
    }
  }
  return false;
}

bool small_in_validity(const SmallBody& b, double et) {
  return std::fabs(et - b.epoch_et) <= g_small_validity;
}

/// The conic's place (and velocity) at et, with no validity check.
bool small_conic(const Conic& b, double et, double r[3], double v[3]) {
  double ecc = 0.0;
  if (!small_eccentric_anomaly(b.m0 + b.n * (et - b.osc_et), b.e, &ecc)) return false;
  const double ce = std::cos(ecc), se = std::sin(ecc);
  const double root = std::sqrt(1.0 - b.e * b.e);
  const double x = b.a * (ce - b.e);
  const double y = b.a * root * se;
  for (int c = 0; c < 3; ++c) r[c] = x * b.p[c] + y * b.q[c];
  if (v != nullptr) {
    const double edot = b.n / (1.0 - b.e * ce);
    const double vx = -b.a * se * edot;
    const double vy = b.a * root * ce * edot;
    for (int c = 0; c < 3; ++c) v[c] = vx * b.p[c] + vy * b.q[c];
  }
  return true;
}

bool small_position(const SmallBody& b, double et, double r[3], double v[3]) {
  if (!small_in_validity(b, et)) return false;
  Conic c;
  conic_of(b, c);
  return small_conic(c, et, r, v);
}

// ── Planetary perturbations ────────────────────────────────────────────────
// Osculating elements are a two-body orbit only at their epoch: the planets
// pull a body off the conic (Psyche 1.4" at +45 days, 3" at +60 days against
// JPL Horizons on two-body alone). Each row is therefore carried along its
// perturbed path on a fixed grid of checkpoints keyed to its element epoch
// (kCheckpointStep): checkpoint k + 1 (or k - 1 before the epoch) is checkpoint
// k integrated one grid step (Encke's method: the deviation from the
// osculating conic, RK4) under the Sun and the eight planets (Mercury, Venus,
// the Earth-Moon barycentre, the Mars, Jupiter, Saturn, Uranus and Neptune
// systems; DE440 GMs), and its osculating elements there. A snapshot uses the
// nearest checkpoint's conic; over the 2 days at most from it the conic is
// exact to well under 0.1".
//
// The path never depends on the clock's history (1.8.0 replaced the row's
// elements in place from wherever the clock had last been, so a row visited
// 50 days back and then brought to its epoch was 12,886 km off for Phaethon):
// the epoch elements are kept, a checkpoint is only ever computed from its
// neighbour toward the epoch, and moving back toward the epoch (or across it)
// restarts the chain from the epoch elements.
//
// The RK4 step is the grid step, refined near a planet (a tenth of the
// planet's distance's crossing time at 30 km/s within 0.2 AU) and near the
// Sun (kSunStepFraction of the body's dynamical time sqrt(r^3/GM): about
// 0.5 day at Phaethon's 0.14 AU perihelion; one step per grid interval
// beyond about 1 AU). 1.8.0's fixed 6-day step was twice Phaethon's
// dynamical time at perihelion.
//
// The planets' heliocentric places are their mean orbits (Standish, "Keplerian
// Elements for Approximate Positions of the Major Planets", JPL SSD, Table 1,
// 1800-2050; mean ecliptic and equinox of J2000): a perturbation needs the
// pulling body's place to about a percent of its distance, and the table holds
// Jupiter to about 400" (0.01 AU at 5.2 AU), which moves a two-month main-belt
// perturbation by a few hundredths of an arcsecond.
constexpr double kSunStepFraction = 0.08;
constexpr int kPlanets = 8;
// a (AU), e, I, L, long. perihelion, long. node (deg) at J2000 and per Julian century.
constexpr double kStandish[kPlanets][12] = {
    {0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
     0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081},
    {0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
     0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418},
    {1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
     0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0},
    {1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
     0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343},
    {5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
     -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106},
    {9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
     -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794},
    {19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503,
     -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589},
    {30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574,
     0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664},
};
// GM (m^3/s^2), gm_de440.tpc: BODY1, 2, 3 (Earth + Moon), 4..8 (systems).
constexpr double kPlanetGm[kPlanets] = {2.2031868551e13, 3.24858592e14, 4.03503235502e14, 4.2828375816e13,
                                        1.267127641e17, 3.79405848418e16, 5.7945564e15, 6.836527100580e15};

struct PlanetPlaces {
  double et = NAN;
  double r[kPlanets][3];
};
// Snapshots ask every row for the same epochs, so the places are kept for the
// last few dozen epochs asked for.
// Per thread: the threaded catalog's pool threads each keep their own.
thread_local PlanetPlaces g_places[48];
thread_local int g_places_next = 0;

const PlanetPlaces& planet_places(double et) {
  for (const PlanetPlaces& p : g_places) {
    if (p.et == et) return p;
  }
  PlanetPlaces& p = g_places[g_places_next];
  g_places_next = (g_places_next + 1) % 48;
  p.et = NAN;
  const double t = et / (36525.0 * 86400.0);
  const double ce = std::cos(kObliquityJ2000), se = std::sin(kObliquityJ2000);
  for (int k = 0; k < kPlanets; ++k) {
    const double* el = kStandish[k];
    const double a = (el[0] + el[6] * t) * kAuMeters, e = el[1] + el[7] * t;
    const double inc = (el[2] + el[8] * t) * kDegToRad, lon = (el[3] + el[9] * t) * kDegToRad;
    const double varpi = (el[4] + el[10] * t) * kDegToRad, node = (el[5] + el[11] * t) * kDegToRad;
    const double w = varpi - node;
    double ecc = 0.0;
    if (!small_eccentric_anomaly(lon - varpi, e, &ecc)) ecc = lon - varpi;
    const double x = a * (std::cos(ecc) - e), y = a * std::sqrt(1.0 - e * e) * std::sin(ecc);
    const double cw = std::cos(w), sw = std::sin(w), cn = std::cos(node), sn = std::sin(node);
    const double ci = std::cos(inc), si = std::sin(inc);
    const double xe = (cw * cn - sw * sn * ci) * x + (-sw * cn - cw * sn * ci) * y;
    const double ye = (cw * sn + sw * cn * ci) * x + (-sw * sn + cw * cn * ci) * y;
    const double ze = (sw * si) * x + (cw * si) * y;
    p.r[k][0] = xe;
    p.r[k][1] = ce * ye - se * ze;
    p.r[k][2] = se * ye + ce * ze;
  }
  p.et = et;  // last: a cache entry is complete before it matches
  return p;
}

/// The planets' pull on a body at heliocentric r (m), heliocentric frame
/// (direct and indirect terms), and the body's smallest planet distance (m).
void planet_acceleration(const double r[3], double et, double out[3], double* nearest) {
  const PlanetPlaces& p = planet_places(et);
  out[0] = out[1] = out[2] = 0.0;
  double near = INFINITY;
  for (int k = 0; k < kPlanets; ++k) {
    const double* rk = p.r[k];
    const double d[3] = {rk[0] - r[0], rk[1] - r[1], rk[2] - r[2]};
    const double d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const double dn = std::sqrt(d2);
    const double rk2 = rk[0] * rk[0] + rk[1] * rk[1] + rk[2] * rk[2];
    const double f = kPlanetGm[k] / (d2 * dn), g = kPlanetGm[k] / (rk2 * std::sqrt(rk2));
    for (int c = 0; c < 3; ++c) out[c] += f * d[c] - g * rk[c];
    near = std::min(near, dn);
  }
  if (nearest != nullptr) *nearest = near;
}

/// Encke: the deviation's acceleration at t (the planets' pull at the body's
/// perturbed place, plus the difference of the Sun's pull there and on the
/// conic).
bool encke_acceleration(const Conic& b, double gm, double t, const double dr[3], double out[3], double* nearest,
                        double* radius) {
  double rho[3];
  if (!small_conic(b, t, rho, nullptr)) return false;
  const double r[3] = {rho[0] + dr[0], rho[1] + dr[1], rho[2] + dr[2]};
  const double rho3 = std::pow(rho[0] * rho[0] + rho[1] * rho[1] + rho[2] * rho[2], 1.5);
  const double r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
  const double r3 = std::pow(r2, 1.5);
  if (radius != nullptr) *radius = std::sqrt(r2);
  planet_acceleration(r, t, out, nearest);
  for (int c = 0; c < 3; ++c) out[c] += gm * (rho[c] / rho3 - r[c] / r3);
  return true;
}

/// One grid step of the perturbed path: `c` (osculating at c.osc_et) is
/// integrated to t_end and replaced by the osculating conic there. A failed
/// step or a non-elliptic result returns false and leaves `c` as it was.
bool advance_conic(Conic& c, double t_end) {
  const double gm = c.n * c.n * c.a * c.a * c.a;
  const double span = t_end - c.osc_et;
  double dr[3] = {0, 0, 0}, dv[3] = {0, 0, 0};
  double t = c.osc_et;
  while (std::fabs(t_end - t) > 1e-6) {
    double k1v[3], k2v[3], k3v[3], k4v[3], nearest = INFINITY, radius = INFINITY;
    if (!encke_acceleration(c, gm, t, dr, k1v, &nearest, &radius)) return false;
    double h = span;
    const double close = 0.2 * kAuMeters;
    if (nearest < close) {
      const double fine = std::max(600.0, 0.1 * nearest / 30000.0);
      if (fine < std::fabs(h)) h = std::copysign(fine, span);
    }
    const double solar = std::max(600.0, kSunStepFraction * std::sqrt(radius * radius * radius / gm));
    if (solar < std::fabs(h)) h = std::copysign(solar, span);
    if (std::fabs(t_end - t) < std::fabs(h) * (1.0 + 1e-9)) h = t_end - t;
    const double hh = 0.5 * h;
    double r2[3], v2[3], r3[3], v3[3], r4[3], v4[3];
    for (int i = 0; i < 3; ++i) { r2[i] = dr[i] + hh * dv[i]; v2[i] = dv[i] + hh * k1v[i]; }
    if (!encke_acceleration(c, gm, t + hh, r2, k2v, nullptr, nullptr)) return false;
    for (int i = 0; i < 3; ++i) { r3[i] = dr[i] + hh * v2[i]; v3[i] = dv[i] + hh * k2v[i]; }
    if (!encke_acceleration(c, gm, t + hh, r3, k3v, nullptr, nullptr)) return false;
    for (int i = 0; i < 3; ++i) { r4[i] = dr[i] + h * v3[i]; v4[i] = dv[i] + h * k3v[i]; }
    if (!encke_acceleration(c, gm, t + h, r4, k4v, nullptr, nullptr)) return false;
    for (int i = 0; i < 3; ++i) {
      dr[i] += h / 6.0 * (dv[i] + 2.0 * v2[i] + 2.0 * v3[i] + v4[i]);
      dv[i] += h / 6.0 * (k1v[i] + 2.0 * k2v[i] + 2.0 * k3v[i] + k4v[i]);
    }
    t += h;
  }
  // The perturbed state at t_end, and its osculating conic.
  double r[3], v[3];
  if (!small_conic(c, t_end, r, v)) return false;
  for (int i = 0; i < 3; ++i) { r[i] += dr[i]; v[i] += dv[i]; }
  const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const double v2n = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const double hv[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  const double hn = std::sqrt(hv[0] * hv[0] + hv[1] * hv[1] + hv[2] * hv[2]);
  const double inv_a = 2.0 / rn - v2n / gm;
  if (!(inv_a > 0.0) || !(hn > 0.0)) return false;
  const double a = 1.0 / inv_a;
  const double vxh[3] = {v[1] * hv[2] - v[2] * hv[1], v[2] * hv[0] - v[0] * hv[2], v[0] * hv[1] - v[1] * hv[0]};
  double ev[3];
  for (int i = 0; i < 3; ++i) ev[i] = vxh[i] / gm - r[i] / rn;
  const double e = std::sqrt(ev[0] * ev[0] + ev[1] * ev[1] + ev[2] * ev[2]);
  if (!(e < 1.0)) return false;
  double p[3], m;
  if (e > 1e-10) {
    for (int i = 0; i < 3; ++i) p[i] = ev[i] / e;
    const double cos_e = (1.0 - rn / a) / e;
    const double sin_e = (r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) / (e * std::sqrt(gm * a));
    const double ecc = std::atan2(sin_e, cos_e);
    m = ecc - e * std::sin(ecc);
  } else {
    for (int i = 0; i < 3; ++i) p[i] = r[i] / rn;
    m = 0.0;
  }
  c.osc_et = t_end;
  c.a = a;
  c.e = e;
  c.n = std::sqrt(gm / (a * a * a));
  c.m0 = m;
  for (int i = 0; i < 3; ++i) c.p[i] = p[i];
  c.q[0] = (hv[1] * p[2] - hv[2] * p[1]) / hn;
  c.q[1] = (hv[2] * p[0] - hv[0] * p[2]) / hn;
  c.q[2] = (hv[0] * p[1] - hv[1] * p[0]) / hn;
  return true;
}

/// Caches `c` as the row's checkpoint k (float32 differences from the epoch
/// elements; the mean anomaly's from the epoch conic carried to the
/// checkpoint, wrapped to +-pi).
void store_checkpoint(SmallBody& b, const Conic& c, int32_t k) {
  const double base_m = b.m0 + b.n * (k * kCheckpointStep);
  b.da = static_cast<float>(c.a - b.a);
  b.de = static_cast<float>(c.e - b.e);
  b.dn = static_cast<float>(c.n - b.n);
  b.dm = static_cast<float>(std::remainder(c.m0 - base_m, kTwoPi));
  for (int i = 0; i < 3; ++i) {
    b.dp[i] = static_cast<float>(c.p[i] - b.p[i]);
    b.dq[i] = static_cast<float>(c.q[i] - b.q[i]);
  }
  b.k = k;
}

/// The row's checkpoint nearest `et`, from its perturbed path. Continues the
/// cached chain when `et` lies farther out on the same side of the epoch, and
/// otherwise restarts it from the epoch elements, so the elements used at et
/// are a function of et alone. A failed step keeps the last good checkpoint.
bool small_rebase(SmallBody& b, double et) {
  const double steps = (et - b.epoch_et) / kCheckpointStep;
  if (!std::isfinite(steps) || std::fabs(steps) > 1.0e6) return false;
  const int32_t want = static_cast<int32_t>(std::lround(steps));
  if (want == b.k) return true;
  const bool onward = b.k != 0 && (b.k > 0) == (want > 0) && std::abs(want) > std::abs(b.k);
  if (!onward) {
    b.da = b.de = b.dn = b.dm = 0.0f;
    for (int i = 0; i < 3; ++i) b.dp[i] = b.dq[i] = 0.0f;
    b.k = 0;
  }
  const int32_t dir = want > b.k ? 1 : -1;
  Conic c;
  while (b.k != want) {
    conic_of(b, c);
    const int32_t next = b.k + dir;
    if (!advance_conic(c, b.epoch_et + next * kCheckpointStep)) return false;
    store_checkpoint(b, c, next);
  }
  return true;
}

/// A row carried to `et` along its perturbed path when `et` is inside its
/// validity span (outside it the row is refused anyway).
void small_rebase_valid(SmallBody& b, double et) {
  if (small_in_validity(b, et)) small_rebase(b, et);
}

/// V from H and G (Bowell et al. 1989): heliocentric distance r, observer
/// distance d (both AU) and the phase angle alpha (rad).
double hg_magnitude(double h, double g, double r_au, double d_au, double alpha) {
  const double t = std::tan(0.5 * alpha);
  const double phi1 = std::exp(-3.33 * std::pow(t, 0.63));
  const double phi2 = std::exp(-1.87 * std::pow(t, 1.22));
  const double mix = (1.0 - g) * phi1 + g * phi2;
  return h + 5.0 * std::log10(r_au * d_au) - 2.5 * std::log10(mix > 1e-300 ? mix : 1e-300);
}

/// One snapshot row: x, y, z (m, heliocentric ICRF) and V (NaN without H).
bool small_snapshot_row(const SmallBody& b, double et, const double* observer, float* out) {
  double r[3];
  if (!small_position(b, et, r, nullptr)) {
    out[0] = out[1] = out[2] = out[3] = NAN;
    return false;
  }
  out[0] = static_cast<float>(r[0]);
  out[1] = static_cast<float>(r[1]);
  out[2] = static_cast<float>(r[2]);
  if (std::isnan(b.h) || observer == nullptr) {
    out[3] = NAN;
    return true;
  }
  const double to_obs[3] = {observer[0] - r[0], observer[1] - r[1], observer[2] - r[2]};
  const double rr = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const double dd = std::sqrt(to_obs[0] * to_obs[0] + to_obs[1] * to_obs[1] + to_obs[2] * to_obs[2]);
  double cosa = (rr > 0.0 && dd > 0.0)
                    ? -(r[0] * to_obs[0] + r[1] * to_obs[1] + r[2] * to_obs[2]) / (rr * dd)
                    : 1.0;
  cosa = cosa > 1.0 ? 1.0 : (cosa < -1.0 ? -1.0 : cosa);
  out[3] = static_cast<float>(hg_magnitude(b.h, b.g, rr / kAuMeters, dd / kAuMeters, std::acos(cosa)));
  return true;
}

/// The speed of light (m/s, SI defining constant): light time only.
constexpr double kSpeedOfLight = 299792458.0;

/// Newton on Kepler's equation from a seed close to the answer (the
/// geometric solve's eccentric anomaly moved by the light time): one or two
/// steps to 1e-12 rad.
bool small_position_from(const Conic& b, double t, double seed, double r[3], double* ecc_out) {
  // No validity check here: the caller checked the observation epoch, and the
  // light-time place an hour or so before it belongs to that epoch (a row is
  // drawn to the very edge of its span).
  const double m = b.m0 + b.n * (t - b.osc_et);
  double ecc = seed;
  bool converged = false;
  for (int i = 0; i < 20; ++i) {
    const double f = ecc - b.e * std::sin(ecc) - m;
    const double d = f / (1.0 - b.e * std::cos(ecc));
    ecc -= d;
    if (std::fabs(d) < 1e-12) {
      converged = true;
      break;
    }
  }
  if (!converged) return false;
  const double ce = std::cos(ecc), se = std::sin(ecc);
  const double x = b.a * (ce - b.e);
  const double y = b.a * std::sqrt(1.0 - b.e * b.e) * se;
  for (int c = 0; c < 3; ++c) r[c] = x * b.p[c] + y * b.q[c];
  *ecc_out = ecc;
  return true;
}

/// Where a body is SEEN from an observer, with the same corrections the
/// bodies module applies to planets (NAIF LT+S, see
/// propagator/solar-system-bodies apparent_offset): the light-time position
/// (three iterations) and the classical first-order stellar aberration
/// u' = u + v/c - u (u.v/c), normalised, at the light-time distance.
///
/// observer: 9 doubles, ICRF: [0..2] the observer's position relative to the
/// Sun (m) at `et`; [3..5] the observer's velocity relative to the solar
/// system barycentre (m/s, for aberration); [6..8] the Sun's velocity
/// relative to the barycentre (m/s): the body's barycentric place at
/// et - tau is the Sun's place then plus the heliocentric row, and the Sun
/// moves about 13 m/s about the barycentre (its acceleration over a light
/// time is below a millimetre).
///
/// Out: `seen` the apparent vector from the observer (m), `geometric` the
/// geometric one at `et`, `light_time_place` the heliocentric row at et - tau.
bool small_apparent_place(const SmallBody& row, double et, const double* observer, double seen[3],
                          double geometric[3], double light_time_place[3]) {
  double r[3];
  if (!small_in_validity(row, et)) return false;
  Conic b;
  conic_of(row, b);
  double ecc = 0.0;
  if (!small_eccentric_anomaly(b.m0 + b.n * (et - b.osc_et), b.e, &ecc) ||
      !small_position_from(b, et, ecc, r, &ecc)) {
    return false;
  }
  const double* o = observer;
  double p[3] = {r[0] - o[0], r[1] - o[1], r[2] - o[2]};
  for (int c = 0; c < 3; ++c) geometric[c] = p[c];
  double tau = std::sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) / kSpeedOfLight;
  for (int it = 0; it < 3; ++it) {
    const double seed = ecc - b.n * tau / (1.0 - b.e * std::cos(ecc));
    double e2 = 0.0;
    if (!small_position_from(b, et - tau, seed, r, &e2)) return false;
    for (int c = 0; c < 3; ++c) p[c] = r[c] - o[6 + c] * tau - o[c];
    tau = std::sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) / kSpeedOfLight;
  }
  const double d = tau * kSpeedOfLight;
  if (!(d > 0.0)) return false;
  const double u[3] = {p[0] / d, p[1] / d, p[2] / d};
  const double v[3] = {o[3] / kSpeedOfLight, o[4] / kSpeedOfLight, o[5] / kSpeedOfLight};
  const double uv = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  double a[3];
  for (int c = 0; c < 3; ++c) a[c] = u[c] + v[c] - u[c] * uv;
  const double an = std::sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  for (int c = 0; c < 3; ++c) {
    seen[c] = a[c] / an * d;
    light_time_place[c] = r[c];
  }
  return true;
}

/// The 9-double observer at `et` from the 10 doubles a host passes: the
/// first nine as for small_apparent_place, given at observer[9] (TDB seconds
/// past J2000), the frame the host last placed its camera in. The position
/// moves on with the observer's heliocentric velocity (barycentric velocity
/// minus the Sun's) to `et`; over the few minutes a snapshot leads the frame
/// its acceleration is below a metre.
void small_observer_at(const double* observer, double et, double out[9]) {
  const double dt = et - observer[9];
  for (int c = 0; c < 9; ++c) out[c] = observer[c];
  for (int c = 0; c < 3; ++c) out[c] += (observer[3 + c] - observer[6 + c]) * dt;
}

/// One APPARENT snapshot row: x, y, z = observer + apparent vector (m,
/// heliocentric ICRF, so the host draws the row exactly as a geometric one)
/// and V from H and G at the light-time place.
bool small_apparent_row(const SmallBody& b, double et, const double* observer, float* out) {
  double seen[3], geometric[3], r[3];
  if (!small_apparent_place(b, et, observer, seen, geometric, r)) {
    out[0] = out[1] = out[2] = out[3] = NAN;
    return false;
  }
  for (int c = 0; c < 3; ++c) out[c] = static_cast<float>(observer[c] + seen[c]);
  if (std::isnan(b.h)) {
    out[3] = NAN;
    return true;
  }
  // Phase angle at the light-time place: Sun - body against observer - body.
  const double d = std::sqrt(seen[0] * seen[0] + seen[1] * seen[1] + seen[2] * seen[2]);
  const double rr = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  double cosa = (rr > 0.0 && d > 0.0) ? (r[0] * seen[0] + r[1] * seen[1] + r[2] * seen[2]) / (rr * d) : 1.0;
  cosa = cosa > 1.0 ? 1.0 : (cosa < -1.0 ? -1.0 : cosa);
  out[3] = static_cast<float>(hg_magnitude(b.h, b.g, rr / kAuMeters, d / kAuMeters, std::acos(cosa)));
  return true;
}

/// Size-prefixed $SBD stream -> rows appended. Returns the count appended or
/// a negative code (the failing record's index in kepler_small_failed_record).
int32_t ingest_small_stream(const uint8_t* data, uint32_t length) {
  g_small_failed_record = -1;
  SmallStore& store = small_bodies();
  const size_t before = store.size();
  uint32_t offset = 0;
  int32_t record = 0;
  // Rows go straight into the store; a refused record takes every row of
  // this stream back out (all or nothing).
  while (offset < length) {
    if (offset + 4 > length) {
      store.truncate(before);
      return kErrBadInput;
    }
    uint32_t size = 0;
    std::memcpy(&size, data + offset, sizeof(size));
    offset += 4;
    if (size == 0 || offset + size > length) {
      g_small_failed_record = record;
      store.truncate(before);
      return kErrBadInput;
    }
    SmallBody body;
    const int32_t code = decode_small_body(data + offset, size, &body);
    if (code != kOk) {
      g_small_failed_record = record;
      store.truncate(before);
      return code;
    }
    store.push_back(body);
    offset += size;
    ++record;
  }
  return static_cast<int32_t>(store.size() - before);
}

}  // namespace

/// Appends the rows of a size-prefixed $SBD stream (4-byte little-endian
/// length before each FlatBuffer), H and G included. All or nothing: a
/// refused record leaves the store unchanged. Returns the number appended or a
/// negative error code.
ORBPRO_ABI_EXPORT("kepler_small_ingest_sbd_stream")
int32_t kepler_small_ingest_sbd_stream(const uint8_t* data, uint32_t length) {
  if (data == nullptr || length == 0) return kErrBadInput;
  return ingest_small_stream(data, length);
}

/// The display fields of every record of a size-prefixed $SBD stream, for a
/// host's search and labels (no store change): `numbers` count uint32 NUMBER,
/// `hgd` count x 3 float32 (H, G, DIAMETER km; NaN when absent), and the
/// names (NAME, else DESIGNATION, UTF-8) packed into `names` with `offsets`
/// count + 1 uint32 byte offsets. `names` holds `capacity` bytes; a stream's
/// names never exceed its own length. Returns the record count, or a negative
/// error code (-4 a malformed stream, -11 names past `capacity`).
ORBPRO_ABI_EXPORT("kepler_small_describe_sbd_stream")
int32_t kepler_small_describe_sbd_stream(const uint8_t* data, uint32_t length, uint32_t count, uint32_t* numbers,
                                         float* hgd, uint32_t* offsets, uint8_t* names, uint32_t capacity) {
  if (data == nullptr || numbers == nullptr || hgd == nullptr || offsets == nullptr || names == nullptr) {
    return kErrNullOutput;
  }
  uint32_t offset = 0, record = 0, used = 0;
  while (offset < length && record < count) {
    if (offset + 4 > length) return kErrBadInput;
    uint32_t size = 0;
    std::memcpy(&size, data + offset, sizeof(size));
    offset += 4;
    if (size == 0 || offset + size > length || !has_sbd_file_identifier(data + offset, size)) return kErrBadInput;
    const uint8_t* buffer = data + offset;
    uint32_t root_offset = 0;
    std::memcpy(&root_offset, buffer, sizeof(root_offset));
    const FlatTable sbd(buffer, size, root_offset);
    if (!sbd.valid()) return kErrBadInput;
    numbers[record] = sbd.read_uint32(ORBPRO_SBD_VT_NUMBER, 0);
    hgd[3 * record] = static_cast<float>(sbd.read_double(ORBPRO_SBD_VT_ABSOLUTE_MAGNITUDE, NAN));
    hgd[3 * record + 1] = static_cast<float>(sbd.read_double(ORBPRO_SBD_VT_SLOPE_PARAMETER, NAN));
    hgd[3 * record + 2] = static_cast<float>(sbd.read_double(ORBPRO_SBD_VT_DIAMETER, NAN));
    uint32_t name_length = 0;
    const char* name = sbd.read_string(ORBPRO_SBD_VT_NAME, &name_length);
    if (name == nullptr || name_length == 0) name = sbd.read_string(ORBPRO_SBD_VT_DESIGNATION, &name_length);
    offsets[record] = used;
    if (name != nullptr && name_length > 0) {
      if (used + name_length > capacity) return -11;
      std::memcpy(names + used, name, name_length);
      used += name_length;
    }
    offset += size;
    ++record;
  }
  offsets[record] = used;
  return static_cast<int32_t>(record);
}

/// The records of a size-prefixed $SBD stream that a selection keeps, copied
/// size-prefixed and in stream order into `out` (`capacity` bytes): the
/// record's ORBIT_CLASS bit set in `class_mask` (bit n = sbdOrbitClass n; 0 =
/// every class), its ABSOLUTE_MAGNITUDE within [`h_min`, `h_max`) (a NaN
/// bound is open; a record without H fails a bounded range), and its NUMBER
/// not set in `exclude` (a bitmap by number, `exclude_bits` bits; null =
/// none). A host's size-band and class filter for the small-body catalog
/// (owner 2026-10-13: the rest of the numbered asteroids load by size band
/// and class), the records unchanged. Returns the bytes written, or a negative
/// error code (-4 a malformed stream, -11 `out` too small). `out` may be
/// `data` (the selection is made in place).
ORBPRO_ABI_EXPORT("kepler_small_select_sbd_stream")
int32_t kepler_small_select_sbd_stream(const uint8_t* data, uint32_t length, uint32_t class_mask, double h_min,
                                       double h_max, const uint8_t* exclude, uint32_t exclude_bits, uint8_t* out,
                                       uint32_t capacity) {
  if (data == nullptr || out == nullptr) return kErrNullOutput;
  uint32_t offset = 0, written = 0;
  while (offset < length) {
    if (offset + 4 > length) return kErrBadInput;
    uint32_t size = 0;
    std::memcpy(&size, data + offset, sizeof(size));
    if (size == 0 || offset + 4 + size > length || !has_sbd_file_identifier(data + offset + 4, size)) return kErrBadInput;
    const uint8_t* buffer = data + offset + 4;
    uint32_t root_offset = 0;
    std::memcpy(&root_offset, buffer, sizeof(root_offset));
    const FlatTable sbd(buffer, size, root_offset);
    if (!sbd.valid()) return kErrBadInput;
    bool keep = true;
    if (class_mask != 0) {
      const uint8_t cls = sbd.read_uint8(ORBPRO_SBD_VT_ORBIT_CLASS, 0);
      keep = cls < 32 && (class_mask >> cls & 1u) != 0;
    }
    if (keep && (!std::isnan(h_min) || !std::isnan(h_max))) {
      const double h = sbd.read_double(ORBPRO_SBD_VT_ABSOLUTE_MAGNITUDE, NAN);
      keep = !std::isnan(h) && (std::isnan(h_min) || h >= h_min) && (std::isnan(h_max) || h < h_max);
    }
    if (keep && exclude != nullptr) {
      const uint32_t number = sbd.read_uint32(ORBPRO_SBD_VT_NUMBER, 0);
      keep = !(number < exclude_bits && (exclude[number >> 3] >> (number & 7) & 1u) != 0);
    }
    if (keep) {
      if (written + 4 + size > capacity) return -11;
      // memmove: `out` may be `data` itself (an in-place selection; kept
      // records only ever move toward the start).
      std::memmove(out + written, data + offset, 4 + size);
      written += 4 + size;
    }
    offset += 4 + size;
  }
  return static_cast<int32_t>(written);
}

/// Index of the record the last refused ingest stopped at, or -1.
ORBPRO_ABI_EXPORT("kepler_small_failed_record")
int32_t kepler_small_failed_record(void) { return g_small_failed_record; }

ORBPRO_ABI_EXPORT("kepler_small_count")
int32_t kepler_small_count(void) { return static_cast<int32_t>(small_bodies().size()); }

ORBPRO_ABI_EXPORT("kepler_small_clear")
void kepler_small_clear(void) {
  delete g_small;
  g_small = nullptr;
}

/// A frame snapshot of rows [first, first + count) at `et` (TDB seconds past
/// J2000): four float32 per row, x, y, z (m, heliocentric ICRF) and V from
/// `observer` (3 doubles, m, heliocentric ICRF; null: V is NaN). A row whose
/// Kepler solve fails, or whose element epoch is farther than the validity
/// span from `et`, is NaN. Returns the number of failed rows.
ORBPRO_ABI_EXPORT("kepler_small_snapshot")
int32_t kepler_small_snapshot(double et, uint32_t first, uint32_t count, const double* observer, float* out) {
  SmallStore& store = small_bodies();
  if (out == nullptr) return kErrNullOutput;
  if (static_cast<uint64_t>(first) + count > store.size()) return kErrBadEntityIndex;
  int32_t failed = 0;
  for (uint32_t i = 0; i < count; ++i) {
    small_rebase_valid(store[first + i], et);
    if (!small_snapshot_row(store[first + i], et, observer, out + 4 * i)) ++failed;
  }
  return failed;
}

/// An APPARENT frame snapshot of rows [first, first + count) at `et` (TDB
/// seconds past J2000): four float32 per row, x, y, z (m, heliocentric ICRF)
/// of the place where the body is SEEN from the observer (light time and
/// stellar aberration, NAIF LT+S, as the bodies module draws planets) and V.
/// `observer` is 10 doubles: heliocentric position, barycentric velocity, the
/// Sun's barycentric velocity (see small_apparent_place) and the TDB epoch
/// they hold at; the module moves the observer on to `et`
/// (small_observer_at). NaN rows as for kepler_small_snapshot. Returns the
/// number of failed rows.
ORBPRO_ABI_EXPORT("kepler_small_snapshot_apparent")
int32_t kepler_small_snapshot_apparent(double et, uint32_t first, uint32_t count, const double* observer, float* out) {
  SmallStore& store = small_bodies();
  if (out == nullptr || observer == nullptr) return kErrNullOutput;
  if (static_cast<uint64_t>(first) + count > store.size()) return kErrBadEntityIndex;
  double at[9];
  small_observer_at(observer, et, at);
  int32_t failed = 0;
  for (uint32_t i = 0; i < count; ++i) {
    small_rebase_valid(store[first + i], et);
    if (!small_apparent_row(store[first + i], et, at, out + 4 * i)) ++failed;
  }
  return failed;
}

/// One row's light-time and aberration shift in double precision: the
/// apparent vector minus the geometric one from the same observer (m, ICRF;
/// observer as for kepler_small_snapshot_apparent). A host adds it to the
/// geometric place of a selected body, exactly as it adds the bodies module's
/// ssb_apparent_offsets to a planet, so the body sits where its point was.
ORBPRO_ABI_EXPORT("kepler_small_apparent_offset")
int32_t kepler_small_apparent_offset(double et, uint32_t index, const double* observer, double* out) {
  SmallStore& store = small_bodies();
  if (out == nullptr || observer == nullptr) return kErrNullOutput;
  if (index >= store.size()) return kErrBadEntityIndex;
  if (!small_in_validity(store[index], et)) return kErrOutsideValidity;
  double seen[3], geometric[3], r[3], at[9];
  small_observer_at(observer, et, at);
  small_rebase(store[index], et);
  if (!small_apparent_place(store[index], et, at, seen, geometric, r)) return kErrNotConverged;
  for (int c = 0; c < 3; ++c) out[c] = seen[c] - geometric[c];
  return kOk;
}

/// One row's state in double precision: position (m) and velocity (m/s),
/// heliocentric ICRF, at `et`.
ORBPRO_ABI_EXPORT("kepler_small_state")
int32_t kepler_small_state(double et, uint32_t index, double* out) {
  SmallStore& store = small_bodies();
  if (out == nullptr) return kErrNullOutput;
  if (index >= store.size()) return kErrBadEntityIndex;
  if (!small_in_validity(store[index], et)) return kErrOutsideValidity;
  small_rebase(store[index], et);
  return small_position(store[index], et, out, out + 3) ? kOk : kErrNotConverged;
}

/// The validity span (seconds either side of each row's element epoch).
/// A non-positive or non-finite value restores the default of 60 days.
ORBPRO_ABI_EXPORT("kepler_small_set_validity")
double kepler_small_set_validity(double seconds) {
  g_small_validity = (std::isfinite(seconds) && seconds > 0.0) ? seconds : kDefaultSmallValiditySeconds;
  return g_small_validity;
}

/// The epochs (TDB seconds past J2000) between which every row is valid, and
/// those between which at least one row is: four doubles (common start,
/// common end, any start, any end). Returns kErrNotInitialized without rows.
ORBPRO_ABI_EXPORT("kepler_small_validity_range")
int32_t kepler_small_validity_range(double* out) {
  SmallStore& store = small_bodies();
  if (out == nullptr) return kErrNullOutput;
  if (store.empty()) return kErrNotInitialized;
  double lo = -INFINITY, hi = INFINITY, any_lo = INFINITY, any_hi = -INFINITY;
  for (size_t i = 0; i < store.size(); ++i) {
    const SmallBody& b = store[i];
    lo = std::max(lo, b.epoch_et - g_small_validity);
    hi = std::min(hi, b.epoch_et + g_small_validity);
    any_lo = std::min(any_lo, b.epoch_et - g_small_validity);
    any_hi = std::max(any_hi, b.epoch_et + g_small_validity);
  }
  out[0] = lo;
  out[1] = hi;
  out[2] = any_lo;
  out[3] = any_hi;
  return kOk;
}

/// Equivalent-sphere diameter (m) from H and a geometric albedo:
/// D = 1329 km / sqrt(p) * 10^(-H/5) (Fowler & Chillemi 1992).
ORBPRO_ABI_EXPORT("kepler_small_diameter_from_h")
double kepler_small_diameter_from_h(double h, double albedo) {
  if (!(albedo > 0.0) || !std::isfinite(h)) return NAN;
  return 1329.0e3 / std::sqrt(albedo) * std::pow(10.0, -h / 5.0);
}
