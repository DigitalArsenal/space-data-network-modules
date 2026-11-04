#!/usr/bin/env node
// E2E (modules-rpo-history-typed-20261103): the geometry, relative and inspection $OCM records carry in typed
// fields every value the module wrote before as USER_DEFINED_PARAMETERS, recorded from that build on the same
// runs in tests/fixtures/free-form.json (tests/record-free-form.mjs, tests/fixture-runs.mjs):
//   geometry    COLUMNS            -> RPO_GEOMETRY, one vector per column, equal bytes (SHA-256 of float64)
//               UNITS              -> the OCMRelativeGeometry field comments of the pinned schema
//               SEGMENT            -> TRAJ_BASIS (PROJECTION = PREDICTED, HISTORY = DETERMINED)
//               *_ELEMENT_SET_EPOCH -> SEED_SETS [chaser, target] {NORAD_CAT_ID, EPOCH}
//               CONDITIONAL        -> derived: TRAJ_BASIS PREDICTED, no MANEUVER_DATA after START_TIME
//               HINDCAST_*         -> CVR SAMPLES, TRUTH_EPOCHS, COVERAGE_1/3_SIGMA_AXIS1..3, MEAN_D2_OVER_3, COVERAGE_95
//               ERROR_MODEL        -> CVR MODEL_ID
//   relative    the same SEGMENT, epochs and CONDITIONAL; STATE_DATA and COVARIANCE_DATA bytes unchanged;
//               the bracket owner of MAN_COMMENT -> Maneuver.NORAD_CAT_ID
//   inspection  COLUMNS -> RPO_INSPECTION (LINE_OF_SIGHT, IN_SAR_* as bool); FRAME -> TRAJ_REF_FRAME;
//               SHADOW -> PERTURBATIONS.SHADOW_MODEL; SAR_* inputs -> RADAR; SAMPLES and IN_SAR_SAMPLES -> the
//               vector lengths and counts; the derived radar values recompute from RADAR
// and the parameters the consult drops are named. assertNoUserDefined on every emitted $OCM.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { flatbuffers, OCM, CVR, COSMOS, cosmosRun, inspectionRun } from './fixture-runs.mjs';
import { assertNoUserDefined } from '../../../common/tests/no-user-defined.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/free-form.json'), 'utf8'));
const standards = path.dirname(createRequire(path.join(HERE, '../package.json')).resolve('spacedatastandards.org/package.json'));
const schema = fs.readFileSync(path.join(standards, 'schema/OCM/main.fbs'), 'utf8');

let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
const sha = (values) => crypto.createHash('sha256').update(Buffer.from(Float64Array.from(values).buffer)).digest('hex');
const ocm = (bytes) => OCM.OCM.getSizePrefixedRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();
const cvr = (bytes) => CVR.CVR.getSizePrefixedRootAsCVR(new flatbuffers.ByteBuffer(bytes)).unpack();
const g = (v, p) => String(Number(v.toPrecision(p)));   // printf %.<p>g for the values here
const f4 = (v) => v.toFixed(4);
const B = OCM.ocmTrajectoryBasis;
const BASIS = { PROJECTION: B.PREDICTED, HISTORY: B.DETERMINED };
function noUserDefined(records) {
  try { records.forEach(assertNoUserDefined); return null; } catch (e) { return e.message; }
}

const run = await cosmosRun();
const { radar, shadow } = await inspectionRun();
const want = fixture.cosmos;
const geometry = run.geometry.map(ocm), relative = run.relative.map(ocm), realism = run.realism.map(cvr);

// ── every record ────────────────────────────────────────────────────────────
check('records: 106 geometry, 106 relative, 1 realism, 2 inspection, as recorded',
  geometry.length === want.geometry.length && relative.length === want.relative.length && realism.length === want.realism.length &&
  radar.length === fixture.inspection.radar.length && shadow.length === fixture.inspection.shadow.length,
  { geometry: geometry.length, relative: relative.length, realism: realism.length, inspection: radar.length + shadow.length });
const udError = noUserDefined([...run.geometry, ...run.relative, ...radar, ...shadow]);
check('assertNoUserDefined on every emitted $OCM', udError === null, udError ?? `${run.geometry.length + run.relative.length + radar.length + shadow.length} records`);

