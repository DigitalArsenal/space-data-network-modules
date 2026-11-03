// The modules XM-fast runs, every wasm pinned to build.json (git show at the registered commit, SHA-256 checked), each
// hosted by the space-data-module-sdk its own package installs (build.json hosts):
//   propagator/sdn-ap            fit and propagate of the X arms (standalone harness, direct surface)
//   propagator/sgp4              propagate_ephemeris of the public set P (a fresh harness per call)
//   analysis/gp-error-model      G1's scorer: pair_statistics in the truth's RTN axes
//   foundation/frames            TEME to the truth's axes, every arm alike
//   analysis/density-calibration the open-DCA $DCL (calibrate_log_density)
// JavaScript moves FlatBuffers; every number comes out of a module.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { g1Dir, modulesRoot, pinned, build } from '../common.mjs';
import { TYPE, oemLines } from './sds.mjs';

const modules = modulesRoot();
const sdk = (rel, entry) => import(pathToFileURL(createRequire(path.join(modules, rel, 'package.json')).resolve(`space-data-module-sdk/${entry}`)).href);
const F = await import(path.join(g1Dir, 'lib/frames.mjs'));
// G1 lib/baselines.mjs rtnSeries and its PLACEHOLDER_COVARIANCE, verbatim (baselines.mjs itself imports a package the
// canonical checkout does not install): the [R, T, N] error of each predicted state against its truth, by pair_statistics.
const PLACEHOLDER_COVARIANCE = [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1e-6, 0, 0, 0, 0, 0, 0, 1e-6, 0, 0, 0, 0, 0, 0, 1e-6];
async function rtnSeries(b, predicted, truth) {
  const pairs = predicted.map((p, i) => ({ id: String(i), predicted: { position: p.r, velocity: p.v, covariance: PLACEHOLDER_COVARIANCE, covarianceAxes: 'INERTIAL' }, truth: { position: truth[i].r, velocity: truth[i].v } }));
  return b.erm.decode((await b.gem.call('pair_statistics', [b.erm.frame('pairs', 'pairs', { axesFrom: 'truth', pairs })])).statistics).pairs.map((s) => s.errorRtn);
}
const enc = await import(pathToFileURL(path.join(modules, 'propagator/sgp4/tests/lib/payloadEncoders.mjs')).href);
const erm = await import(pathToFileURL(path.join(modules, 'analysis/gp-error-model/scripts/erm-codec.mjs')).href);
const short = (e) => String(e?.message ?? e).slice(0, 240);
const OMM_TYPE = { schemaName: 'orbpro.sds.omm', fileIdentifier: '$OMM', rootTypeName: 'OMM' };
const PROP_TYPE = { schemaName: 'orbpro.propagator.PropagatorBatchRequest', fileIdentifier: 'PROP', rootTypeName: 'PropagatorBatchRequest' };
const jd = (t) => 2440587.5 + t / 86400000;
/** An $OEM EPOCH (ISO UTC, microseconds) to the nearest millisecond: the module's float64 Julian dates print a sample of a
 *  300 s grid some microseconds either side of its second (2026-03-10T00:00:01.999989), which Date.parse would truncate. */
const nearestMs = (text) => {
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?Z?$/.exec(String(text));
  if (!m) throw new Error(`unreadable epoch ${text}`);
  return Math.round(Date.parse(`${m[1]}Z`) + (m[2] ? Number(`0.${m[2]}`) * 1000 : 0));
};

/** A pinned module through its host SDK's browser-module harness: { call, response, destroy } as G1's openModule. */
async function openPinned(rel, { sdkFrom = rel, fresh = false } = {}) {
  const { bytes, manifest } = pinned(modules, rel);
  const { createBrowserModuleHarness } = await sdk(sdkFrom, 'host/browser-module');
  const make = () => createBrowserModuleHarness({ wasmSource: bytes, manifest, surface: 'direct' });
  let harness = fresh ? null : await make();
  return {
    async response(methodId, inputs) {
      const h = harness ?? (await make());
      try { return await h.invoke({ methodId, inputs }); } finally { if (fresh) await h.destroy(); }
    },
    async call(methodId, inputs) {
      const r = await this.response(methodId, inputs);
      if (r.statusCode !== 0) throw new Error(`${rel} ${methodId}: ${r.errorCode ?? r.statusCode}: ${String(r.errorMessage).slice(0, 200)}`);
      const out = {};
      for (const o of r.outputs) out[o.portId] = Buffer.from(o.payload);
      return out;
    },
    destroy: async () => { if (harness) await harness.destroy(); harness = null; },
  };
}

