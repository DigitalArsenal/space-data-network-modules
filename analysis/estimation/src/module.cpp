#include "space_data_module_invoke.h"
#include "estimation.hpp"
#include "Estimation_generated.h"
#include "ODR_generated.h"
#include "OCM_generated.h"
#include "TDM_generated.h"
#include "CRD_generated.h"
#include "MEM_generated.h"
#include "TRH_generated.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace {

namespace core = ::sdn::estimation;
namespace wire = ::orbpro::estimation;

const plugin_input_frame_t* input(const char* port) {
  const int32_t index = plugin_find_input_index(port, 0);
  return index < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(index));
}

int fail(const char* code, const char* message) {
  plugin_set_error(code, message);
  return 3;
}

double relative_seconds(const wire::EstimationEpoch& epoch,
                        const wire::EstimationEpoch& reference) {
  return (epoch.jd_day() - reference.jd_day()) * 86400.0 +
         epoch.seconds() - reference.seconds();
}

wire::EstimationEpoch absolute_epoch(double relative,
                                     const wire::EstimationEpoch& reference) {
  double day = reference.jd_day();
  double seconds = reference.seconds() + relative;
  while (seconds >= 86400.0) { seconds -= 86400.0; day += 1.0; }
  while (seconds < 0.0) { seconds += 86400.0; day -= 1.0; }
  return wire::EstimationEpoch(day, seconds);
}

std::string epoch_text(double relative, const wire::EstimationEpoch& reference) {
  const wire::EstimationEpoch epoch = absolute_epoch(relative, reference);
  char text[64] = {};
  std::snprintf(text, sizeof text, "JD %.0f + %.9f s", epoch.jd_day(), epoch.seconds());
  return text;
}

core::Observation observation_from_wire(const wire::EstimationObservation& source,
                                        const wire::EstimationEpoch& reference,
                                        bool strict = false) {
  core::Observation out;
  out.epoch_seconds = relative_seconds(source.epoch(), reference);
  out.kind = static_cast<core::MeasurementKind>(source.kind());
  out.value_count = strict ? source.value_count() : std::min<std::uint8_t>(source.value_count(), 4);
  for (int i = 0; i < 4; ++i) {
    out.value[i] = source.value()->Get(i);
    out.sigma[i] = strict || source.sigma()->Get(i) > 0.0 ? source.sigma()->Get(i) : 1.0;
  }
  out.station_position_m = {source.station_position_m()->Get(0),
                            source.station_position_m()->Get(1),
                            source.station_position_m()->Get(2)};
  out.station_velocity_mps = {source.station_velocity_mps()->Get(0),
                              source.station_velocity_mps()->Get(1),
                              source.station_velocity_mps()->Get(2)};
  out.station_east = {source.station_east()->Get(0),
                      source.station_east()->Get(1),
                      source.station_east()->Get(2)};
  out.station_north = {source.station_north()->Get(0),
                       source.station_north()->Get(1),
                       source.station_north()->Get(2)};
  out.station_up = {source.station_up()->Get(0),
                    source.station_up()->Get(1),
                    source.station_up()->Get(2)};
  out.remote_position_m = {source.remote_position_m()->Get(0),
                           source.remote_position_m()->Get(1),
                           source.remote_position_m()->Get(2)};
  out.remote_velocity_mps = {source.remote_velocity_mps()->Get(0),
                             source.remote_velocity_mps()->Get(1),
                             source.remote_velocity_mps()->Get(2)};
  out.hardware.transmitter_delay_seconds = source.transmitter_delay_seconds();
  out.hardware.receiver_delay_seconds = source.receiver_delay_seconds();
  out.hardware.transponder_delay_seconds = source.transponder_delay_seconds();
  out.hardware.turnaround_numerator = source.turnaround_numerator() == 0
                                          ? 1 : source.turnaround_numerator();
  out.hardware.turnaround_denominator = source.turnaround_denominator() == 0
                                            ? 1 : source.turnaround_denominator();
  out.media.elevation_rad = source.elevation_rad();
  out.media.latitude_rad = source.station_latitude_rad();
  out.media.height_m = source.station_height_m();
  out.media.pressure_hpa = source.pressure_hpa() > 0.0 ? source.pressure_hpa() : 1013.25;
  out.media.temperature_k = source.temperature_k() > 0.0 ? source.temperature_k() : 293.15;
  out.media.relative_humidity = source.relative_humidity();
  out.media.wavelength_m = source.wavelength_m() > 0.0 ? source.wavelength_m() : 0.532e-6;
  out.media.total_electron_content = source.total_electron_content();
  out.media.total_electron_content_rate_per_second = source.total_electron_content_rate_per_second();
  out.media.frequency_hz = source.frequency_hz() > 0.0 ? source.frequency_hz() : 8.4e9;
  out.apply_light_time = (source.flags() & 0x01u) == 0;
  out.apply_sagnac = (source.flags() & 0x02u) == 0;
  out.transmitter_index = source.transmitter_index();
  out.receiver_index = source.receiver_index();
  return out;
}

core::ErrorModel error_model_from_wire(const wire::EstimationErrorModel& source) {
  core::ErrorModel out;
  out.kind = static_cast<core::MeasurementKind>(source.measurement_kind());
  out.noise_sigma = source.noise_sigma();
  out.bias = source.bias();
  out.bias_sigma = source.bias_sigma();
  out.sigma_edit_threshold = source.sigma_edit_threshold();
  out.seed = source.random_seed();
  return out;
}

void apply_error_models(const wire::EstimationRequest* request,
                        std::vector<core::Observation>* observations,
                        std::vector<core::ErrorModel>* models) {
  if (request->error_models() == nullptr) return;
  for (const wire::EstimationErrorModel* source : *request->error_models()) {
    if (source == nullptr) continue;
    models->push_back(error_model_from_wire(*source));
    for (core::Observation& observation : *observations) {
      if (observation.kind != static_cast<core::MeasurementKind>(source->measurement_kind())) continue;
      observation.troposphere = static_cast<core::TroposphereModel>(source->troposphere());
      observation.ionosphere = static_cast<core::IonosphereModel>(source->ionosphere());
      if (source->noise_sigma() > 0.0) {
        for (int i = 0; i < observation.value_count; ++i) {
          observation.sigma[i] = source->noise_sigma();
        }
      }
      if ((source->flags() & 0x01u) != 0) observation.apply_light_time = false;
      if ((source->flags() & 0x02u) != 0) observation.apply_sagnac = false;
    }
  }
}

