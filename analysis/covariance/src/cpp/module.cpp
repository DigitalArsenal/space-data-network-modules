/*
 * analysis/covariance — one object's covariance from its contributors (typed contracts 1.0).
 *
 *   compute_covariance
 *     in  "covariance"   one $SBC, REQUEST arm (SBCCovarianceRequest):
 *                          OBJECT_ID, EPOCH,
 *                          DIRECT_COVARIANCE   an $OCM; its first 21 COVARIANCE_DATA values are the 6x6 lower triangle
 *                                              (km**2 family); a covariance known only as per-axis one-sigma values is
 *                                              the diagonal one (sigma**2 on the diagonal, zeros elsewhere). Only the
 *                                              diagonal is combined, as before.
 *                          ELEMENT_SET_SERIES  $OMM records (SEMI_MAJOR_AXIS km, INCLINATION, RA_OF_ASC_NODE,
 *                                              MEAN_ANOMALY deg); their scatter about the mean is a contributor when
 *                                              there are at least two. SEMI_MAJOR_AXIS 0 (not stated) is 6778 km.
 *                          SENSOR_BIASES       RADIAL_M, IN_TRACK_M, CROSS_TRACK_M (measurement biases already taken
 *                                              onto RTN), each squared as an independent one-sigma variance.
 *     out "covariance"   an $OCM: the combined 6x6 lower triangle (diagonal) in COVARIANCE_DATA, LTM, COV_SIZE 6, at
 *                        EPOCH, COV_REF_FRAME the direct covariance's frame (an RFM named "RTN" when there is none).
 *     out "diagnostics"  an $SBC, DIAGNOSTICS arm: contributors, the variance each added (totals, then per sensor),
 *                        one-sigma position (m) and velocity (m/s), the covariance, the 3x3 position covariance, the
 *                        ellipsoid semi-axes (m, largest first) and the assumptions.
 *
 * No hostcalls, no JSON. The arithmetic is the legacy module's, value for value.
 */

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"
#include "SDS_generated.h"  // OCM, OMM, SBC and the families they include, generated and inlined by build.mjs

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kEarthMuKm3S2 = 398600.4418;
constexpr const char* kProvider = "covariance-analysis";

struct TleScatter {
  int sample_count = 0;
  double radial_variance_m2 = 0.0;
  double in_track_variance_m2 = 0.0;
  double cross_track_variance_m2 = 0.0;
  double velocity_variance_m2s2 = 0.0;
};

struct SensorBiasTerm {
  std::string sensor_id;
  double radial_variance_m2 = 0.0;
  double in_track_variance_m2 = 0.0;
  double cross_track_variance_m2 = 0.0;
};

struct SensorBiasSummary {
  int count = 0;
  double radial_variance_m2 = 0.0;
  double in_track_variance_m2 = 0.0;
  double cross_track_variance_m2 = 0.0;
  std::vector<SensorBiasTerm> terms;
};

double radians(double degrees) {
  return degrees * kPi / 180.0;
}

double wrap_radians(double angle) {
  while (angle > kPi) {
    angle -= kTwoPi;
  }
  while (angle < -kPi) {
    angle += kTwoPi;
  }
  return angle;
}

double sample_variance(const std::vector<double>& values) {
  if (values.size() < 2) {
    return 0.0;
  }
  double mean = 0.0;
  for (double value : values) {
    mean += value;
  }
  mean /= static_cast<double>(values.size());
  double sum = 0.0;
  for (double value : values) {
    const double residual = value - mean;
    sum += residual * residual;
  }
  return sum / static_cast<double>(values.size() - 1);
}