export async function openModules() {
  const ap = pinned(modules, 'propagator/sdn-ap');
  const { createStandaloneHarness } = await sdk('propagator/sdn-ap', 'testing/isomorphic');
  const h = await createStandaloneHarness('browser', ap.file, { surface: 'direct' });
  const gem = await openPinned('analysis/gp-error-model', { fresh: true });
  const frames = await openPinned('foundation/frames');
  const sgp4 = await openPinned('propagator/sgp4', { fresh: true });
  const dc = await openPinned('analysis/density-calibration', { sdkFrom: 'analysis/gp-error-model' });
  const b = { erm, gem, frames };
  const extraFrames = (extra) => { const { rows, dcl } = extra ?? {}; return [
    ...(rows ? [{ portId: 'space_weather', typeRef: TYPE('SPW'), payload: rows }] : []),
    ...(dcl ? [{ portId: 'density_correction', typeRef: TYPE('DCL'), payload: dcl }] : []),
  ]; };
  return {
    provenance: { modulesCommit: build.modulesCommit, wasmSha256: build.wasmSha256 },
    /** propagator/sdn-ap `fit` of one block: { ok, omm, obd, fitMs } or { ok: false, error, fitMs }. */
    async fit(oem, pcf, extra) {
      const inputs = [{ portId: 'ephemeris', typeRef: TYPE('OEM'), payload: oem }, { portId: 'configuration', typeRef: TYPE('PCF'), payload: pcf }, ...extraFrames(extra)];
      const t0 = performance.now();
      let r;
      try { r = await h.invoke({ methodId: 'fit', inputs }); } catch (error) { return { ok: false, error: short(error), fitMs: performance.now() - t0 }; }
      const fitMs = performance.now() - t0;
      if (r.statusCode !== 0) return { ok: false, error: `${r.errorCode}: ${String(r.errorMessage).slice(0, 200)}`, fitMs };
      return { ok: true, omm: new Uint8Array(r.outputs.find((o) => o.portId === 'elements').payload), obd: new Uint8Array(r.outputs.find((o) => o.portId === 'determination').payload), fitMs };
    },
    /** propagator/sdn-ap `propagate` of one set at explicit epochs (ISO UTC), TEME: [{epoch, r, v}]. */
    async propagate(omm, grid, pcf, extra, count) {
      const inputs = [{ portId: 'omm', typeRef: TYPE('OMM'), payload: omm }, { portId: 'grid', typeRef: TYPE('OEM'), payload: grid }, { portId: 'configuration', typeRef: TYPE('PCF'), payload: pcf }, ...extraFrames(extra)];
      const r = await h.invoke({ methodId: 'propagate', inputs });
      if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode}: ${String(r.errorMessage).slice(0, 200)}`);
      const lines = oemLines(new Uint8Array(r.outputs.find((o) => o.portId === 'ephemeris').payload));
      if (lines.length !== count) throw new Error(`propagate returned ${lines.length} of ${count} states`);
      return lines;
    },
    /** propagator/sgp4 `propagate_ephemeris` of one public set from the first to the last epoch (ms) at `stepSeconds`, TEME, km:
     *  the state at each epoch, or null where the answer holds none. */
    async propagateSgp4(set, norad, epochsMs, stepSeconds) {
      const e = set.elements;
      const omm = enc.encodeOmmPayload({ noradId: norad, objectName: set.objectName ?? '', objectId: set.objectId ?? '', epoch: set.epoch, meanMotion: e.MEAN_MOTION, eccentricity: e.ECCENTRICITY, inclination: e.INCLINATION,
        raan: e.RA_OF_ASC_NODE, argPericenter: e.ARG_OF_PERICENTER, meanAnomaly: e.MEAN_ANOMALY, bstar: e.BSTAR, meanMotionDot: e.MEAN_MOTION_DOT, meanMotionDdot: e.MEAN_MOTION_DDOT });
      const request = enc.encodePropagatorBatchRequest({ epoch: jd(epochsMs[0]), stopEpoch: jd(epochsMs.at(-1)), catalogNumbers: [norad], outputFrame: enc.ReferenceFrame.TEME, stepSeconds });
      const res = await sgp4.call('propagate_ephemeris', [
        { portId: 'omm', typeRef: OMM_TYPE, payload: Buffer.from(enc.encodeSizePrefixedStream([omm])) },
        { portId: 'request', typeRef: PROP_TYPE, payload: Buffer.from(request) },
      ]);
      const byMs = new Map();
      for (const blk of enc.decodeOem(new Uint8Array(res.ephemeris)).EPHEMERIS_DATA_BLOCK) for (const l of blk.EPHEMERIS_DATA_LINES) {
        byMs.set(nearestMs(l.EPOCH), { r: [l.X, l.Y, l.Z], v: [l.X_DOT, l.Y_DOT, l.Z_DOT] });
      }
      return epochsMs.map((t) => byMs.get(t) ?? null);
    },
    /** TEME states to the truth's axes by foundation/frames at the given epochs (ISO UTC): [{r, v}]. */
    async toAxes(states, epochs, axes) {
      const out = [];
      for (let i = 0; i < states.length; i += 1) {
        const t = await F.transformState(frames, 'TEME', axes, epochs[i], [...states[i].r, ...states[i].v]);
        out.push({ r: t.slice(0, 3), v: t.slice(3, 6) });
      }
      return out;
    },
    /** G1's scorer: the [R, T, N] error (km) of each predicted state against its truth state (same axes and epochs). */
    rtn: (predicted, truth) => rtnSeries(b, predicted, truth),
    /** analysis/density-calibration `calibrate_log_density`: { ok, dcl } or { ok: false, error }. */
    async calibrate(request) {
      const r = await dc.response('calibrate_log_density', [{ portId: 'request', typeRef: TYPE('DCL'), payload: request }]);
      if (r.statusCode !== 0) return { ok: false, error: `${r.errorCode}: ${String(r.errorMessage).slice(0, 200)}` };
      return { ok: true, dcl: new Uint8Array(r.outputs[0].payload) };
    },
    async close() { await h.destroy?.(); await frames.destroy(); await dc.destroy(); await gem.destroy(); await sgp4.destroy(); },
  };
}
