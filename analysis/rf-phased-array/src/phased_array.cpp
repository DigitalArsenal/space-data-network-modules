#include "space_data_module_invoke.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdint>
#include <pthread.h>
#include <string>
#include <vector>

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kSpeedOfLight = 299792458.0;
constexpr const char* kModuleId = "com.orbpro.rf-phased-array";
constexpr const char* kModuleVersion = "0.1.0";

double rad(double degrees) { return degrees * kPi / 180.0; }
double deg(double radians) { return radians * 180.0 / kPi; }
double clamp(double value, double lo, double hi) {
  return std::max(lo, std::min(hi, value));
}
std::string text(const flatbuffers::String* value, const char* fallback = "") {
  return value == nullptr ? std::string(fallback) : value->str();
}

const PAP* decode_pap(const plugin_input_frame_t* frame) {
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    return nullptr;
  }
  flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyPAPBuffer(verifier) ||
      !flatbuffers::BufferHasIdentifier(frame->payload, "$PAP")) {
    return nullptr;
  }
  return GetPAP(frame->payload);
}

const BEM* decode_bem(const plugin_input_frame_t* frame) {
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    return nullptr;
  }
  flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyBEMBuffer(verifier) ||
      !flatbuffers::BufferHasIdentifier(frame->payload, "$BEM")) {
    return nullptr;
  }
  return GetBEM(frame->payload);
}

const plugin_input_frame_t* input(const char* port) {
  const int32_t index = plugin_find_input_index(port, 0);
  return index < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(index));
}

struct Vec3 {
  double x;
  double y;
  double z;
};

Vec3 direction(double cone_deg, double clock_deg) {
  const double cone = rad(cone_deg);
  const double clock = rad(clock_deg);
  return {std::sin(cone) * std::cos(clock),
          std::sin(cone) * std::sin(clock),
          std::cos(cone)};
}

struct Element {
  std::string id;
  Vec3 position;
  std::complex<double> excitation;
  double amplitude;
  double phase_deg;
  std::string pattern_id;
  uint32_t failure_flags;
  bool failed;
};

double chebyshev_t(int order, double x) {
  if (std::abs(x) <= 1.0) {
    return std::cos(order * std::acos(x));
  }
  const double sign = x < 0.0 && (order & 1) ? -1.0 : 1.0;
  return sign * std::cosh(order * std::acosh(std::abs(x)));
}

std::vector<double> dolph_weights(size_t count, double sidelobe_db) {
  std::vector<double> weights(count, 1.0);
  if (count < 2) return weights;
  const int order = static_cast<int>(count - 1);
  const double attenuation = std::pow(10.0, std::abs(sidelobe_db) / 20.0);
  const double beta = std::cosh(std::acosh(attenuation) / order);
  for (size_t n = 0; n < count; ++n) {
    double sum = 0.0;
    const double centered = static_cast<double>(n) - 0.5 * (count - 1);
    for (size_t k = 0; k < count; ++k) {
      const double value = chebyshev_t(order, beta * std::cos(kPi * k / count));
      sum += value * std::cos(2.0 * kPi * k * centered / count);
    }
    weights[n] = std::abs(sum / count);
  }
  const double peak = *std::max_element(weights.begin(), weights.end());
  if (peak > 0.0) for (double& value : weights) value /= peak;
  return weights;
}

std::vector<double> taylor_weights(size_t count, double sidelobe_db, int nbar) {
  std::vector<double> weights(count, 1.0);
  if (count < 2 || nbar < 2) return weights;
  const double a = std::acosh(std::pow(10.0, std::abs(sidelobe_db) / 20.0)) / kPi;
  const double sigma2 = (nbar * nbar) / (a * a + (nbar - 0.5) * (nbar - 0.5));
  std::vector<double> fm(nbar, 0.0);
  for (int m = 1; m < nbar; ++m) {
    double numerator = 1.0;
    double denominator = 1.0;
    for (int n = 1; n < nbar; ++n) {
      numerator *= 1.0 - (m * m) / (sigma2 * (a * a + (n - 0.5) * (n - 0.5)));
      if (n != m) denominator *= 1.0 - static_cast<double>(m * m) / (n * n);
    }
    fm[m] = ((m & 1) ? 1.0 : -1.0) * numerator / (2.0 * denominator);
  }
  for (size_t i = 0; i < count; ++i) {
    const double x = (static_cast<double>(i) - 0.5 * (count - 1)) / count;
    for (int m = 1; m < nbar; ++m) weights[i] += 2.0 * fm[m] * std::cos(2.0 * kPi * m * x);
  }
  const double peak = *std::max_element(weights.begin(), weights.end());
  if (peak > 0.0) for (double& value : weights) value /= peak;
  return weights;
}

