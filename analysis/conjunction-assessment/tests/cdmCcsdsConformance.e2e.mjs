// The CDM the module writes conforms to CCSDS 508.0-B-1, judged by readers that are not the module:
//   the CCSDS NDM/XML 4.0.0 schema (xmllint), a KVN checker built from the standard's tables and the
//   SANA registries, and Orekit 13.1's CdmParser (tests/lib/ccsdsCdmValidator.mjs).
// Run:  node tests/cdmCcsdsConformance.e2e.mjs   (needs dist/ built and the oracles under
// $CCSDS_ORACLE_ROOT, default ~/software/gmat09-authority: jars/, orekit-data/).
//
// Cases: emit_cdm from OEM sources with supplied covariance in TEME (the evaluation frame a CDM may not
// carry: the standard's REF_FRAME is EME2000, GCRF or ITRF); the standard's own examples as positive
// controls and deliberately broken messages as negative controls; the OD-quality fields through a
// KVN -> FlatBuffer -> KVN/XML -> FlatBuffer round trip.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ByteBuffer } from 'flatbuffers';
import { CDM } from 'spacedatastandards.org/lib/js/CDM/CDM.js';
import { CQR } from 'spacedatastandards.org/lib/js/CQR/CQR.js';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpRecord, gpSource, initCqrFlatc, parseFlatcJson, publishedSchema, screeningControls } from './lib/cqr.mjs';
import { syntheticGp } from './lib/syntheticCatalog.mjs';
import { uncertaintyModelFrame } from '../scripts/uncertainty-model.mjs';
import {
  checkKvn, checkProbabilityMethod, checkXmlSchema, flattenXml, orekitParse, orekitTemeStates, parseKvn, xmlMetadataComments,
} from './lib/ccsdsCdmValidator.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ccsds-cdm');
const JD0 = 2461314.5;
const iso = (jd) => new Date((jd - 2440587.5) * 86400000).toISOString();
const RSW = { REFERENCE_FRAME_type: 'OrbitFrameWrapper', REFERENCE_FRAME: { frame: 'RSW_INERTIAL' } };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-e2e-'));

// --- The module's surface ----------------------------------------------------------------
const flatc = await initCqrFlatc();
const cdmJson = (bytes) => parseFlatcJson(flatc.generateJSON(publishedSchema('CDM'), { path: '/cdm.bin', data: bytes }, { defaultsJson: true }));
const cdmBytes = (record) => flatc.generateBinary(publishedSchema('CDM'), JSON.stringify(record), { sizePrefix: false });
// flatc JSON prints doubles to 12 decimal places. Read small covariance/Pc values directly from
// the published generated bindings, preserving their complete IEEE-754 value for comparisons.
const cdmBinary = (bytes) => CDM.getRootAsCDM(new ByteBuffer(bytes));
const cqrBinary = (bytes) => CQR.getRootAsCQR(new ByteBuffer(bytes));
const nativeDocument = (syntax, text) => encodeCqr(flatc, { NATIVE_DOCUMENT: { SERIALIZATION: syntax, CONTENT: Array.from(new TextEncoder().encode(text)) } });
const documentText = (frame) => new TextDecoder().decode(new Uint8Array(decodeCqr(flatc, frame.payload).NATIVE_DOCUMENT.CONTENT));

async function call(h, methodId, inputs) {
  const r = await h.invoke({ methodId, inputs });
  assert.equal(r.statusCode, 0, `${methodId}: ${r.errorCode ?? ''} ${r.errorMessage ?? ''}`);
  return r;
}
const port = (r, id) => r.outputs.find((f) => f.portId === id);
// A shared CDM builder must produce identical records for a pair result and emit_cdm. Only the
// actual message creation time and unique id can differ between two independent emissions.
const withoutMessageIdentity = ({ CREATION_DATE, MESSAGE_ID, ...record }) => record;
function sameEventMessage(event, emitted, label) {
  assert.ok(event.CONJUNCTION_MESSAGE, `${label}: the covariance-bearing event includes its CDM`);
  assert.deepEqual(withoutMessageIdentity(event.CONJUNCTION_MESSAGE), withoutMessageIdentity(cdmJson(emitted)),
    `${label}: event and emit_cdm carry the same CDM except CREATION_DATE and MESSAGE_ID`);
}
/** FlatBuffer $CDM to text: KVN and XML. */
async function writeText(h, fb) {
  return {
    kvn: documentText(port(await call(h, 'write_cdm_kvn', [{ portId: 'cdm', payload: fb }]), 'kvn')),
    xml: documentText(port(await call(h, 'write_cdm_xml', [{ portId: 'cdm', payload: fb }]), 'xml')),
  };
}
/** Text back to a FlatBuffer $CDM. */
async function parseText(h, { kvn, xml }) {
  return {
    kvn: port(await call(h, 'parse_cdm_kvn', [{ portId: 'kvn', payload: nativeDocument('CCSDS_CDM_KVN', kvn) }]), 'cdm').payload,
    xml: port(await call(h, 'parse_cdm_xml', [{ portId: 'xml', payload: nativeDocument('CCSDS_CDM_XML', xml) }]), 'cdm').payload,
  };
}

