// One SGP4 mode across the stack (modules-sgp4-one-mode-20261031). analysis/epoch-state 0.4.0, analysis/gp-error-model 0.12.0,
// analysis/maneuver-detection 0.9.0 and analysis/private-screening 0.3.0 run foundation/sgp4-str3 in AFSPC mode, the mode of
// propagator/sgp4 1.4.0 and of the conjunction screen, where they ran the improved mode. The modes agree on near-Earth sets
// and on deep-space sets away from a node crossing; they part on the five low-inclination deep-space sets whose node
// passes 0 (propagator/sgp4's tests/fixtures/spacetrack-gp, Space-Track's 2026-10-29 snapshot), up to 4.4 km for 40942.
// Epochs and instants are whole multiples of 675 s (1/128 day) from UTC midnight, so every Julian date, elapsed time and
// minute count is exactly representable and each implementation sees the same bits: the checks compare algorithms, not the
// rounding of a clock.
//
// (1) Node crossing. 40942 (epoch 2026-10-26T05:26:15, 3.2 s from its published epoch; node 0 near 2026-10-31T07:23):
//     - epoch-state answers its TEME trajectory from 06:56:15 to 09:33:45 at 675 s; every state is propagator/sgp4's within 1 mm
//       and 1 mm/s;
//     - gp-error-model's element_residuals scores the set against those states (prediction minus ephemeris) at 1 mm at most;
//     - private-screening's consecutive-set agreement (features, gp view) for the set and its copy at an epoch 2.9 days later is
//       the RTN difference of propagator/sgp4's states, within 1 mm. 33461 serves (the node reaches 0 within the three days a
//       consecutive pair may span; 40942's does not).
//     Each check sees the mode: the same base built natively in improved mode (tests/evidence/str3/library_states.cpp, the
//     control) is hundreds of meters off at the compared instants. A build of the previous release fails (1):
//     SGP4_ONE_MODE_ROOT=<modules tree of cfd7ee626>.
// (2) Near-Earth (ISS 25544). The two modes run the same code: the numbers of each module are those of the previous release,
//     bit for bit (SHA-256 recorded from cfd7ee626's builds). Labels differ where a module names its mode ("improved mode" in
//     epoch-state's COMMENT and PROVIDER, gp-error-model's report "model"), so the digests hold the numbers only.
// (3) maneuver-detection does not propagate: it takes SGP4's un-Kozai'd mean motion (xnodp), computed before any mode-dependent
//     code, to place a set in an error-model regime. Its outputs are those of 0.8.0 byte for byte, over the node-crossing and
//     the near-Earth histories (the version it writes into PRODUCER and ALGORITHM aside). This check passes on 0.8.0 as well.
// Run: node --test tests/sgp4OneMode.e2e.mjs (needs the dists built, clang++ and the installs of analysis/gp-error-model and propagator/sgp4;
// nothing is installed or written to the tree). SGP4_ONE_MODE_RECORD=1 prints the digests of (2) and (3) instead of checking them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(here, "..");
// The tree whose analysis/<module>/dist is under test: this checkout, or another (a build of the previous release).
const under = path.resolve(process.env.SGP4_ONE_MODE_ROOT ?? modules);
const record = process.env.SGP4_ONE_MODE_RECORD === "1";
// Existing installs only: analysis/gp-error-model's (SDK 0.9.12, SDS 1.261.0, flatbuffers, flatc-wasm).
const installed = createRequire(path.join(modules, "analysis/gp-error-model/package.json"));
const sdsRoot = path.dirname(installed.resolve("spacedatastandards.org/package.json"));
const load = (file) => import(pathToFileURL(file).href);
const { createBrowserModuleHarness } = await load(installed.resolve("space-data-module-sdk/host/browser-module"));
const createFlatc = (await load(installed.resolve("flatc-wasm/module"))).default;
const flatbuffers = installed("flatbuffers");
const [OMM, OEM, LFV, MNV] = await Promise.all(["OMM", "OEM", "LFV", "MNV"].map((code) => load(path.join(sdsRoot, `lib/js/${code}/main.js`))));
const { invokePiv, loadRawSgp4Module } = await load(path.join(modules, "propagator/sgp4/tests/lib/pivInvokeHelper.mjs"));
const { ReferenceFrame, decodePropagatorState, encodeOmmPayload, encodePropagatorBatchRequest } = await load(path.join(modules, "propagator/sgp4/tests/lib/payloadEncoders.mjs"));
const { ARM_OF, decode: decodeErm, encode: encodeErm, ERM_TYPE } = await load(path.join(modules, "analysis/gp-error-model/scripts/erm-codec.mjs"));

