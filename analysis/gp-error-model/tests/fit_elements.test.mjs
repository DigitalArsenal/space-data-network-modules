import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

// fit_elements and element_residuals through the built artifact. Expected
// values do not come from this module: tests/fit-reference.json is written by
// tests/fit-reference.py from python-sgp4 (WGS-72, opsmode i), pyerfa frames
// and scipy's Levenberg-Marquardt in classical elements:
//   - Vallado's published SGP4 verification states (SGP4-VER, tcppver.out):
//     the fit recovers each case's elements;
//   - seeded random element sets across regimes, spans, samplings and frames
//     (python-sgp4 ephemerides): the fit recovers the elements, and the
//     half-split closure (first half fitted, second half predicted) stays
//     within 1 cm (owner, 2026-10-10);
//   - a 50 m noise case: the same least-squares optimum, RMS and covariance as
//     scipy;
//   - the NASA ISS OEM fixture of analysis/od: the same fit as scipy, and
//     CelesTrak's Segment-01 SupGP scored exactly as python-sgp4 scores it.
const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
const flatbuffers = require('flatbuffers');
const load = async (code) => import(pathToFileURL(path.join(root, `lib/js/${code}/main.js`)));
const [OMM, OEM] = await Promise.all(['OMM', 'OEM'].map(load));
const wasm = fs.readFileSync(fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const ref = JSON.parse(fs.readFileSync(new URL('./fit-reference.json', import.meta.url)));
const DEG = Math.PI / 180;

const frameOf = (name) => {
  const rfm = new OEM.RFMT();
  rfm.NAME = name;
  return rfm;
};
function block(norad, frame, opts) {
  const b = new OEM.ephemerisDataBlockT();
  Object.assign(b, { CENTER_NAME: 'EARTH', TIME_SYSTEM: OEM.timingStandard.UTC });
  b.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: norad });
  b.REFERENCE_FRAME = frameOf(frame);
  if (opts.lines) {
    b.EPHEMERIS_DATA_LINES = opts.lines.map(([epoch, x]) => {
      const l = new OEM.ephemerisDataLineT();
      l.EPOCH = epoch;
      [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = x.length === 6 ? x : [...x, 0, 0, 0];
      return l;
    });
  } else {
    Object.assign(b, { START_TIME: opts.start, STEP_SIZE: opts.step, STATE_VECTOR_SIZE: opts.size, EPHEMERIS_DATA: opts.data });
  }
  return b;
}
function ephemeris(...blocks) {
  const fb = new flatbuffers.Builder(1 << 20);
  OEM.OEM.finishSizePrefixedOEMBuffer(fb, Object.assign(new OEM.OEMT(), { EPHEMERIS_DATA_BLOCK: blocks }).pack(fb));
  return { portId: 'ephemeris', payload: Buffer.from(fb.asUint8Array()), typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } };
}
function ommSet(norad, epoch, el) {
  const t = new OMM.OMMT();
  Object.assign(t, { EPOCH: epoch, NORAD_CAT_ID: norad, MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4, MEAN_MOTION: el[0], ECCENTRICITY: el[1],
    INCLINATION: el[2], RA_OF_ASC_NODE: el[3], ARG_OF_PERICENTER: el[4], MEAN_ANOMALY: el[5], BSTAR: el[6] });
  const b = new flatbuffers.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
}
const elements = (...bufs) => ({ portId: 'elements', payload: Buffer.concat(bufs), typeRef: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' } });
const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });
async function call(t, methodId, inputs) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h.destroy());
  const r = await h.invoke({ methodId, inputs });
  assert.equal(r.statusCode, 0, r.errorMessage);
  const out = {};
  for (const o of r.outputs) out[o.portId] = Buffer.from(o.payload);
  return out;
}
const report = (out, port = 'report') => JSON.parse(out[port].toString());
const iso = (s) => (s.endsWith('Z') ? s : `${s}Z`);
// Equinoctial parameters of classical elements (n rev/day -> rad/min), as the module reports them.
function equinoctial(el) {
  const varpi = (el[4] + el[3]) * DEG, t = Math.tan((el[2] * DEG) / 2);
  return [el[0] * 2 * Math.PI / 1440, el[1] * Math.cos(varpi), el[1] * Math.sin(varpi), t * Math.sin(el[3] * DEG), t * Math.cos(el[3] * DEG),
    (el[5] + el[4] + el[3]) * DEG, el[6]];
}
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// Largest parameter difference with lambda compared modulo 2 pi.
function compare(actual, expected) {
  return actual.map((a, k) => Math.abs(k === 5 ? wrapPi(a - expected[k]) : a - expected[k]));
}