// --- Source requests ---------------------------------------------------------------------
function track(id, origin, velocity, covarianceFrame) {
  const lines = [];
  for (let t = -300; t <= 300; t += 60) {
    lines.push({ EPOCH: iso(JD0 + t / 86400),
      X: origin[0] + velocity[0] * t, Y: origin[1] + velocity[1] * t, Z: origin[2] + velocity[2] * t,
      X_DOT: velocity[0], Y_DOT: velocity[1], Z_DOT: velocity[2] });
  }
  const covariance = [-300, 300].map((t) => ({ EPOCH: iso(JD0 + t / 86400),
    CX_X: 0.01, CY_Y: 0.09, CZ_Z: 0.01, CX_DOT_X_DOT: 1e-6, CY_DOT_Y_DOT: 1e-6, CZ_DOT_Z_DOT: 1e-6 }));
  return { OBJECT_ID: id, OBJECT_NAME: id, NORAD_CATALOG_ID: id === 'A' ? 90001 : 90002, EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{
    CENTER_NAME: 'EARTH', CENTER_NAIF_ID: 399, TIME_SYSTEM: 'UTC',
    REFERENCE_FRAME: { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'TEMEOFDATE' } },
    COV_REFERENCE_FRAME: covarianceFrame, EPHEMERIS_DATA_LINES: lines, COVARIANCE_MATRIX_LINES: covariance }] } };
}
// Two straight-line OEM tracks 50 m apart at JD0, each with an RTN covariance of 100/300/100 m (1 sigma)
// and 1 mm/s velocity sigmas, evaluated in TEME.
const oemRequest = () => ({ PAIR_REQUEST: {
  PRIMARY: track('A', [7000, 0, 0], [0, 7.5, 0], RSW),
  SECONDARY: track('B', [7000.05, 0, 0], [0, 0, 7.5], RSW),
  CONTROLS: { ...screeningControls({ startJd: JD0 - 200 / 86400, durationSeconds: 400, coarseStepSec: 5 }), ALGORITHM: 'LAAS_2015' },
  PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME') } });

// --- Reading a CDM in either syntax -------------------------------------------------------
const num = (s) => Number(s);
const near = (a, b, rel, absolute = 0) => Math.abs(a - b) <= Math.max(absolute, rel * Math.max(Math.abs(a), Math.abs(b)));
/** KVN as {shared: {KEY: {value, unit}}, objects: [{...}, {...}], metadataComments: [[...], [...]]}. A metadata
 *  COMMENT is the run of COMMENT lines directly before an OBJECT keyword (table 3-3). */
function kvnMaps(text) {
  const out = { shared: {}, objects: [{}, {}], metadataComments: [[], []] };
  let at = -1, pending = [];
  for (const l of parseKvn(text)) {
    if (l.key === 'COMMENT') { pending.push(l.value); continue; }
    if (l.key === 'OBJECT') { at += 1; out.metadataComments[at] = pending; }
    pending = [];
    (at < 0 ? out.shared : out.objects[at])[l.key] = { value: l.value, unit: l.unit };
  }
  return out;
}

/**
 * Every judgement a CDM must pass, whatever produced it: KVN against the standard's tables and the
 * registries, XML against the schema, Orekit reading both, KVN and XML saying the same thing, and
 * both saying what the FlatBuffer says. Returns the parsed forms for case-specific assertions.
 */
async function conforms(name, h, fb) {
  const text = await writeText(h, fb);
  const dir = fs.mkdtempSync(path.join(scratch, `${name}-`));
  const files = { kvn: path.join(dir, 'cdm.kvn'), xml: path.join(dir, 'cdm.xml') };
  fs.writeFileSync(files.kvn, text.kvn);
  fs.writeFileSync(files.xml, text.xml);

  assert.deepEqual(checkKvn(text.kvn), [], `${name}: KVN against CCSDS 508.0-B-1`);
  assert.deepEqual(checkProbabilityMethod(text.kvn), [], `${name}: Pc method against SANA cdm_cpm`);
  assert.deepEqual(checkXmlSchema(files.xml), [], `${name}: XML against the NDM/XML 4.0.0 schema`);
  const orekit = orekitParse([files.kvn, files.xml]);
  for (const f of Object.values(files)) assert.equal(orekit[f].rejected, undefined, `${name}: Orekit rejects ${path.basename(f)}: ${orekit[f].rejected}`);
  assert.deepEqual(orekit[files.kvn].fields, orekit[files.xml].fields, `${name}: Orekit reads the KVN and the XML alike`);

  // KVN and XML carry the same keywords, values and units.
  const kvn = kvnMaps(text.kvn), xml = flattenXml(text.xml);
  const same = (where, a, b) => {
    const keys = (m) => Object.keys(m).filter((k) => k !== 'COMMENT');
    assert.deepEqual(keys(a).sort(), keys(b).sort(), `${name}: ${where}: the same keywords`);
    for (const k of keys(a)) {
      assert.equal(a[k].unit, b[k].unit, `${name}: ${where}: ${k} unit`);
      const [x, y] = [a[k].value, b[k].value];
      assert.ok(x === y || (Number.isFinite(num(x)) && near(num(x), num(y), 1e-9)), `${name}: ${where}: ${k} ${x} vs ${y}`);
    }
  };
  const xmlShared = Object.fromEntries(Object.entries(xml.shared).filter(([k]) => !['cdm', 'header', 'body'].includes(k)));
  same('header and relative data', kvn.shared, xmlShared);
  same('OBJECT1', kvn.objects[0], xml.objects[0]);
  same('OBJECT2', kvn.objects[1], xml.objects[1]);
  assert.deepEqual(xmlMetadataComments(text.xml), kvn.metadataComments, `${name}: KVN and XML carry the same metadata comments`);

  // The FlatBuffer says what the text says.
  const record = cdmJson(fb);
  const sameValue = (what, a, b) => assert.equal(a, b, `${name}: ${what}`);
  sameValue('MESSAGE_ID', record.MESSAGE_ID, kvn.shared.MESSAGE_ID.value);
  sameValue('CREATION_DATE', Date.parse(record.CREATION_DATE), Date.parse(`${kvn.shared.CREATION_DATE.value}Z`));
  assert.ok(near(record.MISS_DISTANCE * 1000, num(kvn.shared.MISS_DISTANCE.value), 1e-9), `${name}: MISS_DISTANCE`);
  const maneuverable = { UNSPECIFIED: 'N/A', YES: 'YES', NO: 'NO', NOT_APPLICABLE: 'N/A' };
  const binaryObjects = [cdmBinary(fb).OBJECT1(), cdmBinary(fb).OBJECT2()];
  [record.OBJECT1, record.OBJECT2].forEach((o, i) => {
    const k = kvn.objects[i];
    sameValue(`OBJECT${i + 1} COVARIANCE_METHOD`, o.COVARIANCE_METHOD, k.COVARIANCE_METHOD.value);
    sameValue(`OBJECT${i + 1} MANEUVERABLE`, maneuverable[o.MANEUVERABLE], k.MANEUVERABLE.value);
    sameValue(`OBJECT${i + 1} CATALOG_NAME`, o.CATALOG_NAME, k.CATALOG_NAME.value);
    sameValue(`OBJECT${i + 1} OBJECT_DESIGNATOR`, o.OBJECT_DESIGNATOR, k.OBJECT_DESIGNATOR.value);
    sameValue(`OBJECT${i + 1} REF_FRAME`, o.REFERENCE_FRAME.NAME, k.REF_FRAME.value);
    assert.equal(o.COVARIANCE.length >= 21, true, `${name}: OBJECT${i + 1} carries the 21-cell covariance`);
    // The FlatBuffer holds km**2, km**2/s, km**2/s**2; the text states metres.
    const keys = ['CR_R', 'CT_R', 'CT_T', 'CN_R', 'CN_T', 'CN_N', 'CRDOT_R', 'CRDOT_T', 'CRDOT_N', 'CRDOT_RDOT', 'CTDOT_R', 'CTDOT_T',
      'CTDOT_N', 'CTDOT_RDOT', 'CTDOT_TDOT', 'CNDOT_R', 'CNDOT_T', 'CNDOT_N', 'CNDOT_RDOT', 'CNDOT_TDOT', 'CNDOT_NDOT'];
    keys.forEach((key, c) => assert.ok(near(binaryObjects[i].COVARIANCE(c) * 1e6, num(k[key].value), 1e-3, 1e-12), `${name}: OBJECT${i + 1} ${key}`));
  });
  return { text, kvn, xml, record, orekit: orekit[files.kvn].fields };
}

// --- Negative controls: the checkers are not rubber stamps -------------------------------------
test('the checkers accept the standard\'s own examples and refuse broken messages', () => {
  const kvn = fs.readFileSync(path.join(FIXTURES, 'standard-3.6.2.kvn'), 'utf8');
  assert.deepEqual(checkKvn(kvn), [], 'the standard\'s KVN example passes');
  assert.deepEqual(checkXmlSchema(path.join(FIXTURES, 'standard-4.4.xml')), [], 'the standard\'s XML example passes the schema');
  const broken = {
    'TEME is not a CDM frame': kvn.replaceAll('= EME2000', '= TEME'),
    'unit label on CRDOT_RDOT': kvn.replace(/(CRDOT_RDOT\s+= \S+) \[m\*\*2\/s\*\*2\]/, '$1 [m**2/s]'),
    'CATALOG_NAME not in SANA': kvn.replaceAll('= SATCAT', '= NORAD'),
    'missing REF_FRAME': kvn.replace(/^REF_FRAME.*\n/gm, ''),
    'CALCULATED spelled otherwise': kvn.replaceAll('= CALCULATED', '= MODELLED'),
    'repeated MESSAGE_ID': kvn.replace('MESSAGE_ID = 201113719185', 'MESSAGE_ID = 201113719185\nMESSAGE_ID = 201113719186'),
  };
  for (const [what, text] of Object.entries(broken)) assert.notDeepEqual(checkKvn(text), [], `refused: ${what}`);
  const xml = path.join(scratch, 'broken.xml');
  fs.writeFileSync(xml, fs.readFileSync(path.join(FIXTURES, 'standard-4.4.xml'), 'utf8').replace('<REF_FRAME>EME2000</REF_FRAME>', '<REF_FRAME>TEME</REF_FRAME>'));
  assert.notDeepEqual(checkXmlSchema(xml), [], 'the schema refuses REF_FRAME TEME');
  const parsed = orekitParse([path.join(FIXTURES, 'standard-3.6.2.kvn')]);
  assert.equal(Object.values(parsed)[0].rejected, undefined, 'Orekit reads the standard\'s example');
});

// --- Source with supplied covariance, evaluated in TEME ---------------------------------------
test('emit_cdm from OEM sources: conformant KVN and XML, the right frame, a real creation time, a unique id', async () => {
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const request = encodeCqr(flatc, oemRequest());
    const assessed = port(await call(h, 'assess_conjunction', [{ portId: 'request', payload: request }]), 'result').payload;
    const event = decodeCqr(flatc, assessed).EVENT_RESULT;
    const before = Date.now();
    const first = port(await call(h, 'emit_cdm', [{ portId: 'request', payload: request }]), 'cdm').payload;
    const second = port(await call(h, 'emit_cdm', [{ portId: 'request', payload: request }]), 'cdm').payload;
    const after = Date.now();
    const { kvn, record, orekit } = await conforms('oem', h, first);
    sameEventMessage(event, first, 'supplied OEM covariance');
    const recomputed = cqrBinary(port(await call(h, 'compute_pc_from_cdm', [{ portId: 'cdm', payload: first }]), 'result').payload).PROBABILITY_RESULT().PROBABILITY();
    const eventPc = cqrBinary(assessed).EVENT_RESULT().PROBABILITY().PROBABILITY();
    assert.ok(near(recomputed, eventPc, 1e-9),
      `OEM Pc survives the CDM frame transform: ${recomputed} vs event ${eventPc}`);

    // Header: a creation time that is now, not the TCA; an id that does not repeat.
    const created = Date.parse(`${kvn.shared.CREATION_DATE.value}Z`);
    assert.ok(created >= before - 1000 && created <= after + 1000, `CREATION_DATE ${kvn.shared.CREATION_DATE.value} is the time of creation`);
    assert.notEqual(created, Date.parse(`${kvn.shared.TCA.value}Z`), 'CREATION_DATE is not the TCA');
    assert.notEqual(kvn.shared.MESSAGE_ID.value, cdmJson(second).MESSAGE_ID, 'two emissions never share a MESSAGE_ID');
    assert.equal(kvn.shared.CCSDS_CDM_VERS.value, '1.0');
    assert.equal(kvn.objects[0].CATALOG_NAME.value, 'SATCAT', 'a NORAD number is catalogued as SATCAT');
    assert.equal(kvn.objects[0].OBJECT_DESIGNATOR.value, '90001');

    // Labels: a source covariance is the source's own; nothing here was a model, and the CDM does not know
    // the manoeuvre capacity.
    for (const o of kvn.objects) {
      assert.equal(o.MANEUVERABLE.value, 'N/A', 'MANEUVERABLE is N/A when the module does not know');
      assert.equal(o.COVARIANCE_METHOD.value, 'CALCULATED', 'a covariance the source computed');
    }
    assert.deepEqual(kvn.metadataComments.map((c) => c.some((x) => /uncalibrated/i.test(x))), [true, true],
      'the calibration label (Uncalibrated) reaches the metadata comment of each object');

    // Frame: TEME is not a CDM frame. The states are the module's own TEME states carried to EME2000 or
    // GCRF; Orekit's TEME transform is the judge, at 200 m and 0.2 m/s (a wrong direction is 40 km).
    for (const o of kvn.objects) assert.match(o.REF_FRAME.value, /^(EME2000|GCRF)$/);
    const temeStates = [event.PRIMARY_STATE, event.SECONDARY_STATE].map((s) => ({
      epoch: s.STATE.EPOCH,
      state: [s.STATE.POSITION.X, s.STATE.POSITION.Y, s.STATE.POSITION.Z, s.STATE.VELOCITY.X, s.STATE.VELOCITY.Y, s.STATE.VELOCITY.Z].map((v, i) => v / 1000),
    }));
    assert.equal(event.PRIMARY_STATE.STATE.COORDINATE_SYSTEM_NAME, 'TEME');
    const oracle = orekitTemeStates(temeStates);
    kvn.objects.forEach((o, i) => {
      const want = oracle[i][o.REF_FRAME.value === 'GCRF' ? 'gcrf' : 'eme2000'];
      const got = ['X', 'Y', 'Z', 'X_DOT', 'Y_DOT', 'Z_DOT'].map((k) => num(o[k].value));
      for (let c = 0; c < 6; ++c) assert.ok(Math.abs(got[c] - want[c]) <= (c < 3 ? 0.2 : 0.0002), `OBJECT${i + 1} ${['X', 'Y', 'Z', 'X_DOT', 'Y_DOT', 'Z_DOT'][c]} ${got[c]} vs Orekit ${want[c]}`);
    });
    // The miss distance is the distance between the two states the message carries.
    const [a, b] = kvn.objects.map((o) => ['X', 'Y', 'Z'].map((k) => num(o[k].value) * 1000));
    assert.ok(Math.abs(Math.hypot(...a.map((x, i) => x - b[i])) - num(kvn.shared.MISS_DISTANCE.value)) < 0.05, 'MISS_DISTANCE is |r2 - r1| of the carried states');
    assert.equal(orekit['OBJECT1.REF_FRAME'], kvn.objects[0].REF_FRAME.value, 'Orekit reads the same frame');

    // The covariance is the source's: 100/300/100 m position sigmas, 1 mm/s velocity sigmas, in m**2.
    const cov = (o, k) => num(o[k].value);
    for (const o of kvn.objects) {
      assert.ok(near(cov(o, 'CR_R'), 1e4, 1e-6) && near(cov(o, 'CT_T'), 9e4, 1e-6) && near(cov(o, 'CN_N'), 1e4, 1e-6), 'position variances in m**2');
      assert.ok(near(cov(o, 'CRDOT_RDOT'), 1, 1e-6) && near(cov(o, 'CTDOT_TDOT'), 1, 1e-6) && near(cov(o, 'CNDOT_NDOT'), 1, 1e-6), 'velocity variances in m**2/s**2');
    }
    assert.equal(record.OBJECT1.COVARIANCE_METHOD, 'CALCULATED');
  } finally {
    await h.destroy?.();
  }
});

// --- OD quality fields ----------------------------------------------------------------------
test('supplied OEM covariance survives segment screening and candidate refinement in GCRF', async () => {
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const pair = oemRequest().PAIR_REQUEST;
    const frame = { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'GCRF' } };
    const sources = [pair.PRIMARY, pair.SECONDARY].map((source, i) => {
      source.EPHEMERIS.EPHEMERIS_DATA_BLOCK[0].REFERENCE_FRAME = frame;
      return { ...source, SOURCE_HANDLE: i + 1 };
    });
    // The same closed-form 50 m crossing fixture, now GCRF. For tau=t/300, the first-order
    // Chebyshev polynomials are y_A=2250*tau and z_B=2250*tau km; velocities are literal7.5 km/s.
    const segments = sources.map((source, i) => ({ SOURCE_HANDLE: source.SOURCE_HANDLE, EPHEMERIS: {
      CENTER_NAME: 'EARTH', REFERENCE_FRAME: frame, TIME_SYSTEM: 'UTC', EPHEMERIS_SOURCE: 'CCSDS-E2E-LINEAR',
      POSITION_RECORDS: [{ EPOCH_MID: iso(JD0), EPOCH_HALF_SPAN: 300, NUM_COEFFICIENTS: 2,
        POS_COEFF_X: [i === 0 ? 7000 : 7000.05, 0], POS_COEFF_Y: [0, i === 0 ? 2250 : 0], POS_COEFF_Z: [0, i === 0 ? 0 : 2250],
        HAS_VELOCITY_COEFFICIENTS: true, VEL_COEFF_X: [0, 0], VEL_COEFF_Y: [i === 0 ? 7.5 : 0, 0], VEL_COEFF_Z: [i === 0 ? 0 : 7.5, 0] }],
    } }));
    const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'ccsds-oem-segments', GENERATION: 1 };
    const prepared = decodeCqr(flatc, port(await call(h, 'prepare_segment_screening_index', [{ portId: 'request', payload: encodeCqr(flatc, { INDEX_REQUEST: {
      INSTANCE, INDEX_CONTENT: 'POLYNOMIAL_SEGMENTS', REFINEMENT_MODE: 'POLYNOMIAL_ONLY', SEGMENT_SET_HANDLE: 1, SOURCES: sources,
      SEGMENTS: { INSTANCE, SEGMENT_SET_HANDLE: 1, SOURCE_OFFSET: 0, FINAL_CHUNK: true, SOURCES: segments },
    } }) }]), 'result').payload).INDEX_RESULT;
    const inputs = [{ portId: 'request', payload: encodeCqr(flatc, { WINDOW_REQUEST: {
      INSTANCE, SCREENING_INDEX_HANDLE: prepared.SCREENING_INDEX_HANDLE, CONTROLS: pair.CONTROLS, EVALUATION_FRAME: earthFrame('GCRF'),
    } }) }];
    for (const method of ['screen_segment_window', 'refine_candidates']) {
      const result = decodeCqr(flatc, port(await call(h, method, inputs), 'result').payload).CATALOG_RESULT;
      assert.equal(result.FINAL_CHUNK, true);
      assert.equal(result.EVENTS.length, 1, `${method}: the single closed-form crossing`);
      const event = result.EVENTS[0];
      assert.ok(event.CONJUNCTION_MESSAGE, `${method}: the supplied covariance reaches a CDM`);
      assert.equal(event.PRIMARY_COVARIANCE_BASIS, 'SOURCE_EPHEMERIS');
      assert.equal(event.CONJUNCTION_MESSAGE.OBJECT1.REFERENCE_FRAME.NAME, 'GCRF');
      assert.equal(event.PRIMARY_STATE.STATE.COORDINATE_SYSTEM_NAME, 'GCRF');
      await conforms(`supplied-${method}`, h, cdmBytes(event.CONJUNCTION_MESSAGE));
    }
  } finally { await h.destroy?.(); }
});