bool apply_mem_record(const plugin_input_frame_t* frame,
                      std::vector<core::Observation>* observations,
                      std::vector<core::ErrorModel>* models) {
  if (frame == nullptr) return true;
  if (frame->payload == nullptr || frame->payload_length == 0 ||
      !MEMBufferHasIdentifier(frame->payload)) return false;
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyMEMBuffer(verifier)) return false;
  const MEM* record = GetMEM(frame->payload);
  if (record == nullptr || record->ERROR_MODELS() == nullptr) return true;
  for (const MEMErrorModel* source : *record->ERROR_MODELS()) {
    if (source == nullptr || source->MEASUREMENT_TYPE() == memMeasurementType::UNSPECIFIED) continue;
    const auto ordinal = static_cast<std::uint16_t>(source->MEASUREMENT_TYPE());
    if (ordinal < 1 || ordinal > 21) continue;
    core::ErrorModel model;
    model.kind = static_cast<core::MeasurementKind>(ordinal - 1);
    model.noise_sigma = source->NOISE_SIGMA();
    model.bias = source->BIAS();
    model.bias_sigma = source->BIAS_SIGMA();
    model.sigma_edit_threshold = source->SIGMA_EDIT_THRESHOLD();
    model.seed = record->RANDOM_SEED() == 0 ? 1 : record->RANDOM_SEED();
    models->push_back(model);
    for (core::Observation& observation : *observations) {
      if (observation.kind != model.kind) continue;
      if (model.noise_sigma > 0.0) {
        for (int i = 0; i < observation.value_count; ++i) {
          observation.sigma[i] = model.noise_sigma;
        }
      }
      const auto troposphere = static_cast<std::uint8_t>(source->TROPOSPHERE_MODEL());
      const auto ionosphere = static_cast<std::uint8_t>(source->IONOSPHERE_MODEL());
      if (troposphere > 0) {
        observation.troposphere = static_cast<core::TroposphereModel>(troposphere - 1);
      }
      if (ionosphere > 0) {
        observation.ionosphere = static_cast<core::IonosphereModel>(ionosphere - 1);
      }
      observation.apply_light_time = source->APPLY_LIGHT_TIME();
      observation.apply_sagnac = source->APPLY_BODY_ROTATION();
    }
  }
  return true;
}

double antenna_delay(const TRH* record, const ::flatbuffers::String* hardware_id) {
  if (record == nullptr || hardware_id == nullptr || record->ANTENNAS() == nullptr) return 0.0;
  for (const TRHAntenna* antenna : *record->ANTENNAS()) {
    if (antenna != nullptr && antenna->HARDWARE_ID() != nullptr &&
        antenna->HARDWARE_ID()->str() == hardware_id->str()) {
      return antenna->PHASE_CENTER_DELAY_SECONDS();
    }
  }
  return 0.0;
}

bool apply_trh_record(const plugin_input_frame_t* frame,
                      std::vector<core::Observation>* observations) {
  if (frame == nullptr) return true;
  if (frame->payload == nullptr || frame->payload_length == 0 ||
      !TRHBufferHasIdentifier(frame->payload)) return false;
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyTRHBuffer(verifier)) return false;
  const TRH* record = GetTRH(frame->payload);
  if (record == nullptr) return false;
  for (core::Observation& observation : *observations) {
    if (record->TRANSMITTERS() != nullptr &&
        observation.transmitter_index < record->TRANSMITTERS()->size()) {
      const TRHTransmitter* transmitter = record->TRANSMITTERS()->Get(
          observation.transmitter_index);
      if (transmitter != nullptr) {
        observation.hardware.transmitter_delay_seconds =
            transmitter->HARDWARE_DELAY_SECONDS() +
            antenna_delay(record, transmitter->ANTENNA_ID());
        if (transmitter->FREQUENCY_HZ() > 0.0) {
          observation.media.frequency_hz = transmitter->FREQUENCY_HZ();
        }
      }
    }
    if (record->RECEIVERS() != nullptr &&
        observation.receiver_index < record->RECEIVERS()->size()) {
      const TRHReceiver* receiver = record->RECEIVERS()->Get(observation.receiver_index);
      if (receiver != nullptr) {
        observation.hardware.receiver_delay_seconds =
            receiver->HARDWARE_DELAY_SECONDS() + antenna_delay(record, receiver->ANTENNA_ID());
        if (!(observation.media.frequency_hz > 0.0) && receiver->CENTER_FREQUENCY_HZ() > 0.0) {
          observation.media.frequency_hz = receiver->CENTER_FREQUENCY_HZ();
        }
      }
    }
    if (record->TRANSPONDERS() != nullptr && record->TRANSPONDERS()->size() > 0) {
      const TRHTransponder* transponder = record->TRANSPONDERS()->Get(0);
      if (transponder != nullptr) {
        observation.hardware.transponder_delay_seconds = transponder->GROUP_DELAY_SECONDS();
        observation.hardware.turnaround_numerator =
            transponder->TURNAROUND_NUMERATOR() == 0 ? 1 : transponder->TURNAROUND_NUMERATOR();
        observation.hardware.turnaround_denominator =
            transponder->TURNAROUND_DENOMINATOR() == 0 ? 1 : transponder->TURNAROUND_DENOMINATOR();
      }
    }
  }
  return true;
}

bool apply_crd_station(const plugin_input_frame_t* frame,
                       std::vector<core::Observation>* observations) {
  if (frame == nullptr) return true;
  if (frame->payload == nullptr || frame->payload_length == 0 ||
      !CRDBufferHasIdentifier(frame->payload)) return false;
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyCRDBuffer(verifier)) return false;
  const CRD* record = GetCRD(frame->payload);
  if (record == nullptr) return false;
  for (core::Observation& observation : *observations) {
    if (observation.kind != core::MeasurementKind::LASER_RANGE) continue;
    observation.station_position_m = {record->X(), record->Y(), record->Z()};
    observation.station_velocity_mps = {record->VX(), record->VY(), record->VZ()};
  }
  return true;
}

