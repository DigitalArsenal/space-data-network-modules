#!/usr/bin/env node
/**
 * COMPOSER — assemble `vectors.json` from the three provenance tiers.
 *
 *   TIER A  authoritative, foreign: Tudat's own Lambert unit-test vectors,
 *           extracted mechanically by dump-tudat-vectors.mjs. Nothing in this
 *           repo produced these numbers.
 *   TIER B  textbook canonicals: inputs from named worked examples, expected
 *           values from the closed form, published answers cross-checked by
 *           gen-textbook-vectors.mjs (which refuses to emit on disagreement).
 *   TIER C  invariants: properties that must hold of ANY correct response,
 *           checked against the module's own output rather than against a
 *           stored number. Declared here, evaluated in vectors/index.mjs.
 *
 * KNOWN-DEFECT AND KNOWN-GAP ROWS. Some rows are marked `expectedToFail`.
 * They are not disabled tests: the runner asserts that they DO fail, and turns
 * an unexpected pass into a failure of its own. That is the only construction
 * under which "we know about it" survives contact with time — a skipped test
 * decays into a forgotten one, while a row that fails when the defect is fixed
 * forces a deliberate re-baseline in front of a human.
 *
 * Usage: node vectors/tools/build-vectors.mjs [--check]
 *   --check  regenerate in memory and diff against the committed file; exit 1
 *            on drift. This is what CI runs, so a hand-edited vectors.json
 *            cannot survive.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTextbookCases } from "./gen-textbook-vectors.mjs";
import { buildLibraryCases, libraryProvenance } from "./gen-library-vectors.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTRACT = path.resolve(HERE, "..", "tudat-extract.json");
const OUT = path.resolve(HERE, "..", "vectors.json");

/** The defect ledger: which graph task owns each known failure. */
const DEFECTS = {
  lambert:
    "modules-maneuver-lambert-returns-non-solutions — solveLambert reports " +
    "converged:true while returning a velocity that does not fly from r1 to " +
    "r2 in tof. Adjudicated by independent Kepler propagation (tier C " +
    "lambert-arrival-closure), not by disagreement with a reference.",
  combinedSplit:
    "the plane-change split optimisation is not implemented in " +
    "computeCombinedManeuver; the whole turn is taken at burn 2.",
};

/** Tier A: Tudat Lambert cases -> solveLambert vectors. */
async function tierA() {
  if (!existsSync(EXTRACT)) {
    throw new Error(
      `${EXTRACT} is missing. Run vectors/tools/dump-tudat-vectors.mjs first ` +
        "(it needs a tudat checkout to READ; tudat is never built).",
    );
  }
  const extract = JSON.parse(await readFile(EXTRACT, "utf8"));
  return extract.cases.map((entry) => {
    const { r1, r2, tof, mu, v1, v2, toleranceVelocity } = entry.values;
    const expect = {};
    for (let axis = 0; axis < 3; axis += 1) {
      expect[`v1.${axis}`] = v1[axis];
      expect[`v2.${axis}`] = v2[axis];
    }
    return {
      id: entry.id,
      tier: "A",
      operation: "solveLambert",
      params: { r1, r2, tof, mu, prograde: !entry.retrograde },
      expect,
      /**
       * The band is the SOURCE's own stated tolerance, floored at 1e-6
       * relative: nothing tighter than the reference's printed precision can
       * honestly be asserted, and nothing looser than what the source itself
       * demanded should be accepted.
       */
      band: {
        abs: 1e-9,
        rel: Math.max(toleranceVelocity, 1e-6),
        /**
         * The regression watermark sits THREE DECADES INSIDE the tolerance the
         * source itself demanded, floored at 1e-12 relative (the practical
         * agreement floor for an iterative solver in doubles).
         *
         * Deriving it from the source rather than fixing it globally is what
         * makes it meaningful: a fixed 1e-9 watermark alarms permanently on
         * Tudat's elliptical case, whose reference velocities are printed to
         * six significant figures and therefore cannot distinguish anything
         * below ~1e-5 relative. An alarm that is always on is an alarm nobody
         * reads.
         */
        alarmRel: Math.max(1e-12, toleranceVelocity * 1e-3),
        sourceTolerance: toleranceVelocity,
      },
      source: entry.source,
      note: entry.note,
    };
  });
}

