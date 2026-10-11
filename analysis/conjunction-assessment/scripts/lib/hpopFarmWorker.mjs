// One worker thread of the HPOP propagation farm (hpopFarm.mjs): hosts HPOP
// resident instances of at most 1,024 objects each and exports their
// conjunction-screening trajectories window by window. Every number comes
// from propagator/hpop; this file builds and forwards PRW records.
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { parentPort } from 'node:worker_threads';
import * as flatbuffers from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import {
  FRMStateVectorT, FRMVector3T, PRW, PRWDescribeRequestT, PRWInstanceT, PRWPrepareRequestT, PRWResidentStateT, PRWT,
  RFMCoordinateSystemT, RFMOriginT, TIMInstantT, frmStateRepresentation, rfmAxisType, rfmOriginKind,
  timEpochRepresentation, timingStandard,
} from 'spacedatastandards.org/lib/js/PRW/main.js';

const TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
const encode = (arm, value) => {
  const record = new PRWT();
  record[arm] = value;
  const builder = new flatbuffers.Builder(1024);
  PRW.finishSizePrefixedPRWBuffer(builder, record.pack(builder));
  return builder.asUint8Array().slice();
};
const decode = (bytes) => PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(bytes)).unpack();
const gcrf = () => new RFMCoordinateSystemT('GCRF', rfmAxisType.ICRF, new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399), 399);
const utc = (jd) => new TIMInstantT(timingStandard.UTC, timEpochRepresentation.JULIAN_DATE, jd);

const instances = [];   // { harness, identity, handles: Set<number> }

async function call(harness, methodId, port, arm, records) {
  return harness.invoke({ methodId, inputs: records.map((r) => ({ portId: port, typeRef: TYPE, payload: encode(arm, r) })) });
}

// GCRF/UTC epoch states (epoch-state output) -> one resident HPOP catalog:
// under the full force model (propagator/hpop/catalog.mjs; each object's
// Cd*A/m from its B*, converted by the module), or under the profile named
// gravity-only.
async function addInstance({ wasm, manifest, catalogPath, profile, environment, id, states }) {
  const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  const identity = new PRWInstanceT('com.orbpro.hpop', id, 1n);
  if (profile === 'full-force') {
    const catalog = await import(pathToFileURL(catalogPath).href);
    const meters = (s) => [...s.position, ...s.velocity].map((x) => x * 1000);
    const inputs = states.map((s) => ({ portId: 'state', typeRef: TYPE, payload: catalog.encode('RESIDENT_STATE', catalog.residentState({
      instanceId: id, handle: s.handle, catalogNumber: s.norad, objectId: s.objectId, epoch: s.epoch, state: meters(s),
      cdAm: catalog.dragAreaOverMass(harness.instance.exports, s.bstar), crAm: catalog.DEFAULT_SRP_AREA_OVER_MASS })) }));
    // The configuration's own state is a placeholder each object replaces.
    inputs.push({ portId: 'configuration', typeRef: TYPE, payload: catalog.encode('EXECUTION_REQUEST',
      catalog.fullForceRequest({ epoch: states[0].epoch, state: meters(states[0]) })) });
    for (const [portId, payload] of Object.entries(environment)) inputs.push({ portId, typeRef: TYPE, payload });
    const response = await harness.invoke({ methodId: 'ingest_state', inputs });
    if (response.statusCode !== 0) throw new Error(`HPOP ingest: ${response.errorCode}: ${response.errorMessage}`);
    instances.push({ harness, identity, handles: new Set(states.map((s) => s.handle)) });
    return;
  }
  const records = states.map((s) => {
    const state = new FRMStateVectorT(frmStateRepresentation.CARTESIAN, [],
      new FRMVector3T(s.position[0] * 1000, s.position[1] * 1000, s.position[2] * 1000),
      new FRMVector3T(s.velocity[0] * 1000, s.velocity[1] * 1000, s.velocity[2] * 1000), 'GCRF', s.epoch, 'UTC');
    const resident = new PRWResidentStateT(identity, s.handle, s.norad, s.objectId, state, gcrf());
    resident.VALID = true;
    return resident;
  });
  const response = await call(harness, 'ingest_state_gravity_only', 'state', 'RESIDENT_STATE', records);
  if (response.statusCode !== 0) throw new Error(`HPOP ingest: ${response.errorCode}: ${response.errorMessage}`);
  instances.push({ harness, identity, handles: new Set(states.map((s) => s.handle)) });
}