test('ACTUAL_OD_SPAN, OBS_USED and WEIGHTED_RMS survive KVN -> FlatBuffer -> KVN and XML -> FlatBuffer -> XML', async () => {
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const input = fs.readFileSync(path.join(FIXTURES, 'od-quality.kvn'), 'utf8');
    assert.deepEqual(checkKvn(input), [], 'the fixture is itself conformant');
    const fb = port(await call(h, 'parse_cdm_kvn', [{ portId: 'kvn', payload: nativeDocument('CCSDS_CDM_KVN', input) }]), 'cdm').payload;
    const { kvn, xml, text, orekit } = await conforms('od-quality', h, fb);
    const want = [{ ACTUAL_OD_SPAN: 5.5, OBS_USED: 551, WEIGHTED_RMS: 0.9934 }, { ACTUAL_OD_SPAN: 11.25, OBS_USED: 187, WEIGHTED_RMS: 1.2104 }];
    kvn.objects.forEach((o, i) => {
      for (const [k, v] of Object.entries(want[i])) assert.ok(near(num(o[k].value), v, 1e-9), `OBJECT${i + 1} ${k} ${o[k]?.value} vs ${v}`);
      assert.equal(o.ACTUAL_OD_SPAN.unit, 'd');
      assert.equal(xml.objects[i].ACTUAL_OD_SPAN.unit, 'd');
    });
    assert.equal(orekit['OBJECT1.OBS_USED'], '551', 'Orekit reads OBS_USED');
    assert.ok(near(num(orekit['OBJECT1.ACTUAL_OD_SPAN_D']), 5.5 * 86400, 1e-9), 'Orekit reads ACTUAL_OD_SPAN (it reports seconds)');
    assert.ok(near(num(orekit['OBJECT2.WEIGHTED_RMS']), 1.2104, 1e-9), 'Orekit reads WEIGHTED_RMS');
    assert.equal(kvn.shared.COLLISION_PROBABILITY_METHOD.value, 'FOSTER-1992');
    // Nothing the standard's parameters said was lost or changed in the module's text forms.
    assert.equal(kvn.objects[0].COVARIANCE_METHOD.value, 'CALCULATED');
    assert.equal(kvn.objects[0].MANEUVERABLE.value, 'YES');
    assert.equal(kvn.objects[1].MANEUVERABLE.value, 'NO');
    assert.equal(kvn.objects[0].REF_FRAME.value, 'EME2000');
    // Round trip: text -> FlatBuffer -> text is the identity, and KVN and XML parse to the same record.
    const back = await parseText(h, text);
    assert.deepEqual(cdmJson(back.kvn), cdmJson(back.xml), 'KVN and XML parse to one record');
    assert.deepEqual(cdmJson(back.kvn), cdmJson(fb), 'the record survives a text round trip');
    const again = await writeText(h, back.kvn);
    assert.equal(again.kvn, text.kvn, 'KVN round trip is exact');
    assert.equal(again.xml, text.xml, 'XML round trip is exact');
  } finally {
    await h.destroy?.();
  }
});