const TYPE = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: "flatbuffer" });
const OMM_REF = { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const PROP_REF = { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" };
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// ── the sets and the instants ─────────────────────────────────────────────────────────────────────────────────────────
const published = JSON.parse(fs.readFileSync(path.join(modules, "propagator/sgp4/tests/fixtures/spacetrack-gp/gp-2026-10-29.json"), "utf8"));
function fixtureSet(noradId, epoch) {
  const r = published.find((row) => Number(row.NORAD_CAT_ID) === noradId);
  return { noradId, epoch, meanMotion: Number(r.MEAN_MOTION), eccentricity: Number(r.ECCENTRICITY), inclination: Number(r.INCLINATION),
    raan: Number(r.RA_OF_ASC_NODE), argPericenter: Number(r.ARG_OF_PERICENTER), meanAnomaly: Number(r.MEAN_ANOMALY), bstar: Number(r.BSTAR),
    objectId: r.OBJECT_ID, objectName: r.OBJECT_NAME, meanMotionDot: 0, meanMotionDdot: 0 };
}
const NODE = fixtureSet(40942, "2026-10-26T05:26:15.000000");   // node 0 near 2026-10-31T07:23
const NEAR = fixtureSet(25544, "2026-10-28T14:15:00.000000");   // the ISS
const PAIR_A = fixtureSet(33461, "2026-10-27T22:52:30.000000"); // node 0 near 2026-10-30T16:09, 2.8 days on
const PAIR_B = { ...PAIR_A, noradId: 99002, epoch: "2026-10-30T20:26:15.000000" }; // the same elements 250,425 s later
const instants = (start, count) => Array.from({ length: count }, (_, k) => new Date(Date.parse(`${start}Z`) + k * 675000).toISOString().slice(0, 19));
const NODE_WINDOW = instants("2026-10-31T06:56:15", 15);   // three samples before the crossing, twelve after
const NEAR_WINDOW = instants("2026-10-29T00:00:00", 33);   // eight hours of the ISS
// The Julian date propagator/sgp4 holds an ISO instant at: the 367-day rule and the fraction of a day (sgp4_base.hpp julianDay).
function julianDate(iso) {
  const [, y, mo, d, h, mi, s] = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d(?:\.\d+)?)/.exec(iso).map(Number);
  const jd = 367.0 * y - Math.floor((7 * (y + Math.floor((mo + 9) / 12.0))) * 0.25) + Math.floor((275 * mo) / 9.0) + d + 1721013.5;
  return jd + (s + mi * 60.0 + h * 3600.0) / 86400.0;
}
const minutesFrom = (set, iso) => (julianDate(iso) - julianDate(set.epoch)) * 1440.0;

// ── the reference: propagator/sgp4 1.4.0 (dist/browser), TEME ─────────────────────────────────────────────────────────
async function referenceStates(sets, windows) {
  const sgp4 = await loadRawSgp4Module();
  try {
    for (const s of sets) {
      const ingest = invokePiv(sgp4, { methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: OMM_REF, payload: encodeOmmPayload(s) }] });
      assert.equal(ingest.response.STATUS_CODE, 0, ingest.response.ERROR_MESSAGE);
    }
    return sets.map((s, k) => windows[k].map((iso) => {
      const answer = invokePiv(sgp4, { methodId: "propagate_state", outputStreamCap: 1, inputs: [{ portId: "request", typeRef: PROP_REF,
        payload: encodePropagatorBatchRequest({ epoch: julianDate(iso), catalogNumbers: [s.noradId], outputFrame: ReferenceFrame.TEME }) }] });
      assert.equal(answer.response.STATUS_CODE, 0, answer.response.ERROR_MESSAGE);
      const state = decodePropagatorState(answer.outputPayloads[0].bytes);
      assert.ok(state.valid, `${s.noradId} at ${iso}: propagator/sgp4 refuses the state`);
      return { iso, position: [...state.position], velocity: [...state.velocity] };  // m, m/s
    }));
  } finally {
    sgp4._plugin_destroy();
  }
}
// The control: the same base built natively in improved mode (built once), TEME km, at the minutes from the set's epoch.
let controlDriver;
function improvedStates(set, window) {
  if (!controlDriver) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "sgp4-one-mode-"));
    process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
    controlDriver = path.join(work, "library_states");
    execFileSync("clang++", ["-std=c++17", "-O2", `-I${path.join(modules, "foundation/sgp4-str3/include")}`,
      path.join(modules, "propagator/sgp4/tests/evidence/str3/library_states.cpp"), "-o", controlDriver]);
  }
  const input = [julianDate(set.epoch), set.meanMotion, set.eccentricity, set.inclination, set.raan, set.argPericenter, set.meanAnomaly, set.bstar,
    window.length, ...window.map((iso) => minutesFrom(set, iso))].map((x) => (Number.isInteger(x) ? String(x) : x.toPrecision(17))).join(" ");
  return execFileSync(controlDriver, ["improved"], { input: `${input}\n`, encoding: "utf8" }).split("X\n")[0].trim().split("\n")
    .map((line) => { const [, status, ...rv] = line.split(" ").map(Number); assert.equal(status, 0); return rv; });
}
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ── the modules under test ────────────────────────────────────────────────────────────────────────────────────────────
async function invokeModule(name, methodId, inputs, config = {}) {
  const dir = path.join(under, "analysis", name);
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(dir, "dist/isomorphic/module.wasm")),
    manifest: JSON.parse(fs.readFileSync(path.join(dir, "plugin-manifest.json"), "utf8")), surface: "direct", hostOptions: { config } });
  try {
    const response = await harness.invoke({ methodId, inputs });
    assert.equal(response.statusCode, 0, `${name} ${methodId}: ${response.errorMessage}`);
    return response;
  } finally {
    await harness.destroy();
  }
}
const finishPrefixed = (build, finish) => { const b = new flatbuffers.Builder(1 << 16); finish(b, build(b)); return Buffer.from(b.asUint8Array()); };
function ommRecord(s) {
  const t = Object.assign(new OMM.OMMT(), { EPOCH: s.epoch, NORAD_CAT_ID: s.noradId, OBJECT_ID: s.objectId, OBJECT_NAME: s.objectName,
    MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4, MEAN_MOTION: s.meanMotion, ECCENTRICITY: s.eccentricity, INCLINATION: s.inclination,
    RA_OF_ASC_NODE: s.raan, ARG_OF_PERICENTER: s.argPericenter, MEAN_ANOMALY: s.meanAnomaly, BSTAR: s.bstar });
  return finishPrefixed((b) => t.pack(b), (b, root) => OMM.OMM.finishSizePrefixedOMMBuffer(b, root));
}
const ommStream = (sets) => Buffer.concat(sets.map(ommRecord));
// A $PRW from its JSON form and back, through flatc and the standards' own schema.
let flatcReady;
const flatc = () => (flatcReady ??= (async () => {
  const f = await createFlatc();
  for (const dir of ["/schemas", "/in", "/out"]) f.FS.mkdir(dir);
  for (const family of fs.readdirSync(path.join(sdsRoot, "schema"))) {
    const schema = path.join(sdsRoot, "schema", family, "main.fbs");
    if (!fs.existsSync(schema)) continue;
    f.FS.mkdir(`/schemas/${family}`);
    f.FS.writeFile(`/schemas/${family}/main.fbs`, fs.readFileSync(schema, "utf8"));
  }
  return f;
})());
async function prw(value) {
  const f = await flatc();
  f.FS.writeFile("/in/request.json", JSON.stringify(value));
  assert.equal(f.callMain(["-b", "--no-warnings", "-I", "/schemas", "-o", "/out", "/schemas/PRW/main.fbs", "/in/request.json"]), 0, "flatc -b PRW");
  return Buffer.from(f.FS.readFile("/out/request.bin"));
}
async function prwJson(bytes) {   // plain or size-prefixed
  const f = await flatc();
  const prefixed = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === bytes.length - 4;
  f.FS.writeFile("/in/reply.bin", bytes);
  assert.equal(f.callMain(["-t", "--no-warnings", "--strict-json", "--defaults-json", ...(prefixed ? ["--size-prefixed"] : []), "-I", "/schemas", "-o", "/out", "/schemas/PRW/main.fbs", "--", "/in/reply.bin"]), 0, "flatc -t PRW");
  return JSON.parse(f.FS.readFile("/out/reply.json", { encoding: "utf8" }));
}
const utc = (iso) => ({ TIME_SYSTEM: "UTC", EPOCH_FORMAT: "ISO8601", ISO8601: `${iso}Z` });
function decodeOems(bytes) {
  const out = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length; ) {
    const size = view.getUint32(at, true);
    if (size) out.push(OEM.OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(bytes.slice(at, at + 4 + size))).unpack());
    at += 4 + (size || 0);
  }
  return out;
}
const recorded = {};
function expectDigest(name, digest) {
  recorded[name] = digest;
  if (!record) assert.equal(digest, RECORDED[name], `${name}: differs from the previous release's`);
}

