// The modules this experiment runs, each wasm read with git show at a registered commit and SHA-256 checked, through XM's and XM3's pinning:
//   XM3's build: propagator/ffm 2.0.4, analysis/estimation 0.7.0 (fit_batch version 3)
//   XM's build: propagator/sdn-ap, propagator/sgp4, analysis/gp-error-model, foundation/frames
// Fits and forecasts of FFM go through lib/fit.mjs and lib/frame.mjs, so every force selection the module offers can be asked for. Operator
// bytes live in memory only and nothing raw is written. Encoding, decoding and routing only: every number comes out of a module.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { config as XM3, root, modulesRoot, pinned, sha256 } from '../../ffm-atmosphere-xm3/common.mjs';
import * as XM from '../../xp-atmosphere-merit/common.mjs';
import { fitV3, estimationCodecV3 } from './fit.mjs';
import { executionFrame, decodeSamples, kernelFrame, encode } from './frame.mjs';

const PRW_TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW' };
const DAY = 86400000;
const mjd = (t) => t / DAY + 40587;
const labelMs = (text) => { const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?Z?$/.exec(String(text)); return m ? Date.parse(`${m[1]}Z`) + (m[2] ? Number(`0.${m[2]}`) * 1000 : 0) : NaN; };
export const isoMs = (t) => new Date(t).toISOString();

async function host(rel) {
  const { bytes, manifest } = pinned(modulesRoot(), rel);
  const harness = await createBrowserModuleHarness({ wasmSource: bytes, manifest, surface: 'direct' });
  return {
    provenance: { path: rel, version: manifest.version, wasmSha256: sha256(bytes) },
    async invoke(methodId, inputs) {
      const r = await harness.invoke({ methodId, inputs });
      if (r.statusCode !== 0) throw new Error(`${rel} ${methodId}: ${r.errorCode ?? r.statusCode}: ${r.errorMessage}`);
      return r;
    },
    destroy: () => harness.destroy(),
  };
}

/** foundation/frames, pinned by XM, hosted by the SDK its own package installs: { call, destroy }. */
async function openFrames() {
  const modules = XM.modulesRoot();
  const { bytes, manifest } = XM.pinned(modules, 'foundation/frames');
  const entry = createRequire(path.join(modules, 'foundation/frames/package.json')).resolve('space-data-module-sdk/host/browser-module');
  const { createBrowserModuleHarness: make } = await import(pathToFileURL(entry).href);
  const harness = await make({ wasmSource: bytes, manifest, surface: 'direct' });
  return {
    async call(methodId, inputs) {
      const r = await harness.invoke({ methodId, inputs });
      if (r.statusCode !== 0) throw new Error(`foundation/frames ${methodId}: ${r.errorCode ?? r.statusCode}: ${r.errorMessage}`);
      const out = {};
      for (const o of r.outputs) out[o.portId] = Buffer.from(o.payload);
      return out;
    },
    destroy: () => harness.destroy(),
  };
}

function earthOrientation() {
  const E = XM3.environment.earthOrientation;
  const raw = fs.readFileSync(E.file);
  if (sha256(raw) !== E.sha256) throw new Error(`${E.file} is not the registered ${E.sha256}`);
  const saved = JSON.parse(raw);
  return P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(new Uint8Array(Buffer.from(saved.inputs.earth_orientation_finals, 'base64')))).unpack().EARTH_ORIENTATION.ROWS;
}