// ── geometry ────────────────────────────────────────────────────────────────
const COLUMNS = want.geometry[0].udp.COLUMNS.split(',');
const fieldsOf = (table) => {
  const body = schema.slice(schema.indexOf(`table ${table} {`), schema.indexOf('\n}', schema.indexOf(`table ${table} {`)));
  return [...body.matchAll(/^\s*([A-Z0-9_]+)\s*:/gm)].map((m) => m[1]);
};
check('geometry: the OCMRelativeGeometry vectors are the recorded COLUMNS, in order', JSON.stringify(fieldsOf('OCMRelativeGeometry')) === JSON.stringify(COLUMNS),
  fieldsOf('OCMRelativeGeometry'));
{
  const bad = [];
  geometry.forEach((rec, i) => {
    const w = want.geometry[i], G = rec.RPO_GEOMETRY;
    if (rec.HEADER.MESSAGE_ID !== w.MESSAGE_ID || rec.METADATA.START_TIME !== w.START_TIME || rec.STATE_STEP_SIZE !== w.STATE_STEP_SIZE) bad.push([i, 'header']);
    if (!G || rec.STATE_DATA.length || rec.TRAJ_TYPE_DESCRIPTION) { bad.push([i, 'shape']); return; }
    for (const c of COLUMNS) if (G[c].length !== w.samples || sha(G[c]) !== w.columns[c]) bad.push([i, c]);
  });
  check('geometry: every column of every record equals the recorded column (21 x 106 SHA-256 of float64)', bad.length === 0, bad.slice(0, 5));
}
{
  // UNITS: "km, km/s, deg (PLANE_ANGLE_DEG), rad and dimensionless (relative orbital elements)" -> the field names and comments.
  const comment = (field) => {
    const at = schema.indexOf(`  ${field}: [double];`, schema.indexOf('table OCMRelativeGeometry {'));
    return schema.slice(schema.lastIndexOf(';', at) + 1, at);
  };
  const units = { DA: 'dimensionless', DLAMBDA: 'rad', DEX: 'dimensionless', DEY: 'dimensionless', DIX: 'rad', DIY: 'rad' };
  const named = COLUMNS.filter((c) => !(c in units));
  check('geometry: UNITS in the typed homes: km, km/s, deg in the names, rad and dimensionless in the comments',
    want.geometry.at(-1).udp.UNITS === 'km, km/s, deg (PLANE_ANGLE_DEG), rad and dimensionless (relative orbital elements)' &&
    named.every((c) => /_(KM|KM_S|DEG)$/.test(c)) && Object.entries(units).every(([c, u]) => comment(c).includes(u)),
    Object.fromEntries(Object.keys(units).map((c) => [c, comment(c).trim().replace(/\s+/g, ' ').slice(-60)])));
}
function segmentChecks(kind, records, wanted) {
  const bad = [];
  records.forEach((rec, i) => {
    const u = wanted[i].udp, seeds = rec.SEED_SETS;
    if (rec.TRAJ_BASIS !== BASIS[u.SEGMENT]) bad.push([i, 'TRAJ_BASIS', u.SEGMENT, rec.TRAJ_BASIS]);
    if (seeds.length !== 2 || seeds[0].NORAD_CAT_ID !== COSMOS.chaser || seeds[0].EPOCH !== u.CHASER_ELEMENT_SET_EPOCH ||
      seeds[1].NORAD_CAT_ID !== COSMOS.target || seeds[1].EPOCH !== u.TARGET_ELEMENT_SET_EPOCH) bad.push([i, 'SEED_SETS']);
    const conditional = rec.TRAJ_BASIS === B.PREDICTED &&
      !(relative[i].MANEUVER_DATA ?? []).some((m) => Date.parse(m.MAN_EPOCH_START) > Date.parse(rec.METADATA.START_TIME));
    if (conditional !== ('CONDITIONAL' in u) || (conditional && u.CONDITIONAL !== `no maneuvers after ${rec.METADATA.START_TIME}`)) bad.push([i, 'CONDITIONAL']);
  });
  const projections = records.filter((r) => r.TRAJ_BASIS === B.PREDICTED).length;
  check(`${kind}: SEGMENT is TRAJ_BASIS, the element-set epochs SEED_SETS, CONDITIONAL derived (TRAJ_BASIS PREDICTED, no bracket after START_TIME)`,
    bad.length === 0 && projections === 1, { projections, history: records.length - projections, bad: bad.slice(0, 5) });
}
segmentChecks('geometry', geometry, want.geometry);

