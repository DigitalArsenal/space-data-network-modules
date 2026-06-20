import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import {
  createStandaloneHarness,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const WORKER_PATH = new URL("./sensor-coverage-benchmark-worker.mjs", import.meta.url);

function resolveStandardsRoot() {
  const candidates = [
    process.env.SPACE_DATA_STANDARDS_ROOT,
    new URL("../../../../spacedatastandards.org", import.meta.url).pathname,
    new URL("../node_modules/spacedatastandards.org", import.meta.url).pathname,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(`${candidate}/lib/js/SCV/main.js`)) {
      return candidate;
    }
  }
  throw new Error("Unable to resolve SDS SCV JavaScript bindings.");
}

const STANDARDS_ROOT = resolveStandardsRoot();
const flatbuffers = await import(
  pathToFileURL(`${STANDARDS_ROOT}/node_modules/flatbuffers/mjs/flatbuffers.js`).href,
);
const {
  SCV,
  SCVCoverageGridT,
  SCVCoverageRequestT,
  SCVEllipsoidT,
  SCVSensorT,
  SCVStateSampleT,
  SCVTimeGridT,
  SCVT,
  SCVVec3T,
  scvAnalysisMode,
  scvBodyKind,
  scvCoordinateFrame,
  scvEnvelopeKind,
  scvGeometryDomain,
  scvMetricSeriesKind,
  scvSensorShapeKind,
} = await import(pathToFileURL(`${STANDARDS_ROOT}/lib/js/SCV/main.js`).href);

export const SCV_COVERAGE_REQUEST_TYPE = Object.freeze({
  schemaName: "SCV/main.fbs",
  fileIdentifier: "$SCV",
  rootTypeName: "SCV",
});

export const BENCHMARK_THRESHOLDS = Object.freeze({
  warmVisualScrubP95Ms: 100,
  coldPriorityPreviewP95Ms: 500,
  priorityFomP95Ms: 500,
  requiresNoRenderTickCoverageCompute: true,
  requiresNoJsCoverageMath: true,
});

export const CANONICAL_SCENARIOS = Object.freeze([
  Object.freeze({
    name: "100-sat",
    satelliteCount: 100,
    durationSeconds: 86400,
    priorityWindowSeconds: 60,
    backfillWindowSeconds: 300,
    stateStepSeconds: 5,
    altitudeMeters: 500000,
    inclinationScale: 0.12,
    halfAngleRad: (12.5 * Math.PI) / 180,
    radiusMeters: 1600000,
    angularSamples: 8,
  }),
  Object.freeze({
    name: "1000-sat",
    satelliteCount: 1000,
    durationSeconds: 86400,
    priorityWindowSeconds: 60,
    backfillWindowSeconds: 300,
    stateStepSeconds: 5,
    altitudeMeters: 500000,
    inclinationScale: 0.12,
    halfAngleRad: (12.5 * Math.PI) / 180,
    radiusMeters: 1600000,
    angularSamples: 8,
  }),
  Object.freeze({
    name: "5000-sat",
    satelliteCount: 5000,
    durationSeconds: 86400,
    priorityWindowSeconds: 60,
    backfillWindowSeconds: 300,
    stateStepSeconds: 10,
    altitudeMeters: 500000,
    inclinationScale: 0.12,
    halfAngleRad: (12.5 * Math.PI) / 180,
    radiusMeters: 1600000,
    angularSamples: 8,
  }),
]);

export const CANONICAL_GRID_SIZES = Object.freeze([
  Object.freeze({
    name: "coarse",
    minLatitudeDeg: -90,
    maxLatitudeDeg: 90,
    minLongitudeDeg: -180,
    maxLongitudeDeg: 180,
    latitudeStepDeg: 10,
    longitudeStepDeg: 10,
  }),
  Object.freeze({
    name: "operational",
    minLatitudeDeg: -90,
    maxLatitudeDeg: 90,
    minLongitudeDeg: -180,
    maxLongitudeDeg: 180,
    latitudeStepDeg: 5,
    longitudeStepDeg: 5,
  }),
  Object.freeze({
    name: "dense",
    minLatitudeDeg: -90,
    maxLatitudeDeg: 90,
    minLongitudeDeg: -180,
    maxLongitudeDeg: 180,
    latitudeStepDeg: 2,
    longitudeStepDeg: 2,
  }),
]);

const BENCHMARK_MODES = Object.freeze([
  "priority-fom",
  "visual-preview",
  "full-day-backfill",
]);
const REQUEST_FORMATS = Object.freeze(["scv"]);

