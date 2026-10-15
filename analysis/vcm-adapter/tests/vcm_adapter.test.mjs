// analysis/vcm-adapter against the survey's sample VCM (an ISS message,
// epoch revolution 37693; spacedatastandards.org
// survey/legacy-messages/vcm/sample/vcm.txt) and propagator/hpop.
//
// (1) The equinoctial covariance transformed to Cartesian, with the n row as
//     dn/n, reproduces the UVW sigmas the VCM prints within 1 % (rad/s,
//     rad/min and rev/day do not), and agrees with an independent
//     finite-difference Jacobian written here. SP messages that cannot be
//     redistributed are checked when VCM_PRIVATE_DIR names them.
// (2) The PRW request it builds runs in HPOP, with B as a dynamic parameter.
// (3) ocm turns HPOP's result into an $OCM and write turns that into a VCM
//     that read recovers: the state to the printed digits and the covariance
//     to its five.
// (4) read's $OCM carries everything the message states, and write prints it
//     back: VCM -> OCM -> VCM text reproduces the printed U, V, W sigmas
//     within 1 % and the covariance to 2e-5 of its sigmas.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { decodeFlowNotice } from 'space-data-module-sdk/runtime-contracts';
import * as flatbuffers from 'flatbuffers';
import * as sdsOcm from 'spacedatastandards.org/lib/js/OCM/main.js';
import * as sds from 'spacedatastandards.org/lib/js/PRW/main.js';

