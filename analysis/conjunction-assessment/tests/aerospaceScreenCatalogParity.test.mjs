// =============================================================================
// A2.8b Aerospace IVV lane — screen_catalog parity gate (node --test)
// =============================================================================
//
// Runs the CA module's FlatBuffer screen_catalog over an Aerospace-IVV-shaped
// OCM track catalog and FAILS on any tolerance violation. Two modes:
//
//   SYNTHETIC (default, always available in CI): the checked-in
//     tests/fixtures/aerospace-synthetic/ fixture — straight-line OCM tracks
//     with an INDEPENDENT analytic closed-form answer key (NOT real CSieve
//     data). Validates the screening/TCA/miss-distance machinery end-to-end,
//     offline, no WasmEdge. [independent-parity vs analytic + regression-guard]
//
//   REAL (when the genuine dataset is present locally): the same harness against
//     AerospaceIVVDataset_20251009a + its CSieve spherical answer key. The real
//     dataset is CC0 but ~21.74 GB and Google-account/OSC-gated — OWNER-ASSIST,
//     see docs/aerospace-ivv-acquisition.md for the one-command acquisition.
//     Trimmed to a representative window (AEROSPACE_PARITY_LIMIT rows).
//
// Pc is NOT gated in either mode (User's Guide + AMOS 2025 exclude Pc from CS
// validation; CSieve uses a different Alfano variant). Tolerances: single source
// of truth tests/lib/caParityTolerances.mjs.
// =============================================================================

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CA_PARITY_TOLERANCES } from "./lib/caParityTolerances.mjs";
import { parseAerospaceOcmText } from "./lib/aerospaceOcm.mjs";
import {
  getDefaultAerospaceReplayPaths,
  buildAerospaceOcmBasenameIndex,
} from "./lib/aerospaceReplayHarness.mjs";
import {
  listOcmDirectoryEntries,
  readCsvRows,
  readOcmDirectoryEntryText,
} from "./lib/aerospaceDataset.mjs";
import {
  buildScreenCatalogRequest,
  compareToReference,
  initFlatc,
  isoToJd,
  loadRawConjunctionModule,
  runScreenCatalog,
  singlethreadArtifactExists,
} from "./lib/screenCatalogParityHarness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = path.join(__dirname, "fixtures", "aerospace-synthetic");
const T = CA_PARITY_TOLERANCES;
const CFG = T.screening.aerospaceSpherical;
const REAL_LIMIT = Number(process.env.AEROSPACE_PARITY_LIMIT ?? 150);

const ARTIFACT = singlethreadArtifactExists();

function trackFromAerospaceOcm(ocm, fallbackNorad) {
  const samples = (ocm.primaryTrajectory?.samples ?? [])
    .filter((s) => s.positionKm && s.velocityKmS)
    .map((s) => ({
      jd: s.epochJD,
      xKm: s.positionKm.x,
      yKm: s.positionKm.y,
      zKm: s.positionKm.z,
      vxKmS: s.velocityKmS.x,
      vyKmS: s.velocityKmS.y,
      vzKmS: s.velocityKmS.z,
    }));
  const norad = Number(ocm.objectDesignator) || Number(fallbackNorad) || 0;
  return {
    sourcePluginId: "aerospace-ivv",
    sourceHandle: 0,
    objectName: ocm.objectName || `OBJ-${norad}`,
    objectId: ocm.objectId || "",
    noradCatId: norad,
    referenceFrame: ocm.referenceFrame || "ICRF",
    samples,
  };
}

