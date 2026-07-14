import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STANDALONE_RUNTIME_KINDS,
  assertSuccessfulResponse,
  createStandaloneHarnessOrSkip,
} from "../../../tests/lib/isomorphicHarness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const FIXTURE_MEME_PATH = new URL("./fixtures/request.fit.meme", import.meta.url);
const MEME_DATA_DIR = path.join(__dirname, "data", "meme");
const REFERENCE_SUITE_DIR = path.join(__dirname, "data", "supgp-reference");
const ISS_OEM_FIXTURE = path.join(
  REFERENCE_SUITE_DIR,
  "iss",
  "ISS.OEM_J2K_EPH.trimmed.txt",
);
const DEFAULT_CELESTRAK_CSV = path.join(
  __dirname,
  "data",
  "celestrak_starlink_supgp.csv",
);

function createFitRequest(payload, options = null) {
  const request = {
    methodId: "fit",
    inputs: [
      {
        portId: "meme",
        payload,
      },
    ],
  };
  if (options) {
    request.inputs.push({
      portId: "options",
      payload: new TextEncoder().encode(JSON.stringify(options)),
    });
  }
  return request;
}

async function invokeFitJson(harness, payload, options = null) {
  const response = await harness.invoke(createFitRequest(payload, options));
  const bytes = assertSuccessfulResponse(response, { outputPortId: "result" });
  return JSON.parse(new TextDecoder().decode(bytes));
}

function listRegressionFiles() {
  if (!fs.existsSync(MEME_DATA_DIR)) {
    return [];
  }
  return fs.readdirSync(MEME_DATA_DIR)
    .filter((entry) => entry.startsWith("MEME_") && entry.endsWith(".txt"))
    .sort()
    .map((entry) => path.join(MEME_DATA_DIR, entry));
}

// ── Provider-manifest driven reference suite ───────────────────────────────
// Each provider is a directory under supgp-reference/<provider>/ with a
// provider.json describing source token, input format (meme|oem), input files,
// gate type and tolerances. Adding a provider (A2.4) is a data change, not code.

function listProviders() {
  if (!fs.existsSync(REFERENCE_SUITE_DIR)) {
    return [];
  }
  return fs.readdirSync(REFERENCE_SUITE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(REFERENCE_SUITE_DIR, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "provider.json")))
    .map((dir) => ({
      dir,
      manifest: JSON.parse(fs.readFileSync(path.join(dir, "provider.json"), "utf8")),
    }))
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

function providerInputFiles(dir, manifest) {
  if (Array.isArray(manifest.inputFiles)) {
    return manifest.inputFiles.map((file) => path.join(dir, file));
  }
  const inputDir = path.join(dir, manifest.inputDir ?? ".");
  if (!fs.existsSync(inputDir)) {
    return [];
  }
  const prefix = manifest.inputPrefix ?? "";
  const suffix = manifest.inputSuffix ?? "";
  return fs.readdirSync(inputDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort()
    .map((name) => path.join(inputDir, name));
}

function fitOptionsForProvider(manifest) {
  const options = { inputFormat: manifest.format };
  if (manifest.source) options.dataSource = manifest.source;
  if (manifest.objectName) options.objectName = manifest.objectName;
  if (manifest.objectId) options.objectId = manifest.objectId;
  if (Number.isFinite(manifest.noradCatId)) options.noradCatId = manifest.noradCatId;
  return options;
}

function parseCelestrakCsv(csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) {
    return new Map();
  }
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/);
  const records = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) {
      continue;
    }
    const fields = line.split(",");
    if (fields.length < 18) {
      continue;
    }
    const noradId = Number.parseInt(fields[11], 10);
    const rms = Number.parseFloat(fields[17]);
    if (!Number.isFinite(noradId) || !Number.isFinite(rms)) {
      continue;
    }
    records.set(noradId, { rms });
  }
  return records;
}

function noradIdFromMemePath(filePath) {
  const id = Number.parseInt(path.basename(filePath).split("_")[1] ?? "", 10);
  return Number.isFinite(id) ? id : Number.NaN;
}

