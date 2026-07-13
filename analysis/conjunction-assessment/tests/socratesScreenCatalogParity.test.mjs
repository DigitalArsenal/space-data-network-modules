// =============================================================================
// A2.8b SOCRATES replay lane — screen_catalog parity gate (node --test)
// =============================================================================
//
// Screens the checked-in SOCRATES window (tests/fixtures/socrates/, the exact
// GP elements CelesTrak SOCRATES used for its top-3 maxProb events, captured
// 2026-03-10) through the CA module's FlatBuffer screen_catalog and FAILS on
// any tolerance violation. Pure-node (raw singlethread wasm, no WasmEdge) and
// OFFLINE (celestrak.org is unreachable from CI; the checked-in window IS the
// fixture — fresh capture is a separate coordinator-gated step).
//
// Gate honesty (see tests/lib/caParityTolerances.mjs):
//   [independent-parity] event-set recall + rel-vel-stratified TCA + geometry
//                        vs SOCRATES's own GP elements (SGP4 == SGP4).
//   [regression-guard]   exact event count + miss-distance bound on the fixed
//                        6-object catalog (SOCRATES CSV range is quantized).
//   [same-family-advisory] Pc vs SOCRATES MAX_PROB (ALFANO-MAXPROB family):
//                        recorded + warned, NEVER a pass/fail axis.
// =============================================================================

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CA_PARITY_TOLERANCES } from "./lib/caParityTolerances.mjs";
import {
  buildOmmCatalogFrame,
  buildScreenCatalogRequest,
  compareToReference,
  initFlatc,
  invokeJsonOperation,
  isoToJd,
  loadRawConjunctionModule,
  runScreenCatalog,
  singlethreadArtifactExists,
} from "./lib/screenCatalogParityHarness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "socrates");
const T = CA_PARITY_TOLERANCES;

const ARTIFACT = singlethreadArtifactExists();

function loadReferenceWindow() {
  const reference = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, "reference.top3.json"), "utf8"),
  ).conjunctions;

  const catalogByNorad = new Map();
  for (const row of reference) {
    const gpFile = row.gp_file.replace(/\.txt$/i, ".json");
    const gpRecords = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, gpFile), "utf8"),
    );
    for (const record of gpRecords) {
      catalogByNorad.set(record.NORAD_CAT_ID, record);
    }
  }

  const referenceEvents = reference.map((row) => ({
    obj1Norad: row.obj1_norad,
    obj2Norad: row.obj2_norad,
    tcaJd: isoToJd(row.tca),
    missKm: row.min_range_km,
    relSpeedKms: row.rel_speed_kms,
    pc: row.max_prob,
  }));

  return { reference, catalog: [...catalogByNorad.values()], referenceEvents };
}

let ctx = null;
if (ARTIFACT) {
  const exports = await loadRawConjunctionModule();
  const flatc = await initFlatc();
  const { reference, catalog, referenceEvents } = loadReferenceWindow();

  // Screening window sized to the checked-in fixtures. SOCRATES nominal is a
  // 7-day forward screen (T.screening.socrates.durationDays); the top-3 window
  // spans TCAs with DSE up to 7.136 days after epoch, so the replay window
  // starts at the earliest GP epoch and is extended just enough to enclose the
  // latest reference TCA (kept honest, not tuned to change any event).
  const minEpochJd = Math.min(...catalog.map((gp) => isoToJd(gp.EPOCH)));
  const maxTcaJd = Math.max(...referenceEvents.map((e) => e.tcaJd));
  const startJd = minEpochJd - 0.05;
  const durationDays = Math.max(
    T.screening.socrates.durationDays,
    maxTcaJd - startJd + 0.25,
  );

  const requestBinary = buildScreenCatalogRequest(flatc, {
    sourceKind: "OMM",
    startJd,
    durationDays,
    thresholdKm: T.screening.socrates.thresholdKm,
    combinedRadiusM: T.screening.socrates.combinedRadiusM,
    coarseStepSec: T.screening.socrates.coarseStepSec,
    fineTolSec: T.screening.socrates.fineTolSec,
  });
  const catalogBinary = buildOmmCatalogFrame(flatc, catalog);
  const decoded = runScreenCatalog(exports, flatc, { requestBinary, catalogBinary });
  const cmp = compareToReference(decoded, referenceEvents);

  ctx = { reference, catalog, referenceEvents, decoded, cmp, startJd, durationDays };
}

function requireCtx(t) {
  if (!ARTIFACT) {
    t.skip(
      "dist/isomorphic-singlethread/module.wasm missing — build conjunction-assessment before the SOCRATES parity gate.",
    );
    return null;
  }
  return ctx;
}

