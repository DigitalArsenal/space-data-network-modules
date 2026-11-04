#!/usr/bin/env node
// Records what the module's dist writes on the fixture runs (tests/fixture-runs.mjs) into
// tests/fixtures/free-form.json: every USER_DEFINED_PARAMETERS entry of every relative, geometry and inspection
// $OCM, the $CVR fields, the maneuver entries, and the SHA-256 of each STATE_DATA column, of the relative
// STATE_DATA and of the COVARIANCE_DATA (float64 little-endian). tests/typed-records.e2e.mjs reads the typed
// fields against it. Hashes, not values: the Cosmos 2612 series derive from Space-Track element sets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { flatbuffers, OCM, CVR, ARCHIVE_THROUGH, COSMOS, cosmosRun, inspectionRun } from './fixture-runs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (values) => crypto.createHash('sha256').update(Buffer.from(Float64Array.from(values).buffer)).digest('hex');
const ocm = (bytes) => OCM.OCM.getSizePrefixedRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();
const cvr = (bytes) => CVR.CVR.getSizePrefixedRootAsCVR(new flatbuffers.ByteBuffer(bytes)).unpack();
const udpOf = (rec) => Object.fromEntries(rec.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));
const realismOf = (c) => ({ RULE: c.RULE, MODEL_ID: c.MODEL_ID, REGIME: c.REGIME, HORIZON_DAYS: c.HORIZON_DAYS, MEASURED_LINEAGE: c.MEASURED_LINEAGE,
  TEST_WINDOW: c.TEST_WINDOW, MEAN_D2_OVER_3: c.MEAN_D2_OVER_3, COVERAGE_95: c.COVERAGE_95, SAMPLES: c.SAMPLES, OBJECTS: c.OBJECTS,
  CALIBRATION: c.CALIBRATION, EVIDENCE: c.EVIDENCE });
function columns(rec) {
  const names = udpOf(rec).COLUMNS.split(','), w = rec.STATE_VECTOR_SIZE;
  return Object.fromEntries(names.map((name, k) => [name, sha(rec.STATE_DATA.filter((_, i) => i % w === k))]));
}
const series = (rec) => ({ MESSAGE_ID: rec.HEADER.MESSAGE_ID, START_TIME: rec.METADATA.START_TIME, STOP_TIME: rec.METADATA.STOP_TIME,
  TRAJ_TYPE_DESCRIPTION: rec.TRAJ_TYPE_DESCRIPTION, STATE_STEP_SIZE: rec.STATE_STEP_SIZE, STATE_VECTOR_SIZE: rec.STATE_VECTOR_SIZE,
  samples: rec.STATE_DATA.length / rec.STATE_VECTOR_SIZE, udp: udpOf(rec), columns: columns(rec) });

const cosmos = await cosmosRun();
const { radar, shadow } = await inspectionRun();
const fixture = {
  recorded: { at: new Date().toISOString(), dist: 'analysis/rpo-history dist/isomorphic/module.wasm before modules-rpo-history-typed-20261103',
    archiveThrough: ARCHIVE_THROUGH, elementSets: cosmos.elementSets, run: COSMOS },
  cosmos: {
    relative: cosmos.relative.map(ocm).map((rec) => ({ MESSAGE_ID: rec.HEADER.MESSAGE_ID, START_TIME: rec.METADATA.START_TIME, udp: udpOf(rec),
      stateData: sha(rec.STATE_DATA), covarianceData: rec.COVARIANCE_DATA.length ? sha(rec.COVARIANCE_DATA) : null,
      maneuvers: (rec.MANEUVER_DATA ?? []).map((m) => ({ MAN_ID: m.MAN_ID, MAN_EPOCH_START: m.MAN_EPOCH_START, MAN_DURATION: m.MAN_DURATION, MAN_COMMENT: m.MAN_COMMENT })),
      realism: rec.COV_REALISM.map(realismOf) })),
    geometry: cosmos.geometry.map(ocm).map(series),
    realism: cosmos.realism.map(cvr).map(realismOf),
  },
  inspection: { radar: radar.map(ocm).map(series), shadow: shadow.map(ocm).map(series) },
};
const out = path.join(HERE, 'fixtures/free-form.json');
fs.writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`recorded ${fixture.cosmos.relative.length} relative, ${fixture.cosmos.geometry.length} geometry, ${fixture.cosmos.realism.length} realism, ` +
  `${radar.length + shadow.length} inspection records -> ${out}`);
