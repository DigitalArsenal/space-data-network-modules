// $EST framing for analysis/estimation's fit_batch (module-local
// Estimation.fbs, extension v2). Encoding goes through flatc from JSON:
// JavaScript prints every double in its shortest round-trip form, so the
// bytes carry the exact values. Decoding reads the binary directly, because
// flatc's JSON output rounds doubles and the module refuses an answer whose
// seed differs in any bit. Representation only.
import fs from 'node:fs';
import path from 'node:path';
import * as flatbuffers from 'flatbuffers';
import createFlatc from 'flatc-wasm/module';

export const EST_TYPE = { schemaName: 'Estimation.fbs', fileIdentifier: '$EST', rootTypeName: 'EstimationEnvelope' };

// flatc with the module's own schema (and the SDK schemas it includes).
export async function estimationCodec(modulesDir, sdkSchemas) {
  const flatc = await createFlatc({ print: () => {}, printErr: () => {} });
  flatc.FS.mkdir('/schema');
  flatc.FS.mkdir('/out');
  for (const name of fs.readdirSync(sdkSchemas).filter((n) => n.endsWith('.fbs'))) flatc.FS.writeFile(`/schema/${name}`, fs.readFileSync(path.join(sdkSchemas, name)));
  flatc.FS.writeFile('/schema/Estimation.fbs', fs.readFileSync(path.join(modulesDir, 'analysis/estimation/schemas/Estimation.fbs')));
  return {
    encode(value) {
      flatc.FS.writeFile('/in.json', JSON.stringify(value));
      const rc = flatc.callMain(['--no-warnings', '--strict-json', '-I', '/schema', '-o', '/out', '--binary', '/schema/Estimation.fbs', '/in.json']);
      if (rc !== 0) throw new Error(`flatc: cannot encode the $EST request (exit ${rc})`);
      return Uint8Array.from(flatc.FS.readFile('/out/in.bin'));
    },
  };
}

// Field slots (schema order) of the tables read here.
const RESULT = { status: 0, propagationRequests: 11, batchFit: 12, errorMessage: 8 };
const QUERY = { sequence: 0, seed: 1, targetEpoch: 2, parameterValues: 3 };
const FIT = ['stateDimension', 'parameterKinds', 'estimate', 'covariance', 'scaledCovariance', 'chiSquare', 'reducedChiSquare', 'weightedRms',
  'measurementCount', 'degreesOfFreedom', 'iterations', 'converged', 'whitenedResiduals', 'rejectedObservationIndices'];
// Extension v2's BatchFitResult suffix (slots 14-19), and the fields of a
// CovarianceRegularization; a version-1 result has none of them.
const FIT_V2 = { measurementParameterCount: 14, considerCovariance: 15, boundStatus: 16, covarianceRtn: 17, considerCovarianceRtn: 18, regularizations: 19 };

const field = (bb, table, slot) => bb.__offset(table, 4 + 2 * slot);
const doubles = (bb, table, slot) => {
  const o = field(bb, table, slot);
  if (!o) return [];
  const start = bb.__vector(table + o), n = bb.__vector_len(table + o);
  return Array.from({ length: n }, (_, i) => bb.readFloat64(start + 8 * i));
};
const integers = (bb, table, slot, width) => {
  const o = field(bb, table, slot);
  if (!o) return [];
  const start = bb.__vector(table + o), n = bb.__vector_len(table + o);
  return Array.from({ length: n }, (_, i) => (width === 1 ? bb.readUint8(start + i) : bb.readUint32(start + 4 * i)));
};
const epochAt = (bb, at) => ({ jd_day: bb.readFloat64(at), seconds: bb.readFloat64(at + 8) });

