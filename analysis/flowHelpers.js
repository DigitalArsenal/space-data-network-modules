function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function normalizeJulianDate(value, label = "julianDate") {
  if (
    value &&
    Number.isFinite(value.dayNumber) &&
    Number.isFinite(value.secondsOfDay)
  ) {
    return value;
  }

  const jd =
    toFiniteNumber(value) ??
    toFiniteNumber(value?.jd) ??
    toFiniteNumber(value?.targetJD) ??
    toFiniteNumber(value?.targetJd) ??
    toFiniteNumber(value?.epochJD);
  if (!Number.isFinite(jd)) {
    throw new Error(`Missing finite ${label} value.`);
  }

  const dayNumber = Math.floor(jd);
  return {
    dayNumber,
    secondsOfDay: (jd - dayNumber) * 86400.0,
  };
}

export function createFlowOutputFrame(
  inputFrame,
  portId,
  payload,
  overrides = {},
) {
  return {
    ...inputFrame,
    ...overrides,
    portId,
    payload,
  };
}

export function readPositionTriples(result) {
  const count = Math.max(0, Number(result?.count ?? 0));
  if (count === 0) {
    return [];
  }
  if (!result?.module?.HEAPU8) {
    throw new Error("Path result is missing module HEAPU8 memory.");
  }

  const values = new Float64Array(
    result.module.HEAPU8.buffer,
    result.ptr,
    count * 3,
  );
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    samples.push({
      x: values[offset],
      y: values[offset + 1],
      z: values[offset + 2],
    });
  }
  return samples;
}

export function collectPayloadRecords(inputs, options = {}) {
  const singularKeys = Array.isArray(options.singularKeys)
    ? options.singularKeys
    : [];
  const pluralKeys = Array.isArray(options.pluralKeys)
    ? options.pluralKeys
    : [];
  const records = [];

  for (const input of Array.isArray(inputs) ? inputs : []) {
    const payload = input?.payload;
    if (Array.isArray(payload)) {
      records.push(...payload);
      continue;
    }

    if (payload && typeof payload === "object") {
      let collected = false;
      for (const key of pluralKeys) {
        if (Array.isArray(payload[key])) {
          records.push(...payload[key]);
          collected = true;
        }
      }
      if (collected) {
        continue;
      }
      for (const key of singularKeys) {
        if (payload[key] !== undefined) {
          records.push(payload[key]);
          collected = true;
          break;
        }
      }
      if (collected) {
        continue;
      }
    }

    if (payload !== undefined && payload !== null) {
      records.push(payload);
    }
  }

  return records;
}