test('internal CDMs remain available while text refuses missing covariance or catalog identity', async () => {
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const [primary, secondary] = syntheticGp();
    const noCovariance = { PAIR_REQUEST: {
      PRIMARY: gpSource(primary), SECONDARY: gpSource(secondary),
      CONTROLS: { ...screeningControls({ startJd: JD0, durationSeconds: 600, coarseStepSec: 60 }), ALGORITHM: 'ALFANO_MAXIMUM' },
      PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME'),
    } };
    const uncatalogued = oemRequest();
    for (const object of [uncatalogued.PAIR_REQUEST.PRIMARY, uncatalogued.PAIR_REQUEST.SECONDARY]) delete object.NORAD_CATALOG_ID;
    for (const [label, request, code] of [
      ['covariance-free GP', noCovariance, 'cdm-covariance-required'],
      ['uncatalogued OEM with covariance', uncatalogued, 'cdm-object-uncatalogued'],
    ]) {
      const emitted = port(await call(h, 'emit_cdm', [{ portId: 'request', payload: encodeCqr(flatc, request) }]), 'cdm');
      assert.ok(emitted?.payload.byteLength > 0, `${label}: emit_cdm retains the internal FlatBuffer`);
      for (const syntax of ['kvn', 'xml']) {
        const response = await h.invoke({ methodId: `write_cdm_${syntax}`, inputs: [{ portId: 'cdm', payload: emitted.payload }] });
        assert.notEqual(response.statusCode, 0, `${label}: ${syntax} must refuse`);
        assert.equal(response.errorCode, code, `${label}: ${syntax} gives a stable refusal code`);
        assert.equal(response.outputs.length, 0, `${label}: ${syntax} emits no partial message`);
      }
    }
    // A numeric source OBJECT_ID already identifies a SATCAT entry; a redundant NORAD field is
    // unnecessary. This is distinct from inventing a catalog identity for the A/B sources above.
    uncatalogued.PAIR_REQUEST.PRIMARY.OBJECT_ID = '90001';
    uncatalogued.PAIR_REQUEST.SECONDARY.OBJECT_ID = '90002';
    const numeric = port(await call(h, 'emit_cdm', [{ portId: 'request', payload: encodeCqr(flatc, uncatalogued) }]), 'cdm').payload;
    const { kvn } = await conforms('numeric-source-id', h, numeric);
    assert.deepEqual(kvn.objects.map((object) => object.CATALOG_NAME.value), ['SATCAT', 'SATCAT']);
    assert.deepEqual(kvn.objects.map((object) => object.OBJECT_DESIGNATOR.value), ['90001', '90002']);
    // CQR catalog IDs are uint32; the provider's signed internal identity must not truncate them.
    const unsigned = oemRequest();
    unsigned.PAIR_REQUEST.PRIMARY.NORAD_CATALOG_ID = 2147483648;
    unsigned.PAIR_REQUEST.SECONDARY.NORAD_CATALOG_ID = 4294967295;
    const wide = port(await call(h, 'emit_cdm', [{ portId: 'request', payload: encodeCqr(flatc, unsigned) }]), 'cdm').payload;
    const wideText = await conforms('unsigned-catalog-id', h, wide);
    assert.deepEqual(wideText.kvn.objects.map((object) => object.OBJECT_DESIGNATOR.value), ['2147483648', '4294967295']);
  } finally {
    await h.destroy?.();
  }
});

