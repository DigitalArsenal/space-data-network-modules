/* global console, process */
import { maybeWriteJson } from "./lib/aerospaceDataset.mjs";
import {
  getDefaultAerospaceReplayPaths,
  runAerospaceAnswerKeyReplay,
} from "./lib/aerospaceReplayHarness.mjs";

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
  const defaults = getDefaultAerospaceReplayPaths(args["extracted-root"]);
  const answerKeyPath =
    args["answer-key"] === "sfsh"
      ? defaults.sfshAnswerKeyPath
      : args["answer-key"] === "spherical" || !args["answer-key"]
        ? defaults.sphericalAnswerKeyPath
        : args["answer-key"];

  const summary = await runAerospaceAnswerKeyReplay({
    extractedRoot: args["extracted-root"],
    answerKeyPath,
    ocmRoot: args["ocm-root"] ?? defaults.ocmRoot,
    limit: args.limit,
    offset: args.offset,
    shardCount: args["shard-count"],
    shardIndex: args["shard-index"],
    pluginBatchSize: args["plugin-batch-size"],
    trackCacheSize: args["track-cache-size"],
    windowLeadSec: args["window-lead-sec"],
    windowLagSec: args["window-lag-sec"],
    resampleStepSec: args["resample-step-sec"],
    coarseStepSec: args["coarse-step-sec"],
    fineTolSec: args["fine-tol-sec"],
    tcaToleranceSec: args["tca-tol-sec"],
    rangeToleranceKm: args["range-tol-km"],
    maxRecordedMismatches: args["max-recorded-mismatches"],
    maxRecordedErrors: args["max-recorded-errors"],
    progressEvery: args["progress-every"],
    onProgress:
      args["progress-every"] !== undefined
        ? (progressSummary) => {
            console.error(
              JSON.stringify(
                {
                  testedRows: progressSummary.testedRows,
                  matchedRows: progressSummary.matchedRows,
                  mismatchCount: progressSummary.mismatchCount,
                  errorCount: progressSummary.errorCount,
                  pluginInstancesCreated:
                    progressSummary.pluginInstancesCreated,
                  elapsedMs: progressSummary.elapsedMs,
                },
                null,
                2,
              ),
            );
          }
        : null,
  });

  await maybeWriteJson(args.output, summary);
  console.log(JSON.stringify(summary, null, 2));

  if (summary.mismatchCount > 0 || summary.errorCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
