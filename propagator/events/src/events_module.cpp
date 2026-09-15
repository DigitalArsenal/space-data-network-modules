// events_module.cpp — the SDS wire for the event-locator engine.
//
// GMAT-parity program item 6. Two methods:
//
//   locate_events          find every event of a locator class over an interval
//                          and emit an $EVL EVENT_REPORT.
//   propagate_to_condition propagate until a named parameter attains a goal and
//                          emit a $PCE STOP_REPORT.
//
// Both are the SAME runner. `src/event_locator.hpp` holds one bracketing scan
// and one Brent refinement; a locator is an event function handed to it. This
// file decodes a request into one of those functions, runs it, and encodes the
// roots. There is no per-locator algorithm here and there is no physics here.
//
// THE TRAJECTORY IS A PORT. The module carries no propagator. The caller hands
// it a sampled trajectory on the `ephemeris` port — produced by whichever
// propagator the caller chose — and the module makes it continuous with the
// Hermite interpolant in `src/ephemeris_source.hpp`, which matches position AND
// velocity at every node so the interpolated velocity is exactly the derivative
// of the interpolated position. That matters directly: the apsis event function
// is r . v, and a position-only interpolant would put its zero where the
// interpolated curve happened to turn rather than where the trajectory does.
//
// WHAT THE SCAN STEP DOES AND DOES NOT DECIDE. SCAN_STEP_SECONDS only decides
// whether a root is BRACKETED. Once bracketed it is refined to
// REFINEMENT_TOLERANCE_SECONDS on the continuous function, so the same scenario
// at three different steps lands on the same epoch. That is the invariant the
// scans this replaces do not have.

#include "space_data_module_invoke.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

namespace {

namespace ev = ::sdn::events;
namespace par = ::sdn::parameters;
namespace orb = ::sdn::orbits;
namespace ax = ::sdn::frames;

constexpr int kMaxSamples = 200000;
constexpr int kMaxEvents = 4096;

const plugin_input_frame_t* find_frame(const char* port_id) {
  const int32_t index = plugin_find_input_index(port_id, 0);
  if (index < 0) return nullptr;
  return plugin_get_input_frame(static_cast<uint32_t>(index));
}

bool parse_iso_utc(const char* text, int* year, int* month, int* day, int* hour, int* minute,
                   double* second) {
  if (text == nullptr) return false;
  int values[5] = {0, 0, 0, 0, 0};
  const char* cursor = text;
  for (int index = 0; index < 5; ++index) {
    int accumulated = 0;
    int digits = 0;
    while (*cursor >= '0' && *cursor <= '9') {
      accumulated = accumulated * 10 + (*cursor - '0');
      ++cursor;
      ++digits;
    }
    if (digits == 0) return false;
    values[index] = accumulated;
    if (index < 4) {
      if (*cursor == '\0') return false;
      ++cursor;
    }
  }
  if (*cursor != ':') return false;
  ++cursor;
  double seconds = 0.0;
  int digits = 0;
  while (*cursor >= '0' && *cursor <= '9') {
    seconds = seconds * 10.0 + (*cursor - '0');
    ++cursor;
    ++digits;
  }
  if (digits == 0) return false;
  if (*cursor == '.') {
    ++cursor;
    double scale = 0.1;
    while (*cursor >= '0' && *cursor <= '9') {
      seconds += (*cursor - '0') * scale;
      scale *= 0.1;
      ++cursor;
    }
  }
  *year = values[0];
  *month = values[1];
  *day = values[2];
  *hour = values[3];
  *minute = values[4];
  *second = seconds;
  return true;
}

/// Two-part UTC Julian date from an ISO 8601 instant.
bool utc_julian(const char* text, double* part1, double* part2) {
  int year = 0, month = 0, day = 0, hour = 0, minute = 0;
  double second = 0.0;
  if (!parse_iso_utc(text, &year, &month, &day, &hour, &minute, &second)) return false;
  return eraDtf2d("UTC", year, month, day, hour, minute, second, part1, part2) == 0;
}

/// ISO 8601 rendering of a two-part UTC Julian date, to nanosecond resolution.
void render_utc(double part1, double part2, char* text, int capacity) {
  if (text == nullptr || capacity < 32) return;
  int year = 0, month = 0, day = 0;
  int hmsf[4] = {0, 0, 0, 0};
  if (eraD2dtf("UTC", 9, part1, part2, &year, &month, &day, hmsf) != 0) {
    text[0] = '\0';
    return;
  }
  auto digits = [](char* out, int value, int width) {
    for (int i = width - 1; i >= 0; --i) {
      out[i] = static_cast<char>('0' + (value % 10));
      value /= 10;
    }
  };
  int position = 0;
  digits(text + position, year, 4); position += 4; text[position++] = '-';
  digits(text + position, month, 2); position += 2; text[position++] = '-';
  digits(text + position, day, 2); position += 2; text[position++] = 'T';
  digits(text + position, hmsf[0], 2); position += 2; text[position++] = ':';
  digits(text + position, hmsf[1], 2); position += 2; text[position++] = ':';
  digits(text + position, hmsf[2], 2); position += 2; text[position++] = '.';
  digits(text + position, hmsf[3], 9); position += 9;
  text[position] = '\0';
}

// ---------------------------------------------------------------------------
// The ephemeris port: an $OEM read into the interpolator's table shape.
//
// $OEM carries KILOMETRES; every other surface here is metres. The conversion
// happens exactly once, here, at the wire — never in the geometry.
// ---------------------------------------------------------------------------

struct EphemerisTable {
  std::vector<double> times;   ///< seconds from the scan's reference epoch
  std::vector<double> states;  ///< six per sample, metres and metres per second
  ev::Ephemeris view;
  bool valid = false;
  double referenceUtc1 = 0.0;
  double referenceUtc2 = 0.0;
};

bool read_ephemeris(const char* portId, double referenceUtc1, double referenceUtc2,
                    EphemerisTable* table) {
  const plugin_input_frame_t* frame = find_frame(portId);
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    return false;
  }
  if (!OEMBufferHasIdentifier(frame->payload)) return false;
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyOEMBuffer(verifier)) return false;
  const OEM* message = GetOEM(frame->payload);
  if (message == nullptr || message->EPHEMERIS_DATA_BLOCK() == nullptr) return false;

  table->times.clear();
  table->states.clear();
  const auto blocks = message->EPHEMERIS_DATA_BLOCK();
  for (::flatbuffers::uoffset_t b = 0; b < blocks->size(); ++b) {
    const ephemerisDataBlock* block = blocks->Get(b);
    if (block == nullptr || block->EPHEMERIS_DATA_LINES() == nullptr) continue;
    const auto lines = block->EPHEMERIS_DATA_LINES();
    for (::flatbuffers::uoffset_t i = 0; i < lines->size(); ++i) {
      const ephemerisDataLine* line = lines->Get(i);
      if (line == nullptr || line->EPOCH() == nullptr) continue;
      double part1 = 0.0;
      double part2 = 0.0;
      if (!utc_julian(line->EPOCH()->c_str(), &part1, &part2)) continue;
      const double seconds =
          ((part1 - referenceUtc1) + (part2 - referenceUtc2)) * 86400.0;
      if (!table->times.empty() && seconds <= table->times.back()) {
        // A table that is not strictly increasing cannot be interpolated, and
        // silently sorting it would hide a producer defect.
        return false;
      }
      table->times.push_back(seconds);
      table->states.push_back(line->X() * 1000.0);
      table->states.push_back(line->Y() * 1000.0);
      table->states.push_back(line->Z() * 1000.0);
      table->states.push_back(line->X_DOT() * 1000.0);
      table->states.push_back(line->Y_DOT() * 1000.0);
      table->states.push_back(line->Z_DOT() * 1000.0);
      if (static_cast<int>(table->times.size()) > kMaxSamples) return false;
    }
  }
  if (table->times.size() < 2) return false;
  table->view.times = table->times.data();
  table->view.states = table->states.data();
  table->view.sampleCount = static_cast<int32_t>(table->times.size());
  table->referenceUtc1 = referenceUtc1;
  table->referenceUtc2 = referenceUtc2;
  table->valid = true;
  return true;
}

