#ifdef DOMAIN
#undef DOMAIN
#endif
#ifndef SDN_BUNDLED_SDS_CPP_HEADERS
#include "SCV/main_generated.h"
#endif

#if defined(__has_include)
#if __has_include("sensor_shape_model.h")
#include "sensor_shape_model.h"
#if __has_include("sensor_shape_model.cpp.inc")
#include "sensor_shape_model.cpp.inc"
#endif
#define SDN_SENSOR_SHAPE_MODEL_INCLUDED 1
#endif
#endif

#include <cstdint>
#include <sstream>
#include <string>
#include <vector>

using namespace sdn_hypersonics;

namespace {

const char* sensor_shape_kind_name(SensorShapeKind kind) {
  switch (kind) {
    case SensorShapeKind::Unknown:
      return "unknown";
    case SensorShapeKind::Conic:
      return "conic";
    case SensorShapeKind::Rectangular:
      return "rectangular";
    case SensorShapeKind::SarAnnularSector:
      return "sar-annular-sector";
    case SensorShapeKind::CustomPolygon:
      return "custom-polygon";
  }
  return "unknown";
}

std::string join_labels(const std::vector<std::string>& labels) {
  std::string joined;
  for (size_t index = 0; index < labels.size(); ++index) {
    if (index > 0) {
      joined += ",";
    }
    joined += labels[index];
  }
  return joined;
}

SensorVec3 scv_vec3(const SCVVec3* vector) {
  if (!vector) {
    return {0.0, 0.0, 0.0};
  }
  return {vector->X(), vector->Y(), vector->Z()};
}

bool sensor_shape_contract_is_valid(
    const SensorShapeContract& contract,
    std::string& reason) {
  if (contract.kind == SensorShapeKind::CustomPolygon || !contract.supported) {
    reason = contract.unsupportedReason.empty()
        ? "unsupported shape: custom polygon sensor contracts are not evaluated by sensor-model"
        : contract.unsupportedReason;
    return false;
  }
  if (contract.minRangeM > 0.0 &&
      contract.maxRangeM > 0.0 &&
      contract.minRangeM > contract.maxRangeM) {
    reason = "invalid sensor shape: min range exceeds max range";
    return false;
  }
  switch (contract.kind) {
    case SensorShapeKind::Conic:
      if (!(contract.outerHalfAngleRad > 0.0) ||
          contract.innerHalfAngleRad > contract.outerHalfAngleRad) {
        reason = "invalid conic sensor shape angles";
        return false;
      }
      return true;
    case SensorShapeKind::Rectangular:
      if (!(contract.crossTrackHalfAngleRad > 0.0) ||
          !(contract.alongTrackHalfAngleRad > 0.0)) {
        reason = "invalid rectangular sensor shape angles";
        return false;
      }
      return true;
    case SensorShapeKind::SarAnnularSector:
      if (!(contract.outerHalfAngleRad > 0.0) ||
          contract.innerHalfAngleRad > contract.outerHalfAngleRad ||
          !(contract.clockRange.spanRad > 0.0)) {
        reason = "invalid SAR annular sector sensor shape angles";
        return false;
      }
      return true;
    case SensorShapeKind::Unknown:
    case SensorShapeKind::CustomPolygon:
      break;
  }
  reason = "unsupported shape";
  return false;
}

}  // namespace

