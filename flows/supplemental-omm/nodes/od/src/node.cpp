// flows/supplemental-omm OD node (typed contracts 1.0: FlatBuffers only, no JSON, no FSB/FSO transport).
//
//   fit             in   starlink | glonass | intelsat | cpf | iss   SDS $OEM, one object per frame, from the flow's
//                                                                    source modules (data-source/*-source emit)
//                   out  omm_meta + omm   IngestRequest (INGQ) + the object's size-prefixed $OMM record stream
//                        ocm_meta + ocm   INGQ + size-prefixed $OCM stream (the OD core's state and covariance)
//                        obd_meta + obd   INGQ + size-prefixed $OBD stream (the fit diagnostics)
//                        status           FlowNotice (FNTC): Info "fitted", Skipped "unfittable" / "fit-failed"
//   publish_request in   result (IngestResult, INGR, from hostcap/storage-ingest) + meta (the INGQ it stored)
//                   out  request (HttpRequest, HREQ): the dataset-publication POST, its BODY the IngestResult; nothing
//                        when omm_publish_url is unset or the batch was refused
//
// Each $OEM is read into the object's states in the source's own axes and time scale and handed to the frozen
// complete-arc OD core exactly as before: velocity-bearing sources (Starlink MEME, ISS OEM; EME2000) as the verbose
// $OEM with an epoch per state, position-only sources (GLONASS SP3, Intelsat ECF, CPF; Earth-fixed or EME2000) as the
// compact position-only $OEM (STATE_VECTOR_SIZE 3) the fitter seeds its velocities from, refused here when the fitter
// could not fit the arc. Every ephemeris is also fitted with SGP4-XP (propagator/sgp4-xp, joined by build.mjs). One
// object is fitted per invocation; the rest wait as backlog. Its records go out as one record stream per standard,
// each with the IngestRequest that files it (hostcap/storage-ingest stores it).

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <flatbuffers/flatbuffers.h>

// The frozen fit core (vendor/od-fit-core.o, wasi-sdk 22, libc++ 18, ABI v2) hands its results back in std::vector and
// std::string. libc++ 20 onwards lays std::vector out by size under ABI v2 (_LIBCPP_ABI_VECTOR_LAYOUT_SIZE_BASED), and
// a node compiled so frees the core's vectors as garbage. Build with a libc++ that keeps the pointer layout (wasi-sdk
// 30, libc++ 21: WASI_SDK_PATH, see build.mjs).
#if defined(_LIBCPP_ABI_VECTOR_LAYOUT_SIZE_BASED)
#error "this libc++ lays std::vector out by size; the frozen OD fit core passes vectors in the pointer layout"
#endif

#include "FlowNotice_generated.h"
#include "HttpRequest_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"
#include "OEM_generated.h"
#include "od_batch_fit.hpp"
#include "oem_fb_builder.hpp"
#include "sds_cid.hpp"

// SGP4-XP element sets of every ephemeris, beside the SGP4 sets of the OD core: the fit engine of
// propagator/sgp4-xp (the US Space Force Sgp4Prop joined to this node by build.mjs) and its SDS records.
#include "OBD_generated.h"
#include "OMM_generated.h"
#include "engine.hpp"
#include "records.hpp"

namespace od {

// ABI-matching declaration for the frozen fit-core entry point. Keeping this
// declaration in the node lets the node pass deterministic fitter policy without
// changing or rebuilding the independently pinned core object.
struct PluginFitFBResult {
  bool ok = false;
  std::vector<uint8_t> omm;
  std::vector<uint8_t> obd;
  std::vector<uint8_t> ocm;
  std::string error_code;
  std::string error_message;
  double rms_km = 0.0;
  bool converged = false;
  double mean_motion = 0.0;
};

std::vector<PluginFitFBResult> fit_ephemeris_epochs_fb(
    const uint8_t* oem_buf,
    std::size_t oem_len,
    std::string_view options_json);

}  // namespace od