// Howard Hinnant's civil-date transform, used only to align authoritative TDM
// epochs with the request epoch. No orbit or measurement physics lives here.
std::int64_t days_from_civil(int year, unsigned month, unsigned day) {
  year -= month <= 2;
  const int era = (year >= 0 ? year : year - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(year - era * 400);
  const unsigned doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return static_cast<std::int64_t>(era) * 146097 + static_cast<int>(doe) - 719468;
}

bool iso_seconds(const char* text, double* result) {
  if (text == nullptr || result == nullptr) return false;
  int year = 0, month = 0, day = 0, hour = 0, minute = 0;
  double second = 0.0;
  if (std::sscanf(text, "%d-%d-%dT%d:%d:%lf", &year, &month, &day, &hour, &minute,
                  &second) != 6) return false;
  *result = static_cast<double>(days_from_civil(year, static_cast<unsigned>(month),
                                                static_cast<unsigned>(day))) * 86400.0 +
            hour * 3600.0 + minute * 60.0 + second;
  return true;
}

bool tdm_kind(const char* keyword, const char* angle_type, const char* range_mode,
              core::MeasurementKind* kind, std::uint8_t* count) {
  if (keyword == nullptr) return false;
  const std::string key(keyword);
  const std::string angle = angle_type == nullptr ? "" : angle_type;
  const std::string mode = range_mode == nullptr ? "" : range_mode;
  *count = 1;
  if (key == "RANGE") {
    *kind = mode.find("PN") != std::string::npos ? core::MeasurementKind::PSEUDONOISE_RANGE
           : mode.find("SEQUENTIAL") != std::string::npos ? core::MeasurementKind::SEQUENTIAL_RANGE
           : core::MeasurementKind::RANGE;
  } else if (key == "RANGE_RATE") *kind = core::MeasurementKind::RANGE_RATE;
  else if (key.find("DOPPLER") != std::string::npos) *kind = core::MeasurementKind::DOPPLER;
  else if (key.find("TRANSMIT_PHASE_CT") != std::string::npos) *kind = core::MeasurementKind::TIME_CORRELATED_PHASE;
  else if (key == "TDOA" || key == "VLBI_DELAY") *kind = core::MeasurementKind::TIME_DIFFERENCE_OF_ARRIVAL;
  else if (key == "FDOA") *kind = core::MeasurementKind::FREQUENCY_DIFFERENCE_OF_ARRIVAL;
  else if (key == "LASER_RANGE" || key == "SLR_RANGE") *kind = core::MeasurementKind::LASER_RANGE;
  else if (key == "CROSSLINK_RANGE") *kind = core::MeasurementKind::CROSSLINK_RANGE;
  else if (key == "CROSSLINK_RANGE_RATE") *kind = core::MeasurementKind::CROSSLINK_RANGE_RATE;
  else if (key == "BISTATIC_RANGE") *kind = core::MeasurementKind::BISTATIC_RANGE;
  else if (key == "SKIN_RANGE") *kind = core::MeasurementKind::SKIN_RANGE;
  else if (key == "ANGLE_1") {
    *count = 2;
    if (angle == "RADEC") *kind = core::MeasurementKind::RIGHT_ASCENSION_DECLINATION;
    else if (angle == "XEYN") *kind = core::MeasurementKind::X_EAST_Y_NORTH;
    else if (angle == "XSYE") *kind = core::MeasurementKind::X_SOUTH_Y_EAST;
    else *kind = core::MeasurementKind::AZIMUTH_ELEVATION;
  } else return false;
  return true;
}

void append_tdm_observations(const plugin_input_frame_t* frame,
                             const wire::EstimationEpoch& reference,
                             std::vector<core::Observation>* output) {
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0 ||
      !TDMBufferHasIdentifier(frame->payload)) return;
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyTDMBuffer(verifier)) return;
  const TDM* tdm = GetTDM(frame->payload);
  if (tdm == nullptr || tdm->SEGMENTS() == nullptr) return;
  const core::Vec3 station{tdm->OBSERVER_X(), tdm->OBSERVER_Y(), tdm->OBSERVER_Z()};
  const core::Vec3 station_velocity{tdm->OBSERVER_VX(), tdm->OBSERVER_VY(), tdm->OBSERVER_VZ()};
  const double reference_unix = (reference.jd_day() - 2440587.5) * 86400.0 + reference.seconds();
  for (const TDMSegment* segment : *tdm->SEGMENTS()) {
    if (segment == nullptr || segment->OBSERVATIONS() == nullptr) continue;
    const auto* rows = segment->OBSERVATIONS();
    for (std::size_t index = 0; index < rows->size(); ++index) {
      const TDMObservation* row = rows->Get(static_cast<::flatbuffers::uoffset_t>(index));
      if (row == nullptr || row->KEYWORD() == nullptr || row->EPOCH() == nullptr) continue;
      core::MeasurementKind kind{};
      std::uint8_t count = 0;
      if (!tdm_kind(row->KEYWORD()->c_str(),
                    segment->ANGLE_TYPE() == nullptr ? nullptr : segment->ANGLE_TYPE()->c_str(),
                    segment->RANGE_MODE() == nullptr ? nullptr : segment->RANGE_MODE()->c_str(),
                    &kind, &count)) continue;
      double unix_time = 0.0;
      if (!iso_seconds(row->EPOCH()->c_str(), &unix_time)) continue;
      core::Observation observation;
      observation.id = row->KEYWORD()->str() + ":" + row->EPOCH()->str();
      observation.epoch_seconds = unix_time - reference_unix;
      observation.kind = kind;
      observation.value_count = count;
      observation.value[0] = row->VALUE();
      observation.station_position_m = station;
      observation.station_velocity_mps = station_velocity;
      observation.media.frequency_hz = segment->TRANSMIT_FREQ_1() > 0.0
                                           ? segment->TRANSMIT_FREQ_1() : 8.4e9;
      observation.hardware.transmitter_delay_seconds = segment->TRANSMIT_DELAY_1();
      observation.hardware.receiver_delay_seconds = segment->RECEIVE_DELAY_1();
      observation.hardware.turnaround_numerator = segment->TURNAROUND_NUMERATOR() > 0
          ? static_cast<std::uint32_t>(segment->TURNAROUND_NUMERATOR()) : 1;
      observation.hardware.turnaround_denominator = segment->TURNAROUND_DENOMINATOR() > 0
          ? static_cast<std::uint32_t>(segment->TURNAROUND_DENOMINATOR()) : 1;
      if (kind == core::MeasurementKind::RANGE ||
          kind == core::MeasurementKind::SEQUENTIAL_RANGE ||
          kind == core::MeasurementKind::PSEUDONOISE_RANGE) {
        const std::string units = segment->RANGE_UNITS() == nullptr ? "km" : segment->RANGE_UNITS()->str();
        if (units == "km") observation.value[0] *= 1000.0;
        else if (units == "s") observation.value[0] *= core::kSpeedOfLight;
      }
      if (count == 2) {
        for (std::size_t next = index + 1; next < rows->size(); ++next) {
          const TDMObservation* companion = rows->Get(static_cast<::flatbuffers::uoffset_t>(next));
          if (companion != nullptr && companion->KEYWORD() != nullptr &&
              companion->EPOCH() != nullptr && companion->KEYWORD()->str() == "ANGLE_2" &&
              companion->EPOCH()->str() == row->EPOCH()->str()) {
            observation.value[1] = companion->VALUE();
            break;
          }
        }
      }
      output->push_back(observation);
    }
  }
}

bool decode_request(const plugin_input_frame_t* frame,
                    const wire::EstimationRequest** request,
                    const wire::EstimationEnvelope** envelope) {
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0 ||
      !wire::EstimationEnvelopeBufferHasIdentifier(frame->payload)) return false;
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!wire::VerifyEstimationEnvelopeBuffer(verifier)) return false;
  *envelope = wire::GetEstimationEnvelope(frame->payload);
  *request = *envelope == nullptr ? nullptr : (*envelope)->request();
  return *request != nullptr && (*request)->config() != nullptr &&
         (*request)->propagator_port_id() != nullptr &&
         (*request)->propagator_capability() != nullptr;
}

bool decode_samples(const plugin_input_frame_t* frame,
                    const wire::EstimationEpoch& reference,
                    std::vector<core::PropagatorSample>* samples) {
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0 ||
      !wire::EstimationEnvelopeBufferHasIdentifier(frame->payload)) return false;
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!wire::VerifyEstimationEnvelopeBuffer(verifier)) return false;
  const wire::EstimationEnvelope* envelope = wire::GetEstimationEnvelope(frame->payload);
  if (envelope == nullptr || envelope->propagator_samples() == nullptr) return false;
  const auto* source_samples = envelope->propagator_samples();
  samples->reserve(source_samples->size());
  for (const wire::EstimationPropagatorSample* source : *source_samples) {
    if (source == nullptr) return false;
    core::PropagatorSample sample;
    sample.state.epoch_seconds = relative_seconds(source->epoch(), reference);
    for (int i = 0; i < 6; ++i) sample.state.value[i] = source->state()->Get(i);
    for (int i = 0; i < 36; ++i) sample.stm[i] = source->stm()->Get(i);
    samples->push_back(sample);
  }
  return true;
}

std::unique_ptr<FRMStateVectorT> frm_state(const core::CartesianState& state,
                                           const wire::EstimationEpoch& reference) {
  auto result = std::make_unique<FRMStateVectorT>();
  result->REPRESENTATION = frmStateRepresentation::CARTESIAN;
  result->ELEMENTS.assign(state.value.begin(), state.value.end());
  result->POSITION = std::make_unique<FRMVector3T>();
  result->VELOCITY = std::make_unique<FRMVector3T>();
  result->POSITION->X = state.value[0]; result->POSITION->Y = state.value[1]; result->POSITION->Z = state.value[2];
  result->VELOCITY->X = state.value[3]; result->VELOCITY->Y = state.value[4]; result->VELOCITY->Z = state.value[5];
  result->COORDINATE_SYSTEM_NAME = "request-reference-frame";
  result->EPOCH = epoch_text(state.epoch_seconds, reference);
  result->EPOCH_TIME_SYSTEM = "TAI";
  return result;
}

