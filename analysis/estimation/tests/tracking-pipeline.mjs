// A simulated tracking campaign through the modules, for fit_batch's
// measurement parameters: propagator/hpop truth (GCRF) -> foundation/frames
// (ITRF states) -> analysis/access (passes above 10 deg) ->
// analysis/observation-simulator (radar $RDO ranges, passive RF $RFO
// frequencies) -> analysis/association (each observation's sensor position and
// velocity in GCRF). Representation only: every number is a module's output;
// this file encodes and decodes records (SDS 1.241.0, association's pin).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { harness } from './batch-fit-fixtures.mjs';
import { hpopRun, isoOf } from './batch-fit-v2-lib.mjs';

const sdsRoot = path.dirname(createRequire(new URL('../../association/package.json', import.meta.url)).resolve('spacedatastandards.org/package.json'));
const req = createRequire(path.join(sdsRoot, 'package.json'));
const flatbuffers = req('flatbuffers');
const lib = async (code) => import(pathToFileURL(path.join(sdsRoot, `lib/js/${code}/main.js`)));
const [ACW, RDO, RFO, OEM, FRM] = await Promise.all(['ACW', 'RDO', 'RFO', 'OEM', 'FRM'].map(lib));

const EOP_FIXTURE = JSON.parse(fs.readFileSync(new URL('../../../propagator/hpop/tests/fixtures/orekit/eop-2026-08.json', import.meta.url), 'utf8'));
const EOP_STREAM = Buffer.from(EOP_FIXTURE.payloadBase64, 'base64');
const ACW_TYPE = { schemaName: 'ACW.fbs', fileIdentifier: '$ACW', rootTypeName: 'ACW', wireFormat: 'flatbuffer' };
const EOP_TYPE = { schemaName: 'EOP.fbs', fileIdentifier: '$EOP', rootTypeName: 'EOP', wireFormat: 'flatbuffer' };
export const C = 299792458;
const LEAP = 37;  // TAI - UTC in 2026 (s)
const jdTt = (seconds) => 2461254.5 + (seconds + LEAP + 32.184) / 86400;  // EPOCH_JD UTC + seconds, as JD TT
const at = (seconds) => ({ jdDay: 2461254.5, seconds });

function eopRows() {
  const rows = [];
  for (let i = 0; i < EOP_STREAM.length;) {
    const n = EOP_STREAM.readUInt32LE(i);
    const bb = new flatbuffers.ByteBuffer(new Uint8Array(EOP_STREAM.subarray(i, i + 4 + n)));
    rows.push(ACW.EOP.getSizePrefixedRootAsEOP(bb).unpack());
    i += 4 + n;
  }
  return rows;
}
const finish = (object, id) => { const b = new flatbuffers.Builder(1 << 16); b.finish(object.pack(b), id); return b.asUint8Array().slice(); };

// GCRF -> ITRF states through foundation/frames (FRM STATE_TRANSFORM with
// the fixture's EOP), one invocation per state.
async function toItrf(frames, seconds, states) {
  const earth = () => new FRM.RFMOriginT(FRM.rfmOriginKind.CELESTIAL_BODY, 399);
  const system = (name, axis, epoch) => new FRM.RFMCoordinateSystemT(name, axis, earth(), 399, epoch, 'UTC', null);
  const out = [];
  for (let k = 0; k < states.length; ++k) {
    const epoch = isoOf(at(seconds[k]));
    const s = states[k];
    const state = new FRM.FRMStateVectorT(FRM.frmStateRepresentation.CARTESIAN, [...s], new FRM.FRMVector3T(s[0], s[1], s[2]), new FRM.FRMVector3T(s[3], s[4], s[5]), 'ICRF', epoch, 'UTC', 3.986004418e14);
    const request = new FRM.FRMFrameTransformRequestT(FRM.frmOperationCode.STATE_TRANSFORM, null, null, 0, 0, null,
      system('ICRF', FRM.rfmAxisType.ICRF, epoch), system('ITRF', FRM.rfmAxisType.BODY_FIXED, epoch), state, FRM.frmStateRepresentation.CARTESIAN, epoch, 'UTC', null);
    const response = await frames.invoke({ methodId: 'transform_frame_position', inputs: [
      { portId: 'request', typeRef: { schemaName: 'FRM.fbs', fileIdentifier: '$FRM', rootTypeName: 'FRM' }, payload: finish(new FRM.FRMT(request, null), '$FRM') },
      { portId: 'earth_orientation', typeRef: EOP_TYPE, payload: EOP_STREAM },
    ] });
    if (response.statusCode !== 0) throw new Error(`frames: ${response.errorMessage}`);
    const result = FRM.FRM.getRootAsFRM(new flatbuffers.ByteBuffer(new Uint8Array(response.outputs[0].payload))).FRAME_TRANSFORM_RESULT();
    const t = result.TARGET_STATE();
    out.push([t.POSITION().X(), t.POSITION().Y(), t.POSITION().Z(), t.VELOCITY().X(), t.VELOCITY().Y(), t.VELOCITY().Z()]);
  }
  return out;
}