function csvRowsSync(csvPath) {
  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

// --- SYNTHETIC loader (checked-in, analytic answer key) ---------------------
function loadSynthetic() {
  const ocmDir = path.join(SYNTHETIC_DIR, "ocm");
  const tracks = fs
    .readdirSync(ocmDir)
    .filter((f) => f.endsWith(".ocm"))
    .sort()
    .map((f) =>
      trackFromAerospaceOcm(
        parseAerospaceOcmText(fs.readFileSync(path.join(ocmDir, f), "utf8"), {
          sourcePath: f,
        }),
        f.replace(/\.ocm$/i, ""),
      ),
    );
  const referenceEvents = csvRowsSync(
    path.join(SYNTHETIC_DIR, "answer_key_spherical.csv"),
  ).map((r) => ({
    obj1Norad: Number(r.obj1),
    obj2Norad: Number(r.obj2),
    tcaJd: Number(r.jdate),
    missKm: Number(r.min_range),
    relSpeedKms: Number(r.Vrel),
    pc: r.prob === "NULL" || r.prob == null ? null : Number(r.prob),
    stratum: r.stratum,
  }));
  const startJd = isoToJd(CFG.windowStartIso) - 0.01;
  const durationDays = 0.02;
  return { mode: "synthetic", tracks, referenceEvents, startJd, durationDays };
}

// --- REAL loader (genuine dataset present locally; OWNER-ASSIST) ------------
async function loadRealIfPresent() {
  const paths = getDefaultAerospaceReplayPaths();
  if (!paths.extractedRoot) return null;
  try {
    fs.accessSync(paths.ocmRoot);
    fs.accessSync(paths.sphericalAnswerKeyPath);
  } catch {
    return null;
  }

  // Trim to a representative window: the first REAL_LIMIT answer-key rows.
  const rows = [];
  for await (const row of readCsvRows(paths.sphericalAnswerKeyPath, { limit: REAL_LIMIT })) {
    rows.push(row);
  }
  const index = await buildAerospaceOcmBasenameIndex(paths.ocmRoot);
  const wantedFiles = new Set();
  for (const r of rows) {
    wantedFiles.add(String(r.obj1_filename));
    wantedFiles.add(String(r.obj2_filename));
  }
  const tracks = [];
  for (const fileName of wantedFiles) {
    const entry = index.get(fileName);
    if (!entry) continue;
    const text = await readOcmDirectoryEntryText(paths.ocmRoot, entry);
    const ocm = parseAerospaceOcmText(text, { sourcePath: entry });
    tracks.push(trackFromAerospaceOcm(ocm, fileName.replace(/\.ocm$/i, "")));
  }
  const referenceEvents = rows.map((r) => ({
    obj1Norad: Number(r.obj1),
    obj2Norad: Number(r.obj2),
    tcaJd: Number(r.jdate),
    missKm: Number(r.min_range),
    relSpeedKms: Number(r.Vrel ?? r.vrel),
    pc: null, // Pc report-only; not gated vs CSieve
    stratum: null, // derived from measured rel speed in-harness
  }));
  const startJd = isoToJd(CFG.windowStartIso);
  const durationDays =
    isoToJd(CFG.windowStopIso) - isoToJd(CFG.windowStartIso);
  return { mode: "real", tracks, referenceEvents, startJd, durationDays };
}

let ctx = null;
if (ARTIFACT) {
  const exports = await loadRawConjunctionModule();
  const flatc = await initFlatc();
  const lane = (await loadRealIfPresent()) ?? loadSynthetic();

  const requestBinary = buildScreenCatalogRequest(flatc, {
    sourceKind: "OCM",
    schemaName: "OCM/main.fbs",
    fileIdentifier: "$OCM",
    primaryTracks: lane.tracks,
    startJd: lane.startJd,
    durationDays: lane.durationDays,
    thresholdKm: CFG.thresholdKm,
    combinedRadiusM: CFG.combinedRadiusM,
    coarseStepSec: CFG.coarseStepSec,
    fineTolSec: CFG.fineTolSec,
    usePerigeeFilter: false, // tracks (ephemeris), not GP — no perigee prefilter
  });
  const decoded = runScreenCatalog(exports, flatc, { requestBinary });
  const cmp = compareToReference(decoded, lane.referenceEvents);
  ctx = { lane, decoded, cmp };
}

function requireCtx(t) {
  if (!ARTIFACT) {
    t.skip(
      "dist/isomorphic-singlethread/module.wasm missing — build conjunction-assessment before the Aerospace parity gate.",
    );
    return null;
  }
  return ctx;
}

test("Aerospace: parity summary (mode + measured deltas for the coordinator)", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  t.diagnostic(
    `mode=${c.lane.mode} tracks=${c.lane.tracks.length} objectsParsed=${c.cmp.counts.objectsParsed} ` +
      `refEvents=${c.cmp.counts.referenceCount} found=${c.cmp.counts.foundCount} ` +
      `matched=${c.cmp.counts.matchedCount} missing=${c.cmp.counts.missingCount} extra=${c.cmp.counts.extraCount} ` +
      `thr=${CFG.thresholdKm}km HBR=${CFG.combinedRadiusM}m`,
  );
  if (c.lane.mode === "synthetic") {
    t.diagnostic(
      "SYNTHETIC fixture (analytic answer key) — real 21.74GB CSieve dataset is OWNER-ASSIST; see docs/aerospace-ivv-acquisition.md",
    );
  }
  for (const m of c.cmp.matched) {
    t.diagnostic(
      `pair ${m.key} [${m.stratum}] dTCA=${m.deltas.tcaDeltaSec.toFixed(6)}s ` +
        `dMiss=${m.deltas.missDeltaM.toFixed(4)}m dRelSpeed=${m.deltas.relSpeedDeltaMS?.toFixed(4)}m/s`,
    );
  }
  assert.ok(true);
});