extern "C" int evaluate_sensor_shape(void) {
  plugin_reset_output_state();
  const std::string request_payload = payload_for_port("sensor");
  if (request_payload.empty()) {
    return fail("missing-sensor", "Input port \"sensor\" is required.");
  }
  flatbuffers::Verifier verifier(
      reinterpret_cast<const uint8_t*>(request_payload.data()),
      request_payload.size());
  if (!VerifySCVBuffer(verifier)) {
    return fail(
        "invalid-scv",
        "Input port \"sensor\" must contain a valid SCV FlatBuffer.");
  }
  const SCV* envelope = GetSCV(request_payload.data());
  if (!envelope ||
      envelope->ENVELOPE_KIND() != scvEnvelopeKind_REQUEST ||
      !envelope->REQUEST()) {
    return fail(
        "invalid-envelope",
        "Input port \"sensor\" SCV envelope must contain a REQUEST payload.");
  }

  const SCVCoverageRequest* request = envelope->REQUEST();
  const auto* sensors = request->SENSORS();
  if (!sensors || sensors->size() == 0) {
    return fail(
        "missing-sensors",
        "Input port \"sensor\" SCV REQUEST must include at least one sensor.");
  }

  uint32_t boundary_direction_count = 0;
  uint32_t boresight_inside_count = 0;
  uint32_t target_sample_count = 0;
  uint32_t target_inside_count = 0;
  uint32_t active_target_sensor_count = 0;
  std::ostringstream summary;
  summary << "sensor-model evaluated " << sensors->size()
          << " SCV sensor contracts";
  if (request->JOB_ID()) {
    summary << "; job=" << request->JOB_ID()->str();
  }
  const auto* targets = request->TARGETS();
  const auto* target_state_samples = request->TARGET_STATE_SAMPLES();

  for (flatbuffers::uoffset_t index = 0; index < sensors->size(); ++index) {
    const SCVSensor* sensor = sensors->Get(index);
    if (!sensor) {
      return fail("invalid-sensor", "SCV REQUEST contains a null sensor entry.");
    }

    const SensorShapeContract contract = parse_sensor_shape_contract(sensor);
    if (contract.kind == SensorShapeKind::CustomPolygon || !contract.supported) {
      const std::string message = contract.unsupportedReason.empty()
          ? "unsupported shape: custom polygon sensor contracts are not evaluated by sensor-model"
          : contract.unsupportedReason;
      return fail("unsupported-shape", message.c_str());
    }

    std::string invalid_reason;
    if (!sensor_shape_contract_is_valid(contract, invalid_reason)) {
      return fail("invalid-shape", invalid_reason.c_str());
    }

    const std::vector<SensorVec3> boundary =
        generate_sensor_boundary_directions(contract);
    if (boundary.empty()) {
      return fail(
          "invalid-shape",
          "Sensor shape did not generate any finite boundary directions.");
    }
    const SensorClassification boresight =
        classify_local_look(contract, {0.0, 0.0, 1.0});
    boundary_direction_count += static_cast<uint32_t>(boundary.size());
    if (boresight.inside) {
      ++boresight_inside_count;
    }
    uint32_t sensor_target_inside_count = 0;

    if (targets) {
      for (flatbuffers::uoffset_t target_index = 0;
           target_index < targets->size();
           ++target_index) {
        const SCVTarget* target = targets->Get(target_index);
        if (!target || !target->POSITION_M()) {
          return fail(
              "invalid-target",
              "SCV TARGETS used for sensor-model classification require POSITION_M.");
        }
        if (target->FRAME() != scvCoordinateFrame_SENSOR_LOCAL) {
          return fail(
              "unsupported-target-frame",
              "sensor-model target sample classification requires SENSOR_LOCAL target frames.");
        }
        const SensorClassification classification =
            classify_local_look(contract, scv_vec3(target->POSITION_M()));
        ++target_sample_count;
        if (classification.inside) {
          ++target_inside_count;
          ++sensor_target_inside_count;
        }
      }
    }

    if (target_state_samples) {
      for (flatbuffers::uoffset_t sample_index = 0;
           sample_index < target_state_samples->size();
           ++sample_index) {
        const SCVTargetStateSample* sample =
            target_state_samples->Get(sample_index);
        if (!sample || !sample->POSITION_M()) {
          return fail(
              "invalid-target-state-sample",
              "SCV TARGET_STATE_SAMPLES used for sensor-model classification require POSITION_M.");
        }
        if (sample->FRAME() != scvCoordinateFrame_SENSOR_LOCAL) {
          return fail(
              "unsupported-target-frame",
              "sensor-model target sample classification requires SENSOR_LOCAL target frames.");
        }
        const SensorClassification classification =
            classify_local_look(contract, scv_vec3(sample->POSITION_M()));
        ++target_sample_count;
        if (classification.inside) {
          ++target_inside_count;
          ++sensor_target_inside_count;
        }
      }
    }

    if (sensor_target_inside_count > 0) {
      ++active_target_sensor_count;
    }

    summary << "; sensor[" << index << "] id=" << sensor->SENSOR_ID()
            << " kind=" << sensor_shape_kind_name(contract.kind)
            << " boundaryDirections=" << boundary.size()
            << " boresight="
            << (boresight.inside ? "inside" : "outside")
            << " labels=" << join_labels(contract.conformanceLabels)
            << " targetInside=" << sensor_target_inside_count;
  }
  summary << "; totalBoundaryDirections=" << boundary_direction_count
          << "; boresightInside=" << boresight_inside_count
          << "; targetSamples=" << target_sample_count
          << "; targetInside=" << target_inside_count
          << "; targetOutside=" << (target_sample_count - target_inside_count);

  flatbuffers::FlatBufferBuilder builder(1024);
  auto message = builder.CreateString(summary.str());
  auto aggregate_statistics = target_sample_count > 0
      ? CreateSCVAggregateStatistics(
            builder,
            target_sample_count,
            target_inside_count,
            0,
            active_target_sensor_count,
            0,
            1,
            target_sample_count,
            0,
            static_cast<double>(target_inside_count),
            static_cast<double>(target_sample_count - target_inside_count),
            static_cast<double>(target_sample_count - target_inside_count),
            0.0,
            0.0,
            0.0,
            target_sample_count > 0
                ? (100.0 * static_cast<double>(target_inside_count) /
                   static_cast<double>(target_sample_count))
                : 0.0)
      : 0;
  auto result = CreateSCVResult(
      builder,
      builder.CreateString("sensor-model"),
      0,
      scvResultState_OK,
      0,
      0,
      sensors->size(),
      target_sample_count > 0 ? 1 : 0,
      0,
      0,
      0,
      0,
      message,
      aggregate_statistics);
  auto scv = CreateSCV(builder, scvEnvelopeKind_RESULT, 0, 0, 0, result, 0);
  FinishSCVBuffer(builder, scv);
  return emit_bytes(
      "result",
      "SCV/main.fbs",
      "$SCV",
      builder.GetBufferPointer(),
      static_cast<uint32_t>(builder.GetSize()));
}