std::string linked_ocm_id(const core::CartesianState& state, const char* trace) {
  std::uint64_t hash = 1469598103934665603ULL;
  for (double value : state.value) {
    std::uint64_t bits = 0; std::memcpy(&bits, &value, sizeof bits);
    for (int i = 0; i < 8; ++i) { hash ^= (bits >> (i * 8)) & 0xffu; hash *= 1099511628211ULL; }
  }
  if (trace != nullptr) for (const char* p = trace; *p != '\0'; ++p) { hash ^= static_cast<unsigned char>(*p); hash *= 1099511628211ULL; }
  char text[48] = {}; std::snprintf(text, sizeof text, "urn:sdn:ocm:%016llx", static_cast<unsigned long long>(hash));
  return text;
}

std::string number_text(double v) {
  char text[32];
  std::snprintf(text, sizeof text, "%.6g", v);
  return text;
}

// The fit's formal covariance is conditional on these assumptions and has no
// coverage evidence of its own: the OCM states them and COV_CALIBRATION
// Uncalibrated (CA uncertainty program; ASO catalog paper section 9).
struct FitAssumptions {
  const wire::EstimationConfig* config = nullptr;
  const std::vector<core::Observation>* observations = nullptr;
  std::size_t accepted = 0;
};

std::vector<std::uint8_t> make_ocm(const core::CartesianState& estimate,
                                   const core::Matrix6& covariance,
                                   const std::vector<double>& residuals,
                                   double rms, bool sequential, wire::EstimatorKind estimator,
                                   const FitAssumptions& assumptions) {
  OCMT record;
  record.TRAJ_TYPE = trajectoryType::CARTESIAN_PV;
  record.TRAJ_TYPE_DESCRIPTION = sequential ? "FILTERED_ESTIMATE" : "BATCH_ESTIMATE";
  record.STATE_VECTOR_SIZE = 6;
  record.STATE_DATA.assign(estimate.value.begin(), estimate.value.end());
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column <= row; ++column) record.COVARIANCE_DATA.push_back(covariance[row * 6 + column]);
  }
  record.ORBIT_DETERMINATION = std::make_unique<OrbitDeterminationT>();
  record.ORBIT_DETERMINATION->OD_ID = "estimation-family-result";
  record.ORBIT_DETERMINATION->OD_ALGORITHM = sequential ? "SEQUENTIAL_COVARIANCE_FILTER" : "BATCH_WEIGHTED_LEAST_SQUARES";
  record.ORBIT_DETERMINATION->OD_METHOD = "MEASUREMENT_BASED";
  record.ORBIT_DETERMINATION->OD_DATA_WEIGHTING = "INVERSE_VARIANCE";
  record.ORBIT_DETERMINATION->OD_EST_PARAMETERS = {"CARTESIAN_X", "CARTESIAN_Y", "CARTESIAN_Z", "CARTESIAN_VX", "CARTESIAN_VY", "CARTESIAN_VZ"};
  record.ORBIT_DETERMINATION->OD_RESIDUAL_RMS = rms;
  record.ORBIT_DETERMINATION->OD_RESIDUALS_SERIES = residuals;
  record.ORBIT_DETERMINATION->OD_ESTIMATOR = estimator == wire::EstimatorKind::LINEAR_KALMAN_FILTER ? estimatorCategory::Unknown :
      estimator == wire::EstimatorKind::UNSCENTED_KALMAN_FILTER ? estimatorCategory::UnscentedKalman :
      sequential ? estimatorCategory::ExtendedKalman : estimatorCategory::BatchLeastSquares;
  if (estimator == wire::EstimatorKind::LINEAR_KALMAN_FILTER) record.ORBIT_DETERMINATION->OD_ALGORITHM = "LINEAR_KALMAN_FILTER";

  record.COV_CALIBRATION = covarianceCalibration::Uncalibrated;
  auto& od = *record.ORBIT_DETERMINATION;
  const wire::EstimationConfig& config = *assumptions.config;
  // Measurement noise per observation type, as the fit weighted it.
  std::map<int, std::pair<double, double>> sigma;
  for (const core::Observation& o : *assumptions.observations) {
    auto& range = sigma.emplace(static_cast<int>(o.kind), std::make_pair(o.sigma[0], o.sigma[0])).first->second;
    for (int i = 0; i < o.value_count; ++i) {
      range.first = std::min(range.first, o.sigma[i]);
      range.second = std::max(range.second, o.sigma[i]);
    }
  }
  std::string noise = "Zero-mean Gaussian measurement noise, independent between observations; 1-sigma (SI) by type:";
  for (const auto& [kind, range] : sigma) {
    const char* name = wire::EnumNameMeasurementKind(static_cast<wire::MeasurementKind>(kind));
    od.OD_OBSERVATIONS_TYPE.push_back(name);
    noise += std::string(" ") + name + " " + number_text(range.first) +
             (range.second != range.first ? " to " + number_text(range.second) : std::string()) + ";";
  }
  od.OD_NOISE_MODELS = noise;
  od.OD_OBSERVATIONS_USED = static_cast<int>(assumptions.accepted);
  od.OD_DATA_WEIGHTING = "INVERSE_VARIANCE: each component weighted 1/sigma^2; edit threshold " +
                         number_text(config.sigma_edit_threshold()) + " sigma";
  const auto* psd = config.process_noise_spectral_density();
  if (!sequential || config.process_noise() == wire::ProcessNoiseKind::NONE) {
    od.OD_PROCESS_NOISE = "NONE";
  } else {
    od.OD_PROCESS_NOISE = std::string(wire::EnumNameProcessNoiseKind(config.process_noise())) +
                          ": white acceleration spectral density (m^2/s^3) " + number_text(psd->Get(0)) + ", " +
                          number_text(psd->Get(1)) + ", " + number_text(psd->Get(2));
    if (config.process_noise() == wire::ProcessNoiseKind::DYNAMIC_MODEL_COMPENSATION)
      od.OD_PROCESS_NOISE += "; correlation time " + number_text(config.dynamic_model_correlation_time_seconds()) + " s";
  }
  const auto* p0 = config.initial_covariance();
  od.OD_APRIORI_DATA = "Request a priori state and covariance; 1-sigma position " + number_text(std::sqrt(p0->Get(0))) +
                       ", " + number_text(std::sqrt(p0->Get(7))) + ", " + number_text(std::sqrt(p0->Get(14))) +
                       " m, velocity " + number_text(std::sqrt(p0->Get(21))) + ", " + number_text(std::sqrt(p0->Get(28))) +
                       ", " + number_text(std::sqrt(p0->Get(35))) + " m/s";
  if (!sequential)
    od.OD_CONVERGENCE_CRITERIA = "state correction below " + number_text(config.state_convergence_tolerance()) +
                                 ", RMS change below " + number_text(config.rms_convergence_tolerance()) + ", at most " +
                                 std::to_string(config.maximum_iterations()) + " iterations";
  record.HEADER = std::make_unique<HeaderT>();
  record.HEADER->COMMENT = {
      "Formal covariance of this fit: conditional on the stated measurement noise, weights, a priori and dynamics; "
      "not calibrated against independent evidence (COV_CALIBRATION Uncalibrated).",
      "Estimated parameters: Cartesian position and velocity. Consider parameters: none. Measurement biases: "
      "neither estimated nor considered; error-model biases are not applied by the fit."};
  ::flatbuffers::FlatBufferBuilder builder(2048);
  const auto root = CreateOCM(builder, &record);
  FinishOCMBuffer(builder, root);
  return {builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize()};
}