test('optional drag, SRP and thrust covariance rows preserve CCSDS units and complete-row boundaries', async () => {
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const fixture = fs.readFileSync(path.join(FIXTURES, 'od-quality.kvn'), 'utf8');
    const originalBytes = port(await call(h, 'parse_cdm_kvn', [{ portId: 'kvn', payload: nativeDocument('CCSDS_CDM_KVN', fixture) }]), 'cdm').payload;
    const original = cdmJson(originalBytes);
    original.OBJECT1.COVARIANCE = Array.from(cdmBinary(originalBytes).OBJECT1().covarianceArray());
    original.OBJECT2.COVARIANCE = Array.from(cdmBinary(originalBytes).OBJECT2().covarianceArray());
    // Source: CCSDS 508.0-B-1 §3.6.3 OBJECT1, UTC 2010-03-13T22:37:52.618, RTN.
    // Drag/SRP values are the published example; the independent thrust row has zero cross terms
    // and a literal 1e-6 m²/s⁴ variance. Table 3-4 supplies all units. The pinned SDS contract
    // stores cells beyond21 in these SI units; 1e-12 relative allows decimal/binary rounding.
    const extra = [
      ['CDRG_R', -1.862, 'm**3/kg'], ['CDRG_T', 3.530, 'm**3/kg'], ['CDRG_N', -0.3100, 'm**3/kg'],
      ['CDRG_RDOT', -1.214e-4, 'm**3/(kg*s)'], ['CDRG_TDOT', 2.580e-4, 'm**3/(kg*s)'], ['CDRG_NDOT', -6.467e-5, 'm**3/(kg*s)'],
      ['CDRG_DRG', 3.483e-6, 'm**4/kg**2'],
      ['CSRP_R', -149.2, 'm**3/kg'], ['CSRP_T', 204.4, 'm**3/kg'], ['CSRP_N', -23.31, 'm**3/kg'],
      ['CSRP_RDOT', -1.254e-3, 'm**3/(kg*s)'], ['CSRP_TDOT', 2.013e-2, 'm**3/(kg*s)'], ['CSRP_NDOT', -4.700e-3, 'm**3/(kg*s)'],
      ['CSRP_DRG', 2.210e-4, 'm**4/kg**2'], ['CSRP_SRP', 1.593e-2, 'm**4/kg**2'],
      ['CTHR_R', 0, 'm**2/s**2'], ['CTHR_T', 0, 'm**2/s**2'], ['CTHR_N', 0, 'm**2/s**2'],
      ['CTHR_RDOT', 0, 'm**2/s**3'], ['CTHR_TDOT', 0, 'm**2/s**3'], ['CTHR_NDOT', 0, 'm**2/s**3'],
      ['CTHR_DRG', 0, 'm**3/(kg*s**2)'], ['CTHR_SRP', 0, 'm**3/(kg*s**2)'], ['CTHR_THR', 1e-6, 'm**2/s**4'],
    ];
    const record = structuredClone(original);
    record.OBJECT1.COVARIANCE.push(...extra.map(([, value]) => value));
    const written = await writeText(h, cdmBytes(record));
    const files = Object.fromEntries(['kvn', 'xml'].map((syntax) => [syntax, path.join(scratch, `optional-covariance.${syntax}`)]));
    for (const syntax of ['kvn', 'xml']) fs.writeFileSync(files[syntax], written[syntax]);
    // The independent KVN checker covers only the mandatory 21 cells. Keep it unchanged; judge
    // these optional rows by the literal standard table above, the complete XML schema and Orekit.
    assert.deepEqual(checkXmlSchema(files.xml), []);
    for (const parsed of Object.values(orekitParse(Object.values(files)))) assert.equal(parsed.rejected, undefined, parsed.rejected);
    for (const object of [kvnMaps(written.kvn).objects[0], flattenXml(written.xml).objects[0]]) {
      assert.deepEqual(Object.keys(object).filter((key) => /^(CDRG|CSRP|CTHR)_/.test(key)), extra.map(([key]) => key));
      for (const [key, value, unit] of extra) {
        assert.equal(object[key].unit, unit, `${key} standard unit`);
        assert.ok(near(num(object[key].value), value, 1e-12), `${key} dimensional conversion`);
      }
    }
    for (const parsed of Object.values(await parseText(h, written))) {
      const covariance = cdmBinary(parsed).OBJECT1().covarianceArray();
      assert.equal(covariance.length, 45);
      record.OBJECT1.COVARIANCE.forEach((value, index) => assert.ok(near(covariance[index], value, 1e-12), `covariance cell ${index} round trip`));
    }
    record.OBJECT1.COVARIANCE.length = 22;
    for (const syntax of ['kvn', 'xml']) {
      const refused = await h.invoke({ methodId: `write_cdm_${syntax}`, inputs: [{ portId: 'cdm', payload: cdmBytes(record) }] });
      assert.notEqual(refused.statusCode, 0);
      assert.equal(refused.errorCode, 'cdm-covariance-incomplete');
      assert.equal(refused.outputs.length, 0);
    }
  } finally { await h.destroy?.(); }
});

