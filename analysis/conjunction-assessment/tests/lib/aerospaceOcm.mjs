import path from "node:path";

export const AEROSPACE_SCREENING_WINDOW_START_ISO = "2025-01-01T12:00:00Z";
export const AEROSPACE_SCREENING_WINDOW_STOP_ISO = "2025-01-08T12:00:00Z";
export const AEROSPACE_MAX_OD_AGE_DAYS = 14;

const ISO_PREFIX_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?/;
const NUMBER_PATTERN = /^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const BLOCK_STOP_PATTERN = /^([A-Z_]+)_STOP$/;
const BLOCK_START_PATTERN = /^([A-Z_]+)_START$/;
const ISO_TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/i;

function parseBracketList(rawValue) {
  const inner = rawValue.slice(1, -1).trim();
  return inner.length === 0 ? [] : inner.split(",").map((item) => item.trim());
}

function parseScalarValue(rawValue) {
  const trimmed = String(rawValue ?? "").trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return parseBracketList(trimmed);
  }
  if (NUMBER_PATTERN.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed.includes(",") && !trimmed.startsWith("<")) {
    return trimmed.split(",").map((item) => item.trim());
  }
  return trimmed;
}

function looksLikeEpochRow(line) {
  return ISO_PREFIX_PATTERN.test(line.trimStart());
}

function toPlainArray(value) {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function parseEpochDataRow(line) {
  const trimmed = line.trim();
  if (!looksLikeEpochRow(trimmed)) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    return null;
  }

  const epoch = parts.shift();
  const values = parts
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value));

  return {
    epoch,
    epochJD: isoToJulianDate(epoch),
    values,
    raw: trimmed,
  };
}

function createBlock(type) {
  return {
    type,
    fields: {},
    rows: [],
    rawLines: [],
  };
}

function finalizeTrajectoryBlock(block) {
  const samples = [];

  for (const row of block.rows) {
    const sample = {
      epoch: row.epoch,
      epochJD: row.epochJD,
      values: row.values,
      raw: row.raw,
    };
    if (row.values.length >= 6) {
      sample.positionKm = {
        x: row.values[0],
        y: row.values[1],
        z: row.values[2],
      };
      sample.velocityKmS = {
        x: row.values[3],
        y: row.values[4],
        z: row.values[5],
      };
    }
    samples.push(sample);
  }

  return {
    ...block,
    samples,
  };
}

function finalizeBlock(block) {
  if (block.type === "TRAJ") {
    return finalizeTrajectoryBlock(block);
  }
  return {
    ...block,
    samples: block.rows.map((row) => ({
      epoch: row.epoch,
      epochJD: row.epochJD,
      values: row.values,
      raw: row.raw,
    })),
  };
}

function assignBlock(target, block) {
  const finalized = finalizeBlock(block);
  switch (finalized.type) {
    case "META":
      target.metadata = finalized.fields;
      break;
    case "TRAJ":
      target.trajectories.push(finalized);
      break;
    case "PHYS":
      target.physical.push(finalized);
      break;
    case "COV":
      target.covariances.push(finalized);
      break;
    case "PERT":
      target.perturbations.push(finalized);
      break;
    case "OD":
      target.orbitDeterminations.push(finalized);
      break;
    case "USER_DEFINED":
      target.userDefined.push(finalized);
      break;
    default:
      target.otherBlocks.push(finalized);
      break;
  }
}