test("Aerospace: event set — full answer-key recall (+ precision on synthetic control)", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  // Recall: every answer-key event must be reproduced (both modes).
  assert.equal(
    c.cmp.counts.missingCount,
    0,
    `missing answer-key events: ${c.cmp.missing.map((m) => `${m.obj1Norad}-${m.obj2Norad}`).join(",")}`,
  );
  if (c.lane.mode === "synthetic") {
    // Deterministic catalog: control pair (>threshold) must be excluded -> 0 extras.
    assert.equal(
      c.cmp.counts.extraCount,
      T.eventSet.allowExtraEventsOnFixedCatalog,
      `unexpected extra events: ${c.cmp.extra.map((e) => `${e.obj1Norad}-${e.obj2Norad}`).join(",")}`,
    );
  } else if (c.cmp.counts.extraCount > 0) {
    // Real trimmed catalog: extras may be genuine conjunctions among the sampled
    // objects (no full ground truth) — advisory, not a fail.
    t.diagnostic(
      `[precision advisory] ${c.cmp.counts.extraCount} extra events in trimmed real catalog (no ground truth for these)`,
    );
  }
});

test("Aerospace: TCA within rel-vel-stratified tolerance [NLRV gated]", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  for (const m of c.cmp.matched) {
    const band = T.tca[m.stratum] ?? T.tca.VLRV;
    if (!band.gated) {
      t.diagnostic(`pair ${m.key} [${m.stratum}] TCA advisory dTCA=${m.deltas.tcaDeltaSec}s (flat-minimum regime)`);
      continue;
    }
    assert.ok(
      m.deltas.tcaDeltaSec <= band.hardFailSec,
      `pair ${m.key} [${m.stratum}] TCA delta ${m.deltas.tcaDeltaSec}s exceeded hard-fail ${band.hardFailSec}s`,
    );
  }
});

test("Aerospace: miss distance within ≤10cm bound [independent-parity: full precision]", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  for (const m of c.cmp.matched) {
    assert.ok(
      m.deltas.missDeltaM <= T.missDistance.aerospaceHardFailM,
      `pair ${m.key} miss-distance delta ${m.deltas.missDeltaM}m exceeded ${T.missDistance.aerospaceHardFailM}m`,
    );
  }
});

test("Aerospace: Pc report-only (CSieve uses a different Alfano variant — not gated)", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  // Explicitly NOT compared/gated against CSieve. Recorded for completeness.
  t.diagnostic(
    `Pc not gated vs CSieve (User's Guide + AMOS 2025). our maxProbability values: ` +
      c.cmp.matched.map((m) => `${m.key}=${m.event.maxProbability}`).join(" "),
  );
  assert.ok(true);
});
