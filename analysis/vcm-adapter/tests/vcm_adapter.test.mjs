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
// (3) write turns HPOP's result back into a VCM that read recovers: the
//     state to the printed digits and the covariance to its five.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { decodePrw, sds } from '../../../propagator/hpop/tests/lib/prwCodec.mjs';

const here = (p) => new URL(p, import.meta.url);
const SAMPLE = fs.readFileSync(here('fixtures/sample-vcm.txt'));
const load = async (dir) => createBrowserModuleHarness({ wasmSource: fs.readFileSync(here(`${dir}/dist/isomorphic/module.wasm`)), manifest: JSON.parse(fs.readFileSync(here(`${dir}/plugin-manifest.json`), 'utf8')), surface: 'direct' });
const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)) });
const PRW = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
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
  const h = await load('..'); t.after(() => h.destroy());
  const report = (options) => h.invoke({ methodId: 'read', inputs: [{ portId: 'message', payload: SAMPLE }, json('options', options)] }).then((r) => JSON.parse(Buffer.from(out(ok(r), 'report')).toString()));
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
  const h = await load('..'); t.after(() => h.destroy());
  const dir = process.env.VCM_PRIVATE_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.vcm'));
  assert.ok(files.length > 0, 'no .vcm files');
  let radKsExcluded = false;
  for (const f of files) {
    const text = fs.readFileSync(`${dir}/${f}`);
    const read = (options) => h.invoke({ methodId: 'read', inputs: [{ portId: 'message', payload: text }, json('options', options)] }).then((r) => JSON.parse(Buffer.from(out(ok(r), 'report')).toString()));
    const r = await read({ ephemerisSource: 'Analytical' });
    const dev = r.statedUvwSigmasKm.slice(0, 3).map((s, i) => r.recomputedUvwSigmasKm[i] / s - 1);
    t.diagnostic(`${f}: deviations ${dev.map((d) => (d * 100).toFixed(2)).join('/')} %, scale ${r.covarianceScale.toFixed(3)}, ${r.parameterSigmas.map((p) => `${p.name} ${(100 * p.sigma / p.value).toFixed(1)} %`).join(', ')}`);
    for (const d of dev) assert.ok(Math.abs(d) < 0.01, `${f}: ${dev}`);
    if (r.weightedRms < 1) assert.equal(r.covarianceScale, 1);
    const ks = await read({ ephemerisSource: 'Analytical', meanMotionUnit: 'rad/ks' });
    if (Math.abs(ks.recomputedUvwSigmasKm[0] / ks.statedUvwSigmasKm[0] - 1) > 0.1) radKsExcluded = true;
  }
  assert.ok(radKsExcluded, 'no message rules out rad/ks');
});

