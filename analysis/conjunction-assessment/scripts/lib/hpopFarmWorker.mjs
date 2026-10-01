// One worker thread of the HPOP propagation farm (hpopFarm.mjs): hosts HPOP
// resident instances of at most 1,024 objects each and exports their
// conjunction-screening trajectories window by window. Every number comes
// from propagator/hpop; this file builds and forwards PRW records.
import fs from 'node:fs';
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

// GCRF/UTC epoch states (epoch-state output) -> one resident HPOP catalog.
async function addInstance({ wasm, manifest, id, states }) {
  const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  const identity = new PRWInstanceT('com.orbpro.hpop', id, 1n);
  const records = states.map((s) => {
    const state = new FRMStateVectorT(frmStateRepresentation.CARTESIAN, [],
      new FRMVector3T(s.position[0] * 1000, s.position[1] * 1000, s.position[2] * 1000),
      new FRMVector3T(s.velocity[0] * 1000, s.velocity[1] * 1000, s.velocity[2] * 1000), 'GCRF', s.epoch, 'UTC');
    const resident = new PRWResidentStateT(identity, s.handle, s.norad, s.objectId, state, gcrf());
    resident.VALID = true;
    return resident;
  });
  const response = await call(harness, 'ingest_state', 'state', 'RESIDENT_STATE', records);
  if (response.statusCode !== 0) throw new Error(`HPOP ingest: ${response.errorCode}: ${response.errorMessage}`);
  instances.push({ harness, identity, handles: new Set(states.map((s) => s.handle)) });
}

const prepare = (instance, startJd, seconds, handles) => call(instance.harness, 'prepare_trajectory_segments', 'request', 'PREPARE_REQUEST',
  [new PRWPrepareRequestT(instance.identity, 0, handles, utc(startJd), seconds, 'conjunction-screening')]);

// One window of every instance: [{ frames, dropped: [{handle, reason}] }].
// An object HPOP cannot cover is found by preparing objects one at a time and
// leaves the instance for the rest of the run.
async function exportWindow({ startJd, seconds }) {
  const frames = [], dropped = [];
  for (const instance of instances) {
    let prepared = await prepare(instance, startJd, seconds, [...instance.handles]);
    if (prepared.statusCode !== 0) {
      for (const handle of [...instance.handles]) {
        const alone = await prepare(instance, startJd, seconds, [handle]);
        if (alone.statusCode !== 0) {
          instance.handles.delete(handle);
          dropped.push({ handle, reason: `${alone.errorCode}: ${alone.errorMessage}` });
        }
      }
      if (instance.handles.size === 0) continue;
      prepared = await prepare(instance, startJd, seconds, [...instance.handles]);
      if (prepared.statusCode !== 0) throw new Error(`HPOP prepare: ${prepared.errorCode}: ${prepared.errorMessage}`);
    }
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
  return { frames, dropped };
}

parentPort.on('message', async ({ id, op, args }) => {
  try {
    if (op === 'add') {
      await addInstance({ ...args, wasm: fs.readFileSync(args.wasmPath), manifest: JSON.parse(fs.readFileSync(args.manifestPath, 'utf8')) });
      parentPort.postMessage({ id, ok: true });
    } else if (op === 'window') {
      const result = await exportWindow(args);
      parentPort.postMessage({ id, ok: true, result }, result.frames.map((f) => f.buffer));
    }
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.stack ?? error) });
  }
});