// What the previous release (cfd7ee626's builds) gave on the near-Earth inputs below (SHA-256).
const RECORDED = {
  "epoch-state ISS trajectory": "42c5ed17ead28491648c1f3d8aeb0a77a0a2e8b4ca1e0da66c080d4a119ad12c",
  "gp-error-model ISS residuals": "d3dd205ccb50b5648f077830fee5d0abfe4b1ea9d253e5aa4a83b20700a6f6ea",
  "private-screening ISS pair features": "7378aba666acae346d191200dd9311fb2d68c723058a8b8c6025bb9957df712c",
  "maneuver-detection propagation_requests": "875cfb24800f37b0513a6b9187776648553c03d96bc634a24e561ea11a298126",
  "maneuver-detection report": "ec4a0603cb589607294836e3ed19bc9ee1279e4c1d90261c1d198d1c375524c2",
  "maneuver-detection maneuvers": "4fdd41a2d6065629ecd4b963c9622cbc1e1ddd02f2f51e5bab81cfb5b9fbb8ce",
};

// ── epoch-state: answer_propagation_requests, one request for both sets ───────────────────────────────────────────────
let epochStateAnswers;
const epochState = () => (epochStateAnswers ??= (async () => {
  const response = await invokeModule("epoch-state", "answer_propagation_requests", [
    { portId: "requests", typeRef: TYPE("PRW"), payload: await prw({ WINDOW_REQUEST: { QUERIES: [
      { SEQUENCE: 0, SET_INDEX: 0, OBJECT_KEY: "NORAD:40942", START: utc(NODE_WINDOW[0]), STOP: utc(NODE_WINDOW.at(-1)), STEP_SECONDS: 675 },
      { SEQUENCE: 1, SET_INDEX: 1, OBJECT_KEY: "NORAD:25544", START: utc(NEAR_WINDOW[0]), STOP: utc(NEAR_WINDOW.at(-1)), STEP_SECONDS: 675 }] } }) },
    { portId: "element_sets", typeRef: TYPE("OMM"), payload: ommStream([NODE, NEAR]) }]);
  return decodeOems(new Uint8Array(response.outputs.find((f) => f.portId === "propagation").payload)).map((oem) => oem.EPHEMERIS_DATA_BLOCK[0]);
})());