test('read -> HPOP -> write -> read round trip', async (t) => {
  const vcm = await load('..'), hpop = await load('../../../propagator/hpop');
  t.after(() => { vcm.destroy(); hpop.destroy(); });
  const options = { ephemerisSource: 'Analytical', arcSeconds: 3600 };
  const read = ok(await vcm.invoke({ methodId: 'read', inputs: [{ portId: 'message', payload: SAMPLE }, json('options', options)] }));
  const report = JSON.parse(Buffer.from(out(read, 'report')).toString());
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
    taiMinusUtcS: report.taiMinusUtcS, ut1MinusUtcS: report.ut1MinusUtcS, ut1RateMsPerDay: report.ut1RateMsPerDay,
    polarX: report.polarMotionArcsec[0], polarY: report.polarMotionArcsec[1], weightedRms: 1,
  };
  const written = ok(await vcm.invoke({ methodId: 'write', inputs: [{ portId: 'result', typeRef: PRW, payload: out(run, 'response') }, json('header', header)] }));
  const text = Buffer.from(out(written, 'message')).toString();
  t.diagnostic(text.split('\n').slice(0, 8).join('\n'));
  const back = JSON.parse(Buffer.from(out(ok(await vcm.invoke({ methodId: 'read', inputs: [{ portId: 'message', payload: Buffer.from(text) }, json('options', { ...options, scaleCovarianceByWeightedRms: false })] })), 'report')).toString());
  const position = [final.STATE.STATE.POSITION.X, final.STATE.STATE.POSITION.Y, final.STATE.STATE.POSITION.Z].map((x) => x / 1000);
  for (let i = 0; i < 3; ++i) assert.ok(Math.abs(back.j2kPositionKm[i] - position[i]) < 1e-8, 'position');
  const P = [...final.COVARIANCE.VALUES], m = 7;
  let worst = 0;
  for (let i = 0; i < m; ++i) for (let j = 0; j < m; ++j) {
    const si = i < 6 ? 1e3 : 1, sj = j < 6 ? 1e3 : 1;
    const expected = P[i * m + j] / (si * sj), scaleIJ = Math.sqrt((P[i * m + i] / (si * si)) * (P[j * m + j] / (sj * sj)));
    worst = Math.max(worst, Math.abs(back.cartesianCovarianceKm[i * m + j] - expected) / scaleIJ);
  }
  t.diagnostic(`covariance through VCM text and back: ${worst.toExponential(2)} of the sigmas`);
  assert.ok(worst < 2e-4, `${worst}`);
  // With the message's own weighted RMS (above 1) in the header, the text
  // carries the covariance divided by RMS^2 and prints the sigmas of the
  // result; a default read restores the result's covariance.
  const scaled = Buffer.from(out(ok(await vcm.invoke({ methodId: 'write', inputs: [{ portId: 'result', typeRef: PRW, payload: out(run, 'response') }, json('header', { ...header, weightedRms: report.weightedRms })] })), 'message')).toString();
  assert.match(scaled, /WTD RMS:\s+0\.11498E\+01/);
  const again = JSON.parse(Buffer.from(out(ok(await vcm.invoke({ methodId: 'read', inputs: [{ portId: 'message', payload: Buffer.from(scaled) }, json('options', options)] })), 'report')).toString());
  let worstScaled = 0;
  for (let i = 0; i < m; ++i) for (let j = 0; j < m; ++j) {
    const si = i < 6 ? 1e3 : 1, sj = j < 6 ? 1e3 : 1;
    const expected = P[i * m + j] / (si * sj), scaleIJ = Math.sqrt((P[i * m + i] / (si * si)) * (P[j * m + j] / (sj * sj)));
    worstScaled = Math.max(worstScaled, Math.abs(again.cartesianCovarianceKm[i * m + j] - expected) / scaleIJ);
  }
  assert.ok(worstScaled < 2e-4, `${worstScaled}`);
  for (let i = 0; i < 3; ++i) assert.ok(Math.abs(again.recomputedUvwSigmasKm[i] / again.statedUvwSigmasKm[i] - 1) < 0.01, `printed sigma ${i}`);
});

// (4) The parameter rows' units are not stated in the format; parameterRows
//     chooses. Read as printed, the sample's B sigma is 5.1 times B; read as
//     a fraction of B, 4.3 %. Fractional rows go back out as fractions.
test('parameterRows: B row as printed or as a fraction of B', async (t) => {
  const vcm = await load('..'), hpop = await load('../../../propagator/hpop');
  t.after(() => { vcm.destroy(); hpop.destroy(); });
  const options = { ephemerisSource: 'Analytical', arcSeconds: 3600 };
  const read = async (rows) => ok(await vcm.invoke({ methodId: 'read', inputs: [{ portId: 'message', payload: SAMPLE }, json('options', { ...options, parameterRows: rows })] }));
  const reportOf = (r) => JSON.parse(Buffer.from(out(r, 'report')).toString());
  const absolute = reportOf(await read('absolute')), fractional = reportOf(await read('fractional'));
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
  const text = Buffer.from(out(ok(await vcm.invoke({ methodId: 'write', inputs: [{ portId: 'result', typeRef: PRW, payload: out(run, 'response') }, json('header', header)] })), 'message')).toString();
  const { n, p } = lowerTriangle(text);
  assert.equal(n, 7);
  // B is a constant of the motion: its variance is unchanged by propagation.
  assert.ok(Math.abs(p[6 * 7 + 6] - printed ** 2) < 1e-4 * printed ** 2, `${p[6 * 7 + 6]} vs ${printed ** 2}`);
  const bad = await vcm.invoke({ methodId: 'read', inputs: [{ portId: 'message', payload: SAMPLE }, json('options', { parameterRows: 'percent' })] });
  assert.notEqual(bad.statusCode, 0);
});