const MIN_BACKFILL_WORKER_COUNT = 1;
const MAX_BACKFILL_WORKER_COUNT = 8;

function gridCellCount(grid) {
  return Math.ceil((grid.maxLatitudeDeg - grid.minLatitudeDeg) / grid.latitudeStepDeg) *
    Math.ceil((grid.maxLongitudeDeg - grid.minLongitudeDeg) / grid.longitudeStepDeg);
}

function scenarioByName(name) {
  const scenario = CANONICAL_SCENARIOS.find((entry) => entry.name === name);
  if (!scenario) {
    throw new Error(`Unknown scenario '${name}'. Expected one of ${CANONICAL_SCENARIOS.map((entry) => entry.name).join(", ")}.`);
  }
  return scenario;
}

function gridByName(name) {
  const grid = CANONICAL_GRID_SIZES.find((entry) => entry.name === name);
  if (!grid) {
    throw new Error(`Unknown grid '${name}'. Expected one of ${CANONICAL_GRID_SIZES.map((entry) => entry.name).join(", ")}.`);
  }
  return grid;
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function roundMetric(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 1000) / 1000
    : value;
}

function defaultBackfillWorkerCount() {
  const availableParallelism =
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length;
  return Math.min(
    MAX_BACKFILL_WORKER_COUNT,
    Math.max(
      MIN_BACKFILL_WORKER_COUNT,
      Math.floor(availableParallelism / 4),
    ),
  );
}

function resolveBackfillWorkerCount(value) {
  if (value === null || value === undefined) {
    return defaultBackfillWorkerCount();
  }
  if (!Number.isInteger(value) || value < MIN_BACKFILL_WORKER_COUNT) {
    throw new Error("--backfill-workers must be a positive integer");
  }
  return Math.min(MAX_BACKFILL_WORKER_COUNT, value);
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rssMB: roundMetric(usage.rss / (1024 * 1024)),
    heapUsedMB: roundMetric(usage.heapUsed / (1024 * 1024)),
    externalMB: roundMetric(usage.external / (1024 * 1024)),
  };
}

function standaloneTelemetrySnapshot(runtimeKind) {
  return {
    workerUtilization: {
      status: "not-measured",
      reason:
        `The ${runtimeKind} standalone module benchmark invokes the SDK harness directly; ` +
        "capture OrbPro Sandcastle browser-worker telemetry for worker utilization.",
    },
    renderFps: {
      status: "not-measured",
      reason:
        "The standalone module benchmark has no OrbPro render loop; " +
        "capture local Sandcastle playback telemetry for render FPS.",
    },
  };
}

export function createBenchmarkReportSkeleton({
  runtimeKind = "browser",
  scenarioNames = ["100-sat"],
  gridNames = ["coarse"],
  repeatCount = 1,
  mode = "priority-fom",
  requestFormat = "scv",
  windowStartSeconds = 0,
  windowSeconds = null,
  backfillWorkerCount = null,
} = {}) {
  if (!BENCHMARK_MODES.includes(mode)) {
    throw new Error(`Unknown benchmark mode '${mode}'. Expected one of ${BENCHMARK_MODES.join(", ")}.`);
  }
  if (!REQUEST_FORMATS.includes(requestFormat)) {
    throw new Error(`Unknown request format '${requestFormat}'. Expected one of ${REQUEST_FORMATS.join(", ")}.`);
  }
  const requests = [];
  for (const scenarioName of scenarioNames) {
    const scenario = scenarioByName(scenarioName);
    for (const gridName of gridNames) {
      const grid = gridByName(gridName);
      const effectiveWindowSeconds =
        windowSeconds ??
        (mode === "visual-preview"
          ? scenario.stateStepSeconds
          : mode === "full-day-backfill"
            ? scenario.backfillWindowSeconds
          : scenario.priorityWindowSeconds);
      requests.push({
        scenario,
        requestFormat,
        grid: {
          ...grid,
          cellCount: gridCellCount(grid),
        },
        mode,
        repeatCount,
        windowSeconds: effectiveWindowSeconds,
        windowStartSeconds,
        backfillWorkerCount:
          mode === "full-day-backfill"
            ? resolveBackfillWorkerCount(backfillWorkerCount)
            : 1,
        windowStopSeconds: mode === "full-day-backfill"
          ? scenario.durationSeconds
          : Math.min(windowStartSeconds + effectiveWindowSeconds, scenario.durationSeconds),
      });
    }
  }

  return {
    benchmarkId: "sensor-coverage-stk-class",
    generatedAt: new Date().toISOString(),
    runtimeKind,
    requestFormat,
    thresholds: BENCHMARK_THRESHOLDS,
    requests,
    results: [],
    summary: null,
    stkComparison: {
      status: "pending",
      reason: "No STK benchmark report was supplied. Pass --stk-report=<path> for apples-to-apples comparison.",
    },
  };
}

