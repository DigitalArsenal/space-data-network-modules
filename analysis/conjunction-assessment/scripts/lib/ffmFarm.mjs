// FFM propagation farm for a catalog-wide trajectory screen: one propagator
// run. analysis/epoch-state turns each element set into a GCRF state at its
// epoch (SGP4 at zero elapsed time, TEME -> GCRF); propagator/ffm integrates
// those states on worker threads, at most 1,024 objects per resident
// instance, and exports conjunction-screening trajectories one time window at
// a time. All physics is in those modules; this file moves records.
//
// Profiles: 'full-force' (the default) configures every instance with the
// full force model of propagator/ffm/catalog.mjs and the environment frames
// in `environment` (kernel.prw, earth_orientation.prw and space_weather.prw,
// PRW records), each object carrying its Cd*A/m (from its B*) and Cr*A/m;
// 'gravity-only' names the point mass and degree/order 20 field.
import { decodeFlowNotice } from 'space-data-module-sdk/runtime-contracts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as flatbuffers from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { MPE, meanElementSource } from 'spacedatastandards.org/lib/js/MPE/main.js';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/main.js';
import { OMM } from 'spacedatastandards.org/lib/js/OMM/main.js';

const BATCH = 1024;   // FFM ingest_state limit per resident catalog

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
      typeRef: { schemaName: 'MPE.fbs', fileIdentifier: '$MPE', rootTypeName: 'MPE', wireFormat: 'flatbuffer' } }] });
    if (response.statusCode !== 0) throw new Error(`epoch-state: ${response.errorCode}: ${response.errorMessage}`);
    // report: a FlowNotice (Info); ITEMS are "key=value" counts, then one "failure index=… entity_id=… reason=…" per refused set.
    const notice = decodeFlowNotice(response.outputs.find((f) => f.portId === 'report').payload);
    const report = { reason: notice.reason, count: notice.count, failures: [] };
    for (const item of notice.items) {
      if (item.startsWith('failure ')) report.failures.push(Object.fromEntries([...item.slice(8).matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]])));
      else { const at = item.indexOf('='); if (at > 0) report[item.slice(0, at)] = item.slice(at + 1); }
    }
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
 * A resident FFM farm. The single implementation is `ffm`.
 * `workers` is an explicit positive integer; auto leaves two cores available
 * and caps at 16. `environment` is immutable for this farm's lifetime.
 * `updateCatalog(catalog, { handles })` retains byte-identical OMM records and
 * handles, deriving and ingesting only changed/new records. Unspecified handles
 * remain stable by NORAD number. Deleted records leave the active catalog.
 * New environment/force configuration requires a new farm, so carried states
 * can never silently retain stale drivers after an environment change.
 */