namespace {

namespace R = sdn::runtime;

constexpr size_t kMaxOutputStreamBytes = 128u * 1024u * 1024u;
// The frozen core's options parameter (its own ABI, unchanged): the deterministic optimizer bound.
constexpr std::string_view kFitOptions = R"json({"maxIterations":40})json";
constexpr const char* kProviderId = "supplemental-omm";
constexpr const char* kParser = "org.sdn.flows.supplemental-omm.od";
constexpr const char* kParserVersion = "2.0.0";

enum class Provider : uint8_t { Starlink, Glonass, Intelsat, Cpf, Iss };

struct ProviderInfo {
  const char* port_id;
  Provider provider;
  const char* source_name;   // the stored SOURCE_NAME of the fits (analysis/catalog-synthesis reads it)
  const char* originator;    // the XP $OMM's ORIGINATOR: who produced the ephemeris
  const char* source_plugin; // the module that read it (the XP $OMM COMMENT, the $OBD sensor)
  bool position_only;        // the source gives positions only
};

constexpr ProviderInfo kProviders[] = {
    {"starlink", Provider::Starlink, "spacex-starlink", "SpaceX", "com.orbpro.spacex-starlink-source", false},
    {"glonass", Provider::Glonass, "glonass", "CODE (Astronomical Institute, University of Bern)", "com.orbpro.glonass-source", true},
    {"intelsat", Provider::Intelsat, "intelsat", "Intelsat", "com.orbpro.intelsat-source", true},
    {"cpf", Provider::Cpf, "cpf", "ILRS (EDC, DGFI-TUM)", "com.orbpro.cpf-source", true},
    {"iss", Provider::Iss, "iss", "NASA/JSC/FOD/TOPO", "com.orbpro.iss-source", false},
};

const ProviderInfo* provider_for_port(const char* port_id) {
  if (!port_id) return nullptr;
  for (const ProviderInfo& p : kProviders) {
    if (std::strcmp(port_id, p.port_id) == 0) return &p;
  }
  return nullptr;
}

struct NativeState {
  std::string epoch;
  // The epoch in seconds on the source's own time scale, used to group evenly
  // spaced position-only states into compact $OEM blocks.
  double seconds = 0.0;
  double x = 0.0, y = 0.0, z = 0.0;
  double vx = 0.0, vy = 0.0, vz = 0.0;
};

// The states of one object for the SGP4-XP fit: the same states the core's $OEM was built from, in the source's own
// axes, their instants in UTC.
struct XpInput {
  std::vector<sgp4xp::Observed> states;
  sgp4xp::Frame frame = sgp4xp::Frame::Teme;
  std::string name;
  std::string object_id;
  uint32_t norad = 0;
};

struct PendingFitObject {
  od::BatchObject object;
  XpInput xp;
  const ProviderInfo* provider = nullptr;
  std::string identity;
};

std::deque<PendingFitObject> g_pending;

// --- epochs ---------------------------------------------------------------------------------------------------------

std::string calendar_iso(int year, int month, int day, int hour, int minute, double seconds) {
  int whole_seconds = static_cast<int>(seconds);
  int millis = static_cast<int>((seconds - whole_seconds) * 1000.0 + 0.5);
  if (millis >= 1000) {
    ++whole_seconds;
    millis -= 1000;
  }
  char buffer[48];
  std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", year, month, day, hour, minute,
                whole_seconds, millis);
  return buffer;
}