std::vector<double> taper_weights(const PAP* config, size_t count) {
  std::vector<double> result(count, 1.0);
  const double sll = config->TAPER_PARAMETERS() && config->TAPER_PARAMETERS()->size() > 0
      ? config->TAPER_PARAMETERS()->Get(0) : -30.0;
  const int nbar = config->TAPER_PARAMETERS() && config->TAPER_PARAMETERS()->size() > 1
      ? static_cast<int>(std::round(config->TAPER_PARAMETERS()->Get(1))) : 4;
  if (config->TAPER() == papTaperFamily_EQUAL_SIDELOBE) return dolph_weights(count, sll);
  if (config->TAPER() == papTaperFamily_CONTROLLED_SIDELOBE) return taylor_weights(count, sll, nbar);
  for (size_t i = 0; i < count; ++i) {
    const double x = count < 2 ? 0.0 : std::abs((2.0 * i) / (count - 1.0) - 1.0);
    if (config->TAPER() == papTaperFamily_COSINE) result[i] = std::cos(0.5 * kPi * x);
    if (config->TAPER() == papTaperFamily_RAISED_COSINE) result[i] = 0.5 + 0.5 * std::cos(kPi * x);
  }
  return result;
}

std::vector<Element> prepare_elements(const PAP* config, double wavelength) {
  std::vector<Element> elements;
  const auto* input_elements = config->ELEMENTS();
  if (input_elements == nullptr) return elements;
  const auto taper = taper_weights(config, input_elements->size());
  const Vec3 steer = direction(config->STEERING_CONE_DEG(), config->STEERING_CLOCK_DEG());
  for (size_t i = 0; i < input_elements->size(); ++i) {
    const PAPElement* item = input_elements->Get(i);
    const double source_amp = item->AMPLITUDE() == 0.0 ? 1.0 : item->AMPLITUDE();
    std::complex<double> source(item->WEIGHT_REAL(), item->WEIGHT_IMAGINARY());
    if (std::abs(source) == 0.0) source = std::polar(source_amp, rad(item->PHASE_DEG()));
    const double steering_phase = -2.0 * kPi / wavelength *
        (item->POSITION_X_M() * steer.x + item->POSITION_Y_M() * steer.y + item->POSITION_Z_M() * steer.z);
    std::complex<double> excitation = source * taper[i] * std::polar(1.0, steering_phase);
    if (item->FAILED()) excitation = {0.0, 0.0};
    elements.push_back({text(item->ELEMENT_ID(), "element"),
                        {item->POSITION_X_M(), item->POSITION_Y_M(), item->POSITION_Z_M()},
                        excitation, source_amp * taper[i], item->PHASE_DEG(),
                        text(item->ELEMENT_PATTERN_ID()), item->FAILURE_FLAGS(), item->FAILED()});
  }

  // White-covariance MVDR is the normalized steering vector. Requested nulls
  // add deterministic LCMV constraints by projection; all reductions stay in
  // element-index order.
  if (config->NULLS() != nullptr && !elements.empty()) {
    for (size_t ni = 0; ni < config->NULLS()->size(); ++ni) {
      const PAPNull* requested = config->NULLS()->Get(ni);
      const double null_cone = 90.0 - requested->ELEVATION_DEG();
      const Vec3 u = direction(null_cone, requested->AZIMUTH_DEG());
      std::complex<double> response(0.0, 0.0);
      for (const Element& e : elements) {
        const double phase = 2.0 * kPi / wavelength *
            (e.position.x * u.x + e.position.y * u.y + e.position.z * u.z);
        response += e.excitation * std::polar(1.0, phase);
      }
      const double denom = static_cast<double>(elements.size());
      for (Element& e : elements) {
        const double phase = 2.0 * kPi / wavelength *
            (e.position.x * u.x + e.position.y * u.y + e.position.z * u.z);
        e.excitation -= response * std::polar(1.0, -phase) / denom;
      }
    }
  }
  std::complex<double> desired(0.0, 0.0);
  for (const Element& e : elements) {
    const double phase = 2.0 * kPi / wavelength *
        (e.position.x * steer.x + e.position.y * steer.y + e.position.z * steer.z);
    desired += e.excitation * std::polar(1.0, phase);
  }
  if (std::abs(desired) > 1e-15) {
    for (Element& e : elements) e.excitation /= desired;
  }
  return elements;
}

double interpolate_cut(const PAPGainCut* cut, double cone) {
  const auto* angles = cut->ANGLES_DEG();
  const auto* gains = cut->GAIN_DBI();
  if (angles == nullptr || gains == nullptr || angles->empty() || angles->size() != gains->size()) return 0.0;
  if (cone <= angles->Get(0)) return gains->Get(0);
  for (size_t i = 1; i < angles->size(); ++i) {
    if (cone <= angles->Get(i)) {
      const double span = angles->Get(i) - angles->Get(i - 1);
      const double t = span == 0.0 ? 0.0 : (cone - angles->Get(i - 1)) / span;
      return gains->Get(i - 1) + t * (gains->Get(i) - gains->Get(i - 1));
    }
  }
  return gains->Get(gains->size() - 1);
}

