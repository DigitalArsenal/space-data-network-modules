// =============================================================================
// A2.8b — CA parity tolerances (SINGLE SOURCE OF TRUTH)
// =============================================================================
//
// Every per-metric tolerance the A2.8b parity gates enforce lives HERE so the
// App-2 coordinator can lift the numbers straight into the task packet
// (coordination/tasks/app2-supplemental-omm.md, A2.8b bullet). Both lane
// suites import this module; no test hardcodes a tolerance inline.
//
// Grounding: docs/a2.8a-ca-parity-ground-truth.md (the promoted A2.8a research
// report) — §Q5 tolerance table + the AMOS 2025 measured tool-vs-tool deltas.
//
// Honesty labels (per owner directive — never mislabel a gate):
//   [independent-parity]  our result vs a genuinely independent reference
//                         (SOCRATES's own GP elements; analytic closed form).
//   [same-family-advisory] compared, recorded, warned — but NOT a pass/fail
//                         axis (Pc: different method family, cannot gate).
//   [regression-guard]    a fixed checked-in fixture whose exact answer is
//                         deterministic; the bound guards against a future
//                         module regression, tightened to just above the
//                         MEASURED delta with the reason documented.
//
// CALIBRATION (measured 2026-07-13, pure-node singlethread wasm, screen_catalog):
//   SOCRATES checked-in window (3 NLRV pairs, gp_*.json @ 2026-03-10):
//     TCA delta   : 0.0001-0.0009 s  (all < 1 ms target)
//     miss-dist   : 0.23-4.33 m      (dominated by CSV range quantization, see below)
//     rel-speed   : 0.10-0.48 m/s
//     Pc ratio    : 1.0x / 1.7x / 1.9x vs SOCRATES MAX_PROB (all < 10x)
//   Synthetic Aerospace linear-motion pairs (analytic answer key):
//     VLRV (5 m/s)   : TCA exact, miss exact to mm.
//     NLRV realistic : TCA sub-ms, miss sub-mm when miss >> (relSpeed*fineTolSec).
//     LRV/VLRV TCA is INTRINSICALLY loose vs an analytic point-TCA (flat
//     minimum: |rel(dt)| = sqrt(miss^2 + (relSpeed*dt)^2) is nearly flat for
//     small relSpeed) — this is physics, not a defect. AMOS Table 2 and the
//     User's Guide both de-emphasize LRV/VLRV TCA; the BAR there is
//     "event found + miss distance", so LRV/VLRV TCA is recorded, not gated.
// =============================================================================

// --- relative-velocity strata (m/s), from AMOS 2025 Table 2 -----------------
export const REL_VEL_STRATA = Object.freeze({
  // >= NLRV_MIN_MS  -> NLRV (non-low rel velocity): tight TCA + geometry.
  // [LRV_MIN_MS, NLRV_MIN_MS) -> LRV (low): looser.
  // <  LRV_MIN_MS   -> VLRV (very low): event-found is the bar.
  NLRV_MIN_MS: 50.0,
  LRV_MIN_MS: 10.0,
});

export function relVelStratum(relSpeedKms) {
  const ms = Math.abs(Number(relSpeedKms)) * 1000.0;
  if (!Number.isFinite(ms)) return "unknown";
  if (ms >= REL_VEL_STRATA.NLRV_MIN_MS) return "NLRV";
  if (ms >= REL_VEL_STRATA.LRV_MIN_MS) return "LRV";
  return "VLRV";
}