const here = (p) => new URL(p, import.meta.url);
const SAMPLE = fs.readFileSync(here('fixtures/sample-vcm.txt'));
// Typed contracts 1.0: the VCM text is a $FIL (CONTENT), the read options / ocm header / write options are node config
// (plugin.getConfig answered by the SDK host from hostOptions.config: tables "read", "header", "write"), and read's
// report is a FlowNotice whose ITEMS are "key=value" lines.
const load = async (dir, config = {}) => createBrowserModuleHarness({ wasmSource: fs.readFileSync(here(`${dir}/dist/isomorphic/module.wasm`)), manifest: JSON.parse(fs.readFileSync(here(`${dir}/plugin-manifest.json`), 'utf8')), surface: 'direct', hostOptions: { config } });
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL('../node_modules/spacedatastandards.org/', import.meta.url));
// $FIL from the standard's own TypeScript bindings (lib/ts/FIL), bundled with the standards repo's esbuild.
const { FIL } = await (async () => {
  const esbuild = createRequire(path.join(STANDARDS_ROOT, 'package.json'))('esbuild');
  const built = await esbuild.build({ stdin: { contents: 'export * from "./lib/ts/FIL/main.ts";', resolveDir: STANDARDS_ROOT, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
})();
const FIL_REF = { schemaName: 'FIL.fbs', fileIdentifier: '$FIL', rootTypeName: 'FIL', wireFormat: 'flatbuffer' };
const filOf = (text) => {
  const b = new flatbuffers.Builder(1024);
  const content = FIL.createContentVector(b, new Uint8Array(text));
  FIL.startFIL(b); FIL.addContent(b, content); FIL.finishFILBuffer(b, FIL.endFIL(b));
  return b.asUint8Array();
};
const message = (text) => ({ portId: 'message', typeRef: FIL_REF, payload: filOf(text) });
const textOf = (bytes) => { const f = FIL.getRootAsFIL(new flatbuffers.ByteBuffer(new Uint8Array(bytes))); assert.equal(f.MEDIA_TYPE(), 'text/plain'); return Buffer.from(f.contentArray()).toString(); };
// The FlowNotice report back as the object the items describe: numbers and number lists parsed, parameterSigma and note
// lines collected, integrator.* nested.
const LIST_TEXT = new Set(['dynamicParameters']);
const reportOf = (bytes) => {
  const n = decodeFlowNotice(bytes);
  assert.equal(n.kind, 'info'); assert.equal(n.schema, 'OCM.fbs');
  const r = { parameterSigmas: [], notes: [], integrator: {} };
  for (const item of n.items) {
    const at = item.indexOf('='), key = item.slice(0, at), v = item.slice(at + 1);
    const value = v === 'true' ? true : v === 'false' ? false : LIST_TEXT.has(key) ? v.split(' ').filter(Boolean)
      : v !== '' && v.split(' ').every((x) => x !== '' && !Number.isNaN(Number(x))) ? (v.includes(' ') || /Km$|KmS$|Arcsec$|equinoctial$/.test(key) ? v.split(' ').map(Number) : Number(v)) : v;
    if (key === 'parameterSigma') { const [name, unit, val, sigma] = v.split(' '); r.parameterSigmas.push({ name, unit, value: Number(val), sigma: Number(sigma) }); }
    else if (key === 'note') r.notes.push(v);
    else if (key.startsWith('integrator.')) r.integrator[key.slice(11)] = value;
    else r[key] = value;
  }
  if (r.cartesianCovarianceKm === '') r.cartesianCovarianceKm = null;
  return r;
};
const decodePrw = (bytes) => sds.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack();
// One invocation of the adapter with its node config.
const call = async (config, methodId, inputs) => { const h = await load('..', config); try { return await h.invoke({ methodId, inputs }); } finally { h.destroy(); } };
const readWith = async (h, text) => h.invoke({ methodId: 'read', inputs: [message(text)] });
const PRW = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
const OCM_REF = { schemaName: 'OCM.fbs', fileIdentifier: '$OCM', rootTypeName: 'OCM', wireFormat: 'flatbuffer' };
const EOP_REF = { schemaName: 'EOP.fbs', fileIdentifier: '$EOP', rootTypeName: 'EOP', wireFormat: 'flatbuffer' };
const out = (response, port) => response.outputs.find((o) => o.portId === port).payload;
const ok = (response) => { assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`); return response; };

// Independent equinoctial -> Cartesian (Vallado 2013 sec. 2.4.3), n in rad per
// `scale` seconds, for the finite-difference check.
function toCartesian([af, ag, L, N, chi, psi], mu, fr, scale) {
  const n = N / scale, a = Math.cbrt(mu / (n * n));
  let F = L;
  for (let k = 0; k < 50; ++k) F -= (F + ag * Math.cos(F) - af * Math.sin(F) - L) / (1 - ag * Math.sin(F) - af * Math.cos(F));
  const b = 1 / (1 + Math.sqrt(1 - af * af - ag * ag)), c = Math.cos(F), s = Math.sin(F);
  const x = a * ((1 - ag * ag * b) * c + af * ag * b * s - af), y = a * ((1 - af * af * b) * s + af * ag * b * c - ag);
  const r = a * (1 - af * c - ag * s), k = n * a * a / r;
  const xd = k * (af * ag * b * c - (1 - ag * ag * b) * s), yd = k * ((1 - af * af * b) * c - af * ag * b * s);
  const d = 1 + chi * chi + psi * psi;
  const f = [(1 - chi * chi + psi * psi) / d, 2 * chi * psi / d, -2 * fr * chi / d];
  const g = [2 * fr * chi * psi / d, fr * (1 + chi * chi - psi * psi) / d, 2 * psi / d];
  return [0, 1, 2].map((i) => x * f[i] + y * g[i]).concat([0, 1, 2].map((i) => xd * f[i] + yd * g[i]));
}
const lowerTriangle = (text) => {
  const lines = text.split('\n'), at = lines.findIndex((l) => l.includes('COVARIANCE MATRIX'));
  const n = Number(/\(\s*(\d+)\s*x/.exec(lines[at])[1]);
  const values = lines.slice(at + 1).join(' ').replace(/<>/g, ' ').trim().split(/\s+/).filter(Boolean).map(Number).slice(0, (n * (n + 1)) / 2);
  const p = Array(n * n).fill(0); let k = 0;
  for (let i = 0; i < n; ++i) for (let j = 0; j <= i; ++j) p[i * n + j] = p[j * n + i] = values[k++];
  return { n, p };
};

test('read: the transformed covariance reproduces the VCM\'s own sigmas', async (t) => {
  const report = async (options) => { const h = await load('..', { read: options }); try { return reportOf(out(ok(await readWith(h, SAMPLE)), 'report')); } finally { h.destroy(); } };
  const r = await report({});
  assert.equal(r.meanMotionUnit, 'fraction');
  t.diagnostic(`stated ${r.statedUvwSigmasKm.slice(0, 3).map((x) => (x * 1000).toFixed(1))} m, recomputed ${r.recomputedUvwSigmasKm.slice(0, 3).map((x) => (x * 1000).toFixed(2))} m`);
  // Within 1 % (the printed covariance has five digits); see sigmasOf below
  // for the messages that settle the mean-motion row.
  for (let i = 0; i < 3; ++i) assert.ok(Math.abs(r.recomputedUvwSigmasKm[i] / r.statedUvwSigmasKm[i] - 1) < 0.01, `axis ${i}`);
  assert.ok(r.equinoctialRoundTripKm < 1e-9, `round trip ${r.equinoctialRoundTripKm}`);
  assert.deepEqual(r.dynamicParameters, ['DRAG_AREA_OVER_MASS']);
  assert.ok(Math.abs(r.covarianceScale - r.weightedRms ** 2) < 1e-12, 'WTD RMS above 1 scales the covariance');
  for (const unit of ['rad/s', 'rad/min', 'rev/day']) {
    const other = await report({ meanMotionUnit: unit });
    assert.ok(Math.abs(other.recomputedUvwSigmasKm[0] / r.statedUvwSigmasKm[0] - 1) > 0.04, `${unit} would also reproduce the radial sigma`);
  }
  // The Jacobian against central differences of the independent conversion,
  // with the n row taken as dn/n.
  const { n, p } = lowerTriangle(SAMPLE.toString());
  const e = r.equinoctial, J = [];
  for (let k = 0; k < 6; ++k) {
    const d = 1e-6 * Math.max(1e-3, Math.abs(e[k])), plus = e.slice(), minus = e.slice();
    plus[k] += d; minus[k] -= d;
    const a = toCartesian(plus, r.gmKm3S2, r.retrogradeFactor, 1000), b = toCartesian(minus, r.gmKm3S2, r.retrogradeFactor, 1000);
    J.push(a.map((x, i) => ((x - b[i]) / (2 * d)) * (k === 3 ? e[3] : 1)));
  }
  const scale = r.covarianceScale, m = 7;
  let worst = 0;
  for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j) {
    let s = 0;
    for (let a = 0; a < 6; ++a) for (let b = 0; b < 6; ++b) s += J[a][i] * p[a * n + b] * J[b][j];
    worst = Math.max(worst, Math.abs(r.cartesianCovarianceKm[i * m + j] - s * scale) / Math.sqrt(r.cartesianCovarianceKm[i * m + i] * r.cartesianCovarianceKm[j * m + j]));
  }
  t.diagnostic(`Cartesian covariance against finite differences: ${worst.toExponential(2)} of the sigmas`);
  assert.ok(worst < 1e-6, `${worst}`);
});

// SP messages that cannot be redistributed: set VCM_PRIVATE_DIR to a
// directory of *.vcm files to check them. Every printed sigma must be
// reproduced within 1 % with the defaults; a message with a weighted RMS
// below 1 must match unscaled; and some message must rule out rad/ks, the
// unit the survey's sample alone cannot tell from dn/n.
test('read: private SP messages (VCM_PRIVATE_DIR)', { skip: !process.env.VCM_PRIVATE_DIR && 'VCM_PRIVATE_DIR not set' }, async (t) => {
  const dir = process.env.VCM_PRIVATE_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.vcm'));
  assert.ok(files.length > 0, 'no .vcm files');
  let radKsExcluded = false;
  for (const f of files) {
    const text = fs.readFileSync(`${dir}/${f}`);
    const read = async (options) => { const h = await load('..', { read: options }); try { return reportOf(out(ok(await readWith(h, text)), 'report')); } finally { h.destroy(); } };
    const r = await read({ ephemerisSource: 'Analytical' });
    const dev = r.statedUvwSigmasKm.slice(0, 3).map((s, i) => r.recomputedUvwSigmasKm[i] / s - 1);
    t.diagnostic(`${f}: deviations ${dev.map((d) => (d * 100).toFixed(2)).join('/')} %, scale ${r.covarianceScale.toFixed(3)}, ${r.parameterSigmas.map((p) => `${p.name} ${(100 * p.sigma / p.value).toFixed(1)} %`).join(', ')}`);
    for (const d of dev) assert.ok(Math.abs(d) < 0.01, `${f}: ${dev}`);
    if (r.weightedRms < 1) assert.equal(r.covarianceScale, 1);
    const ks = await read({ ephemerisSource: 'Analytical', meanMotionUnit: 'rad/ks' });
    if (Math.abs(ks.recomputedUvwSigmasKm[0] / ks.statedUvwSigmasKm[0] - 1) > 0.1) radKsExcluded = true;
    await assertReproduced(t, text, f, { ephemerisSource: 'Analytical' });   // VCM -> OCM -> VCM text
  }
  assert.ok(radKsExcluded, 'no message rules out rad/ks');
});

// The $OCM read wrote, decoded with the released SDS bindings.
const decodeOcm = (bytes) => sdsOcm.OCM.getSizePrefixedRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack();
// A VCM through read and write: the text written from the $OCM and the $EOP records read wrote.
async function throughOcm(text, options = {}) {
  const vcm = await load('..', { read: options });
  try {
    const read = ok(await readWith(vcm, text));
    const written = ok(await vcm.invoke({ methodId: 'write', inputs: [{ portId: 'ocm', typeRef: OCM_REF, payload: out(read, 'ocm') }, { portId: 'eop', typeRef: EOP_REF, payload: out(read, 'eop') }] }));
    return { read, report: reportOf(out(read, 'report')), ocm: decodeOcm(out(read, 'ocm')), text: textOf(out(written, 'message')) };
  } finally { vcm.destroy(); }
}
const messageLines = (text) => text.split('\n').map((l) => l.replace(/^<>\s?/, '').replace(/\s+/g, ' ').trim());
const lineOf = (text, label) => messageLines(text).find((l) => l.startsWith(label));
const sigmasOf = (text) => ['VECTOR U,V,W SIGMAS (KM):', 'VECTOR UD,VD,WD SIGMAS (KM/S):'].flatMap((label) => lineOf(text, label).slice(label.length).trim().split(' ').map(Number));
// VCM -> OCM -> VCM text for one message: the printed sigmas within 1 %, the covariance to 2e-5 of its sigmas, and
// every line that states a model, a parameter, an Earth orientation value or an integrator setting as it was.
async function assertReproduced(t, text, name, options) {
  const { text: again } = await throughOcm(text, options);
  const was = sigmasOf(text.toString()), is = sigmasOf(again);
  // Within 1 % of what the message printed, plus the half unit of the fourth decimal the new text prints them to.
  for (let i = 0; i < 6; ++i) assert.ok(Math.abs(is[i] - was[i]) <= 0.01 * was[i] + 0.5e-4 + 1e-12, `${name}: sigma ${i} ${is[i]} against ${was[i]}`);
  const a = lowerTriangle(text.toString()), b = lowerTriangle(again);
  assert.equal(b.n, a.n, `${name}: covariance size`);
  let worst = 0;
  for (let i = 0; i < a.n; ++i) for (let j = 0; j < a.n; ++j) worst = Math.max(worst, Math.abs(b.p[i * a.n + j] - a.p[i * a.n + j]) / Math.sqrt(a.p[i * a.n + i] * a.p[j * a.n + j] || 1));
  t.diagnostic(`${name}: covariance ${worst.toExponential(2)} of the sigmas, sigmas ${was.map((x, i) => (is[i] / (x || 1)).toFixed(4)).join('/')}`);
  assert.ok(worst < 2e-5, `${name}: covariance ${worst}`);
  for (const label of ['J2K POS (KM):', 'J2K VEL (KM/S):', 'GEOPOTENTIAL:', 'SOLAR RAD PRESS:', 'BALLISTIC COEF', 'SOLAR RAD PRESS COEFF', 'THRUST ACCEL', 'SOLAR FLUX:', 'TAI-UTC',
    'POLAR MOT', 'TIME CONST LEAP', 'INTEGRATOR MODE:', 'STEP MODE:', 'INITIAL STEP SIZE', 'SATELLITE NUMBER:', 'COMMON NAME:']) {
    assert.equal(lineOf(again, label), lineOf(text.toString(), label), `${name}: ${label}`);
  }
  assert.equal(lineOf(again, 'COVARIANCE MATRIX').replace(/WTD.*/, ''), lineOf(text.toString(), 'COVARIANCE MATRIX').replace(/WTD.*/, ''), `${name}: covariance size line`);
  assert.equal(lineOf(again, 'COVARIANCE MATRIX').replace(/.*WTD RMS:/, ''), lineOf(text.toString(), 'COVARIANCE MATRIX').replace(/.*WTD RMS:/, ''), `${name}: weighted RMS`);
}

test('read -> write: the sample VCM comes back from its OCM with its sigmas and covariance', async (t) => {
  await assertReproduced(t, SAMPLE, 'sample', {});
});

// The shapes the sample does not have, built on the sample's covariance: a covariance reaching B, BDOT, AGOM and T
// (10x10) with radiation pressure and in-track thrust on, a geostationary orbit, a retrograde orbit and an
// eccentric one with a weighted RMS below 1 (so unscaled). The printed sigmas are those the module recomputes from
// the covariance, as SP's are, so the round trip is checked on messages whose sigmas agree with their covariance.
const fortranE = (x, digits = 5) => {
  if (x === 0) return `0.${'0'.repeat(digits)}E+00`;
  let e = Math.floor(Math.log10(Math.abs(x))) + 1, m = Math.round((Math.abs(x) / 10 ** e) * 10 ** digits);
  if (m >= 10 ** digits) { m = 10 ** (digits - 1); ++e; }
  return `${x < 0 ? '-' : ''}0.${String(m).padStart(digits, '0')}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
};
function variantOf({ pos, vel, rms, size, thrust = 0, agom = 0, bdot = 0, srp = false, sigmas = [0, 0, 0, 0, 0, 0] }) {
  const base = lowerTriangle(SAMPLE.toString());
  const p = Array.from({ length: size * size }, () => 0);
  for (let i = 0; i < 7; ++i) for (let j = 0; j < 7; ++j) p[i * size + j] = base.p[i * 7 + j];
  const variance = [0, 0, 0, 0, 0, 0, 0, 1e-18, 2e-3, 1e-18];
  for (let i = 7; i < size; ++i) p[i * size + i] = variance[i];
  for (let i = 6; i < size; ++i) for (let j = 0; j < i; ++j) if (i > 6 || j >= 6) p[i * size + j] = p[j * size + i] = 0.05 * Math.sqrt(p[i * size + i] * p[j * size + j]) * (j % 2 ? 1 : -1);
  const values = [];
  for (let i = 0; i < size; ++i) for (let j = 0; j <= i; ++j) values.push(fortranE(p[i * size + j]));
  const rows = [];
  for (let k = 0; k < values.length; k += 5) rows.push(`<> ${values.slice(k, k + 5).map((v) => v.padStart(12)).join(' ')}`);
  const pad = (x, w, d) => x.toFixed(d).padStart(w);
  const lines = SAMPLE.toString().split('\n').filter((l) => !/^<> *-?\d?\.\d+E/.test(l)).map((line) => {
    if (line.startsWith('<> J2K POS')) return `<> J2K POS (KM):  ${pos.map((x) => pad(x, 16, 8)).join(' ')}`;
    if (line.startsWith('<> J2K VEL')) return `<> J2K VEL (KM/S): ${vel.map((x) => pad(x, 16, 12)).join(' ')}`;
    if (line.startsWith('<> SOLAR RAD PRESS:')) return `<> SOLAR RAD PRESS: ${srp ? ' ON' : 'OFF'}  SOLID EARTH TIDES:  ON  IN-TRACK THRUST: ${thrust ? ' ON' : 'OFF'}`;
    if (line.startsWith('<> BALLISTIC')) return `<> BALLISTIC COEF (M2/KG):  0.826455E-02 BDOT (M2/KG-S): ${fortranE(bdot, 6)}`;
    if (line.startsWith('<> SOLAR RAD PRESS COEFF')) return `<> SOLAR RAD PRESS COEFF (M2/KG):  ${fortranE(agom, 6)}  EDR(W/KG):  0.39E-02`;
    if (line.startsWith('<> THRUST ACCEL')) return `<> THRUST ACCEL (M/S2):  ${fortranE(thrust, 6)}  C.M. OFFSET (M):  0.000000E+00`;
    if (line.startsWith('<> VECTOR U,V,W')) return `<> VECTOR U,V,W SIGMAS (KM):        ${sigmas.slice(0, 3).map((x) => pad(x, 10, 4)).join(' ')}`;
    if (line.startsWith('<> VECTOR UD,VD,WD')) return `<> VECTOR UD,VD,WD SIGMAS (KM/S):    ${sigmas.slice(3).map((x) => pad(x, 10, 4)).join(' ')}`;
    if (line.startsWith('<> COVARIANCE MATRIX')) return `<> COVARIANCE MATRIX (EQUINOCTIAL ELS): (${String(size).padStart(2)}x${String(size).padStart(2)}) WTD RMS: ${fortranE(rms)}`;
    return line;
  });
  return Buffer.from(`${lines.filter((l) => l !== '').join('\n')}\n${rows.join('\n')}\n`);
}
test('read -> write: shapes the sample does not have, from 7x7 to 10x10, retrograde, geostationary, eccentric, unscaled', async (t) => {
  const h = await load('..', { read: {} }); t.after(() => h.destroy());
  const shapes = {
    'size 10 with thrust and radiation pressure': { pos: [369.89521989, 5103.23778139, 4467.41312115], vel: [-6.491206849227, -2.407500055425, 3.279477293781], rms: 1.15, size: 10, thrust: 3.1e-9, agom: 0.0211, bdot: 2.4e-10, srp: true },
    'geostationary': { pos: [42164.0, 112.5, 83.25], vel: [-0.0083, 3.0746, 0.0537], rms: 1.09, size: 8, bdot: 1e-12 },
    'retrograde': { pos: [7000.0, 40.0, 25.0], vel: [0.2, -1.05, 7.47], rms: 1.12, size: 7 },
    'eccentric, weighted RMS below 1': { pos: [7000.0, 0.0, 0.0], vel: [0.0, 9.0, 3.07], rms: 0.86, size: 7 },
  };
  for (const [name, shape] of Object.entries(shapes)) {
    const r = reportOf(out(ok(await readWith(h, variantOf(shape))), 'report'));
    assert.equal(r.covarianceSize, shape.size, name);
    const text = variantOf({ ...shape, sigmas: r.recomputedUvwSigmasKm.map((x) => Number(x.toFixed(4))) });
    await assertReproduced(t, text, name, {});
  }
});

test('read: the $OCM carries the state, the covariance with its parameter row, the force model and the settings', async (t) => {
  const { ocm, report } = await throughOcm(SAMPLE, {});
  assert.equal(ocm.HEADER.ORIGINATOR, 'FAKE_CENTER');
  assert.equal(ocm.METADATA.OBJECT_DESIGNATOR, '00000');
  assert.equal(ocm.METADATA.INTERNATIONAL_DESIGNATOR, '0000-000A');
  assert.equal(ocm.METADATA.TIME_SYSTEM, 'UTC');
  assert.equal(ocm.METADATA.TAIMUTC_AT_TZERO, 37);
  assert.equal(ocm.METADATA.UT1MUTC_AT_TZERO, -0.01719);
  assert.equal(ocm.TRAJ_REF_FRAME.NAME, 'EME2000');
  assert.equal(ocm.CENTER_NAME, 'EARTH');
  assert.equal(ocm.ORB_REVNUM, 37693);
  assert.deepEqual(ocm.STATE_DATA, [...report.j2kPositionKm, ...report.j2kVelocityKmS]);
  // the covariance: Cartesian, lower triangle, six state rows and the B row
  assert.equal(ocm.COV_TYPE, 'CARTPV');
  assert.equal(ocm.COV_ORDERING, sdsOcm.covarianceOrdering.LTM);
  assert.equal(ocm.COV_SIZE, 7);
  assert.deepEqual(ocm.COV_PARAMETERS, ['DRAG_AREA_OVER_MASS']);
  assert.deepEqual(ocm.COV_UNITS, ['km', 'km', 'km', 'km/s', 'km/s', 'km/s', 'm**2/kg']);
  assert.equal(ocm.COV_REF_FRAME.NAME, 'EME2000');
  assert.equal(ocm.COVARIANCE_DATA.length, 28);
  for (let i = 0; i < 7; ++i) for (let j = 0; j <= i; ++j) assert.equal(ocm.COVARIANCE_DATA[(i * (i + 1)) / 2 + j], report.cartesianCovarianceKm[i * 7 + j]);
  // the parameters' values and the weighted RMS
  const byName = Object.fromEntries(ocm.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS.map((p) => [p.NAME, p]));
  assert.deepEqual(Object.keys(byName), ['DRAG_AREA_OVER_MASS', 'DRAG_AREA_OVER_MASS_RATE', 'SRP_AREA_OVER_MASS']);  // no thrust: IN-TRACK THRUST is OFF
  assert.equal(byName.DRAG_AREA_OVER_MASS.VALUE, 0.826455e-2);
  assert.equal(byName.DRAG_AREA_OVER_MASS.UNITS, 'm**2/kg');
  assert.equal(byName.DRAG_AREA_OVER_MASS.SOLVED_FOR, true);
  assert.equal(byName.DRAG_AREA_OVER_MASS_RATE.SOLVED_FOR, false);
  assert.equal(ocm.ORBIT_DETERMINATION.WEIGHTED_RMS, 0.11498e1);
  assert.equal(ocm.ORBIT_DETERMINATION.SEDR, 0.39e-2);
  // the force model
  assert.equal(ocm.PERTURBATIONS.GEOPOTENTIAL_MODEL, 'EGM-96 70Z,70T');
  assert.equal(ocm.PERTURBATIONS.ATMOSPHERIC_DRAG, 'JAC70/MSIS90');
  assert.deepEqual(ocm.PERTURBATIONS.N_BODY_PERTURBATIONS, ['MOON', 'SUN']);
  assert.equal(ocm.PERTURBATIONS.SOLAR_RAD_PRESSURE, 'OFF');
  assert.equal(ocm.PERTURBATIONS.SOLID_TIDES_MODEL, 'ON');
  assert.equal(ocm.PERTURBATIONS.FIXED_F10P7, 153);
  assert.equal(ocm.PERTURBATIONS.FIXED_GEOMAG_AP, 10);
  // the integrator settings ride as user-defined parameters
  const user = Object.fromEntries(ocm.USER_DEFINED_PARAMETERS.map((u) => [u.PARAM_NAME, u.PARAM_VALUE]));
  assert.equal(user.VCM_INTEGRATOR_MODE, 'ASW');
  assert.equal(user.VCM_PARTIALS, 'FAST NUM');
  assert.equal(user.VCM_STEP_SIZE_SELECTION, 'MANUAL');
  assert.equal(user.VCM_NUTATION_TERMS, '4');
});

test('read -> HPOP -> ocm -> write -> read round trip', async (t) => {
  const hpop = await load('../../../propagator/hpop');
  t.after(() => hpop.destroy());
  const options = { ephemerisSource: 'Analytical', arcSeconds: 3600 };
  const read = ok(await call({ read: options }, 'read', [message(SAMPLE)]));
  const report = reportOf(out(read, 'report'));
  const request = decodePrw(out(read, 'request')).EXECUTION_REQUEST;
  assert.equal(request.INITIAL.COORDINATE_SYSTEM.AXIS_TYPE, sds.rfmAxisType.MEAN_EQUATOR_EQUINOX_J2000);
  assert.equal(request.FORCES.GRAVITY_CHOICE, sds.prwGravitySelection.EGM96);
  assert.equal(request.FORCES.ATMOSPHERE_MODEL, sds.prwAtmosphereFamily.JACCHIA_ROBERTS);
  assert.equal(request.INITIAL_COVARIANCE.DIMENSION, 7);
  const run = ok(await hpop.invoke({ methodId: 'invoke', inputs: [{ portId: 'request', typeRef: PRW, payload: out(read, 'request') }, { portId: 'earth_orientation', typeRef: PRW, payload: out(read, 'earth_orientation') }] }));
  const result = decodePrw(out(run, 'response')).EXECUTION_RESULT;
  const final = result.FINAL_SAMPLE;
  assert.equal(final.COVARIANCE.DIMENSION, 7);
  const header = {
    satelliteNumber: 0, internationalDesignator: report.internationalDesignator, commonName: 'ROUND TRIP', center: 'SDN',
    geopotential: report.geopotential, zonals: report.zonals, tesserals: report.tesserals, drag: report.drag,
    lunarSolar: 'ON', solarRadiationPressure: 'OFF', solidEarthTides: 'ON', inTrackThrust: 'OFF',
    ballisticCoefficient: report.ballisticCoefficientM2Kg, f10: report.f10, averageF10: report.averageF10, averageAp: report.averageAp,
    taiMinusUtcS: report.taiMinusUtcS, ut1MinusUtcS: report.ut1MinusUtcS, weightedRms: 1,
  };
  const toOcm = async (extra) => out(ok(await call({ header: { ...header, ...extra } }, 'ocm', [{ portId: 'result', typeRef: PRW, payload: out(run, 'response') }])), 'ocm');
  const ocm = await toOcm({});
  const record = decodeOcm(ocm);
  assert.equal(record.COV_SIZE, 7);
  assert.deepEqual(record.COV_PARAMETERS, ['DRAG_AREA_OVER_MASS']);
  assert.equal(record.TRAJ_REF_FRAME.NAME, 'EME2000');
  assert.equal(record.METADATA.OBJECT_NAME, 'ROUND TRIP');
  const writeText = async (bytes) => textOf(out(ok(await call({}, 'write', [{ portId: 'ocm', typeRef: OCM_REF, payload: bytes }, { portId: 'eop', typeRef: EOP_REF, payload: out(read, 'eop') }])), 'message'));
  const text = await writeText(ocm);
  t.diagnostic(text.split('\n').slice(0, 8).join('\n'));
  const back = reportOf(out(ok(await call({ read: { ...options, scaleCovarianceByWeightedRms: false } }, 'read', [message(Buffer.from(text))])), 'report'));
  const position = [final.STATE.STATE.POSITION.X, final.STATE.STATE.POSITION.Y, final.STATE.STATE.POSITION.Z].map((x) => x / 1000);
  for (let i = 0; i < 3; ++i) assert.ok(Math.abs(back.j2kPositionKm[i] - position[i]) < 1e-8, 'position');
  const P = [...final.COVARIANCE.VALUES], m = 7;
  let worst = 0;
  for (let i = 0; i < m; ++i) for (let j = 0; j < m; ++j) {
    const si = i < 6 ? 1e3 : 1, sj = j < 6 ? 1e3 : 1;
    const expected = P[i * m + j] / (si * sj), scaleIJ = Math.sqrt((P[i * m + i] / (si * si)) * (P[j * m + j] / (sj * sj)));
    worst = Math.max(worst, Math.abs(back.cartesianCovarianceKm[i * m + j] - expected) / scaleIJ);
  }
  t.diagnostic(`covariance through the OCM, VCM text and back: ${worst.toExponential(2)} of the sigmas`);
  assert.ok(worst < 2e-4, `${worst}`);
  // With the message's own weighted RMS (above 1) in the header, the text
  // carries the covariance divided by RMS^2 and prints the sigmas of the
  // result; a default read restores the result's covariance.
  const scaled = await writeText(await toOcm({ weightedRms: report.weightedRms }));
  assert.match(scaled, /WTD RMS:\s+0\.11498E\+01/);
  const again = reportOf(out(ok(await call({ read: options }, 'read', [message(Buffer.from(scaled))])), 'report'));
  let worstScaled = 0;
  for (let i = 0; i < m; ++i) for (let j = 0; j < m; ++j) {
    const si = i < 6 ? 1e3 : 1, sj = j < 6 ? 1e3 : 1;
    const expected = P[i * m + j] / (si * sj), scaleIJ = Math.sqrt((P[i * m + i] / (si * si)) * (P[j * m + j] / (sj * sj)));
    worstScaled = Math.max(worstScaled, Math.abs(again.cartesianCovarianceKm[i * m + j] - expected) / scaleIJ);
  }
  assert.ok(worstScaled < 2e-4, `${worstScaled}`);
  for (let i = 0; i < 3; ++i) assert.ok(Math.abs(again.recomputedUvwSigmasKm[i] / again.statedUvwSigmasKm[i] - 1) < 0.01, `printed sigma ${i}`);
});

// (5) The parameter rows' units are not stated in the format; parameterRows
//     chooses. Read as printed, the sample's B sigma is 5.1 times B; read as
//     a fraction of B, 4.3 %. Fractional rows go back out as fractions.
test('parameterRows: B row as printed or as a fraction of B', async (t) => {
  const hpop = await load('../../../propagator/hpop');
  t.after(() => hpop.destroy());
  const options = { ephemerisSource: 'Analytical', arcSeconds: 3600 };
  const read = async (rows) => ok(await call({ read: { ...options, parameterRows: rows } }, 'read', [message(SAMPLE)]));
  const absolute = reportOf(out(await read('absolute'), 'report')), fractional = reportOf(out(await read('fractional'), 'report'));
  const printed = Math.sqrt(0.13665e-2) * 0.11498e1, b = 0.826455e-2;
  assert.equal(absolute.parameterRows, 'absolute');
  assert.equal(fractional.parameterRows, 'fractional');
  assert.ok(Math.abs(absolute.parameterSigmas[0].sigma - printed) < 1e-9 * printed);
  assert.ok(Math.abs(fractional.parameterSigmas[0].sigma - printed * b) < 1e-9 * printed * b);
  t.diagnostic(`B sigma as printed ${(printed / b).toFixed(2)} x B; as a fraction ${(100 * printed).toFixed(2)} % of B`);
  // The six element rows are the same either way.
  for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j)
    assert.equal(absolute.cartesianCovarianceKm[i * 7 + j], fractional.cartesianCovarianceKm[i * 7 + j]);
  assert.deepEqual(fractional.recomputedUvwSigmasKm, absolute.recomputedUvwSigmasKm);
  // Fractional rows written back as fractions: the B variance survives the
  // round trip through HPOP at zero arc length's worth of drift (1 h here).
  const r = await read('fractional');
  const run = ok(await hpop.invoke({ methodId: 'invoke', inputs: [{ portId: 'request', typeRef: PRW, payload: out(r, 'request') }, { portId: 'earth_orientation', typeRef: PRW, payload: out(r, 'earth_orientation') }] }));
  const header = { geopotential: fractional.geopotential, zonals: fractional.zonals, tesserals: fractional.tesserals, drag: fractional.drag, ballisticCoefficient: b, weightedRms: 1, parameterRows: 'fractional' };
  const ocm = out(ok(await call({ header }, 'ocm', [{ portId: 'result', typeRef: PRW, payload: out(run, 'response') }])), 'ocm');
  const text = textOf(out(ok(await call({}, 'write', [{ portId: 'ocm', typeRef: OCM_REF, payload: ocm }])), 'message'));
  const { n, p } = lowerTriangle(text);
  assert.equal(n, 7);
  // B is a constant of the motion: its variance is unchanged by propagation.
  assert.ok(Math.abs(p[6 * 7 + 6] - printed ** 2) < 1e-4 * printed ** 2, `${p[6 * 7 + 6]} vs ${printed ** 2}`);
  const bad = await call({ read: { parameterRows: 'percent' } }, 'read', [message(SAMPLE)]);
  assert.notEqual(bad.statusCode, 0);
});

// Typed contracts 1.0: one concrete FlatBuffer type on every port, and the artifact passes SDK compliance.
test('every port names one FlatBuffer type; SDK compliance', async () => {
  const { validateArtifactWithStandards } = await import('space-data-module-sdk/compliance');
  const manifest = JSON.parse(fs.readFileSync(here('../plugin-manifest.json'), 'utf8'));
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(here('../dist/isomorphic/module.wasm')), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const method of manifest.methods) for (const port of [...method.inputPorts, ...method.outputPorts]) {
    assert.equal(port.acceptedTypeSets.length, 1, port.portId);
    const [type, ...rest] = port.acceptedTypeSets[0].allowedTypes;
    assert.equal(rest.length, 0, port.portId);
    assert.equal(type.acceptsAnyFlatbuffer, undefined, port.portId);
    assert.equal(type.wireFormat, 'flatbuffer', port.portId);
    ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
  }
  assert.deepEqual(ids, {
    'read.message': '$FIL', 'read.request': '$PRW', 'read.earth_orientation': '$PRW', 'read.eop': '$EOP', 'read.ocm': '$OCM', 'read.report': 'FNTC',
    'ocm.result': '$PRW', 'ocm.ocm': '$OCM', 'write.ocm': '$OCM', 'write.eop': '$EOP', 'write.message': '$FIL',
  });
});

test('config: unknown keys and non-scalar values are refused; a refused message', async () => {
  for (const config of [{ read: { nope: 1 } }, { read: { arcSeconds: [1, 2] } }]) {
    const r = await call(config, 'read', [message(SAMPLE)]);
    assert.equal(r.errorCode, 'invalid-options', JSON.stringify(config));
  }
  assert.notEqual((await call({}, 'read', [message(Buffer.from('<> NOT A MESSAGE\n'))])).statusCode, 0);
});
