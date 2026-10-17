/*
 * Lunar photometry E2E through the shipped WASM, with no JS physics.
 * Reference: recorded JPL Horizons APmag (V mag) and S-T-O (degrees),
 * CENTER 500@399, 24 JD TT epochs in fixtures/horizons-moon-apmag.json;
 * that fixture records the full request URL. States are DE440 ICRF, m/m/s.
 * The module supplies Earth's SSB state for the geocentric observer and
 * converts TAI to TDB; TT is encoded as (jdTT, -32.184 s) in its TAI ABI.
 * Tolerances: 0.05 mag for the published empirical lunar phase law against
 * Horizons, and 0.05 deg for geometric versus apparent S-T-O. Both are the
 * requested display-accuracy bounds; fixture rounding is only 0.001 mag /
 * 0.0001 deg. Near-new-Moon epochs retain exactly the same bounds.
 * JS only serializes input, converts angle units, and compares output.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

const here = path.dirname(fileURLToPath(import.meta.url));
const bsp = path.resolve(here, "../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp");
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures/horizons-moon-apmag.json"), "utf8"));

// Pre-change module outputs at the same epoch, JD 2461329.5 TT, in V mag.
// Captured BEFORE rebuilding from the original dist/isomorphic/module.wasm,
// copied outside the repo; SHA256:
// 8cef229615e5634c351962ba744e200745192fb7977657eb800b657f076e30f3.
// Zero tolerance: exact double equality protects every planet's photometry.
// The observer is geocentric except for Earth, viewed from the module's Moon
// state because magnitude at the Earth's own center is undefined. No PCK is
// loaded in either run (the same default Saturn/Uranus orientation handling).
const planetBaseline = [
  [199, "Mercury", 0.08114006090368253],
  [299, "Venus", -4.225707405545522],
  [399, "Earth", -16.138239552956655],
  [499, "Mars", 1.0114441875901856],
  [599, "Jupiter", -1.9267455297933107],
  [699, "Saturn", 0.6281691963596768],
  [799, "Uranus", 5.70512185895395],
  [899, "Neptune", 7.689543359759165],
  [10, "Sun", -26.74636111132843],
  [999, "Pluto", 14.526761297756453],
];

// DE440 has system barycenters, not Mars..Pluto centers. For the regression
// comparison ONLY, serialize fixed zero center-to-barycenter offsets in a
// type-3 SPK. These are identical inputs to the original and rebuilt modules,
// not reference planetary ephemerides. Earth/Moon DE440 segments are untouched.
// NAIF SPK Required Reading (type 3):
// https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/spk.html
function planetCenterAliases() {
  const bytes = Buffer.alloc(4096);
  bytes.write("DAF/SPK ", 0); bytes.write("LTL-IEEE", 88);
  for (const [at, value] of [[8, 2], [12, 6], [76, 2], [80, 2], [84, 457]]) bytes.writeInt32LE(value, at);
  bytes.writeDoubleLE(6, 1040);
  for (const [i, id, center] of [[0, 499, 4], [1, 599, 5], [2, 699, 6], [3, 799, 7], [4, 899, 8], [5, 999, 9]]) {
    const summary = 1048 + 40 * i, start = 385 + 12 * i;
    bytes.writeDoubleLE(-2e9, summary); bytes.writeDoubleLE(2e9, summary + 8);
    [id, center, 1, 3, start, start + 11].forEach((v, k) => bytes.writeInt32LE(v, summary + 16 + 4 * k));
    [0, 2e9, 0, 0, 0, 0, 0, 0, -2e9, 4e9, 8, 1].forEach((v, k) => bytes.writeDoubleLE(v, (start - 1 + k) * 8));
  }
  return bytes;
}

test("Moon magnitude and phase match 24 Horizons epochs; other photometry stays exact", async (t) => {
  assert.equal(fixture.epochs.length, 24, "all recorded lunation epochs are required");
  assert.equal(fixture.epochs[0].jdTT, 2461329.5, "planet baseline epoch");
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(here, "../dist/isomorphic/module.wasm")),
    surface: "direct", maxThreads: 1, wasiThreadPoolSize: 1,
  });
  const x = harness.instance.exports;
  const mem = () => (harness.memory ?? x.memory).buffer;
  const allocations = [];
  t.after(async () => {
    for (const [ptr, size] of allocations) x.plugin_free(ptr, size);
    await harness.destroy();
  });
  const alloc = (size) => {
    const ptr = x.plugin_alloc(size);
    assert.ok(ptr, `allocate ${size} bytes`);
    allocations.push([ptr, size]);
    return ptr;
  };
  const load = (bytes) => {
    const ptr = x.plugin_alloc(bytes.length);
    try {
      new Uint8Array(mem(), ptr, bytes.length).set(bytes);
      assert.ok(x.ssb_load_kernel(ptr, bytes.length) >= 0, "kernel loads");
    } finally { x.plugin_free(ptr, bytes.length); }
  };
  load(fs.readFileSync(bsp)); // Missing committed data fails; no network or skips.
  const ids = alloc(4), observer = alloc(48), out = alloc(56), status = alloc(4);
  const observeFrom = (et, id) => {
    new Int32Array(mem(), ids, 1)[0] = id;
    assert.equal(x.ssb_states(et, ids, 1, 0, observer, status), 0, `${id} SSB state`);
    assert.equal(new Int32Array(mem(), status, 1)[0], 0);
  };
  const apparent = (et, id) => {
    new Int32Array(mem(), ids, 1)[0] = id;
    assert.equal(x.ssb_apparent(et, observer, ids, 1, out, status), 0, `${id} appearance`);
    assert.equal(new Int32Array(mem(), status, 1)[0], 0);
    return Array.from(new Float64Array(mem(), out, 7));
  };

  const failures = [];
  let maxMagnitudeError = 0, maxPhaseError = 0;
  console.log("JD TT          Horizons V   Module V       dV mag    phase deg   dPhase deg  result");
  for (const epoch of fixture.epochs) {
    const et = x.ssb_et(epoch.jdTT, -32.184);
    observeFrom(et, 399);
    const actual = apparent(et, 301);
    const phaseDeg = actual[6] * 180 / Math.PI;
    const dV = actual[4] - epoch.apmag, dPhase = phaseDeg - epoch.phaseDeg;
    const magnitudeOK = Math.abs(dV) <= 0.05, phaseOK = Math.abs(dPhase) <= 0.05;
    maxMagnitudeError = Math.max(maxMagnitudeError, Math.abs(dV));
    maxPhaseError = Math.max(maxPhaseError, Math.abs(dPhase));
    const result = magnitudeOK && phaseOK ? "PASS" : "FAIL";
    console.log(`${epoch.jdTT.toFixed(6)}  ${epoch.apmag.toFixed(3).padStart(10)}  ${actual[4].toFixed(6).padStart(10)}  ${dV.toFixed(6).padStart(11)}  ${phaseDeg.toFixed(6).padStart(11)}  ${dPhase.toFixed(6).padStart(11)}  ${result}`);
    if (!magnitudeOK) failures.push(`JD ${epoch.jdTT}: dV=${dV} mag exceeds 0.05 mag`);
    if (!phaseOK) failures.push(`JD ${epoch.jdTT}: dPhase=${dPhase} deg exceeds 0.05 deg`);
  }
  console.log(`Max |dV| = ${maxMagnitudeError.toFixed(6)} mag; max |dPhase| = ${maxPhaseError.toFixed(6)} deg`);

  load(planetCenterAliases());
  const baselineEt = x.ssb_et(2461329.5, -32.184);
  for (const [id, name, expected] of planetBaseline) {
    observeFrom(baselineEt, id === 399 ? 301 : 399);
    assert.equal(apparent(baselineEt, id)[4], expected, `${name} V exactly matches the original WASM`);
  }
  console.log("Mercury..Neptune (8 planets), Sun and Pluto: exact equality with original WASM at JD 2461329.5 TT");
  // Aggregate after printing EVERY epoch and checking planets, so crescent
  // failures cannot hide the rest of the lunation or the regression result.
  assert.deepEqual(failures, [], "all 24 epochs must meet both unchanged 0.05 bounds");
});
