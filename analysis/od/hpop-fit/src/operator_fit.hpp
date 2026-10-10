// The operator-ephemeris fit, end to end, in memory: one ephemeris in, an
// SGP4 OMM and a full-force HPOP solution out, each with exact statistics over
// every ephemeris point of its span and a half-split closure; the reference
// OMM (CelesTrak SupGP or the Space-Track OMM) scored on the same points as
// the frame-error gate. Nothing here keeps the ephemeris.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "hpop_fit.hpp"
#include "od/sgp4_fitter.h"
#include "residual_stats.hpp"
#include "time_frames.hpp"

namespace odhpop {

struct OperatorFitOptions {
  std::string input_format;  // "meme", "oem", "oem-fb" or "" (detect)
  std::string data_source;
  std::string object_name;
  std::string object_id;
  int norad_cat_id = 0;
  // SGP4 OMM window: [anchor + omm_start_s, + omm_span_s]. The anchor is the
  // first point, or the reference's epoch ("reference"), CelesTrak's window.
  std::string omm_anchor = "first";
  double omm_start_s = 0.0;
  double omm_span_s = 11520.0;
  // HPOP span from the first point of the first maneuver-free segment;
  // 0: the whole segment.
  double hpop_span_s = 86400.0;
  std::size_t maximum_fit_points = 720;
  bool closure = true;
  bool hpop = true;
  // Gates.
  double reference_rms_max_km = 5.0;
  double hpop_rms_max_km = 50.0;
  // Segmenting.
  double gap_factor = 3.0;
  double jump_k = 10.0;
  double jump_floor_m_s2 = 1e-6;
  ForceModel forces;  // full force by default
};

struct Segment {
  std::size_t begin = 0, end = 0;  // sample indices, [begin, end)
  std::vector<std::string> evidence;  // how it was found maneuver-free / why it ends
};

struct ClosureResult {
  bool done = false;
  UtcEpoch split;
  ResidualStats first_half;  // the half fit's own exact stats
  ResidualStats second_half;  // the closure
  double max_r_km = 0, max_t_km = 0, max_n_km = 0;
  std::string error;
};

struct SgpResult {
  bool ok = false;
  std::string error;
  od::SGP4Elements elements;
  UtcEpoch epoch;
  ResidualStats stats;  // every point of the window, TEME km
  std::size_t fit_points = 0;
  ClosureResult closure;
  bool has_reference = false;
  ResidualStats reference;  // the reference OMM on the same points
  bool reference_gate_pass = true;
};

struct HpopResult {
  bool ok = false;
  std::string error;
  FitResult fit;
  ResidualStats stats;  // every point of the span
  ClosureResult closure;
  Segment segment;
};

struct OperatorFitResult {
  bool ok = false;  // every product built and every gate passed
  std::string failure_code;
  std::string failure_message;
  std::string raw_sha256;
  std::size_t raw_bytes = 0;
  std::string format, source_frame, time_system;
  std::string object_name, object_id;
  int norad_cat_id = 0;
  std::size_t samples = 0;
  UtcEpoch first, last;
  std::vector<Segment> segments;
  SgpResult sgp4;
  HpopResult hpop;
};

struct Reference {
  bool present = false;
  od::SGP4Elements elements;
  UtcEpoch epoch;
};

OperatorFitResult fit_operator_ephemeris(const uint8_t* bytes, std::size_t size, const Reference& reference,
                                         const Environment& env, const OperatorFitOptions& options);

// SGP4 of `el` (epoch `epoch`) at `t`: TEME km, km/s.
bool sgp4_at(const od::SGP4Elements& el, const UtcEpoch& epoch, const UtcEpoch& t, std::array<double, 6>* teme_km);

}  // namespace odhpop