TleScatter compute_tle_scatter(const flatbuffers::Vector<flatbuffers::Offset<OMM>>* series) {
  TleScatter scatter{};
  const size_t count = series ? series->size() : 0;
  scatter.sample_count = static_cast<int>(count);
  if (count < 2) {
    return scatter;
  }

  std::vector<double> semi_major_axis_km;
  std::vector<double> inclination_rad;
  std::vector<double> raan_rad;
  std::vector<double> mean_anomaly_rad;
  semi_major_axis_km.reserve(count);
  inclination_rad.reserve(count);
  raan_rad.reserve(count);
  mean_anomaly_rad.reserve(count);

  for (const OMM* omm : *series) {
    const double axis = omm->SEMI_MAJOR_AXIS();
    semi_major_axis_km.push_back(axis != 0.0 ? axis : 6778.0);
    inclination_rad.push_back(radians(omm->INCLINATION()));
    raan_rad.push_back(radians(omm->RA_OF_ASC_NODE()));
    mean_anomaly_rad.push_back(radians(omm->MEAN_ANOMALY()));
  }

  double mean_axis_km = 0.0;
  double mean_inclination = 0.0;
  double mean_raan = 0.0;
  double mean_anomaly = 0.0;
  for (size_t index = 0; index < count; ++index) {
    mean_axis_km += semi_major_axis_km[index];
    mean_inclination += inclination_rad[index];
    mean_raan += raan_rad[index];
    mean_anomaly += mean_anomaly_rad[index];
  }
  mean_axis_km /= static_cast<double>(count);
  mean_inclination /= static_cast<double>(count);
  mean_raan /= static_cast<double>(count);
  mean_anomaly /= static_cast<double>(count);

  std::vector<double> radial_m;
  std::vector<double> in_track_m;
  std::vector<double> cross_track_m;
  radial_m.reserve(count);
  in_track_m.reserve(count);
  cross_track_m.reserve(count);
  const double mean_radius_m = mean_axis_km * 1000.0;
  for (size_t index = 0; index < count; ++index) {
    radial_m.push_back((semi_major_axis_km[index] - mean_axis_km) * 1000.0);
    in_track_m.push_back(mean_radius_m * wrap_radians(mean_anomaly_rad[index] - mean_anomaly));
    const double inclination_residual = inclination_rad[index] - mean_inclination;
    const double raan_residual = std::sin(std::max(0.0, mean_inclination)) *
      wrap_radians(raan_rad[index] - mean_raan);
    cross_track_m.push_back(mean_radius_m * std::hypot(inclination_residual, raan_residual));
  }

  scatter.radial_variance_m2 = sample_variance(radial_m);
  scatter.in_track_variance_m2 = sample_variance(in_track_m);
  scatter.cross_track_variance_m2 = sample_variance(cross_track_m);

  const double orbital_period_s = kTwoPi *
    std::sqrt(std::pow(std::max(mean_axis_km, 1.0), 3.0) / kEarthMuKm3S2);
  const double time_scale_s = std::max(600.0, orbital_period_s / 6.0);
  scatter.velocity_variance_m2s2 =
    (scatter.radial_variance_m2 + scatter.in_track_variance_m2 + scatter.cross_track_variance_m2) /
    (3.0 * time_scale_s * time_scale_s);
  return scatter;
}

SensorBiasSummary compute_sensor_biases(const flatbuffers::Vector<flatbuffers::Offset<SBCBiasTerm>>* biases) {
  SensorBiasSummary summary{};
  summary.count = biases ? static_cast<int>(biases->size()) : 0;
  if (!biases) return summary;
  for (const SBCBiasTerm* entry : *biases) {
    const double radial = entry->RADIAL_M();
    const double in_track = entry->IN_TRACK_M();
    const double cross_track = entry->CROSS_TRACK_M();
    SensorBiasTerm term;
    term.sensor_id = entry->SENSOR_ID() ? entry->SENSOR_ID()->str() : "";
    term.radial_variance_m2 = radial * radial;
    term.in_track_variance_m2 = in_track * in_track;
    term.cross_track_variance_m2 = cross_track * cross_track;
    summary.radial_variance_m2 += term.radial_variance_m2;
    summary.in_track_variance_m2 += term.in_track_variance_m2;
    summary.cross_track_variance_m2 += term.cross_track_variance_m2;
    summary.terms.push_back(std::move(term));
  }
  return summary;
}

std::vector<double> lower_triangular_from_diagonal(const std::array<double, 6>& diagonal) {
  std::vector<double> lower;
  lower.reserve(21);
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column <= row; ++column) {
      lower.push_back(row == column ? diagonal[static_cast<size_t>(row)] : 0.0);
    }
  }
  return lower;
}

std::vector<double> position_matrix_from_diagonal(const std::array<double, 6>& diagonal) {
  return {
    diagonal[0], 0.0, 0.0,
    0.0, diagonal[1], 0.0,
    0.0, 0.0, diagonal[2],
  };
}

std::vector<double> sorted_position_axes_m(const std::array<double, 6>& diagonal) {
  std::vector<double> axes = {
    std::sqrt(std::max(0.0, diagonal[0])) * 1000.0,
    std::sqrt(std::max(0.0, diagonal[1])) * 1000.0,
    std::sqrt(std::max(0.0, diagonal[2])) * 1000.0,
  };
  std::sort(axes.begin(), axes.end(), std::greater<double>());
  return axes;
}

std::string frame_name_of(const RFM* frame) {
  if (!frame) return "";
  if (frame->NAME() && frame->NAME()->size() > 0) return frame->NAME()->str();
  if (const auto* c = frame->REFERENCE_FRAME_as_CelestialFrameWrapper()) return EnumNameCelestialFrame(c->frame());
  if (const auto* o = frame->REFERENCE_FRAME_as_OrbitFrameWrapper()) return EnumNameOrbitFrame(o->frame());
  return "";
}

int fail(const char* code, const char* message, int status = 400) {
  plugin_set_error(code, message);
  return status;
}

