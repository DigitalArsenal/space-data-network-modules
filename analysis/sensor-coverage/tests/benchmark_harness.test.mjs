import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  BENCHMARK_THRESHOLDS,
  CANONICAL_GRID_SIZES,
  CANONICAL_SCENARIOS,
  SCV_COVERAGE_REQUEST_TYPE,
  createBackfillWindows,
  createCoverageBenchmarkRequest,
  createScvCoverageBenchmarkPayload,
  createBenchmarkReportSkeleton,
  loadStkComparison,
  runBenchmark,
  runRequestBenchmark,
} from "../benchmarks/sensor-coverage-benchmark.mjs";

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

const {
  SCV,
  scvAnalysisMode,
  scvEnvelopeKind,
  scvMetricSeriesKind,
} = await import(pathToFileURL(`${resolveStandardsRoot()}/lib/js/SCV/main.js`).href);
const flatbuffers = await import(
  pathToFileURL(`${resolveStandardsRoot()}/node_modules/flatbuffers/mjs/flatbuffers.js`).href,
);

test("sensor coverage benchmark harness defines STK-class canonical scenarios and thresholds", () => {
  assert.deepEqual(
    CANONICAL_SCENARIOS.map((scenario) => scenario.satelliteCount),
    [100, 1000, 5000],
  );
  assert.deepEqual(
    CANONICAL_GRID_SIZES.map((grid) => grid.name),
    ["coarse", "operational", "dense"],
  );
  assert.equal(BENCHMARK_THRESHOLDS.warmVisualScrubP95Ms, 100);
  assert.equal(BENCHMARK_THRESHOLDS.coldPriorityPreviewP95Ms, 500);
  assert.equal(BENCHMARK_THRESHOLDS.priorityFomP95Ms, 500);
  assert.equal(BENCHMARK_THRESHOLDS.requiresNoRenderTickCoverageCompute, true);
  assert.equal(BENCHMARK_THRESHOLDS.requiresNoJsCoverageMath, true);
});

test("sensor coverage benchmark summarizes SCV results from aggregate and raster products", () => {
  const source = fs.readFileSync(
    new URL("../benchmarks/sensor-coverage-benchmark.mjs", import.meta.url),
    "utf8",
  );
  const summaryStart = source.indexOf("function scvResultHasRasterBand");
  const summaryStop = source.indexOf("function findScvResultEnvelope", summaryStart);
  assert.notEqual(summaryStart, -1);
  assert.notEqual(summaryStop, -1);
  const summarySource = source.slice(summaryStart, summaryStop);

  assert.match(summarySource, /AGGREGATE_STATISTICS\(\)/);
  assert.match(summarySource, /RASTER_PRODUCTS\(\)/);
  assert.doesNotMatch(summarySource, /CELL_STATS/);
  assert.doesNotMatch(summarySource, /cellStatsLength/);
  assert.doesNotMatch(summarySource, /intervalsLength/);
});

test("sensor coverage benchmark dry run emits a repeatable report skeleton", () => {
  const report = createBenchmarkReportSkeleton({
    runtimeKind: "browser",
    scenarioNames: ["100-sat"],
    gridNames: ["coarse"],
    repeatCount: 1,
    requestFormat: "scv",
  });

  assert.equal(report.benchmarkId, "sensor-coverage-stk-class");
  assert.equal(report.runtimeKind, "browser");
  assert.equal(report.requestFormat, "scv");
  assert.equal(report.thresholds.priorityFomP95Ms, 500);
  assert.equal(report.requests.length, 1);
  assert.equal(report.requests[0].requestFormat, "scv");
  assert.equal(report.requests[0].scenario.satelliteCount, 100);
  assert.equal(report.requests[0].grid.name, "coarse");
  assert.equal(report.stkComparison.status, "pending");
});