test('emitted probability names are registered or labelled, and existing aliases still compute', async () => {
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    for (const [algorithm, name, legacy, registered] of [
      ['CHAN', 'CHAN-1997', 'CHAN-2008', true], ['ALFANO_2005', 'ALFANO-2005', 'ALFANO_2005', true],
      ['FOSTER', 'FOSTER-1992', 'FOSTER-2D', true], ['PATERA', 'PATERA-LEGACY-POLAR', 'PATERA-2001', false],
      ['ALFRIEND_1999', 'ALFRIEND-1999', 'ALFRIEND_1999', true], ['ALFRIEND_2D', 'ALFRIEND-2D', 'alfriend', false],
      ['LAAS_2015', 'LAAS-2015', 'LAAS_2015', false],
    ]) {
      const request = oemRequest();
      request.PAIR_REQUEST.CONTROLS.ALGORITHM = algorithm;
      const emitted = port(await call(h, 'emit_cdm', [{ portId: 'request', payload: encodeCqr(flatc, request) }]), 'cdm').payload;
      const { record, text, kvn } = await conforms(`method-${algorithm.toLowerCase()}`, h, emitted);
      assert.equal(record.COLLISION_PROBABILITY_METHOD, name);
      assert.equal(kvn.shared.COLLISION_PROBABILITY_METHOD.value, name);
      const relative = text.kvn.split(/^OBJECT\s*=/m)[0];
      assert.equal(/^COMMENT.*unregistered/im.test(relative), !registered, `${name} SANA status`);
      const pc = async (payload) => cqrBinary(port(await call(h, 'compute_pc_from_cdm', [{ portId: 'cdm', payload }]), 'result').payload).PROBABILITY_RESULT().PROBABILITY();
      // Exactly the same CDM geometry/covariance in EME2000 at JD0 UTC: this checks alias dispatch,
      // not a new probability oracle. Identical aliases must return the same dimensionless Pc.
      assert.equal(await pc(cdmBytes(record)), await pc(cdmBytes({ ...record, COLLISION_PROBABILITY_METHOD: legacy })), `${name} legacy alias`);
    }
  } finally { await h.destroy?.(); }
});