const SBC* read_request(const plugin_input_frame_t* frame) {
  if (!frame || !frame->payload || frame->payload_length == 0) return nullptr;
  const uint8_t* data = frame->payload;
  const size_t size = frame->payload_length;
  if (size >= 8 && SBCBufferHasIdentifier(data)) {
    flatbuffers::Verifier verifier(data, size);
    return VerifySBCBuffer(verifier) ? GetSBC(data) : nullptr;
  }
  if (size >= 12 && flatbuffers::BufferHasIdentifier(data, SBCIdentifier(), true)) {
    flatbuffers::Verifier verifier(data, size);
    return VerifySizePrefixedSBCBuffer(verifier) ? GetSizePrefixedSBC(data) : nullptr;
  }
  return nullptr;
}

int push(const char* port, const char* schema, const char* identifier, const char* root, flatbuffers::FlatBufferBuilder& b) {
  return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0,
                               b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
}

}  // namespace

extern "C" int compute_covariance(void) {
  plugin_reset_output_state();

  const int32_t index = plugin_find_input_index("covariance", 0);
  if (index < 0) {
    return fail("missing-covariance", "Input port \"covariance\" is required.");
  }
  const SBC* sbc = read_request(plugin_get_input_frame(static_cast<uint32_t>(index)));
  if (!sbc) {
    return fail("invalid-covariance", "Input port \"covariance\" must carry one valid $SBC.");
  }
  const SBCCovarianceRequest* request = sbc->REQUEST();
  if (!request) {
    return fail("invalid-covariance", "The $SBC on \"covariance\" must carry its REQUEST arm.");
  }

  std::array<double, 6> diagonal{};
  const OCM* direct = request->DIRECT_COVARIANCE();
  const bool has_direct = direct != nullptr;
  if (has_direct) {
    const auto* data = direct->COVARIANCE_DATA();
    if (!data || data->size() < 21) {
      return fail("invalid-covariance", "DIRECT_COVARIANCE must carry 21 COVARIANCE_DATA values (the 6x6 lower triangle).");
    }
    diagonal = {data->Get(0), data->Get(2), data->Get(5), data->Get(9), data->Get(14), data->Get(20)};
  }
  const std::array<double, 6> direct_diagonal = diagonal;

  const TleScatter tle = compute_tle_scatter(request->ELEMENT_SET_SERIES());
  diagonal[0] += tle.radial_variance_m2 * 1.0e-6;
  diagonal[1] += tle.in_track_variance_m2 * 1.0e-6;
  diagonal[2] += tle.cross_track_variance_m2 * 1.0e-6;
  diagonal[3] += tle.velocity_variance_m2s2 * 1.0e-6;
  diagonal[4] += tle.velocity_variance_m2s2 * 1.0e-6;
  diagonal[5] += tle.velocity_variance_m2s2 * 1.0e-6;

  const SensorBiasSummary biases = compute_sensor_biases(request->SENSOR_BIASES());
  diagonal[0] += biases.radial_variance_m2 * 1.0e-6;
  diagonal[1] += biases.in_track_variance_m2 * 1.0e-6;
  diagonal[2] += biases.cross_track_variance_m2 * 1.0e-6;

  const auto lower = lower_triangular_from_diagonal(diagonal);
  const auto position = position_matrix_from_diagonal(diagonal);
  const auto axes = sorted_position_axes_m(diagonal);

  const std::string object_id = request->OBJECT_ID() ? request->OBJECT_ID()->str() : "UNKNOWN";
  const std::string epoch = request->EPOCH() ? request->EPOCH()->str() : "";
  const std::string direct_frame = has_direct ? frame_name_of(direct->COV_REF_FRAME()) : "";
  const std::string frame = direct_frame.empty() ? "RTN" : direct_frame;

  // The combined covariance: an $OCM at the request epoch.
  {
    OCMT ocm;
    ocm.HEADER = std::make_unique<HeaderT>();
    ocm.HEADER->CCSDS_OCM_VERS = "3.0";
    ocm.HEADER->ORIGINATOR = kProvider;
    ocm.METADATA = std::make_unique<MetadataT>();
    ocm.METADATA->OBJECT_DESIGNATOR = object_id;
    ocm.METADATA->TIME_SYSTEM = "UTC";
    ocm.METADATA->EPOCH_TZERO = epoch;
    ocm.METADATA->START_TIME = epoch;
    ocm.METADATA->STOP_TIME = epoch;
    ocm.TRAJ_TYPE_DESCRIPTION = "COVARIANCE";
    ocm.CENTER_NAME = "EARTH";
    if (has_direct && direct->COV_REF_FRAME()) {
      ocm.COV_REF_FRAME = std::unique_ptr<RFMT>(direct->COV_REF_FRAME()->UnPack());
    } else {
      ocm.COV_REF_FRAME = std::make_unique<RFMT>();
      ocm.COV_REF_FRAME->NAME = frame;
    }
    if (!epoch.empty()) ocm.STATE_EPOCHS.push_back(epoch);
    ocm.COVARIANCE_DATA = lower;
    ocm.COV_ORDERING = covarianceOrdering::LTM;
    ocm.COV_SIZE = 6;
    flatbuffers::FlatBufferBuilder b(1024);
    FinishOCMBuffer(b, CreateOCM(b, &ocm));
    if (push("covariance", "OCM.fbs", OCMIdentifier(), "OCM", b) < 0) {
      return fail("output-failed", "Could not push the \"covariance\" $OCM.", 500);
    }
  }

  // The diagnostics: an $SBC DIAGNOSTICS arm.
  {
    auto diag = std::make_unique<SBCDiagnosticsT>();
    diag->OBJECT_ID = object_id;
    diag->EPOCH = epoch;
    diag->REFERENCE_FRAME = frame;
    diag->PROVIDER = kProvider;
    diag->STATUS = "nominal";
    if (has_direct) diag->CONTRIBUTORS.push_back(sbcContributorKind::DirectCovariance);
    if (tle.sample_count > 1) diag->CONTRIBUTORS.push_back(sbcContributorKind::ElementSetSeries);
    if (biases.count > 0) diag->CONTRIBUTORS.push_back(sbcContributorKind::SensorBias);

    auto contribution = [](sbcContributorKind kind, const std::string& sensor, uint32_t count, double r, double t,
                           double c, double v) {
      auto row = std::make_unique<SBCContributionT>();
      row->KIND = kind;
      row->SENSOR_ID = sensor;
      row->COUNT = count;
      row->RADIAL_VARIANCE_M2 = r;
      row->IN_TRACK_VARIANCE_M2 = t;
      row->CROSS_TRACK_VARIANCE_M2 = c;
      row->VELOCITY_VARIANCE_M2_S2 = v;
      return row;
    };
    // Totals first (the direct matrix's own diagonal in m**2; the series and the biases always, as the legacy report
    // always gave their sample and sensor counts), then one row per sensor.
    if (has_direct) {
      diag->CONTRIBUTIONS.push_back(contribution(sbcContributorKind::DirectCovariance, "", 1,
        direct_diagonal[0] * 1.0e6, direct_diagonal[1] * 1.0e6, direct_diagonal[2] * 1.0e6, 0.0));
    }
    diag->CONTRIBUTIONS.push_back(contribution(sbcContributorKind::ElementSetSeries, "",
      static_cast<uint32_t>(tle.sample_count), tle.radial_variance_m2, tle.in_track_variance_m2,
      tle.cross_track_variance_m2, tle.velocity_variance_m2s2));
    diag->CONTRIBUTIONS.push_back(contribution(sbcContributorKind::SensorBias, "",
      static_cast<uint32_t>(biases.count), biases.radial_variance_m2, biases.in_track_variance_m2,
      biases.cross_track_variance_m2, 0.0));
    for (const auto& term : biases.terms) {
      diag->CONTRIBUTIONS.push_back(contribution(sbcContributorKind::SensorBias, term.sensor_id, 1,
        term.radial_variance_m2, term.in_track_variance_m2, term.cross_track_variance_m2, 0.0));
    }

    diag->POSITION_SIGMA_RTN_M = {
      std::sqrt(std::max(0.0, diagonal[0])) * 1000.0,
      std::sqrt(std::max(0.0, diagonal[1])) * 1000.0,
      std::sqrt(std::max(0.0, diagonal[2])) * 1000.0,
    };
    diag->VELOCITY_SIGMA_RTN_M_S = {
      std::sqrt(std::max(0.0, diagonal[3])) * 1000.0,
      std::sqrt(std::max(0.0, diagonal[4])) * 1000.0,
      std::sqrt(std::max(0.0, diagonal[5])) * 1000.0,
    };
    diag->COVARIANCE_LOWER_TRIANGLE = lower;
    diag->POSITION_COVARIANCE_KM2 = position;
    diag->ELLIPSOID_SIGMA_LEVEL = 1.0;
    diag->ELLIPSOID_SEMI_AXES_M = axes;
    diag->ASSUMPTIONS = {
      "direct covariance is interpreted in RTN order",
      "TLE-series covariance uses synthetic mean element residuals",
      "sensor biases are independent one-sigma variance contributors",
    };
    SBCT out;
    out.DIAGNOSTICS = std::move(diag);
    flatbuffers::FlatBufferBuilder b(1024);
    FinishSBCBuffer(b, CreateSBC(b, &out));
    if (push("diagnostics", "SBC.fbs", SBCIdentifier(), "SBC", b) < 0) {
      return fail("output-failed", "Could not push the \"diagnostics\" $SBC.", 500);
    }
  }
  return 0;
}