test("sensor coverage benchmark keeps FOM lanes metric-product and visual lanes swath-preview", () => {
  const scenario = CANONICAL_SCENARIOS[0];
  const grid = CANONICAL_GRID_SIZES[0];
  const priorityRequest = createCoverageBenchmarkRequest({
    scenario,
    grid,
    mode: "priority-fom",
  });
  const visualRequest = createCoverageBenchmarkRequest({
    scenario,
    grid,
    mode: "visual-preview",
    stopSeconds: scenario.stateStepSeconds,
  });

  assert.equal(priorityRequest.figureOfMerit, "percent_coverage");
  assert.equal(priorityRequest.outputMode, "metric_products");
  assert.equal(visualRequest.figureOfMerit, "none");
  assert.equal(visualRequest.outputMode, "swath_preview");
});

test("sensor coverage benchmark can build SDS SCV binary requests for benchmark lanes", () => {
  const scenario = CANONICAL_SCENARIOS[0];
  const grid = CANONICAL_GRID_SIZES[0];
  const priorityPayload = createScvCoverageBenchmarkPayload({
    scenario,
    grid,
    mode: "priority-fom",
    startSeconds: 0,
    stopSeconds: scenario.priorityWindowSeconds,
  });
  const visualPayload = createScvCoverageBenchmarkPayload({
    scenario,
    grid,
    mode: "visual-preview",
    startSeconds: 0,
    stopSeconds: scenario.stateStepSeconds,
  });

  assert.equal(SCV_COVERAGE_REQUEST_TYPE.schemaName, "SCV/main.fbs");
  assert.equal(SCV_COVERAGE_REQUEST_TYPE.fileIdentifier, "$SCV");
  assert.equal(SCV_COVERAGE_REQUEST_TYPE.rootTypeName, "SCV");
  assert.equal(SCV_COVERAGE_REQUEST_TYPE.wireFormat, "flatbuffer");
  assert.equal(SCV_COVERAGE_REQUEST_TYPE.requiredAlignment, 8);
  assert.ok(priorityPayload instanceof Uint8Array);

  const priorityEnvelope = SCV.getRootAsSCV(
    new flatbuffers.ByteBuffer(priorityPayload),
  );
  const priorityRequest = priorityEnvelope.REQUEST();
  assert.equal(priorityEnvelope.ENVELOPE_KIND(), scvEnvelopeKind.REQUEST);
  assert.ok(priorityRequest);
  assert.equal(priorityRequest.ANALYSIS_MODE(), scvAnalysisMode.COVERAGE);
  assert.equal(priorityRequest.sensorsLength(), scenario.satelliteCount);
  assert.ok(priorityRequest.stateSamplesLength() > scenario.satelliteCount);
  assert.equal(priorityRequest.requestedProductsLength(), 1);
  assert.equal(
    priorityRequest.REQUESTED_PRODUCTS(0),
    scvMetricSeriesKind.PERCENT_COVERED,
  );
  assert.equal(priorityRequest.INCLUDE_PACKED_GEOMETRY(), false);

  const visualRequest = SCV.getRootAsSCV(
    new flatbuffers.ByteBuffer(visualPayload),
  ).REQUEST();
  assert.ok(visualRequest);
  assert.equal(visualRequest.ANALYSIS_MODE(), scvAnalysisMode.SWATH);
  assert.equal(visualRequest.requestedProductsLength(), 0);
  assert.equal(visualRequest.INCLUDE_PACKED_GEOMETRY(), true);
});

test("sensor coverage full-day benchmark honors explicit backfill window seconds", () => {
  const report = createBenchmarkReportSkeleton({
    scenarioNames: ["100-sat"],
    gridNames: ["coarse"],
    repeatCount: 1,
    mode: "full-day-backfill",
    windowSeconds: 300,
  });
  const windows = createBackfillWindows(report.requests[0]);

  assert.equal(report.requests[0].windowSeconds, 300);
  assert.equal(windows.length, 288);
  assert.deepEqual(windows[0], { startSeconds: 0, stopSeconds: 300 });
  assert.deepEqual(windows.at(-1), { startSeconds: 86100, stopSeconds: 86400 });
});

