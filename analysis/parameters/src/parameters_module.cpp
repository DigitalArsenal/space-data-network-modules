// parameters_module.cpp — the SDS wire for the named-parameter catalog.
//
// GMAT-parity program item 6. Two methods:
//
//   publish_catalog     emit the roster itself as a $PCE CATALOG, so a consumer
//                       can discover what this build answers, in what unit, in
//                       what frame, and where it refuses — without asking.
//   evaluate_parameters evaluate named parameters on a run of states and emit a
//                       $PCE EVALUATION_RESULT.
//
// This file is WIRE ONLY. Every number comes out of src/parameter_catalog.hpp,
// every element set out of foundation/orbits, every rotation out of
// foundation/frames. Nothing here computes physics, and the one thing it does
// decide — which published parameter code means which roster entry — is read
// from the generated crosswalk rather than written twice.

#include "space_data_module_invoke.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace {

namespace par = ::sdn::parameters;
namespace orb = ::sdn::orbits;
namespace ax = ::sdn::frames;

constexpr int kMaxStates = 4096;
constexpr int kMaxParameters = 256;

const plugin_input_frame_t* find_frame(const char* port_id) {
  const int32_t index = plugin_find_input_index(port_id, 0);
  if (index < 0) return nullptr;
  return plugin_get_input_frame(static_cast<uint32_t>(index));
}

