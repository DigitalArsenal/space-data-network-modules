import { createFlowOutputFrame } from "../flowHelpers.js";

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

function invokeNativeStreamMethod(
  analyzer,
  methodId,
  inputs,
  outputStreamCap = 0,
) {
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

export function createAccessFlowMethodHandlers(analyzer) {
  if (!analyzer) {
    throw new Error("createAccessFlowMethodHandlers requires an analyzer.");
  }

  return Object.freeze({
    compute_access_windows({ inputs }) {
      const nativeResult = invokeNativeStreamMethod(
        analyzer,
        "compute_access_windows",
        inputs,
        Array.isArray(inputs) ? inputs.length : 0,
      );
      if (nativeResult) {
        return nativeResult;
      }
      const outputs = (inputs || []).map((input) => {
        const payload = input.payload ?? {};
        return createFlowOutputFrame(
          input,
          "results",
          analyzer.computeAccessWindows(
            payload.states ?? [],
            payload.stationId,
            payload.options ?? payload.constraints ?? {},
          ),
        );
      });
      return { outputs, backlogRemaining: 0, yielded: false };
    },
  });
}

export default createAccessFlowMethodHandlers;