// Days from 1970-01-01 of a proleptic Gregorian date, and back (H. Hinnant).
int64_t days_from_civil(int64_t y, int m, int d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const int64_t yoe = y - era * 400;
  const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

void civil_from_days(int64_t z, int* y, int* m, int* d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const int64_t doe = z - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  *d = static_cast<int>(doy - (153 * mp + 2) / 5 + 1);
  *m = static_cast<int>(mp < 10 ? mp + 3 : mp - 9);
  *y = static_cast<int>(yoe + era * 400 + (*m <= 2));
}

// An ISO 8601 calendar stamp "YYYY-MM-DDThh:mm:ss[.fff...][Z]" as whole days from 1970 and seconds of its day, on the
// time scale the $OEM's TIME_SYSTEM names.
bool parse_calendar(std::string_view text, int64_t* day, double* second_of_day) {
  if (text.size() < 19 || text[4] != '-' || text[7] != '-' || (text[10] != 'T' && text[10] != ' ') || text[13] != ':' ||
      text[16] != ':') {
    return false;
  }
  for (size_t i : {0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18}) {
    if (!std::isdigit(static_cast<unsigned char>(text[i]))) return false;
  }
  const auto num = [&](size_t at, size_t n) { return std::atoi(std::string(text.substr(at, n)).c_str()); };
  const int year = num(0, 4), month = num(5, 2), dom = num(8, 2), hour = num(11, 2), minute = num(14, 2);
  std::string sec(text.substr(17));
  if (!sec.empty() && sec.back() == 'Z') sec.pop_back();
  char* end = nullptr;
  const double seconds = std::strtod(sec.c_str(), &end);
  if (end == sec.c_str() || *end != '\0' || month < 1 || month > 12 || dom < 1 || dom > 31) return false;
  *day = days_from_civil(year, month, dom);
  *second_of_day = hour * 3600.0 + minute * 60.0 + seconds;
  return true;
}

// The stamp `seconds_after` seconds after (day, second_of_day), as the node writes epochs: milliseconds and "Z" (the
// time scale stays the $OEM's TIME_SYSTEM).
std::string stamp_after(int64_t day, double second_of_day, double seconds_after, double* unix_seconds) {
  double s = second_of_day + seconds_after;
  const double whole_days = std::floor(s / 86400.0);
  day += static_cast<int64_t>(whole_days);
  s -= whole_days * 86400.0;
  int y, m, d;
  civil_from_days(day, &y, &m, &d);
  const int hour = static_cast<int>(s / 3600.0);
  const int minute = static_cast<int>((s - hour * 3600.0) / 60.0);
  const double second = s - hour * 3600.0 - minute * 60.0;
  *unix_seconds = static_cast<double>(day) * 86400.0 + s;
  return calendar_iso(y, m, d, hour, minute, second);
}

// --- the core's $OEM ------------------------------------------------------------------------------------------------

flatbuffers::Offset<RFM> build_reference_frame(flatbuffers::FlatBufferBuilder* builder, CustomFrame frame) {
  auto wrapper = CreateCustomFrameWrapper(*builder, frame);
  RFMBuilder rfm(*builder);
  rfm.add_REFERENCE_FRAME_type(RFMUnionTraits<CustomFrameWrapper>::enum_value);
  rfm.add_REFERENCE_FRAME(wrapper.Union());
  return rfm.Finish();
}

flatbuffers::Offset<RFM> build_reference_frame(flatbuffers::FlatBufferBuilder* builder, CelestialFrame frame) {
  auto wrapper = CreateCelestialFrameWrapper(*builder, frame);
  RFMBuilder rfm(*builder);
  rfm.add_REFERENCE_FRAME_type(RFMUnionTraits<CelestialFrameWrapper>::enum_value);
  rfm.add_REFERENCE_FRAME(wrapper.Union());
  return rfm.Finish();
}

// Position-only sources (CPF, SP3, ECF) carry no velocity. The fit core's reader takes every EPHEMERIS_DATA_LINES row
// as a full state, so a row with zero velocity is a body at rest in its source frame: Earth-fixed, it rotates to
// omega x r in TEME and the fit starts from a near-radial orbit (the LAGEOS-1 CPF arc fitted to e 0.966, n 16.79
// rev/day, B* at its bound, instead of e 0.0045, n 6.387). The reader's position-only shape is the compact form with
// STATE_VECTOR_SIZE 3: it marks the series position-only and the fitter seeds the initial velocity from the positions.
// Compact epochs are START_TIME + i * STEP_SIZE, so each run of evenly spaced states is one block; a gap or a cadence
// change starts the next.
//
// The fitter seeds each local fit from the quadratic derivative of the three positions around its epoch. An arc it
// cannot fit is refused here instead: epochs must strictly increase (a repeated epoch divides by zero in that
// derivative), and every such seed must be a bound Earth orbit. An unbound seed has no mean motion; the core's
// deep-space propagator then loops without end on the NaN elements (a GEO-radius circle traced at the inertial rate in
// the Earth-fixed frame is one: 6.1 km/s against a 4.3 km/s escape speed).
bool earth_fixed(CustomFrame frame) { return frame == CustomFrame::ECEF; }
bool earth_fixed(CelestialFrame) { return false; }

bool position_only_arc_is_fittable(const std::vector<NativeState>& states, bool earth_fixed_frame) {
  constexpr double kCadenceToleranceSeconds = 1e-3;
  // The fit core's WGS-72 constants (sgp4_fitter.cpp MU_EARTH and frame_transform.cpp kOmegaEarth).
  constexpr double kMuEarth = 398600.8;
  constexpr double kOmegaEarth = 7.29211514668855e-5;
  const size_t count = states.size();
  if (count < 3) return false;
  for (size_t index = 0; index < count; ++index) {
    const NativeState& state = states[index];
    if (!std::isfinite(state.seconds) || !std::isfinite(state.x) || !std::isfinite(state.y) ||
        !std::isfinite(state.z)) {
      return false;
    }
    if (index > 0 && !(state.seconds - states[index - 1].seconds > kCadenceToleranceSeconds)) return false;
  }
  for (size_t index = 0; index < count; ++index) {
    // The fitter's window: the first three, the last three, else centred.
    const size_t first = index == 0 ? 0 : (index >= count - 1 ? count - 3 : index - 1);
    const NativeState& p0 = states[first];
    const NativeState& p1 = states[first + 1];
    const NativeState& p2 = states[first + 2];
    const double t1 = p1.seconds - p0.seconds;
    const double t2 = p2.seconds - p0.seconds;
    const double te = states[index].seconds - p0.seconds;
    const double l0 = (2.0 * te - t1 - t2) / (t1 * t2);
    const double l1 = (2.0 * te - t2) / (t1 * (t1 - t2));
    const double l2 = (2.0 * te - t1) / (t2 * (t2 - t1));
    double vx = p0.x * l0 + p1.x * l1 + p2.x * l2;
    double vy = p0.y * l0 + p1.y * l1 + p2.y * l2;
    const double vz = p0.z * l0 + p1.z * l1 + p2.z * l2;
    const NativeState& at = states[index];
    if (earth_fixed_frame) {
      // Inertial speed is |v_fixed + omega x r|, whatever the rotation angle.
      vx -= kOmegaEarth * at.y;
      vy += kOmegaEarth * at.x;
    }
    const double radius = std::sqrt(at.x * at.x + at.y * at.y + at.z * at.z);
    const double energy = 0.5 * (vx * vx + vy * vy + vz * vz) - kMuEarth / radius;
    if (!(radius > 0.0) || !(energy < 0.0)) return false;
  }
  return true;
}

template <typename Frame>
std::vector<uint8_t> build_position_only_oem(const std::string& object_name, const std::string& object_id,
                                             uint32_t norad, Frame frame, timingStandard time_system,
                                             const std::vector<NativeState>& states) {
  constexpr double kCadenceToleranceSeconds = 1e-3;
  if (!position_only_arc_is_fittable(states, earth_fixed(frame))) return {};
  flatbuffers::FlatBufferBuilder builder(1 << 16);
  std::vector<flatbuffers::Offset<ephemerisDataBlock>> blocks;
  size_t start = 0;
  double step = 0.0;
  while (start < states.size()) {
    size_t end = start + 1;
    if (end < states.size()) {
      step = states[end].seconds - states[start].seconds;
      ++end;
      while (end < states.size() &&
             std::fabs(states[end].seconds - states[end - 1].seconds - step) <= kCadenceToleranceSeconds) {
        ++end;
      }
    }
    std::vector<double> data;
    data.reserve((end - start) * 3);
    for (size_t index = start; index < end; ++index) {
      data.push_back(states[index].x);
      data.push_back(states[index].y);
      data.push_back(states[index].z);
    }
    auto data_vector = builder.CreateVector(data);
    auto name = builder.CreateString(object_name);
    auto id = builder.CreateString(object_id);
    CATBuilder cat(builder);
    cat.add_OBJECT_NAME(name);
    cat.add_OBJECT_ID(id);
    cat.add_NORAD_CAT_ID(norad);
    auto object = cat.Finish();
    auto reference_frame = build_reference_frame(&builder, frame);
    auto center = builder.CreateString("EARTH");
    auto start_time = builder.CreateString(states[start].epoch);
    auto stop_time = builder.CreateString(states[end - 1].epoch);
    ephemerisDataBlockBuilder block(builder);
    block.add_OBJECT(object);
    block.add_CENTER_NAME(center);
    block.add_REFERENCE_FRAME(reference_frame);
    block.add_TIME_SYSTEM(time_system);
    block.add_START_TIME(start_time);
    block.add_STOP_TIME(stop_time);
    block.add_STEP_SIZE(step);
    block.add_STATE_VECTOR_SIZE(3);
    block.add_EPHEMERIS_DATA(data_vector);
    blocks.push_back(block.Finish());
    start = end;
  }
  auto block_vector = builder.CreateVector(blocks);
  OEMBuilder oem(builder);
  oem.add_EPHEMERIS_DATA_BLOCK(block_vector);
  FinishOEMBuffer(builder, oem.Finish());
  const uint8_t* bytes = builder.GetBufferPointer();
  return std::vector<uint8_t>(bytes, bytes + builder.GetSize());
}

std::vector<uint8_t> build_celestial_oem(const std::string& object_name, const std::string& object_id, uint32_t norad,
                                         CelestialFrame frame, timingStandard time_system,
                                         const std::vector<NativeState>& states) {
  if (states.size() < 3) return {};
  const oem_fb::Identity identity{object_name.c_str(), object_id.c_str(), norad};
  return oem_fb::build_oem_flatbuffer(identity, frame, "EARTH", time_system, states.data(),
                                      static_cast<int>(states.size()));
}

XpInput make_xp_input(const std::vector<NativeState>& states, sgp4xp::Frame frame, sgp4xp::TimeScale scale,
                      bool velocities, const std::string& name, const std::string& object_id, uint32_t norad) {
  XpInput input;
  input.frame = frame;
  input.name = name;
  input.object_id = object_id;
  input.norad = norad;
  input.states.reserve(states.size());
  for (const NativeState& state : states) {
    sgp4xp::Observed observed;
    if (!sgp4xp::utcOf(state.epoch, scale, &observed.t)) {
      input.states.clear();
      return input;
    }
    observed.r[0] = state.x;
    observed.r[1] = state.y;
    observed.r[2] = state.z;
    if (velocities) {
      observed.v[0] = state.vx;
      observed.v[1] = state.vy;
      observed.v[2] = state.vz;
      observed.hasVelocity = true;
    }
    input.states.push_back(observed);
  }
  return input;
}

std::string text_of(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

std::string describe(const std::string& name, const std::string& object_id, uint32_t norad) {
  const std::string label = !name.empty() ? name : object_id;
  if (!label.empty() && norad > 0) return label + " (NORAD " + std::to_string(norad) + ")";
  if (!label.empty()) return label;
  if (norad > 0) return "NORAD " + std::to_string(norad);
  return {};
}

// One $OEM from a source as the core's input and the XP input. Every block's states, in order, are the object's (the
// sources give one block). The axes and time scale are the $OEM's own: EME2000, or Earth-fixed (CustomFrame ECEF); UTC
// or GPS. `why` says what makes an $OEM unusable; an arc the core cannot fit leaves `pending->object.oem` empty.
bool read_source_oem(const ProviderInfo& provider, const uint8_t* bytes, uint32_t length, PendingFitObject* pending,
                     std::string* why) {
  flatbuffers::Verifier verifier(bytes, length);
  if (!OEMBufferHasIdentifier(bytes) || !VerifyOEMBuffer(verifier)) {
    *why = "not an SDS $OEM FlatBuffer";
    return false;
  }
  const OEM* oem = GetOEM(bytes);
  const auto* blocks = oem->EPHEMERIS_DATA_BLOCK();
  if (!blocks || blocks->size() == 0) {
    *why = "the $OEM has no ephemeris data block";
    return false;
  }
  std::string name, object_id;
  uint32_t norad = 0;
  bool celestial = false;
  CelestialFrame celestial_frame = CelestialFrame::EME2000;
  bool fixed = false;
  timingStandard time_system = timingStandard::UTC;
  std::vector<NativeState> states;
  for (flatbuffers::uoffset_t b = 0; b < blocks->size(); ++b) {
    const ephemerisDataBlock* block = blocks->Get(b);
    if (!block) continue;
    if (b == 0) {
      if (const CAT* cat = block->OBJECT()) {
        name = text_of(cat->OBJECT_NAME());
        object_id = text_of(cat->OBJECT_ID());
        norad = cat->NORAD_CAT_ID();
      }
      const RFM* rfm = block->REFERENCE_FRAME();
      if (const auto* c = rfm ? rfm->REFERENCE_FRAME_as_CelestialFrameWrapper() : nullptr) {
        celestial = true;
        celestial_frame = c->frame();
      } else if (const auto* f = rfm ? rfm->REFERENCE_FRAME_as_CustomFrameWrapper() : nullptr) {
        fixed = f->frame() == CustomFrame::ECEF;
      }
      time_system = block->TIME_SYSTEM();
    }
    if (const auto* lines = block->EPHEMERIS_DATA_LINES(); lines && lines->size() > 0) {
      for (const ephemerisDataLine* line : *lines) {
        int64_t day = 0;
        double sod = 0.0;
        NativeState state;
        if (!line || !line->EPOCH() || !parse_calendar(line->EPOCH()->string_view(), &day, &sod)) {
          *why = "an ephemeris line's EPOCH is not an ISO 8601 calendar time";
          return false;
        }
        state.epoch = stamp_after(day, sod, 0.0, &state.seconds);
        state.x = line->X();
        state.y = line->Y();
        state.z = line->Z();
        state.vx = line->X_DOT();
        state.vy = line->Y_DOT();
        state.vz = line->Z_DOT();
        states.push_back(std::move(state));
      }
    } else if (const auto* data = block->EPHEMERIS_DATA(); data && data->size() > 0) {
      const uint32_t stride = block->STATE_VECTOR_SIZE() == 3 ? 3 : 6;
      int64_t day = 0;
      double sod = 0.0;
      if (!block->START_TIME() || !parse_calendar(block->START_TIME()->string_view(), &day, &sod)) {
        *why = "a compact block's START_TIME is not an ISO 8601 calendar time";
        return false;
      }
      for (uint32_t i = 0; i + stride <= data->size(); i += stride) {
        NativeState state;
        state.epoch = stamp_after(day, sod, (i / stride) * block->STEP_SIZE(), &state.seconds);
        state.x = data->Get(i);
        state.y = data->Get(i + 1);
        state.z = data->Get(i + 2);
        if (stride == 6) {
          state.vx = data->Get(i + 3);
          state.vy = data->Get(i + 4);
          state.vz = data->Get(i + 5);
        }
        states.push_back(std::move(state));
      }
    }
  }
  if (!celestial && !fixed) {
    *why = "the $OEM's REFERENCE_FRAME is neither a celestial frame nor Earth-fixed (CustomFrame ECEF)";
    return false;
  }
  if (celestial && celestial_frame != CelestialFrame::EME2000) {
    *why = "the $OEM's celestial REFERENCE_FRAME is not EME2000";
    return false;
  }
  if (time_system != timingStandard::UTC && time_system != timingStandard::GPS) {
    *why = "the $OEM's TIME_SYSTEM is neither UTC nor GPS";
    return false;
  }
  const sgp4xp::TimeScale scale = time_system == timingStandard::GPS ? sgp4xp::TimeScale::Gps : sgp4xp::TimeScale::Utc;
  const sgp4xp::Frame xp_frame = fixed ? sgp4xp::Frame::Itrf : sgp4xp::Frame::Eme2000;
  pending->provider = &provider;
  pending->identity = describe(name, object_id, norad);
  if (provider.position_only) {
    pending->object.oem = fixed ? build_position_only_oem(name, object_id, norad, CustomFrame::ECEF, time_system, states)
                                : build_position_only_oem(name, object_id, norad, celestial_frame, time_system, states);
  } else if (celestial) {
    pending->object.oem = build_celestial_oem(name, object_id, norad, celestial_frame, time_system, states);
  } else {
    *why = "an Earth-fixed $OEM from a source that gives velocities";
    return false;
  }
  if (!pending->object.oem.empty()) {
    pending->xp = make_xp_input(states, xp_frame, scale, !provider.position_only, name, object_id, norad);
  }
  return true;
}

// --- the fit --------------------------------------------------------------------------------------------------------

bool preflight_fit_epochs(const std::vector<od::PluginFitFBResult>& epochs, std::string* error_code,
                          std::string* error_message) {
  if (epochs.empty()) {
    *error_code = "fit-empty";
    *error_message = "complete-arc fitter produced no epoch records";
    return false;
  }
  for (const od::PluginFitFBResult& epoch : epochs) {
    if (!epoch.ok || epoch.omm.empty() || epoch.ocm.empty() || epoch.obd.empty()) {
      if (!epoch.ok) {
        *error_code = epoch.error_code.empty() ? "fit-epoch-failed" : epoch.error_code;
        *error_message = epoch.error_message.empty() ? "complete-arc fitter returned a failed epoch" : epoch.error_message;
      } else {
        *error_code = "fit-incomplete-epoch";
        *error_message = "complete-arc fitter returned an incomplete epoch record set";
      }
      return false;
    }
  }
  return true;
}

// One record stream: size-prefixed records back to back.
struct RecordStream {
  std::vector<uint8_t> bytes;
  uint64_t count = 0;
  bool add(const std::vector<uint8_t>& record) {
    if (record.empty()) return true;
    if (record.size() > kMaxOutputStreamBytes - bytes.size()) return false;
    bytes.insert(bytes.end(), record.begin(), record.end());
    ++count;
    return true;
  }
};

// ---------------------------------------------------------------------------
// SGP4-XP element sets beside the SGP4 sets of the OD core.
//
// Every ephemeris is also fitted with SGP4-XP, the US Space Force's perturbation model with a fitted ballistic term
// (BTERM) and solar-radiation term (AGOM): a day to fit (two thirds of an ephemeris shorter than a day and a half) and
// up to a day to score it, window after window while the ephemeris lasts, at most 16 (propagator/sgp4-xp,
// engine.hpp). Each fitted window is one $OMM (MEAN_ELEMENT_THEORY SGP4XP, BTERM in BSTAR, AGOM in MEAN_MOTION_DDOT)
// and one $OBD in the same record streams as the OD core's records, and names its source: the OMM's ORIGINATOR is the
// organisation that produced the ephemeris and the OBD's sensor is the source module's plugin ID. An ephemeris too
// short to hold a fit and three hours to score it gets no XP set; the OD core's sets are unaffected either way.
// ---------------------------------------------------------------------------
constexpr sgp4xp::WindowPolicy kXpWindowPolicy{86400.0, 86400.0, 10800.0, 16, 0};
constexpr const char* kXpProduct =
    "SDN supplemental-omm OD node over propagator/sgp4-xp 0.1.0 and the US Space Force Sgp4Prop 9.1.1.0 (XP build)";
constexpr uint32_t kUnknownNorad = 99999;  // the OD core's placeholder

template <typename T>
std::vector<uint8_t> size_prefixed(const T& native, const char* identifier) {
  flatbuffers::FlatBufferBuilder builder(4096);
  builder.FinishSizePrefixed(T::TableType::Pack(builder, &native), identifier);
  return std::vector<uint8_t>(builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize());
}

// Appends an $OMM and an $OBD for each fitted window. Returns the account that follows the object's completion
// message: empty when the ephemeris is too short to hold a fit and its scoring, else the number of sets and of windows
// refused. `ok` is false only when a stream would pass its size bound.
std::string append_xp_records(RecordStream* omm, RecordStream* obd, const PendingFitObject& pending, bool* ok) {
  *ok = true;
  if (pending.xp.states.empty()) return {};
  const uint32_t norad = pending.xp.norad != 0 ? pending.xp.norad : kUnknownNorad;
  sgp4xp::SourceFit fitted;
  std::string code;
  std::string why;
  if (!sgp4xp::fitSource(pending.xp.states, pending.xp.frame, norad, kXpWindowPolicy, &fitted, &code, &why)) {
    if (code == "arc-too-short" || code == "too-few-states") return {};
    return "; SGP4-XP refused: " + code + ": " + why;
  }
  sgp4xp::Provenance who;
  who.originator = pending.provider->originator;
  who.source = pending.provider->source_plugin;
  who.name = pending.xp.name;
  who.id = pending.xp.object_id;
  who.norad = norad;
  size_t appended = 0;
  for (const sgp4xp::IntervalFit& window : fitted.windows) {
    const std::unique_ptr<OMMT> o = sgp4xp::ommOf(window, who, kXpProduct);
    const std::unique_ptr<OBDT> d = sgp4xp::obdOf(window, who, kXpProduct);
    if (!omm->add(size_prefixed(*o, OMMIdentifier())) || !obd->add(size_prefixed(*d, OBDIdentifier()))) {
      *ok = false;
      return {};
    }
    ++appended;
  }
  std::string account = "; SGP4-XP: " + std::to_string(appended) + (appended == 1 ? " set" : " sets");
  if (!fitted.refusals.empty()) {
    account += ", " + std::to_string(fitted.refusals.size()) + " refused (" + fitted.refusals.front() + ")";
  }
  return account;
}

// --- outputs --------------------------------------------------------------------------------------------------------

std::string hex(const uint8_t* bytes, size_t n) {
  static const char* digits = "0123456789abcdef";
  std::string out(n * 2, '0');
  for (size_t i = 0; i < n; ++i) {
    out[2 * i] = digits[bytes[i] >> 4];
    out[2 * i + 1] = digits[bytes[i] & 15];
  }
  return out;
}

int32_t push(const char* port, const char* schema, const char* identifier, const char* root,
             const uint8_t* bytes, size_t size) {
  return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, bytes,
                               static_cast<uint32_t>(size));
}

// The batch of one standard: its IngestRequest on "<code>_meta", then its record stream on "<code>". BATCH_ID is the
// SHA-256 of the stream.
bool push_batch(const char* code, const char* schema, const char* identifier, const char* root,
                const RecordStream& stream, const ProviderInfo& provider, std::string* batch_id) {
  uint8_t digest[32];
  sdn_cid::sha256_raw(stream.bytes.data(), stream.bytes.size(), digest);
  *batch_id = hex(digest, sizeof digest);
  R::IngestRequestT request;
  request.SCHEMA = schema;
  request.TAGS = std::make_unique<R::SourceTagsT>();
  request.TAGS->PROVIDER_ID = kProviderId;
  request.TAGS->SOURCE_NAME = provider.source_name;
  request.TAGS->BATCH_ID = *batch_id;
  request.TAGS->CONTENT_KEY_ID = "public";
  request.RECONCILE = R::reconcileMode_Duplicates;
  request.PROVENANCE = std::make_unique<R::ProvenanceT>();
  request.PROVENANCE->PARSER = kParser;
  request.PROVENANCE->PARSER_VERSION = kParserVersion;
  request.PROVENANCE->NORMALIZED_SHA256 = *batch_id;
  request.PROVENANCE->NORMALIZED_COUNT = stream.count;
  flatbuffers::FlatBufferBuilder b(512);
  R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, &request));
  const std::string meta_port = std::string(code) + "_meta";
  return push(meta_port.c_str(), "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest",
              b.GetBufferPointer(), b.GetSize()) >= 0 &&
         push(code, schema, identifier, root, stream.bytes.data(), stream.bytes.size()) >= 0;
}