function getFirstFiniteNumber(values = []) {
  for (const value of values) {
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

export function isoToJulianDate(isoString) {
  const rawIso = String(isoString ?? "").trim();
  const normalizedIso =
    rawIso.length > 0 && !ISO_TIMEZONE_PATTERN.test(rawIso)
      ? `${rawIso}Z`
      : rawIso;
  const unixMillis = Date.parse(normalizedIso);
  if (!Number.isFinite(unixMillis)) {
    return Number.NaN;
  }
  return unixMillis / 86400000 + 2440587.5;
}

export function parseAerospaceOcmText(text, options = {}) {
  const sourcePath = options.sourcePath ?? null;
  const normalizedText = String(text ?? "").replace(/\r/g, "");
  const lines = normalizedText.split("\n");
  const result = {
    sourcePath,
    fileName: sourcePath ? path.basename(sourcePath) : null,
    header: {},
    metadata: {},
    trajectories: [],
    covariances: [],
    physical: [],
    perturbations: [],
    orbitDeterminations: [],
    userDefined: [],
    otherBlocks: [],
    warnings: [],
  };

  let activeBlock = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const startMatch = trimmed.match(BLOCK_START_PATTERN);
    if (startMatch) {
      if (activeBlock) {
        assignBlock(result, activeBlock);
      }
      activeBlock = createBlock(startMatch[1]);
      continue;
    }

    const stopMatch = trimmed.match(BLOCK_STOP_PATTERN);
    if (stopMatch) {
      if (activeBlock && activeBlock.type === stopMatch[1]) {
        assignBlock(result, activeBlock);
        activeBlock = null;
      }
      continue;
    }

    const keyValueMatch = line.match(/^([^=]+?)=(.*)$/);
    if (keyValueMatch) {
      const key = keyValueMatch[1].trim();
      const value = parseScalarValue(keyValueMatch[2]);
      if (activeBlock) {
        activeBlock.fields[key] = value;
      } else {
        result.header[key] = value;
      }
      continue;
    }

    const epochRow = parseEpochDataRow(line);
    if (epochRow && activeBlock) {
      activeBlock.rows.push(epochRow);
      continue;
    }

    if (activeBlock) {
      activeBlock.rawLines.push(trimmed);
    }
  }

  if (activeBlock) {
    assignBlock(result, activeBlock);
  }

  const metadata = result.metadata ?? {};
  const firstTrajectory = result.trajectories[0] ?? null;
  const firstOd = result.orbitDeterminations[0]?.fields ?? {};

  result.objectDesignator = String(metadata.OBJECT_DESIGNATOR ?? "").trim();
  result.objectName = String(metadata.OBJECT_NAME ?? "").trim();
  result.objectId = String(metadata.INTERNATIONAL_DESIGNATOR ?? "").trim();
  result.epochTzero = String(metadata.EPOCH_TZERO ?? "").trim() || null;
  result.epochTzeroJD = result.epochTzero
    ? isoToJulianDate(result.epochTzero)
    : Number.NaN;
  result.startTime = String(metadata.START_TIME ?? "").trim() || null;
  result.stopTime = String(metadata.STOP_TIME ?? "").trim() || null;
  result.screeningStartJD = result.startTime
    ? isoToJulianDate(result.startTime)
    : Number.NaN;
  result.screeningStopJD = result.stopTime ? isoToJulianDate(result.stopTime) : Number.NaN;
  result.usableStartTime =
    String(firstTrajectory?.fields?.USEABLE_START_TIME ?? "").trim() || null;
  result.usableStopTime =
    String(firstTrajectory?.fields?.USEABLE_STOP_TIME ?? "").trim() || null;
  result.usableStartJD = result.usableStartTime
    ? isoToJulianDate(result.usableStartTime)
    : Number.NaN;
  result.usableStopJD = result.usableStopTime
    ? isoToJulianDate(result.usableStopTime)
    : Number.NaN;
  result.odEpoch = String(firstOd.OD_EPOCH ?? "").trim() || null;
  result.odEpochJD = result.odEpoch ? isoToJulianDate(result.odEpoch) : Number.NaN;
  result.primaryTrajectory = firstTrajectory;
  result.primaryStateCount = firstTrajectory?.samples?.length ?? 0;
  result.referenceFrame =
    String(firstTrajectory?.fields?.TRAJ_REF_FRAME ?? "").trim() || null;
  result.trajType = String(firstTrajectory?.fields?.TRAJ_TYPE ?? "").trim() || null;
  result.primarySemiMajorAxisKm = getFirstFiniteNumber(
    firstOd.SEMI_MAJOR_AXIS ? toPlainArray(firstOd.SEMI_MAJOR_AXIS) : [],
  );

  return result;
}

export function extractEpochState(ocm, options = {}) {
  const trajectory = options.trajectory ?? ocm?.primaryTrajectory;
  const samples = Array.isArray(trajectory?.samples) ? trajectory.samples : [];
  if (samples.length === 0) {
    return null;
  }

  const targetEpochJD = Number.isFinite(options.targetEpochJD)
    ? options.targetEpochJD
    : Number.isFinite(ocm?.epochTzeroJD)
      ? ocm.epochTzeroJD
      : samples[0].epochJD;

  let bestSample = samples[0];
  let bestDelta = Math.abs(samples[0].epochJD - targetEpochJD);

  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index];
    const delta = Math.abs(sample.epochJD - targetEpochJD);
    if (delta < bestDelta) {
      bestSample = sample;
      bestDelta = delta;
    }
  }

  if (!bestSample.positionKm || !bestSample.velocityKmS) {
    return null;
  }

  return {
    epoch: bestSample.epoch,
    epochJD: bestSample.epochJD,
    positionKm: { ...bestSample.positionKm },
    velocityKmS: { ...bestSample.velocityKmS },
    objectDesignator: ocm?.objectDesignator ?? null,
    objectName: ocm?.objectName ?? null,
    sourcePath: ocm?.sourcePath ?? null,
  };
}

export function odAgeDaysFromScreeningStart(ocm) {
  if (!Number.isFinite(ocm?.odEpochJD)) {
    return Number.NaN;
  }
  const screeningStartJD = isoToJulianDate(AEROSPACE_SCREENING_WINDOW_START_ISO);
  return screeningStartJD - ocm.odEpochJD;
}

export function validateAerospaceOcm(ocm) {
  const issues = [];
  if (!ocm.objectDesignator) {
    issues.push("Missing OBJECT_DESIGNATOR.");
  }
  if (!ocm.primaryTrajectory) {
    issues.push("Missing TRAJ block.");
  }
  if (ocm.primaryStateCount <= 0) {
    issues.push("No TRAJ samples were parsed.");
  }
  if (!ocm.usableStartTime || !ocm.usableStopTime) {
    issues.push("Missing USEABLE_START_TIME/USEABLE_STOP_TIME.");
  }
  if (
    Number.isFinite(ocm.usableStartJD) &&
    Number.isFinite(ocm.usableStopJD) &&
    ocm.usableStartJD > ocm.usableStopJD
  ) {
    issues.push("Usable start time is after usable stop time.");
  }
  if (
    Number.isFinite(ocm.odEpochJD) &&
    odAgeDaysFromScreeningStart(ocm) > AEROSPACE_MAX_OD_AGE_DAYS
  ) {
    issues.push("OD_EPOCH is older than the 14-day Aerospace limit.");
  }
  return issues;
}
