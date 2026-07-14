// Live OMM parity report: fits fresh provider ephemerides with the OD module
// and prints per-object RMS vs the same-day CelesTrak SupGP RMS, plus the ISS
// same-ephemeris score (A2.4d owner ruling). Read-only over a
// tests/data/supgp-reference/<provider>/ pair dir; makes no network calls —
// capture pairs first (CELESTRAK_FETCH_POLICY applies to captures).
//
//   node scripts/live-parity-report.mjs <starlinkPairDir> <issPairDir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSuccessfulResponse,
  createStandaloneHarnessOrSkip,
} from "../../../tests/lib/isomorphicHarness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

function fitRequest(payload, options) {
  return {
    methodId: "fit",
    inputs: [
      { portId: "meme", payload },
      { portId: "options", payload: new TextEncoder().encode(JSON.stringify(options)) },
    ],
  };
}

async function fitJson(harness, payload, options) {
  const response = await harness.invoke(fitRequest(payload, options));
  const bytes = assertSuccessfulResponse(response, { outputPortId: "result" });
  return JSON.parse(new TextDecoder().decode(bytes));
}

function csvRows(csvPath) {
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",");
  const col = (name) => header.indexOf(name);
  return lines.slice(1).map((line) => {
    const f = line.split(",");
    return {
      name: f[col("OBJECT_NAME")],
      epoch: f[col("EPOCH")],
      norad: Number.parseInt(f[col("NORAD_CAT_ID")], 10),
      rms: Number.parseFloat(f[col("RMS")]),
    };
  });
}

const [starlinkDir, issDir] = process.argv.slice(2).map((p) => path.resolve(p));
const harness = await createStandaloneHarnessOrSkip("browser", WASM_PATH);
if (!harness) {
  console.error("no standalone runtime available");
  process.exit(1);
}

const generatedAt = new Date().toISOString();
const report = { generatedAt, starlink: [], iss: null };

{
  const manifest = JSON.parse(fs.readFileSync(path.join(starlinkDir, "provider.json"), "utf8"));
  const refByNorad = new Map(csvRows(path.join(starlinkDir, manifest.celestrakCsv)).map((r) => [r.norad, r]));
  const memeDir = path.join(starlinkDir, manifest.inputDir);
  for (const file of fs.readdirSync(memeDir).filter((f) => f.startsWith("MEME_")).sort()) {
    const norad = Number.parseInt(file.split("_")[1], 10);
    const ref = refByNorad.get(norad);
    const fit = await fitJson(harness, fs.readFileSync(path.join(memeDir, file)), {
      inputFormat: "meme",
      dataSource: manifest.source,
    });
    report.starlink.push({
      norad,
      name: ref?.name ?? file.split("_")[2],
      ourRms: Number.parseFloat(fit.RMS),
      celestrakRms: ref?.rms ?? NaN,
      celestrakEpoch: ref?.epoch ?? "",
      fitEpoch: fit.EPOCH,
    });
  }
}

{
  const manifest = JSON.parse(fs.readFileSync(path.join(issDir, "provider.json"), "utf8"));
  const oem = fs.readFileSync(path.join(issDir, manifest.inputFiles[0]));
  const base = {
    inputFormat: "oem",
    dataSource: manifest.source,
    objectName: manifest.objectName,
    objectId: manifest.objectId,
    noradCatId: manifest.noradCatId,
  };
  const plain = await fitJson(harness, oem, base);
  const refRows = csvRows(path.join(issDir, manifest.celestrakCsv))
    .filter((r) => r.norad === manifest.noradCatId);
  // Nearest CelesTrak segment to our fit epoch, then score ITS elements over
  // the SAME OEM states via refMeanMotion/ref* passthrough (REFERENCE_RMS).
  const fitEpochMs = Date.parse(plain.EPOCH);
  const nearest = refRows
    .map((r) => ({ ...r, d: Math.abs(Date.parse(`${r.epoch}Z`) - fitEpochMs) }))
    .sort((a, b) => a.d - b.d)[0];
  const csvLines = fs.readFileSync(path.join(issDir, manifest.celestrakCsv), "utf8").split(/\r?\n/);
  const header = csvLines[0].split(",");
  const row = csvLines.find((l) => l.startsWith(`${nearest.name},`)).split(",");
  const g = (n) => row[header.indexOf(n)];
  const scored = await fitJson(harness, oem, {
    ...base,
    refEpoch: g("EPOCH"),
    refMeanMotion: Number.parseFloat(g("MEAN_MOTION")),
    refEccentricity: Number.parseFloat(g("ECCENTRICITY")),
    refInclination: Number.parseFloat(g("INCLINATION")),
    refRaan: Number.parseFloat(g("RA_OF_ASC_NODE")),
    refArgPericenter: Number.parseFloat(g("ARG_OF_PERICENTER")),
    refMeanAnomaly: Number.parseFloat(g("MEAN_ANOMALY")),
    refBstar: Number.parseFloat(g("BSTAR")),
    refMeanMotionDot: Number.parseFloat(g("MEAN_MOTION_DOT")),
    refMeanMotionDdot: Number.parseFloat(g("MEAN_MOTION_DDOT")),
  });
  report.iss = {
    norad: manifest.noradCatId,
    segment: nearest.name,
    ourRms: Number.parseFloat(plain.RMS),
    celestrakSameEphemerisRms: Number.parseFloat(scored.REFERENCE_RMS),
    celestrakReportedInSampleRms: nearest.rms,
    deltaEpochSeconds: Math.round(nearest.d / 1000),
    fitEpoch: plain.EPOCH,
    celestrakEpoch: nearest.epoch,
  };
}

await harness.close?.();

const pad = (v, n) => String(v).padEnd(n);
console.log(`\nLIVE OMM PARITY vs CelesTrak SupGP — generated ${generatedAt}`);
console.log(`\nStarlink (beatsCelestrak, fresh MEME + fresh SupGP, matched by NORAD):`);
console.log(pad("NORAD", 7) + pad("OBJECT", 18) + pad("OURS km", 10) + pad("CELESTRAK km", 14) + "BEAT");
let beats = 0;
for (const r of report.starlink) {
  const beat = r.ourRms < r.celestrakRms;
  if (beat) beats += 1;
  console.log(
    pad(r.norad, 7) + pad(r.name, 18) + pad(r.ourRms.toFixed(3), 10)
    + pad(r.celestrakRms.toFixed(3), 14) + (beat ? "YES" : "no"),
  );
}
console.log(`beat ${beats}/${report.starlink.length}`);
if (report.iss) {
  const i = report.iss;
  console.log(`\nISS same-ephemeris (A2.4d): ours ${i.ourRms.toFixed(3)} km vs CelesTrak's own elements `
    + `${i.celestrakSameEphemerisRms.toFixed(3)} km on the identical NASA OEM `
    + `(${i.segment}, Δepoch ${i.deltaEpochSeconds}s; CelesTrak in-sample ${i.celestrakReportedInSampleRms})`);
}

const outPath = process.env.PARITY_REPORT_OUT;
if (outPath) {
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport written: ${outPath}`);
}