test("epoch-state: across 40942's node crossing its trajectory is propagator/sgp4's within 1 mm", async () => {
  const [ref] = await referenceStates([NODE], [NODE_WINDOW]);
  const [crossing] = await epochState();
  assert.equal(crossing.EPHEMERIS_DATA.length, 6 * NODE_WINDOW.length);
  const control = improvedStates(NODE, NODE_WINDOW);
  let dr = 0, dv = 0, modeGap = 0, apart = 0;
  NODE_WINDOW.forEach((iso, k) => {
    const r = crossing.EPHEMERIS_DATA.slice(6 * k, 6 * k + 3).map((x) => x * 1000), v = crossing.EPHEMERIS_DATA.slice(6 * k + 3, 6 * k + 6).map((x) => x * 1000);
    dr = Math.max(dr, distance(r, ref[k].position));
    dv = Math.max(dv, distance(v, ref[k].velocity));
    const gap = distance(control[k].slice(0, 3).map((x) => x * 1000), ref[k].position);
    modeGap = Math.max(modeGap, gap);
    if (gap > 100) apart++;
  });
  assert.ok(apart >= 12, `the improved mode is more than 100 m from propagator/sgp4 at only ${apart} of ${NODE_WINDOW.length} instants: the window misses the crossing`);
  assert.ok(dr <= 1e-3 && dv <= 1e-3, `epoch-state is ${dr} m and ${dv} m/s from propagator/sgp4 (the improved mode is up to ${modeGap.toFixed(1)} m)`);
  console.log(`epoch-state 40942: ${dr.toExponential(2)} m, ${dv.toExponential(2)} m/s from propagator/sgp4 over ${NODE_WINDOW.length} instants; the improved mode is up to ${modeGap.toFixed(1)} m`);
  assert.match(crossing.COMMENT, /WGS-72 constants, AFSPC mode, every 675 s/);
});