// ---------------------------------------------------------------------------
// The body-position port, over the SAME ERFA chain the frames and parameter
// modules use. An optional SPK kernel supplies geometric J2000 states; without
// it the explicitly selected Analytical source is the vendored ERFA series.
// ---------------------------------------------------------------------------

enum class EphemerisSource { Analytical, SpkKernel };

struct BodyContext {
  EphemerisSource source = EphemerisSource::Analytical;
  const spk::Kernel* kernel = nullptr;
  bool kernelUsed = false;
  double referenceUtc1 = 0.0;
  double referenceUtc2 = 0.0;
  ax::EarthOrientation earthOrientation;
  int centralBodyId = 399;
};

int32_t erfa_body_position(void* context, int32_t bodyId, double secondsFromEpoch,
                           double position[3]) {
  BodyContext* bodies = static_cast<BodyContext*>(context);
  if (bodies == nullptr || position == nullptr) return 1;
  const double days = secondsFromEpoch / 86400.0;
  int year = 0, month = 0, day = 0;
  int hmsf[4] = {0, 0, 0, 0};
  if (eraD2dtf("UTC", 6, bodies->referenceUtc1, bodies->referenceUtc2 + days, &year, &month,
               &day, hmsf) != 0) {
    return 1;
  }
  ax::Epoch epoch;
  if (!ax::epochFromUtc(year, month, day, hmsf[0], hmsf[1],
                        hmsf[2] + hmsf[3] / 1.0e6, bodies->earthOrientation, &epoch)) {
    return 1;
  }
  if (bodyId == bodies->centralBodyId) {
    position[0] = 0.0;
    position[1] = 0.0;
    position[2] = 0.0;
    return 0;
  }
  if (bodies->source == EphemerisSource::SpkKernel) {
    // ERFA/SOFA Dtdb: Fairhead-Bretagnon geocentric TDB-TT (seconds).
    // u=v=0 removes topocentric terms; preserve two-part TT through ET.
    // https://www.iausofa.org/2023-10-11c#documentation
    const double tdbMinusTt = eraDtdb(epoch.tt1, epoch.tt2, 0.0, 0.0, 0.0, 0.0);
    const double et = ((epoch.tt1 - 2451545.0) + epoch.tt2) * 86400.0 + tdbMinusTt;
    ephem::StateRow state;
    if (!bodies->kernel || bodies->kernel->state_et(bodyId, bodies->centralBodyId, et,
                                                   &state) != ephem::Status::Ok)
      return 1; // A supplied kernel never silently becomes an analytic series.
    for (int i = 0; i < 3; ++i) position[i] = state.pos[i] * 1000.0;
    bodies->kernelUsed = true;
    return 0;
  }
  double pvh[2][3];
  double pvb[2][3];
  eraEpv00(epoch.tt1, epoch.tt2, pvh, pvb);
  const double earthToSun[3] = {-pvh[0][0] * ERFA_DAU, -pvh[0][1] * ERFA_DAU,
                                -pvh[0][2] * ERFA_DAU};
  const ax::Vec3 moon = ax::moonPositionGcrf(epoch);
  double fromEarth[3] = {0.0, 0.0, 0.0};
  if (bodyId == 10) {
    fromEarth[0] = earthToSun[0];
    fromEarth[1] = earthToSun[1];
    fromEarth[2] = earthToSun[2];
  } else if (bodyId == 301) {
    fromEarth[0] = moon.x;
    fromEarth[1] = moon.y;
    fromEarth[2] = moon.z;
  } else if (bodyId == 399) {
    fromEarth[0] = 0.0;
    fromEarth[1] = 0.0;
    fromEarth[2] = 0.0;
  } else {
    // A body this build carries no ephemeris for. Refusing is the answer; an
    // eclipse computed against a body at the origin would be a different
    // eclipse and nothing would say so.
    return 1;
  }
  if (bodies->centralBodyId == 399) {
    position[0] = fromEarth[0];
    position[1] = fromEarth[1];
    position[2] = fromEarth[2];
    return 0;
  }
  if (bodies->centralBodyId == 301) {
    position[0] = fromEarth[0] - moon.x;
    position[1] = fromEarth[1] - moon.y;
    position[2] = fromEarth[2] - moon.z;
    return 0;
  }
  return 1;
}

/// Reference ellipsoid for the bodies this build can place a site on.
struct BodyShape {
  int bodyId;
  double equatorialRadius;
  double flattening;
};
constexpr BodyShape kBodyShape[] = {
    {399, 6378137.0, 1.0 / 298.257223563},
    {301, 1737400.0, 0.0},
    {499, 3396190.0, 1.0 / 169.894},
};

bool body_shape(int bodyId, orb::Ellipsoid* out) {
  for (const BodyShape& entry : kBodyShape) {
    if (entry.bodyId == bodyId) {
      out->equatorialRadius = entry.equatorialRadius;
      out->flattening = entry.flattening;
      return true;
    }
  }
  return false;
}

/// A ground site, rotated into the ephemeris axes at each epoch.
struct SiteContext {
  double latitude = 0.0;
  double longitude = 0.0;
  double altitude = 0.0;
  int bodyId = 399;
  orb::Ellipsoid ellipsoid;
  double referenceUtc1 = 0.0;
  double referenceUtc2 = 0.0;
  ax::EarthOrientation earthOrientation;
  bool earthOrientationSupplied = false;
};