std::vector<std::uint8_t> make_odr(const wire::EstimationRequest* request,
                                   const core::CartesianState& estimate,
                                   const core::Matrix6& covariance,
                                   const core::BatchResult* batch,
                                   const core::FilterResult* filter,
                                   const std::string& ocm_id) {
  ODRT report;
  report.RUN_ID = request->trace_id() == nullptr ? "estimation-run" : request->trace_id()->str();
  report.OCM_CONTENT_ID = ocm_id;
  report.COVARIANCE_DIMENSION = 6;
  report.STATE_COVARIANCE.assign(covariance.begin(), covariance.end());
  report.ESTIMATED_EPOCH_STATE = frm_state(estimate, request->config()->initial_epoch());
  report.CONFIGURATION = std::make_unique<ODRSolverConfigurationT>();
  report.CONFIGURATION->ESTIMATOR = request->config()->estimator() == wire::EstimatorKind::LINEAR_KALMAN_FILTER
      ? odrEstimatorKind::UNSPECIFIED
      : static_cast<odrEstimatorKind>(static_cast<int>(request->config()->estimator()) + 1);
  report.CONFIGURATION->MAXIMUM_ITERATIONS = request->config()->maximum_iterations();
  report.CONFIGURATION->STATE_CONVERGENCE_TOLERANCE = request->config()->state_convergence_tolerance();
  report.CONFIGURATION->RMS_CONVERGENCE_TOLERANCE = request->config()->rms_convergence_tolerance();
  report.CONFIGURATION->SIGMA_EDIT_THRESHOLD = request->config()->sigma_edit_threshold();
  report.CONFIGURATION->PROCESS_NOISE = static_cast<odrProcessNoiseKind>(static_cast<int>(request->config()->process_noise()) + 1);
  for (int i = 0; i < 6; ++i) report.CONFIGURATION->PROCESS_NOISE_SPECTRAL_DENSITY.push_back(request->config()->process_noise_spectral_density()->Get(i));
  report.CONFIGURATION->DYNAMIC_MODEL_CORRELATION_TIME_SECONDS = request->config()->dynamic_model_correlation_time_seconds();
  report.CONFIGURATION->PROPAGATOR_PORT_ID = request->propagator_port_id()->str();
  report.CONFIGURATION->PROPAGATOR_CAPABILITY = request->propagator_capability()->str();
  for (int component = 0; component < 6; ++component) {
    auto parameter = std::make_unique<ODREstimatedParameterT>();
    parameter->PARAMETER = std::make_unique<PCEParameterRefT>();
    parameter->PARAMETER->PARAMETER = static_cast<pceParameter>(component + 1);
    parameter->DISPOSITION = odrParameterDisposition::ESTIMATED;
    parameter->A_PRIORI_VALUE = request->config()->initial_state()->Get(component);
    parameter->A_PRIORI_SIGMA = std::sqrt(std::max(
        request->options() && request->options()->estimate_clock()
            ? request->options()->initial_covariance8()->Get(component * 8 + component)
            : request->config()->initial_covariance()->Get(component * 6 + component), 0.0));
    parameter->FINAL_VALUE = estimate.value[component];
    parameter->FINAL_SIGMA = std::sqrt(std::max(covariance[component * 6 + component], 0.0));
    parameter->UNIT = component < 3 ? pceUnit::METRE : pceUnit::METRE_PER_SECOND;
    report.ESTIMATED_PARAMETERS.push_back(std::move(parameter));
  }
  if (batch != nullptr) {
    report.CONVERGENCE_REASON = batch->converged ? odrConvergenceReason::CONVERGED : odrConvergenceReason::MAXIMUM_ITERATIONS;
    report.RESIDUAL_RMS = batch->residual_rms;
    for (const core::BatchIteration& source : batch->iterations) {
      auto iteration = std::make_unique<ODRIterationStatisticsT>();
      iteration->ITERATION = source.iteration;
      iteration->ACCEPTED_OBSERVATION_COUNT = static_cast<std::uint32_t>(source.accepted_count);
      iteration->REJECTED_OBSERVATION_COUNT = static_cast<std::uint32_t>(source.rejected_count);
      iteration->PREFIT_RMS = source.prefit_rms;
      iteration->POSTFIT_RMS = source.postfit_rms;
      iteration->WEIGHTED_RMS = source.postfit_rms;
      iteration->STATE_CORRECTION_NORM = source.correction_norm;
      report.ITERATIONS.push_back(std::move(iteration));
    }
    for (std::size_t index : batch->rejected_indices) {
      auto edited = std::make_unique<ODREditedObservationT>();
      edited->OBSERVATION_ID = "observation-" + std::to_string(index);
      edited->REASON = "SIGMA_THRESHOLD";
      report.EDITED_OBSERVATIONS.push_back(std::move(edited));
    }
  } else {
    report.CONVERGENCE_REASON = odrConvergenceReason::CONVERGED;
    for (const core::FilterEpoch& source : filter->epochs) {
      auto epoch = std::make_unique<ODRFilterEpochT>();
      epoch->EPOCH = epoch_text(source.filtered.epoch_seconds, request->config()->initial_epoch());
      epoch->FILTERED_STATE = frm_state(source.filtered, request->config()->initial_epoch());
      epoch->FILTERED_COVARIANCE.assign(source.filtered_covariance.begin(), source.filtered_covariance.end());
      epoch->SMOOTHED_STATE = frm_state(source.smoothed, request->config()->initial_epoch());
      epoch->SMOOTHED_COVARIANCE.assign(source.smoothed_covariance.begin(), source.smoothed_covariance.end());
      epoch->NORMALIZED_INNOVATION_SQUARED = source.normalized_innovation_squared;
      report.FILTER_HISTORY.push_back(std::move(epoch));
    }
  }
  ::flatbuffers::FlatBufferBuilder builder(4096);
  const auto root = CreateODR(builder, &report);
  FinishODRBuffer(builder, root);
  return {builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize()};
}

int push(const char* port, const char* schema, const char* identifier,
         const std::vector<std::uint8_t>& bytes) {
  return plugin_push_output(port, schema, identifier, bytes.data(),
                            static_cast<std::uint32_t>(bytes.size()));
}

}  // namespace