test("epoch-state: the ISS trajectory's numbers are the previous release's, bit for bit", async () => {
  const [, near] = await epochState();
  assert.equal(near.EPHEMERIS_DATA.length, 6 * NEAR_WINDOW.length);
  expectDigest("epoch-state ISS trajectory", sha(Buffer.from(new Float64Array(near.EPHEMERIS_DATA).buffer)));
});

// ── gp-error-model: element_residuals, a set against an ephemeris ─────────────────────────────────────────────────────
function ephemerisOem(noradId, states, offsetKm = 0) {
  const block = new OEM.ephemerisDataBlockT();
  Object.assign(block, { CENTER_NAME: "EARTH", TIME_SYSTEM: OEM.timingStandard.UTC });
  block.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: noradId });
  block.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: "TEME" });
  block.EPHEMERIS_DATA_LINES = states.map((s) => {
    const line = new OEM.ephemerisDataLineT();
    line.EPOCH = `${s.iso}Z`;
    [line.X, line.Y, line.Z] = [s.position[0] / 1000 + offsetKm, s.position[1] / 1000, s.position[2] / 1000];
    [line.X_DOT, line.Y_DOT, line.Z_DOT] = s.velocity.map((x) => x / 1000);
    return line;
  });
  return finishPrefixed((b) => Object.assign(new OEM.OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }).pack(b), (b, root) => OEM.OEM.finishSizePrefixedOEMBuffer(b, root));
}
async function residuals(set, states, offsetKm = 0) {
  const window = { from: `${states[0].iso}Z`, to: `${states.at(-1).iso}Z`, label: "window" };
  const response = await invokeModule("gp-error-model", "element_residuals", [
    { portId: "elements", typeRef: TYPE("OMM"), payload: ommStream([set]) },
    { portId: "ephemeris", typeRef: TYPE("OEM"), payload: ephemerisOem(set.noradId, states, offsetKm) },
    { portId: "options", typeRef: { ...ERM_TYPE }, payload: encodeErm(ARM_OF.element_residuals.options, { samples: true,
      requests: [{ norad: set.noradId, set: `${set.epoch}Z`, label: "set", windows: [window] }] }) }]);
  const report = decodeErm(response.outputs[0].payload);
  assert.equal(report.results[0].windows[0].n, states.length);
  return report;
}

test("gp-error-model: across 40942's node crossing element_residuals against propagator/sgp4's states is zero within 1 mm", async () => {
  const [states] = await referenceStates([NODE], [NODE_WINDOW]);
  const report = await residuals(NODE, states);
  const w = report.results[0].windows[0];
  const control = improvedStates(NODE, NODE_WINDOW);
  const modeGap = Math.max(...control.map((c, k) => distance(c.slice(0, 3).map((x) => x * 1000), states[k].position)));
  assert.ok(modeGap > 1000, `the improved mode is only ${modeGap} m from propagator/sgp4`);
  assert.ok(w.max3dKm <= 1e-6 && w.rmsVelocityKmS <= 1e-6, `gp-error-model's SGP4 is up to ${w.max3dKm * 1000} m and ${w.rmsVelocityKmS * 1000} m/s (RMS) from propagator/sgp4 (the improved mode is up to ${modeGap.toFixed(1)} m)`);
  console.log(`gp-error-model 40942: up to ${(w.max3dKm * 1000).toExponential(2)} m from propagator/sgp4 over ${w.n} instants; the improved mode is up to ${modeGap.toFixed(1)} m`);
  assert.match(report.model, /WGS-72, AFSPC mode; TEME$/);
});