/// Parse an ISO 8601 UTC instant. Deliberately strict: a malformed epoch is
/// refused rather than partially read, because a silently truncated epoch is a
/// different instant and every time-dependent parameter would then be wrong by
/// an amount nothing reports.
bool parse_iso_utc(const char* text, int* year, int* month, int* day, int* hour, int* minute,
                   double* second) {
  if (text == nullptr) return false;
  int values[5] = {0, 0, 0, 0, 0};
  int index = 0;
  const char* cursor = text;
  for (; index < 5; ++index) {
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
      ++cursor;  // '-', '-', 'T'/' ', ':'
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

/// Map the evaluator's outcome onto the published result vocabulary. The two
/// are deliberately separate types: the header answers a physics question and
/// the record answers a wire question, and collapsing them would make the
/// header's vocabulary a wire contract it never agreed to.
pceResultStatus publish_status(par::Status status) {
  switch (status) {
    case par::Status::OK: return pceResultStatus::OK;
    case par::Status::UNKNOWN_PARAMETER: return pceResultStatus::UNKNOWN_PARAMETER;
    case par::Status::NOT_IMPLEMENTED: return pceResultStatus::NOT_IMPLEMENTED;
    case par::Status::MISSING_INPUT: return pceResultStatus::MISSING_DEPENDENCY;
    case par::Status::UNDEFINED_FOR_THIS_ORBIT: return pceResultStatus::OUT_OF_DOMAIN;
    case par::Status::UNSUPPORTED_CENTRAL_BODY: return pceResultStatus::MISSING_DEPENDENCY;
    case par::Status::NUMERICAL_FAILURE:
    default:
      return pceResultStatus::SINGULAR_AT_STATE;
  }
}

pceUnit publish_unit(const char* unit) {
  if (unit == nullptr || unit[0] == '\0') return pceUnit::DIMENSIONLESS;
  if (std::strcmp(unit, "m") == 0) return pceUnit::METRE;
  if (std::strcmp(unit, "m/s") == 0) return pceUnit::METRE_PER_SECOND;
  if (std::strcmp(unit, "rad") == 0) return pceUnit::RADIAN;
  if (std::strcmp(unit, "rad/s") == 0) return pceUnit::RADIAN_PER_SECOND;
  if (std::strcmp(unit, "s") == 0) return pceUnit::SECOND;
  if (std::strcmp(unit, "d") == 0) return pceUnit::DAY;
  if (std::strcmp(unit, "kg") == 0) return pceUnit::KILOGRAM;
  if (std::strcmp(unit, "m^2") == 0) return pceUnit::METRE_SQUARED;
  if (std::strcmp(unit, "m^3/s^2") == 0) return pceUnit::PROVIDER_DEFINED;
  if (std::strcmp(unit, "m^2/s") == 0) return pceUnit::METRE_SQUARED_PER_SECOND;
  if (std::strcmp(unit, "m^2/s^2") == 0) return pceUnit::METRE_SQUARED_PER_SECOND_SQUARED;
  if (std::strcmp(unit, "m/s^2") == 0) return pceUnit::METRE_PER_SECOND_SQUARED;
  if (std::strcmp(unit, "kg/s") == 0) return pceUnit::KILOGRAM_PER_SECOND;
  if (std::strcmp(unit, "kg/m^3") == 0) return pceUnit::KILOGRAM_PER_METRE_CUBED;
  if (std::strcmp(unit, "kg/m^2") == 0) return pceUnit::PROVIDER_DEFINED;
  if (std::strcmp(unit, "m^2/kg") == 0) return pceUnit::METRE_SQUARED_PER_KILOGRAM;
  if (std::strcmp(unit, "kg m^2") == 0) return pceUnit::KILOGRAM_METRE_SQUARED;
  if (std::strcmp(unit, "N") == 0) return pceUnit::NEWTON;
  if (std::strcmp(unit, "K") == 0) return pceUnit::KELVIN;
  if (std::strcmp(unit, "Pa") == 0) return pceUnit::PASCAL;
  if (std::strcmp(unit, "m^3") == 0) return pceUnit::METRE_CUBED;
  if (std::strcmp(unit, "W") == 0) return pceUnit::WATT;
  if (std::strcmp(unit, "1/s") == 0) return pceUnit::PROVIDER_DEFINED;
  // Reciprocal seconds, cubic metres per second squared and kilograms per
  // square metre are outside the published SI vocabulary. PROVIDER_DEFINED is
  // the standard's own answer for that, and the descriptor names the symbol —
  // which is why nothing here quietly returns DIMENSIONLESS instead.
  return pceUnit::PROVIDER_DEFINED;
}

pceOwnerClass publish_owner(par::OwnerClass owner) {
  switch (owner) {
    case par::OwnerClass::SPACE_OBJECT: return pceOwnerClass::SPACE_OBJECT;
    case par::OwnerClass::SPACE_POINT: return pceOwnerClass::SPACE_POINT;
    case par::OwnerClass::THRUSTER: return pceOwnerClass::THRUSTER;
    case par::OwnerClass::PROPELLANT_TANK: return pceOwnerClass::FUEL_TANK;
    case par::OwnerClass::IMPULSIVE_MANEUVER: return pceOwnerClass::IMPULSIVE_BURN;
    case par::OwnerClass::FINITE_MANEUVER: return pceOwnerClass::FINITE_BURN;
    case par::OwnerClass::POWER_SYSTEM: return pceOwnerClass::POWER_SYSTEM;
    case par::OwnerClass::SURFACE_PLATE: return pceOwnerClass::SPACE_OBJECT;
    case par::OwnerClass::HARDWARE_MOUNT: return pceOwnerClass::SPACE_OBJECT;
    default: return pceOwnerClass::UNSPECIFIED;
  }
}

pceDataType publish_data_type(par::ValueKind kind) {
  switch (kind) {
    case par::ValueKind::REAL: return pceDataType::REAL_SCALAR;
    case par::ValueKind::REAL_ARRAY: return pceDataType::REAL_VECTOR;
    case par::ValueKind::MATRIX: return pceDataType::REAL_MATRIX;
    case par::ValueKind::EPOCH_TEXT: return pceDataType::EPOCH;
    case par::ValueKind::IDENTIFIER_TEXT: return pceDataType::STRING;
    default: return pceDataType::UNSPECIFIED;
  }
}

pceFrameDependency publish_frame(par::FrameDependency frame) {
  switch (frame) {
    case par::FrameDependency::NONE: return pceFrameDependency::FRAME_INDEPENDENT;
    case par::FrameDependency::COORDINATE_SYSTEM:
      return pceFrameDependency::COORDINATE_SYSTEM_DEPENDENT;
    case par::FrameDependency::CENTRAL_BODY: return pceFrameDependency::CENTRAL_BODY_DEPENDENT;
    case par::FrameDependency::BODY_FIXED: return pceFrameDependency::COORDINATE_SYSTEM_DEPENDENT;
    case par::FrameDependency::SUN_DIRECTION:
      return pceFrameDependency::SECOND_OBJECT_DEPENDENT;
    case par::FrameDependency::BODY_FRAME: return pceFrameDependency::COORDINATE_SYSTEM_DEPENDENT;
    default: return pceFrameDependency::UNSPECIFIED;
  }
}

/// Why a declared parameter is unavailable, in capability language. Read from
/// the roster's availability rather than typed twice.
const char* unavailable_reason(par::Availability availability) {
  switch (availability) {
    case par::Availability::REQUIRES_ATTITUDE_PROVIDER:
      return "an attitude provider is required";
    case par::Availability::REQUIRES_HARDWARE_PROVIDER:
      return "a hardware provider is required";
    case par::Availability::REQUIRES_POWER_PROVIDER: return "a power provider is required";
    case par::Availability::REQUIRES_MASS_PROPERTY_PROVIDER:
      return "a mass-property provider is required";
    case par::Availability::REQUIRES_MANEUVER_PROVIDER:
      return "a maneuver provider is required";
    case par::Availability::REQUIRES_MEAN_ELEMENT_THEORY:
      return "a mean-element theory provider is required";
    case par::Availability::REQUIRES_ATMOSPHERE_PROVIDER:
      return "an atmosphere provider is required";
    case par::Availability::REQUIRES_COVARIANCE_PROVIDER:
      return "a covariance provider is required";
    case par::Availability::REQUIRES_STATE_TRANSITION_PROVIDER:
      return "a state-transition provider is required";
    case par::Availability::REQUIRES_ESTIMATION_PROVIDER:
      return "an estimation provider is required";
    case par::Availability::CALLER_SUPPLIED:
      return "the value is a stated property of the object and must be supplied";
    case par::Availability::NOT_A_CALCULATION_PARAMETER:
      return "not a calculation parameter";
    default: return nullptr;
  }
}

pceAvailability publish_availability(par::Availability availability) {
  switch (availability) {
    case par::Availability::IMPLEMENTED: return pceAvailability::IMPLEMENTED;
    case par::Availability::CALLER_SUPPLIED: return pceAvailability::IMPLEMENTED;
    default: return pceAvailability::DECLARED_UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Earth orientation, read from the optional port. Exactly the frames module's
// rule: the `_HP` doubles are authoritative when present, and an axis chain
// that needs the row and is handed none refuses rather than assuming zeros.
// ---------------------------------------------------------------------------

bool read_earth_orientation(ax::EarthOrientation* eop, const char** dataSetCid) {
  const plugin_input_frame_t* frame = find_frame("earth_orientation");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    return false;
  }
  if (!EOPBufferHasIdentifier(frame->payload)) return false;
  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyEOPBuffer(verifier)) return false;
  const EOP* row = GetEOP(frame->payload);
  if (row == nullptr) return false;
  // PRECEDENCE, exactly as $EOP states it and as foundation/frames reads it:
  // a high-precision double, when present, is AUTHORITATIVE over the float
  // beside it. Reading the float when a double is there would resolve dUT1 near
  // 0.9 s only to about 6e-8 s, which is coarser than every acceptance that
  // depends on Earth rotation.
  const bool haveHighPrecision = row->UT1_MINUS_UTC_SECONDS_HP() != 0.0 ||
                                 row->X_POLE_WANDER_RADIANS_HP() != 0.0 ||
                                 row->Y_POLE_WANDER_RADIANS_HP() != 0.0;
  if (haveHighPrecision) {
    eop->dut1 = row->UT1_MINUS_UTC_SECONDS_HP();
    eop->xPole = row->X_POLE_WANDER_RADIANS_HP();
    eop->yPole = row->Y_POLE_WANDER_RADIANS_HP();
    eop->dX = row->X_CELESTIAL_POLE_OFFSET_RADIANS_HP();
    eop->dY = row->Y_CELESTIAL_POLE_OFFSET_RADIANS_HP();
    eop->lengthOfDay = row->LENGTH_OF_DAY_CORRECTION_SECONDS_HP();
  } else {
    eop->dut1 = row->UT1_MINUS_UTC_SECONDS();
    eop->xPole = row->X_POLE_WANDER_RADIANS();
    eop->yPole = row->Y_POLE_WANDER_RADIANS();
    eop->dX = row->X_CELESTIAL_POLE_OFFSET_RADIANS();
    eop->dY = row->Y_CELESTIAL_POLE_OFFSET_RADIANS();
    eop->lengthOfDay = row->LENGTH_OF_DAY_CORRECTION_SECONDS();
  }
  if (dataSetCid != nullptr && row->DATA_SET_CID() != nullptr) {
    *dataSetCid = row->DATA_SET_CID()->c_str();
  }
  return true;
}

// ---------------------------------------------------------------------------

struct BodyGm {
  int bodyId;
  double gm;
};
// Used ONLY when the request supplies no gravitational parameter; the request
// always wins. Values: IAU 2015 nominal (Sun), DE440 (Earth, Moon, Mars).
constexpr BodyGm kBodyGm[] = {
    {10, 1.32712440018e20},
    {399, 3.986004418e14},
    {301, 4.902800118e12},
    {499, 4.282837362e13},
};

double default_gravitational_parameter(int bodyId) {
  for (const BodyGm& entry : kBodyGm) {
    if (entry.bodyId == bodyId) return entry.gm;
  }
  return 0.0;
}

struct BodyShape {
  int bodyId;
  double equatorialRadius;
  double flattening;
};
// WGS84 for the Earth; IAU/WGCCRE mean radii and flattening for the others.
constexpr BodyShape kBodyShape[] = {
    {399, 6378137.0, 1.0 / 298.257223563},
    {301, 1737400.0, 0.0},
    {499, 3396190.0, 1.0 / 169.894},
};

bool default_shape(int bodyId, orb::Ellipsoid* out) {
  for (const BodyShape& entry : kBodyShape) {
    if (entry.bodyId == bodyId) {
      out->equatorialRadius = entry.equatorialRadius;
      out->flattening = entry.flattening;
      return true;
    }
  }
  return false;
}

}  // namespace

// ---------------------------------------------------------------------------
// publish_catalog
// ---------------------------------------------------------------------------

extern "C" int publish_catalog(void) {
  plugin_reset_output_state();

  ::flatbuffers::FlatBufferBuilder builder(1 << 18);
  ::std::vector<::flatbuffers::Offset<PCEParameterDescriptor>> entries;
  entries.reserve(par::kCatalogSize);

  for (int i = 0; i < par::kCatalogSize; ++i) {
    const par::Descriptor& descriptor = par::kCatalog[i];
    if (descriptor.kind == par::ValueKind::CONTAINER) continue;
    const par::PceCrosswalkEntry* published = nullptr;
    for (int j = 0; j < par::kPceCrosswalkSize; ++j) {
      if (par::kPceCrosswalk[j].id == descriptor.id) {
        published = &par::kPceCrosswalk[j];
        break;
      }
    }
    // A roster entry with no published code is reachable by name only; it is
    // still published so a consumer can see it exists.
    const auto name = builder.CreateString(descriptor.name);
    const char* reason = unavailable_reason(descriptor.availability);
    const auto reasonOffset = reason != nullptr ? builder.CreateString(reason)
                                                : ::flatbuffers::Offset<::flatbuffers::String>();

    PCEParameterDescriptorBuilder entry(builder);
    entry.add_PARAMETER(published != nullptr
                            ? static_cast<pceParameter>(published->pceParameterValue)
                            : pceParameter::PROVIDER_DEFINED);
    entry.add_PROVIDER_DEFINED_NAME(name);
    entry.add_OWNER_CLASS(publish_owner(descriptor.owner));
    entry.add_UNIT(publish_unit(descriptor.unit));
    entry.add_DATA_TYPE(publish_data_type(descriptor.kind));
    entry.add_ELEMENT_COUNT(descriptor.elementCount);
    entry.add_FRAME_DEPENDENCY(publish_frame(descriptor.frame));
    entry.add_AVAILABILITY(publish_availability(descriptor.availability));
    // A stated property is SETTABLE — it is a fact about the object that the
    // caller supplies — while a computed one is not. Saying which is how a
    // consumer knows whether writing to it means anything.
    entry.add_IS_SETTABLE(descriptor.availability == par::Availability::CALLER_SUPPLIED);
    // A real scalar that this build evaluates can carry a stopping condition;
    // a matrix, a text epoch or a refused name cannot.
    entry.add_SUPPORTS_STOPPING_CONDITION(
        descriptor.kind == par::ValueKind::REAL &&
        descriptor.availability == par::Availability::IMPLEMENTED);
    if (reason != nullptr) entry.add_UNAVAILABLE_REASON(reasonOffset);
    entries.push_back(entry.Finish());
  }

  const auto catalogId = builder.CreateString("sdn-parameter-catalog");
  const auto providerId = builder.CreateString("com.digitalarsenal.analysis.parameters");
  const auto entriesVector = builder.CreateVector(entries);
  PCEParameterCatalogBuilder catalog(builder);
  catalog.add_CATALOG_ID(catalogId);
  catalog.add_PROVIDER_ID(providerId);
  catalog.add_ENTRIES(entriesVector);
  const auto catalogOffset = catalog.Finish();

  PCEBuilder envelope(builder);
  envelope.add_CATALOG(catalogOffset);
  const auto root = envelope.Finish();
  FinishPCEBuffer(builder, root);

  if (plugin_push_output("catalog", "PCE.fbs", "$PCE", builder.GetBufferPointer(),
                         static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit the PCE parameter catalog.");
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// evaluate_parameters
// ---------------------------------------------------------------------------

extern "C" int evaluate_parameters(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_frame("request");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length == 0) {
    plugin_set_error("missing-request", "No PCE evaluation request frame was provided.");
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
  const PCEEvaluationRequest* request =
      envelopeIn != nullptr ? envelopeIn->EVALUATION_REQUEST() : nullptr;
  if (request == nullptr) {
    plugin_set_error("missing-request", "The PCE envelope carries no EVALUATION_REQUEST.");
    return 3;
  }

  ax::EarthOrientation earthOrientation;
  const char* eopCid = nullptr;
  const bool haveEop = read_earth_orientation(&earthOrientation, &eopCid);

  const PCEEvaluationContext* requestContext = request->CONTEXT();
  const int centralBodyId = requestContext != nullptr && requestContext->CENTRAL_BODY_ID() != 0
                                ? requestContext->CENTRAL_BODY_ID()
                                : 399;

  par::EvaluationContext base;
  base.centralBodyId = centralBodyId;
  base.earthOrientation = earthOrientation;
  base.earthOrientationSupplied = haveEop;
  base.gravitationalParameter =
      requestContext != nullptr && requestContext->GRAVITATIONAL_PARAMETER() > 0.0
          ? requestContext->GRAVITATIONAL_PARAMETER()
          : default_gravitational_parameter(centralBodyId);
  if (requestContext != nullptr && requestContext->EQUATORIAL_RADIUS_M() > 0.0) {
    base.ellipsoid.equatorialRadius = requestContext->EQUATORIAL_RADIUS_M();
    base.ellipsoid.flattening = requestContext->FLATTENING();
  } else {
    default_shape(centralBodyId, &base.ellipsoid);
  }
  if (requestContext != nullptr && requestContext->REFERENCE_EPOCH() != nullptr) {
    int year = 0, month = 0, day = 0, hour = 0, minute = 0;
    double second = 0.0;
    if (parse_iso_utc(requestContext->REFERENCE_EPOCH()->c_str(), &year, &month, &day, &hour,
                      &minute, &second) &&
        eraDtf2d("UTC", year, month, day, hour, minute, second, &base.referenceUtc1,
                 &base.referenceUtc2) == 0) {
      base.referenceEpochSupplied = true;
    }
  }

  ::flatbuffers::FlatBufferBuilder builder(1 << 18);
  ::std::vector<::flatbuffers::Offset<PCEParameterSample>> samples;

  const auto states = request->STATES();
  const auto parameters = request->PARAMETERS();
  const int stateCount = states != nullptr ? static_cast<int>(states->size()) : 0;
  const int parameterCount = parameters != nullptr ? static_cast<int>(parameters->size()) : 0;
  if (stateCount == 0 || parameterCount == 0) {
    plugin_set_error("empty-request",
                     "An evaluation request must name at least one parameter and one state.");
    return 3;
  }
  if (stateCount > kMaxStates || parameterCount > kMaxParameters) {
    plugin_set_error("request-too-large",
                     "The request exceeds this provider's per-invocation limits.");
    return 3;
  }

  for (int stateIndex = 0; stateIndex < stateCount; ++stateIndex) {
    const FRMStateVector* state = states->Get(stateIndex);
    par::EvaluationContext context = base;
    if (state != nullptr && state->POSITION() != nullptr && state->VELOCITY() != nullptr) {
      context.state.position = {state->POSITION()->X(), state->POSITION()->Y(),
                                state->POSITION()->Z()};
      context.state.velocity = {state->VELOCITY()->X(), state->VELOCITY()->Y(),
                                state->VELOCITY()->Z()};
    }
    if (state != nullptr && state->GRAVITATIONAL_PARAMETER() > 0.0) {
      context.gravitationalParameter = state->GRAVITATIONAL_PARAMETER();
    }
    const char* epochText =
        state != nullptr && state->EPOCH() != nullptr ? state->EPOCH()->c_str() : nullptr;
    if (epochText != nullptr) {
      int year = 0, month = 0, day = 0, hour = 0, minute = 0;
      double second = 0.0;
      if (parse_iso_utc(epochText, &year, &month, &day, &hour, &minute, &second) &&
          ax::epochFromUtc(year, month, day, hour, minute, second, context.earthOrientation,
                           &context.epoch) &&
          eraDtf2d("UTC", year, month, day, hour, minute, second, &context.utc1,
                   &context.utc2) == 0) {
        context.epochSupplied = true;
      }
    }

    par::Derived derived;
    const bool derivedOk = par::buildDerived(context, &derived);

    ::std::vector<::flatbuffers::Offset<PCEParameterValue>> values;
    values.reserve(parameterCount);
    for (int p = 0; p < parameterCount; ++p) {
      const PCEParameterRef* ref = parameters->Get(p);
      if (ref == nullptr) continue;

      const par::Descriptor* descriptor = nullptr;
      const par::PceCrosswalkEntry* crosswalk = nullptr;
      const char* providerName = ref->PROVIDER_DEFINED_NAME() != nullptr
                                     ? ref->PROVIDER_DEFINED_NAME()->c_str()
                                     : nullptr;
      if (ref->PARAMETER() == pceParameter::PROVIDER_DEFINED) {
        // A provider-defined reference resolves against the roster BY NAME,
        // which is how the reference tool's own shorthands stay reachable.
        descriptor = par::findByName(providerName);
      } else {
        crosswalk = par::crosswalkFromPce(static_cast<uint16_t>(ref->PARAMETER()));
        if (crosswalk != nullptr && crosswalk->id != par::ParameterId::UNSPECIFIED) {
          descriptor = par::findById(crosswalk->id);
        }
      }

      const auto nameOffset =
          providerName != nullptr
              ? builder.CreateString(providerName)
              : (descriptor != nullptr ? builder.CreateString(descriptor->name)
                                       : ::flatbuffers::Offset<::flatbuffers::String>());

      if (descriptor == nullptr) {
        const char* reason = crosswalk != nullptr && crosswalk->unavailableReason != nullptr
                                 ? crosswalk->unavailableReason
                                 : "this provider does not answer that parameter";
        const auto message = builder.CreateString(reason);
        PCEParameterValueBuilder value(builder);
        value.add_PARAMETER(ref->PARAMETER());
        if (providerName != nullptr) value.add_PROVIDER_DEFINED_NAME(nameOffset);
        value.add_STATUS(crosswalk != nullptr ? pceResultStatus::NOT_IMPLEMENTED
                                              : pceResultStatus::UNKNOWN_PARAMETER);
        value.add_MESSAGE(message);
        values.push_back(value.Finish());
        continue;
      }

      if (descriptor->kind == par::ValueKind::EPOCH_TEXT) {
        char text[64] = {0};
        const par::Status status =
            par::evaluateText(descriptor->id, context, text, sizeof text);
        const auto textOffset = status == par::Status::OK
                                    ? builder.CreateString(text)
                                    : ::flatbuffers::Offset<::flatbuffers::String>();
        PCEParameterValueBuilder value(builder);
        value.add_PARAMETER(ref->PARAMETER());
        if (providerName != nullptr) value.add_PROVIDER_DEFINED_NAME(nameOffset);
        value.add_STATUS(publish_status(status));
        if (status == par::Status::OK) value.add_STRING_VALUE(textOffset);
        value.add_UNIT(publish_unit(descriptor->unit));
        values.push_back(value.Finish());
        continue;
      }

      double evaluated[36] = {0.0};
      int count = 0;
      const par::Status status =
          derivedOk ? par::evaluate(descriptor->id, context, derived, evaluated, &count)
                    : par::Status::NUMERICAL_FAILURE;

      const int elementIndex = ref->ELEMENT_INDEX();
      ::flatbuffers::Offset<::flatbuffers::Vector<double>> vectorOffset;
      if (status == par::Status::OK && count > 1 && elementIndex < 0) {
        vectorOffset = builder.CreateVector(evaluated, static_cast<size_t>(count));
      }
      const char* reason =
          status == par::Status::NOT_IMPLEMENTED
              ? unavailable_reason(descriptor->availability)
              : nullptr;
      const auto message = reason != nullptr
                               ? builder.CreateString(reason)
                               : ::flatbuffers::Offset<::flatbuffers::String>();

      PCEParameterValueBuilder value(builder);
      value.add_PARAMETER(ref->PARAMETER());
      if (providerName != nullptr) value.add_PROVIDER_DEFINED_NAME(nameOffset);
      value.add_STATUS(publish_status(status));
      value.add_UNIT(publish_unit(descriptor->unit));
      if (status == par::Status::OK) {
        if (count == 1) {
          value.add_VALUE(evaluated[0]);
        } else if (elementIndex >= 0 && elementIndex < count) {
          value.add_VALUE(evaluated[elementIndex]);
        } else {
          value.add_VALUES(vectorOffset);
          if (count == 36) {
            value.add_ROW_COUNT(6);
            value.add_COLUMN_COUNT(6);
          } else if (count == 9) {
            value.add_ROW_COUNT(3);
            value.add_COLUMN_COUNT(3);
          }
        }
      } else if (reason != nullptr) {
        value.add_MESSAGE(message);
      }
      values.push_back(value.Finish());
    }

    const auto epochOffset =
        epochText != nullptr ? builder.CreateString(epochText)
                             : ::flatbuffers::Offset<::flatbuffers::String>();
    const auto scaleOffset = builder.CreateString("UTC");
    const auto valuesVector = builder.CreateVector(values);
    PCEParameterSampleBuilder sample(builder);
    if (epochText != nullptr) sample.add_EPOCH(epochOffset);
    sample.add_EPOCH_TIME_SYSTEM(scaleOffset);
    sample.add_PARAMETER_VALUES(valuesVector);
    samples.push_back(sample.Finish());
  }

  const auto traceOffset = request->TRACE_ID() != nullptr
                               ? builder.CreateString(request->TRACE_ID()->c_str())
                               : ::flatbuffers::Offset<::flatbuffers::String>();
  const auto cidOffset = eopCid != nullptr ? builder.CreateString(eopCid)
                                           : ::flatbuffers::Offset<::flatbuffers::String>();
  const auto samplesVector = builder.CreateVector(samples);
  PCEEvaluationResultBuilder result(builder);
  result.add_STATUS(pceResultStatus::OK);
  result.add_SAMPLES(samplesVector);
  if (eopCid != nullptr) result.add_EOP_DATA_SET_CID(cidOffset);
  if (request->TRACE_ID() != nullptr) result.add_TRACE_ID(traceOffset);
  const auto resultOffset = result.Finish();

  PCEBuilder envelope(builder);
  envelope.add_EVALUATION_RESULT(resultOffset);
  const auto root = envelope.Finish();
  FinishPCEBuffer(builder, root);

  if (plugin_push_output("result", "PCE.fbs", "$PCE", builder.GetBufferPointer(),
                         static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit the PCE evaluation result.");
    return 1;
  }
  return 0;
}
