// A fitted record against its own statement (stack #420's restated checks, #438): the record's posterior on BTERM, and
// at the end of the flown forecast its position covariance (propagate of the fitted $OCM at that instant, GCRF) against
// the error to the truth's state there along radial, in-track and cross-track. JS only moves bytes, rotates the module's
// covariance onto the truth state's axes and divides.
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {wasmPath} from './module.mjs';
import {flight} from './ocm.mjs';

/** BTERM's posterior from a determination text ({value, sigma} for a Gaussian, {median, sigmaLog} for a log-normal). */
export const posteriorOf = (text) => {
  const log = /posterior sigma of the log ([0-9.eE+-]+); posterior median ([0-9.eE+-]+)/.exec(text ?? '');
  if (log) return {median: Number(log[2]), sigmaLog: Number(log[1])};
  const g = /posterior ([0-9.eE+-]+) \+- ([0-9.eE+-]+)/.exec(text ?? '');
  return g ? {value: Number(g[1]), sigma: Number(g[2])} : {};
};
/** The fitted B's distance from `truth` in its own stated sigmas. */
export const bSigmas = (text, truth = 0.044) => {
  const p = posteriorOf(text);
  if (p.sigmaLog) return Math.abs(Math.log(truth / p.median)) / p.sigmaLog;
  return Math.abs(truth - p.value) / p.sigma;
};

/** For a runModelTruth result `r` (fit mode, forecast `days` days): the error and the record's 1-sigma (m) along R, I, C
 * of the truth state at the fit's end plus `days`, and the error in sigmas. */
export async function statedAtForecastEnd(r, days, modulePath = wasmPath) {
  const s = r.referenceStates.at(-1);
  const endMs = Date.parse(r.fixture.fitEnd + 'Z') + days * 86400000;
  // the truth's sample is in TDB: it must be that instant (TT - UTC 69.184 s in 2026, TDB - TT within 1.7 ms)
  const offset = ((s.epochJD - 2440587.5) * 86400000 - endMs) / 1000;
  if (Math.abs(offset - 69.184) > 5e-3) throw new Error(`the truth's last state is not at the forecast's end (${offset} s)`);
  const h = await createStandaloneHarness('browser', modulePath, {surface: 'command'});
  const p = await h.invoke({methodId: 'propagate', inputs: flight([new Uint8Array(Buffer.from(r.omm, 'base64'))],
    {output: {EPOCHS: [new Date(endMs).toISOString().replace('Z', '')], FRAME: pcfOutputFrame.GCRF}})});
  await h.close?.();
  if (p.statusCode !== 0) throw new Error(`propagate: ${p.errorCode} ${p.errorMessage}`);
  const b = OEM.getRootAsOEM(new fb.ByteBuffer(p.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
  const st = b.EPHEMERIS_DATA_LINES[0], c = b.COVARIANCE_MATRIX_LINES?.[0];
  if (!c) throw new Error('the fitted record states no covariance');
  const unit = (a) => { const n = Math.hypot(...a); return a.map((x) => x / n); };
  const cross = (a, q) => [a[1] * q[2] - a[2] * q[1], a[2] * q[0] - a[0] * q[2], a[0] * q[1] - a[1] * q[0]];
  const rh = unit(s.position), ch = unit(cross(s.position, s.velocity)), ih = cross(ch, rh);
  const err = [st.X - s.position[0], st.Y - s.position[1], st.Z - s.position[2]];
  const P = [[c.CX_X, c.CY_X, c.CZ_X], [c.CY_X, c.CY_Y, c.CZ_Y], [c.CZ_X, c.CZ_Y, c.CZ_Z]];
  const quad = (a) => a.reduce((sum, ai, i) => sum + ai * a.reduce((t, aj, j) => t + P[i][j] * aj, 0), 0);
  const out = {};
  for (const [k, a] of Object.entries({R: rh, I: ih, C: ch})) {
    const e = err.reduce((t, x, i) => t + x * a[i], 0) * 1000, sg = Math.sqrt(quad(a)) * 1000;
    out[k] = {errorM: e, sigmaM: sg, z: e / sg};
  }
  return out;
}