extern "C" int run_estimation(void) {
  plugin_reset_output_state();
  const wire::EstimationRequest* request = nullptr;
  const wire::EstimationEnvelope* envelope = nullptr;
  if (!decode_request(input("request"), &request, &envelope)) {
    return fail("bad-estimation-request", "request must be a valid $EST envelope with configuration and a named propagator port");
  }
  if (request->propagator_capability()->str().find("plugin_compute_stm") == std::string::npos) {
    return fail("missing-stm-capability", "the estimation propagator port must provide plugin_compute_stm");
  }

  std::vector<core::Observation> observations;
  if (request->observations() != nullptr) {
    observations.reserve(request->observations()->size());
    for (const wire::EstimationObservation* source : *request->observations()) {
      // Validate the fixed storage bound before error-model loops use count.
      if (source != nullptr && source->value_count() > 4 &&
          request->config()->estimator() != wire::EstimatorKind::BATCH_WEIGHTED_LEAST_SQUARES) {
        return fail("bad-estimation-request", "observation value_count exceeds the four-lane wire storage");
      }
      if (source != nullptr) observations.push_back(observation_from_wire(*source,
          request->config()->initial_epoch(),
          request->config()->estimator() != wire::EstimatorKind::BATCH_WEIGHTED_LEAST_SQUARES));
    }
  }
  if (request->extended_observations() != nullptr) {
    if (!observations.empty() || request->config()->estimator() == wire::EstimatorKind::BATCH_WEIGHTED_LEAST_SQUARES)
      return fail("bad-estimation-request", "extended observations are sequential-only and replace legacy observations");
    for (const auto* source : *request->extended_observations()) {
      if (!source || !source->observation() || !source->values() || !source->sigmas())
        return fail("bad-estimation-request", "extended observation is incomplete");
      const auto count = source->observation()->value_count();
      if (count < 1 || count > 6 || source->values()->size() != count || source->sigmas()->size() != count)
        return fail("bad-estimation-request", "extended observation must have 1..6 matching value/sigma lanes");
      auto o = observation_from_wire(*source->observation(), request->config()->initial_epoch(), true);
      for (unsigned i=0;i<count;++i) {o.value[i]=source->values()->Get(i);o.sigma[i]=source->sigmas()->Get(i);}
      if (source->linear_matrix()) o.linear_matrix.assign(source->linear_matrix()->begin(), source->linear_matrix()->end());
      if (source->linear_offset()) o.linear_offset.assign(source->linear_offset()->begin(), source->linear_offset()->end());
      o.satellite_clock_bias_m=source->satellite_clock_bias_m();
      observations.push_back(o);
    }
  }
  append_tdm_observations(input("tracking_data"), request->config()->initial_epoch(), &observations);
  if (!apply_crd_station(input("laser_tracking"), &observations)) {
    return fail("bad-crd", "laser_tracking must be a valid $CRD station-coordinate record");
  }
  if (!apply_trh_record(input("tracking_hardware"), &observations)) {
    return fail("bad-trh", "tracking_hardware must be a valid $TRH record");
  }
  std::vector<core::ErrorModel> error_models;
  apply_error_models(request, &observations, &error_models);
  if (!apply_mem_record(input("error_model"), &observations, &error_models)) {
    return fail("bad-mem", "error_model must be a valid $MEM record");
  }

  std::vector<core::PropagatorSample> samples;
  const bool nonlinear = request->options() && request->options()->nonlinear_propagation();
  if (!nonlinear && (!decode_samples(input("propagator_samples"), request->config()->initial_epoch(), &samples) ||
      samples.size() != observations.size())) {
    return fail("propagator-protocol", "propagator_samples must contain one caller-produced state and STM for every observation");
  }

  core::CartesianState estimate;
  estimate.epoch_seconds = 0.0;
  core::Matrix6 covariance{};
  for (int i = 0; i < 6; ++i) estimate.value[i] = request->config()->initial_state()->Get(i);
  for (int i = 0; i < 36; ++i) covariance[i] = request->config()->initial_covariance()->Get(i);
  std::vector<double> residuals;
  std::vector<std::uint32_t> rejected;
  std::vector<wire::FilterEpoch> wire_history;
  core::BatchResult batch;
  core::FilterResult filter;
  bool batch_mode = request->config()->estimator() == wire::EstimatorKind::BATCH_WEIGHTED_LEAST_SQUARES;
  bool converged = true;
  double rms = 0.0;
  double recovered_sigma = 0.0;
  std::uint32_t iteration_count = 0;

  if (batch_mode && request->options()) return fail("bad-estimation-request", "sequential options cannot be used in batch mode");
  if (batch_mode) {
    core::BatchConfig config;
    config.a_priori = estimate;
    config.a_priori_covariance = covariance;
    config.maximum_iterations = request->config()->maximum_iterations() == 0 ? 12 : request->config()->maximum_iterations();
    config.state_convergence_tolerance = request->config()->state_convergence_tolerance();
    config.rms_convergence_tolerance = request->config()->rms_convergence_tolerance();
    config.sigma_edit_threshold = request->config()->sigma_edit_threshold();
    batch = core::batch_weighted_least_squares(config, observations, samples);
    estimate = batch.estimate; covariance = batch.covariance; residuals = batch.residuals;
    for (std::size_t index : batch.rejected_indices) rejected.push_back(static_cast<std::uint32_t>(index));
    converged = batch.converged; rms = batch.residual_rms; recovered_sigma = batch.recovered_noise_sigma;
    iteration_count = static_cast<std::uint32_t>(batch.iterations.size());
  } else {
    core::FilterConfig config;
    config.initial = estimate; config.initial_covariance = covariance;
    config.estimator = static_cast<core::EstimatorKind>(request->config()->estimator());
    config.process_noise = static_cast<core::ProcessNoiseKind>(request->config()->process_noise());
    for (int i = 0; i < 3; ++i) config.acceleration_psd[i] = request->config()->process_noise_spectral_density()->Get(i);
    config.dmc_correlation_time_seconds = request->config()->dynamic_model_correlation_time_seconds();
    config.sigma_edit_threshold = request->config()->sigma_edit_threshold();
    if (const auto* options=request->options()) {
      config.ukf_alpha=options->ukf_alpha();config.ukf_beta=options->ukf_beta();config.ukf_kappa=options->ukf_kappa();
      config.adaptive_process_noise=options->adaptive_process_noise();config.inflate_measurement_noise=options->inflate_measurement_noise();
      config.adaptation_rate=options->adaptation_rate();config.minimum_process_scale=options->minimum_process_scale();config.maximum_process_scale=options->maximum_process_scale();
      config.maximum_measurement_scale=options->maximum_measurement_scale();config.estimate_clock=options->estimate_clock();
      config.initial_clock_bias_m=options->initial_clock_bias_m();config.initial_clock_drift_mps=options->initial_clock_drift_mps();
      config.clock_bias_psd=options->clock_bias_psd();config.clock_drift_psd=options->clock_drift_psd();
      if (config.estimate_clock) {
        if (!options->initial_covariance8() || options->initial_covariance8()->size()!=64)
          return fail("bad-estimation-request", "clock estimation requires a row-major 8x8 initial covariance");
        std::copy(options->initial_covariance8()->begin(), options->initial_covariance8()->end(), config.initial_covariance8.begin());
      }
    }
    const bool smooth = request->config()->estimator() == wire::EstimatorKind::EXTENDED_KALMAN_FILTER_WITH_RTS || (request->options() && request->options()->smooth());
    std::vector<std::unique_ptr<wire::PropagationQueryT>> pending;
    const auto* answers=envelope->propagation_answers();
    std::size_t sequence=0;bool protocol_error=false;
    if (nonlinear) config.propagator=[&](const core::CartesianState& seed,double target,core::PropagatorSample* sample) {
      const auto id=sequence++;
      const auto seed_epoch=absolute_epoch(seed.epoch_seconds,request->config()->initial_epoch());
      const auto target_epoch=absolute_epoch(target,request->config()->initial_epoch());
      core::Matrix6 empty{};
      const wire::EstimationState seed_wire(seed_epoch,
        ::flatbuffers::span<const double,6>(seed.value.data(),6),
        ::flatbuffers::span<const double,36>(empty.data(),36),0,0,0,0,0,request->config()->reference_frame(),0,0,request->config()->estimator());
      if (answers && id<answers->size()) {
        const auto* answer=answers->Get(id);const auto* query=answer?answer->query():nullptr;
        if (!query || !query->seed() || !query->target_epoch() || !answer->sample() || query->sequence()!=id ||
            query->seed()->reference_frame()!=request->config()->reference_frame() ||
            query->seed()->epoch().jd_day()!=seed_epoch.jd_day() || query->seed()->epoch().seconds()!=seed_epoch.seconds() ||
            query->target_epoch()->jd_day()!=target_epoch.jd_day() || query->target_epoch()->seconds()!=target_epoch.seconds()) {
          protocol_error=true;return false;
        }
        for(int i=0;i<6;++i) if(query->seed()->state()->Get(i)!=seed.value[i]) {protocol_error=true;return false;}
        sample->state.epoch_seconds=relative_seconds(answer->sample()->epoch(),request->config()->initial_epoch());
        for(int i=0;i<6;++i)sample->state.value[i]=answer->sample()->state()->Get(i);
        for(int i=0;i<36;++i)sample->stm[i]=answer->sample()->stm()->Get(i);
        return true;
      }
      auto query=std::make_unique<wire::PropagationQueryT>();query->sequence=static_cast<uint32_t>(id);
      query->seed=std::make_unique<wire::EstimationState>(seed_wire);
      query->target_epoch=std::make_unique<wire::EstimationEpoch>(target_epoch);
      pending.push_back(std::move(query));return false;
    };
    filter = core::sequential_filter(config, observations, samples, smooth);
    if(protocol_error || (answers && answers->size()>sequence)) return fail("propagator-protocol", "propagator answers do not match the exact seed, epoch, frame and sequence");
    if(!pending.empty()) {
      wire::EstimationEnvelopeT reply;reply.result=std::make_unique<wire::EstimationResultT>();
      reply.result->status=wire::EstimationStatus::NEEDS_PROPAGATION;reply.result->propagation_requests=std::move(pending);
      ::flatbuffers::FlatBufferBuilder b;wire::FinishEstimationEnvelopeBuffer(b,wire::EstimationEnvelope::Pack(b,&reply));
      std::vector<uint8_t> bytes(b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());
      return push("result","Estimation.fbs","$EST",bytes)<0?fail("emit-failed","cannot emit propagation query"):0;
    }
    if (!filter.valid || filter.epochs.empty()) return fail("filter-failed", "sequential filter did not produce a valid covariance history");
    const core::FilterEpoch& final = filter.epochs.back();
    estimate = smooth ? final.smoothed : final.filtered;
    covariance = smooth ? final.smoothed_covariance : final.filtered_covariance;
    for (std::size_t index : filter.rejected_indices) rejected.push_back(static_cast<std::uint32_t>(index));
    for (const core::FilterEpoch& source : filter.epochs) {
      const auto epoch = absolute_epoch(source.filtered.epoch_seconds, request->config()->initial_epoch());
      wire_history.emplace_back(epoch,
        ::flatbuffers::span<const double, 6>(source.filtered.value.data(), 6),
        ::flatbuffers::span<const double, 36>(source.filtered_covariance.data(), 36),
        ::flatbuffers::span<const double, 6>(source.smoothed.value.data(), 6),
        ::flatbuffers::span<const double, 36>(source.smoothed_covariance.data(), 36),
        source.normalized_innovation_squared);
    }
  }

  const char* trace = request->trace_id() == nullptr ? nullptr : request->trace_id()->c_str();
  const std::string ocm_id = linked_ocm_id(estimate, trace);
  FitAssumptions assumptions;
  assumptions.config = request->config();
  assumptions.observations = &observations;
  assumptions.accepted = observations.size() - rejected.size();
  const std::vector<std::uint8_t> ocm = make_ocm(estimate, covariance, residuals, rms, !batch_mode, request->config()->estimator(), assumptions);
  const std::vector<std::uint8_t> odr = make_odr(request, estimate, covariance,
                                                 batch_mode ? &batch : nullptr,
                                                 batch_mode ? nullptr : &filter, ocm_id);
  const wire::EstimationEpoch result_epoch = absolute_epoch(estimate.epoch_seconds, request->config()->initial_epoch());
  const wire::EstimationState state(result_epoch,
      ::flatbuffers::span<const double, 6>(estimate.value.data(), 6),
      ::flatbuffers::span<const double, 36>(covariance.data(), 36), rms, recovered_sigma,
      iteration_count, static_cast<std::uint32_t>(observations.size() - rejected.size()),
      static_cast<std::uint32_t>(rejected.size()), request->config()->reference_frame(),
      converged ? 1 : 0, (request->config()->estimator() == wire::EstimatorKind::EXTENDED_KALMAN_FILTER_WITH_RTS || (request->options() && request->options()->smooth())) ? 1 : 0,
      request->config()->estimator());
  std::vector<double> iteration_covariances;
  for (const core::Matrix6& value : batch.iteration_covariances) {
    iteration_covariances.insert(iteration_covariances.end(), value.begin(), value.end());
  }
  ::flatbuffers::FlatBufferBuilder builder(8192);
  std::vector<::flatbuffers::Offset<wire::ExtendedFilterEpoch>> extended_history;
  if (!batch_mode && request->options()) {
    const int n=request->options()->estimate_clock()?8:6;
    for(const auto& e:filter.epochs) {
      wire::ExtendedFilterEpochT row;row.epoch=std::make_unique<wire::EstimationEpoch>(absolute_epoch(e.filtered.epoch_seconds,request->config()->initial_epoch()));
      row.state_dimension=n;row.filtered_state.assign(e.filtered_extended.begin(),e.filtered_extended.begin()+n);
      row.smoothed_state.assign(e.smoothed_extended.begin(),e.smoothed_extended.begin()+n);
      for(int i=0;i<n;++i)for(int j=0;j<n;++j){row.filtered_covariance.push_back(e.filtered_covariance_extended[8*i+j]);row.smoothed_covariance.push_back(e.smoothed_covariance_extended[8*i+j]);}
      row.normalized_innovation_squared=e.normalized_innovation_squared;row.accepted=e.accepted;
      row.process_noise_scale=e.process_noise_scale;row.measurement_noise_scale=e.measurement_noise_scale;
      extended_history.push_back(wire::ExtendedFilterEpoch::Pack(builder,&row));
    }
  }
  const auto result = wire::CreateEstimationResultDirect(builder,
      converged ? wire::EstimationStatus::OK : wire::EstimationStatus::NOT_CONVERGED,
      &state, &wire_history, &residuals, &iteration_covariances, &rejected,
      &odr, &ocm, nullptr, trace, &extended_history);
  const auto root = wire::CreateEstimationEnvelope(builder, 0, result);
  wire::FinishEstimationEnvelopeBuffer(builder, root);
  const std::vector<std::uint8_t> response(builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize());
  if (push("result", "Estimation.fbs", "$EST", response) < 0 ||
      push("odr", "ODR.fbs", "$ODR", odr) < 0 ||
      push("ocm", "OCM.fbs", "$OCM", ocm) < 0) {
    return fail("emit-failed", "failed to emit one or more estimation result records");
  }
  return converged ? 0 : 5;
}

