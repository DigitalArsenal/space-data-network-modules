// One worker of hpop-calibration.mjs: hosts an HPOP resident instance and
// propagates arcs to their target epochs. Every number comes from
// propagator/hpop; this file builds and reads PRW records.
//
// Variants per arc (P(t) is linear in P0 and Q, so the host combines them):
//   state  no covariance;
//   a      the arc's P0, no process noise;
//   u0..u2 P0 = 0 and unit white-acceleration density (1 m^2/s^3) on the
//          radial, transverse or normal axis.
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import * as flatbuffers from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import {
  FRMStateVectorT, FRMVector3T, PRW, PRWInstanceT, PRWProcessNoiseT, PRWResidentRequestT, PRWResidentStateT, PRWStateMatrixT,
  PRWT, RFMCoordinateSystemT, RFMOriginT, TIMInstantT, frmStateRepresentation, prwProcessNoiseAxes, prwProcessNoiseModel,
  rfmAxisType, rfmOriginKind, timEpochRepresentation, timingStandard,
} from 'spacedatastandards.org/lib/js/PRW/main.js';

const TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
const POSITION_BLOCK = [0, 1, 2, 7, 8, 14];  // xx, xy, xz, yy, yz, zz of a row-major 6x6
const encode = (arm, value) => {
  const record = new PRWT();
  record[arm] = value;
  const builder = new flatbuffers.Builder(1024);
  PRW.finishSizePrefixedPRWBuffer(builder, record.pack(builder));
  return builder.asUint8Array().slice();
};
const gcrf = () => new RFMCoordinateSystemT('GCRF', rfmAxisType.ICRF, new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399), 399);
const iso = (text) => new TIMInstantT(timingStandard.UTC, timEpochRepresentation.ISO8601, 0, 0, text);

function record(identity, handle, arc, variant, interval) {
  const s = arc.seed;
  const state = new FRMStateVectorT(frmStateRepresentation.CARTESIAN, [],
    new FRMVector3T(s.position[0] * 1000, s.position[1] * 1000, s.position[2] * 1000),
    new FRMVector3T(s.velocity[0] * 1000, s.velocity[1] * 1000, s.velocity[2] * 1000), 'GCRF', s.epoch, 'UTC');
  const r = new PRWResidentStateT(identity, handle, arc.norad, String(arc.norad), state, gcrf());
  r.VALID = true;
  if (variant === 'a') r.COVARIANCE = new PRWStateMatrixT(6, arc.covariance);
  if (variant.startsWith('u')) {
    const q = [0, 0, 0];
    q[Number(variant[1])] = 1;
    r.COVARIANCE = new PRWStateMatrixT(6, new Array(36).fill(0));
    r.PROCESS_NOISE = new PRWProcessNoiseT(prwProcessNoiseModel.WHITE_ACCELERATION, prwProcessNoiseAxes.RADIAL_TRANSVERSE_NORMAL, q, interval);
  }
  return r;
}

async function run({ wasmPath, manifestPath, id, arcs, variants, interval }) {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath),
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')), surface: 'direct' });
  const per = Math.floor(1024 / variants.length);
  const results = [];
  let generation = 0n;
  try {
    for (let at = 0; at < arcs.length; at += per) {
      const batch = arcs.slice(at, at + per);
      const identity = new PRWInstanceT('com.orbpro.hpop', id, ++generation);
      const records = batch.flatMap((arc, i) => variants.map((v, k) => record(identity, i * variants.length + k + 1, arc, v, interval)));
      const ingest = await harness.invoke({ methodId: 'ingest_state',
        inputs: records.map((r) => ({ portId: 'state', typeRef: TYPE, payload: encode('RESIDENT_STATE', r) })) });
      if (ingest.statusCode !== 0) throw new Error(`HPOP ingest: ${ingest.errorCode}: ${ingest.errorMessage}`);
      for (let i = 0; i < batch.length; ++i) {
        const samples = [];
        for (const target of batch[i].targets) {
          const sample = {};
          for (let k = 0; k < variants.length; ++k) {
            const request = new PRWResidentRequestT(identity, iso(target), [i * variants.length + k + 1], 0, gcrf());
            const res = await harness.invoke({ methodId: 'propagate_state',
              inputs: [{ portId: 'request', typeRef: TYPE, payload: encode('RESIDENT_REQUEST', request) }] });
            if (res.statusCode !== 0) { sample.error = `${res.errorCode}: ${res.errorMessage}`; break; }
            const out = PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(res.outputs[0].payload)).RESIDENT_STATE();
            if (k === 0) {
              const st = out.STATE();
              const p = st.POSITION(), v = st.VELOCITY();
              sample.state = [p.X(), p.Y(), p.Z(), v.X(), v.Y(), v.Z()];
            }
            const v = variants[k];
            if (v !== 'state') {
              const c = out.COVARIANCE();
              const block = POSITION_BLOCK.map((j) => c.VALUES(j));
              if (v === 'a') sample.a = block;
              else (sample.u ??= [])[Number(v[1])] = block;
            }
          }
          samples.push(sample.error ? { error: sample.error } : sample);
        }
        results.push({ arc: batch[i].arc, samples });
        parentPort.postMessage({ progress: 1 });
      }
    }
  } finally {
    await harness.destroy();
  }
  return results;
}

parentPort.on('message', async (job) => {
  try {
    parentPort.postMessage({ done: true, results: await run(job) });
  } catch (error) {
    parentPort.postMessage({ done: true, error: String(error?.stack ?? error) });
  }
});
