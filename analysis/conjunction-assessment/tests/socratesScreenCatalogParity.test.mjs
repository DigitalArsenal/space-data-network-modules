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
//   [regression-guard]   no event on a pair SOCRATES did not report + miss-
//                        distance bound on the fixed 6-object catalog
//                        (SOCRATES CSV range is quantized).
//   [same-family-advisory] Pc vs SOCRATES MAX_PROB (ALFANO-MAXPROB family):
//                        recorded + warned, NEVER a pass/fail axis.
//
// Every close approach within the threshold is its own event, so a reported
// pair can appear again at other TCAs of the window (48282-58288 meets once an
// orbit on 03-12 and 03-16). The reference is SOCRATES's top three by maximum
// probability, not its full listing: those other conjunctions are checked as
// conjunctions (their own local minimum within the threshold, confirmed by the
// pair solver, and ranked below the three by maximum probability), not
// counted as spurious.
// =============================================================================

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CA_PARITY_TOLERANCES } from "./lib/caParityTolerances.mjs";
import { decodeCqr, earthFrame, encodeCqr, gpSource, screeningControls } from "./lib/cqr.mjs";
import {
  buildOmmCatalogFrame,
  buildScreenCatalogRequest,
  compareToReference,
  initFlatc,
  invokeRaw,
  isoToJd,
  loadRawConjunctionModule,
  runScreenCatalog,
  primaryArtifactExists,
} from "./lib/screenCatalogParityHarness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "socrates");
const T = CA_PARITY_TOLERANCES;

const ARTIFACT = primaryArtifactExists();

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

  // Each other conjunction of a reported pair, solved again by the pair
  // method on its own two-minute window: the engine TCA solver (LAAS_2015
  // selects ConjunctionEngine, a separate implementation from the screener's
  // refinement), 5 s coarse step, 1 ms tolerance.
  const gpByNorad = new Map(catalog.map((gp) => [gp.NORAD_CAT_ID, gp]));
  const resolved = cmp.otherTcas.map((event) => {
    const request = encodeCqr(flatc, { PAIR_REQUEST: {
      PRIMARY: gpSource(gpByNorad.get(event.obj1Norad)),
      SECONDARY: gpSource(gpByNorad.get(event.obj2Norad)),
      CONTROLS: { ...screeningControls({ startJd: event.tcaJd - 60 / 86400, durationSeconds: 120, coarseStepSec: 5,
        thresholdKm: T.screening.socrates.thresholdKm, fineTolSec: T.screening.socrates.fineTolSec }), ALGORITHM: "LAAS_2015" },
      PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame("TEME"),
    } });
    const response = invokeRaw(exports, "assess_conjunction", [{ portId: "request", bytes: request }]);
    const pair = response.statusCode === 0 ? decodeCqr(flatc, response.outputs[0].payload).EVENT_RESULT : null;
    return { event, statusCode: response.statusCode, errorMessage: response.errorMessage, pair };
  });

  ctx = { reference, catalog, referenceEvents, decoded, cmp, resolved, startJd, durationDays };
}

function requireCtx(t) {
  if (!ARTIFACT) {
    t.skip(
      "dist/isomorphic/module.wasm missing — build conjunction-assessment before the SOCRATES parity gate.",
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
      `missing=${c.cmp.counts.missingCount} otherTcas=${c.cmp.counts.otherTcaCount} ` +
      `otherPairs=${c.cmp.counts.otherPairCount} ` +
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
  // Recall: every reference conjunction reproduced.
  assert.equal(
    c.cmp.counts.missingCount,
    0,
    `missing reference pairs: ${c.cmp.missing.map((m) => `${m.obj1Norad}-${m.obj2Norad}`).join(",")}`,
  );
  assert.equal(c.cmp.counts.matchedCount, c.referenceEvents.length);
  // Precision: on this fixed catalog no pair SOCRATES did not report comes
  // within the threshold.
  assert.equal(
    c.cmp.counts.otherPairCount,
    T.eventSet.allowExtraEventsOnFixedCatalog,
    `unexpected extra events: ${c.cmp.otherPairs.map((e) => `${e.obj1Norad}-${e.obj2Norad}`).join(",")}`,
  );
});

test("SOCRATES: other conjunctions of the reported pairs are distinct close approaches [regression-guard: same SGP4, separate TCA solver]", (t) => {
  const c = requireCtx(t);
  if (!c) return;
  const thresholdM = T.screening.socrates.thresholdKm * 1000;
  const endJd = c.startJd + c.durationDays;
  // SOCRATES ranks by maximum probability; its top three end at this value.
  const lowestReferencePc = Math.min(...c.referenceEvents.map((r) => r.pc));
  for (const { event, statusCode, errorMessage, pair } of c.resolved) {
    const label = `${event.obj1Norad}-${event.obj2Norad} @ ${event.tcaJd}`;
    assert.ok(event.minRangeKm * 1000 <= thresholdM, `${label} is beyond the threshold`);
    assert.ok(event.tcaJd >= c.startJd && event.tcaJd <= endJd, `${label} is outside the window`);
    assert.ok(event.maxProbability < lowestReferencePc, `${label} would rank inside SOCRATES's top three`);
    assert.equal(statusCode, 0, `${label}: ${errorMessage}`);
    t.diagnostic(`${label} miss=${(event.minRangeKm * 1000).toFixed(3)}m pair-solver dTCA=${(Math.abs(pair.TCA.JULIAN_DATE - event.tcaJd) * 86400).toFixed(5)}s dMiss=${Math.abs(pair.MISS_DISTANCE_M - event.minRangeKm * 1000).toFixed(4)}m`);
    assert.ok(Math.abs(pair.TCA.JULIAN_DATE - event.tcaJd) * 86400 <= T.tca.NLRV.hardFailSec, `${label}: pair solver TCA differs`);
    assert.ok(Math.abs(pair.MISS_DISTANCE_M - event.minRangeKm * 1000) <= T.missDistance.aerospaceHardFailM, `${label}: pair solver miss differs`);
  }
  // Distinct close approaches: no two events of a pair within two coarse steps.
  const byPair = new Map();
  for (const e of c.decoded.conjunctions) {
    const key = [e.obj1Norad, e.obj2Norad].sort((a, b) => a - b).join("-");
    byPair.set(key, [...(byPair.get(key) ?? []), e.tcaJd].sort((a, b) => a - b));
  }
  for (const [key, tcas] of byPair) {
    for (let i = 1; i < tcas.length; i++) {
      assert.ok((tcas[i] - tcas[i - 1]) * 86400 > 2 * T.screening.socrates.coarseStepSec, `${key}: two events ${((tcas[i] - tcas[i - 1]) * 86400).toFixed(3)} s apart`);
    }
  }
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