export async function createFfmFarm(o) {
  const implementation = o.implementation ?? 'ffm';
  if (implementation !== 'ffm') throw new Error(`Unknown FFM implementation ${implementation}: ffm is the only implementation.`);
  const profile = o.profile ?? 'full-force';
  if (!['full-force', 'gravity-only'].includes(profile)) throw new Error(`Unknown FFM profile ${profile}: full-force or gravity-only.`);
  if (o.workers !== undefined && (!Number.isInteger(o.workers) || o.workers < 1)) throw new Error('FFM workers must be a positive integer.');
  const availableCores = os.availableParallelism();
  const count = Math.min(o.workers ?? Math.min(16, Math.max(1, availableCores - 2)), Math.max(1, o.catalog.length));
  const workerPolicy = { requested: o.workers ?? 'auto', availableCores, selected: count, autoCap: 16, reservedCores: 2 };
  let environment = null;
  if (profile === 'full-force') {
    if (!o.environment) throw new Error('The full-force FFM farm needs its environment frames (kernel.prw, earth_orientation.prw, space_weather.prw).');
    environment = Object.fromEntries(['kernel', 'earth_orientation', 'space_weather'].map((port) =>
      [port, new Uint8Array(fs.readFileSync(path.join(o.environment, `${port}.prw`)))]));
  }
  const ffm = path.join(o.modulesRoot, 'propagator', implementation);
  const manifest = JSON.parse(fs.readFileSync(path.join(ffm, 'plugin-manifest.json'), 'utf8'));
  const workers = Array.from({ length: count }, () => new Worker(new URL('./ffmFarmWorker.mjs', import.meta.url)));
  let messageId = 0, instanceId = 0, residentInstances = 0, nextHandle = 1;
  let rows = new Map(), deriveMs = 0, ingestMs = 0, epochStateReport = null, closed = false, closing = false, fatal = null;
  let operations = Promise.resolve();
  const pending = new Map(), reentries = [], cpu = { ingestS: 0, windows: [], updates: [] };
  const failWorker = (worker, error) => {
    if (!closed) fatal = error;
    for (const [id, p] of pending) if (p.worker === worker) { pending.delete(id); p.reject(error); }
  };
  for (const worker of workers) {
    worker.on('message', ({ id, ok, result, error }) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    });
    worker.on('error', (error) => failWorker(worker, error));
    worker.on('exit', (code) => { if (!closed) failWorker(worker, new Error(`FFM worker exited (${code}).`)); });
  }
  const send = (worker, op, args) => new Promise((resolve, reject) => {
    if (fatal || closed) { reject(fatal ?? new Error('FFM farm is closed.')); return; }
    const id = messageId++; pending.set(id, { worker, resolve, reject });
    try { worker.postMessage({ id, op, args }); } catch (error) { pending.delete(id); reject(error); }
  });
  const serialize = (fn) => {
    if (closing || closed) return Promise.reject(new Error('FFM farm is closed.'));
    const result = operations.then(() => { if (fatal) throw fatal; return fn(); });
    operations = result.catch(() => {});
    return result;
  };
  let screenStartJd = o.screenStartJd, residentStats = [];
  const reentryJd = (reason) => {
    const m = /^reentry: .* at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?) UTC/.exec(reason);
    return m ? unixSeconds(m[1]) / 86400 + 2440587.5 : null;
  };
  const objectOf = ({ object }) => object;

  async function update(catalog, { handles } = {}) {
    if (handles && handles.length !== catalog.length) throw new Error('FFM handles must match catalog length.');
    const next = new Map(), seenHandles = new Set(), changed = [];
    let candidateNextHandle = nextHandle;
    for (const [i, bytes] of catalog.entries()) {
      const omm = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(bytes)).unpack();
      const norad = Number(omm.NORAD_CAT_ID), prior = rows.get(norad);
      const handle = handles?.[i] ?? prior?.object.handle ?? candidateNextHandle++;
      if (!Number.isSafeInteger(norad) || norad <= 0 || next.has(norad)) throw new Error('FFM catalog requires unique positive NORAD numbers.');
      if (!Number.isInteger(handle) || handle <= 0 || handle > 0xffffffff || seenHandles.has(handle)) throw new Error('FFM handles must be unique positive uint32 values.');
      candidateNextHandle = Math.max(candidateNextHandle, handle + 1); seenHandles.add(handle);
      if (prior?.object.handle === handle && Buffer.from(bytes).equals(prior.bytes)) { next.set(norad, prior); continue; }
      const row = { bytes: Buffer.from(bytes), omm, object: { handle, norad, objectId: omm.OBJECT_ID || String(norad), name: omm.OBJECT_NAME, bstar: omm.BSTAR } };
      changed.push(row); next.set(norad, row);
    }
    const removed = [...rows.values()].filter((row) => next.get(row.object.norad) !== row);
    const t0 = performance.now();
    const derived = changed.length ? await epochStates(path.join(o.modulesRoot, 'analysis/epoch-state'), changed.map((r) => r.omm)) : null;
    const thisDeriveMs = performance.now() - t0;
    deriveMs += thisDeriveMs;
    if (derived) epochStateReport = derived.report;
    const ready = [];
    for (const row of changed) {
      const state = derived.states.get(row.object.norad);
      if (state) ready.push({ ...row.object, ...state });
      else row.excluded = { ...row.object, reason: 'epoch-state refused the element set' };
    }
    const t1 = performance.now();
    try {
      const removals = removed.length ? await Promise.all(workers.map((w) => send(w, 'remove', { handles: removed.map((r) => r.object.handle) }))) : [];
      const removalCpuS = removals.reduce((sum, r) => sum + r.cpuMs, 0) / 1000;
      const batches = Math.max(Math.ceil(ready.length / BATCH), Math.min(2 * count, ready.length));
      const buckets = Array.from({ length: batches }, () => []);
      ready.forEach((state, i) => buckets[i % batches].push(state));
      const adds = buckets.map((states) => {
        const id = instanceId++;
        return send(workers[id % count], 'add', { wasmPath: path.join(ffm, 'dist/isomorphic/module.wasm'),
          manifestPath: path.join(ffm, 'plugin-manifest.json'), catalogPath: path.join(ffm, 'catalog.mjs'), profile, environment,
          id: `farm-${id}`, states });
      });
      const cpuS = removalCpuS + (await Promise.all(adds)).reduce((sum, r) => sum + r.cpuMs, 0) / 1000;
      residentStats = await Promise.all(workers.map((w) => send(w, 'residency', {})));
      residentInstances = residentStats.reduce((sum, r) => sum + r.instances, 0); cpu.ingestS += cpuS; ingestMs += performance.now() - t1;
      const summary = { unchanged: next.size - changed.length, changed: changed.filter((r) => rows.has(r.object.norad)).length,
        added: changed.filter((r) => !rows.has(r.object.norad)).length, deleted: [...rows.keys()].filter((id) => !next.has(id)).length,
        derived: changed.length, excluded: changed.filter((r) => r.excluded).length, deriveMs: thisDeriveMs, ingestCpuS: cpuS };
      rows = next; nextHandle = candidateNextHandle; cpu.updates.push(summary); return summary;
    } catch (error) { fatal = error; throw error; }
  }

  const farm = {
    get objects() { return [...rows.values()].map(objectOf); },
    get excluded() { return [...rows.values()].flatMap((r) => r.excluded ? [r.excluded] : []); },
    get instances() { return residentInstances; }, get residency() { return residentStats.map((r) => ({ ...r })); }, get deriveMs() { return deriveMs; }, get ingestMs() { return ingestMs; },
    get epochStateReport() { return epochStateReport; },
    reentries, cpu, workers: count, workerPolicy, profile, implementation, moduleId: manifest.pluginId,
    updateCatalog(catalog, options) { return serialize(() => update(catalog, options)); },
    window(startJd, days) { return serialize(async () => {
      if (!Number.isFinite(startJd) || !Number.isFinite(days) || days < 0) throw new Error('FFM window requires finite start and nonnegative days.');
      screenStartJd ??= startJd;
      const parts = await Promise.all(workers.map((w) => send(w, 'window', { startJd, seconds: days * 86400, loadCeiling: o.loadCeiling })));
      cpu.windows.push({ startJd, days, cpuS: parts.reduce((sum, p) => sum + p.cpuMs, 0) / 1000,
        maxWorkerCpuS: Math.max(...parts.map((p) => p.cpuMs)) / 1000, maxWorkerPausedS: Math.max(...parts.map((p) => p.pausedMs)) / 1000 });
      const byHandle = new Map(farm.objects.map((x) => [x.handle, x])), dropped = [];
      for (const d of parts.flatMap((p) => p.dropped)) {
        const object = byHandle.get(d.handle), jd = reentryJd(d.reason);
        if (jd !== null) reentries.push({ ...object, jd, phase: jd < screenStartJd ? 'catch-up' : 'screen', reason: d.reason });
        if (jd === null || jd < screenStartJd) dropped.push({ ...object, reason: d.reason, jd: startJd });
      }
      return { frames: parts.flatMap((p) => p.frames), dropped };
    }); },
    async close() {
      closing = true; await operations;
      if (closed) return;
      closed = true; await Promise.all(workers.map((w) => w.terminate()));
    },
  };
  try { await update(o.catalog, { handles: o.handles }); return farm; }
  catch (error) { await farm.close(); throw error; }
}