function createState(scenario, sensorIndex, elapsedSeconds) {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + scenario.altitudeMeters;
  const speed = 7612.608173223869;
  const meanMotion = speed / orbitRadius;
  const phase = (2 * Math.PI * sensorIndex) / scenario.satelliteCount;
  const ringIndex = Math.floor(sensorIndex / 25);
  const theta = -0.22 + phase + meanMotion * elapsedSeconds;
  const zTheta = theta * 0.7 + ringIndex * ((2 * Math.PI) / 40);
  return {
    elapsedSeconds,
    position: {
      x: orbitRadius * Math.cos(theta),
      y: orbitRadius * Math.sin(theta),
      z: orbitRadius * scenario.inclinationScale * Math.sin(zTheta),
    },
    velocity: {
      x: -speed * Math.sin(theta),
      y: speed * Math.cos(theta),
      z: speed * scenario.inclinationScale * 0.7 * Math.cos(zTheta),
    },
  };
}

function createSensorTrack(scenario, sensorIndex, startSeconds, stopSeconds) {
  const states = [];
  for (
    let elapsedSeconds = startSeconds;
    elapsedSeconds < stopSeconds;
    elapsedSeconds += scenario.stateStepSeconds
  ) {
    states.push(createState(scenario, sensorIndex, elapsedSeconds));
  }
  states.push(createState(scenario, sensorIndex, stopSeconds));
  return {
    sensorId: sensorIndex,
    type: "conic",
    outerHalfAngleRad: scenario.halfAngleRad,
    radiusMeters: scenario.radiusMeters,
    angularSamples: scenario.angularSamples,
    states,
  };
}

export function createCoverageBenchmarkRequest({
  scenario,
  grid,
  mode = "priority-fom",
  startSeconds = 0,
  stopSeconds = scenario.priorityWindowSeconds,
}) {
  const visualOnly = mode === "visual-preview";
  const sensors = Array.from(
    { length: scenario.satelliteCount },
    (_, sensorIndex) =>
      createSensorTrack(scenario, sensorIndex, startSeconds, stopSeconds),
  );
  return {
    coverageSource: {
      brand: "OrbPro",
      mode: `sensor coverage ${mode} benchmark`,
      benchmarkId: "sensor-coverage-stk-class",
      requestedSensorCount: scenario.satelliteCount,
      gridName: grid.name,
      windowStartSeconds: startSeconds,
      windowStopSeconds: stopSeconds,
    },
    sensors,
    grid: {
      minLatitudeDeg: grid.minLatitudeDeg,
      maxLatitudeDeg: grid.maxLatitudeDeg,
      minLongitudeDeg: grid.minLongitudeDeg,
      maxLongitudeDeg: grid.maxLongitudeDeg,
      latitudeStepDeg: grid.latitudeStepDeg,
      longitudeStepDeg: grid.longitudeStepDeg,
    },
    timeSpan: {
      startSeconds,
      stopSeconds,
    },
    figureOfMerit: visualOnly ? "none" : "percent_coverage",
    outputMode: visualOnly ? "swath_only" : "analytics_only",
  };
}