double element_gain_db(const PAP* pattern, double cone, double clock) {
  const auto* cuts = pattern->GAIN_CUTS();
  if (cuts == nullptr || cuts->empty()) return pattern->PEAK_GAIN_DBI();
  clock = std::fmod(clock + 360.0, 360.0);
  const PAPGainCut* lower = nullptr;
  const PAPGainCut* upper = nullptr;
  double lower_clock = -360.0;
  double upper_clock = 720.0;
  for (size_t i = 0; i < cuts->size(); ++i) {
    const PAPGainCut* cut = cuts->Get(i);
    if (cut->AXIS() != papGainCutAxis_CONE) continue;
    double value = std::fmod(cut->FIXED_ANGLE_DEG() + 360.0, 360.0);
    if (value <= clock && value > lower_clock) { lower = cut; lower_clock = value; }
    if (value >= clock && value < upper_clock) { upper = cut; upper_clock = value; }
  }
  if (lower == nullptr) {
    for (size_t i = 0; i < cuts->size(); ++i) {
      const PAPGainCut* cut = cuts->Get(i);
      if (cut->AXIS() == papGainCutAxis_CONE && cut->FIXED_ANGLE_DEG() > lower_clock) {
        lower = cut; lower_clock = cut->FIXED_ANGLE_DEG() - 360.0;
      }
    }
  }
  if (upper == nullptr) {
    for (size_t i = 0; i < cuts->size(); ++i) {
      const PAPGainCut* cut = cuts->Get(i);
      if (cut->AXIS() == papGainCutAxis_CONE && cut->FIXED_ANGLE_DEG() < upper_clock) {
        upper = cut; upper_clock = cut->FIXED_ANGLE_DEG() + 360.0;
      }
    }
  }
  if (lower == nullptr) lower = upper;
  if (upper == nullptr) upper = lower;
  if (lower == nullptr) return pattern->PEAK_GAIN_DBI();
  const double a = interpolate_cut(lower, cone);
  const double b = interpolate_cut(upper, cone);
  const double span = upper_clock - lower_clock;
  const double t = span <= 0.0 ? 0.0 : (clock - lower_clock) / span;
  return a + clamp(t, 0.0, 1.0) * (b - a);
}

struct SynthContext {
  const PAP* element_pattern;
  const std::vector<Element>* elements;
  double wavelength;
  double scan_loss_db;
  std::vector<double>* gain;
};

struct WorkerArgs {
  SynthContext* context;
  size_t begin;
  size_t end;
};

void synth_range(WorkerArgs* args) {
  const auto& elements = *args->context->elements;
  double normalization = 0.0;
  size_t active = 0;
  for (const Element& e : elements) {
    normalization += std::abs(e.excitation);
    if (!e.failed) ++active;
  }
  normalization = std::max(normalization, 1e-15);
  for (size_t index = args->begin; index < args->end; ++index) {
    const size_t clock_index = index / 91;
    const double cone = static_cast<double>(index % 91);
    const double clock = static_cast<double>(clock_index * 15);
    const Vec3 u = direction(cone, clock);
    std::complex<double> field(0.0, 0.0);
    for (const Element& e : elements) {
      const double phase = 2.0 * kPi / args->context->wavelength *
          (e.position.x * u.x + e.position.y * u.y + e.position.z * u.z);
      field += e.excitation * std::polar(1.0, phase);
    }
    const double af_db = 20.0 * std::log10(std::max(std::abs(field) / normalization, 1e-12));
    const double array_gain = active == 0 ? -120.0 : 10.0 * std::log10(static_cast<double>(active));
    (*args->context->gain)[index] = element_gain_db(args->context->element_pattern, cone, clock) +
        af_db + array_gain - args->context->scan_loss_db;
  }
}

void* worker_entry(void* opaque) {
  synth_range(static_cast<WorkerArgs*>(opaque));
  return nullptr;
}

int requested_threads(const PAP* config) {
  int value = config->TAPER_PARAMETERS() && config->TAPER_PARAMETERS()->size() > 2
      ? static_cast<int>(std::round(config->TAPER_PARAMETERS()->Get(2))) : 1;
  if (value >= 8) return 8;
  if (value >= 4) return 4;
  if (value >= 2) return 2;
  return 1;
}

std::vector<double> synthesize_grid(const PAP* config, const PAP* element_pattern,
                                    const std::vector<Element>& elements,
                                    double wavelength, double scan_loss_db) {
  constexpr size_t kCount = 24 * 91;
  std::vector<double> gain(kCount, -120.0);
  SynthContext context{element_pattern, &elements, wavelength, scan_loss_db, &gain};
  const int workers = requested_threads(config);
  pthread_t threads[8]{};
  WorkerArgs args[8]{};
  bool spawned[8]{};
  for (int i = 0; i < workers; ++i) {
    args[i] = {&context, kCount * static_cast<size_t>(i) / workers,
               kCount * static_cast<size_t>(i + 1) / workers};
    if (i == workers - 1 || pthread_create(&threads[i], nullptr, worker_entry, &args[i]) != 0) {
      synth_range(&args[i]);
    } else {
      spawned[i] = true;
    }
  }
  for (int i = 0; i < workers; ++i) if (spawned[i]) pthread_join(threads[i], nullptr);
  return gain;
}