/** Tier C: the invariant declarations (the evaluators live in index.mjs). */
function tierC() {
  return [
    {
      id: "vis-viva-closure",
      applies: "hohmannTransfer",
      statement:
        "circular speed at r1 plus the first burn equals the transfer orbit's " +
        "vis-viva speed at r1, and likewise at r2 before the second burn.",
    },
    {
      id: "delta-v-sum-identity",
      applies: "every operation reporting a total",
      statement: "totalDeltaV equals the sum of the reported burn magnitudes.",
    },
    {
      id: "rtn-eci-round-trip-per-component",
      applies: "every operation reporting a *_ric field",
      statement:
        "converting a RIC delta-v to inertial through ricBasis and back " +
        "reproduces it COMPONENT BY COMPONENT. Magnitude-only would pass " +
        "under the identity map that engine defect D1 applies.",
    },
    {
      id: "lambert-arrival-closure",
      applies: "solveLambert, solveLambertMinDV",
      statement:
        "propagating (r1, v1) forward by tof with an independent " +
        "universal-variable Kepler propagator arrives at r2, per component, " +
        "within 1e-6 of |r2|.",
    },
    {
      id: "lambert-earth-floor",
      applies: "solveLambert, solveLambertMinDV",
      statement:
        "the transfer conic the module REPORTS (perigeeRadius, apogeeRadius, " +
        "transferEccentricity, transferConic) reproduces an independent " +
        "reconstruction from the same returned v1, and the presence of an " +
        "apoapsis agrees with the conic type the module named. Also classifies " +
        "each arc above-surface / THROUGH-EARTH: six published conformance " +
        "geometries pass through the planet and are correct answers, which is " +
        "why the module REPORTS the perigee instead of refusing them.",
      changedAt:
        "0.3.0 — against 0.2.0 this invariant could only classify, because the " +
        "module published no perigee to check (graph: " +
        "modules-maneuver-lambert-publishes-no-transfer-perigee).",
    },
    {
      id: "lambert-mindv-ranks-its-own-set",
      applies: "solveLambertMinDV",
      statement:
        "the returned cost is the minimum of the candidate set the response " +
        "publishes, the returned (revolutions, branch) is a member of that set, " +
        "and the set is in canonical order (revolutions ascending, low before " +
        "high). This is what makes 'it ranked over BOTH branches' checkable " +
        "rather than asserted: 0.2.0 ranked over half its domain and no field " +
        "of a response distinguished that from a real minimum.",
    },
    {
      id: "phasing-earth-floor",
      applies: "phasingManeuver",
      statement:
        "classifies whether the phasing orbit's far apse clears Re + 100 km. " +
        "The module does not clamp it, so this invariant records rather than " +
        "fails — and the wrapper's guard is tested against exactly the cases " +
        "it classifies BELOW-FLOOR.",
    },
  ];
}

/**
 * TIER A: REPAIRED, not marked.
 *
 * These three Lambert geometries were held open as expected FAILURES from the
 * harness's first run until maneuver-planner 0.2.0. They are green now. The
 * markers came off in the same commit as the fix, exactly as the task demanded
 * — but they came off `vectors.json` BY HAND while this generator went on
 * applying them, so `build-vectors.mjs --check` had been failing on `main`
 * since that landing and nothing was running it. The repair record and the
 * recalibrated watermarks below are the hand edits, moved into the generator
 * where they belong: the file is reproducible again, and `--check` is now part
 * of `npm test` so it cannot rot silently a second time.
 */
const TIER_A_REPAIRED_NOTE =
  "Held open as an expected FAILURE from the harness's first run until 0.2.0. " +
  "The row is unchanged — same Tudat source, same tolerance, same adjudicating " +
  "invariant. What changed is the solver: the small-|z| derivative was y^3.5 " +
  "where BMW/Curtis give y^1.5, the non-zero branch was not the Curtis " +
  "expression either, `converged` was the literal true, and the residual was " +
  "never re-evaluated. The marker is removed in the SAME commit as the fix, " +
  "deliberately, so that neither the green run nor the red one is silent.";