export const CA_PARITY_TOLERANCES = Object.freeze({
  version: "a2.8b-2026-07-13",
  provenance: "docs/a2.8a-ca-parity-ground-truth.md (§Q5 + AMOS 2025 Table 2)",

  // --- TCA deltas, rel-vel stratified ---------------------------------------
  // targetSec = the value a healthy tool hits (AMOS measured); hardFailSec =
  // the pass/fail bound. gated=false => recorded + reported but not pass/fail
  // (LRV/VLRV flat-minimum TCA cannot be gated against an analytic point-TCA).
  tca: Object.freeze({
    NLRV: Object.freeze({ targetSec: 0.001, hardFailSec: 0.010, gated: true }),  // AMOS: avg 0.01 ms, max 1.7 ms
    LRV: Object.freeze({ targetSec: 0.010, hardFailSec: 10.0, gated: false }),   // AMOS suggests ~0.01 s tool-vs-tool; loose vs analytic
    VLRV: Object.freeze({ targetSec: 10.0, hardFailSec: 10.0, gated: false }),   // "event found" is the bar
  }),

  // --- miss-distance deltas --------------------------------------------------
  missDistance: Object.freeze({
    // [independent-parity] Aerospace/CSieve reports full-precision min_range and
    // the synthetic analytic key is exact — so ≤10 cm is enforceable. AMOS
    // measured max 6.8 cm / avg 2.8 mm between two independent passing tools.
    aerospaceHardFailM: 0.10,
    aerospaceTargetM: 0.01,
    // [regression-guard] SOCRATES CSV TCA_RANGE is quantized to ~0.001-0.01 km,
    // so a 10 cm gate is IMPOSSIBLE against it (a 0.01-km-reported near-hit
    // carries a ±5 m rounding band). Bound set just above the measured 4.33 m
    // max; also absorbs independent-SGP4 differences at sub-15 m ranges.
    socratesHardFailM: 5.0,
  }),

  // --- rel-speed delta (secondary geometry check) ---------------------------
  relSpeed: Object.freeze({
    hardFailMS: 5.0, // measured max 0.48 m/s on the SOCRATES window; guard bound
  }),

  // --- event set (recall / precision) ---------------------------------------
  eventSet: Object.freeze({
    // Every reference pair MUST be reproduced. Missing an NLRV reference pair
    // is a hard fail (both references treat near-100% NLRV recall as the bar).
    requireFullReferenceRecall: true,
    // Extra events beyond the reference set are only tolerated within a
    // threshold-rounding band (AMOS accepted 2-vs-4 boundary artifacts at
    // exactly the screening threshold). On a FIXED checked-in catalog the
    // count is deterministic, so extras are [regression-guard] hard-gated to 0.
    boundaryRoundingM: 0.10,
    allowExtraEventsOnFixedCatalog: 0,
  }),

  // --- Pc: [same-family-advisory] -------------------------------------------
  // NEVER a pass/fail axis. The User's Guide and AMOS 2025 both exclude Pc
  // from CS validation ("direct comparison of Pc values requires the same
  // method of Pc computation and is therefore not a key metric").
  pc: Object.freeze({
    gated: false,
    // vs SOCRATES only (both ALFANO-MAXPROB family): warn if outside 10x.
    socratesAdvisoryRatio: 10.0,
    // vs Aerospace/CSieve (Alfano-2004 variant): report only, no comparison bound.
    aerospaceCompared: false,
    // gross-sanity flag (a >1000x gap signals a wiring bug, not method drift);
    // still non-fatal — surfaced to the coordinator, never fails the suite.
    sanityRatio: 1000.0,
  }),

  // --- screening-volume configurations --------------------------------------
  screening: Object.freeze({
    // SOCRATES Plus: 5 km spherical, 7-day forward, SGP4.
    socrates: Object.freeze({
      thresholdKm: 5.0,
      durationDays: 7.0,
      combinedRadiusM: 10.0, // affects Pc only; SOCRATES uses Alfano max-prob
      coarseStepSec: 60.0,
      fineTolSec: 0.001,
      probabilityMethod: "ALFANO-MAXPROB",
    }),
    // Aerospace IVV Round 1: single 10 km spherical volume, default HBR 0.5 m.
    aerospaceSpherical: Object.freeze({
      thresholdKm: 10.0,
      combinedRadiusM: 0.5, // default HBR 0.5 m
      coarseStepSec: 30.0,
      fineTolSec: 0.001,
      windowStartIso: "2025-01-01T12:00:00Z",
      windowStopIso: "2025-01-08T12:00:00Z",
      maxOdAgeDays: 14,
    }),
    // Aerospace IVV Round 2: SFSH rectangular per-object volumes (8 regime
    // buckets, U/V/W radial/in-track/cross-track half-volumes, km). Documented
    // here for the real-dataset run; the synthetic fixture uses the spherical
    // config. Asymmetric: A-within-B's-volume does not imply the reverse.
    aerospaceSfsh: Object.freeze({
      volumesKm: Object.freeze([
        Object.freeze({ id: 1, u: 10, v: 10, w: 10, regime: "DeepSpace-T3" }),
        Object.freeze({ id: 2, u: 0.4, v: 2, w: 2, regime: "LEO4" }),
        Object.freeze({ id: 3, u: 0.4, v: 12, w: 12, regime: "LEO3" }),
        Object.freeze({ id: 4, u: 0.4, v: 25, w: 25, regime: "LEO2" }),
        Object.freeze({ id: 5, u: 0.4, v: 44, w: 51, regime: "LEO1" }),
        Object.freeze({ id: 6, u: 20, v: 20, w: 20, regime: "DeepSpace-T4" }),
        Object.freeze({ id: 7, u: 2, v: 25, w: 25, regime: "LEO/NearEarth-T4" }),
        Object.freeze({ id: 8, u: 20, v: 50, w: 20, regime: "Hyperbolic-testonly" }),
      ]),
    }),
  }),
});

export default CA_PARITY_TOLERANCES;