export async function openFfmHost() {
  const estimation = await host('analysis/estimation'), ffm = await host('propagator/ffm');
  const modules = modulesRoot();
  const { FIT_PARAMETER_DOMAINS: domains } = await import(path.join(modules, 'propagator/ffm/catalog-configuration.mjs'));
  const codec = await estimationCodecV3(modules, path.join(root, 'node_modules/space-data-module-sdk/schemas/orbpro'));
  const kernelBytes = fs.readFileSync(XM3.environment.kernel.path);
  if (sha256(kernelBytes) !== XM3.environment.kernel.sha256) throw new Error('the DE440s kernel is not the registered one');
  const kernel = kernelFrame(kernelBytes), eopRows = earthOrientation();
  const inputs = (fromMs, toMs, rows) => {
    const lo = mjd(fromMs - 2 * DAY) - 1, hi = mjd(toMs + 2 * DAY) + 1;
    const eop = eopRows.filter((r) => r.MJD >= lo && r.MJD <= hi);
    if (!eop.length || eop.at(-1).MJD < mjd(toMs)) throw new Error(`Earth orientation ends before ${isoMs(toMs)} (last MJD ${eopRows.at(-1)?.MJD})`);
    const spw = (rows ?? []).map((r) => Object.assign(new P.SPWT(), r));
    return [
      kernel,
      { portId: 'earth_orientation', typeRef: PRW_TYPE, payload: encode('EARTH_ORIENTATION', Object.assign(new P.PRWEarthOrientationT(), { ROWS: eop })) },
      ...(rows ? [{ portId: 'space_weather', typeRef: PRW_TYPE, payload: encode('SPACE_WEATHER', Object.assign(new P.PRWSpaceWeatherTableT(), { ROWS: spw })) }] : []),
    ];
  };
  return {
    provenance: { estimation: estimation.provenance, ffm: ffm.provenance, kernelSha256: XM3.environment.kernel.sha256, eopRowsThroughMjd: eopRows.at(-1)?.MJD },
    /**
     * A fit of position states `lines` [{epoch, r}] km GCRF. settings: { forces, parameters [{kind, value}], fixed {b, agom, t}, apriori, sigmaM, integrator,
     * sigmaEditThreshold, maximumIterations, correctionTolerance }. `spanEndMs` bounds the environment frames.
     */
    async fit(lines, seed, settings, rows, spanEndMs) {
      // FFM takes no space weather when drag is off (the orbits above 8,400 km of VENDORS.md).
      const ctx = { estimation, ffm, codec, domains, inputs: inputs(Date.parse(lines[0].epoch), spanEndMs, settings.forces?.drag === false ? null : rows) };
      const points = lines.map((l) => ({ time: l.epoch, position: l.r.map((x) => x * 1000) }));
      const reference = { epoch: lines[0].epoch, state: seed.map((x) => x * 1000) };
      return fitV3(ctx, points, reference, settings);
    },
    /** The fitted product carried to `epochs` (ISO UTC, ascending), each sample at its UTC instant: [{ r, v }] km GCRF. */
    async forecast(product, epochs, settings, rows) {
      const response = await ffm.invoke('invoke', [
        executionFrame({ epoch: product.epoch, state: product.state, samples: epochs, forces: settings.forces, parameters: product.parameters, fixed: settings.fixed ?? {}, stm: false, covariance: null, noise: null, integrator: settings.integrator }),
        ...inputs(Date.parse(product.epoch), Date.parse(epochs.at(-1)), settings.forces?.drag === false ? null : rows),
      ]);
      const samples = decodeSamples(response);
      if (samples.length !== epochs.length) throw new Error(`forecast: ${samples.length} of ${epochs.length} states`);
      const offsets = samples.map((x, i) => labelMs(x.epoch) - Date.parse(epochs[i]));
      if (Math.max(...offsets) - Math.min(...offsets) > 2) throw new Error(`forecast: sample labels spread ${Math.min(...offsets)}..${Math.max(...offsets)} ms`);
      return samples.map((x) => ({ r: x.state.slice(0, 3).map((v) => v / 1000), v: x.state.slice(3, 6).map((v) => v / 1000) }));
    },
    async close() { await estimation.destroy(); await ffm.destroy(); },
  };
}

/** Axes conversion by foundation/frames, per state: `toGcrf(lines, 'EME2000')` returns [{ epoch, r, v }] km GCRF. */
export async function openAxes() {
  const frames = await openFrames();
  const F = await import(path.join(root, 'experiments/sdn-gp-starlink-ffm-match/lib/frames.mjs'));
  return {
    async convert(lines, from, to) {
      const out = [];
      for (const l of lines) {
        const s = await F.transformState(frames, from, to, l.epoch, [...l.r, ...l.v]);
        out.push({ epoch: l.epoch, r: s.slice(0, 3), v: s.slice(3, 6) });
      }
      return out;
    },
    close: () => frames.destroy(),
  };
}

/** A diagonal a priori over state and parameters: position 100 km, velocity 10 m/s, each parameter by its own sigma. */
export function apriori(parameterSigmas = []) {
  const diag = [...Array(3).fill(1e10), ...Array(3).fill(100), ...parameterSigmas.map((s) => s * s)];
  const m = diag.length;
  return Array.from({ length: m * m }, (_, j) => (Math.floor(j / m) === j % m ? diag[j % m] : 0));
}
