// One base orbit of the delta-V Monte Carlo (study/dv-mc-truth.mjs), in a
// worker. Every orbit computation is a module's: analysis/epoch-state turns
// the random mean elements into a GCRF state, propagator/ffm propagates it at
// full force (catalog.mjs's request, the FFM-1 force model) with the trial's
// impulse in RTN, and analysis/gp-error-model fit_elements fits SGP4 element
// sets to the truth, as Space-Track's GP sets are fits. This file draws the
// random numbers and moves bytes.
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

register(new URL('./sibling-deps.mjs', import.meta.url));
const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(here, '../..');
process.env.SPACE_DATA_STANDARDS_ROOT ??= path.join(PACKAGE, 'node_modules/spacedatastandards.org');
const MODULES = path.resolve(PACKAGE, '../..');
const catalog = await import(path.join(MODULES, 'propagator/ffm/catalog.mjs'));
const { epochStates } = await import(path.join(MODULES, 'analysis/gp-error-model/scripts/ffm.mjs'));
const codec = await import(path.join(MODULES, 'analysis/gp-error-model/scripts/erm-codec.mjs'));
const { createBrowserModuleHarness } = await import('space-data-module-sdk/host/browser-module');
const { OEM, OMM, flatbuffers, TYPES, iso } = await import('./host.mjs');

const P = catalog.prw;
const DAY = 86400;
const harnessOf = async (dir) => createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(MODULES, dir, 'dist/isomorphic/module.wasm')),
  manifest: JSON.parse(fs.readFileSync(path.join(MODULES, dir, 'plugin-manifest.json'), 'utf8')), surface: 'direct' });
let ffm, gp, env;

// mulberry32: a seeded uniform generator, so the fixture is reproducible.
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FFM from a GCRF state (km, km/s) at t0 to the last of `times` (UTC s), sampled there, with optional RTN impulses
// [{t, dv: [R, T, N] m/s}]. Returns [[t, state km, km/s], ...].
async function propagate(t0, state, times, cdAm, impulses = []) {
  const request = catalog.fullForceRequest({ epoch: iso(t0), state: state.map((x) => x * 1000), target: iso(times.at(-1)), cdAm });
  request.SAMPLE_EPOCHS = times.map((t) => catalog.instant(iso(t), 'UTC'));
  request.IMPULSES = impulses.map(({ t, dv }) => Object.assign(new P.PRWImpulseT(), {
    EPOCH: catalog.instant(iso(t), 'UTC'), DELTA_V: Object.assign(new P.FRMVector3T(), { X: dv[0], Y: dv[1], Z: dv[2] }),
    VECTOR_BASIS: P.prwSteeringBasis.RTN_AXES }));
  const res = await ffm.invoke({ methodId: 'invoke', inputs: [{ portId: 'request', typeRef: catalog.TYPE, payload: catalog.encode('EXECUTION_REQUEST', request) }, ...env] });
  if (res.statusCode !== 0) throw new Error(`ffm: ${res.errorCode}: ${res.errorMessage}`);
  const out = P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(res.outputs[0].payload)).EXECUTION_RESULT();
  return times.map((t, i) => {
    const s = out.SAMPLES(i).STATE().STATE(), p = s.POSITION(), v = s.VELOCITY();
    return [t, [p.X(), p.Y(), p.Z(), v.X(), v.Y(), v.Z()].map((x) => x / 1000)];
  });
}

// One SGP4 element set fitted to the truth samples in [from, to] every 300 s back from `to`, epoch at `to` (fit_elements).
async function fit(norad, truth, from, to, bstar) {
  const block = new OEM.ephemerisDataBlockT();
  Object.assign(block, { CENTER_NAME: 'EARTH', TIME_SYSTEM: OEM.timingStandard.UTC,
    OBJECT: Object.assign(new OEM.CATT(), { NORAD_CAT_ID: norad }), REFERENCE_FRAME: Object.assign(new OEM.RFMT(), { NAME: 'GCRF' }) });
  block.EPHEMERIS_DATA_LINES = truth.filter(([t]) => t >= from && t <= to && (to - t) % 300 === 0).map(([t, x]) => {
    const l = new OEM.ephemerisDataLineT();
    l.EPOCH = iso(t);
    [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = x;
    return l;
  });
  const b = new flatbuffers.Builder(1 << 20);
  OEM.OEM.finishSizePrefixedOEMBuffer(b, Object.assign(new OEM.OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }).pack(b));
  const options = { epoch: iso(to), ...(bstar === undefined ? { fitBstar: true } : { fitBstar: false, bstar }) };
  const res = await gp.invoke({ methodId: 'fit_elements', inputs: [{ portId: 'ephemeris', payload: b.asUint8Array(), typeRef: TYPES.OEM },
    codec.frame('options', codec.ARM_OF.fit_elements.options, options)] });
  if (res.statusCode !== 0) throw new Error(`fit_elements: ${res.errorMessage}`);
  const elements = res.outputs.find((o) => o.portId === 'elements');
  if (!elements?.payload?.length) throw new Error(`fit_elements: no converged fit (${JSON.stringify(codec.decode(res.outputs.find((o) => o.portId === 'report').payload).fits?.[0]?.error)})`);
  const o = OMM.OMM.getSizePrefixedRootAsOMM(new flatbuffers.ByteBuffer(new Uint8Array(elements.payload))).unpack();
  return [o.EPOCH, o.MEAN_MOTION, o.ECCENTRICITY, o.INCLINATION, o.RA_OF_ASC_NODE, o.ARG_OF_PERICENTER, o.MEAN_ANOMALY, o.BSTAR];
}