const stationOf = (s) => Object.assign(new ACW.ACWGroundStationT(), { STATION_ID: s.id, NAME: s.id, LATITUDE_RAD: s.lat * Math.PI / 180, LONGITUDE_RAD: s.lon * Math.PI / 180, ALTITUDE_M: s.h, MIN_ELEVATION_RAD: 10 * Math.PI / 180, CHANNEL_CAPACITY: 1 });
const sample = (seconds, s) => Object.assign(new ACW.ACWStateSampleT(), { JULIAN_DATE_TT: jdTt(seconds), POSITION_X_M: s[0], POSITION_Y_M: s[1], POSITION_Z_M: s[2], VELOCITY_X_MPS: s[3], VELOCITY_Y_MPS: s[4], VELOCITY_Z_MPS: s[5] });

// The campaign. stations [{id, lat, lon, h}], sensors [{id, station, kind:
// 'RADAR' | 'RF', models: [{type, sigma, bias}]}]; the target emits at
// `emitterHz`. Returns {radar: [$RDO], rf: [$RFO], geometry: Map(id ->
// {position, velocity} GCRF m, m/s at the record's time tag)} after
// `edit(records)` has changed the records (time tags, values).
export async function campaign({ hpop, truth, hours, step = 30, stations, sensors, emitterHz, seed, edit }) {
  const [frames, access, simulator, association] = await Promise.all([
    harness('../../../foundation/frames/'), harness('../../access/'), harness('../../observation-simulator/'), harness('../../association/'),
  ]);
  try {
    const seconds = Array.from({ length: Math.round((hours * 3600) / step) + 1 }, (_, k) => k * step);
    const gcrf = (await hpopRun(hpop, { state: truth.state, from: at(0), epochs: seconds.map(at), names: truth.names, values: truth.values })).map((r) => r.state);
    const itrf = await toItrf(frames, seconds, gcrf);
    const states = seconds.map((t, k) => sample(t, itrf[k]));
    // Passes above 10 degrees, per station.
    const accessRequest = Object.assign(new ACW.ACWRequestT(), { OPERATION: ACW.acwOperationCode.COMPUTE_ACCESS_WINDOWS, GROUND_STATIONS: stations.map(stationOf), STATES: states,
      EVALUATION_MODE: ACW.acwEvaluationMode.CONTINUOUS, ROOT_TOLERANCE_S: 0.01, TRACE_ID: 'fit_batch v2 campaign' });
    const accessResponse = await access.invoke({ methodId: 'compute_access_windows', inputs: [{ portId: 'request', typeRef: ACW_TYPE, payload: finish(new ACW.ACWT(accessRequest, null), '$ACW') }] });
    if (accessResponse.statusCode !== 0) throw new Error(`access: ${accessResponse.errorMessage}`);
    const windows = ACW.ACW.getRootAsACW(new flatbuffers.ByteBuffer(new Uint8Array(accessResponse.outputs[0].payload))).RESULT().unpack().WINDOWS;
    // Observations.
    const target = Object.assign(new ACW.ACWTargetT(), { TARGET_ID: 'leo', NORAD_CAT_ID: 99001, OBJECT_ID: '2026-999A', STATES: states,
      SIGNATURE: Object.assign(new ACW.ACWTargetSignatureT(), { RCS_M2: 1, DIAMETER_M: 1, GEOMETRIC_ALBEDO: 0.2, EMITTER_FREQUENCY_HZ: emitterHz, EMITTER_EIRP_DBW: 30 }) });
    const sensorOf = (s) => Object.assign(new ACW.ACWSensorT(), {
      SENSOR_ID: s.id, HOST_ID: s.station, PHENOMENOLOGY: ACW.acwSensorPhenomenology[s.kind], OBSERVATION_INTERVAL_S: 10,
      RECEIVER_G_OVER_T_DB_PER_K: 20, RECEIVER_BANDWIDTH_HZ: 1e3, DETECTION_THRESHOLD_DB: -300,
      ERROR_MODELS: s.models.map((m) => Object.assign(new ACW.MEMErrorModelT(), { MODEL_ID: `${s.id}-${m.type}`, MEASUREMENT_TYPE: ACW.memMeasurementType[m.type], NOISE_SIGMA: m.sigma, BIAS: m.bias ?? 0, APPLY_LIGHT_TIME: true })),
    });
    const accessOf = (s) => Object.assign(new ACW.ACWSensorAccessT(), { SENSOR_ID: s.id, TARGET_ID: 'leo',
      WINDOWS: windows.filter((w) => w.STATION_ID === s.station).map((w) => Object.assign(new ACW.ACWAccessWindowT(), { START_JULIAN_DATE_TT: w.START_JULIAN_DATE_TT, END_JULIAN_DATE_TT: w.END_JULIAN_DATE_TT })) });
    const simulation = Object.assign(new ACW.ACWRequestT(), { OPERATION: ACW.acwOperationCode.SIMULATE_OBSERVATIONS, RANDOM_SEED: BigInt(seed),
      GROUND_STATIONS: stations.map(stationOf), TARGETS: [target], SENSORS: sensors.map(sensorOf), ACCESS: sensors.map(accessOf), EARTH_ORIENTATION: eopRows() });
    const simulated = await simulator.invoke({ methodId: 'simulate_observations', inputs: [{ portId: 'request', typeRef: ACW_TYPE, payload: finish(new ACW.ACWT(simulation, null), '$ACW') }] });
    if (simulated.statusCode !== 0) throw new Error(`observation-simulator: ${simulated.errorMessage}`);
    const read = (port, mod, code) => simulated.outputs.filter((f) => f.portId === port).map((f) => mod[code][`getRootAs${code}`](new flatbuffers.ByteBuffer(new Uint8Array(f.payload))).unpack());
    const records = { radar: read('radar', RDO, 'RDO'), rf: read('rf', RFO, 'RFO'), windows };
    records.radar.forEach((r, k) => { r.ID = `radar-${k}`; });
    records.rf.forEach((r, k) => { r.ID = `rf-${k}`; });
    edit?.(records);
    // Sensor geometry at each time tag: association's report over a
    // prediction of the truth (GCRF, km; nominal 1 km^2 covariance).
    const lower = []; for (let r = 0; r < 6; r++) for (let c = 0; c <= r; c++) lower.push(r === c ? 1 : 0);
    const block = Object.assign(new OEM.ephemerisDataBlockT(), {
      OBJECT: Object.assign(new OEM.CATT(), { NORAD_CAT_ID: 99001, OBJECT_ID: '2026-999A', OBJECT_NAME: 'LEO' }), CENTER_NAME: 'EARTH',
      REFERENCE_FRAME: Object.assign(new OEM.RFMT(), { REFERENCE_FRAME_type: OEM.RFMUnion.CelestialFrameWrapper, REFERENCE_FRAME: Object.assign(new OEM.CelestialFrameWrapperT(), { frame: OEM.CelestialFrame.GCRF }) }),
      TIME_SYSTEM: OEM.timingStandard.UTC, INTERPOLATION: 'LAGRANGE', INTERPOLATION_DEGREE: 7,
      EPHEMERIS_DATA_LINES: seconds.map((t, k) => Object.assign(new OEM.ephemerisDataLineT(), { EPOCH: isoOf(at(t)), X: gcrf[k][0] / 1e3, Y: gcrf[k][1] / 1e3, Z: gcrf[k][2] / 1e3, X_DOT: gcrf[k][3] / 1e3, Y_DOT: gcrf[k][4] / 1e3, Z_DOT: gcrf[k][5] / 1e3 })),
      COVARIANCE_MATRIX_LINES: seconds.filter((_, k) => k % 10 === 0).map((t) => { const line = Object.assign(new OEM.covarianceMatrixLineT(), { EPOCH: isoOf(at(t)) });
        ['CX_X', 'CY_X', 'CY_Y', 'CZ_X', 'CZ_Y', 'CZ_Z', 'CX_DOT_X', 'CX_DOT_Y', 'CX_DOT_Z', 'CX_DOT_X_DOT', 'CY_DOT_X', 'CY_DOT_Y', 'CY_DOT_Z', 'CY_DOT_X_DOT', 'CY_DOT_Y_DOT', 'CZ_DOT_X', 'CZ_DOT_Y', 'CZ_DOT_Z', 'CZ_DOT_X_DOT', 'CZ_DOT_Y_DOT', 'CZ_DOT_Z_DOT'].forEach((n, i) => { line[n] = lower[i]; });
        return line; }),
    });
    const oem = Object.assign(new OEM.OEMT(), { CREATION_DATE: '2026-08-02T00:00:00Z', ORIGINATOR: 'fit_batch v2 campaign', EPHEMERIS_DATA_BLOCK: [block] });
    const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' });
    const reportResponse = await association.invoke({ methodId: 'associate_observations', inputs: [
      { portId: 'predictions', typeRef: typeRef('OEM'), payload: finish(oem, '$OEM') },
      ...records.radar.map((r) => ({ portId: 'radar_observations', typeRef: typeRef('RDO'), payload: finish(Object.assign(new RDO.RDOT(), r), '$RDO') })),
      ...records.rf.map((r) => ({ portId: 'rf_observations', typeRef: typeRef('RFO'), payload: finish(Object.assign(new RFO.RFOT(), r), '$RFO') })),
      { portId: 'earth_orientation', typeRef: EOP_TYPE, payload: EOP_STREAM },
      { portId: 'options', typeRef: { schemaName: 'application/json' }, payload: Buffer.from(JSON.stringify({ geometry: false, scan: 'observation' })) },
    ] });
    if (reportResponse.statusCode !== 0) throw new Error(`association: ${reportResponse.errorMessage}`);
    const report = JSON.parse(Buffer.from(reportResponse.outputs.find((f) => f.portId === 'report').payload).toString());
    const geometry = new Map(report.observations.map((o) => [o.id, { position: o.sensor_gcrf_km.map((v) => v * 1e3), velocity: o.sensor_velocity_gcrf_km_s.map((v) => v * 1e3) }]));
    return { ...records, geometry, truthAt: (t) => gcrf[Math.round(t / step)] };
  } finally {
    for (const h of [frames, access, simulator, association]) h.destroy?.();
  }
}
