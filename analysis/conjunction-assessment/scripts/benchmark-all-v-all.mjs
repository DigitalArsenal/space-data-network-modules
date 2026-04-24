// Cross-plugin benchmark. This script is intended to run from the OrbPro
// workspace, where the package exports below bridge to the canonical SDN module
// artifacts under packages/space-data-network-modules/.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { createHPOPPropagator } from "@orbpro/integration/hpop";
import { createSGP4Propagator } from "@orbpro/integration/sgp4";
import {
  extractEpochState,
  isoToJulianDate,
  parseAerospaceOcmText,
} from "./lib/aerospaceOcm.mjs";
import {
  listOcmEntries,
  maybeWriteJson,
  readJson,
  readTarEntryText,
} from "./lib/aerospaceDataset.mjs";
import {
  loadReferenceEventsFromSocrates,
  runAllVsAllBenchmark,
  scoreEventsAgainstReference,
} from "./lib/allVsAllHarness.mjs";

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

function splitCsvList(value, transform = (item) => item) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(transform);
}

async function loadSgp4Scenario(options) {
  const mode = String(options.mode ?? "sgp4-gp");
  const propagator = await createSGP4Propagator({
    requireEmbeddedManifest: true,
  });

  const inputPath =
    options.input ??
    (mode === "sgp4-tle"
      ? null
      : new URL(
          "../tests/fixtures/socrates/gp_61721,67298.json",
          import.meta.url,
        ));
  if (!inputPath) {
    throw new Error(
      "--input is required for sgp4-tle mode; bundled SOCRATES fixtures are GP/OMM records.",
    );
  }
  const inputText = await readFile(inputPath, "utf8");

  if (mode === "sgp4-tle") {
    const normalizedInput =
      inputPath.endsWith(".json") || inputText.trimStart().startsWith("[")
        ? JSON.parse(inputText)
        : inputText;
    propagator.initFromTLE(normalizedInput);
  } else {
    propagator.initFromOMM(JSON.parse(inputText));
  }

  const labels = [];
  for (let entityIndex = 0; entityIndex < propagator.entityCount; entityIndex++) {
    const row = propagator.getEntityCatalogRow(entityIndex) ?? {};
    labels.push({
      id: Number(row.NORAD_CAT_ID ?? entityIndex),
      name: row.OBJECT_NAME ?? `Entity ${entityIndex}`,
      designator: row.OBJECT_ID ?? null,
    });
  }

  return {
    propagator,
    labels,
    cleanup() {
      propagator.destroy();
    },
  };
}

async function loadHpopScenario(options) {
  const datasetTarPath =
    options["dataset-tar"] ??
    "/Users/tj/Documents/Conjunctions/AerospaceIVVDataset_20251009a.tar.gz";
  const objectIds = splitCsvList(options["object-ids"], (item) => item);
  const maxObjects = Number(options["max-objects"] ?? 8);
  const ocmEntries = await listOcmEntries(datasetTarPath, {
    contains: options["entry-contains"] ?? "/CDM/",
  });

  const selectedEntries =
    objectIds.length > 0
      ? ocmEntries.filter((entry) =>
          objectIds.some((objectId) => entry.endsWith(`/${objectId}.ocm`)),
        )
      : ocmEntries.slice(0, maxObjects);

  const states = [];
  const labels = [];

  for (const entry of selectedEntries) {
    const text = await readTarEntryText(datasetTarPath, entry);
    const parsed = parseAerospaceOcmText(text, { sourcePath: entry });
    const epochState = extractEpochState(parsed);
    if (!epochState) {
      continue;
    }
    states.push({
      epochJD: epochState.epochJD,
      positionKm: epochState.positionKm,
      velocityKmS: epochState.velocityKmS,
    });
    labels.push({
      id: Number(parsed.objectDesignator || labels.length),
      name: parsed.objectName || path.basename(entry, ".ocm"),
      designator: parsed.objectDesignator || null,
      sourcePath: entry,
    });
  }

  const propagator = await createHPOPPropagator({
    requireEmbeddedManifest: true,
  });
  propagator.initFromState(states);

  return {
    propagator,
    labels,
    cleanup() {
      propagator.destroy();
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode ?? "sgp4-gp");
  const stepSizes = splitCsvList(args["step-sizes"] ?? "60", Number);
  const startIso = args["start-iso"] ?? "2026-03-09T18:00:00Z";
  const stopIso = args["stop-iso"] ?? "2026-03-16T18:00:00Z";
  const thresholdKm = Number(args["threshold-km"] ?? 5);
  const captureMultiplier = Number(args["capture-multiplier"] ?? 4);

  const scenario =
    mode === "hpop-ocm" ? await loadHpopScenario(args) : await loadSgp4Scenario(args);

  try {
    const referenceEvents = args["reference-socrates-json"]
      ? loadReferenceEventsFromSocrates(
          await readJson(args["reference-socrates-json"]),
        )
      : [];
    const labelIds = new Set(scenario.labels.map((label) => Number(label.id)));
    const scopedReferenceEvents = referenceEvents.filter(
      (event) => labelIds.has(Number(event.idA)) && labelIds.has(Number(event.idB)),
    );

    const runs = [];
    for (const stepSec of stepSizes) {
      const run = await runAllVsAllBenchmark({
        propagator: scenario.propagator,
        labels: scenario.labels,
        entityCount: scenario.labels.length,
        startJD: isoToJulianDate(startIso),
        stopJD: isoToJulianDate(stopIso),
        stepSec,
        thresholdKm,
        captureMultiplier,
        excludePair(entityIndexA, entityIndexB) {
          const labelA = scenario.labels[entityIndexA];
          const labelB = scenario.labels[entityIndexB];
          return (
            labelA?.designator &&
            labelB?.designator &&
            labelA.designator === labelB.designator
          );
        },
      });

      const score =
        referenceEvents.length > 0
          ? scoreEventsAgainstReference(run.events, scopedReferenceEvents)
          : null;

      runs.push({
        stepSec,
        benchmark: run,
        referenceScore: score,
      });
    }

    const summary = {
      mode,
      startIso,
      stopIso,
      thresholdKm,
      captureMultiplier,
      entityCount: scenario.labels.length,
      labels: scenario.labels,
      runs,
    };

    await maybeWriteJson(args.output, summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    scenario.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