// {status, queries: [{sequence, seed: {epoch, state[6]}, target_epoch, parameter_values}], fit}
export function decodeResult(bytes) {
  const bb = new flatbuffers.ByteBuffer(new Uint8Array(bytes));
  if (bb.__has_identifier && !bb.__has_identifier('$EST')) throw new Error('not an $EST envelope');
  const root = bb.readInt32(bb.position()) + bb.position();
  const ro = field(bb, root, 1);
  if (!ro) throw new Error('$EST envelope without a result');
  const result = bb.__indirect(root + ro);
  const so = field(bb, result, RESULT.status);
  const status = so ? bb.readInt32(result + so) : 0;
  const queries = [];
  const qo = field(bb, result, RESULT.propagationRequests);
  if (qo) {
    const start = bb.__vector(result + qo), n = bb.__vector_len(result + qo);
    for (let i = 0; i < n; ++i) {
      const q = bb.__indirect(start + 4 * i);
      const seq = field(bb, q, QUERY.sequence), seed = field(bb, q, QUERY.seed), target = field(bb, q, QUERY.targetEpoch);
      const at = q + seed;
      queries.push({
        sequence: seq ? bb.readUint32(q + seq) : 0,
        seed: { epoch: epochAt(bb, at), state: Array.from({ length: 6 }, (_, k) => bb.readFloat64(at + 16 + 8 * k)) },
        target_epoch: epochAt(bb, q + target),
        parameter_values: doubles(bb, q, QUERY.parameterValues),
      });
    }
  }
  let fit = null;
  const fo = field(bb, result, RESULT.batchFit);
  if (fo) {
    const t = bb.__indirect(result + fo);
    fit = {};
    FIT.forEach((name, slot) => {
      const o = field(bb, t, slot);
      if (['parameterKinds'].includes(name)) fit[name] = integers(bb, t, slot, 1);
      else if (name === 'rejectedObservationIndices') fit[name] = integers(bb, t, slot, 4);
      else if (['estimate', 'covariance', 'scaledCovariance', 'whitenedResiduals'].includes(name)) fit[name] = doubles(bb, t, slot);
      else if (name === 'stateDimension') fit[name] = o ? bb.readUint8(t + o) : 0;
      else if (name === 'converged') fit[name] = o ? bb.readUint8(t + o) !== 0 : false;
      else if (['measurementCount', 'degreesOfFreedom', 'iterations'].includes(name)) fit[name] = o ? bb.readUint32(t + o) : 0;
      else fit[name] = o ? bb.readFloat64(t + o) : 0;
    });
    const mo = field(bb, t, FIT_V2.measurementParameterCount);
    fit.measurementParameterCount = mo ? bb.readUint32(t + mo) : 0;
    fit.considerCovariance = doubles(bb, t, FIT_V2.considerCovariance);
    fit.boundStatus = integers(bb, t, FIT_V2.boundStatus, 1);
    fit.covarianceRtn = doubles(bb, t, FIT_V2.covarianceRtn);
    fit.considerCovarianceRtn = doubles(bb, t, FIT_V2.considerCovarianceRtn);
    fit.regularizations = [];
    const ro2 = field(bb, t, FIT_V2.regularizations);
    if (ro2) {
      const start = bb.__vector(t + ro2), n = bb.__vector_len(t + ro2);
      for (let i = 0; i < n; ++i) {
        const r = bb.__indirect(start + 4 * i);
        const at = (slot) => field(bb, r, slot);
        fit.regularizations.push({
          block: at(0) ? bb.readInt32(r + at(0)) : -1, observation: at(1) ? bb.readUint32(r + at(1)) : 0,
          dimension: at(2) ? bb.readUint32(r + at(2)) : 0, raised: at(3) ? bb.readUint32(r + at(3)) : 0,
          minimumEigenvalue: at(4) ? bb.readFloat64(r + at(4)) : 0, frobeniusChange: at(5) ? bb.readFloat64(r + at(5)) : 0,
          maximumCorrelationChange: at(6) ? bb.readFloat64(r + at(6)) : 0,
        });
      }
    }
  }
  return { status, queries, fit };
}

// The fixed-layout EstimationObservation struct, as flatc JSON wants it.
export function positionObservation(epoch, positionM) {
  const zero3 = [0, 0, 0];
  return {
    epoch, value: [...positionM, 0], sigma: [1, 1, 1, 1], station_position_m: zero3, station_velocity_mps: zero3, station_east: zero3, station_north: zero3,
    station_up: zero3, remote_position_m: zero3, remote_velocity_mps: zero3, frequency_hz: 0, transmitter_delay_seconds: 0, receiver_delay_seconds: 0,
    transponder_delay_seconds: 0, elevation_rad: 0, station_latitude_rad: 0, station_height_m: 0, pressure_hpa: 0, temperature_k: 0, relative_humidity: 0,
    wavelength_m: 0, total_electron_content: 0, total_electron_content_rate_per_second: 0, turnaround_numerator: 1, turnaround_denominator: 1,
    kind: 'POSITION_VECTOR', value_count: 3, flags: 3, transmitter_index: 0, receiver_index: 0,
  };
}

// A query's seed as the full EstimationState struct the module emitted.
export function seedStruct(query) {
  return {
    epoch: query.seed.epoch, state: query.seed.state, covariance: Array(36).fill(0), residual_rms: 0, recovered_noise_sigma: 0,
    iteration_count: 0, accepted_count: 0, rejected_count: 0, reference_frame: 'ICRF', converged: 0, smoothed: 0, estimator: 'BATCH_WEIGHTED_LEAST_SQUARES',
  };
}
