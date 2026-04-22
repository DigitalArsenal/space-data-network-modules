import {
  isoToJulianDate,
  julianDateToIso,
  toJulianDateObject,
} from "./aerospaceOcm.mjs";

const NEIGHBOR_OFFSETS = [];
for (let x = -1; x <= 1; x++) {
  for (let y = -1; y <= 1; y++) {
    for (let z = -1; z <= 1; z++) {
      NEIGHBOR_OFFSETS.push([x, y, z]);
    }
  }
}

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function distanceSquaredMeters(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function relSpeedMetersPerSecond(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.hypot(dx, dy, dz);
}

function readBatchPositions(batchResult) {
  if (!batchResult?.ptr || !batchResult?.count || !batchResult?.module?.HEAPU8) {
    return new Float64Array(0);
  }
  return new Float64Array(
    batchResult.module.HEAPU8.buffer,
    batchResult.ptr,
    batchResult.count * 3,
  );
}

function getStateAtJd(propagator, entityIndex, julianDate) {
  return propagator.propagate(toJulianDateObject(julianDate), entityIndex, null);
}

function getDistanceState(propagator, entityIndexA, entityIndexB, julianDate) {
  const stateA = getStateAtJd(propagator, entityIndexA, julianDate);
  const stateB = getStateAtJd(propagator, entityIndexB, julianDate);
  if (!stateA?.valid || !stateB?.valid) {
    return null;
  }
  return {
    julianDate,
    stateA,
    stateB,
    distanceMeters: Math.sqrt(
      distanceSquaredMeters(stateA.position, stateB.position),
    ),
    relativeSpeedMetersPerSecond: relSpeedMetersPerSecond(
      stateA.velocity,
      stateB.velocity,
    ),
  };
}

function refineTca(propagator, entityIndexA, entityIndexB, leftJD, rightJD) {
  let left = leftJD;
  let right = rightJD;
  const phi = (Math.sqrt(5) - 1) / 2;

  let m1 = right - (right - left) * phi;
  let m2 = left + (right - left) * phi;
  let d1 = getDistanceState(propagator, entityIndexA, entityIndexB, m1);
  let d2 = getDistanceState(propagator, entityIndexA, entityIndexB, m2);

  for (let iteration = 0; iteration < 32; iteration++) {
    const v1 = d1?.distanceMeters ?? Number.POSITIVE_INFINITY;
    const v2 = d2?.distanceMeters ?? Number.POSITIVE_INFINITY;
    if (v1 <= v2) {
      right = m2;
      m2 = m1;
      d2 = d1;
      m1 = right - (right - left) * phi;
      d1 = getDistanceState(propagator, entityIndexA, entityIndexB, m1);
    } else {
      left = m1;
      m1 = m2;
      d1 = d2;
      m2 = left + (right - left) * phi;
      d2 = getDistanceState(propagator, entityIndexA, entityIndexB, m2);
    }
  }

  const midpoint = (left + right) * 0.5;
  return (
    getDistanceState(propagator, entityIndexA, entityIndexB, midpoint) ??
    d1 ??
    d2
  );
}

export async function runAllVsAllBenchmark(options = {}) {
  const propagator = options.propagator;
  const labels = Array.isArray(options.labels) ? options.labels : [];
  const entityCount =
    options.entityCount ?? propagator?.entityCount ?? labels.length ?? 0;
  const startJD =
    options.startJD ??
    isoToJulianDate(String(options.startIso ?? "2025-01-01T12:00:00Z"));
  const stopJD =
    options.stopJD ??
    isoToJulianDate(String(options.stopIso ?? "2025-01-08T12:00:00Z"));
  const stepSec = Number(options.stepSec ?? 60);
  const thresholdKm = Number(options.thresholdKm ?? 10);
  const thresholdMeters = thresholdKm * 1000.0;
  const captureMultiplier = Number(options.captureMultiplier ?? 4);
  const maxRelativeSpeedKms = Number(options.maxRelativeSpeedKms ?? 16);
  const captureDistanceMeters = Math.max(
    thresholdMeters * captureMultiplier,
    thresholdMeters + maxRelativeSpeedKms * 1000.0 * stepSec,
  );
  const cellSizeMeters = captureDistanceMeters;
  const fullScanThreshold = Number(options.fullScanThreshold ?? 64);
  const useFullScan = entityCount <= fullScanThreshold;
  const excludePair =
    typeof options.excludePair === "function" ? options.excludePair : () => false;
  const startedAt = Date.now();

  const candidates = new Map();
  const activeWindows = new Map();
  const finalizedCandidates = [];
  const stepDays = stepSec / 86400.0;
  let sampleCount = 0;
  let comparedPairs = 0;

  for (let jd = startJD; jd <= stopJD + stepDays * 0.5; jd += stepDays) {
    const batch = propagator.propagateAllPositions(jd);
    const positions = readBatchPositions(batch);
    const buckets = new Map();
    sampleCount++;

    if (useFullScan) {
      for (let entityIndexA = 0; entityIndexA < entityCount; entityIndexA++) {
        const offsetA = entityIndexA * 3;
        const ax = positions[offsetA];
        const ay = positions[offsetA + 1];
        const az = positions[offsetA + 2];
        if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) {
          continue;
        }

        for (
          let entityIndexB = entityIndexA + 1;
          entityIndexB < entityCount;
          entityIndexB++
        ) {
          if (excludePair(entityIndexA, entityIndexB)) {
            continue;
          }
          const offsetB = entityIndexB * 3;
          const bx = positions[offsetB];
          const by = positions[offsetB + 1];
          const bz = positions[offsetB + 2];
          if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)) {
            continue;
          }
          const distanceMeters = Math.hypot(ax - bx, ay - by, az - bz);
          comparedPairs++;
          const key = pairKey(entityIndexA, entityIndexB);
          const activeWindow = activeWindows.get(key);
          if (distanceMeters > captureDistanceMeters) {
            if (activeWindow) {
              finalizedCandidates.push(activeWindow);
              activeWindows.delete(key);
            }
            continue;
          }
          if (
            !activeWindow ||
            distanceMeters < activeWindow.minSampleDistanceMeters
          ) {
            activeWindows.set(key, {
              entityIndexA,
              entityIndexB,
              minSampleDistanceMeters: distanceMeters,
              sampleJD: jd,
            });
          }
        }
      }
      continue;
    }

    for (let entityIndex = 0; entityIndex < entityCount; entityIndex++) {
      const offset = entityIndex * 3;
      const x = positions[offset];
      const y = positions[offset + 1];
      const z = positions[offset + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        continue;
      }

      const cx = Math.floor(x / cellSizeMeters);
      const cy = Math.floor(y / cellSizeMeters);
      const cz = Math.floor(z / cellSizeMeters);

      for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
        const neighborKey = `${cx + dx},${cy + dy},${cz + dz}`;
        const neighborEntries = buckets.get(neighborKey);
        if (!neighborEntries) {
          continue;
        }
        for (const otherIndex of neighborEntries) {
          if (excludePair(entityIndex, otherIndex)) {
            continue;
          }
          const otherOffset = otherIndex * 3;
          const distanceMeters = Math.hypot(
            x - positions[otherOffset],
            y - positions[otherOffset + 1],
            z - positions[otherOffset + 2],
          );
          comparedPairs++;
          if (distanceMeters > captureDistanceMeters) {
            continue;
          }
          const key = pairKey(entityIndex, otherIndex);
          const current = candidates.get(key);
          if (!current || distanceMeters < current.minSampleDistanceMeters) {
            candidates.set(key, {
              entityIndexA: Math.min(entityIndex, otherIndex),
              entityIndexB: Math.max(entityIndex, otherIndex),
              minSampleDistanceMeters: distanceMeters,
              sampleJD: jd,
            });
          }
        }
      }

      const bucketKey = `${cx},${cy},${cz}`;
      const bucket = buckets.get(bucketKey);
      if (bucket) {
        bucket.push(entityIndex);
      } else {
        buckets.set(bucketKey, [entityIndex]);
      }
    }
  }

  for (const activeWindow of activeWindows.values()) {
    finalizedCandidates.push(activeWindow);
  }

  const refinementCandidates = useFullScan
    ? finalizedCandidates
    : Array.from(candidates.values());
  const refinedEvents = [];
  for (const candidate of refinementCandidates) {
    const leftJD = Math.max(startJD, candidate.sampleJD - stepDays);
    const rightJD = Math.min(stopJD, candidate.sampleJD + stepDays);
    const refined = refineTca(
      propagator,
      candidate.entityIndexA,
      candidate.entityIndexB,
      leftJD,
      rightJD,
    );
    if (!refined || refined.distanceMeters > thresholdMeters) {
      continue;
    }

    const labelA = labels[candidate.entityIndexA] ?? {};
    const labelB = labels[candidate.entityIndexB] ?? {};
    refinedEvents.push({
      entityIndexA: candidate.entityIndexA,
      entityIndexB: candidate.entityIndexB,
      idA: labelA.id ?? candidate.entityIndexA,
      idB: labelB.id ?? candidate.entityIndexB,
      nameA: labelA.name ?? null,
      nameB: labelB.name ?? null,
      designatorA: labelA.designator ?? null,
      designatorB: labelB.designator ?? null,
      tcaJD: refined.julianDate,
      tcaIso: julianDateToIso(refined.julianDate),
      minRangeKm: refined.distanceMeters / 1000.0,
      relSpeedKms: refined.relativeSpeedMetersPerSecond / 1000.0,
    });
  }

  refinedEvents.sort((left, right) => left.tcaJD - right.tcaJD);

  return {
    startIso: julianDateToIso(startJD),
    stopIso: julianDateToIso(stopJD),
    stepSec,
    thresholdKm,
    captureMultiplier,
    maxRelativeSpeedKms,
    useFullScan,
    sampleCount,
    comparedPairs,
    candidatePairs: refinementCandidates.length,
    events: refinedEvents,
    elapsedMs: Date.now() - startedAt,
  };
}