// ── relative ────────────────────────────────────────────────────────────────
segmentChecks('relative', relative, want.relative);
{
  const bad = [];
  relative.forEach((rec, i) => {
    const w = want.relative[i];
    if (rec.HEADER.MESSAGE_ID !== w.MESSAGE_ID || sha(rec.STATE_DATA) !== w.stateData) bad.push([i, 'STATE_DATA']);
    if ((w.covarianceData === null) !== (rec.COVARIANCE_DATA.length === 0) || (w.covarianceData && sha(rec.COVARIANCE_DATA) !== w.covarianceData)) bad.push([i, 'COVARIANCE_DATA']);
  });
  check('relative: STATE_DATA and COVARIANCE_DATA bytes unchanged (106 trajectories, 1 covariance)', bad.length === 0 && relative.filter((r) => r.COVARIANCE_DATA.length).length === 1,
    bad.slice(0, 5));
}
{
  const got = relative.flatMap((r) => r.MANEUVER_DATA ?? []), wanted = want.relative.flatMap((r) => r.maneuvers);
  const owner = (m) => Number(/^(?:chaser|target) NORAD:(\d+):/.exec(m.MAN_COMMENT.join(' '))?.[1]);
  const ok = got.length === wanted.length && got.every((m, k) => m.MAN_ID === wanted[k].MAN_ID && m.MAN_EPOCH_START === wanted[k].MAN_EPOCH_START &&
    m.MAN_DURATION === wanted[k].MAN_DURATION && m.NORAD_CAT_ID === owner(wanted[k]) && m.NORAD_CAT_ID > 0);
  check('relative: every bracket names its object in Maneuver.NORAD_CAT_ID (the number MAN_COMMENT gave)', ok,
    got.map((m) => [m.MAN_ID, m.NORAD_CAT_ID]));
}

// ── run summary and hindcast ────────────────────────────────────────────────
{
  const s = want.geometry.at(-1).udp, onRecord = relative.at(-1).COV_REALISM[0], c = realism[0];
  const f1 = s.HINDCAST_INSIDE_1SIGMA_RIC.split(','), f3 = s.HINDCAST_INSIDE_3SIGMA_RIC.split(',');
  const typed = (x) => ({ SAMPLES: x.SAMPLES, TRUTH_EPOCHS: x.TRUTH_EPOCHS, MEAN_D2_OVER_3: f4(x.MEAN_D2_OVER_3), COVERAGE_95: f4(x.COVERAGE_95),
    IN1: [x.COVERAGE_1_SIGMA_AXIS1, x.COVERAGE_1_SIGMA_AXIS2, x.COVERAGE_1_SIGMA_AXIS3].map(f4),
    IN3: [x.COVERAGE_3_SIGMA_AXIS1, x.COVERAGE_3_SIGMA_AXIS2, x.COVERAGE_3_SIGMA_AXIS3].map(f4) });
  const recorded = { SAMPLES: Number(s.HINDCAST_SAMPLES), TRUTH_EPOCHS: Number(s.HINDCAST_TRUTH_EPOCHS), MEAN_D2_OVER_3: s.HINDCAST_MEAN_D2_OVER_3,
    COVERAGE_95: s.HINDCAST_COVERAGE_95, IN1: f1, IN3: f3 };
  check('hindcast: HINDCAST_* equal the CVR fields of the projection record and of the $CVR output',
    JSON.stringify(typed(onRecord)) === JSON.stringify(recorded) && JSON.stringify(typed(c)) === JSON.stringify(recorded), { recorded, typed: typed(c) });
  check('hindcast: ERROR_MODEL is CVR MODEL_ID', s.ERROR_MODEL.startsWith(`${c.MODEL_ID} (`) && onRecord.MODEL_ID === c.MODEL_ID, c.MODEL_ID);
  const w = want.realism[0];
  const same = ['RULE', 'MODEL_ID', 'REGIME', 'HORIZON_DAYS', 'MEASURED_LINEAGE', 'TEST_WINDOW', 'MEAN_D2_OVER_3', 'COVERAGE_95', 'SAMPLES', 'OBJECTS', 'CALIBRATION']
    .filter((k) => c[k] !== w[k]);
  check('hindcast: CVR EVIDENCE is the identifier COV_CALIBRATION_REFERENCE names; every other CVR field as recorded',
    c.EVIDENCE === relative.at(-1).COV_CALIBRATION_REFERENCE && onRecord.EVIDENCE === c.EVIDENCE && same.length === 0, { EVIDENCE: c.EVIDENCE, differ: same });
  const dropped = ['FRAME', 'GRID_SAMPLES', 'SAMPLES_IN_BRACKETS', 'SAMPLES_WITHOUT_SET', 'SAMPLES_UNSUPPORTED', 'ELEMENT_SETS', 'MANEUVER_BRACKETS', 'PROJECTION',
    'CALIBRATION_AT_STOP', 'RELATIVE_SAMPLES', 'HINDCAST_FACTORS_NOT_FITTED'];
  const typedKeys = ['COLUMNS', 'UNITS', 'SEGMENT', 'CHASER_ELEMENT_SET_EPOCH', 'TARGET_ELEMENT_SET_EPOCH', 'CONDITIONAL', 'ERROR_MODEL', 'HINDCAST_SAMPLES',
    'HINDCAST_TRUTH_EPOCHS', 'HINDCAST_INSIDE_1SIGMA_RIC', 'HINDCAST_INSIDE_3SIGMA_RIC', 'HINDCAST_MEAN_D2_OVER_3', 'HINDCAST_COVERAGE_95'];
  const definitions = ['CURVILINEAR', 'RELATIVE_ORBITAL_ELEMENTS', 'BANDS', 'VELOCITY'];
  const recordedKeys = new Set([...want.geometry, ...want.relative].flatMap((r) => Object.keys(r.udp)));
  const unplaced = [...recordedKeys].filter((k) => ![...dropped, ...typedKeys, ...definitions].includes(k));
  check('dropped (consult 2.1): run accounting, FRAME and the definition texts; no recorded key unaccounted for', unplaced.length === 0,
    { dropped, definitions, unplaced });
}

