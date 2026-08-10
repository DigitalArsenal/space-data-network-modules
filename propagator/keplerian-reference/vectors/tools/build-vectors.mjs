#!/usr/bin/env node
/**
 * Generate (or --check) vectors/vectors.json.
 *
 * Tier B rows are computed from the CLOSED FORM in ../index.mjs, never by
 * running the module. Two independent implementations of two-body motion —
 * one in C++ inside the wasm, one in JS here — agreeing to 1e-9 relative is
 * evidence; one implementation agreeing with a recording of itself is not.
 *
 * The generator REFUSES TO EMIT when a row fails its own internal consistency
 * check (energy closure on the anchor it is about to write). That refusal is
 * the property the maneuver suite proved out: a generator that will happily
 * write a physically impossible expectation cannot be trusted to have written
 * a possible one.
 *
 *   node vectors/tools/build-vectors.mjs            # write
 *   node vectors/tools/build-vectors.mjs --check    # fail on drift
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BANDS,
  MU,
  inertialMagnitudes,
  propagateTwoBody,
} from "../index.mjs";

const vectorsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputPath = path.join(vectorsDir, "vectors.json");

/**
 * The element sets. Chosen to span the regimes a propagator gets wrong:
 * near-circular LEO (the common case), a high-eccentricity Molniya (where a
 * lazy Kepler solve diverges), an exactly-circular equatorial orbit (where
 * argument of perigee and RAAN are degenerate), and a retrograde sun-synch
 * (where an inclination sign error hides).
 */
const CASES = [
  {
    id: "leo-near-circular",
    note: "ISS-like near-circular LEO. The common case, and the one whose errors are least visible.",
    elements: {
      epochJd: 2460000.5,
      meanMotionRevPerDay: 15.5,
      eccentricity: 0.0006703,
      inclinationDeg: 51.64,
      raOfAscNodeDeg: 208.9163,
      argOfPericenterDeg: 30.8756,
      meanAnomalyDeg: 329.2838,
      noradCatId: 25544,
    },
    offsetsMinutes: [0, 10, 45, 96, 1440],
  },
  {
    id: "molniya-high-eccentricity",
    note: "e = 0.72. A Kepler solver that starts from M instead of pi wanders here; a fixed-iteration solver silently returns a wrong anomaly.",
    elements: {
      epochJd: 2460000.5,
      meanMotionRevPerDay: 2.006,
      eccentricity: 0.72,
      inclinationDeg: 63.4,
      raOfAscNodeDeg: 45.0,
      argOfPericenterDeg: 270.0,
      meanAnomalyDeg: 0.0,
      noradCatId: 99001,
    },
    offsetsMinutes: [0, 60, 359, 718],
  },
  {
    id: "circular-equatorial-degenerate",
    note: "e = 0 and i = 0: argument of perigee and RAAN are both undefined-but-declared. A propagator that divides by e or by sin(i) fails here.",
    elements: {
      epochJd: 2460000.5,
      meanMotionRevPerDay: 1.0027,
      eccentricity: 0.0,
      inclinationDeg: 0.0,
      raOfAscNodeDeg: 0.0,
      argOfPericenterDeg: 0.0,
      meanAnomalyDeg: 123.456,
      noradCatId: 99002,
    },
    offsetsMinutes: [0, 240, 719],
  },
  {
    id: "sun-synchronous-retrograde",
    note: "i = 98.2 deg, retrograde. An inclination handled as |i| puts the ground track on the wrong side and is invisible in a single-orbit plot.",
    elements: {
      epochJd: 2460000.5,
      meanMotionRevPerDay: 14.57,
      eccentricity: 0.001,
      inclinationDeg: 98.2,
      raOfAscNodeDeg: 12.5,
      argOfPericenterDeg: 90.0,
      meanAnomalyDeg: 270.0,
      noradCatId: 99003,
    },
    offsetsMinutes: [0, 33, 99],
  },
];

/**
 * The generator's own refusal: specific orbital energy must be conserved
 * along the arc it is about to record. If it is not, the anchor is wrong and
 * the row is never written.
 */
function assertEnergyClosure(caseSpec) {
  const base = inertialMagnitudes(caseSpec.elements, caseSpec.elements.epochJd);
  const referenceEnergy = -MU / (2 * base.semiMajorAxis);
  for (const minutes of caseSpec.offsetsMinutes) {
    const jd = caseSpec.elements.epochJd + minutes / 1440;
    const { radius, speed } = inertialMagnitudes(caseSpec.elements, jd);
    const energy = (speed * speed) / 2 - MU / radius;
    const relative = Math.abs((energy - referenceEnergy) / referenceEnergy);
    if (!(relative < 1e-12)) {
      throw new Error(
        `REFUSING TO EMIT ${caseSpec.id} at +${minutes} min: specific orbital energy ` +
          `drifted by ${relative.toExponential(3)} relative, which means the anchor this ` +
          `generator was about to write is not on the orbit it claims. Fix the closed form, ` +
          `never the tolerance.`,
      );
    }
  }
}