export function loadReferenceEventsFromSocrates(referenceJson) {
  const conjunctions = Array.isArray(referenceJson?.conjunctions)
    ? referenceJson.conjunctions
    : [];
  return conjunctions.map((entry) => ({
    idA: Number(entry.obj1_norad),
    idB: Number(entry.obj2_norad),
    tcaJD: isoToJulianDate(entry.tca),
    tcaIso: entry.tca,
    minRangeKm: Number(entry.min_range_km),
  }));
}

export function scoreEventsAgainstReference(foundEvents = [], referenceEvents = []) {
  const usedFound = new Set();
  const matches = [];
  const missing = [];

  for (const reference of referenceEvents) {
    let bestIndex = -1;
    let bestDeltaSec = Number.POSITIVE_INFINITY;
    for (let index = 0; index < foundEvents.length; index++) {
      if (usedFound.has(index)) {
        continue;
      }
      const found = foundEvents[index];
      const idsMatch =
        pairKey(reference.idA, reference.idB) === pairKey(found.idA, found.idB);
      if (!idsMatch) {
        continue;
      }
      const deltaSec = Math.abs(reference.tcaJD - found.tcaJD) * 86400.0;
      if (deltaSec < bestDeltaSec) {
        bestDeltaSec = deltaSec;
        bestIndex = index;
      }
    }
    if (bestIndex === -1) {
      missing.push(reference);
      continue;
    }
    usedFound.add(bestIndex);
    matches.push({
      reference,
      found: foundEvents[bestIndex],
      tcaDeltaSec: bestDeltaSec,
      rangeDeltaKm:
        foundEvents[bestIndex].minRangeKm - Number(reference.minRangeKm ?? 0),
    });
  }

  const extras = foundEvents.filter((_, index) => !usedFound.has(index));
  const tcaDeltaSeconds = matches.map((match) => match.tcaDeltaSec).sort((a, b) => a - b);
  const percentile = (p) => {
    if (tcaDeltaSeconds.length === 0) {
      return null;
    }
    const idx = Math.min(
      tcaDeltaSeconds.length - 1,
      Math.floor(p * (tcaDeltaSeconds.length - 1)),
    );
    return tcaDeltaSeconds[idx];
  };

  return {
    referenceCount: referenceEvents.length,
    foundCount: foundEvents.length,
    matchedCount: matches.length,
    missingCount: missing.length,
    extraCount: extras.length,
    tcaDeltaSecP50: percentile(0.5),
    tcaDeltaSecP95: percentile(0.95),
    tcaDeltaSecMax: percentile(1.0),
    matches,
    missing,
    extras,
  };
}
