// =============================================================================
// SDN-AP PROPAGATOR (the bundle's name; its theory SDN-AP was removed)
// =============================================================================
//
// General-perturbations propagation of whole catalogs, one isomorphic WASM
// module (clang wasm32-wasip1-threads through the module SDK; no WebAssembly
// exception handling), carrying:
//   - SGP4    the public SGP4/SDP4 (STR#3, Vallado et al. 2006), type 0 sets;
//   - SGP4XP  the US Space Force SGP4-XP theory, type 4 sets, written clean
//             room (side B) from the public change list and SPEC.md.
//
// Parts (inlined in this order by build.mjs):
//   constants.inc  gravity models, theory identifiers
//   sgp4_core.inc  the SDP4 lunar-solar and resonance terms
//   model.inc      SGP4 ingest and propagation of one object; checkpoints
//   fastmath.inc   sincos from one range reduction
//   drag.inc       SGP4XP drag: flux model, J70 temperature and density table
//   xp_theory.inc  SGP4XP: the SPEC.md semi-analytic theory, its node grid
//   store.inc      the element store, frames
//   pool.inc       the batch thread pool
//   fit.inc        fit: ephemeris to element set (Levenberg-Marquardt)
//   abi.inc        the propagator ABI and the sdnap_* batch entries
//   omm.inc        the ingest_omm invoke method ($OMM FlatBuffers)
//   oem.inc        the propagate invoke method ($OMM in, $OEM out)
//   fit_oem.inc    the fit invoke method ($OEM in, $OMM out)
// =============================================================================

#include "space_data_module_invoke.h"
#include "orbpro/orbpro_propagator_abi.h"
#include "omm_slots.h"

#include <pthread.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "constants.inc"
#include "sgp4_core.inc"
#include "model.inc"
#include "fastmath.inc"
#include "drag.inc"
#include "xp_theory.inc"
#include "store.inc"
#include "gcrf.inc"
#include "pool.inc"
#include "fit.inc"
#include "abi.inc"
#include "twobody.inc"
#include "events.inc"
#include "omm.inc"
#include "covariance.inc"
#include "pcf.inc"
#include "oem.inc"
#include "epoch_store.inc"
#include "fit_oem.inc"
#include "events_method.inc"

// ---- Display quantities (the module's own conversions, so a tool does no physics of its own) ----------------------

/// The mean elements of row `index` (an SGP4XP set of sdnap_init_elements / plugin_init_omm) at `minutes`
/// from its epoch, from the theory's integrated mean equinoctial state: out = a (km), e, i, RAAN, argument of
/// pericenter, mean anomaly (deg, [0, 360)), TEME of date. An SGP4 set, an unknown row or a refused set: an error code.
SDNAP_EXPORT("sdnap_mean_elements_at")
int32_t sdnap_mean_elements_at(uint32_t index, double minutes, double* out) {
  sdnap::Store& st = sdnap::store();
  if (out == nullptr || index >= st.count || st.kind[index] != 1) return ORBPRO_PROP_BAD_INPUT;
  sdnap::xpt::XpSat& s = st.xps[st.slot[index]];
  if (s.init_error != 0) return ORBPRO_PROP_UNPHYSICAL;
  double y[6];
  if (!sdnap::xpt::mean_at(s, minutes, y)) return ORBPRO_PROP_UNPHYSICAL;
  const sdnap::xpt::Kepler k = sdnap::xpt::kepler_of(y);
  const double deg = 180.0 / sdnap::kPi;
  out[0] = k.a * sdnap::xpt::kRe;
  out[1] = k.e;
  out[2] = k.i * deg;
  out[3] = k.node * deg;
  out[4] = k.argp * deg;
  out[5] = k.m * deg;
  return ORBPRO_PROP_OK;
}

/// The mean motion (rev/day) an SGP4XP set carries for a mean semi-major axis `a_km` (km), eccentricity `e`
/// and inclination `i_deg` (deg): the inverse of sdnap_mean_elements_at, whose a is the theory's own
/// (k_e / n)^(2/3) of the set's (Brouwer) mean motion (SPEC 1.1, 1.5); e and i do not enter that relation and are checked
/// only. NaN for a <= 0, e outside [0, 1) or a non-finite i.
SDNAP_EXPORT("sdnap_mean_motion_of")
double sdnap_mean_motion_of(double a_km, double e, double i_deg) {
  if (!(a_km > 0.0) || !(e >= 0.0) || !(e < 1.0) || !std::isfinite(i_deg)) return std::numeric_limits<double>::quiet_NaN();
  const double a_er = a_km / sdnap::xpt::kRe;
  const double n = sdnap::xpt::kKe / (a_er * std::sqrt(a_er));  // rad/min
  return n * sdnap::kMinutesPerDay / sdnap::kTwoPi;
}

/// The osculating elements of a TEME state (km, km/s) about the Earth theories' gravitational parameter: out = a (km),
/// e, i, RAAN, argument of pericenter, mean anomaly (deg, [0, 360); an open orbit: a < 0, the hyperbolic mean anomaly).
/// 0, or ORBPRO_PROP_BAD_INPUT for a degenerate state.
SDNAP_EXPORT("sdnap_osculating_elements")
int32_t sdnap_osculating_elements(const double* r, const double* v, double* out) {
  if (r == nullptr || v == nullptr || out == nullptr) return ORBPRO_PROP_BAD_INPUT;
  double el[6];
  if (!sdnap::twobody::elements_of(sdnap::events::mu_xp(), r, v, el)) return ORBPRO_PROP_BAD_INPUT;
  const double deg = 180.0 / sdnap::kPi;
  out[0] = el[0];
  out[1] = el[1];
  out[2] = el[2] * deg;
  for (int j = 3; j < 6; ++j) out[j] = sdnap::xpt::wrap(el[j]) * deg;
  return ORBPRO_PROP_OK;
}

