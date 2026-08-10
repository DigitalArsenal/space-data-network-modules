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