test('fit_elements recovers the elements of Vallado\'s published SGP4 verification cases', async (t) => {
  for (const c of ref.vallado) {
    // Exact epochs: the published tsince in minutes from the epoch's microseconds.
    const exact = c.states.map(([m, ...x]) => [isoPlus(c.epoch, m * 60), x]);
    // Deep space: B* is held at the published value (it barely moves SGP4's deep-space states).
    const deep = c.regime === 'deep space';
    const out = await call(t, 'fit_elements', [ephemeris(block(c.satnum, 'TEME', { lines: exact })),
      json('options', { epoch: iso(c.epoch), fitBstar: !deep, bstar: c.truth[6], closure: false })]);
    const r = report(out).fits[0];
    assert.equal(r.converged, true, `${c.satnum}: ${r.error}`);
    assert.ok(r.rms.rms3dKm < 2e-8, `${c.satnum}: RMS ${r.rms.rms3dKm} km`);
    const d = compare(r.equinoctial, equinoctial(c.truth));
    const tol = [1e-12, 2e-9, 2e-9, 2e-9, 2e-9, 2e-9, 2e-8];
    d.forEach((x, k) => assert.ok(x <= tol[k], `${c.satnum} parameter ${k}: |${r.equinoctial[k]} - ${equinoctial(c.truth)[k]}| = ${x}`));
  }
});