// ── CelesTrak SupGP element-space parity (A2.4) ──────────────────────────────
// A richer CSV reader than parseCelestrakCsv: keeps every OMM element column,
// keyed by NORAD_CAT_ID -> [row, ...] (a source may carry many rows for one
// object: ISS 6 h segments, CPF prediction-centre variants, weekly Intelsat
// snapshots). Column lookup is by HEADER NAME (order-independent). Blank/`#`
// lines are skipped so a provenance banner could be prepended without breaking
// the parse; the checked-in captures are byte-exact CelesTrak CSV (no banner).
function parseCelestrakSupGpRows(csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) {
    return new Map();
  }
  const lines = fs.readFileSync(csvPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"));
  if (lines.length < 2) {
    return new Map();
  }
  const header = lines[0].split(",");
  const col = (name) => header.indexOf(name);
  const cNorad = col("NORAD_CAT_ID");
  const byNorad = new Map();
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    const norad = Number.parseInt(f[cNorad], 10);
    if (!Number.isFinite(norad)) {
      continue;
    }
    const num = (name) => Number.parseFloat(f[col(name)]);
    const row = {
      objectName: f[col("OBJECT_NAME")],
      epoch: f[col("EPOCH")],
      meanMotion: num("MEAN_MOTION"),
      eccentricity: num("ECCENTRICITY"),
      inclination: num("INCLINATION"),
      raan: num("RA_OF_ASC_NODE"),
      argp: num("ARG_OF_PERICENTER"),
      meanAnomaly: num("MEAN_ANOMALY"),
      // Drag terms — needed to propagate CelesTrak's own elements via SGP4 for
      // the A2.4d same-ephemeris RMS score (a bare Keplerian set would misfit an
      // LEO arc). Columns are present in the SupGP CSV; default 0 when blank.
      bstar: Number.isFinite(num("BSTAR")) ? num("BSTAR") : 0,
      meanMotionDot: Number.isFinite(num("MEAN_MOTION_DOT")) ? num("MEAN_MOTION_DOT") : 0,
      meanMotionDdot: Number.isFinite(num("MEAN_MOTION_DDOT")) ? num("MEAN_MOTION_DDOT") : 0,
      rms: num("RMS"),
    };
    if (!byNorad.has(norad)) {
      byNorad.set(norad, []);
    }
    byNorad.get(norad).push(row);
  }
  return byNorad;
}

function epochMs(iso) {
  // Accept "2026-07-13T12:00:00.000000" or "...Z"; normalise fractional secs.
  const normalized = iso.replace(/(\.\d{3})\d*/, "$1").replace(/Z?$/, "Z");
  return Date.parse(normalized);
}

function pickClosestEpochRow(rows, fitEpochIso) {
  const target = epochMs(fitEpochIso);
  let best = null;
  for (const row of rows) {
    const delta = Math.abs(epochMs(row.epoch) - target);
    if (!best || delta < best.deltaMs) {
      best = { row, deltaMs: delta };
    }
  }
  return best;
}

