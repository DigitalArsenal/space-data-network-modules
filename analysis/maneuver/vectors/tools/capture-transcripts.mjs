#!/usr/bin/env node
/**
 * TRANSCRIPT CAPTURE — record what the REAL artifact answers, verbatim.
 *
 * The console's maneuver wrapper cannot import the module SDK, so its unit
 * tests cannot instantiate the module. The alternative most codebases reach for
 * is a hand-written mock — and a hand-written mock of THIS module would be a
 * lie by construction, because the things the wrapper exists to handle are
 * precisely the things an author writing a mock would "fix" without noticing.
 *
 * So the fixture is a RECORDING. Every response in it came out of
 * `dist/isomorphic/module.wasm` at the recorded content hash, and the wrapper's
 * decode path is therefore tested against real bytes.
 *
 * WHAT 0.2.0 CHANGED, and why every "why" line below was rewritten: the
 * recording made against 0.1.0 captured a module with no error path, unsigned
 * scalars where a RIC array had been computed and dropped, an unclamped phasing
 * semi-major axis, and a Lambert solver that answered `converged: true` for
 * arcs that do not arrive. Three of those are gone. A transcript set whose
 * commentary still describes them would send the next reader looking for
 * defects that are not there — and worse, the wrapper's guards are now testing
 * against responses that no longer need guarding, which is how a workaround
 * outlives its cause.
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
    why: "the canonical case. In 0.1.0 this was the ONLY operation whose RIC arrays reached a caller; every operation that computes one now serialises it.",
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
    why: "plane change folded into burn 2. The in-track/cross-track split of that burn was computed by 0.1.0 and dropped at the JSON boundary, so the console reconstructed it from aTransfer; dv2_ric now carries it. signSource must be \"serialised\".",
    request: {
      operation: "combinedManeuver",
      params: { r1: 6678137, r2: 42164000, deltaInclination: 0.49741883681838395, mu: MU },
    },
  },
  {
    id: "bielliptic-leo-geo",
    why: "three burns. 0.1.0 emitted no RIC array for any of them and dropped aTransfer1/aTransfer2 as well; all five are serialised now.",
    request: {
      operation: "biEllipticTransfer",
      params: { r1: 6678137, r2: 42164000, rIntermediate: 120000000, mu: MU },
    },
  },
  {
    id: "phasing-catch-up",
    why: "positive phase angle: the phasing orbit is SMALLER and the departure burn is retrograde. The scalar is still abs(), but dv1_ric now carries the sign, so the console no longer has to recover it from sign(phasingSMA - currentRadius).",
    request: {
      operation: "phasingManeuver",
      params: { currentRadius: 6778137, phaseAngle: 0.5235987755982988, numRevs: 3, mu: MU },
    },
  },
  {
    id: "phasing-fall-behind",
    why: "negative phase angle: larger orbit, prograde departure. Asymmetric with the catch-up case, which is why both are recorded — a sign convention that is right in one direction and wrong in the other passes a single-direction test.",
    request: {
      operation: "phasingManeuver",
      params: { currentRadius: 6778137, phaseAngle: -0.5235987755982988, numRevs: 3, mu: MU },
    },
  },
  {
    id: "phasing-underground",
    why: "170 degrees in one revolution. 0.1.0 returned a phasing orbit whose far apse was ~4300 km BENEATH the surface with no error and no flag. 0.2.0 clamps to Re+100 km and REPORTS it: clampedToEarthFloor true, farApse at the floor, achievedPhaseAngle showing what the clamped orbit actually delivers (0.207 rad, not the 2.967 requested). The console's own Earth guard is now defence in depth rather than the only guard.",
    request: {
      operation: "phasingManeuver",
      params: { currentRadius: 6778137, phaseAngle: 2.9670597283903604, numRevs: 1, mu: MU },
    },
  },
  {
    id: "plane-change-15deg",
    why: "a pure cross-track burn — the case where a RIC array that is right in magnitude but wrong in AXIS would still look plausible.",
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
    why: "Tudat's elliptical case. In 0.1.0 this was the one geometry solveLambert got right, which is what made the rest of the Lambert finding unambiguous. It still arrives, now alongside a residual and an honest converged flag.",
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
    id: "lambert-leo-arrives",
    why: "a routine 120-degree LEO transfer. THIS IS THE ROW THAT FLIPPED: 0.1.0 answered converged:true and returned a departure velocity that missed by roughly twenty times the target radius, and the console wrapper had to refuse it by propagating the answer itself. 0.2.0 arrives to ~1e-11 of |r2|. The wrapper's closure guard must now ACCEPT it — and the guard is what proves the flip rather than merely asserting it.",
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

/**
 * Refusals. `invokeJsonRequest` asserts a zero status, so it cannot record one
 * — and a transcript set with no refusals in it would leave the consumer's
 * error-decode path tested against nothing at all. These go through the raw
 * invoke surface and record the status code alongside the body.
 */
const REFUSALS = [
  {
    id: "error-unknown-operation",
    why: "the shape of every refusal: non-zero statusCode, a stable errorCode, and a response FRAME carrying {error, errorCode}. 0.1.0 trapped here and poisoned the instance.",
    request: { operation: "noSuchOperation", params: {} },
  },
  {
    id: "error-missing-parameter",
    why: "a missing required parameter names the parameter. The console can surface this text directly instead of guessing.",
    request: { operation: "hohmannTransfer", params: { r1: 6678137 } },
  },
  {
    id: "error-validator-message-is-reachable",
    why: "the module's OWN validator, verbatim — '[phasing]: Number of revolutions must be >= 1'. Written by the author of computePhasingManeuver and unreachable for the whole life of 0.1.0.",
    request: { operation: "phasingManeuver", params: { currentRadius: 6778137, phaseAngle: 0.5, numRevs: 0 } },
  },
  {
    id: "error-lambert-no-solution",
    why: "an antipodal geometry has no unique Lambert solution and 0.2.0 says so. 0.1.0 answered converged:true with velocities that fly nowhere near the target — the defect that kept LAMBERT and RENDEZVOUS embargoed in the console.",
    request: { operation: "solveLambert", params: { r1: [6778000, 0, 0], r2: [-6778000, 0, 0], tof: 2700, mu: MU } },
  },
];

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
for (const entry of REFUSALS) {
  const raw = await harness.invoke({
    methodId: "invoke",
    inputs: [
      {
        portId: "request",
        payload: Buffer.from(JSON.stringify(entry.request), "utf8"),
      },
    ],
  });
  const frame = raw.outputs?.find((output) => output.portId === "response");
  transcripts.push({
    id: entry.id,
    why: entry.why,
    request: entry.request,
    statusCode: raw.statusCode,
    errorCode: raw.errorCode,
    response: frame ? JSON.parse(new TextDecoder().decode(frame.payload)) : null,
  });
}
await harness.destroy();

const payload = {
  "//":
    "RECORDED from the real maneuver-planner artifact by " +
    "analysis/maneuver/vectors/tools/capture-transcripts.mjs. NOT a mock. " +
    "Captured against maneuver-planner 0.2.0, which repaired the four things " +
    "the previous recording documented: the module now has a working error " +
    "path (every refusal is {error, errorCode}, nothing traps), every " +
    "operation that computes a RIC array serialises it, phasing clamps to the " +
    "Earth floor and says so, and solveLambert arrives. Refusal transcripts " +
    "are recorded too — a caller has to decode those as carefully as answers. " +
    "Regenerate when the artifact changes.",
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