function buildDocument() {
  const cases = [];
  for (const caseSpec of CASES) {
    assertEnergyClosure(caseSpec);
    for (const minutes of caseSpec.offsetsMinutes) {
      const jd = caseSpec.elements.epochJd + minutes / 1440;
      const state = propagateTwoBody(caseSpec.elements, jd);
      cases.push({
        id: `${caseSpec.id}@+${minutes}min`,
        tier: "B",
        operation: "plugin_propagate",
        note: caseSpec.note,
        params: { elements: caseSpec.elements, julianDate: jd },
        expect: {
          "position.0": state.position[0],
          "position.1": state.position[1],
          "position.2": state.position[2],
          "velocity.0": state.velocity[0],
          "velocity.1": state.velocity[1],
          "velocity.2": state.velocity[2],
          epoch: jd,
          reference_frame: 3,
          flags: 1,
        },
        band: { position: BANDS.position, velocity: BANDS.velocity, time: BANDS.time },
        source: {
          kind: "closed-form",
          derivation:
            "Two-body motion from mean elements: a = (mu/n^2)^(1/3); Kepler's equation " +
            "solved by Newton-Raphson; perifocal->inertial by the classical 3-1-3 " +
            "rotation; inertial->ECEF by rotation about Z through GMST (IAU 1982) with " +
            "the -omega x r velocity term.",
          generator: "vectors/tools/build-vectors.mjs via vectors/index.mjs",
          mu: MU,
          muNote: "WGS-72, the model the mean elements were fitted under.",
        },
      });
    }
  }

  return {
    "//":
      "GENERATED by vectors/tools/build-vectors.mjs. DO NOT HAND-EDIT — " +
      "`npm run vectors:check` fails on drift. Provenance for every row is in " +
      "vectors/PROVENANCE.md.",
    schemaVersion: 1,
    conformance: {
      model: "two-body point-mass, no drag, no J2, no third bodies",
      mu: MU,
      units: "SI throughout: metres, metres/second, Julian days, degrees on input",
      outputFrame: "ECEF (ORBPRO_FRAME_ECEF = 3)",
    },
    tolerancePolicy: "fail <=> |observed - expected| > abs + rel * |expected|",
    invariants: [
      {
        id: "vis-viva-closure",
        tier: "C",
        applies: "every propagated state",
        statement:
          "v^2/2 - mu/r, computed in the INERTIAL frame from the module's own ECEF " +
          "output by undoing the Earth-rotation term, equals -mu/(2a) for the a implied " +
          "by the ingested mean motion. No stored expectation.",
      },
      {
        id: "period-closure",
        tier: "C",
        applies: "every element set",
        statement:
          "Propagating forward by exactly one orbital period returns the same INERTIAL " +
          "position. Verified by propagation, not by a recorded value.",
      },
      {
        id: "determinism",
        tier: "C",
        applies: "every case",
        statement:
          "The same inputs produce BYTE-IDENTICAL 64-byte state vectors across repeated " +
          "calls, and across a destroy/re-ingest cycle. Compared as bytes, not as numbers.",
      },
      {
        id: "frame-and-flags-declared",
        tier: "C",
        applies: "every propagated state",
        statement:
          "reference_frame is ECEF and the VALID flag is set on success; the three " +
          "padding bytes at offsets 57..59 are zero. A propagator that leaves the frame " +
          "field at its default is unreadable by a host that honours it.",
      },
      {
        id: "refusal-is-typed",
        tier: "C",
        applies: "every documented failure",
        statement:
          "Each failure mode returns its own documented negative code. A propagator that " +
          "returns -1 for everything cannot be placed on the degradation ladder.",
      },
    ],
    cases,
  };
}

const document = buildDocument();
const serialized = `${JSON.stringify(document, null, 2)}\n`;
const check = process.argv.includes("--check");

if (check) {
  const existing = await fs.readFile(outputPath, "utf8").catch(() => null);
  if (existing === null) {
    console.error(`vectors:check FAIL — ${path.basename(outputPath)} does not exist.`);
    process.exit(1);
  }
  if (existing !== serialized) {
    console.error(
      `vectors:check FAIL — vectors.json is not reproducible from ` +
        `vectors/tools/build-vectors.mjs. Regenerate with \`npm run vectors:build\`, ` +
        `and if the numbers moved, say WHY in vectors/PROVENANCE.md before committing.`,
    );
    process.exit(1);
  }
  console.log(`vectors:check PASS — ${document.cases.length} case(s) reproduce exactly.`);
} else {
  await fs.writeFile(outputPath, serialized, "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), outputPath)} (${document.cases.length} cases)`);
}