// Smallest absolute angular separation in degrees (handles 0/360 wrap).
function angDiffDeg(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Compare our fitted OMM against the same-epoch CelesTrak SupGP OMM within the
// documented per-provider element-space tolerances. Fail-closed: a missing
// reference row or an out-of-tolerance element throws. `parity.label` records
// the honesty class (independent raw-vs-fit / prediction-vs-prediction /
// non-independent) — it is reported, never used to weaken the assertion.
function assertElementSpaceParity(fit, parity, celestrakByNorad, label) {
  const rows = celestrakByNorad.get(parity.noradCatId);
  assert.ok(
    rows && rows.length > 0,
    `${label}: no CelesTrak SupGP row for NORAD ${parity.noradCatId}.`,
  );
  const { row: ref, deltaMs } = pickClosestEpochRow(rows, fit.EPOCH);
  const deltaSec = deltaMs / 1000;
  const tol = parity.tolerances ?? {};
  const checks = [];
  if (Number.isFinite(tol.meanMotion)) {
    checks.push([
      "MEAN_MOTION", Math.abs(fit.MEAN_MOTION - ref.meanMotion), tol.meanMotion,
    ]);
  }
  if (Number.isFinite(tol.eccentricity)) {
    checks.push([
      "ECCENTRICITY", Math.abs(fit.ECCENTRICITY - ref.eccentricity), tol.eccentricity,
    ]);
  }
  if (Number.isFinite(tol.inclinationDeg)) {
    checks.push([
      "INCLINATION", angDiffDeg(fit.INCLINATION, ref.inclination), tol.inclinationDeg,
    ]);
  }
  if (Number.isFinite(tol.raanDeg)) {
    checks.push([
      "RA_OF_ASC_NODE", angDiffDeg(fit.RA_OF_ASC_NODE, ref.raan), tol.raanDeg,
    ]);
  }
  if (Number.isFinite(tol.argLatDeg)) {
    // Argument of latitude (argp + mean anomaly) is the well-conditioned
    // combination for near-circular orbits where argp/MA individually rotate.
    const fitArgLat = (fit.ARG_OF_PERICENTER + fit.MEAN_ANOMALY) % 360;
    const refArgLat = (ref.argp + ref.meanAnomaly) % 360;
    checks.push(["ARG_LAT(argp+MA)", angDiffDeg(fitArgLat, refArgLat), tol.argLatDeg]);
  }
  for (const [name, delta, limit] of checks) {
    assert.ok(
      delta <= limit,
      `${label}: ${name} parity vs CelesTrak SupGP NORAD ${parity.noradCatId} `
        + `(${parity.label ?? "element-space"}, Δepoch=${deltaSec.toFixed(0)}s) `
        + `Δ=${delta} exceeds tolerance ${limit}.`,
    );
  }
}

function summarizeRegression(results, celestrak) {
  const successful = results
    .filter((entry) => entry.ok)
    .map((entry) => entry.rms)
    .sort((left, right) => left - right);
  const comparisons = results
    .filter((entry) => entry.ok && celestrak.has(entry.noradId))
    .map((entry) => ({
      rms: entry.rms,
      referenceRms: celestrak.get(entry.noradId).rms,
    }));

  return {
    count: results.length,
    successCount: successful.length,
    medianRms: successful.length
      ? successful[Math.floor(successful.length / 2)]
      : Number.NaN,
    meanRms: successful.length
      ? successful.reduce((sum, value) => sum + value, 0) / successful.length
      : Number.NaN,
    betterCount: comparisons.filter((entry) => entry.rms < entry.referenceRms).length,
    worseCount: comparisons.filter((entry) => entry.rms >= entry.referenceRms).length,
  };
}

function assertBeatsCelestrak(result) {
  assert.ok(
    result.rms < result.referenceRms,
    [
      `${path.basename(result.filePath)} must beat CelesTrak SupGP RMS.`,
      `OrbPro=${result.rms.toFixed(6)} km`,
      `CelesTrak=${result.referenceRms.toFixed(6)} km`,
      `delta=${(result.rms - result.referenceRms).toFixed(6)} km`,
    ].join(" "),
  );
}

async function runBeatsCelestrakGate(t, harness, dir, manifest) {
  const files = providerInputFiles(dir, manifest);
  assert.ok(
    files.length > 0,
    `Provider ${manifest.name} declares no input files.`,
  );
  const celestrak = parseCelestrakCsv(path.join(dir, manifest.celestrakCsv));
  assert.ok(
    celestrak.size > 0,
    `Provider ${manifest.name} is missing its CelesTrak SupGP CSV (${manifest.celestrakCsv}).`,
  );

  const options = fitOptionsForProvider(manifest);
  const results = [];
  for (const filePath of files) {
    const noradId = manifest.noradFromFilename
      ? noradIdFromMemePath(filePath)
      : Number.NaN;
    const reference = celestrak.get(noradId);
    assert.ok(
      reference,
      `Missing CelesTrak SupGP reference RMS for NORAD ${noradId} (${manifest.name}).`,
    );
    const fit = await invokeFitJson(harness, fs.readFileSync(filePath), options);
    const rms = Number.parseFloat(fit.RMS);
    assert.ok(
      Number.isFinite(rms),
      `Fit RMS must be finite for ${path.basename(filePath)}.`,
    );
    results.push({ filePath, noradId, rms, referenceRms: reference.rms });
  }
  for (const result of results) {
    assertBeatsCelestrak(result);
  }
}

async function runElementRangeGate(t, harness, dir, manifest) {
  const files = providerInputFiles(dir, manifest);
  assert.ok(files.length > 0, `Provider ${manifest.name} declares no input files.`);
  const options = fitOptionsForProvider(manifest);
  const expect = manifest.expect ?? {};
  // Optional same-epoch CelesTrak SupGP element-space parity (A2.4).
  const celestrakByNorad = manifest.celestrakParity
    ? parseCelestrakSupGpRows(path.join(dir, manifest.celestrakCsv))
    : null;
  if (manifest.celestrakParity) {
    assert.ok(
      celestrakByNorad && celestrakByNorad.size > 0,
      `Provider ${manifest.name} declares celestrakParity but its CelesTrak CSV `
        + `(${manifest.celestrakCsv}) is missing or empty.`,
    );
  }

  for (const filePath of files) {
    const fit = await invokeFitJson(harness, fs.readFileSync(filePath), options);
    const label = `${manifest.name}:${path.basename(filePath)}`;

    if (expect.converged) {
      assert.equal(fit.CONVERGED, true, `${label} must converge.`);
    }
    if (Array.isArray(expect.meanMotion)) {
      assert.ok(
        fit.MEAN_MOTION >= expect.meanMotion[0] && fit.MEAN_MOTION <= expect.meanMotion[1],
        `${label} MEAN_MOTION=${fit.MEAN_MOTION} out of ${JSON.stringify(expect.meanMotion)}.`,
      );
    }
    if (Array.isArray(expect.inclination)) {
      assert.ok(
        fit.INCLINATION >= expect.inclination[0] && fit.INCLINATION <= expect.inclination[1],
        `${label} INCLINATION=${fit.INCLINATION} out of ${JSON.stringify(expect.inclination)}.`,
      );
    }
    if (Number.isFinite(expect.eccentricityMax)) {
      assert.ok(
        fit.ECCENTRICITY <= expect.eccentricityMax,
        `${label} ECCENTRICITY=${fit.ECCENTRICITY} exceeds ${expect.eccentricityMax}.`,
      );
    }
    if (Number.isFinite(expect.rmsMaxKm)) {
      const rms = Number.parseFloat(fit.RMS);
      assert.ok(
        Number.isFinite(rms) && rms <= expect.rmsMaxKm,
        `${label} RMS=${fit.RMS} exceeds ${expect.rmsMaxKm} km.`,
      );
    }
    if (manifest.source) {
      assert.equal(fit.DATA_SOURCE, manifest.source, `${label} DATA_SOURCE mismatch.`);
    }
    if (manifest.objectName) {
      assert.equal(fit.OBJECT_NAME, manifest.objectName, `${label} OBJECT_NAME mismatch.`);
    }
    if (manifest.objectId) {
      assert.equal(fit.OBJECT_ID.trim(), manifest.objectId, `${label} OBJECT_ID mismatch.`);
    }
    if (manifest.celestrakParity) {
      assertElementSpaceParity(fit, manifest.celestrakParity, celestrakByNorad, label);
    }
  }
}

// ── A2.4d same-ephemeris beat (OWNER RULING 2026-07-13: "same ephemeris") ─────
// Build the ref* fit options that carry a captured CelesTrak SupGP OMM row into
// the module, so the fitter propagates THOSE elements via the SAME SGP4 over the
// SAME source-OEM states our fit used and reports REFERENCE_RMS. Reusable: any
// provider manifest declaring gate "beatsCelestrakSameEphemeris" + a
// celestrakParity.noradCatId reference gets this for free (GLONASS/CPF/Intelsat
// may adopt it once their arcs upgrade).
function referenceOptionsFromRow(manifest, row) {
  const options = fitOptionsForProvider(manifest);
  options.refEpoch = row.epoch;
  options.refMeanMotion = row.meanMotion;
  options.refEccentricity = row.eccentricity;
  options.refInclination = row.inclination;
  options.refRaan = row.raan;
  options.refArgPericenter = row.argp;
  options.refMeanAnomaly = row.meanAnomaly;
  options.refBstar = row.bstar;
  options.refMeanMotionDot = row.meanMotionDot;
  options.refMeanMotionDdot = row.meanMotionDdot;
  return options;
}

// Same-ephemeris gate: our fitted RMS <= the RMS of CelesTrak's OWN published
// SupGP elements, BOTH scored against the identical source-OEM states via the
// SAME SGP4 (apples-to-apples, per the A2.4c analysis + the owner ruling). Runs
// the existing elementRange checks too (element-space parity + ranges) so this
// gate is a strict superset: parity + beat, both.
async function runBeatsCelestrakSameEphemerisGate(t, harness, dir, manifest) {
  // (1) parity + ranges (unchanged, never weakened).
  await runElementRangeGate(t, harness, dir, manifest);

  // (2) the same-ephemeris RMS beat.
  const parity = manifest.celestrakParity;
  assert.ok(
    parity && Number.isFinite(parity.noradCatId),
    `Provider ${manifest.name} declares beatsCelestrakSameEphemeris but no `
      + `celestrakParity.noradCatId reference to score.`,
  );
  const byNorad = parseCelestrakSupGpRows(path.join(dir, manifest.celestrakCsv));
  const refRows = byNorad.get(parity.noradCatId);
  assert.ok(
    refRows && refRows.length > 0,
    `${manifest.name}: no CelesTrak SupGP rows for NORAD ${parity.noradCatId} `
      + `(${manifest.celestrakCsv}).`,
  );

  const files = providerInputFiles(dir, manifest);
  assert.ok(files.length > 0, `Provider ${manifest.name} declares no input files.`);
  const baseOptions = fitOptionsForProvider(manifest);

  for (const filePath of files) {
    const content = fs.readFileSync(filePath);
    const label = `${manifest.name}:${path.basename(filePath)}`;

    // Pass 1 — fit WITHOUT a reference: learn our fit epoch, and prove the
    // reference option does not perturb the fit (byte-identity contract).
    const plain = await invokeFitJson(harness, content, baseOptions);
    assert.equal(
      "REFERENCE_RMS" in plain,
      false,
      `${label}: a non-reference fit must NOT emit REFERENCE_RMS.`,
    );

    // The same-ephemeris reference is the CelesTrak SupGP segment whose epoch is
    // closest to OUR fit epoch (ISS Segment 01 EPOCH == our epoch, Δ0s).
    const { row: refRow, deltaMs } = pickClosestEpochRow(refRows, plain.EPOCH);

    // Pass 2 — fit WITH the reference: the module propagates CelesTrak's own
    // elements via the SAME SGP4 over the SAME winning fit points → REFERENCE_RMS.
    const scored = await invokeFitJson(
      harness,
      content,
      referenceOptionsFromRow(manifest, refRow),
    );

    const oursRms = Number.parseFloat(scored.RMS);
    const theirsRms = Number.parseFloat(scored.REFERENCE_RMS);
    assert.ok(Number.isFinite(oursRms), `${label}: our fit RMS must be finite.`);
    assert.ok(
      Number.isFinite(theirsRms),
      `${label}: REFERENCE_RMS must be present + finite (same-ephemeris score of `
        + `CelesTrak's own SupGP elements).`,
    );
    assert.equal(
      scored.RMS,
      plain.RMS,
      `${label}: the reference option perturbed the fit (${scored.RMS} vs ${plain.RMS}); `
        + `same-ephemeris scoring must be side-effect free.`,
    );

    // Record BOTH numbers in the test output (A2.4d directive).
    const summary =
      `${label} same-ephemeris beat: ours=${oursRms.toFixed(3)} km <= `
      + `CelesTrak=${theirsRms.toFixed(3)} km (margin ${(theirsRms - oursRms).toFixed(3)} km; `
      + `ref NORAD ${parity.noradCatId} [${refRow.objectName}] Δepoch=`
      + `${(deltaMs / 1000).toFixed(0)}s)`;
    if (typeof t.diagnostic === "function") t.diagnostic(summary);
    console.log(summary);

    assert.ok(
      oursRms <= theirsRms,
      `${label}: same-ephemeris RMS gate FAILED — ours ${oursRms} km must be <= `
        + `CelesTrak ${theirsRms} km on the identical OEM states.`,
    );
  }
}

// Split a single-segment OEM into two META/data segments carrying the same
// object, to exercise multi-segment concatenation.
function splitOemIntoTwoSegments(content) {
  const lines = content.split(/\r?\n/);
  const metaStart = lines.findIndex((l) => l.trim() === "META_START");
  const metaStop = lines.findIndex((l) => l.trim() === "META_STOP");
  const header = lines.slice(0, metaStart);
  const metaBlock = lines.slice(metaStart, metaStop + 1);
  const rest = lines.slice(metaStop + 1);
  const dataLines = rest.filter((l) => /^\s*\d{4}-\d{2}-\d{2}T/.test(l));
  const half = Math.floor(dataLines.length / 2);
  return [
    ...header,
    "",
    ...metaBlock,
    ...dataLines.slice(0, half),
    "",
    ...metaBlock,
    ...dataLines.slice(half),
    "",
  ].join("\n");
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`OD fixture fit produces a stable GP estimate on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // DATA_SOURCE now flows from the caller/manifest instead of being hardcoded
    // to "SpaceX-E" in the fitter (that hardcode was the bug de-Starlinked in
    // A2.2a); the caller supplies the source token via the options frame.
    const result = await invokeFitJson(
      harness,
      fs.readFileSync(fileURLToPath(FIXTURE_MEME_PATH)),
      { dataSource: "SpaceX-E" },
    );

    assert.equal(result.DATA_SOURCE, "SpaceX-E");
    assert.equal(result.OBJECT_ID.trim(), "99999A");
    assert.ok(result.EPOCH.startsWith("2026-03-10T20:16:42"));
    assert.ok(Math.abs(result.MEAN_MOTION - 15.08802686) < 1e-8);
    assert.ok(Math.abs(result.ECCENTRICITY - 0.0001602) < 1e-7);
    assert.ok(Math.abs(result.INCLINATION - 53.2223) < 1e-4);
    assert.ok(Number.parseFloat(result.RMS) <= 0.001);
  });

  test(`OD fit labels MEME output from caller/manifest fields on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // With no data_source supplied the output is unlabeled (no operator default).
    const bare = await invokeFitJson(
      harness,
      fs.readFileSync(fileURLToPath(FIXTURE_MEME_PATH)),
    );
    assert.equal(bare.DATA_SOURCE, "");

    // Caller/manifest fields populate DATA_SOURCE / OBJECT_NAME / NORAD_CAT_ID.
    const labeled = await invokeFitJson(
      harness,
      fs.readFileSync(fileURLToPath(FIXTURE_MEME_PATH)),
      {
        inputFormat: "meme",
        dataSource: "SpaceX-E",
        objectName: "STARLINK-36348",
        noradCatId: 67851,
      },
    );
    assert.equal(labeled.DATA_SOURCE, "SpaceX-E");
    assert.equal(labeled.OBJECT_NAME, "STARLINK-36348");
    assert.equal(labeled.NORAD_CAT_ID, 67851);
  });

  test(`OD fit honors maxIterations option on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeFitJson(
      harness,
      fs.readFileSync(fileURLToPath(FIXTURE_MEME_PATH)),
      { maxIterations: 2 },
    );

    assert.equal(result.MAX_ITERATIONS, 2);
    assert.ok(
      Number.isInteger(result.ITERATIONS) && result.ITERATIONS <= 2,
      `Expected solver iterations <= 2, got ${result.ITERATIONS}`,
    );
  });

  test(`OD fit rejects malformed MEME payloads on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke(
      createFitRequest(Buffer.from("not a meme", "utf8")),
    );
    assert.equal(response.statusCode, 1);
    assert.equal(response.errorCode, "parse-failed");
    assert.match(response.errorMessage, /did not contain any ephemeris points/i);
  });

  // ── CCSDS OEM input path (ISS NASA public OEM fixture) ───────────────────

  test(`OD OEM ISS fixture parses META + fits plausible ISS elements on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const content = fs.readFileSync(ISS_OEM_FIXTURE);
    // Explicit format and auto-detection must agree.
    const explicit = await invokeFitJson(harness, content, {
      inputFormat: "oem",
      dataSource: "ISS-E",
    });
    const auto = await invokeFitJson(harness, content, { dataSource: "ISS-E" });

    for (const fit of [explicit, auto]) {
      assert.equal(fit.CONVERGED, true, "ISS OEM fit must converge.");
      // Identity flows from the OEM META block.
      assert.equal(fit.OBJECT_NAME, "ISS");
      assert.equal(fit.OBJECT_ID.trim(), "1998-067-A");
      assert.equal(fit.DATA_SOURCE, "ISS-E");
      // Plausible ISS elements (ranges, not exact values). Mean motion ~15.5
      // rev/day, inclination ~51.6 deg in TEME.
      assert.ok(
        fit.MEAN_MOTION > 15.3 && fit.MEAN_MOTION < 15.7,
        `MEAN_MOTION=${fit.MEAN_MOTION} not ISS-like.`,
      );
      assert.ok(
        fit.INCLINATION > 51.0 && fit.INCLINATION < 52.2,
        `INCLINATION=${fit.INCLINATION} not ISS-like.`,
      );
      assert.ok(fit.ECCENTRICITY < 0.01, `ECCENTRICITY=${fit.ECCENTRICITY} too high.`);
      assert.ok(
        Number.parseFloat(fit.RMS) < 5.0,
        `RMS=${fit.RMS} too high for an EME2000->TEME converted fit.`,
      );
    }
  });

  test(`OD OEM handles multiple META/data segments on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const single = fs.readFileSync(ISS_OEM_FIXTURE, "utf8");
    const twoSegment = splitOemIntoTwoSegments(single);
    assert.equal((twoSegment.match(/META_START/g) ?? []).length, 2);

    const options = { inputFormat: "oem", dataSource: "ISS-E" };
    const singleFit = await invokeFitJson(harness, Buffer.from(single, "utf8"), options);
    const splitFit = await invokeFitJson(harness, Buffer.from(twoSegment, "utf8"), options);

    // Concatenating the two segments must reproduce the single-segment fit
    // (same samples), and identity still comes from the (first) META block.
    assert.equal(splitFit.CONVERGED, true);
    assert.equal(splitFit.OBJECT_ID.trim(), "1998-067-A");
    assert.ok(
      Math.abs(splitFit.MEAN_MOTION - singleFit.MEAN_MOTION) < 1e-6,
      `Split-segment fit diverged: ${splitFit.MEAN_MOTION} vs ${singleFit.MEAN_MOTION}.`,
    );
  });

  test(`OD OEM fails closed on unsupported TIME_SYSTEM / REF_FRAME on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const content = fs.readFileSync(ISS_OEM_FIXTURE, "utf8");

    // A2.4-prereq ADDED support for TIME_SYSTEM GPS/TAI and ITRF/IGS20/ECEF
    // frames, so the fail-closed guard is exercised here with values that REMAIN
    // unsupported: a barycentric-dynamical time scale (TDB) and a local-orbit
    // frame (RSW). (GPS-time + ECEF happy paths are covered by the native
    // test_frame_time_fit and the fit-pipeline module test.)
    const tdbContent = content.replace("TIME_SYSTEM          = UTC", "TIME_SYSTEM          = TDB");
    const tdbResponse = await harness.invoke(
      createFitRequest(Buffer.from(tdbContent, "utf8"), { inputFormat: "oem" }),
    );
    assert.equal(tdbResponse.statusCode, 1);
    assert.equal(tdbResponse.errorCode, "unsupported-time-system");
    assert.match(tdbResponse.errorMessage, /TIME_SYSTEM/i);

    const rswContent = content.replace("REF_FRAME            = EME2000", "REF_FRAME            = RSW");
    const rswResponse = await harness.invoke(
      createFitRequest(Buffer.from(rswContent, "utf8"), { inputFormat: "oem" }),
    );
    assert.equal(rswResponse.statusCode, 1);
    assert.equal(rswResponse.errorCode, "unsupported-frame");
    assert.match(rswResponse.errorMessage, /REF_FRAME/i);
  });

  test(`OD OEM fits a position-only IGS20/GPS (GLONASS) KVN ephemeris on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // Real IAC GLONASS SP3 R03 arc (ECEF/IGS20, GPS time, position-only, km) —
    // the same 3 epochs the native test uses, provenance:
    // analysis/od/tests/data/glonass/iac_glonass.sp3.glo (R03). A position-only
    // KVN OEM (4-token state lines) exercises the OD module's ECEF->TEME (GMST) +
    // GPS->UTC + position-only-seed path through the real WASM ABI.
    const glonassKvn = [
      "CCSDS_OEM_VERS = 2.0",
      "CREATION_DATE = 2026-07-11T00:00:00.000",
      "ORIGINATOR = IAC",
      "META_START",
      "OBJECT_NAME = R03",
      "OBJECT_ID = ",
      "CENTER_NAME = EARTH",
      "REF_FRAME = IGS20",
      "TIME_SYSTEM = GPS",
      "START_TIME = 2026-07-11T00:00:00.000",
      "STOP_TIME = 2026-07-11T00:30:00.000",
      "META_STOP",
      "2026-07-11T00:00:00.000 -12150.969681 -3659.828919 22181.510368",
      "2026-07-11T00:15:00.000 -9957.122270 -5356.366623 22914.410060",
      "2026-07-11T00:30:00.000 -7849.784068 -7255.011907 23204.602173",
      "",
    ].join("\n");

    const fit = await invokeFitJson(harness, Buffer.from(glonassKvn, "utf8"), {
      inputFormat: "oem",
      dataSource: "GLONASS-RE",
    });

    // Honest IDs (SP3 carries no NORAD/COSPAR; the registry seam lives in the fit
    // pipeline, not the parser). Unmapped => the fitter's documented "unknown"
    // placeholder (99999) or 0, NEVER a fabricated real GLONASS catalog number.
    assert.equal(fit.OBJECT_NAME, "R03");
    assert.ok(
      fit.NORAD_CAT_ID === 0 || fit.NORAD_CAT_ID === 99999,
      `NORAD_CAT_ID=${fit.NORAD_CAT_ID} must be the honest unknown placeholder, not a real ID`,
    );
    assert.equal(fit.DATA_SOURCE, "GLONASS-RE");
    // Credible GLONASS elements: n~2.13 rev/day, i~64.8 deg, near-circular.
    assert.ok(
      fit.MEAN_MOTION > 2.0 && fit.MEAN_MOTION < 2.3,
      `MEAN_MOTION=${fit.MEAN_MOTION} not GLONASS-like (~2.13 rev/day).`,
    );
    assert.ok(
      fit.INCLINATION > 63.0 && fit.INCLINATION < 67.0,
      `INCLINATION=${fit.INCLINATION} not GLONASS-like (~64.8 deg).`,
    );
    assert.ok(fit.ECCENTRICITY < 0.02, `ECCENTRICITY=${fit.ECCENTRICITY} too high for GLONASS.`);
    assert.ok(
      Number.parseFloat(fit.RMS) < 5.0,
      `RMS=${fit.RMS} too high for the position-only ECEF->TEME fit.`,
    );
  });

  // ── Provider-manifest reference gates (Starlink beats-CelesTrak, ISS range) ─

  for (const { dir, manifest } of listProviders()) {
    test(`OD provider reference gate [${manifest.name}] on ${runtimeKind}`, async (t) => {
      // Fail-closed, visible skip for providers whose gate is blocked at the
      // source (GPS almanac ≠ state ephemeris; OneWeb LTEF undecodable). The
      // captured CelesTrak SupGP reference pair is still checked in so the gate
      // wires the moment the block clears — this is a documented skip-with-
      // reason, never a silent absence.
      if (manifest.gate === "skip") {
        t.skip(manifest.skipReason ?? `Provider ${manifest.name} gate is blocked.`);
        return;
      }

      const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
      if (!harness) {
        return;
      }
      t.after(async () => {
        await harness.destroy();
      });

      if (manifest.gate === "beatsCelestrak") {
        await runBeatsCelestrakGate(t, harness, dir, manifest);
      } else if (manifest.gate === "beatsCelestrakSameEphemeris") {
        await runBeatsCelestrakSameEphemerisGate(t, harness, dir, manifest);
      } else if (manifest.gate === "elementRange") {
        await runElementRangeGate(t, harness, dir, manifest);
      } else {
        throw new Error(`Unknown provider gate: ${manifest.gate}`);
      }
    });
  }

  test(`OD source-adapter corpus regression stays within fit-quality thresholds on ${runtimeKind}`, async (t) => {
    const regressionFiles = listRegressionFiles();
    if (regressionFiles.length === 0) {
      t.skip("Add MEME files under tests/data/meme to run the broader OD regression corpus.");
      return;
    }

    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // Keep the default corpus small enough for the repo-wide WasmEdge matrix.
    // Larger public MEME sweeps stay available through OD_MEME_MAX_FILES.
    const maxFiles = Number.parseInt(process.env.OD_MEME_MAX_FILES ?? "5", 10);
    const files = regressionFiles.slice(0, Math.max(1, maxFiles));
    const celestrak = parseCelestrakCsv(
      process.env.OD_CELESTRAK_SUPGP_CSV ?? DEFAULT_CELESTRAK_CSV,
    );
    const results = [];

    for (const filePath of files) {
      const fit = await invokeFitJson(harness, fs.readFileSync(filePath), {
        dataSource: "SpaceX-E",
      });
      const noradId = noradIdFromMemePath(filePath);
      const rms = Number.parseFloat(fit.RMS);
      results.push({
        filePath,
        noradId,
        ok: Number.isFinite(rms) && rms <= 50 && !fit.error,
        rms,
      });
    }

    const summary = summarizeRegression(results, celestrak);
    assert.ok(
      summary.successCount >= Math.ceil(summary.count * 0.9),
      `Expected at least 90% successful fits, got ${summary.successCount}/${summary.count}.`,
    );
    assert.ok(
      summary.medianRms < 0.35,
      `Expected median RMS < 0.35 km, got ${summary.medianRms}.`,
    );
    if (summary.betterCount + summary.worseCount > 0) {
      assert.equal(
        summary.worseCount,
        0,
        `Expected every comparable OD fit to beat the optional CelesTrak reference (${summary.betterCount} better, ${summary.worseCount} not lower).`,
      );
    }
  });
}