const prepare = (instance, startJd, seconds, handles) => call(instance.harness, 'prepare_trajectory_segments', 'request', 'PREPARE_REQUEST',
  [new PRWPrepareRequestT(instance.identity, 0, handles, utc(startJd), seconds, 'conjunction-screening')]);

// Objects are prepared CHUNK at a time; with a load ceiling, a chunk waits
// while the host's 1-minute load average is above it.
const CHUNK = 64;
async function belowCeiling(ceiling) {
  const t0 = performance.now();
  while (ceiling && os.loadavg()[0] > ceiling) await new Promise((resolve) => setTimeout(resolve, 5000));
  return performance.now() - t0;
}
const cpuMs = (since) => { const c = process.threadCpuUsage(since); return (c.user + c.system) / 1000; };

// One window of every instance: { frames, dropped: [{handle, reason}], cpuMs,
// pausedMs }. An object HPOP cannot cover (an error, or its reentry) is found
// by preparing objects one at a time and leaves the instance for the rest of
// the run; the farm reads the reason. cpuMs is this thread's CPU time (user
// and system) for the window.
async function exportWindow({ startJd, seconds, loadCeiling }) {
  const frames = [], dropped = [];
  const cpu0 = process.threadCpuUsage();
  let pausedMs = 0;
  for (const instance of instances) {
    const handles = [...instance.handles];
    for (let at = 0; at < handles.length; at += CHUNK) {
      pausedMs += await belowCeiling(loadCeiling);
      const chunk = handles.slice(at, at + CHUNK);
      if ((await prepare(instance, startJd, seconds, chunk)).statusCode === 0) continue;
      for (const handle of chunk) {
        const alone = await prepare(instance, startJd, seconds, [handle]);
        if (alone.statusCode !== 0) {
          instance.handles.delete(handle);
          dropped.push({ handle, reason: `${alone.errorCode}: ${alone.errorMessage}` });
        }
      }
    }
    if (instance.handles.size === 0) continue;
    // Every object is prepared: the whole set assembles without integrating.
    const prepared = await prepare(instance, startJd, seconds, [...instance.handles]);
    if (prepared.statusCode !== 0) throw new Error(`HPOP prepare: ${prepared.errorCode}: ${prepared.errorMessage}`);
    const set = decode(prepared.outputs[0].payload).PREPARE_RESULT.SEGMENT_SET_HANDLE;
    const describe = { methodId: 'describe_trajectory_segments',
      inputs: [{ portId: 'request', typeRef: TYPE, payload: encode('DESCRIBE_REQUEST', new PRWDescribeRequestT(instance.identity, set)) }] };
    for (;;) {   // one source per chunk; the same request continues it
      const chunk = await instance.harness.invoke(describe);
      if (chunk.statusCode !== 0) throw new Error(`HPOP describe: ${chunk.errorCode}: ${chunk.errorMessage}`);
      const frame = chunk.outputs[0].payload.slice();   // its own buffer, to transfer
      frames.push(frame);
      if (PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(frame)).DESCRIBE_RESULT().FINAL_CHUNK()) break;
    }
  }
  return { frames, dropped, cpuMs: cpuMs(cpu0), pausedMs };
}

parentPort.on('message', async ({ id, op, args }) => {
  try {
    if (op === 'add') {
      const cpu0 = process.threadCpuUsage();
      await addInstance({ ...args, wasm: fs.readFileSync(args.wasmPath), manifest: JSON.parse(fs.readFileSync(args.manifestPath, 'utf8')) });
      parentPort.postMessage({ id, ok: true, result: { cpuMs: cpuMs(cpu0) } });
    } else if (op === 'window') {
      const result = await exportWindow(args);
      parentPort.postMessage({ id, ok: true, result }, result.frames.map((f) => f.buffer));
    }
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.stack ?? error) });
  }
});
