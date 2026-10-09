// normalize_ses_i11 against Orekit 13.1 (IntelsatElevenElementsPropagator)
// and against the published values Orekit's own test asserts: Intelsat's
// calculator for spacecraft 4521 at 170 h, and STK at the element epoch.
// Frame: Earth-fixed, as the format defines it. Time: UTC.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { ByteBuffer } from 'flatbuffers';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { TYPE, container } from './vimpel-fixture.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const reference = JSON.parse(fs.readFileSync(new URL('./fixtures/ses-i11/orekit-13.1-reference.json', import.meta.url)));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// An eleven-parameter file in the layout SES publishes. `check` is the printed
// prediction [hours, east longitude, north latitude], or null.
function i11(name, epochIso, e, { check, validHours = 171 } = {}) {
  const t = new Date(epochIso), v = new Date(t.getTime() + validHours * 3600e3);
  const p2 = (n) => String(n).padStart(2, '0');
  const lon = (x) => (x >= 0 ? `${x.toFixed(4)} DEG. E` : `${(-x).toFixed(4)} DEG. W`);
  const lat = (x) => (x >= 0 ? `${x.toFixed(4)} DEG. N` : `${(-x).toFixed(4)} DEG. S`);
  return [
    '-----------------------',
    `WEEKLY I11 DATA SET VALID UNTIL ${p2(v.getUTCDate())}-${MONTHS[v.getUTCMonth()]}-${v.getUTCFullYear()} ${p2(v.getUTCHours())}:${p2(v.getUTCMinutes())}`,
    '-----------------------', '',
    `SUBJECT: ELEVEN PARAMETER EPHEMERIS FOR ${name} / 0.00 DEG. E`, '',
    'YEAR  MONTH  DAY  HOUR  MINUTE  SECOND',
    `${t.getUTCFullYear()}  ${p2(t.getUTCMonth() + 1)}     ${p2(t.getUTCDate())}   ${p2(t.getUTCHours())}    ${p2(t.getUTCMinutes())}      ${p2(t.getUTCSeconds())}`, '',
    'THE EPHEMERIS VALUES ARE:', '',
    'LM0             LM1              LM2', 'DEG. E          DEG/DAY          DEG/DAY/DAY', `${e[0]}       ${e[1]}            ${e[2]}`, '', '',
    'LONC            LONC1            LONS             LONS1', 'DEG. E          DEG/DAY          DEG. E           DEG/DAY', `${e[3]}       ${e[4]}            ${e[5]}         ${e[6]}`, '', '',
    'LATC            LATC1            LATS             LATS1', 'DEG. N          DEG/DAY          DEG. N           DEG/DAY', ` ${e[7]}       ${e[8]}            ${e[9]}          ${e[10]}`, '',
    ...(check ? ['THE PREDICTED SATELLITE LONGITUDE AND LATITUDE AT ' + check[0] + ' HOURS AFTER', `EPOCH ARE  ${lon(check[1])} AND   ${lat(check[2])} `] : []), '',
  ].join('\n');
}
const request = (text, options) => {
  const payload = container(text, { format: 'ses-i11', ...options });
  return { methodId: 'normalize_ses_i11', inputs: [{ portId: 'container', typeRef: { ...TYPE, byteLength: payload.length }, payload }] };
};
async function invoke(t, r) {
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL('../dist/isomorphic/module.wasm', import.meta.url)), manifest, surface: 'direct' });
  t.after(() => h.destroy());
  return h.invoke(r);
}
function block(out) {
  const oem = OEM.getSizePrefixedRootAsOEM(new ByteBuffer(out.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack();
  const b = oem.EPHEMERIS_DATA_BLOCK[0];
  const rows = [];
  for (let k = 0; k < b.EPHEMERIS_DATA.length; k += 6) rows.push({ t: (k / 6) * b.STEP_SIZE, p: b.EPHEMERIS_DATA.slice(k, k + 3).map((x) => x * 1000), v: b.EPHEMERIS_DATA.slice(k + 3, k + 6).map((x) => x * 1000) });
  return { b, rows };
}
const deg = (x) => (x * 180) / Math.PI;

for (const set of reference.sets) {
  test(`${set.name}: Earth-fixed states equal Orekit 13.1 within 1 mm and 1 um/s`, async (t) => {
    const at170 = set.states.find((s) => s.t === 612000);
    const text = i11(set.name, set.epoch, set.elements, { check: [170, Math.round(at170.lon * 1e4) / 1e4, Math.round(at170.lat * 1e4) / 1e4] });
    const out = await invoke(t, request(text));
    assert.equal(out.statusCode, 0, out.errorMessage);
    const { b, rows } = block(out);
    assert.equal(b.REFERENCE_FRAME.NAME, 'FIXED_EARTH');
    assert.equal(b.OBJECT.OBJECT_NAME, set.name);
    assert.equal(b.START_TIME, `${set.epoch.slice(0, 19)}.000000`);
    let compared = 0;
    for (const s of set.states.filter((x) => x.t % b.STEP_SIZE === 0)) {
      const row = rows.find((r) => r.t === s.t);
      assert.ok(row, `no state at ${s.t} s`);
      for (let c = 0; c < 3; ++c) {
        assert.ok(Math.abs(row.p[c] - s.p[c]) <= 1e-3, `${set.name} t=${s.t} position ${c}: ${row.p[c]} vs ${s.p[c]}`);
        assert.ok(Math.abs(row.v[c] - s.v[c]) <= 1e-6, `${set.name} t=${s.t} velocity ${c}: ${row.v[c]} vs ${s.v[c]}`);
      }
      ++compared;
    }
    assert.ok(compared >= 30);
  });
}

// Published values (Orekit 13.1 IntelsatElevenElementsPropagatorTest):
// Intelsat's calculator for spacecraft 4521 gives 301.9191 E, 0.0257 N at
// 170 h; STK gives 302.0355 E, 0.0378 N, r = 42172456.005 m and
// dr/dt = 0.797 m/s at the epoch. Tolerances are Orekit's.
test('intelsat-4521: Intelsat calculator and STK values', async (t) => {
  const set = reference.sets.find((s) => s.name === 'intelsat-4521');
  const out = await invoke(t, request(i11('IS-4521', set.epoch, set.elements, { check: [170, 301.9191, 0.0257] })));
  assert.equal(out.statusCode, 0, out.errorMessage);
  const { rows } = block(out);
  const geo = (p) => ({ lon: (deg(Math.atan2(p[1], p[0])) + 360) % 360, lat: deg(Math.asin(p[2] / Math.hypot(...p))), r: Math.hypot(...p) });
  const g0 = geo(rows[0].p), g170 = geo(rows.find((r) => r.t === 612000).p);
  assert.ok(Math.abs(g170.lon - 301.9191) <= 1e-4 && Math.abs(g170.lat - 0.0257) <= 1e-4, JSON.stringify(g170));
  assert.ok(Math.abs(g0.lon - 302.0355) <= 1e-4 && Math.abs(g0.lat - 0.0378) <= 1e-4, JSON.stringify(g0));
  assert.ok(Math.abs(g0.r - 42172456.005) <= 1e-3, String(g0.r));
  const rdot = rows[0].p.reduce((a, x, k) => a + x * rows[0].v[k], 0) / g0.r;
  assert.ok(Math.abs(rdot - 0.797) <= 1e-3, String(rdot));
});

test('a file whose printed prediction its elements do not reproduce is refused', async (t) => {
  const set = reference.sets.find((s) => s.name === 'intelsat-4521');
  for (const check of [[170, 301.9201, 0.0257], [170, 301.9191, 0.0247]]) {
    const out = await invoke(t, request(i11('IS-4521', set.epoch, set.elements, { check })));
    assert.notEqual(out.statusCode, 0);
    assert.equal(out.outputs.length, 0);
  }
});

test('wrong format name, wrong hash and a missing parameter line are refused', async (t) => {
  const set = reference.sets.find((s) => s.name === 'intelsat-4521');
  const text = i11('IS-4521', set.epoch, set.elements, { check: [170, 301.9191, 0.0257] });
  for (const r of [request(text, { format: 'vimpel-orbits-text' }), request(text, { hash: false }), request(text.replace(/LATC .*\n.*\n.*\n/, ''))]) {
    const out = await invoke(t, r);
    assert.notEqual(out.statusCode, 0);
    assert.equal(out.outputs.length, 0);
  }
});
