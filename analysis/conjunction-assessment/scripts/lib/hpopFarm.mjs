// HPOP propagation farm for a catalog-wide trajectory screen: one propagator
// run. analysis/epoch-state turns each element set into a GCRF state at its
// epoch (SGP4 at zero elapsed time, TEME -> GCRF); propagator/hpop integrates
// those states on worker threads, at most 1,024 objects per resident
// instance, and exports conjunction-screening trajectories one time window at
// a time. All physics is in those modules; this file moves records.
//
// Profiles: 'full-force' (the default) configures every instance with the
// full force model of propagator/hpop/catalog.mjs and the environment frames
// in `environment` (kernel.prw, earth_orientation.prw and space_weather.prw,
// PRW records), each object carrying its Cd*A/m (from its B*) and Cr*A/m;
// 'gravity-only' names the point mass and degree/order 20 field.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as flatbuffers from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { MPE, meanElementSource } from 'spacedatastandards.org/lib/js/MPE/main.js';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/main.js';
import { OMM } from 'spacedatastandards.org/lib/js/OMM/main.js';

const BATCH = 1024;   // HPOP ingest_state limit per resident catalog

// Unix seconds of an ISO UTC epoch, keeping its microseconds (Date.parse
// stops at milliseconds: ~4 m at 7.5 km/s).
function unixSeconds(iso) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z?$/.exec(iso.trim());
  if (!m) throw new Error(`Unsupported epoch ${iso}`);
  return Date.parse(`${m[1]}Z`) / 1000 + (m[2] ? Number(`0${m[2]}`) : 0);
}

function mpeStream(omms) {
  const frames = omms.map((o) => {
    const b = new flatbuffers.Builder(256);
    const id = b.createString(`NORAD:${o.NORAD_CAT_ID}`);
    MPE.startMPE(b);
    MPE.addEntityId(b, id);
    MPE.addEpoch(b, unixSeconds(o.EPOCH));
    MPE.addMeanMotion(b, o.MEAN_MOTION);
    MPE.addEccentricity(b, o.ECCENTRICITY);
    MPE.addInclination(b, o.INCLINATION);
    MPE.addRaOfAscNode(b, o.RA_OF_ASC_NODE);
    MPE.addArgOfPericenter(b, o.ARG_OF_PERICENTER);
    MPE.addMeanAnomaly(b, o.MEAN_ANOMALY);
    MPE.addBstar(b, o.BSTAR);
    MPE.addMeanElementTheory(b, meanElementSource.SGP4);
    MPE.finishSizePrefixedMPEBuffer(b, MPE.endMPE(b));
    return b.asUint8Array();
  });
  // Size-prefixed records, each padded to 8 bytes (zero-length prefixes).
  const sizes = frames.map((f) => f.length + ((8 - (f.length % 8)) % 8));
  const out = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  let at = 0;
  frames.forEach((f, i) => { out.set(f, at); at += sizes[i]; });
  return out;
}

function* sizePrefixed(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 4 <= bytes.length;) {
    const n = view.getUint32(at, true);
    if (n === 0) { at += 4; continue; }
    yield bytes.subarray(at, at + 4 + n);
    at += 4 + n;
  }
}

/** GCRF epoch states for catalog OMMs: [{ index, state | reason }]. */
async function epochStates(epochStateDir, omms) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(epochStateDir, 'dist/isomorphic/module.wasm')),
    manifest: JSON.parse(fs.readFileSync(path.join(epochStateDir, 'plugin-manifest.json'), 'utf8')), surface: 'direct' });
  try {
    const payload = mpeStream(omms);
    const response = await harness.invoke({ methodId: 'derive', inputs: [{ portId: 'elements', payload,
      typeRef: { schemaName: 'MPE.fbs', fileIdentifier: '$MPE', rootTypeName: 'MPE', wireFormat: 'aligned-binary', requiredAlignment: 8, byteLength: payload.byteLength } }] });
    if (response.statusCode !== 0) throw new Error(`epoch-state: ${response.errorCode}: ${response.errorMessage}`);
    const report = JSON.parse(new TextDecoder().decode(response.outputs.find((f) => f.portId === 'report').payload));
    const states = new Map();
    const statesFrame = response.outputs.find((f) => f.portId === 'states');
    for (const frame of statesFrame ? sizePrefixed(statesFrame.payload) : []) {
      const oem = OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(frame.slice())).unpack();
      const line = oem.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
      const norad = Number(/NORAD:(\d+)/.exec(oem.EPHEMERIS_DATA_BLOCK[0].COMMENT ?? '')?.[1] ?? oem.EPHEMERIS_DATA_BLOCK[0].OBJECT?.NORAD_CAT_ID);
      states.set(norad, { epoch: line.EPOCH, position: [line.X, line.Y, line.Z], velocity: [line.X_DOT, line.Y_DOT, line.Z_DOT] });
    }
    return { states, report };
  } finally {
    await harness.destroy();
  }
}

/**
 * @param {object} o
 * @param {Uint8Array[]} o.catalog  One $OMM per object.
 * @param {string} o.modulesRoot  The space-data-network-modules checkout.
 * @param {number} [o.workers]
 * @param {number} [o.screenStartJd]  UTC JD the screen starts (default: the first window's start).
 * @param {number} [o.loadCeiling]  Pause each worker's next chunk of objects while the host's
 *   1-minute load average exceeds it (none by default).
 * @param {number[]} [o.handles]  Each object's source handle (default: its position + 1), so a
 *   farm of some catalog objects (the ones whose element sets changed) keeps the catalog's handles.
 * @returns {Promise<{objects: object[], excluded: object[], reentries: object[], window: Function, close: Function}>}
 *
 * HPOP ends a trajectory at reentry (100 km geodetic altitude) with the error
 * `reentry` and its UTC epoch. An object that reenters before the screen
 * starts is dropped, as SGP4 excludes a decayed element set. One that
 * reenters during the screen keeps the windows before the one holding its
 * reentry and is absent from that window on; `reentries` lists both kinds.
 */
