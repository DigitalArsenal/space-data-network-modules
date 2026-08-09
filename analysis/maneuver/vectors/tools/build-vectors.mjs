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
 * Known-defect marks applied to tier A rows.
 *
 * The three Lambert geometries below were adjudicated by propagation, not
 * assumed: each module answer was propagated forward and missed its target by
 * more than a quarter of the target radius while the reference's answer
 * arrived. The elliptical row is NOT marked — the module solves that one to
 * 5.8e-11 of |r2|, which is what makes the other three unambiguous rather than
 * a suspicion about the harness.
 */
const TIER_A_KNOWN_DEFECT = new Set([
  "tudat-izzo-hyperbolic",
  "tudat-izzo-retrograde",
  "tudat-izzo-near-pi",
]);

async function build() {
  const a = await tierA();
  for (const entry of a) {
    if (TIER_A_KNOWN_DEFECT.has(entry.id)) {
      entry.expectedToFail = { defect: DEFECTS.lambert };
    }
  }
  const b = buildTextbookCases().map((entry) => {
    if (entry.id === "combined-optimal-split-KNOWN-GAP") {
      return { ...entry, expectedToFail: { ...entry.expectedToFail, defect: DEFECTS.combinedSplit } };
    }
    return entry;
  });

  return {
    "//":
      "GENERATED by vectors/tools/build-vectors.mjs from tudat-extract.json " +
      "(tier A) and gen-textbook-vectors.mjs (tier B). DO NOT HAND-EDIT — " +
      "`node vectors/tools/build-vectors.mjs --check` fails on drift. " +
      "Provenance for every row is in vectors/PROVENANCE.md.",
    schemaVersion: 1,
    conformance: {
      model: "two-body point-mass, impulsive burns",
      mu: 3.986004418e14,
      re: 6378137,
      units: "SI throughout: metres, m/s, seconds, radians",
    },
    tolerancePolicy: "fail <=> |observed - expected| > abs + rel * |expected|",
    invariants: tierC(),
    cases: [...a, ...b],
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