// ── inspection ──────────────────────────────────────────────────────────────
const ICOLUMNS = fixture.inspection.radar[0].udp.COLUMNS.split(',');
const BOOLS = new Set(['LINE_OF_SIGHT', 'IN_SAR_RIGHT', 'IN_SAR_LEFT']);
check('inspection: the OCMInspectionGeometry vectors are the recorded COLUMNS, in order, then RADAR',
  JSON.stringify(fieldsOf('OCMInspectionGeometry')) === JSON.stringify([...ICOLUMNS, 'RADAR']), fieldsOf('OCMInspectionGeometry'));
function inspectionChecks(kind, records, wanted, withRadar) {
  const bad = [];
  records.map(ocm).forEach((rec, i) => {
    const w = wanted[i], G = rec.RPO_INSPECTION;
    if (!G || rec.STATE_DATA.length || rec.TRAJ_TYPE_DESCRIPTION || rec.HEADER.MESSAGE_ID !== w.MESSAGE_ID || rec.METADATA.START_TIME !== w.START_TIME) { bad.push([i, 'shape']); return; }
    for (const c of ICOLUMNS) {
      const v = BOOLS.has(c) ? G[c].map((x) => (x ? 1 : 0)) : G[c];
      const absent = c.startsWith('IN_SAR_') && !withRadar;
      // Without a radar the recorded IN_SAR_* columns were NaN; the typed vectors are empty.
      if (absent ? v.length !== 0 || w.columns[c] !== sha(Array(w.samples).fill(NaN)) : v.length !== w.samples || sha(v) !== w.columns[c]) bad.push([i, c]);
    }
    if (String(G[ICOLUMNS[0]].length) !== w.udp.SAMPLES) bad.push([i, 'SAMPLES']);
    if (rec.TRAJ_REF_FRAME?.NAME !== w.udp.FRAME || rec.TRAJ_REF_FRAME.REFERENCE_FRAME?.frame !== OCM.CelestialFrame[w.udp.FRAME]) bad.push([i, 'FRAME']);
    if (rec.PERTURBATIONS?.SHADOW_MODEL !== w.udp.SHADOW) bad.push([i, 'SHADOW']);
    if (withRadar !== Boolean(G.RADAR)) bad.push([i, 'RADAR presence']);
  });
  check(`inspection (${kind}): every column equals the recorded column, FRAME is TRAJ_REF_FRAME, SHADOW is PERTURBATIONS.SHADOW_MODEL, SAMPLES the vector length`,
    bad.length === 0, { records: records.length, samples: wanted.map((w) => w.samples), bad: bad.slice(0, 5) });
}
inspectionChecks('radar case', radar, fixture.inspection.radar, true);
inspectionChecks('penumbra pass, no radar', shadow, fixture.inspection.shadow, false);
{
  const rec = ocm(radar[0]), R = rec.RPO_INSPECTION.RADAR, u = fixture.inspection.radar[0].udp;
  const typed = { SAR_SOURCE: R.SOURCE, SAR_FREQUENCY_GHZ: g(R.FREQUENCY_GHZ, 6), SAR_ANTENNA_M: `${g(R.ANTENNA_LENGTH_M, 6)} x ${g(R.ANTENNA_HEIGHT_M, 6)}`,
    SAR_INCIDENCE_DEG: `${g(R.INCIDENCE_MIN_DEG, 6)} to ${g(R.INCIDENCE_MAX_DEG, 6)}` };
  check('inspection: SAR_SOURCE, SAR_FREQUENCY_GHZ, SAR_ANTENNA_M, SAR_INCIDENCE_DEG are RADAR\'s six inputs',
    Object.entries(typed).every(([k, v]) => u[k] === v), typed);
  const G = rec.RPO_INSPECTION, count = (v) => v.filter(Boolean).length;
  check('inspection: IN_SAR_SAMPLES is the count of true IN_SAR_RIGHT and IN_SAR_LEFT', u.IN_SAR_SAMPLES === `right ${count(G.IN_SAR_RIGHT)}, left ${count(G.IN_SAR_LEFT)}`,
    u.IN_SAR_SAMPLES);
  // The dropped derived values follow from RADAR (inspect.cpp's definitions; test oracle).
  const lambda = 299792458 / (R.FREQUENCY_GHZ * 1e9), deg = (x) => (x * 180) / Math.PI, RE = 6378.137, r = Number(u.SAR_TARGET_MEAN_RADIUS_KM);
  const look = (inc) => deg(Math.asin((RE / r) * Math.sin((inc * Math.PI) / 180)));
  const derived = { SAR_WAVELENGTH_M: Number(u.SAR_WAVELENGTH_M) / lambda - 1,
    SAR_AZIMUTH_BEAMWIDTH_DEG: Number(u.SAR_AZIMUTH_BEAMWIDTH_DEG) / deg(0.886 * lambda / R.ANTENNA_LENGTH_M) - 1,
    SAR_ELEVATION_BEAMWIDTH_DEG: Number(u.SAR_ELEVATION_BEAMWIDTH_DEG) / deg(0.886 * lambda / R.ANTENNA_HEIGHT_M) - 1,
    SAR_LOOK_ANGLE_DEG: Math.max(...u.SAR_LOOK_ANGLE_DEG.split(' to ').map(Number).map((x, k) => Math.abs(x - look(k ? R.INCIDENCE_MAX_DEG : R.INCIDENCE_MIN_DEG)))) };
  check('inspection: dropped SAR_WAVELENGTH_M, beamwidths and look angles recompute from RADAR (1e-12 relative, 1e-6 deg)',
    Math.abs(derived.SAR_WAVELENGTH_M) < 1e-12 && Math.abs(derived.SAR_AZIMUTH_BEAMWIDTH_DEG) < 1e-12 && Math.abs(derived.SAR_ELEVATION_BEAMWIDTH_DEG) < 1e-12 &&
    derived.SAR_LOOK_ANGLE_DEG < 1e-6, derived);
}
{
  const typedKeys = ['COLUMNS', 'FRAME', 'SHADOW', 'SAMPLES', 'SAR_SOURCE', 'SAR_FREQUENCY_GHZ', 'SAR_ANTENNA_M', 'SAR_INCIDENCE_DEG', 'IN_SAR_SAMPLES'];
  const dropped = ['UNITS', 'LINE_OF_SIGHT_MODEL', 'TARGET_FRAME', 'SAR_BEAM_MODEL', 'SAR_WAVELENGTH_M', 'SAR_AZIMUTH_BEAMWIDTH_DEG', 'SAR_ELEVATION_BEAMWIDTH_DEG',
    'SAR_LOOK_ANGLE_DEG', 'SAR_LOOK_ANGLE_AT_MEAN_RADIUS_DEG', 'SAR_TARGET_MEAN_RADIUS_KM'];
  const unplaced = [...new Set([...fixture.inspection.radar, ...fixture.inspection.shadow].flatMap((r) => Object.keys(r.udp)))]
    .filter((k) => ![...typedKeys, ...dropped].includes(k));
  check('inspection dropped (consult 2.1): UNITS, the model definitions and the derived radar values; no recorded key unaccounted for', unplaced.length === 0,
    { dropped, unplaced });
}

console.log(failures ? `TYPED RECORDS E2E FAIL (${failures}/${checks})` : `TYPED RECORDS E2E PASS (${checks}/${checks})`);
process.exit(failures ? 1 : 0);