int32_t rotating_site_position(void* context, double secondsFromEpoch, double position[3],
                               double up[3]) {
  const SiteContext* site = static_cast<const SiteContext*>(context);
  if (site == nullptr || position == nullptr || up == nullptr) return 1;

  // Body-fixed Cartesian from the geodetic triple, over the ellipsoid the
  // element-set library already owns.
  const double sinLat = std::sin(site->latitude);
  const double cosLat = std::cos(site->latitude);
  const double sinLon = std::sin(site->longitude);
  const double cosLon = std::cos(site->longitude);
  const double a = site->ellipsoid.equatorialRadius;
  const double f = site->ellipsoid.flattening;
  const double eSquared = f * (2.0 - f);
  const double primeVertical = a / std::sqrt(1.0 - eSquared * sinLat * sinLat);
  const ax::Vec3 bodyFixed{
      (primeVertical + site->altitude) * cosLat * cosLon,
      (primeVertical + site->altitude) * cosLat * sinLon,
      (primeVertical * (1.0 - eSquared) + site->altitude) * sinLat,
  };
  // The local up is the ELLIPSOID NORMAL, not the radius vector: the two differ
  // by up to 0.19 degrees on the Earth, which is a third of a typical minimum
  // elevation mask.
  const ax::Vec3 upBodyFixed{cosLat * cosLon, cosLat * sinLon, sinLat};

  const double days = secondsFromEpoch / 86400.0;
  int year = 0, month = 0, day = 0;
  int hmsf[4] = {0, 0, 0, 0};
  if (eraD2dtf("UTC", 6, site->referenceUtc1, site->referenceUtc2 + days, &year, &month, &day,
               hmsf) != 0) {
    return 1;
  }
  ax::Epoch epoch;
  if (!ax::epochFromUtc(year, month, day, hmsf[0], hmsf[1], hmsf[2] + hmsf[3] / 1.0e6,
                        site->earthOrientation, &epoch)) {
    return 1;
  }
  ax::Mat3 toBodyFixed;
  if (site->bodyId == 399) {
    toBodyFixed = ax::gcrfToItrf(epoch, site->earthOrientation);
  } else {
    ax::RotationElements elements;
    if (!ax::rotationElementsForBody(site->bodyId, &elements)) return 1;
    toBodyFixed = ax::icrfToBodyFixed(epoch, elements);
  }
  const ax::Mat3 toInertial = ax::transpose(toBodyFixed);
  const ax::Vec3 inertial = ax::apply(toInertial, bodyFixed);
  const ax::Vec3 upInertial = ax::apply(toInertial, upBodyFixed);
  position[0] = inertial.x;
  position[1] = inertial.y;
  position[2] = inertial.z;
  up[0] = upInertial.x;
  up[1] = upInertial.y;
  up[2] = upInertial.z;
  return 0;
}

/// Mean equatorial radius, metres, for the bodies this build can occult with.
double body_radius(int bodyId) {
  switch (bodyId) {
    case 10: return 6.957e8;      // photospheric radius
    case 399: return 6378137.0;   // WGS84 equatorial radius
    case 301: return 1737400.0;   // IAU/WGCCRE mean radius
    case 499: return 3396190.0;
    default: return 0.0;
  }
}

// ---------------------------------------------------------------------------
// A parameter scalar over the catalog, so a stopping condition on a NAMED
// parameter resolves through the same evaluator the catalog module publishes.
// One implementation, two modules.
// ---------------------------------------------------------------------------

struct ScalarContext {
  par::EvaluationContext base;
  par::ParameterId id = par::ParameterId::UNSPECIFIED;
  double referenceUtc1 = 0.0;
  double referenceUtc2 = 0.0;
  bool lastEvaluationFailed = false;
};

int32_t parameter_scalar(void* context, double secondsFromEpoch, const double state[6],
                         double* value) {
  ScalarContext* scalar = static_cast<ScalarContext*>(context);
  if (scalar == nullptr || value == nullptr) return 1;
  par::EvaluationContext evaluation = scalar->base;
  evaluation.state.position = {state[0], state[1], state[2]};
  evaluation.state.velocity = {state[3], state[4], state[5]};

  const double days = secondsFromEpoch / 86400.0;
  evaluation.utc1 = scalar->referenceUtc1;
  evaluation.utc2 = scalar->referenceUtc2 + days;
  int year = 0, month = 0, day = 0;
  int hmsf[4] = {0, 0, 0, 0};
  if (eraD2dtf("UTC", 6, evaluation.utc1, evaluation.utc2, &year, &month, &day, hmsf) != 0) {
    return 1;
  }
  if (!ax::epochFromUtc(year, month, day, hmsf[0], hmsf[1], hmsf[2] + hmsf[3] / 1.0e6,
                        evaluation.earthOrientation, &evaluation.epoch)) {
    return 1;
  }
  evaluation.epochSupplied = true;

  par::Derived derived;
  if (!par::buildDerived(evaluation, &derived)) return 1;
  double values[36] = {0.0};
  int count = 0;
  if (par::evaluate(scalar->id, evaluation, derived, values, &count) != par::Status::OK ||
      count < 1) {
    scalar->lastEvaluationFailed = true;
    return 1;
  }
  *value = values[0];
  return 0;
}

}  // namespace

// ---------------------------------------------------------------------------
// locate_events
// ---------------------------------------------------------------------------