export async function createHpopFarm(o) {
  const profile = o.profile ?? 'full-force';
  if (!['full-force', 'gravity-only'].includes(profile)) throw new Error(`Unknown HPOP profile ${profile}: full-force or gravity-only.`);
  let environment = null;
  if (profile === 'full-force') {
    if (!o.environment) throw new Error('The full-force HPOP farm needs its environment frames (kernel.prw, earth_orientation.prw, space_weather.prw).');
    environment = Object.fromEntries(['kernel', 'earth_orientation', 'space_weather'].map((port) =>
      [port, new Uint8Array(fs.readFileSync(path.join(o.environment, `${port}.prw`)))]));
  }
  const omms = o.catalog.map((bytes) => OMM.getRootAsOMM(new flatbuffers.ByteBuffer(bytes)).unpack());
  const objects = omms.map((m, i) => ({ handle: o.handles?.[i] ?? i + 1, norad: m.NORAD_CAT_ID, objectId: m.OBJECT_ID || String(m.NORAD_CAT_ID), name: m.OBJECT_NAME,
    bstar: m.BSTAR }));
  const t0 = performance.now();
  const { states, report } = await epochStates(path.join(o.modulesRoot, 'analysis/epoch-state'), omms);
  const deriveMs = performance.now() - t0;
  const excluded = [], ready = [];
  for (const obj of objects) {
    const s = states.get(obj.norad);
    if (s) ready.push({ ...obj, ...s });
    else excluded.push({ ...obj, reason: 'epoch-state refused the element set' });
  }

  const count = Math.max(1, Math.min(o.workers ?? os.availableParallelism() - 2, ready.length));
  const workers = Array.from({ length: count }, () => new Worker(new URL('./hpopFarmWorker.mjs', import.meta.url)));
  let next = 0;
  const pending = new Map();
  for (const w of workers) w.on('message', ({ id, ok, result, error }) => {
    const p = pending.get(id); pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  });
  const send = (w, op, args) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); w.postMessage({ id, op, args }); });

  const hpop = path.join(o.modulesRoot, 'propagator/hpop');
  const t1 = performance.now();
  // About two instances per worker, objects dealt round-robin, so element
  // sets of every age (HPOP integrates each from its epoch) spread evenly.
  const instanceCount = Math.max(Math.ceil(ready.length / BATCH), Math.min(2 * count, ready.length));
  const adds = [];
  for (let b = 0; b < instanceCount; b++) {
    adds.push(send(workers[b % count], 'add', { wasmPath: path.join(hpop, 'dist/isomorphic/module.wasm'),
      manifestPath: path.join(hpop, 'plugin-manifest.json'), catalogPath: path.join(hpop, 'catalog.mjs'), profile, environment,
      id: `farm-${b}`, states: ready.filter((_, i) => i % instanceCount === b) }));
  }
  const ingestCpuMs = (await Promise.all(adds)).reduce((sum, r) => sum + (r?.cpuMs ?? 0), 0);
  const ingestMs = performance.now() - t1;
  // CPU time of the workers (user and system, per thread): ingest and each window.
  const cpu = { ingestS: ingestCpuMs / 1000, windows: [] };
  const byHandle = new Map(objects.map((x) => [x.handle, x]));
  const reentries = [];
  let screenStartJd = o.screenStartJd;
  // The UTC Julian date of the epoch in a reentry error ("... at <ISO> UTC").
  const reentryJd = (reason) => {
    const m = /^reentry: .* at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?) UTC/.exec(reason);
    return m ? unixSeconds(m[1]) / 86400 + 2440587.5 : null;
  };

  return {
    objects, excluded, reentries, cpu, deriveMs, ingestMs, workers: count, instances: instanceCount, epochStateReport: report, profile,
    /** Trajectories of every object over [startJd, startJd + days], UTC. */
    async window(startJd, days) {
      screenStartJd ??= startJd;
      const parts = await Promise.all(workers.map((w) => send(w, 'window', { startJd, seconds: days * 86400, loadCeiling: o.loadCeiling })));
      cpu.windows.push({ startJd, cpuS: parts.reduce((sum, p) => sum + p.cpuMs, 0) / 1000,
        maxWorkerCpuS: Math.max(...parts.map((p) => p.cpuMs)) / 1000, maxWorkerPausedS: Math.max(...parts.map((p) => p.pausedMs)) / 1000 });
      const frames = parts.flatMap((p) => p.frames);
      const dropped = [];
      for (const d of parts.flatMap((p) => p.dropped)) {
        const object = byHandle.get(d.handle), jd = reentryJd(d.reason);
        if (jd !== null) reentries.push({ ...object, jd, phase: jd < screenStartJd ? 'catch-up' : 'screen', reason: d.reason });
        if (jd === null || jd < screenStartJd) dropped.push({ ...object, reason: d.reason, jd: startJd });
      }
      return { frames, dropped };
    },
    async close() { await Promise.all(workers.map((w) => w.terminate())); },
  };
}