bool push_notice(R::flowNoticeKind kind, const char* reason, const ProviderInfo* provider, uint64_t count,
                 const std::string& item, const std::string& batch_id = {}) {
  R::FlowNoticeT notice;
  notice.KIND = kind;
  notice.SCHEMA = "OMM.fbs";
  notice.PROVIDER_ID = kProviderId;
  if (provider) notice.SOURCE_NAME = provider->source_name;
  notice.BATCH_ID = batch_id;
  notice.COUNT = count;
  notice.REASON = reason;
  if (!item.empty()) notice.ITEMS.push_back(item);
  flatbuffers::FlatBufferBuilder b(256 + item.size());
  R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
  return push("status", "FlowNotice.fbs", R::FlowNoticeIdentifier(), "FlowNotice", b.GetBufferPointer(),
              b.GetSize()) >= 0;
}

int finish(int code) {
  const uint32_t backlog = static_cast<uint32_t>(g_pending.size());
  plugin_set_backlog_remaining(backlog);
  plugin_set_yielded(backlog > 0 ? 1 : 0);
  return code;
}

int fail(const char* code, const std::string& message, int status) {
  plugin_set_error(code, message.c_str());
  return finish(status);
}

}  // namespace

extern "C" int fit(void) {
  plugin_reset_output_state();

  for (uint32_t index = 0; index < plugin_get_input_count(); ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    const ProviderInfo* provider = frame ? provider_for_port(frame->port_id) : nullptr;
    if (!provider) continue;
    if (!frame->payload || frame->payload_length == 0) {
      return fail("od-input-invalid", std::string("an empty frame on \"") + provider->port_id + "\"", 400);
    }
    PendingFitObject pending;
    std::string why;
    if (!read_source_oem(*provider, frame->payload, frame->payload_length, &pending, &why)) {
      return fail("od-input-invalid", std::string("\"") + provider->port_id + "\": " + why, 400);
    }
    if (pending.object.oem.empty()) {
      std::string message = "the ephemeris has fewer than three usable states or an arc the fit core cannot fit";
      if (!pending.identity.empty()) message += ": " + pending.identity;
      if (!push_notice(R::flowNoticeKind_Skipped, "unfittable", provider, 1, message)) {
        return fail("od-output", "unable to emit a FlowNotice", 500);
      }
      continue;
    }
    g_pending.push_back(std::move(pending));
  }

  if (g_pending.empty()) return finish(0);

  PendingFitObject pending = std::move(g_pending.front());
  g_pending.pop_front();
  // Keep the frozen pthread batch entry linked into the isomorphic node. The empty call performs no fit; the object is
  // fitted below through the same core's options-aware complete-arc entry point.
  od::BatchRunStats stats{};
  const std::vector<od::BatchObject> no_objects;
  (void)od::run_batch_fit(no_objects, 0, &stats);

  std::vector<od::PluginFitFBResult> epochs =
      od::fit_ephemeris_epochs_fb(pending.object.oem.data(), pending.object.oem.size(), kFitOptions);
  std::string error_code, error_message;
  if (!preflight_fit_epochs(epochs, &error_code, &error_message)) {
    std::string message = "OD fit failed";
    if (!pending.identity.empty()) message += ": " + pending.identity;
    message += ": " + error_code + ": " + error_message;
    if (!push_notice(R::flowNoticeKind_Skipped, "fit-failed", pending.provider, 1, message)) {
      return fail("od-output", "unable to emit a FlowNotice", 500);
    }
    return finish(0);
  }

  RecordStream omm, ocm, obd;
  for (const od::PluginFitFBResult& epoch : epochs) {
    if (!omm.add(epoch.omm) || !ocm.add(epoch.ocm) || !obd.add(epoch.obd)) {
      return fail("od-output-too-large", "one fitted record stream exceeds 128 MiB", 413);
    }
  }
  bool xp_ok = true;
  const std::string xp_account = append_xp_records(&omm, &obd, pending, &xp_ok);
  if (!xp_ok) return fail("od-output-too-large", "one fitted record stream exceeds 128 MiB", 413);

  std::string omm_batch, ocm_batch, obd_batch;
  if (!push_batch("omm", "OMM.fbs", "$OMM", "OMM", omm, *pending.provider, &omm_batch) ||
      !push_batch("ocm", "OCM.fbs", "$OCM", "OCM", ocm, *pending.provider, &ocm_batch) ||
      !push_batch("obd", "OBD.fbs", "$OBD", "OBD", obd, *pending.provider, &obd_batch)) {
    return fail("od-output", "unable to emit a fitted batch", 500);
  }
  std::string message = "OD fit complete";
  if (!pending.identity.empty()) message += ": " + pending.identity;
  message += xp_account;
  if (!push_notice(R::flowNoticeKind_Info, "fitted", pending.provider, omm.count, message, omm_batch)) {
    return fail("od-output", "unable to emit a FlowNotice", 500);
  }
  return finish(0);
}