// --- Empirical covariance and event delivery -------------------------------------------------
// Invented public element sets, UTC from 2026-10-01T00:00:00, evaluated in TEME by the guest. The
// model's literal RTN lower-triangular covariance uses km and km/s: 100/1000/100 m position sigmas
// and 1 mm/s velocity sigmas. This case checks serialization and provenance exactly; all orbit,
// TCA, probability, covariance and frame computations remain inside C++/WASM.
const empiricalModel = {
  kind: 'gp-error-model',
  regimes: [{ id: 'all', altitudeKm: [0, 1e9], eccentricity: [0, 1] }],
  ageBinsDays: [[0, 7]],
  strata: [{ regimeIndex: 0, ageIndex: 0, covariance: [
    0.01, 0, 1, 0, 0, 0.01, 0, 0, 0, 1e-6, 0, 0, 0, 0, 1e-6, 0, 0, 0, 0, 0, 1e-6,
  ] }],
};
const calibrationReference = 'held-out synthetic reference states';
const calibratedModel = () => uncertaintyModelFrame(empiricalModel, {
  strata: [{ regimeIndex: 0, ageIndex: 0, label: 'CALIBRATED', reference: calibrationReference }],
}, 'CCSDS E2E synthetic model');

async function drainCatalog(h, inputs) {
  const records = [], events = [];
  let invokeMs = 0, payloadBytes = 0, outputFrames = 0, maxFramesPerInvoke = 0;
  for (let chunk = 0; ; ++chunk) {
    assert.ok(chunk < 1000, 'catalog stream reaches its final chunk');
    const started = performance.now();
    const response = await call(h, 'screen_catalog', inputs);
    invokeMs += performance.now() - started;
    maxFramesPerInvoke = Math.max(maxFramesPerInvoke, response.outputs.length);
    outputFrames += response.outputs.length;
    const frame = port(response, 'result');
    assert.ok(frame, 'screen_catalog returns a result frame');
    payloadBytes += frame.payload.byteLength;
    const record = decodeCqr(flatc, frame.payload);
    records.push(record);
    const result = record.CATALOG_RESULT;
    assert.equal(result.EVENT_OFFSET, events.length, 'catalog chunks are contiguous');
    events.push(...(result.EVENTS ?? []));
    if (result.FINAL_CHUNK) {
      assert.equal(events.length, result.CONJUNCTIONS_FOUND, 'all reported events fit the drained output');
      break;
    }
  }
  // Re-encode both forms with the same encoder so alignment/default-field decisions cancel. This
  // measures the actual attachment size, without confusing it with covariance or model overhead.
  let withMessageBytes = 0, withoutMessageBytes = 0;
  for (const record of records) {
    withMessageBytes += encodeCqr(flatc, record).byteLength;
    const without = structuredClone(record);
    for (const event of without.CATALOG_RESULT.EVENTS ?? []) delete event.CONJUNCTION_MESSAGE;
    withoutMessageBytes += encodeCqr(flatc, without).byteLength;
  }
  return { events, invokeMs, payloadBytes, outputFrames, maxFramesPerInvoke,
    chunks: records.length, attachmentBytes: withMessageBytes - withoutMessageBytes };
}