extern "C" int simulate_tracking(void) {
  plugin_reset_output_state();
  const wire::EstimationRequest* request = nullptr;
  const wire::EstimationEnvelope* envelope = nullptr;
  if (!decode_request(input("request"), &request, &envelope)) return fail("bad-simulation-request", "simulation requires a valid $EST request");
  if (request->options() || request->extended_observations()) return fail("bad-simulation-request", "extended records are supported by run_estimation only");
  if (request->observations()) for(const auto* o:*request->observations()) {
    if(o && (o->value_count()>4 || static_cast<unsigned>(o->kind())>20)) return fail("bad-simulation-request", "simulation supports the legacy measurement kinds and four-lane records");
  }
  std::vector<core::Observation> templates;
  if (request->observations() != nullptr) for (const wire::EstimationObservation* source : *request->observations()) if (source != nullptr) templates.push_back(observation_from_wire(*source, request->config()->initial_epoch()));
  if (!apply_crd_station(input("laser_tracking"), &templates)) return fail("bad-crd", "laser_tracking must be a valid $CRD station-coordinate record");
  if (!apply_trh_record(input("tracking_hardware"), &templates)) return fail("bad-trh", "tracking_hardware must be a valid $TRH record");
  std::vector<core::ErrorModel> models; apply_error_models(request, &templates, &models);
  if (!apply_mem_record(input("error_model"), &templates, &models)) return fail("bad-mem", "error_model must be a valid $MEM record");
  std::vector<core::PropagatorSample> samples;
  if (!decode_samples(input("propagator_samples"), request->config()->initial_epoch(), &samples)) return fail("propagator-protocol", "simulation truth samples are malformed");
  const std::vector<core::Observation> simulated = core::simulate_measurements(templates, samples, models);
  if (simulated.size() != templates.size()) return fail("simulation-failed", "simulation input lengths differ");
  std::vector<wire::EstimationObservation> encoded;
  encoded.reserve(simulated.size());
  for (std::size_t i = 0; i < simulated.size(); ++i) {
    const core::Observation& value = simulated[i];
    const wire::EstimationObservation* source = request->observations()->Get(static_cast<::flatbuffers::uoffset_t>(i));
    encoded.emplace_back(absolute_epoch(value.epoch_seconds, request->config()->initial_epoch()),
      ::flatbuffers::span<const double, 4>(value.value.data(), 4),
      ::flatbuffers::span<const double, 4>(value.sigma.data(), 4),
      ::flatbuffers::span<const double, 3>(source->station_position_m()->data(), 3),
      ::flatbuffers::span<const double, 3>(source->station_velocity_mps()->data(), 3),
      ::flatbuffers::span<const double, 3>(source->station_east()->data(), 3),
      ::flatbuffers::span<const double, 3>(source->station_north()->data(), 3),
      ::flatbuffers::span<const double, 3>(source->station_up()->data(), 3),
      ::flatbuffers::span<const double, 3>(source->remote_position_m()->data(), 3),
      ::flatbuffers::span<const double, 3>(source->remote_velocity_mps()->data(), 3),
      source->frequency_hz(), source->transmitter_delay_seconds(), source->receiver_delay_seconds(),
      source->transponder_delay_seconds(), source->elevation_rad(), source->station_latitude_rad(),
      source->station_height_m(), source->pressure_hpa(), source->temperature_k(),
      source->relative_humidity(), source->wavelength_m(), source->total_electron_content(),
      source->total_electron_content_rate_per_second(),
      source->turnaround_numerator(), source->turnaround_denominator(), source->kind(),
      value.value_count, source->flags(), source->transmitter_index(), source->receiver_index());
  }
  ::flatbuffers::FlatBufferBuilder builder(4096);
  const auto observation_vector = builder.CreateVectorOfStructs(encoded);
  wire::EstimationEnvelopeBuilder envelope_builder(builder);
  envelope_builder.add_simulated_observations(observation_vector);
  const auto root = envelope_builder.Finish();
  wire::FinishEstimationEnvelopeBuffer(builder, root);
  if (plugin_push_output("observations", "Estimation.fbs", "$EST", builder.GetBufferPointer(),
                         static_cast<std::uint32_t>(builder.GetSize())) < 0) return fail("emit-failed", "failed to emit simulated observations");
  return 0;
}