// item: {base, seed}; context: {trials, start, cadenceHours, fitDays, sets, postArcHours}
export async function run({ base, seed }, { trials, start, cadenceHours = 8, fitDays = 2, sets = 9, postArcHours = 5 }) {
  if (!ffm) {
    ffm = await harnessOf('propagator/ffm');
    gp = await harnessOf('analysis/gp-error-model');
    const fx = path.join(MODULES, 'propagator/ffm/tests/fixtures/ffm-e2e-requests');
    env = ['kernel', 'earth_orientation', 'space_weather'].map((p) => ({ portId: p, typeRef: catalog.TYPE, payload: new Uint8Array(fs.readFileSync(path.join(fx, `ffm-${p}.prw`))) }));
  }
  const u = random(seed);
  const between = (a, b) => a + (b - a) * u();
  const norad = 90000 + base;
  // LEO-M mean elements (14.55 to 15.15 rev/day: about 520 to 770 km).
  const values = [between(14.55, 15.15), between(2e-4, 2e-3), between(40, 100), between(0, 360), between(0, 360), between(0, 360), between(2e-5, 2e-4)];
  const t0 = Date.parse(start) / 1000 + 60 * Math.round(between(0, 3.5 * DAY) / 60);
  const seedState = (await epochStates([{ key: base, epoch: t0, values }])).get(base);
  const state = [...seedState.position, ...seedState.velocity];
  const cdAm = catalog.dragAreaOverMass(ffm.instance.exports, values[6]);
  const epochs = Array.from({ length: sets }, (_, k) => t0 + 60 * Math.round((fitDays * DAY + k * cadenceHours * 3600 + between(-3600, 3600)) / 60));
  const grid = [];
  for (let t = t0 + 60; t <= epochs.at(-1); t += 60) grid.push(t);
  const truth = [[t0, state], ...(await propagate(t0, state, grid, cdAm))];
  const gaps = [Math.floor(sets / 2) - 1, Math.floor(sets / 2)];
  const pre = [];
  for (let k = 0; k <= Math.max(...gaps); ++k) pre.push(await fit(norad, truth, epochs[k] - fitDays * DAY, epochs[k]));
  const out = [];
  for (let n = 0; n < trials; ++n) {
    const gap = gaps[Math.floor(u() * gaps.length)];
    const tb = Math.round(1000 * between(epochs[gap] + 900, epochs[gap + 1] - postArcHours * 3600)) / 1000;
    const dv = [between(-1.5, 1.5), (u() < 0.5 ? -1 : 1) * between(0.3, 3), between(-1.5, 1.5)];
    // The impulse rides on a one-second FFM step across the burn (an RTN impulse costs FFM its moving-basis
    // Jacobian over the whole request); the coast after it is a plain request.
    const [ts, xs] = truth[truth.findLastIndex(([t]) => t < tb)];
    const [[t1, x1]] = await propagate(ts, xs, [tb + 1], cdAm, [{ t: tb, dv }]);
    const after = await propagate(t1, x1, grid.filter((t) => t > t1), cdAm);
    const post = [];
    for (let k = gap + 1; k < sets; ++k) post.push(await fit(norad, after, Math.max(tb + 60, epochs[k] - fitDays * DAY), epochs[k], pre[gap][7]));
    out.push({ base, gap, burn: iso(tb), dv_rtn_mps: dv, post });
  }
  return { base: { norad, epoch0: iso(t0), elements: values, sets: pre }, trials: out };
}