test('synthetic model covariances stay DEFAULT, preserve calibration and arrive as event CDMs', async (t) => {
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const objects = syntheticGp();
    const controls = { ...screeningControls({ startJd: JD0, durationSeconds: 3600, thresholdKm: 5, coarseStepSec: 60 }), ALGORITHM: 'FOSTER' };
    const catalogInputs = [
      { portId: 'request', payload: encodeCqr(flatc, { CATALOG_REQUEST: { CONTROLS: controls, EVALUATION_FRAME: earthFrame('TEME') } }) },
      ...objects.map((g) => ({ portId: 'catalog', payload: flatc.generateBinary(publishedSchema('OMM'), JSON.stringify(gpRecord(g)), { sizePrefix: false }) })),
      { portId: 'uncertainty_model', payload: calibratedModel() },
    ];
    const screened = await drainCatalog(h, catalogInputs);
    const attached = screened.events.filter((e) => e.CONJUNCTION_MESSAGE).length;
    t.diagnostic(`Synthetic catalog: ${objects.length} objects, ${screened.events.length} events, ${attached} event CDMs; ` +
      `${screened.payloadBytes} result bytes, ${screened.attachmentBytes} attachment bytes; ` +
      `WASM invoke time ${screened.invokeMs.toFixed(3)} ms (one complete drain); ` +
      `${screened.chunks} result chunks, ${screened.outputFrames} output frames total, maximum ${screened.maxFramesPerInvoke} frames/invoke; output fully drained.`);
    assert.ok(screened.events.length > 0, 'the wide synthetic screen finds conjunctions');
    const selected = screened.events.reduce((a, b) => a.MISS_DISTANCE_M < b.MISS_DISTANCE_M ? a : b);
    t.diagnostic(`Synthetic pair: SATCAT ${selected.PRIMARY_NORAD_ID} / ${selected.SECONDARY_NORAD_ID}, ` +
      `TCA ${iso(selected.TCA.JULIAN_DATE)}, miss ${selected.MISS_DISTANCE_M.toFixed(3)} m.`);
    for (const event of screened.events) {
      assert.equal(event.PROBABILITY.ALGORITHM, 'FOSTER', 'the synthetic fixture stays within the requested 2D method');
      assert.equal(event.PRIMARY_COVARIANCE_BASIS, 'EMPIRICAL_MODEL');
      assert.equal(event.SECONDARY_COVARIANCE_BASIS, 'EMPIRICAL_MODEL');
    }
    assert.equal(attached, screened.events.length, 'every model-covariance catalog event carries a CDM');
    assert.ok(screened.attachmentBytes > 0, 'the measured payload includes CDM attachments');
    await conforms('model-catalog-event', h, cdmBytes(selected.CONJUNCTION_MESSAGE));

    const primary = objects.find((g) => g.NORAD_CAT_ID === selected.PRIMARY_NORAD_ID);
    const secondary = objects.find((g) => g.NORAD_CAT_ID === selected.SECONDARY_NORAD_ID);
    assert.ok(primary && secondary, 'the selected event names public synthetic catalog objects');
    const sources = [primary, secondary].map((g, i) => ({ ...gpSource(g), SOURCE_HANDLE: i + 1,
      PROVENANCE: { ORIGIN_CLASS: 'OMM_RECORD', SOURCE_ID: `SYNTHETIC-SOURCE-${i + 1}` } }));
    const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'ccsds-model', GENERATION: 1 };
    const prepared = decodeCqr(flatc, port(await call(h, 'prepare_screening_index', [{ portId: 'request', payload: encodeCqr(flatc, {
      INDEX_REQUEST: { INSTANCE, INDEX_CONTENT: 'SOURCE_DESCRIPTIONS', REFINEMENT_MODE: 'EXACT_ONLY', SOURCES: sources },
    }) }]), 'result').payload).INDEX_RESULT;
    const windowInputs = [{ portId: 'request', payload: encodeCqr(flatc, { WINDOW_REQUEST: {
      INSTANCE, SCREENING_INDEX_HANDLE: prepared.SCREENING_INDEX_HANDLE, CONTROLS: controls, EVALUATION_FRAME: earthFrame('TEME'),
    } }) }, { portId: 'uncertainty_model', payload: calibratedModel() }];
    for (const method of ['screen_window', 'refine_candidates']) {
      const result = decodeCqr(flatc, port(await call(h, method, windowInputs), 'result').payload).CATALOG_RESULT;
      assert.equal(result.FINAL_CHUNK, true, `${method}: the two-object fixture fits one chunk`);
      assert.ok(result.EVENTS?.length > 0, `${method}: the synthetic pair is found`);
      for (const event of result.EVENTS) {
        assert.ok(event.CONJUNCTION_MESSAGE, `${method}: every covariance-bearing event carries its CDM`);
        assert.equal(event.PRIMARY_COVARIANCE_BASIS, 'EMPIRICAL_MODEL');
        assert.equal(event.SECONDARY_COVARIANCE_BASIS, 'EMPIRICAL_MODEL');
        assert.equal(event.PROBABILITY.CALIBRATION, 'Calibrated');
        assert.equal(event.PROBABILITY.CALIBRATION_REFERENCE, calibrationReference);
        assert.equal(event.CONJUNCTION_MESSAGE.OBJECT1.EPHEMERIS_NAME, 'SYNTHETIC-SOURCE-1');
        assert.equal(event.CONJUNCTION_MESSAGE.OBJECT2.EPHEMERIS_NAME, 'SYNTHETIC-SOURCE-2');
      }
      await conforms(`model-${method}`, h, cdmBytes(result.EVENTS[0].CONJUNCTION_MESSAGE));
    }
    const request = encodeCqr(flatc, { PAIR_REQUEST: {
      PRIMARY: sources[0], SECONDARY: sources[1], CONTROLS: controls,
      PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME'),
    } });
    for (const [label, modelFrame] of [
      ['Calibrated', calibratedModel()], ['Uncalibrated', uncertaintyModelFrame(empiricalModel)],
    ]) {
      const inputs = [{ portId: 'request', payload: request }, { portId: 'uncertainty_model', payload: modelFrame }];
      const event = decodeCqr(flatc, port(await call(h, 'assess_conjunction', inputs), 'result').payload).EVENT_RESULT;
      const emitted = port(await call(h, 'emit_cdm', inputs), 'cdm').payload;
      const { record, kvn, xml } = await conforms(`model-${label.toLowerCase()}`, h, emitted);
      sameEventMessage(event, emitted, `${label} empirical covariance`);
      assert.equal(event.PRIMARY_STATE.STATE.COORDINATE_SYSTEM_NAME, 'TEME', 'the event preserves its evaluation frame');
      assert.equal(event.PRIMARY_COVARIANCE_BASIS, 'EMPIRICAL_MODEL');
      assert.equal(event.SECONDARY_COVARIANCE_BASIS, 'EMPIRICAL_MODEL');
      assert.equal(event.PROBABILITY.CALIBRATION, label);
      if (label === 'Calibrated') assert.equal(event.PROBABILITY.CALIBRATION_REFERENCE, calibrationReference);
      [record.OBJECT1, record.OBJECT2].forEach((object, i) => {
        assert.equal(object.COVARIANCE_METHOD, 'DEFAULT', `${label}: FlatBuffer model covariance is DEFAULT`);
        assert.equal(kvn.objects[i].COVARIANCE_METHOD.value, 'DEFAULT', `${label}: KVN model covariance is DEFAULT`);
        assert.equal(xml.objects[i].COVARIANCE_METHOD.value, 'DEFAULT', `${label}: XML model covariance is DEFAULT`);
        assert.equal(kvn.objects[i].CATALOG_NAME.value, 'SATCAT');
        assert.equal(kvn.objects[i].OBJECT_DESIGNATOR.value, String(i === 0 ? primary.NORAD_CAT_ID : secondary.NORAD_CAT_ID));
        assert.equal(kvn.objects[i].REF_FRAME.value, 'EME2000');
        const comments = kvn.metadataComments[i].join('\n');
        assert.match(comments, /EMPIRICAL[ _]MODEL/i, `${label}: covariance basis reaches object metadata`);
        assert.match(comments, new RegExp(`\\b${label}\\b`, 'i'), `${label}: calibration reaches object metadata`);
        if (label === 'Calibrated') assert.ok(comments.includes(calibrationReference), 'the calibration reference reaches each object');
      });
    }
  } finally {
    await h.destroy?.();
  }
});

// --- A covariance the guest would have to transform is refused, not guessed -----------------
test('a source covariance in another inertial frame is refused', async () => {
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const request = oemRequest();
    request.PAIR_REQUEST.SECONDARY = track('B', [7000.05, 0, 0], [0, 0, 7.5],
      { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'EME2000' } });
    const r = await h.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload: encodeCqr(flatc, request) }] });
    assert.notEqual(r.statusCode, 0);
    assert.equal(r.errorCode, 'covariance-frame-mismatch');
  } finally {
    await h.destroy?.();
  }
});
