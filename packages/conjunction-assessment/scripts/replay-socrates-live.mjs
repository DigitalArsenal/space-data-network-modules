import { runSocratesLiveComparisonCli } from "./lib/socratesReplayHarness.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index++;
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runSocratesLiveComparisonCli({
    sort: args.sort,
    limit: args.limit,
    offset: args.offset,
    cacheDir: args["cache-dir"],
    rateMs: args["rate-ms"],
    csvTimeoutMs: args["csv-timeout-ms"],
    timeoutMs: args["timeout-ms"],
    maxScanRows: args["max-scan-rows"],
    thresholdKm: args["threshold-km"],
    windowLeadDays: args["window-lead-days"],
    windowDurationDays: args["window-duration-days"],
    tcaToleranceSec: args["tca-tol-sec"],
    rangeToleranceKm: args["range-tol-km"],
    speedToleranceKmS: args["speed-tol-km-s"],
    probabilityRatioTolerance: args["prob-ratio-tol"],
    maxRecordedMismatches: args["max-recorded-mismatches"],
    maxRecordedErrors: args["max-recorded-errors"],
    progressEvery: args["progress-every"],
    output: args.output,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.mismatchCount > 0 || summary.errorCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