export function createScvCoverageBenchmarkPayload({
  scenario,
  grid,
  mode = "priority-fom",
  startSeconds = 0,
  stopSeconds = scenario.priorityWindowSeconds,
}) {
  const visualOnly = mode === "visual-preview";
  const sensors = [];
  const stateSamples = [];
  const halfAngleDeg = scenario.halfAngleRad * (180 / Math.PI);
  for (let sensorIndex = 0; sensorIndex < scenario.satelliteCount; sensorIndex += 1) {
    sensors.push(
      new SCVSensorT(
        sensorIndex,
        `benchmark-sensor-${sensorIndex}`,
        `Benchmark sensor ${sensorIndex}`,
        scvSensorShapeKind.CONIC,
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        halfAngleDeg,
        0,
        0,
        0,
        scenario.radiusMeters,
      ),
    );
    const track = createSensorTrack(
      scenario,
      sensorIndex,
      startSeconds,
      stopSeconds,
    );
    for (const state of track.states) {
      stateSamples.push(
        new SCVStateSampleT(
          sensorIndex,
          state.elapsedSeconds,
          new SCVVec3T(
            state.position.x,
            state.position.y,
            state.position.z,
          ),
          new SCVVec3T(
            state.velocity.x,
            state.velocity.y,
            state.velocity.z,
          ),
          0,
          0,
          0,
          1,
          scvCoordinateFrame.BODY_FIXED,
        ),
      );
    }
  }

  const rows = Math.ceil((grid.maxLatitudeDeg - grid.minLatitudeDeg) / grid.latitudeStepDeg);
  const request = new SCVCoverageRequestT(
    `sensor-coverage-${mode}-benchmark`,
    BigInt("0"),
    visualOnly ? scvAnalysisMode.SWATH : scvAnalysisMode.COVERAGE,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      6378137.0,
      6356752.3142451793,
      6378137.0,
      scvCoordinateFrame.BODY_FIXED,
    ),
    new SCVTimeGridT(
      null,
      0,
      startSeconds,
      stopSeconds,
      scenario.stateStepSeconds,
      0,
      Math.max(1, Math.ceil((stopSeconds - startSeconds) / scenario.stateStepSeconds)),
    ),
    new SCVCoverageGridT(
      grid.name ?? "benchmark-grid",
      scvGeometryDomain.SURFACE,
      scvCoordinateFrame.BODY_FIXED,
      grid.minLatitudeDeg,
      grid.maxLatitudeDeg,
      grid.minLongitudeDeg,
      grid.maxLongitudeDeg,
      grid.latitudeStepDeg,
      grid.longitudeStepDeg,
      0,
      grid.cellCount ?? gridCellCount(grid),
      rows,
    ),
    sensors,
    stateSamples,
    [],
    [],
    visualOnly ? [] : [scvMetricSeriesKind.PERCENT_COVERED],
    0,
    0,
    0,
    0,
    undefined,
    visualOnly,
  );
  const envelope = new SCVT(scvEnvelopeKind.REQUEST, request);
  const builder = new flatbuffers.Builder(1024);
  SCV.finishSCVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

export function createBackfillWindows(requestEntry) {
  const scenario = requestEntry.scenario;
  if (requestEntry.mode !== "full-day-backfill") {
    return [
      {
        startSeconds: requestEntry.windowStartSeconds,
        stopSeconds: requestEntry.windowStopSeconds,
      },
    ];
  }
  const windows = [];
  const windowSeconds = requestEntry.windowSeconds ?? scenario.priorityWindowSeconds;
  for (
    let startSeconds = requestEntry.windowStartSeconds;
    startSeconds < requestEntry.windowStopSeconds;
    startSeconds += windowSeconds
  ) {
    windows.push({
      startSeconds,
      stopSeconds: Math.min(startSeconds + windowSeconds, requestEntry.windowStopSeconds),
    });
  }
  return windows;
}

function createBenchmarkTasks(requestEntry) {
  const windows = createBackfillWindows(requestEntry);
  const tasks = [];
  for (let repeatIndex = 0; repeatIndex < requestEntry.repeatCount; repeatIndex += 1) {
    for (const window of windows) {
      tasks.push({
        index: tasks.length,
        window,
      });
    }
  }
  return { windows, tasks };
}

export function outputSummaryForResult(result) {
  return {
    activeSensorCount: result.statistics?.activeSensorCount ?? null,
    swathCount: result.swaths?.length ?? 0,
    accessedCells: result.statistics?.accessedCells ?? null,
    coverageIntervalCount: result.coverageIntervals?.length ?? 0,
    figureOfMeritType: result.figureOfMerit?.type ?? null,
  };
}

export function outputSummaryForScvResult(result) {
  let accessedCells = 0;
  for (let index = 0; index < result.cellStatsLength(); index += 1) {
    const cell = result.CELL_STATS(index);
    if (cell?.COVERAGE_FRACTION() > 0) {
      accessedCells += 1;
    }
  }
  const geometry = result.GEOMETRY();
  return {
    activeSensorCount: result.TOTAL_SENSORS(),
    swathCount: geometry?.segmentsLength?.() ?? 0,
    accessedCells,
    coverageIntervalCount: result.intervalsLength(),
    figureOfMeritType:
      result.cellStatsLength() > 0 ? "percent_coverage" : "none",
  };
}

function findScvResultEnvelope(response) {
  if (response.statusCode !== 0) {
    throw new Error(response.errorMessage || response.errorCode || "SCV benchmark invoke failed");
  }
  if (response.outputs.some((frame) => frame.typeRef?.fileIdentifier === "JSON")) {
    throw new Error("SCV benchmark request emitted JSON compatibility output");
  }
  for (const frame of response.outputs) {
    if (frame.typeRef?.fileIdentifier !== "$SCV") {
      continue;
    }
    const byteBuffer = new flatbuffers.ByteBuffer(frame.payload);
    if (!SCV.bufferHasIdentifier(byteBuffer)) {
      continue;
    }
    const envelope = SCV.getRootAsSCV(byteBuffer);
    if (envelope.ENVELOPE_KIND() === scvEnvelopeKind.RESULT) {
      return envelope;
    }
  }
  throw new Error("SCV benchmark invoke did not emit a result frame");
}