/// The TEME state (6 doubles: km, km/s) of osculating elements (a km, e, i, Omega, omega, u deg; u the argument of
/// latitude) at the UTC split Julian date whole + frac in frame 0 TEME, 1 GCRF, 2 EME2000: the inverse of
/// sdnap_osculating_elements (the exports E2E's reference). 0, or -1 for an open or degenerate orbit or an unknown frame.
SDNAP_EXPORT("sdnap_state_of_elements")
int32_t sdnap_state_of_elements(double whole, double frac, const double* el, int32_t frame, double* out) {
  using namespace sdnap;
  const double a = el[0], e = el[1], inc = el[2] * kDeg, node = el[3] * kDeg, argp = el[4] * kDeg, u = el[5] * kDeg;
  if (!(a > 0.0) || !(e >= 0.0 && e < 1.0) || frame < 0 || frame > 2) return -1;
  const double nu = u - argp;
  const double E = std::atan2(std::sqrt(1.0 - e * e) * std::sin(nu), e + std::cos(nu));
  const double kep[6] = {a, e, inc, node, argp, E - e * std::sin(E)};
  double rr[3], vv[3];
  if (!twobody::state_of(events::mu_xp(), kep, rr, vv)) return -1;
  if (frame == 0) {
    for (int c = 0; c < 3; ++c) { out[c] = rr[c]; out[3 + c] = vv[c]; }
    return 0;
  }
  double g[3], gv[3], m[3][3];
  if (frame == 2) {
    double rb[3][3];
    frames::frame_bias(rb);
    frames::apply_transpose(rb, rr, g);  // EME2000 -> GCRF
    frames::apply_transpose(rb, vv, gv);
  } else {
    for (int c = 0; c < 3; ++c) { g[c] = rr[c]; gv[c] = vv[c]; }
  }
  if (frames::gcrf_to_teme(whole, frac, m) != 0) return -1;
  frames::apply(m, g, out);
  frames::apply(m, gv, out + 3);
  return 0;
}

/// A UVW vector (U radial, V in-track, W along r x v) of the state (r, v) in that state's axes (TEME).
SDNAP_EXPORT("sdnap_uvw_to_frame")
void sdnap_uvw_to_frame(const double* r, const double* v, const double* uvw, double* out) { sdnap::events::uvw_to_teme(r, v, uvw, out); }

/// A vector in the frame of the state (r, v) as its UVW components (U radial, V in-track, W along r x v): the mirror
/// of sdnap_uvw_to_frame. `out` may alias `vec`.
SDNAP_EXPORT("sdnap_frame_to_uvw")
void sdnap_frame_to_uvw(const double* r, const double* v, const double* vec, double* out) {
  double basis[3][3];
  for (int a = 0; a < 3; ++a) {
    const double e[3] = {a == 0 ? 1.0 : 0.0, a == 1 ? 1.0 : 0.0, a == 2 ? 1.0 : 0.0};
    sdnap::events::uvw_to_teme(r, v, e, basis[a]);  // the U, V and W unit vectors, in the frame
  }
  const double q[3] = {vec[0], vec[1], vec[2]};
  for (int a = 0; a < 3; ++a) out[a] = q[0] * basis[a][0] + q[1] * basis[a][1] + q[2] * basis[a][2];
}

/// The propagated covariance of an $OMM set (SPEC 12): `omm` (`length` bytes, plain or size-prefixed) an SGP4XP
/// set carrying COVARIANCE (as `fit` writes it: the epoch TEME covariance and USER_DEFINED_SDNAP_COV_x); at
/// each of `count` times (`minutes` from its epoch) `out` gets 42 doubles: the TEME state (km, km/s), then the 6 x 6
/// covariance row-major (km^2, km^2/s, km^2/s^2). 0, or -1 not a decodable Earth set, -2 no COVARIANCE, -3 the theory
/// refuses the set or does not reach a time, -4 an SGP4 set, -5 singular epoch columns, -6 a malformed covariance.
SDNAP_EXPORT("sdnap_covariance_at")
int32_t sdnap_covariance_at(const uint8_t* omm, uint32_t length, const double* minutes, uint32_t count, double* out) {
  if (omm == nullptr || (count > 0 && (minutes == nullptr || out == nullptr))) return -1;
  sdnap::ElementRow row{};
  if (!sdnap::omm::decode(omm, length, row)) return -1;
  if (row.theory != sdnap::kTheorySgp4Xp) return -4;
  sdnap::cov::Set set;
  const int rc = sdnap::cov::read(omm, length, row, set);
  if (rc == 0) return -2;
  if (rc < 0) return -6;
  sdnap::cov::Propagator p;
  if (const int pr = sdnap::cov::prepare(set, p)) return pr;
  for (uint32_t k = 0; k < count; ++k) {
    double* o = out + 42u * k;
    if (!sdnap::cov::eval(p, minutes[k], o, o + 3, o + 6)) return -3;
  }
  return 0;
}