test("gp-error-model: the ISS residuals against an ephemeris offset by 1 km are the previous release's, bit for bit", async () => {
  const [states] = await referenceStates([NEAR], [NEAR_WINDOW]);
  const report = await residuals(NEAR, states, 1);
  expectDigest("gp-error-model ISS residuals", sha(JSON.stringify(report.results)));
});

// ── private-screening: features, the gp view's consecutive-set agreement ──────────────────────────────────────────────
const unixSeconds = (iso) => Date.parse(`${iso}Z`) / 1000;
function historyLfv(id, sets) {
  const row = Object.assign(new LFV.LFVRowT(), { SOURCE_ID: id, TARGET: null, ROLE: LFV.lfvRole.Real, GENERATOR: null, CLASS_LABEL: null });
  row.ELEMENT_SETS = sets.map((s) => Object.assign(new LFV.OMMT(), { EPOCH: `${s.epoch.slice(0, 19)}.000000000Z`, MEAN_MOTION: s.meanMotion, ECCENTRICITY: s.eccentricity,
    INCLINATION: s.inclination, RA_OF_ASC_NODE: s.raan, ARG_OF_PERICENTER: s.argPericenter, MEAN_ANOMALY: s.meanAnomaly, BSTAR: s.bstar }));
  const b = new flatbuffers.Builder(1 << 14);
  b.finish(Object.assign(new LFV.LFVT(), { ROWS: [row] }).pack(b), "$LFV");
  return Buffer.from(b.asUint8Array());
}
async function consecutiveAgreement(id, first, second) {
  const response = await invokeModule("private-screening", "features", [{ portId: "histories", typeRef: TYPE("LFV"), payload: historyLfv(id, [first, second]) }],
    { features: { view: "gp", window: [unixSeconds(first.epoch) - 1, unixSeconds(second.epoch) + 1], minPoints: 2 } });
  const payload = Buffer.from(response.outputs[0].payload);
  const lfv = LFV.LFV.getRootAsLFV(new flatbuffers.ByteBuffer(new Uint8Array(payload))).unpack();
  assert.equal(lfv.ROWS.length, 1);
  const at = (name) => lfv.ROWS[0].VALUES[lfv.FEATURE_NAMES.indexOf(name)];
  return { payload, values: ["consecutiveRKm", "consecutiveTKm", "consecutiveNKm", "consecutiveTMaxKm"].map(at) };
}
// The pair's one link as private-screening defines it: the first set propagated to the second's epoch minus the second at
// its epoch, in the propagated state's RTN axes (km), absolute values; then the largest |T| (the same one).
function rtnLink(rA, vA, rB) {
  const d = [rA[0] - rB[0], rA[1] - rB[1], rA[2] - rB[2]];
  const norm = (a) => Math.hypot(...a), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const u = rA.map((x) => x / norm(rA)), h = cross(rA, vA), n = h.map((x) => x / norm(h)), t = cross(n, u);
  const link = [Math.abs(dot(d, u)), Math.abs(dot(d, t)), Math.abs(dot(d, n))];
  return [...link, link[1]];
}