export async function invokeCoverageBenchmarkRequest(
  harness,
  {
    scenario,
    grid,
    mode = "priority-fom",
    requestFormat = "scv",
    startSeconds = 0,
    stopSeconds = scenario.priorityWindowSeconds,
  },
) {
  const effectiveMode = mode === "full-day-backfill" ? "priority-fom" : mode;
  if (requestFormat === "scv") {
    const payload = createScvCoverageBenchmarkPayload({
      scenario,
      grid,
      mode: effectiveMode,
      startSeconds,
      stopSeconds,
    });
    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: SCV_COVERAGE_REQUEST_TYPE,
          payload,
        },
      ],
    });
    const result = findScvResultEnvelope(response).RESULT();
    if (!result) {
      throw new Error("SCV benchmark result envelope did not contain RESULT payload");
    }
    return outputSummaryForScvResult(result);
  }
  throw new Error(`Unknown request format '${requestFormat}'. Expected one of ${REQUEST_FORMATS.join(", ")}.`);
}

export async function runRequestBenchmark(
  harnessOrPool,
  requestEntry,
  { invoke = null } = {},
) {
  const harnessPool = Array.isArray(harnessOrPool)
    ? harnessOrPool
    : [harnessOrPool];
  const parallelWorkerCount =
    requestEntry.mode === "full-day-backfill"
      ? Math.min(requestEntry.backfillWorkerCount ?? 1, harnessPool.length)
      : 1;
  const activeHarnesses = harnessPool.slice(0, Math.max(1, parallelWorkerCount));
  const durations = [];
  const outputSummaries = [];
  const { windows, tasks } = createBenchmarkTasks(requestEntry);
  const startedAt = performance.now();
  let nextTaskIndex = 0;

  await Promise.all(
    activeHarnesses.map(async (harness) => {
      while (nextTaskIndex < tasks.length) {
        const task = tasks[nextTaskIndex];
        nextTaskIndex += 1;
        const { window } = task;
        const before = performance.now();
        let outputSummary;
        if (invoke) {
          const payload = createScvCoverageBenchmarkPayload({
            scenario: requestEntry.scenario,
            grid: requestEntry.grid,
            mode:
              requestEntry.mode === "full-day-backfill"
                ? "priority-fom"
                : requestEntry.mode,
            startSeconds: window.startSeconds,
            stopSeconds: window.stopSeconds,
          });
          const result = await invoke(harness, {
            methodId: "compute_sensor_coverage",
            inputs: [
              {
                portId: "coverage",
                typeRef: SCV_COVERAGE_REQUEST_TYPE,
                payload,
              },
            ],
          });
          outputSummary = outputSummaryForResult(result);
        } else {
          outputSummary = await invokeCoverageBenchmarkRequest(harness, {
            scenario: requestEntry.scenario,
            grid: requestEntry.grid,
            mode: requestEntry.mode,
            requestFormat: requestEntry.requestFormat ?? "scv",
            startSeconds: window.startSeconds,
            stopSeconds: window.stopSeconds,
          });
        }
        durations[task.index] = performance.now() - before;
        outputSummaries[task.index] = outputSummary;
      }
    }),
  );

  const warmDurations = durations.slice(1);
  return {
    scenarioName: requestEntry.scenario.name,
    satelliteCount: requestEntry.scenario.satelliteCount,
    gridName: requestEntry.grid.name,
    gridCellCount: requestEntry.grid.cellCount,
    mode: requestEntry.mode,
    requestFormat: requestEntry.requestFormat ?? "scv",
    repeatCount: requestEntry.repeatCount,
    windowCount: windows.length,
    parallelWorkerCount: activeHarnesses.length,
    parallelExecution: "direct_harness",
    totalInvokeCount: durations.length,
    elapsedTotalMs: roundMetric(performance.now() - startedAt),
    invokeMs: durations.map(roundMetric),
    invokeColdStartMs: durations.length > 0 ? roundMetric(durations[0]) : null,
    invokeWarmMs: warmDurations.map(roundMetric),
    invokeP50Ms: roundMetric(percentile(durations, 50)),
    invokeP95Ms: roundMetric(percentile(durations, 95)),
    invokeWarmP95Ms: roundMetric(percentile(warmDurations, 95)),
    invokeMaxMs: roundMetric(Math.max(...durations)),
    memory: memorySnapshot(),
    telemetry: standaloneTelemetrySnapshot(
      activeHarnesses[0]?.runtimeKind ?? "browser",
    ),
    output: outputSummaries.at(-1) ?? null,
  };
}