extern "C" int initial_orbit(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = input("request");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0 ||
      !wire::EstimationEnvelopeBufferHasIdentifier(frame->payload)) return fail("bad-iod-request", "initial orbit request must be a $EST envelope");
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!wire::VerifyEstimationEnvelopeBuffer(verifier)) return fail("bad-iod-request", "initial orbit request failed FlatBuffer verification");
  const wire::EstimationEnvelope* envelope = wire::GetEstimationEnvelope(frame->payload);
  const wire::InitialOrbitRequest* request = envelope == nullptr ? nullptr : envelope->initial_orbit_request();
  if (request == nullptr) return fail("bad-iod-request", "the $EST envelope carries no initial_orbit_request");
  const double mu = request->gravitational_parameter_m3_s2();
  core::IodResult result;
  if (request->method() == wire::InitialOrbitKind::GAUSS || request->method() == wire::InitialOrbitKind::LAPLACE) {
    std::array<core::AnglesObservation, 3> angles{};
    for (int i = 0; i < 3; ++i) {
      angles[i].epoch_seconds = i == 0 ? -request->interval_12_seconds() : (i == 2 ? request->interval_23_seconds() : 0.0);
      angles[i].right_ascension_rad = request->right_ascensions_rad()->Get(i);
      angles[i].declination_rad = request->declinations_rad()->Get(i);
      angles[i].observer_position_m = {request->observer_positions_m()->Get(i * 3), request->observer_positions_m()->Get(i * 3 + 1), request->observer_positions_m()->Get(i * 3 + 2)};
    }
    result = request->method() == wire::InitialOrbitKind::GAUSS ? core::gauss_iod(angles, mu) : core::laplace_iod(angles, mu);
  } else {
    std::array<core::CartesianState, 3> positions{};
    for (int i = 0; i < 3; ++i) {
      positions[i].epoch_seconds = i == 0 ? -request->interval_12_seconds() : (i == 2 ? request->interval_23_seconds() : 0.0);
      for (int axis = 0; axis < 3; ++axis) positions[i].value[axis] = request->positions_m()->Get(i * 3 + axis);
    }
    result = request->method() == wire::InitialOrbitKind::GIBBS ? core::gibbs_iod(positions, mu) : core::herrick_gibbs_iod(positions, mu);
  }
  const wire::InitialOrbitResult encoded(request->epochs(),
      ::flatbuffers::span<const double, 6>(result.state.value.data(), 6),
      static_cast<std::uint32_t>(result.iterations), ::orbpro::propagator::ReferenceFrame::ICRF,
      result.valid ? wire::EstimationStatus::OK : wire::EstimationStatus::BAD_INPUT);
  ::flatbuffers::FlatBufferBuilder builder(1024);
  wire::EstimationEnvelopeBuilder envelope_builder(builder);
  envelope_builder.add_initial_orbit_result(&encoded);
  const auto root = envelope_builder.Finish();
  wire::FinishEstimationEnvelopeBuffer(builder, root);
  if (plugin_push_output("result", "Estimation.fbs", "$EST", builder.GetBufferPointer(),
                         static_cast<std::uint32_t>(builder.GetSize())) < 0) return fail("emit-failed", "failed to emit initial-orbit result");
  return result.valid ? 0 : 4;
}
