#!/usr/bin/env node
/**
 * TRANSCRIPT CAPTURE — record what the REAL artifact answers, verbatim.
 *
 * The console's maneuver wrapper cannot import the module SDK, so its unit
 * tests cannot instantiate the module. The alternative most codebases reach for
 * is a hand-written mock — and a hand-written mock of THIS module would be a
 * lie by construction, because the two things the wrapper exists to defend
 * against are precisely the things an author writing a mock would "fix" without
 * noticing: the `std::abs()` scalars with no RIC array beside them, and the
 * unclamped phasing semi-major axis.
 *
 * So the fixture is a RECORDING. Every response in it came out of
 * `dist/isomorphic/module.wasm` at the recorded content hash, and the wrapper's
 * decode path is therefore tested against real bytes with real defects in them.
 *
 * Regenerate whenever the artifact changes:
 *   node vectors/tools/capture-transcripts.mjs --out <path to fixture.json>
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createStandaloneHarness,
  invokeJsonRequest,
} from "../../../../tests/lib/isomorphicHarness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = new URL("../../dist/isomorphic/module.wasm", import.meta.url);
const DEFAULT_OUT = path.resolve(HERE, "..", "transcripts.json");

const MU = 3.986004418e14;

/**
 * The request set. Chosen to cover every decode path the console wrapper has,
 * INCLUDING the ones that only exist because the module is broken.
 */
const REQUESTS = [
  {
    id: "hohmann-300km-geo",
    why: "the canonical case; the only operation whose RIC arrays are serialised",
    request: { operation: "hohmannTransfer", params: { r1: 6678137, r2: 42164000, mu: MU } },
  },
  {
    id: "hohmann-leo-to-leo",
    why: "a small raise, the shape the HOHMANN card actually issues",
    request: { operation: "hohmannTransfer", params: { r1: 6778137, r2: 7078137, mu: MU } },
  },
  {
    id: "hohmann-lower",
    why: "r2 < r1: both burns are RETROGRADE, so the serialised RIC sign is load-bearing",
    request: { operation: "hohmannTransfer", params: { r1: 7078137, r2: 6778137, mu: MU } },
  },
  {
    id: "combined-28p5deg",
    why: "plane change folded into burn 2; the RIC split is NOT serialised and must be reconstructed",
    request: {
      operation: "combinedManeuver",
      params: { r1: 6678137, r2: 42164000, deltaInclination: 0.49741883681838395, mu: MU },
    },
  },
  {
    id: "bielliptic-leo-geo",
    why: "three burns, none of them carrying a serialised RIC array",
    request: {
      operation: "biEllipticTransfer",
      params: { r1: 6678137, r2: 42164000, rIntermediate: 120000000, mu: MU },
    },
  },
  {
    id: "phasing-catch-up",
    why: "positive phase angle: the phasing orbit is SMALLER and the departure burn is retrograde. The scalar is abs(); the sign must be recovered from phasingSMA.",
    request: {
      operation: "phasingManeuver",
      params: { currentRadius: 6778137, phaseAngle: 0.5235987755982988, numRevs: 3, mu: MU },
    },
  },
  {
    id: "phasing-fall-behind",
    why: "negative phase angle: larger orbit, prograde departure. Asymmetric with the catch-up case, which is why both are recorded.",
    request: {
      operation: "phasingManeuver",
      params: { currentRadius: 6778137, phaseAngle: -0.5235987755982988, numRevs: 3, mu: MU },
    },
  },
  {
    id: "phasing-underground",
    why: "170 degrees in one revolution: the module returns a phasing orbit roughly 4300 km BENEATH the surface, with no error. The wrapper's Earth guard is tested against THIS response, not against an invented one.",
    request: {
      operation: "phasingManeuver",
      params: { currentRadius: 6778137, phaseAngle: 2.9670597283903604, numRevs: 1, mu: MU },
    },
  },
  {
    id: "plane-change-15deg",
    why: "the other operation that serialises its RIC array",
    request: {
      operation: "planeChange",
      params: {
        orbitalRadius: 11480000,
        velocity: 5892.311,
        deltaInclination: 0.2617993877991494,
      },
    },
  },
  {
    id: "lambert-elliptical-arrives",
    why: "Tudat's elliptical case — the one geometry solveLambert gets right (5.8e-11 of |r2|). The wrapper's closure guard must ACCEPT this.",
    request: {
      operation: "solveLambert",
      params: {
        r1: [12756272, 0, 0],
        r2: [12756272, 22094511.219168257, 0],
        tof: 4033.8999999999996,
        mu: 398600441800000,
        prograde: true,
      },
    },
  },
  {
    id: "lambert-leo-does-not-arrive",
    why: "a routine 120-degree LEO transfer. The module reports converged:true and returns a velocity that misses by twenty times the target radius. The wrapper's closure guard must REFUSE this.",
    request: {
      operation: "solveLambert",
      params: {
        r1: [6678137, 0, 0],
        r2: [-3689068.5, 6389779.4, 0],
        tof: 5431.007,
        mu: MU,
        prograde: true,
      },
    },
  },
];

const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : DEFAULT_OUT;

const wasmPath = fileURLToPath(WASM);
const contentHash = createHash("sha256").update(await readFile(wasmPath)).digest("hex");

const harness = await createStandaloneHarness("browser", WASM);
const transcripts = [];
for (const entry of REQUESTS) {
  transcripts.push({
    id: entry.id,
    why: entry.why,
    request: entry.request,
    response: await invokeJsonRequest(harness, entry.request),
  });
}
await harness.destroy();

const payload = {
  "//":
    "RECORDED from the real maneuver-planner artifact by " +
    "analysis/maneuver/vectors/tools/capture-transcripts.mjs. NOT a mock: the " +
    "responses carry the shipped module's actual defects (abs()-only scalars, " +
    "unserialised RIC arrays, an unclamped phasing semi-major axis), which is " +
    "exactly what the console wrapper must be tested against. Regenerate when " +
    "the artifact changes.",
  artifact: {
    path: "analysis/maneuver/dist/isomorphic/module.wasm",
    sha256: contentHash,
  },
  capturedWith: "browser module harness (space-data-module-sdk)",
  transcripts,
};

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
process.stderr.write(
  `capture-transcripts: ${transcripts.length} transcripts from sha256 ${contentHash.slice(0, 16)} -> ${out}\n`,
);