test("private-screening: across 33461's node crossing the consecutive-set agreement is propagator/sgp4's within 1 mm", async () => {
  const [[a], [b]] = await referenceStates([PAIR_A, PAIR_B], [[PAIR_B.epoch.slice(0, 19)], [PAIR_B.epoch.slice(0, 19)]]);
  const km = (m) => m.map((x) => x / 1000);
  const expected = rtnLink(km(a.position), km(a.velocity), km(b.position));
  const [control] = improvedStates(PAIR_A, [PAIR_B.epoch.slice(0, 19)]);
  const improved = rtnLink(control.slice(0, 3), control.slice(3, 6), km(b.position));
  const modeGap = Math.max(...expected.map((x, k) => Math.abs(x - improved[k]))) * 1000;
  assert.ok(modeGap > 100, `the improved mode moves the agreement by only ${modeGap} m`);
  const { values } = await consecutiveAgreement("33461", PAIR_A, PAIR_B);
  const worst = Math.max(...values.map((x, k) => Math.abs(x - expected[k]))) * 1000;
  assert.ok(worst <= 1e-3, `private-screening's R, T, N, Tmax ${values.join(", ")} km; propagator/sgp4 gives ${expected.join(", ")} km (${worst} m apart; the improved mode would move them ${modeGap.toFixed(1)} m)`);
  console.log(`private-screening 33461: ${worst.toExponential(2)} m from propagator/sgp4 in R, T, N and Tmax; the improved mode is up to ${modeGap.toFixed(1)} m`);
});

test("private-screening: the ISS pair's features are the previous release's, byte for byte", async () => {
  const { payload } = await consecutiveAgreement("25544", NEAR, { ...NEAR, epoch: "2026-10-29T14:15:00.000000" });
  expectDigest("private-screening ISS pair features", sha(payload));
});

// ── maneuver-detection: no propagation, an unchanged output ───────────────────────────────────────────────────────────
// A history: the set at each epoch, its mean motion scaled by `scale[k]` (a lowered mean motion after the last epoch is a burn).
const gpRows = (set, epochs, scale) => epochs.map((EPOCH, k) => ({ OBJECT_NAME: set.objectName, OBJECT_ID: set.objectId, NORAD_CAT_ID: set.noradId, EPOCH,
  MEAN_MOTION: set.meanMotion * scale[k], ECCENTRICITY: set.eccentricity, INCLINATION: set.inclination, RA_OF_ASC_NODE: set.raan,
  ARG_OF_PERICENTER: set.argPericenter, MEAN_ANOMALY: set.meanAnomaly, BSTAR: set.bstar }));
const rowSet = (row) => ({ noradId: Number(row.NORAD_CAT_ID), epoch: row.EPOCH, meanMotion: Number(row.MEAN_MOTION), eccentricity: Number(row.ECCENTRICITY),
  inclination: Number(row.INCLINATION), raan: Number(row.RA_OF_ASC_NODE), argPericenter: Number(row.ARG_OF_PERICENTER), meanAnomaly: Number(row.MEAN_ANOMALY),
  bstar: Number(row.BSTAR), objectId: row.OBJECT_ID ?? "", objectName: row.OBJECT_NAME ?? "" });
// The detector's propagator query port answered by propagator/sgp4 (propagate_ephemeris, one block per set over its neighbour sets, TEME):
// one $OEM per object, a block for each of its queries.
async function sgp4Answers(requests, rows) {
  const queries = requests.WINDOW_REQUEST.QUERIES.map((q) => ({ set: q.SET_INDEX, norad: Number(rows[q.SET_INDEX].NORAD_CAT_ID), step: q.STEP_SECONDS }));
  const groups = [];
  for (const q of queries) {
    if (!groups.length || groups.at(-1).norad !== q.norad) groups.push({ norad: q.norad, step: q.step, queries: [] });
    groups.at(-1).queries.push(q);
  }
  const frames = [];
  for (const group of groups) {
    const sgp4 = await loadRawSgp4Module();
    try {
      const answer = invokePiv(sgp4, { methodId: "propagate_ephemeris", outputStreamCap: 4, inputs: [
        { portId: "request", typeRef: PROP_REF, payload: encodePropagatorBatchRequest({ catalogNumbers: [group.norad], stepSeconds: group.step, elementSetBlocks: true,
          neighbourSets: requests.WINDOW_REQUEST.NEIGHBOUR_SETS || 2, outputFrame: ReferenceFrame.TEME }) },
        { portId: "omm", typeRef: OMM_REF, payload: ommStream(group.queries.map((q) => rowSet(rows[q.set]))) }] });
      assert.equal(answer.response.STATUS_CODE, 0, answer.response.ERROR_MESSAGE);
      const blocks = OEM.OEM.getRootAsOEM(new flatbuffers.ByteBuffer(answer.outputPayloads[0].bytes)).unpack().EPHEMERIS_DATA_BLOCK;
      assert.equal(blocks.length, group.queries.length, `propagator/sgp4 answers ${blocks.length} blocks for ${group.queries.length} queries of ${group.norad}`);
      const oem = Object.assign(new OEM.OEMT(), { CREATION_DATE: "2026-10-11T00:00:00.000Z", EPHEMERIS_DATA_BLOCK: blocks });
      frames.push(finishPrefixed((b) => oem.pack(b), (b, root) => OEM.OEM.finishOEMBuffer(b, root)));
    } finally {
      sgp4._plugin_destroy();
    }
  }
  return frames;
}
// 0.9.0 writes its version where 0.8.0 wrote its own: PRODUCER and the head of ALGORITHM. Same length, so the rest is untouched.
const asPrevious = (bytes) => Buffer.from(Buffer.from(bytes).toString("latin1").replaceAll("maneuver-detection 0.9.0", "maneuver-detection 0.8.0"), "latin1");