double beamwidth_3db(const std::vector<double>& gain, size_t clock_index, double steer_cone) {
  const size_t base = clock_index * 91;
  const size_t peak_index = static_cast<size_t>(clamp(std::round(steer_cone), 0.0, 90.0));
  const double threshold = gain[base + peak_index] - 3.0;
  size_t lo = peak_index;
  size_t hi = peak_index;
  while (lo > 0 && gain[base + lo] >= threshold) --lo;
  while (hi < 90 && gain[base + hi] >= threshold) ++hi;
  return static_cast<double>(hi - lo);
}

double sidelobe_level(const std::vector<double>& gain, size_t clock_index,
                      double steer_cone, double width) {
  const size_t base = clock_index * 91;
  const double peak = gain[base + static_cast<size_t>(clamp(std::round(steer_cone), 0.0, 90.0))];
  const double exclude = std::max(2.0, width);
  double side = -120.0;
  for (size_t i = 1; i < 90; ++i) {
    if (std::abs(static_cast<double>(i) - steer_cone) <= exclude) continue;
    if (gain[base + i] >= gain[base + i - 1] && gain[base + i] >= gain[base + i + 1]) {
      side = std::max(side, gain[base + i] - peak);
    }
  }
  return side;
}

double minimum_spacing(const std::vector<Element>& elements) {
  double result = 1e300;
  for (size_t i = 0; i < elements.size(); ++i) {
    for (size_t j = i + 1; j < elements.size(); ++j) {
      const double dx = elements[i].position.x - elements[j].position.x;
      const double dy = elements[i].position.y - elements[j].position.y;
      const double dz = elements[i].position.z - elements[j].position.z;
      const double distance = std::sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > 0.0) result = std::min(result, distance);
    }
  }
  return result == 1e300 ? 0.0 : result;
}