const TIER_A_REPAIRED = {
  "tudat-izzo-hyperbolic": {
    /**
     * The watermarks below were RECALIBRATED when the rows flipped green. They
     * had been set while the rows were expected to FAIL, so none of them had
     * ever been measured against a working solver and every one fired on the
     * first green run. Each is now ~3-4x the measured agreement, with the
     * measurement written down beside it.
     */
    alarmRel: 1e-5,
    alarmRelRationale:
      "Measured 2.4e-6 relative at 0.2.0. Tudat prints this row to SIX " +
      "significant figures (-745.457, 156.743, 104.495, -693.209), so ~1e-6 is " +
      "the floor the PRINTED reference can support; nothing tighter is " +
      "assertable without asserting digits that were never published. Watermark " +
      "set just above it.",
  },
  "tudat-izzo-retrograde": {
    alarmRel: 3e-11,
    alarmRelRationale:
      "Measured 7.3e-12 relative at 0.2.0, against a reference Tudat quotes to " +
      "15 significant figures and gates itself at 1e-9. This is the " +
      "highest-authority row in the tier and the watermark is the tightest: at " +
      "3e-11 it is ~4x the observed agreement, so a solver change that costs an " +
      "order of magnitude shows up here first.",
  },
  "tudat-izzo-near-pi": {
    alarmRel: 3e-9,
    alarmRelRationale:
      "Measured 5.5e-10 relative at 0.2.0. The near-pi geometry is the one that " +
      "depends on the conditioning choices in the solver (|sin| from the cross " +
      "product, 1-cos from a unit-vector chord); reverting either takes this row " +
      "to ~3e-7, which is inside the 1e-6 gate and would otherwise pass " +
      "silently. This watermark is what makes that revert visible.",
  },
};

/** The elliptical row was never marked and needs no repair record. */
const TIER_A_UNMARKED_WATERMARK = { "tudat-izzo-elliptical": { alarmRel: 1e-5 } };

async function build() {
  const a = await tierA();
  for (const entry of a) {
    const override = TIER_A_REPAIRED[entry.id] ?? TIER_A_UNMARKED_WATERMARK[entry.id];
    if (override) {
      entry.band.alarmRel = override.alarmRel;
      if (override.alarmRelRationale) {
        entry.band.alarmRelRationale = override.alarmRelRationale;
      }
    }
    if (TIER_A_REPAIRED[entry.id]) {
      entry.repairedBy = {
        task: "modules-maneuver-lambert-returns-non-solutions",
        landedWith: "modules-maneuver-planner-rebuild-batch (maneuver-planner 0.2.0)",
        note: TIER_A_REPAIRED_NOTE,
      };
    }
  }
  const b = buildTextbookCases().map((entry) => {
    if (entry.id === "combined-optimal-split-KNOWN-GAP") {
      return { ...entry, expectedToFail: { ...entry.expectedToFail, defect: DEFECTS.combinedSplit } };
    }
    return entry;
  });

  const d = await buildLibraryCases();

  return {
    "//":
      "GENERATED by vectors/tools/build-vectors.mjs from tudat-extract.json " +
      "(tier A), gen-textbook-vectors.mjs (tier B) and hapsira-extract.json + " +
      "orekit-extract.json via gen-library-vectors.mjs (tier D). DO NOT " +
      "HAND-EDIT — `node vectors/tools/build-vectors.mjs --check` fails on " +
      "drift. Provenance for every row is in vectors/PROVENANCE.md.",
    schemaVersion: 2,
    conformance: {
      model: "two-body point-mass, impulsive burns",
      mu: 3.986004418e14,
      re: 6378137,
      units: "SI throughout: metres, m/s, seconds, radians",
      /**
       * Tier D rows carry their SOURCE's gravitational parameter in `params.mu`
       * rather than the pinned one. Orekit's Der case runs at EGM96's
       * 3.986004415e14 and hapsira's at the IAU 3.986004418e14 — the same
       * upstream geometry at two constants. Forcing both onto our pin would
       * turn a conformance check into a comparison of constants.
       */
      tierDUsesSourceMu: true,
    },
    tolerancePolicy: "fail <=> |observed - expected| > abs + rel * |expected|",
    libraries: await libraryProvenance(),
    invariants: tierC(),
    cases: [...a, ...b, ...d],
  };
}

const check = process.argv.includes("--check");
const built = await build();
const serialized = `${JSON.stringify(built, null, 2)}\n`;

if (check) {
  const existing = existsSync(OUT) ? await readFile(OUT, "utf8") : "";
  if (existing !== serialized) {
    process.stderr.write(
      "vectors.json is out of date with its generators. Regenerate with " +
        "`node vectors/tools/build-vectors.mjs` and review the diff — a vector " +
        "file that drifts from the script that produced it has no provenance.\n",
    );
    process.exit(1);
  }
  process.stderr.write(`build-vectors --check: ${built.cases.length} cases up to date\n`);
} else {
  await writeFile(OUT, serialized, "utf8");
  const failing = built.cases.filter((entry) => entry.expectedToFail).length;
  process.stderr.write(
    `build-vectors: ${built.cases.length} cases -> ${OUT} ` +
      `(${failing} marked expected-to-fail)\n`,
  );
}