// ISO 8601 UTC of an ISO epoch plus seconds, to the microsecond.
function isoPlus(text, seconds) {
  const [date, time] = text.split('T');
  const [h, mi, s] = time.split(':');
  const us = BigInt(Math.round(((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1e6)) + BigInt(Math.round(seconds * 1e6));
  const dayUs = 86400000000n;
  const days = us >= 0n ? us / dayUs : (us - dayUs + 1n) / dayUs;
  const rem = us - days * dayUs;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  const hh = rem / 3600000000n, mm = (rem % 3600000000n) / 60000000n, ss = (rem % 60000000n) / 1000000n, uu = rem % 1000000n;
  const p = (v, n = 2) => String(v).padStart(n, '0');
  return `${d.toISOString().slice(0, 10)}T${p(hh)}:${p(mm)}:${p(ss)}.${p(uu, 6)}Z`;
}

test('fit_elements on random SGP4 ephemerides: elements recovered, half-split closure within 1 cm', async (t) => {
  for (const c of ref.synthetic) {
    const eph = ephemeris(block(40000, c.frame, { start: iso(c.start), step: c.stepSeconds, size: c.stateVectorSize, data: c.data }));
    // At the generating epoch SGP4 can reproduce its own ephemeris exactly: the
    // elements come back, and half the data predicts the other half within 1 cm.
    const out = await call(t, 'fit_elements', [eph, json('options', { epoch: iso(c.epoch), fitBstar: c.fitBstar, bstar: c.truth[6] })]);
    const r = report(out).fits[0];
    assert.equal(r.converged, true, `${c.name}: ${r.error}`);
    assert.equal(r.rms.n, c.count, `${c.name}: every state scored`);
    assert.ok(r.rms.max3dKm < 2e-6, `${c.name}: max residual ${r.rms.max3dKm} km`);
    assert.ok(r.closure.rms.max3dKm <= 1e-5, `${c.name}: closure max ${r.closure.rms.max3dKm} km > 1 cm`);
    assert.equal(r.closure.rms.n, c.count - Math.floor(c.count / 2), `${c.name}: the closure scores the whole second half`);
    const d = compare(r.equinoctial, equinoctial(c.truth));
    const tol = [1e-12, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, c.fitBstar ? 1e-8 : 0];
    d.forEach((x, k) => assert.ok(x <= tol[k], `${c.name} parameter ${k}: ${x}`));
    // The OMM carries the same elements at full precision.
    const omm = OMM.OMM.getSizePrefixedRootAsOMM(new flatbuffers.ByteBuffer(new Uint8Array(out.elements)));
    assert.equal(omm.EPOCH(), r.epoch);
    assert.equal(omm.MEAN_MOTION(), r.elements.MEAN_MOTION);
    assert.equal(omm.covarianceLength(), 21);
    // At another epoch SGP4 cannot reproduce a trajectory generated from a
    // different epoch exactly (its secular and drag polynomials are in time
    // since epoch); the fit still converges close to it.
    const first = report(await call(t, 'fit_elements', [eph, json('options', { epoch: 'first', fitBstar: c.fitBstar, bstar: c.truth[6] })])).fits[0];
    assert.equal(first.converged, true, `${c.name} (first): ${first.error}`);
    assert.ok(first.rms.max3dKm < 0.01, `${c.name} (first): max residual ${first.rms.max3dKm} km`);
  }
});

test('fit_elements on 50 m noise: the same least-squares optimum, RMS and covariance as scipy', async (t) => {
  const c = ref.noisy;
  const out = await call(t, 'fit_elements', [ephemeris(block(40001, c.frame, { start: iso(c.start), step: c.stepSeconds, size: 6, data: c.data })),
    json('options', { epoch: iso(c.epoch), fitBstar: true })]);
  const r = report(out).fits[0];
  assert.equal(r.converged, true, r.error);
  assert.ok(Math.abs(r.rms.rms3dKm - c.scipyStats.rms3dKm) < 1e-9, `RMS ${r.rms.rms3dKm} vs scipy ${c.scipyStats.rms3dKm}`);
  assert.ok(Math.abs(r.rms.rmsPerCoordinateKm - c.scipyStats.rmsPerCoordinateKm) < 1e-9);
  const got = [r.elements.MEAN_MOTION, r.elements.ECCENTRICITY, r.elements.INCLINATION, r.elements.RA_OF_ASC_NODE, r.elements.ARG_OF_PERICENTER,
    r.elements.MEAN_ANOMALY, r.elements.BSTAR];
  const cov = c.scipyCovarianceClassical;
  const sigma = [0, 2, 5, 9, 14, 20, 27].map((i) => Math.sqrt(cov[i]));
  got.forEach((x, k) => {
    const d = k >= 3 && k <= 5 ? Math.abs(((x - c.scipy[k] + 540) % 360) - 180) : Math.abs(x - c.scipy[k]);
    assert.ok(d <= 1e-2 * sigma[k], `element ${k}: ${x} vs scipy ${c.scipy[k]} (sigma ${sigma[k]})`);
  });
  r.covariance.classical.forEach((x, i) => assert.ok(Math.abs(x - cov[i]) <= 1e-2 * Math.sqrt(Math.abs(cov[[0, 2, 5, 9, 14, 20, 27][rowOf(i)]] * cov[[0, 2, 5, 9, 14, 20, 27][colOf(i)]])),
    `covariance ${i}: ${x} vs ${cov[i]}`));
});
const rowOf = (i) => { let r = 0; while ((r + 1) * (r + 2) / 2 <= i) ++r; return r; };
const colOf = (i) => i - rowOf(i) * (rowOf(i) + 1) / 2;

test('fit_elements on the NASA ISS OEM: the same fit as scipy; element_residuals scores SupGP as python-sgp4 does', async (t) => {
  const c = ref.iss;
  const eph = ephemeris(block(25544, c.frame, { lines: c.states.map(([e, ...x]) => [iso(e), x]) }));
  const out = await call(t, 'fit_elements', [eph, json('options', { epoch: iso(c.epoch), fitBstar: true })]);
  const r = report(out).fits[0];
  assert.equal(r.converged, true, r.error);
  assert.ok(Math.abs(r.rms.rms3dKm - c.scipyStats.rms3dKm) < 1e-6, `RMS ${r.rms.rms3dKm} vs scipy ${c.scipyStats.rms3dKm}`);
  assert.ok(r.rms.rms3dKm <= c.scipyStats.rms3dKm + 1e-9, 'not worse than scipy');
  const d = compare(r.equinoctial, equinoctial(c.scipy));
  [1e-10, 1e-8, 1e-8, 1e-8, 1e-8, 1e-7, 1e-6].forEach((tol, k) => assert.ok(d[k] <= tol, `parameter ${k}: ${d[k]}`));
  // CelesTrak's set comes from the analysis/od fixture CSV (no reuse licence: not copied here).
  const s = c.supgp;
  const csv = new URL(`../../../${s.csv}`, import.meta.url);
  if (!fs.existsSync(csv)) { t.diagnostic(`skipped: ${s.csv} is absent`); return; }
  const [head, ...rows] = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/).map((l) => l.split(','));
  const row = Object.fromEntries(head.map((k, i) => [k, rows[s.row][i]]));
  const el = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR'].map((k) => Number(row[k]));
  assert.equal(row.EPOCH, s.epoch);
  const res = await call(t, 'element_residuals', [elements(ommSet(25544, s.epoch, el)), eph, json('options', { requests: [{ norad: 25544, set: s.epoch,
    windows: [{ from: iso(c.states[0][0]), to: iso(c.states.at(-1)[0]), label: 'all' }, { from: iso(s.window6h.from), to: iso(s.window6h.to), label: 'segment' }] }] })]);
  const [all, seg] = report(res, 'residuals').results[0].windows;
  assert.equal(all.n, s.recomputed.n);
  assert.ok(Math.abs(all.rms3dKm - s.recomputed.rms3dKm) < 1e-9, `${all.rms3dKm} vs ${s.recomputed.rms3dKm}`);
  assert.equal(seg.n, s.window6h.n);
  assert.ok(Math.abs(seg.rmsPerCoordinateKm - s.window6h.rmsPerCoordinateKm) < 1e-9, `${seg.rmsPerCoordinateKm} vs ${s.window6h.rmsPerCoordinateKm}`);
  // CelesTrak's rms file value is this per-coordinate RMS over the segment (3D / sqrt 3), to its three decimals.
  assert.ok(Math.abs(seg.rmsPerCoordinateKm - Number(row.RMS)) < 0.002, `${seg.rmsPerCoordinateKm} vs published ${row.RMS}`);
});