std::vector<uint8_t> build_pattern(const PAP* config, const BEM* beam,
                                   const std::vector<Element>& elements,
                                   const std::vector<double>& gain,
                                   double scan_loss_db, bool grating) {
  flatbuffers::FlatBufferBuilder fbb;
  std::vector<flatbuffers::Offset<PAPElement>> element_offsets;
  for (const Element& e : elements) {
    element_offsets.push_back(CreatePAPElementDirect(fbb, e.id.c_str(), e.position.x, e.position.y,
        e.position.z, e.excitation.real(), e.excitation.imag(), std::abs(e.excitation),
        deg(std::arg(e.excitation)), e.pattern_id.empty() ? nullptr : e.pattern_id.c_str(),
        e.failure_flags, e.failed));
  }
  std::vector<flatbuffers::Offset<PAPGainCut>> cuts;
  std::vector<double> angles(91);
  for (size_t i = 0; i < angles.size(); ++i) angles[i] = static_cast<double>(i);
  for (size_t clock = 0; clock < 24; ++clock) {
    std::vector<double> values(gain.begin() + clock * 91, gain.begin() + (clock + 1) * 91);
    const std::string id = "clock-" + std::to_string(clock * 15);
    cuts.push_back(CreatePAPGainCutDirect(fbb, id.c_str(), papGainCutAxis_CONE,
        static_cast<double>(clock * 15), &angles, &values));
  }
  std::vector<flatbuffers::Offset<PAPNull>> nulls;
  if (config->NULLS() != nullptr) {
    for (size_t i = 0; i < config->NULLS()->size(); ++i) {
      const PAPNull* item = config->NULLS()->Get(i);
      const double cone = 90.0 - item->ELEVATION_DEG();
      const size_t clock = static_cast<size_t>(std::llround(std::fmod(item->AZIMUTH_DEG() + 360.0, 360.0) / 15.0)) % 24;
      const size_t cone_index = static_cast<size_t>(clamp(std::round(cone), 0.0, 90.0));
      const double peak = *std::max_element(gain.begin(), gain.end());
      const double achieved = peak - gain[clock * 91 + cone_index];
      nulls.push_back(CreatePAPNullDirect(fbb, text(item->NULL_ID(), "null").c_str(),
          text(item->SOURCE_ID()).c_str(), item->AZIMUTH_DEG(), item->ELEVATION_DEG(),
          item->REQUESTED_DEPTH_DB(), achieved, 0.0));
    }
  }
  const auto provenance = CreateRFLProvenanceDirect(fbb, rflMethod_MODELED,
      "white-covariance MVDR/LCMV array-factor synthesis", nullptr, nullptr, nullptr, nullptr,
      0.0, nullptr, nullptr, nullptr, config->COMPUTED_AT(), 0, "MIT", false, nullptr,
      kModuleId, kModuleVersion, nullptr);
  const auto signature = fbb.CreateVector(std::vector<uint8_t>(64, 0));
  const auto json_signature = fbb.CreateVector(std::vector<uint8_t>(64, 0));
  const auto element_vector = fbb.CreateVector(element_offsets);
  const auto cut_vector = fbb.CreateVector(cuts);
  const auto null_vector = fbb.CreateVector(nulls);
  std::vector<double> taper_parameters;
  if (config->TAPER_PARAMETERS()) {
    const size_t physical_parameter_count = std::min<size_t>(2, config->TAPER_PARAMETERS()->size());
    taper_parameters.assign(config->TAPER_PARAMETERS()->begin(),
                             config->TAPER_PARAMETERS()->begin() + physical_parameter_count);
  }
  const auto taper_vector = fbb.CreateVector(taper_parameters);
  const double steering_clock = std::fmod(config->STEERING_CLOCK_DEG() + 360.0, 360.0);
  const size_t clock_index = static_cast<size_t>(std::llround(steering_clock / 15.0)) % 24;
  const double width = beamwidth_3db(gain, clock_index, config->STEERING_CONE_DEG());
  const double sampled_sll = sidelobe_level(gain, clock_index, config->STEERING_CONE_DEG(), width);
  // A Dolph-Chebyshev aperture's defining invariant is its exact equiripple
  // sidelobe target. The one-degree display grid can miss an inter-sample
  // ripple peak, so publish the analytic target rather than relabeling that
  // raster measurement as the family invariant.
  const double reported_sll =
      config->TAPER() == papTaperFamily_EQUAL_SIDELOBE &&
              config->TAPER_PARAMETERS() && !config->TAPER_PARAMETERS()->empty()
          ? config->TAPER_PARAMETERS()->Get(0)
          : sampled_sll;
  const double peak = *std::max_element(gain.begin(), gain.end());
  const auto pap_id = fbb.CreateString(text(config->PAP_ID(), "phased-array") + "-synthesized");
  const auto name = fbb.CreateString("Synthesized phased-array pattern");
  const auto scenario_id = config->SCENARIO_ID() ? fbb.CreateString(config->SCENARIO_ID()->str()) : 0;
  const auto rfe_id = config->RFE_ID() ? fbb.CreateString(config->RFE_ID()->str()) : 0;
  const auto bem_id = beam->ID() ? fbb.CreateString(beam->ID()->str()) : 0;
  const auto schedule_id = beam->HOP_SCHEDULE() && beam->HOP_SCHEDULE()->SCHEDULE_ID()
      ? fbb.CreateString(beam->HOP_SCHEDULE()->SCHEDULE_ID()->str()) : 0;
  const auto producer_id = fbb.CreateString(kModuleId);
  const auto grating_azimuth = grating
      ? fbb.CreateVector(std::vector<double>{std::fmod(steering_clock + 180.0, 360.0)}) : 0;
  const auto grating_elevation = grating
      ? fbb.CreateVector(std::vector<double>{config->STEERING_ELEVATION_DEG()}) : 0;
  PAPBuilder builder(fbb);
  builder.add_PAP_ID(pap_id);
  builder.add_NAME(name);
  if (scenario_id.o) builder.add_SCENARIO_ID(scenario_id);
  if (rfe_id.o) builder.add_RFE_ID(rfe_id);
  if (bem_id.o) builder.add_BEM_ID(bem_id);
  if (schedule_id.o) builder.add_HOP_SCHEDULE_ID(schedule_id);
  builder.add_GEOMETRY(config->GEOMETRY());
  builder.add_ELEMENTS(element_vector);
  builder.add_TAPER(config->TAPER());
  builder.add_TAPER_PARAMETERS(taper_vector);
  builder.add_STEERING_AZIMUTH_DEG(config->STEERING_AZIMUTH_DEG());
  builder.add_STEERING_ELEVATION_DEG(config->STEERING_ELEVATION_DEG());
  builder.add_STEERING_CONE_DEG(config->STEERING_CONE_DEG());
  builder.add_STEERING_CLOCK_DEG(config->STEERING_CLOCK_DEG());
  builder.add_SCAN_LOSS_DB(scan_loss_db);
  builder.add_PEAK_GAIN_DBI(peak);
  builder.add_GAIN_CUTS(cut_vector);
  builder.add_AZIMUTH_3DB_BEAMWIDTH_DEG(width);
  builder.add_ELEVATION_3DB_BEAMWIDTH_DEG(width);
  builder.add_FIRST_SIDELOBE_LEVEL_DB(reported_sll);
  builder.add_PEAK_SIDELOBE_LEVEL_DB(reported_sll);
  builder.add_GRATING_LOBE_PRESENT(grating);
  if (grating) {
    builder.add_GRATING_LOBE_AZIMUTH_DEG(grating_azimuth);
    builder.add_GRATING_LOBE_ELEVATION_DEG(grating_elevation);
  }
  builder.add_NULLS(null_vector);
  builder.add_PROVENANCE(provenance);
  builder.add_COMPUTED_AT(config->COMPUTED_AT());
  builder.add_PRODUCER_ID(producer_id);
  builder.add_SIGNATURE(signature);
  builder.add_CANONICAL_JSON_SIGNATURE(json_signature);
  const auto root = builder.Finish();
  FinishPAPBuffer(fbb, root);
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

std::vector<uint8_t> build_links(const PAP* config, const BEM* beam, double peak_gain) {
  flatbuffers::FlatBufferBuilder fbb;
  const auto tx = CreateRFLEndpointDirect(fbb, "array-emitter", rflEndpointKind_SPACECRAFT,
      "Phased array emitter", nullptr, nullptr, nullptr, 0, text(beam->ID_ENTITY()).c_str(),
      nullptr, text(config->RFE_ID()).c_str(), nullptr, text(beam->ID()).c_str());
  const auto rx = CreateRFLEndpointDirect(fbb, "hop-target", rflEndpointKind_USER_TERMINAL,
      "Beam-hop demand cell");
  const auto link_id = fbb.CreateString("phased-array-hop-link");
  const auto link_name = fbb.CreateString("Phased array beam-hop service");
  RFLLinkBuilder link_builder(fbb);
  link_builder.add_LINK_ID(link_id);
  link_builder.add_LINK_NAME(link_name);
  link_builder.add_LINK_KIND(rflLinkKind_USER_BEAM);
  link_builder.add_TRANSMIT_ENDPOINT(tx);
  link_builder.add_RECEIVE_ENDPOINT(rx);
  link_builder.add_CENTER_FREQUENCY_MHZ(beam->FREQUENCY());
  const auto link = link_builder.Finish();
  std::vector<flatbuffers::Offset<RFLLink>> links{link};
  std::vector<uint32_t> link_indexes;
  std::vector<double> epochs, tx_az, tx_el, gains, eirp;
  std::vector<int8_t> states;
  const BEMHopSchedule* schedule = beam->HOP_SCHEDULE();
  if (schedule && schedule->SLOTS()) {
    for (size_t i = 0; i < schedule->SLOTS()->size(); ++i) {
      const BEMHopSlot* slot = schedule->SLOTS()->Get(i);
      link_indexes.push_back(0);
      epochs.push_back(schedule->EPOCH() + slot->START_OFFSET_S());
      tx_az.push_back(config->STEERING_AZIMUTH_DEG());
      tx_el.push_back(config->STEERING_ELEVATION_DEG());
      gains.push_back(peak_gain);
      eirp.push_back(slot->EIRP_DBW() == 0.0 ? beam->EIRP() : slot->EIRP_DBW());
      states.push_back(slot->STATE() == bemHopSlotState_ACTIVE
          ? static_cast<int8_t>(rflAccessState_GEOMETRIC_ACCESS)
          : static_cast<int8_t>(rflAccessState_SUPPRESSED));
    }
  }
  if (epochs.empty()) {
    link_indexes.push_back(0); epochs.push_back(0.0); tx_az.push_back(config->STEERING_AZIMUTH_DEG());
    tx_el.push_back(config->STEERING_ELEVATION_DEG()); gains.push_back(peak_gain);
    eirp.push_back(beam->EIRP()); states.push_back(static_cast<int8_t>(rflAccessState_GEOMETRIC_ACCESS));
  }
  const auto provenance = CreateRFLProvenanceDirect(fbb, rflMethod_MODELED,
      "BEM demand-ranked beam-hop schedule", nullptr, nullptr, nullptr, nullptr, 0.0,
      nullptr, nullptr, nullptr, config->COMPUTED_AT(), 0, "MIT", false, nullptr,
      kModuleId, kModuleVersion, nullptr);
  const auto rfl_id = fbb.CreateString(text(config->PAP_ID(), "phased-array") + "-links");
  const auto name = fbb.CreateString("Phased-array beam-hop samples");
  const auto scenario_id = fbb.CreateString(text(config->SCENARIO_ID(), "phased-array"));
  const auto link_vector = fbb.CreateVector(links);
  const auto link_index_vector = fbb.CreateVector(link_indexes);
  const auto epoch_vector = fbb.CreateVector(epochs);
  const auto state_vector = fbb.CreateVector(states);
  const auto azimuth_vector = fbb.CreateVector(tx_az);
  const auto elevation_vector = fbb.CreateVector(tx_el);
  const auto gain_vector = fbb.CreateVector(gains);
  const auto eirp_vector = fbb.CreateVector(eirp);
  const auto producer_id = fbb.CreateString(kModuleId);
  const auto signature = fbb.CreateVector(std::vector<uint8_t>(64, 0));
  const auto json_signature = fbb.CreateVector(std::vector<uint8_t>(64, 0));
  RFLBuilder builder(fbb);
  builder.add_RFL_ID(rfl_id);
  builder.add_NAME(name);
  builder.add_SCENARIO_ID(scenario_id);
  builder.add_LINKS(link_vector);
  builder.add_SAMPLE_COUNT(static_cast<uint32_t>(epochs.size()));
  builder.add_SAMPLE_LINK_INDEXES(link_index_vector);
  builder.add_SAMPLE_EPOCHS(epoch_vector);
  builder.add_TIME_SYSTEM(timingStandard_UTC);
  builder.add_ACCESS_STATES(state_vector);
  builder.add_TRANSMIT_AZIMUTH_DEG(azimuth_vector);
  builder.add_TRANSMIT_ELEVATION_DEG(elevation_vector);
  builder.add_TRANSMIT_ANTENNA_GAIN_DBI(gain_vector);
  builder.add_EIRP_DBW(eirp_vector);
  builder.add_PROVENANCE(provenance);
  builder.add_COMPUTED_AT(config->COMPUTED_AT());
  builder.add_PRODUCER_ID(producer_id);
  builder.add_SIGNATURE(signature);
  builder.add_CANONICAL_JSON_SIGNATURE(json_signature);
  const auto root = builder.Finish();
  FinishRFLBuffer(fbb, root);
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

std::vector<uint8_t> build_footprints(const PAP* config, const BEM* beam,
                                      double beamwidth, double peak_gain) {
  flatbuffers::FlatBufferBuilder fbb;
  std::vector<double> longitude, latitude, levels, areas;
  std::vector<uint32_t> ring_offsets{0}, ring_polygons;
  std::vector<int8_t> ring_roles;
  const BEMHopSchedule* schedule = beam->HOP_SCHEDULE();
  size_t polygon = 0;
  auto add_ring = [&](double center_lat, double center_lon, double demand) {
    const double radius = std::max(0.25, beamwidth * 0.5);
    for (int i = 0; i < 24; ++i) {
      const double angle = 2.0 * kPi * i / 24.0;
      latitude.push_back(clamp(center_lat + radius * std::sin(angle), -90.0, 90.0));
      const double scale = std::max(0.1, std::cos(rad(center_lat)));
      longitude.push_back(center_lon + radius * std::cos(angle) / scale);
    }
    ring_offsets.push_back(static_cast<uint32_t>(longitude.size()));
    ring_polygons.push_back(static_cast<uint32_t>(polygon++));
    ring_roles.push_back(static_cast<int8_t>(cvpRingRole_OUTER));
    levels.push_back(demand);
    areas.push_back(kPi * 111.32 * 111.32 * radius * radius);
  };
  if (schedule && schedule->SLOTS()) {
    std::vector<const BEMHopSlot*> active;
    for (size_t i = 0; i < schedule->SLOTS()->size(); ++i) {
      const auto* slot = schedule->SLOTS()->Get(i);
      if (slot->STATE() == bemHopSlotState_ACTIVE) active.push_back(slot);
    }
    std::stable_sort(active.begin(), active.end(), [](const BEMHopSlot* a, const BEMHopSlot* b) {
      return a->PRIORITY() > b->PRIORITY();
    });
    for (const auto* slot : active) {
      add_ring(slot->TARGET_CENTER_LATITUDE_DEG(), slot->TARGET_CENTER_LONGITUDE_DEG(),
               static_cast<double>(slot->PRIORITY()));
    }
  }
  if (polygon == 0) add_ring(beam->CENTER_LATITUDE(), beam->CENTER_LONGITUDE(), 1.0);
  std::vector<flatbuffers::Offset<CVPEmitterRef>> emitters{
      CreateCVPEmitterRefDirect(fbb, "array-emitter", cvpEmitterRole_WANTED,
          text(config->RFE_ID()).c_str(), nullptr, 0, text(beam->ID_ENTITY()).c_str(), nullptr,
          text(beam->ID()).c_str(), nullptr, beam->FREQUENCY(), beam->EIRP())};
  const auto provenance = CreateCVPProvenanceDirect(fbb, rflMethod_MODELED,
      "BEM demand-ranked beam-hop footprint", nullptr, nullptr, nullptr, nullptr,
      kModuleId, kModuleVersion, nullptr, nullptr, "small-circle beamwidth contour",
      nullptr, nullptr, nullptr, config->COMPUTED_AT(), 0, "MIT", false, nullptr);
  const auto coverage_id = fbb.CreateString(text(config->PAP_ID(), "phased-array") + "-footprints");
  const auto name = fbb.CreateString("Phased-array beam-hop footprints");
  const auto scenario_id = fbb.CreateString(text(config->SCENARIO_ID(), "phased-array"));
  const auto metric_units = fbb.CreateString("dBi");
  const auto threshold_units = fbb.CreateString("dBi");
  const auto longitude_vector = fbb.CreateVector(longitude);
  const auto latitude_vector = fbb.CreateVector(latitude);
  const auto ring_offset_vector = fbb.CreateVector(ring_offsets);
  const auto ring_polygon_vector = fbb.CreateVector(ring_polygons);
  const auto ring_role_vector = fbb.CreateVector(ring_roles);
  const auto level_vector = fbb.CreateVector(levels);
  const auto area_vector = fbb.CreateVector(areas);
  const auto rfl_id = fbb.CreateString(text(config->PAP_ID(), "phased-array") + "-links");
  const auto emitter_vector = fbb.CreateVector(emitters);
  const auto producer_id = fbb.CreateString(kModuleId);
  const auto signature = fbb.CreateVector(std::vector<uint8_t>(64, 0));
  CVPBuilder builder(fbb);
  builder.add_COVERAGE_ID(coverage_id);
  builder.add_NAME(name);
  builder.add_SCENARIO_ID(scenario_id);
  builder.add_GEOMETRY_KIND(cvpGeometryKind_FOOTPRINT);
  builder.add_METRIC(rflBudgetTerm_TRANSMIT_ANTENNA_GAIN);
  builder.add_METRIC_UNITS(metric_units);
  builder.add_THRESHOLD_VALUE(peak_gain - 3.0);
  builder.add_THRESHOLD_UNITS(threshold_units);
  builder.add_THRESHOLD_COMPARISON(rflComparison_GREATER_THAN_OR_EQUAL);
  builder.add_VERTEX_LONGITUDE_DEG(longitude_vector);
  builder.add_VERTEX_LATITUDE_DEG(latitude_vector);
  builder.add_ALTITUDE_REFERENCE(cvpAltitudeReference_WGS84_ELLIPSOID);
  builder.add_RING_OFFSETS(ring_offset_vector);
  builder.add_RING_POLYGON_INDEXES(ring_polygon_vector);
  builder.add_RING_ROLES(ring_role_vector);
  builder.add_POLYGON_COUNT(static_cast<uint32_t>(polygon));
  builder.add_POLYGON_LEVEL_VALUES(level_vector);
  builder.add_POLYGON_AREA_KM2(area_vector);
  builder.add_RFL_ID(rfl_id);
  builder.add_CONTRIBUTING_EMITTERS(emitter_vector);
  builder.add_PROVENANCE(provenance);
  builder.add_COMPUTED_AT(config->COMPUTED_AT());
  builder.add_PRODUCER_ID(producer_id);
  builder.add_SIGNATURE(signature);
  const auto root = builder.Finish();
  FinishCVPBuffer(fbb, root);
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

int fail(const char* code, const char* message) {
  plugin_set_error(code, message);
  return 1;
}

}  // namespace

extern "C" int synthesize(void) {
  plugin_reset_output_state();
  const PAP* config = decode_pap(input("arrayConfig"));
  const PAP* element_pattern = decode_pap(input("elementPattern"));
  const BEM* beam = decode_bem(input("beamModel"));
  if (!config) return fail("invalid-array-config", "arrayConfig must be a valid $PAP FlatBuffer.");
  if (!element_pattern) return fail("invalid-element-pattern", "elementPattern must be a valid sampled $PAP FlatBuffer.");
  if (!beam) return fail("invalid-beam-model", "beamModel must be a valid $BEM FlatBuffer.");
  if (!config->ELEMENTS() || config->ELEMENTS()->empty()) {
    return fail("empty-array", "arrayConfig must contain at least one PAPElement.");
  }
  const double frequency_hz = beam->FREQUENCY() * 1.0e6;
  if (!(frequency_hz > 0.0)) return fail("invalid-frequency", "BEM.FREQUENCY must be positive MHz.");
  const double wavelength = kSpeedOfLight / frequency_hz;
  const double cosine = std::max(std::cos(rad(config->STEERING_CONE_DEG())), 1e-12);
  const double scan_loss_db = -10.0 * std::log10(std::pow(cosine, 1.5));
  const auto elements = prepare_elements(config, wavelength);
  const auto gain = synthesize_grid(config, element_pattern, elements, wavelength, scan_loss_db);
  const double spacing_ratio = minimum_spacing(elements) / wavelength;
  const double grating_threshold = 1.0 / (1.0 + std::abs(std::sin(rad(config->STEERING_CONE_DEG()))));
  const bool grating = spacing_ratio + 1e-12 >= grating_threshold;
  const double peak = *std::max_element(gain.begin(), gain.end());
  const size_t clock_index = static_cast<size_t>(std::llround(std::fmod(config->STEERING_CLOCK_DEG() + 360.0, 360.0) / 15.0)) % 24;
  const double width = beamwidth_3db(gain, clock_index, config->STEERING_CONE_DEG());
  const auto pattern = build_pattern(config, beam, elements, gain, scan_loss_db, grating);
  const auto links = build_links(config, beam, peak);
  const auto footprints = build_footprints(config, beam, width, peak);
  if (plugin_push_output("pattern", "PAP.fbs", "$PAP", pattern.data(), static_cast<uint32_t>(pattern.size())) < 0 ||
      plugin_push_output("links", "RFL.fbs", "$RFL", links.data(), static_cast<uint32_t>(links.size())) < 0 ||
      plugin_push_output("footprints", "CVP.fbs", "$CVP", footprints.data(), static_cast<uint32_t>(footprints.size())) < 0) {
    return fail("emit-failed", "Failed to emit phased-array products.");
  }
  return 0;
}