function createWorkerTaskGroups(tasks, workerCount) {
  const groups = Array.from({ length: workerCount }, () => []);
  for (let index = 0; index < tasks.length; index += 1) {
    groups[index % workerCount].push(tasks[index]);
  }
  return groups.filter((group) => group.length > 0);
}

function runBenchmarkWorker({ runtimeKind, requestEntry, tasks }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        runtimeKind,
        requestEntry,
        tasks,
      },
    });
    let settled = false;
    worker.once("message", (message) => {
      settled = true;
      if (message?.error) {
        const error = new Error(message.error.message);
        error.stack = message.error.stack;
        reject(error);
        return;
      }
      resolve(message.results ?? []);
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`Sensor coverage benchmark worker exited with code ${code}`));
      }
    });
  });
}

export async function runRequestBenchmarkInWorkerThreads(
  requestEntry,
  { runtimeKind = "browser" } = {},
) {
  const { windows, tasks } = createBenchmarkTasks(requestEntry);
  const workerCount = Math.max(
    1,
    Math.min(requestEntry.backfillWorkerCount ?? 1, tasks.length),
  );
  const taskGroups = createWorkerTaskGroups(tasks, workerCount);
  const startedAt = performance.now();
  const workerResults = await Promise.all(
    taskGroups.map((workerTasks) =>
      runBenchmarkWorker({
        runtimeKind,
        requestEntry,
        tasks: workerTasks,
      }),
    ),
  );
  const durations = [];
  const outputSummaries = [];
  for (const result of workerResults.flat()) {
    durations[result.index] = result.durationMs;
    outputSummaries[result.index] = result.outputSummary;
  }

  const warmDurations = durations.slice(1);
  return {
    scenarioName: requestEntry.scenario.name,
    satelliteCount: requestEntry.scenario.satelliteCount,
    gridName: requestEntry.grid.name,
    gridCellCount: requestEntry.grid.cellCount,
    mode: requestEntry.mode,
    requestFormat: requestEntry.requestFormat ?? "scv",
    repeatCount: requestEntry.repeatCount,
    windowCount: windows.length,
    parallelWorkerCount: taskGroups.length,
    parallelExecution: "worker_threads",
    totalInvokeCount: durations.length,
    elapsedTotalMs: roundMetric(performance.now() - startedAt),
    invokeMs: durations.map(roundMetric),
    invokeColdStartMs: durations.length > 0 ? roundMetric(durations[0]) : null,
    invokeWarmMs: warmDurations.map(roundMetric),
    invokeP50Ms: roundMetric(percentile(durations, 50)),
    invokeP95Ms: roundMetric(percentile(durations, 95)),
    invokeWarmP95Ms: roundMetric(percentile(warmDurations, 95)),
    invokeMaxMs: roundMetric(Math.max(...durations)),
    memory: memorySnapshot(),
    telemetry: standaloneTelemetrySnapshot(runtimeKind),
    output: outputSummaries.at(-1) ?? null,
  };
}

function comparableResultKey(result) {
  return [
    result.scenarioName ?? result.scenario?.name ?? "",
    result.gridName ?? result.grid?.name ?? "",
    result.mode ?? "",
  ].join("\u0000");
}