test("SOCRATES: parity summary (measured deltas for the coordinator)", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  t.diagnostic(
    `catalog=${c.catalog.length} objectsParsed=${c.cmp.counts.objectsParsed} ` +
      `found=${c.cmp.counts.foundCount} matched=${c.cmp.counts.matchedCount} ` +
      `missing=${c.cmp.counts.missingCount} extra=${c.cmp.counts.extraCount} ` +
      `window=[${c.startJd.toFixed(3)},+${c.durationDays.toFixed(2)}d] thr=${T.screening.socrates.thresholdKm}km`,
  );
  for (const m of c.cmp.matched) {
    t.diagnostic(
      `pair ${m.key} [${m.stratum}] ` +
        `dTCA=${m.deltas.tcaDeltaSec.toFixed(5)}s ` +
        `dMiss=${m.deltas.missDeltaM.toFixed(3)}m ` +
        `dRelSpeed=${m.deltas.relSpeedDeltaMS.toFixed(3)}m/s ` +
        `PcRatio=${m.deltas.pcRatio == null ? "n/a" : m.deltas.pcRatio.toFixed(3)} ` +
        `(our=${m.event.minRangeKm.toFixed(6)}km ref=${m.reference.missKm}km)`,
    );
  }
  assert.ok(true);
});

test("SOCRATES: event set — full reference recall, no spurious events [independent-parity + regression-guard]", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  // All 6 objects parsed.
  assert.equal(c.cmp.counts.objectsParsed, c.catalog.length);
  // Recall: every reference pair reproduced.
  assert.equal(
    c.cmp.counts.missingCount,
    0,
    `missing reference pairs: ${c.cmp.missing.map((m) => `${m.obj1Norad}-${m.obj2Norad}`).join(",")}`,
  );
  // Precision: on this fixed catalog the event set is deterministic.
  assert.equal(
    c.cmp.counts.extraCount,
    T.eventSet.allowExtraEventsOnFixedCatalog,
    `unexpected extra events: ${c.cmp.extra.map((e) => `${e.obj1Norad}-${e.obj2Norad}`).join(",")}`,
  );
  assert.equal(c.cmp.counts.foundCount, c.referenceEvents.length);
});

test("SOCRATES: TCA within rel-vel-stratified tolerance [independent-parity]", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  for (const m of c.cmp.matched) {
    const band = T.tca[m.stratum];
    if (!band.gated) {
      t.diagnostic(`pair ${m.key} [${m.stratum}] TCA advisory dTCA=${m.deltas.tcaDeltaSec}s`);
      continue;
    }
    assert.ok(
      m.deltas.tcaDeltaSec <= band.hardFailSec,
      `pair ${m.key} [${m.stratum}] TCA delta ${m.deltas.tcaDeltaSec}s exceeded hard-fail ${band.hardFailSec}s`,
    );
  }
});

test("SOCRATES: miss distance within SOCRATES bound [regression-guard: CSV range quantized]", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  for (const m of c.cmp.matched) {
    assert.ok(
      m.deltas.missDeltaM <= T.missDistance.socratesHardFailM,
      `pair ${m.key} miss-distance delta ${m.deltas.missDeltaM}m exceeded ${T.missDistance.socratesHardFailM}m`,
    );
  }
});

test("SOCRATES: relative speed within bound", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  for (const m of c.cmp.matched) {
    if (m.deltas.relSpeedDeltaMS == null) continue;
    assert.ok(
      m.deltas.relSpeedDeltaMS <= T.relSpeed.hardFailMS,
      `pair ${m.key} rel-speed delta ${m.deltas.relSpeedDeltaMS}m/s exceeded ${T.relSpeed.hardFailMS}m/s`,
    );
  }
});

test("SOCRATES: Pc advisory — same-family, recorded not gated [same-family-advisory]", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  // Pc is NEVER a pass/fail axis (User's Guide + AMOS 2025). We record the
  // ratio vs SOCRATES MAX_PROB (same ALFANO-MAXPROB family), warn if outside
  // the advisory band, and only assert a gross-sanity ceiling.
  for (const m of c.cmp.matched) {
    if (m.deltas.pcRatio == null) continue;
    if (m.deltas.pcRatio > T.pc.socratesAdvisoryRatio) {
      t.diagnostic(
        `[Pc ADVISORY] pair ${m.key} Pc ratio ${m.deltas.pcRatio.toFixed(3)} ` +
          `exceeds ${T.pc.socratesAdvisoryRatio}x (our=${m.event.maxProbability} ref=${m.reference.pc}) — advisory only`,
      );
    }
    assert.ok(
      Number.isFinite(m.deltas.pcRatio) && m.deltas.pcRatio <= T.pc.sanityRatio,
      `pair ${m.key} Pc ratio ${m.deltas.pcRatio} breached gross-sanity ceiling ${T.pc.sanityRatio}x — likely a wiring bug`,
    );
  }
});
