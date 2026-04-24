import {
  collectPayloadRecords,
  createFlowOutputFrame,
} from "../flowHelpers.js";

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return null;
}

function normalizeStreamInvokeInputs(inputs = []) {
  const normalized = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    const bytes = toUint8Array(
      input?.bytes ?? input?.data ?? input?.payloadBytes ?? input?.payload,
    );
    if (!bytes) {
      return null;
    }
    normalized.push({
      ...input,
      bytes,
    });
  }
  return normalized;
}

function normalizeStreamInvokeOutputs(outputs = []) {
  return outputs.map((output = {}) => {
    const bytes = toUint8Array(
      output.bytes ?? output.payloadBytes ?? output.data,
    );
    return {
      ...output,
      ...(bytes ? { bytes, payloadBytes: bytes } : {}),
    };
  });
}

function invokeNativeStreamMethod(analyzer, methodId, inputs, outputStreamCap = 0) {
  if (typeof analyzer?.streamInvoke !== "function") {
    return null;
  }
  const normalizedInputs = normalizeStreamInvokeInputs(inputs);
  if (!normalizedInputs) {
    return null;
  }
  const result = analyzer.streamInvoke({
    methodId,
    inputs: normalizedInputs,
    outputStreamCap,
  });
  if ((result?.statusCode ?? 0) !== 0) {
    throw new Error(
      result?.errorMessage ||
        `Native ${methodId} stream invocation failed with status ${result?.statusCode ?? -1}.`,
    );
  }
  return {
    outputs: normalizeStreamInvokeOutputs(result?.outputs ?? []),
    backlogRemaining: result?.backlogRemaining ?? 0,
    yielded: result?.yielded ?? false,
  };
}

export function createCoverageFlowMethodHandlers(analyzer) {
  if (!analyzer) {
    throw new Error("createCoverageFlowMethodHandlers requires an analyzer.");
  }

  return {
    create_grid({ inputs }) {
      const nativeResult = invokeNativeStreamMethod(
        analyzer,
        "create_grid",
        inputs,
        Array.isArray(inputs) ? inputs.length : 0,
      );
      if (nativeResult) {
        return nativeResult;
      }
      const outputs = (inputs || []).map((input) =>
        createFlowOutputFrame(
          input,
          "results",
          analyzer.createGrid(input.payload ?? {}),
        ),
      );
      return { outputs, backlogRemaining: 0, yielded: false };
    },

    accumulate_footprints({ inputs }) {
      const nativeResult = invokeNativeStreamMethod(
        analyzer,
        "accumulate_footprints",
        inputs,
        0,
      );
      if (nativeResult) {
        return nativeResult;
      }
      for (const input of inputs || []) {
        const payload = input.payload ?? {};
        analyzer.accumulateFootprints(
          payload.gridId,
          collectPayloadRecords([input], {
            singularKeys: ["footprint"],
            pluralKeys: ["footprints", "records"],
          }),
        );
      }
      return { outputs: [], backlogRemaining: 0, yielded: false };
    },

    get_statistics({ inputs }) {
      const nativeResult = invokeNativeStreamMethod(
        analyzer,
        "get_statistics",
        inputs,
        Array.isArray(inputs) ? inputs.length : 0,
      );
      if (nativeResult) {
        return nativeResult;
      }
      const outputs = (inputs || []).map((input) =>
        createFlowOutputFrame(
          input,
          "results",
          analyzer.getStatistics(input.payload?.gridId),
        ),
      );
      return { outputs, backlogRemaining: 0, yielded: false };
    },

    get_access_intervals({ inputs }) {
      const nativeResult = invokeNativeStreamMethod(
        analyzer,
        "get_access_intervals",
        inputs,
        Array.isArray(inputs) ? inputs.length : 0,
      );
      if (nativeResult) {
        return nativeResult;
      }
      const outputs = (inputs || []).map((input) =>
        createFlowOutputFrame(input, "results", {
          intervals: analyzer.getAccessIntervals(
            input.payload?.gridId,
            input.payload?.cellIndex,
          ),
        }),
      );
      return { outputs, backlogRemaining: 0, yielded: false };
    },

    compute_fom({ inputs }) {
      const nativeResult = invokeNativeStreamMethod(
        analyzer,
        "compute_fom",
        inputs,
        Array.isArray(inputs) ? inputs.length : 0,
      );
      if (nativeResult) {
        return nativeResult;
      }
      const outputs = (inputs || []).map((input) =>
        createFlowOutputFrame(input, "results", {
          values: Array.from(
            analyzer.computeFom(
              input.payload?.gridId,
              input.payload?.fomType ?? "access_count",
            ),
          ),
        }),
      );
      return { outputs, backlogRemaining: 0, yielded: false };
    },

    generate_heatmap({ inputs }) {
      const nativeResult = invokeNativeStreamMethod(
        analyzer,
        "generate_heatmap",
        inputs,
        Array.isArray(inputs) ? inputs.length : 0,
      );
      if (nativeResult) {
        return nativeResult;
      }
      const outputs = (inputs || []).map((input) =>
        createFlowOutputFrame(
          input,
          "results",
          analyzer.generateHeatmap(input.payload?.gridId, input.payload ?? {}),
        ),
      );
      return { outputs, backlogRemaining: 0, yielded: false };
    },

    analyze_sensor_union({ inputs }) {
      const nativeResult = invokeNativeStreamMethod(
        analyzer,
        "analyze_sensor_union",
        inputs,
        Array.isArray(inputs) ? inputs.length : 0,
      );
      if (nativeResult) {
        return nativeResult;
      }
      const outputs = (inputs || []).map((input) =>
        createFlowOutputFrame(
          input,
          "results",
          analyzer.analyzeSensorUnion(input.payload?.gridId, input.payload ?? {}),
        ),
      );
      return { outputs, backlogRemaining: 0, yielded: false };
    },
  };
}

export default createCoverageFlowMethodHandlers;