test("sensor coverage full-day benchmark defaults to STK-class backfill buckets", () => {
  const report = createBenchmarkReportSkeleton({
    scenarioNames: ["100-sat"],
    gridNames: ["coarse"],
    repeatCount: 1,
    mode: "full-day-backfill",
  });
  const windows = createBackfillWindows(report.requests[0]);

  assert.equal(report.requests[0].windowSeconds, 300);
  assert.equal(windows.length, 288);
  assert.deepEqual(windows[0], { startSeconds: 0, stopSeconds: 300 });
  assert.deepEqual(windows.at(-1), { startSeconds: 86100, stopSeconds: 86400 });
});

test("sensor coverage full-day benchmark schedules backfill windows through bounded parallel lanes", async () => {
  const report = createBenchmarkReportSkeleton({
    scenarioNames: ["100-sat"],
    gridNames: ["coarse"],
    repeatCount: 1,
    mode: "full-day-backfill",
    backfillWorkerCount: 4,
  });
  const [requestEntry] = report.requests;
  const fakeHarnessPool = Array.from({ length: 4 }, (_, index) => ({
    id: `fake-${index}`,
    runtimeKind: "browser",
  }));
  let activeInvokeCount = 0;
  let maxActiveInvokeCount = 0;

  const result = await runRequestBenchmark(fakeHarnessPool, requestEntry, {
    invoke: async () => {
      activeInvokeCount += 1;
      maxActiveInvokeCount = Math.max(maxActiveInvokeCount, activeInvokeCount);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeInvokeCount -= 1;
      return {
        statistics: {
          activeSensorCount: requestEntry.scenario.satelliteCount,
          accessedCells: 1,
        },
        swaths: [],
        coverageIntervals: [],
        figureOfMerit: {
          type: "percent_coverage",
        },
      };
    },
  });

  assert.equal(requestEntry.backfillWorkerCount, 4);
  assert.equal(result.mode, "full-day-backfill");
  assert.equal(result.windowCount, 288);
  assert.equal(result.totalInvokeCount, 288);
  assert.equal(result.parallelWorkerCount, 4);
  assert.equal(maxActiveInvokeCount, 4);
});

test("sensor coverage full-day benchmark honors explicit eight-lane backfill", () => {
  const report = createBenchmarkReportSkeleton({
    scenarioNames: ["1000-sat"],
    gridNames: ["coarse"],
    repeatCount: 1,
    mode: "full-day-backfill",
    backfillWorkerCount: 8,
  });

  assert.equal(report.requests[0].backfillWorkerCount, 8);
});

test("sensor coverage full-day benchmark uses worker-thread lanes for standalone backfill", () => {
  const benchmarkSource = fs.readFileSync(
    new URL("../benchmarks/sensor-coverage-benchmark.mjs", import.meta.url),
    "utf8",
  );

  assert.match(benchmarkSource, /node:worker_threads/);
  assert.match(benchmarkSource, /sensor-coverage-benchmark-worker\.mjs/);
  assert.match(benchmarkSource, /runRequestBenchmarkInWorkerThreads/);
  assert.match(benchmarkSource, /parallelExecution: "worker_threads"/);
});

test("sensor coverage benchmark command supports dry-run JSON output", () => {
  const output = execFileSync(
    process.execPath,
    [
      "benchmarks/sensor-coverage-benchmark.mjs",
      "--dry-run",
      "--runtime=browser",
      "--scenario=100-sat",
      "--grid=coarse",
      "--repeat=1",
      "--json",
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    },
  );
  const report = JSON.parse(output);
  assert.equal(report.benchmarkId, "sensor-coverage-stk-class");
  assert.equal(report.requests.length, 1);
  assert.equal(report.requests[0].scenario.name, "100-sat");
  assert.equal(report.requests[0].grid.name, "coarse");
});

test("sensor coverage benchmark command supports SDS SCV binary request output", () => {
  const output = execFileSync(
    process.execPath,
    [
      "benchmarks/sensor-coverage-benchmark.mjs",
      "--runtime=browser",
      "--scenario=100-sat",
      "--grid=coarse",
      "--mode=priority-fom",
      "--request-format=scv",
      "--repeat=1",
      "--json",
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    },
  );
  const report = JSON.parse(output);
  const [result] = report.results;

  assert.equal(report.requestFormat, "scv");
  assert.equal(report.requests[0].requestFormat, "scv");
  assert.ok(result);
  assert.equal(result.requestFormat, "scv");
  assert.equal(result.output.activeSensorCount, 100);
  assert.equal(result.output.figureOfMeritType, "percent_coverage");
});