// publish_request: hostcap/storage-ingest's IngestResult + the IngestRequest it stored -> the dataset-publication POST
// (omm_publish_url), its BODY the IngestResult naming the stored batch (SCHEMA, PROVIDER_ID, SOURCE_NAME, BATCH_ID);
// nothing when omm_publish_url is unset, or when the batch was refused (nothing was stored).
extern "C" int publish_request(void) {
  plugin_reset_output_state();
  const auto frame_for = [](const char* port) -> const plugin_input_frame_t* {
    const int32_t at = plugin_find_input_index(port, 0);
    return at < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(at));
  };
  const plugin_input_frame_t* result_frame = frame_for("result");
  const plugin_input_frame_t* meta_frame = frame_for("meta");
  if (plugin_find_input_index("result", 1) >= 0 || plugin_find_input_index("meta", 1) >= 0) {
    plugin_set_error("batched-input-frames", "publish_request pairs ONE IngestResult with ONE IngestRequest per invocation.");
    return 500;
  }
  if (!result_frame || !result_frame->payload || result_frame->payload_length == 0) {
    plugin_set_error("missing-result-frame", "publish_request requires the storage-ingest result frame.");
    return 400;
  }
  if (!meta_frame || !meta_frame->payload || meta_frame->payload_length == 0) {
    plugin_set_error("missing-meta-frame", "publish_request requires the IngestRequest frame.");
    return 400;
  }
  flatbuffers::Verifier result_verifier(result_frame->payload, result_frame->payload_length);
  if (!R::VerifyIngestResultBuffer(result_verifier)) {
    plugin_set_error("invalid-result-frame", "the result frame is not an IngestResult (INGR).");
    return 400;
  }
  flatbuffers::Verifier meta_verifier(meta_frame->payload, meta_frame->payload_length);
  if (!R::VerifyIngestRequestBuffer(meta_verifier)) {
    plugin_set_error("invalid-meta-frame", "the meta frame is not an IngestRequest (INGQ).");
    return 400;
  }
  const sdm_piv::Config config = sdm_piv::get_config();
  const std::string url(config.string("omm_publish_url", ""));
  if (url.empty()) return 0;
  const R::IngestResult& result = *R::GetIngestResult(result_frame->payload);
  const R::IngestRequest& meta = *R::GetIngestRequest(meta_frame->payload);
  if (result.REFUSED() && result.REFUSED()->size()) return 0;  // nothing stored, nothing to publish
  std::string schema = text_of(result.SCHEMA()), batch_id = text_of(result.BATCH_ID());
  if (schema.empty()) schema = text_of(meta.SCHEMA());
  if (batch_id.empty()) batch_id = text_of(meta.TAGS()->BATCH_ID());
  const std::string provider = text_of(meta.TAGS()->PROVIDER_ID()), source = text_of(meta.TAGS()->SOURCE_NAME());
  if (schema.empty() || batch_id.empty() || provider.empty() || source.empty()) {
    plugin_set_error("incomplete-publication-identity", "publish_request needs schema, batchId, providerId and sourceName.");
    return 400;
  }
  flatbuffers::FlatBufferBuilder body_builder(512);
  R::FinishIngestResultBuffer(
      body_builder,
      R::CreateIngestResultDirect(body_builder, schema.c_str(), provider.c_str(), source.c_str(), batch_id.c_str(),
                                  result.INSERTED(), result.RECONCILED_DUPLICATES(), result.RECONCILED_OLD_BATCHES(),
                                  result.ARCHIVED() && result.ARCHIVED()->size() ? result.ARCHIVED()->c_str() : nullptr,
                                  nullptr));
  const std::vector<uint8_t> body(body_builder.GetBufferPointer(),
                                  body_builder.GetBufferPointer() + body_builder.GetSize());
  flatbuffers::FlatBufferBuilder b(512 + body.size());
  std::vector<flatbuffers::Offset<R::Header>> headers{R::CreateHeaderDirect(b, "content-type", "application/octet-stream")};
  R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "POST", url.c_str(), &headers, &body,
                                                           static_cast<uint32_t>(config.number("omm_publish_timeout_ms", 30000)),
                                                           0, nullptr));
  if (push("request", "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", b.GetBufferPointer(),
           b.GetSize()) < 0) {
    plugin_set_error("emit-failed", "unable to emit the publication HttpRequest.");
    return 500;
  }
  return 0;
}