extern "C" int locate_events(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_frame("request");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No EVL event-location request frame was provided.");
    return 3;
  }
  if (!EVLBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS EVL FlatBuffer.");
    return 3;
  }
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyEVLBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS EVL FlatBuffer.");
    return 3;
  }
  const EVL* envelopeIn = GetEVL(frame->payload);
  const EVLEventLocationRequest* request =
      envelopeIn != nullptr ? envelopeIn->LOCATION_REQUEST() : nullptr;
  if (request == nullptr) {
    plugin_set_error("missing-request", "The EVL envelope carries no LOCATION_REQUEST.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1 << 18);

  const auto refuse = [&](evlResultStatus status, const char* message) {
    const auto messageOffset = builder.CreateString(message);
    EVLEventReportBuilder report(builder);
    report.add_STATUS(status);
    report.add_ERROR_MESSAGE(messageOffset);
    report.add_LOCATOR_CLASS(request->LOCATOR_CLASS());
    const auto reportOffset = report.Finish();
    EVLBuilder envelope(builder);
    envelope.add_EVENT_REPORT(reportOffset);
    const auto root = envelope.Finish();
    FinishEVLBuffer(builder, root);
    plugin_push_output("report", "EVL.fbs", "$EVL", builder.GetBufferPointer(),
                       static_cast<uint32_t>(builder.GetSize()));
    return 0;
  };

  const char* startText =
      request->SCAN_START_EPOCH() != nullptr ? request->SCAN_START_EPOCH()->c_str() : nullptr;
  const char* stopText =
      request->SCAN_STOP_EPOCH() != nullptr ? request->SCAN_STOP_EPOCH()->c_str() : nullptr;
  double startUtc1 = 0.0, startUtc2 = 0.0, stopUtc1 = 0.0, stopUtc2 = 0.0;
  if (startText == nullptr || stopText == nullptr || !utc_julian(startText, &startUtc1, &startUtc2) ||
      !utc_julian(stopText, &stopUtc1, &stopUtc2)) {
    return refuse(evlResultStatus::INVALID_INPUT,
                  "SCAN_START_EPOCH and SCAN_STOP_EPOCH must both be ISO 8601 UTC instants.");
  }
  const double spanSeconds =
      ((stopUtc1 - startUtc1) + (stopUtc2 - startUtc2)) * 86400.0;

  ax::EarthOrientation earthOrientation;
  const char* eopCid = nullptr;
  bool haveEop = false;
  {
    const plugin_input_frame_t* eopFrame = find_frame("earth_orientation");
    if (eopFrame != nullptr && eopFrame->payload != nullptr && eopFrame->payload_length > 0 &&
        EOPBufferHasIdentifier(eopFrame->payload)) {
      ::flatbuffers::Verifier eopVerifier(eopFrame->payload, eopFrame->payload_length);
      if (VerifyEOPBuffer(eopVerifier)) {
        const EOP* row = GetEOP(eopFrame->payload);
        if (row != nullptr) {
          const bool highPrecision = row->UT1_MINUS_UTC_SECONDS_HP() != 0.0 ||
                                     row->X_POLE_WANDER_RADIANS_HP() != 0.0 ||
                                     row->Y_POLE_WANDER_RADIANS_HP() != 0.0;
          if (highPrecision) {
            earthOrientation.dut1 = row->UT1_MINUS_UTC_SECONDS_HP();
            earthOrientation.xPole = row->X_POLE_WANDER_RADIANS_HP();
            earthOrientation.yPole = row->Y_POLE_WANDER_RADIANS_HP();
          } else {
            earthOrientation.dut1 = row->UT1_MINUS_UTC_SECONDS();
            earthOrientation.xPole = row->X_POLE_WANDER_RADIANS();
            earthOrientation.yPole = row->Y_POLE_WANDER_RADIANS();
          }
          if (row->DATA_SET_CID() != nullptr) eopCid = row->DATA_SET_CID()->c_str();
          haveEop = true;
        }
      }
    }
  }

  EphemerisTable ephemeris;
  if (!read_ephemeris("ephemeris", startUtc1, startUtc2, &ephemeris)) {
    return refuse(evlResultStatus::MISSING_EPHEMERIS,
                  "A strictly increasing OEM ephemeris covering the scan interval is "
                  "required; this provider carries no propagator of its own.");
  }

  const PCEEvaluationContext* requestContext = request->CONTEXT();
  const int centralBodyId =
      requestContext != nullptr && requestContext->CENTRAL_BODY_ID() != 0
          ? requestContext->CENTRAL_BODY_ID()
          : 399;

  BodyContext bodies;
  bodies.referenceUtc1 = startUtc1;
  bodies.referenceUtc2 = startUtc2;
  bodies.earthOrientation = earthOrientation;
  bodies.centralBodyId = centralBodyId;

  ephem::KernelFrame kernelFrame;
  spk::Kernel kernel;
  if (const auto* input = find_frame("kernel")) {
    // A kernel is ICRF/J2000. Refuse differently labelled trajectory samples
    // instead of silently treating TEME/body-fixed axes or TDB text as UTC.
    const auto* trajectory = GetOEM(find_frame("ephemeris")->payload);
    for (const auto* block : *trajectory->EPHEMERIS_DATA_BLOCK()) {
      const auto* rfm = block->REFERENCE_FRAME();
      const auto* axes = rfm ? rfm->REFERENCE_FRAME_as_CelestialFrameWrapper() : nullptr;
      if (block->TIME_SYSTEM() != timingStandard::UTC || !axes ||
          (axes->frame() != CelestialFrame::ICRF && axes->frame() != CelestialFrame::J2000 &&
           axes->frame() != CelestialFrame::GCRF) || block->CENTER_NAIF_ID() != centralBodyId)
        return refuse(evlResultStatus::INVALID_INPUT,
          "Kernel mode requires OEM TIME_SYSTEM=UTC, ICRF/J2000/GCRF axes and matching CENTER_NAIF_ID.");
    }
    const char* error = nullptr;
    if (!ephem::decode_kernel_frame(input->payload, input->payload_length, &kernelFrame, &error))
      return refuse(evlResultStatus::INVALID_INPUT, error);
    if (kernel.load(kernelFrame.body, kernelFrame.body_length) != ephem::Status::Ok)
      return refuse(evlResultStatus::INVALID_INPUT, "Invalid SPK kernel.");
    bodies.source = EphemerisSource::SpkKernel;
    bodies.kernel = &kernel;
  }

  ev::ScanRequest scan;
  scan.startSeconds = 0.0;
  scan.stopSeconds = spanSeconds;
  scan.refinement.coarseStepSeconds =
      request->SCAN_STEP_SECONDS() > 0.0 ? request->SCAN_STEP_SECONDS() : 60.0;
  scan.refinement.toleranceSeconds = request->REFINEMENT_TOLERANCE_SECONDS() > 0.0
                                         ? request->REFINEMENT_TOLERANCE_SECONDS()
                                         : 1e-6;
  scan.maxEvents = static_cast<int32_t>(request->MAXIMUM_EVENTS());

  // Resolve the locator class into ONE event function. Everything below this
  // point is class-independent, which is the acceptance's own claim.
  ev::EventFn eventFunction = nullptr;
  void* eventContext = nullptr;
  ev::EclipseContext eclipse;
  ev::ContactContext contact;
  ev::IntrusionContext intrusion;
  ev::NodeContext node;
  ev::StoppingContext stopping;
  SiteContext site;
  ScalarContext scalar;
  evlEventType entryType = evlEventType::ENTRY;
  evlEventType exitType = evlEventType::EXIT;
  int occultingBodyId = 0;

  switch (request->LOCATOR_CLASS()) {
    case evlLocatorClass::ECLIPSE: {
      const EVLEclipseConfiguration* configuration = request->ECLIPSE_CONFIGURATION();
      if (configuration == nullptr) {
        return refuse(evlResultStatus::MISSING_CONFIGURATION,
                      "An ECLIPSE request needs ECLIPSE_CONFIGURATION.");
      }
      occultingBodyId = configuration->OCCULTING_BODY_IDS() != nullptr &&
                                configuration->OCCULTING_BODY_IDS()->size() > 0
                            ? configuration->OCCULTING_BODY_IDS()->Get(0)
                            : centralBodyId;
      eclipse.bodyPosition = erfa_body_position;
      eclipse.bodyContext = &bodies;
      eclipse.occultingBodyId = occultingBodyId;
      eclipse.occultingRadius = body_radius(occultingBodyId);
      eclipse.occultedBodyId = configuration->ILLUMINATING_BODY_ID() != 0
                                   ? configuration->ILLUMINATING_BODY_ID()
                                   : 10;
      eclipse.occultedRadius = body_radius(eclipse.occultedBodyId);
      // One region per invocation: the three are three different functions and
      // reporting them together would need three scans anyway.
      if (configuration->REPORT_UMBRA()) {
        eclipse.region = ev::ShadowRegion::UMBRA;
        entryType = evlEventType::UMBRA;
        exitType = evlEventType::UMBRA;
      } else if (configuration->REPORT_ANTUMBRA()) {
        eclipse.region = ev::ShadowRegion::ANTUMBRA;
        entryType = evlEventType::ANTUMBRA;
        exitType = evlEventType::ANTUMBRA;
      } else {
        eclipse.region = ev::ShadowRegion::PENUMBRA;
        entryType = evlEventType::PENUMBRA;
        exitType = evlEventType::PENUMBRA;
      }
      if (!(eclipse.occultingRadius > 0.0) || !(eclipse.occultedRadius > 0.0)) {
        return refuse(evlResultStatus::INVALID_INPUT,
                      "This provider carries no radius for one of the named bodies.");
      }
      eventFunction = ev::eclipseFunction;
      eventContext = &eclipse;
      break;
    }
    case evlLocatorClass::CONTACT: {
      const EVLContactConfiguration* configuration = request->CONTACT_CONFIGURATION();
      if (configuration == nullptr) {
        return refuse(evlResultStatus::MISSING_CONFIGURATION,
                      "A CONTACT request needs CONTACT_CONFIGURATION.");
      }
      // The observer's position arrives in the same axes as the ephemeris; the
      // caller states it, because resolving a ground site into inertial axes is
      // the frames module's work and duplicating it here would be a second
      // answer.
      const RFMOrigin* observer = configuration->OBSERVER();
      if (observer == nullptr) {
        return refuse(evlResultStatus::MISSING_CONFIGURATION,
                      "A CONTACT request needs an OBSERVER.");
      }
      contact.stateSource = ev::ephemerisStateSource;
      contact.stateContext = &ephemeris.view;
      contact.minimumElevation = configuration->MINIMUM_ELEVATION_RAD();
      contact.lightTimeCorrection =
          configuration->ABERRATION_CORRECTION() == evlAberrationCorrection::LIGHT_TIME ||
          configuration->ABERRATION_CORRECTION() ==
              evlAberrationCorrection::LIGHT_TIME_AND_STELLAR_ABERRATION;
      if (observer->KIND() != rfmOriginKind::GROUND_SITE) {
        return refuse(evlResultStatus::MISSING_CONFIGURATION,
                      "A CONTACT observer must be a ground site with a stated geodetic "
                      "latitude, longitude and altitude.");
      }
      // A site on a ROTATING body moves in the inertial axes the ephemeris is
      // expressed in, so its position is a function of time exactly like the
      // spacecraft's. Freezing it would put every rise and set epoch wrong by up
      // to half the pass; the site adapter below rotates it at each evaluation
      // over the same IAU-2006/2000A chain the rest of the stack uses.
      site.latitude = observer->SITE_LATITUDE();
      site.longitude = observer->SITE_LONGITUDE();
      site.altitude = observer->SITE_ALTITUDE();
      site.bodyId = observer->SITE_BODY_ID() != 0 ? observer->SITE_BODY_ID() : centralBodyId;
      site.referenceUtc1 = startUtc1;
      site.referenceUtc2 = startUtc2;
      site.earthOrientation = earthOrientation;
      site.earthOrientationSupplied = haveEop;
      if (site.bodyId == 399 && !haveEop) {
        return refuse(evlResultStatus::MISSING_EOP_DATA,
                      "An Earth ground site needs an Earth-orientation row; this provider "
                      "refuses rather than placing the site against assumed zeros.");
      }
      if (!body_shape(site.bodyId, &site.ellipsoid)) {
        return refuse(evlResultStatus::INVALID_INPUT,
                      "This provider carries no shape for the site's body.");
      }
      contact.sitePosition = rotating_site_position;
      contact.siteContext = &site;
      entryType = evlEventType::RISE;
      exitType = evlEventType::SET;
      eventFunction = ev::contactFunction;
      eventContext = &contact;
      break;
    }
    case evlLocatorClass::INTRUSION: {
      const EVLIntrusionConfiguration* configuration = request->INTRUSION_CONFIGURATION();
      if (configuration == nullptr) {
        return refuse(evlResultStatus::MISSING_CONFIGURATION,
                      "An INTRUSION request needs INTRUSION_CONFIGURATION.");
      }
      if (configuration->FIELD_OF_VIEW_SHAPE() != evlFieldOfViewShape::CONIC &&
          configuration->FIELD_OF_VIEW_SHAPE() != evlFieldOfViewShape::UNSPECIFIED) {
        return refuse(evlResultStatus::UNSUPPORTED_LOCATOR_CLASS,
                      "This provider locates intrusions into a CONIC field of view; a "
                      "rectangular or masked field needs its own event function.");
      }
      intrusion.bodyPosition = erfa_body_position;
      intrusion.bodyContext = &bodies;
      intrusion.bodyId = configuration->INTRUDING_BODY_IDS() != nullptr &&
                                 configuration->INTRUDING_BODY_IDS()->size() > 0
                             ? configuration->INTRUDING_BODY_IDS()->Get(0)
                             : 10;
      intrusion.bodyRadius = body_radius(intrusion.bodyId);
      intrusion.includeBodyRadius = configuration->USE_APPARENT_BODY_RADIUS();
      intrusion.halfAngle = configuration->CONE_HALF_ANGLE_RAD();
      if (configuration->BORESIGHT() != nullptr) {
        intrusion.boresight[0] = configuration->BORESIGHT()->X();
        intrusion.boresight[1] = configuration->BORESIGHT()->Y();
        intrusion.boresight[2] = configuration->BORESIGHT()->Z();
      }
      if (!(intrusion.halfAngle > 0.0)) {
        return refuse(evlResultStatus::INVALID_INPUT,
                      "CONE_HALF_ANGLE_RAD must be positive.");
      }
      entryType = evlEventType::ENTRY;
      exitType = evlEventType::EXIT;
      eventFunction = ev::intrusionFunction;
      eventContext = &intrusion;
      break;
    }
    case evlLocatorClass::APSIDES: {
      entryType = evlEventType::PERIAPSIS;
      exitType = evlEventType::APOAPSIS;
      eventFunction = ev::apsisFunction;
      eventContext = nullptr;
      break;
    }
    case evlLocatorClass::NODE_CROSSING: {
      entryType = evlEventType::ASCENDING_NODE;
      exitType = evlEventType::DESCENDING_NODE;
      eventFunction = ev::nodeFunction;
      eventContext = &node;
      break;
    }
    case evlLocatorClass::PARAMETER_CONDITION: {
      const EVLParameterConditionConfiguration* configuration =
          request->PARAMETER_CONDITION_CONFIGURATION();
      if (configuration == nullptr || configuration->CONDITIONS() == nullptr ||
          configuration->CONDITIONS()->size() == 0) {
        return refuse(evlResultStatus::MISSING_CONFIGURATION,
                      "A PARAMETER_CONDITION request needs at least one condition.");
      }
      const PCEParameterCondition* condition = configuration->CONDITIONS()->Get(0);
      const PCEParameterRef* ref = condition != nullptr ? condition->PARAMETER() : nullptr;
      if (ref == nullptr) {
        return refuse(evlResultStatus::MISSING_CONFIGURATION,
                      "A condition needs a PARAMETER reference.");
      }
      const par::Descriptor* descriptor = nullptr;
      if (ref->PARAMETER() == pceParameter::PROVIDER_DEFINED &&
          ref->PROVIDER_DEFINED_NAME() != nullptr) {
        descriptor = par::findByName(ref->PROVIDER_DEFINED_NAME()->c_str());
      } else {
        const par::PceCrosswalkEntry* crosswalk =
            par::crosswalkFromPce(static_cast<uint16_t>(ref->PARAMETER()));
        if (crosswalk != nullptr && crosswalk->id != par::ParameterId::UNSPECIFIED) {
          descriptor = par::findById(crosswalk->id);
        }
      }
      if (descriptor == nullptr ||
          descriptor->availability != par::Availability::IMPLEMENTED ||
          descriptor->kind != par::ValueKind::REAL) {
        return refuse(evlResultStatus::PARAMETER_UNAVAILABLE,
                      "A stopping condition needs a real scalar parameter this provider "
                      "evaluates.");
      }
      scalar.id = descriptor->id;
      scalar.referenceUtc1 = startUtc1;
      scalar.referenceUtc2 = startUtc2;
      scalar.base.centralBodyId = centralBodyId;
      scalar.base.earthOrientation = earthOrientation;
      scalar.base.earthOrientationSupplied = haveEop;
      scalar.base.gravitationalParameter =
          requestContext != nullptr && requestContext->GRAVITATIONAL_PARAMETER() > 0.0
              ? requestContext->GRAVITATIONAL_PARAMETER()
              : 3.986004418e14;
      if (requestContext != nullptr && requestContext->EQUATORIAL_RADIUS_M() > 0.0) {
        scalar.base.ellipsoid.equatorialRadius = requestContext->EQUATORIAL_RADIUS_M();
        scalar.base.ellipsoid.flattening = requestContext->FLATTENING();
      } else {
        scalar.base.ellipsoid.equatorialRadius = 6378137.0;
        scalar.base.ellipsoid.flattening = 1.0 / 298.257223563;
      }
      stopping.scalar = parameter_scalar;
      stopping.scalarContext = &scalar;
      stopping.goal = condition->GOAL_VALUE();
      if (condition->DIRECTION() == pceConditionDirection::INCREASING) {
        scan.direction = ev::Direction::INCREASING;
      } else if (condition->DIRECTION() == pceConditionDirection::DECREASING) {
        scan.direction = ev::Direction::DECREASING;
      }
      entryType = evlEventType::CONDITION_SATISFIED;
      exitType = evlEventType::CONDITION_SATISFIED;
      eventFunction = ev::stoppingFunction;
      eventContext = &stopping;
      break;
    }
    default:
      return refuse(evlResultStatus::UNSUPPORTED_LOCATOR_CLASS,
                    "This provider locates eclipse, contact, intrusion, apsides, node "
                    "crossings and parameter conditions.");
  }

  static ev::Event events[kMaxEvents];
  int32_t count = 0;
  const ev::Status status =
      ev::scan(ev::ephemerisStateSource, &ephemeris.view, eventFunction, eventContext, scan,
               events, kMaxEvents, &count);
  if (status == ev::Status::STATE_SOURCE_REFUSED) {
    return refuse(evlResultStatus::MISSING_EPHEMERIS,
                  "The ephemeris does not cover the whole scan interval; this provider "
                  "refuses rather than extrapolating.");
  }
  if (status == ev::Status::EVENT_FUNCTION_REFUSED) {
    // The light-time correction evaluates the trajectory at t - range/c, which
    // is BEFORE the scan start. An ephemeris that begins exactly at the scan
    // start therefore cannot serve it, and saying so is the answer — falling
    // back to the uncorrected position would return an epoch that silently is
    // not the corrected one.
    if (request->LOCATOR_CLASS() == evlLocatorClass::CONTACT &&
        request->CONTACT_CONFIGURATION() != nullptr &&
        (request->CONTACT_CONFIGURATION()->ABERRATION_CORRECTION() ==
             evlAberrationCorrection::LIGHT_TIME ||
         request->CONTACT_CONFIGURATION()->ABERRATION_CORRECTION() ==
             evlAberrationCorrection::LIGHT_TIME_AND_STELLAR_ABERRATION)) {
      return refuse(evlResultStatus::MISSING_EPHEMERIS,
                    "The light-time correction evaluates the trajectory one light time "
                    "before each epoch, so the ephemeris must begin before the scan "
                    "start; this provider refuses rather than reporting an uncorrected "
                    "epoch as a corrected one.");
    }
    return refuse(evlResultStatus::PARAMETER_UNAVAILABLE,
                  "The event function could not be evaluated over the scan interval.");
  }
  if (status == ev::Status::REFINEMENT_DID_NOT_CONVERGE) {
    return refuse(evlResultStatus::ROOT_REFINEMENT_FAILED,
                  "A root did not converge inside the iteration budget; an unconverged "
                  "epoch is never reported as if it were one.");
  }
  if (status == ev::Status::INVALID_REQUEST) {
    return refuse(evlResultStatus::INVALID_INPUT,
                  "The scan interval, step or tolerance is not usable.");
  }

  // Encode. An event is an INTERVAL when the locator has a notion of inside and
  // outside (eclipse, contact, intrusion, a condition held over a span) and an
  // INSTANT otherwise (an apsis, a node crossing) — so the two are encoded
  // differently rather than one being faked as the other.
  const bool intervalShaped = request->LOCATOR_CLASS() == evlLocatorClass::ECLIPSE ||
                              request->LOCATOR_CLASS() == evlLocatorClass::CONTACT ||
                              request->LOCATOR_CLASS() == evlLocatorClass::INTRUSION;

  ::std::vector<::flatbuffers::Offset<EVLEvent>> encoded;
  const auto epochOf = [&](double seconds, char* text, int capacity) {
    render_utc(startUtc1, startUtc2 + seconds / 86400.0, text, capacity);
  };

  if (intervalShaped) {
    for (int32_t i = 0; i < count; ++i) {
      if (events[i].direction != ev::Direction::DECREASING) continue;  // entry
      int32_t exitIndex = -1;
      for (int32_t j = i + 1; j < count; ++j) {
        if (events[j].direction == ev::Direction::INCREASING) {
          exitIndex = j;
          break;
        }
      }
      char startEpoch[64] = {0};
      char stopEpoch[64] = {0};
      epochOf(events[i].epochSeconds, startEpoch, sizeof startEpoch);
      const double duration =
          exitIndex >= 0 ? events[exitIndex].epochSeconds - events[i].epochSeconds : 0.0;
      if (exitIndex >= 0) epochOf(events[exitIndex].epochSeconds, stopEpoch, sizeof stopEpoch);

      const auto startOffset = builder.CreateString(startEpoch);
      const auto stopOffset =
          exitIndex >= 0 ? builder.CreateString(stopEpoch)
                         : ::flatbuffers::Offset<::flatbuffers::String>();
      const auto scaleOffset = builder.CreateString("UTC");
      EVLEventBuilder event(builder);
      event.add_EVENT_TYPE(entryType);
      event.add_START_EPOCH(startOffset);
      if (exitIndex >= 0) event.add_STOP_EPOCH(stopOffset);
      event.add_EPOCH_TIME_SYSTEM(scaleOffset);
      event.add_DURATION_SECONDS(duration);
      if (occultingBodyId != 0) event.add_OCCULTING_BODY_ID(occultingBodyId);
      encoded.push_back(event.Finish());
    }
  } else {
    for (int32_t i = 0; i < count; ++i) {
      char startEpoch[64] = {0};
      epochOf(events[i].epochSeconds, startEpoch, sizeof startEpoch);
      const auto startOffset = builder.CreateString(startEpoch);
      const auto scaleOffset = builder.CreateString("UTC");
      EVLEventBuilder event(builder);
      // For an apsis the DECREASING crossing of r . v is apoapsis (the radius
      // stops growing) and the increasing one is periapsis; for a node the
      // increasing crossing of the plane normal is the ascending node.
      event.add_EVENT_TYPE(events[i].direction == ev::Direction::INCREASING ? entryType
                                                                            : exitType);
      event.add_START_EPOCH(startOffset);
      event.add_EPOCH_TIME_SYSTEM(scaleOffset);
      event.add_EXTREMUM_VALUE(events[i].residual);
      encoded.push_back(event.Finish());
    }
  }

  // The optional source receipt is the exact verified descriptor of the kernel
  // that produced body states. No receipt means Analytical (or no body lookup).
  if (bodies.kernelUsed) {
    const int32_t pushed = plugin_push_output_ex("ephemeris_source", "NCD.fbs", "$NCD",
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "NCD", 0, 8,
        kernelFrame.descriptor_bytes.data(),
        static_cast<uint32_t>(kernelFrame.descriptor_bytes.size()));
    if (pushed < 0) {
      plugin_set_error("source-receipt-failed", "Could not emit the ephemeris source descriptor.");
      return 5;
    }
  }

  const auto eventsVector = builder.CreateVector(encoded);
  const auto startOffset = builder.CreateString(startText);
  const auto stopOffset = builder.CreateString(stopText);
  const auto scaleOffset = builder.CreateString("UTC");
  const auto cidOffset = eopCid != nullptr ? builder.CreateString(eopCid)
                                           : ::flatbuffers::Offset<::flatbuffers::String>();
  const auto traceOffset = request->TRACE_ID() != nullptr
                               ? builder.CreateString(request->TRACE_ID()->c_str())
                               : ::flatbuffers::Offset<::flatbuffers::String>();
  EVLEventReportBuilder report(builder);
  report.add_STATUS(status == ev::Status::RESULT_TRUNCATED ? evlResultStatus::BUDGET_EXCEEDED
                                                           : evlResultStatus::OK);
  report.add_LOCATOR_CLASS(request->LOCATOR_CLASS());
  report.add_SCAN_START_EPOCH(startOffset);
  report.add_SCAN_STOP_EPOCH(stopOffset);
  report.add_EPOCH_TIME_SYSTEM(scaleOffset);
  report.add_EVENTS(eventsVector);
  if (eopCid != nullptr) report.add_EOP_DATA_SET_CID(cidOffset);
  if (request->TRACE_ID() != nullptr) report.add_TRACE_ID(traceOffset);
  const auto reportOffset = report.Finish();

  EVLBuilder envelope(builder);
  envelope.add_EVENT_REPORT(reportOffset);
  const auto root = envelope.Finish();
  FinishEVLBuffer(builder, root);

  if (plugin_push_output("report", "EVL.fbs", "$EVL", builder.GetBufferPointer(),
                         static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit the EVL event report.");
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// propagate_to_condition
// ---------------------------------------------------------------------------

extern "C" int propagate_to_condition(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_frame("request");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No PCE stop request frame was provided.");
    return 3;
  }
  if (!PCEBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-request-buffer", "Input is not an SDS PCE FlatBuffer.");
    return 3;
  }
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyPCEBuffer(verifier)) {
    plugin_set_error("invalid-request-buffer", "Input is not a valid SDS PCE FlatBuffer.");
    return 3;
  }
  const PCE* envelopeIn = GetPCE(frame->payload);
  const PCEStopRequest* request = envelopeIn != nullptr ? envelopeIn->STOP_REQUEST() : nullptr;
  if (request == nullptr) {
    plugin_set_error("missing-request", "The PCE envelope carries no STOP_REQUEST.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1 << 16);
  const auto refuse = [&](pceResultStatus status, const char* message) {
    const auto messageOffset = builder.CreateString(message);
    PCEStopReportBuilder report(builder);
    report.add_STATUS(status);
    report.add_ERROR_MESSAGE(messageOffset);
    const auto reportOffset = report.Finish();
    PCEBuilder envelope(builder);
    envelope.add_STOP_REPORT(reportOffset);
    const auto root = envelope.Finish();
    FinishPCEBuffer(builder, root);
    plugin_push_output("report", "PCE.fbs", "$PCE", builder.GetBufferPointer(),
                       static_cast<uint32_t>(builder.GetSize()));
    return 0;
  };

  const FRMStateVector* initial = request->INITIAL_STATE();
  const char* startText =
      initial != nullptr && initial->EPOCH() != nullptr ? initial->EPOCH()->c_str() : nullptr;
  double startUtc1 = 0.0;
  double startUtc2 = 0.0;
  if (startText == nullptr || !utc_julian(startText, &startUtc1, &startUtc2)) {
    return refuse(pceResultStatus::INVALID_INPUT,
                  "INITIAL_STATE needs an ISO 8601 UTC epoch.");
  }

  EphemerisTable ephemeris;
  if (!read_ephemeris("ephemeris", startUtc1, startUtc2, &ephemeris)) {
    return refuse(pceResultStatus::MISSING_DEPENDENCY,
                  "A strictly increasing OEM ephemeris from the propagator port is "
                  "required; this provider carries no propagator of its own.");
  }

  if (request->CONDITIONS() == nullptr || request->CONDITIONS()->size() == 0) {
    return refuse(pceResultStatus::INVALID_INPUT, "A stop request needs a condition.");
  }
  const PCEParameterCondition* condition = request->CONDITIONS()->Get(0);
  const PCEParameterRef* ref = condition != nullptr ? condition->PARAMETER() : nullptr;
  if (ref == nullptr) {
    return refuse(pceResultStatus::INVALID_INPUT, "A condition needs a PARAMETER.");
  }
  const par::Descriptor* descriptor = nullptr;
  if (ref->PARAMETER() == pceParameter::PROVIDER_DEFINED &&
      ref->PROVIDER_DEFINED_NAME() != nullptr) {
    descriptor = par::findByName(ref->PROVIDER_DEFINED_NAME()->c_str());
  } else {
    const par::PceCrosswalkEntry* crosswalk =
        par::crosswalkFromPce(static_cast<uint16_t>(ref->PARAMETER()));
    if (crosswalk != nullptr && crosswalk->id != par::ParameterId::UNSPECIFIED) {
      descriptor = par::findById(crosswalk->id);
    }
  }
  if (descriptor == nullptr) {
    return refuse(pceResultStatus::UNKNOWN_PARAMETER,
                  "The condition names a parameter this provider does not resolve.");
  }
  if (descriptor->availability != par::Availability::IMPLEMENTED ||
      descriptor->kind != par::ValueKind::REAL) {
    return refuse(pceResultStatus::NOT_IMPLEMENTED,
                  "A stopping condition needs a real scalar parameter this provider "
                  "evaluates.");
  }

  ax::EarthOrientation earthOrientation;
  bool haveEop = false;
  {
    const plugin_input_frame_t* eopFrame = find_frame("earth_orientation");
    if (eopFrame != nullptr && eopFrame->payload != nullptr && eopFrame->payload_length > 0 &&
        EOPBufferHasIdentifier(eopFrame->payload)) {
      ::flatbuffers::Verifier eopVerifier(eopFrame->payload, eopFrame->payload_length);
      if (VerifyEOPBuffer(eopVerifier)) {
        const EOP* row = GetEOP(eopFrame->payload);
        if (row != nullptr) {
          earthOrientation.dut1 = row->UT1_MINUS_UTC_SECONDS_HP() != 0.0
                                      ? row->UT1_MINUS_UTC_SECONDS_HP()
                                      : row->UT1_MINUS_UTC_SECONDS();
          earthOrientation.xPole = row->X_POLE_WANDER_RADIANS_HP() != 0.0
                                       ? row->X_POLE_WANDER_RADIANS_HP()
                                       : row->X_POLE_WANDER_RADIANS();
          earthOrientation.yPole = row->Y_POLE_WANDER_RADIANS_HP() != 0.0
                                       ? row->Y_POLE_WANDER_RADIANS_HP()
                                       : row->Y_POLE_WANDER_RADIANS();
          haveEop = true;
        }
      }
    }
  }

  const PCEEvaluationContext* requestContext = request->CONTEXT();
  ScalarContext scalar;
  scalar.id = descriptor->id;
  scalar.referenceUtc1 = startUtc1;
  scalar.referenceUtc2 = startUtc2;
  scalar.base.centralBodyId =
      requestContext != nullptr && requestContext->CENTRAL_BODY_ID() != 0
          ? requestContext->CENTRAL_BODY_ID()
          : 399;
  scalar.base.earthOrientation = earthOrientation;
  scalar.base.earthOrientationSupplied = haveEop;
  scalar.base.gravitationalParameter =
      requestContext != nullptr && requestContext->GRAVITATIONAL_PARAMETER() > 0.0
          ? requestContext->GRAVITATIONAL_PARAMETER()
          : 3.986004418e14;
  if (requestContext != nullptr && requestContext->EQUATORIAL_RADIUS_M() > 0.0) {
    scalar.base.ellipsoid.equatorialRadius = requestContext->EQUATORIAL_RADIUS_M();
    scalar.base.ellipsoid.flattening = requestContext->FLATTENING();
  } else {
    scalar.base.ellipsoid.equatorialRadius = 6378137.0;
    scalar.base.ellipsoid.flattening = 1.0 / 298.257223563;
  }

  ev::StoppingContext stopping;
  stopping.scalar = parameter_scalar;
  stopping.scalarContext = &scalar;
  stopping.goal = condition->GOAL_VALUE();

  const double maximumElapsed = request->MAXIMUM_ELAPSED_SECONDS() > 0.0
                                    ? request->MAXIMUM_ELAPSED_SECONDS()
                                    : ephemeris.times.back();
  const bool backward = request->DIRECTION() == pcePropagationDirection::BACKWARD;

  ev::ScanRequest scan;
  scan.startSeconds = 0.0;
  // A BACKWARD run is the same runner with the span reversed; nothing else in
  // this file knows the difference, which is what makes backward propagation a
  // conformance case rather than a second code path.
  scan.stopSeconds = backward ? -maximumElapsed : maximumElapsed;
  scan.refinement.coarseStepSeconds = 60.0;
  scan.refinement.toleranceSeconds = request->EPOCH_TOLERANCE_SECONDS() > 0.0
                                         ? request->EPOCH_TOLERANCE_SECONDS()
                                         : 1e-6;
  if (condition->DIRECTION() == pceConditionDirection::INCREASING) {
    scan.direction = ev::Direction::INCREASING;
  } else if (condition->DIRECTION() == pceConditionDirection::DECREASING) {
    scan.direction = ev::Direction::DECREASING;
  }

  // OCCURRENCE: the caller may want the second or the third attainment. The
  // scan collects them in order and the report names which one it returned.
  const uint32_t occurrence = request->CONDITIONS()->Get(0)->OCCURRENCE() > 0
                                  ? request->CONDITIONS()->Get(0)->OCCURRENCE()
                                  : 1;
  scan.maxEvents = static_cast<int32_t>(occurrence);

  static ev::Event events[64];
  int32_t count = 0;
  const ev::Status status = ev::scan(ev::ephemerisStateSource, &ephemeris.view,
                                     ev::stoppingFunction, &stopping, scan, events, 64, &count);
  if (status == ev::Status::STATE_SOURCE_REFUSED) {
    return refuse(pceResultStatus::MISSING_DEPENDENCY,
                  "The ephemeris does not cover the requested interval; this provider "
                  "refuses rather than extrapolating.");
  }
  if (status == ev::Status::EVENT_FUNCTION_REFUSED) {
    return refuse(pceResultStatus::SINGULAR_AT_STATE,
                  "The condition parameter could not be evaluated over the interval.");
  }
  if (status == ev::Status::REFINEMENT_DID_NOT_CONVERGE) {
    return refuse(pceResultStatus::ROOT_REFINEMENT_FAILED,
                  "The root did not converge inside the iteration budget.");
  }
  if (count < static_cast<int32_t>(occurrence)) {
    return refuse(pceResultStatus::GOAL_NOT_ATTAINED,
                  "The condition was not attained inside the requested interval.");
  }

  const ev::Event& stop = events[occurrence - 1];
  char epochText[64] = {0};
  render_utc(startUtc1, startUtc2 + stop.epochSeconds / 86400.0, epochText, sizeof epochText);

  double achieved = 0.0;
  parameter_scalar(&scalar, stop.epochSeconds, stop.state, &achieved);

  const auto epochOffset = builder.CreateString(epochText);
  const auto scaleOffset = builder.CreateString("UTC");
  const auto positionOffset =
      CreateFRMVector3(builder, stop.state[0], stop.state[1], stop.state[2]);
  const auto velocityOffset =
      CreateFRMVector3(builder, stop.state[3], stop.state[4], stop.state[5]);
  const auto systemName =
      initial->COORDINATE_SYSTEM_NAME() != nullptr
          ? builder.CreateString(initial->COORDINATE_SYSTEM_NAME()->c_str())
          : ::flatbuffers::Offset<::flatbuffers::String>();
  const auto stateEpoch = builder.CreateString(epochText);
  const auto stateScale = builder.CreateString("UTC");
  FRMStateVectorBuilder state(builder);
  state.add_REPRESENTATION(frmStateRepresentation::CARTESIAN);
  state.add_POSITION(positionOffset);
  state.add_VELOCITY(velocityOffset);
  if (initial->COORDINATE_SYSTEM_NAME() != nullptr) {
    state.add_COORDINATE_SYSTEM_NAME(systemName);
  }
  state.add_EPOCH(stateEpoch);
  state.add_EPOCH_TIME_SYSTEM(stateScale);
  const auto stateOffset = state.Finish();

  const auto traceOffset = request->TRACE_ID() != nullptr
                               ? builder.CreateString(request->TRACE_ID()->c_str())
                               : ::flatbuffers::Offset<::flatbuffers::String>();

  PCEStopReportBuilder report(builder);
  report.add_STATUS(pceResultStatus::OK);
  report.add_ATTAINED_CONDITION_INDEX(0);
  report.add_ATTAINED_OCCURRENCE(occurrence);
  report.add_EPOCH(epochOffset);
  report.add_EPOCH_TIME_SYSTEM(scaleOffset);
  report.add_ELAPSED_SECONDS(stop.epochSeconds);
  report.add_STATE(stateOffset);
  report.add_ACHIEVED_VALUE(achieved);
  // The RESIDUAL is reported, never assumed zero: it is the number a consumer
  // gates on, and a root refined to a tolerance has one.
  report.add_GOAL_RESIDUAL(achieved - condition->GOAL_VALUE());
  report.add_FUNCTION_EVALUATION_COUNT(static_cast<uint32_t>(stop.iterations));
  if (request->TRACE_ID() != nullptr) report.add_TRACE_ID(traceOffset);
  const auto reportOffset = report.Finish();

  PCEBuilder envelope(builder);
  envelope.add_STOP_REPORT(reportOffset);
  const auto root = envelope.Finish();
  FinishPCEBuffer(builder, root);

  if (plugin_push_output("report", "PCE.fbs", "$PCE", builder.GetBufferPointer(),
                         static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit the PCE stop report.");
    return 1;
  }
  return 0;
}