test("maneuver-detection: its outputs on the node-crossing and near-Earth histories, with the error model, are the previous release's byte for byte", async () => {
  // 40942's set every 12 h from 2026-10-29 across the crossing, its mean motion lowered by 4e-4 from the fifth set on (a burn); and the
  // repository's near-Earth fixture, a 51.6 degree LEO history with a 1 m/s burn (analysis/maneuver-detection tests/fixtures.mjs).
  const nodeEpochs = Array.from({ length: 8 }, (_, k) => new Date(Date.parse("2026-10-29T00:00:00Z") + k * 43200000).toISOString().slice(0, 19) + ".000000");
  const { gpHistory } = await load(path.join(modules, "analysis/maneuver-detection/tests/fixtures.mjs"));
  const rows = [...gpRows(NODE, nodeEpochs, nodeEpochs.map((_, k) => (k < 4 ? 1 : 1 - 4e-4))), ...gpHistory(1).rows];
  const model = { portId: "error_model", typeRef: { ...ERM_TYPE }, payload: new Uint8Array(fs.readFileSync(path.join(modules, "analysis/gp-error-model/data/e14-s3-kc.erm"))) };
  const sets = { portId: "element_sets", typeRef: TYPE("OMM"), payload: ommStream(rows.map(rowSet)) };
  const config = { detect: {} };
  const first = await invokeModule("maneuver-detection", "detect_maneuvers", [sets], config);
  const requests = first.outputs.filter((f) => f.portId === "propagation_requests").map((f) => new Uint8Array(f.payload));
  assert.equal(requests.length, 1);
  const asked = await prwJson(requests[0]);
  assert.equal(asked.WINDOW_REQUEST.QUERIES.length, rows.length);
  const answers = await sgp4Answers(asked, rows);
  const second = await invokeModule("maneuver-detection", "detect_maneuvers", [sets, model, ...answers.map((payload) => ({ portId: "propagation", typeRef: TYPE("OEM"), payload }))], config);
  const maneuvers = second.outputs.filter((f) => f.portId === "maneuvers").map((f) => new Uint8Array(f.payload));
  const report = second.outputs.filter((f) => f.portId === "report").map((f) => new Uint8Array(f.payload));
  assert.equal(report.length, 1);
  const events = maneuvers.map((bytes) => MNV.MNV.getRootAsMNV(new flatbuffers.ByteBuffer(bytes)).unpack());
  const by = (norad) => events.filter((m) => m.SAT_NO === norad).length;
  assert.ok(by(40942) > 0 && by(99999) > 0, `the detector finds events in both histories (40942: ${by(40942)}, 99999: ${by(99999)})`);
  expectDigest("maneuver-detection propagation_requests", sha(asPrevious(requests[0])));
  expectDigest("maneuver-detection report", sha(asPrevious(report[0])));
  expectDigest("maneuver-detection maneuvers", sha(Buffer.concat(maneuvers.map(asPrevious))));
  console.log(`maneuver-detection: ${rows.length} queries, ${events.length} maneuvers (40942: ${by(40942)}, 99999: ${by(99999)}), report ${report[0].length} bytes`);
});

process.on("exit", () => { if (record) console.log(`RECORDED = ${JSON.stringify(recorded, null, 2)}`); });