test("sensor coverage benchmark results expose required runtime telemetry fields", () => {
  const output = execFileSync(
    process.execPath,
    [
      "benchmarks/sensor-coverage-benchmark.mjs",
      "--runtime=browser",
      "--scenario=100-sat",
      "--grid=coarse",
      "--mode=visual-preview",
      "--repeat=1",
      "--json",
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    },
  );
  const report = JSON.parse(output);
  const [result] = report.results;

  assert.ok(result);
  assert.equal(typeof result.memory.rssMB, "number");
  assert.equal(result.telemetry.workerUtilization.status, "not-measured");
  assert.match(result.telemetry.workerUtilization.reason, /standalone/i);
  assert.equal(result.telemetry.renderFps.status, "not-measured");
  assert.match(result.telemetry.renderFps.reason, /render loop/i);
});

test("sensor coverage benchmark reports cold start and warm p95 timing separately", () => {
  const output = execFileSync(
    process.execPath,
    [
      "benchmarks/sensor-coverage-benchmark.mjs",
      "--runtime=browser",
      "--scenario=100-sat",
      "--grid=coarse",
      "--mode=priority-fom",
      "--repeat=2",
      "--json",
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    },
  );
  const report = JSON.parse(output);
  const [result] = report.results;

  assert.ok(result);
  assert.equal(result.totalInvokeCount, 2);
  assert.equal(result.invokeColdStartMs, result.invokeMs[0]);
  assert.deepEqual(result.invokeWarmMs, [result.invokeMs[1]]);
  assert.equal(result.invokeWarmP95Ms, result.invokeMs[1]);
});

test("sensor coverage benchmark evaluates matching STK full-day baseline reports", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-coverage-stk-"));
  const stkReportPath = path.join(tempDir, "stk-report.json");
  fs.writeFileSync(
    stkReportPath,
    JSON.stringify({
      benchmarkId: "stk-coverage",
      results: [
        {
          scenarioName: "1000-sat",
          gridName: "dense",
          mode: "full-day-backfill",
          elapsedTotalMs: 400000,
        },
      ],
    }),
  );
  const report = {
    results: [
      {
        scenarioName: "1000-sat",
        gridName: "dense",
        mode: "full-day-backfill",
        elapsedTotalMs: 305844.74,
      },
    ],
    stkComparison: {
      status: "pending",
    },
  };

  loadStkComparison(stkReportPath, report);

  assert.equal(report.stkComparison.status, "passed");
  assert.equal(report.stkComparison.matchedResults.length, 1);
  assert.equal(report.stkComparison.matchedResults[0].orbproFaster, true);
  assert.equal(report.stkComparison.matchedResults[0].speedup, 1.308);
});

test("sensor coverage benchmark evaluates supplied STK report after live benchmark results", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-coverage-live-stk-"));
  const stkReportPath = path.join(tempDir, "stk-report.json");
  fs.writeFileSync(
    stkReportPath,
    JSON.stringify({
      benchmarkId: "stk-coverage",
      results: [
        {
          scenarioName: "100-sat",
          gridName: "coarse",
          mode: "visual-preview",
          elapsedTotalMs: 1000000,
        },
      ],
    }),
  );

  const report = await runBenchmark({
    runtimeKind: "browser",
    scenarioNames: ["100-sat"],
    gridNames: ["coarse"],
    mode: "visual-preview",
    repeatCount: 1,
    stkReportPath,
  });

  assert.equal(report.results.length, 1);
  assert.equal(report.stkComparison.status, "passed");
  assert.equal(report.stkComparison.matchedResults.length, 1);
  assert.equal(report.stkComparison.matchedResults[0].orbproFaster, true);
});