function elapsedTotalMs(result) {
  const value =
    result.elapsedTotalMs ??
    result.totalElapsedMs ??
    result.elapsedMs ??
    result.durationMs;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function evaluateStkComparison(stkReport, report) {
  const stkResults = Array.isArray(stkReport?.results) ? stkReport.results : [];
  const stkResultsByKey = new Map(
    stkResults.map((result) => [comparableResultKey(result), result]),
  );
  const matchedResults = [];
  for (const orbproResult of report.results ?? []) {
    const key = comparableResultKey(orbproResult);
    const stkResult = stkResultsByKey.get(key);
    const orbproElapsedTotalMs = elapsedTotalMs(orbproResult);
    const stkElapsedTotalMs = elapsedTotalMs(stkResult ?? {});
    if (!stkResult || orbproElapsedTotalMs === null || stkElapsedTotalMs === null) {
      continue;
    }
    matchedResults.push({
      scenarioName: orbproResult.scenarioName,
      gridName: orbproResult.gridName,
      mode: orbproResult.mode,
      orbproElapsedTotalMs: roundMetric(orbproElapsedTotalMs),
      stkElapsedTotalMs: roundMetric(stkElapsedTotalMs),
      speedup: roundMetric(stkElapsedTotalMs / orbproElapsedTotalMs),
      orbproFaster: orbproElapsedTotalMs < stkElapsedTotalMs,
    });
  }

  if (matchedResults.length === 0) {
    return {
      status: "provided",
      reason:
        "STK report was supplied, but no results matched by scenarioName, gridName, and mode with numeric elapsedTotalMs.",
      matchedResults,
    };
  }
  const failedResults = matchedResults.filter((result) => !result.orbproFaster);
  return {
    status: failedResults.length === 0 ? "passed" : "failed",
    matchedResults,
    failedResults,
  };
}

export function loadStkComparison(stkReportPath, report) {
  if (!stkReportPath) {
    return;
  }
  const stkReport = JSON.parse(fs.readFileSync(stkReportPath, "utf8"));
  const comparison = evaluateStkComparison(stkReport, report);
  report.stkComparison = {
    ...comparison,
    reportPath: stkReportPath,
    report: stkReport,
  };
}

function assertReportThresholds(report) {
  const failures = [];
  for (const result of report.results) {
    if (
      result.mode === "priority-fom" &&
      result.invokeP95Ms > report.thresholds.priorityFomP95Ms
    ) {
      failures.push(
        `${result.scenarioName}/${result.gridName} priority FOM p95 ${result.invokeP95Ms} ms exceeds ${report.thresholds.priorityFomP95Ms} ms`,
      );
    }
    if (
      result.mode === "visual-preview" &&
      result.invokeP95Ms > report.thresholds.coldPriorityPreviewP95Ms
    ) {
      failures.push(
        `${result.scenarioName}/${result.gridName} visual preview p95 ${result.invokeP95Ms} ms exceeds ${report.thresholds.coldPriorityPreviewP95Ms} ms`,
      );
    }
    if (
      result.mode === "visual-preview" &&
      result.invokeWarmP95Ms !== null &&
      result.invokeWarmP95Ms > report.thresholds.warmVisualScrubP95Ms
    ) {
      failures.push(
        `${result.scenarioName}/${result.gridName} warm visual p95 ${result.invokeWarmP95Ms} ms exceeds ${report.thresholds.warmVisualScrubP95Ms} ms`,
      );
    }
  }
  if (failures.length > 0) {
    const error = new Error(`Sensor coverage benchmark threshold failure:\n${failures.join("\n")}`);
    error.failures = failures;
    throw error;
  }
}

export async function runBenchmark(options = {}) {
  const report = createBenchmarkReportSkeleton(options);
  if (options.dryRun) {
    loadStkComparison(options.stkReportPath, report);
    return report;
  }

  const harnessPool = [];
  async function ensureHarnessPool(count) {
    while (harnessPool.length < count) {
      harnessPool.push(
        await createStandaloneHarness(
          report.runtimeKind,
          WASM_PATH,
          report.runtimeKind === "browser" ? { surface: "direct" } : {},
        ),
      );
    }
    return harnessPool;
  }

  try {
    for (const requestEntry of report.requests) {
      if (
        requestEntry.mode === "full-day-backfill" &&
        requestEntry.backfillWorkerCount > 1
      ) {
        report.results.push(
          await runRequestBenchmarkInWorkerThreads(requestEntry, {
            runtimeKind: report.runtimeKind,
          }),
        );
        continue;
      }
      const directHarnessPool = await ensureHarnessPool(
        requestEntry.mode === "full-day-backfill"
          ? requestEntry.backfillWorkerCount
          : 1,
      );
      report.results.push(await runRequestBenchmark(directHarnessPool, requestEntry));
    }
  } finally {
    await Promise.all(harnessPool.map((harness) => harness.destroy?.()));
  }
  loadStkComparison(options.stkReportPath, report);
  const p95Values = report.results
    .map((result) => result.invokeP95Ms)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const warmP95Values = report.results
    .map((result) => result.invokeWarmP95Ms)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  report.summary = {
    resultCount: report.results.length,
    maxP95Ms: p95Values.length > 0 ? roundMetric(Math.max(...p95Values)) : null,
    maxWarmP95Ms: warmP95Values.length > 0 ? roundMetric(Math.max(...warmP95Values)) : null,
    memory: memorySnapshot(),
  };
  if (options.assertThresholds) {
    assertReportThresholds(report);
  }
  return report;
}

function parseList(value, fallback) {
  if (!value) {
    return fallback;
  }
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseCliArgs(argv) {
  const options = {
    runtimeKind: "browser",
    scenarioNames: ["100-sat"],
    gridNames: ["coarse"],
    repeatCount: 1,
    mode: "priority-fom",
    requestFormat: "scv",
    dryRun: false,
    json: false,
    assertThresholds: false,
    outputPath: null,
    stkReportPath: null,
    windowStartSeconds: 0,
    windowSeconds: null,
    backfillWorkerCount: null,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--assert-thresholds") {
      options.assertThresholds = true;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg.startsWith("--runtime=")) {
      options.runtimeKind = arg.slice("--runtime=".length);
    } else if (arg.startsWith("--scenario=")) {
      options.scenarioNames = parseList(arg.slice("--scenario=".length), options.scenarioNames);
    } else if (arg.startsWith("--grid=")) {
      options.gridNames = parseList(arg.slice("--grid=".length), options.gridNames);
    } else if (arg.startsWith("--repeat=")) {
      options.repeatCount = Number(arg.slice("--repeat=".length));
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg.startsWith("--request-format=")) {
      options.requestFormat = arg.slice("--request-format=".length);
    } else if (arg.startsWith("--window-start=")) {
      options.windowStartSeconds = Number(arg.slice("--window-start=".length));
    } else if (arg.startsWith("--window-seconds=")) {
      options.windowSeconds = Number(arg.slice("--window-seconds=".length));
    } else if (arg.startsWith("--backfill-workers=")) {
      options.backfillWorkerCount = Number(arg.slice("--backfill-workers=".length));
    } else if (arg.startsWith("--output=")) {
      options.outputPath = arg.slice("--output=".length);
    } else if (arg.startsWith("--stk-report=")) {
      options.stkReportPath = arg.slice("--stk-report=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.repeatCount) || options.repeatCount < 1) {
    throw new Error("--repeat must be a positive integer");
  }
  if (!REQUEST_FORMATS.includes(options.requestFormat)) {
    throw new Error(`--request-format must be one of ${REQUEST_FORMATS.join(", ")}`);
  }
  if (!Number.isFinite(options.windowStartSeconds) || options.windowStartSeconds < 0) {
    throw new Error("--window-start must be a non-negative number");
  }
  if (options.windowSeconds !== null && (!Number.isFinite(options.windowSeconds) || options.windowSeconds <= 0)) {
    throw new Error("--window-seconds must be a positive number");
  }
  if (
    options.backfillWorkerCount !== null &&
    (!Number.isInteger(options.backfillWorkerCount) ||
      options.backfillWorkerCount < MIN_BACKFILL_WORKER_COUNT)
  ) {
    throw new Error("--backfill-workers must be a positive integer");
  }
  return options;
}

function printableList() {
  return {
    scenarios: CANONICAL_SCENARIOS,
    grids: CANONICAL_GRID_SIZES.map((grid) => ({
      ...grid,
      cellCount: gridCellCount(grid),
    })),
    modes: BENCHMARK_MODES,
    requestFormats: REQUEST_FORMATS,
    thresholds: BENCHMARK_THRESHOLDS,
  };
}

function printReport(report, { json = false } = {}) {
  if (json) {
    return JSON.stringify(report, null, 2);
  }
  const lines = [
    `Sensor coverage benchmark: ${report.benchmarkId}`,
    `Runtime: ${report.runtimeKind}`,
    `Request format: ${report.requestFormat}`,
    `Requests: ${report.requests.length}`,
  ];
  for (const result of report.results) {
    lines.push(
      `${result.scenarioName}/${result.gridName}/${result.mode}: p95=${result.invokeP95Ms} ms max=${result.invokeMaxMs} ms invokes=${result.totalInvokeCount}`,
    );
  }
  if (report.results.length === 0) {
    lines.push("Dry run only; no module invokes executed.");
  }
  const matchedCount = report.stkComparison.matchedResults?.length ?? 0;
  if (matchedCount > 0) {
    const bestSpeedup = Math.max(
      ...report.stkComparison.matchedResults.map((result) => result.speedup),
    );
    lines.push(
      `STK comparison: ${report.stkComparison.status} (${matchedCount} matched, best speedup=${bestSpeedup}x)`,
    );
  } else {
    lines.push(`STK comparison: ${report.stkComparison.status}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.list) {
    const output = JSON.stringify(printableList(), null, 2);
    process.stdout.write(`${output}\n`);
    return;
  }

  const report = await runBenchmark(options);
  const output = printReport(report, { json: options.json });
  if (options.outputPath) {
    fs.writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
