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
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, initCqrFlatc, publishedSchema, screeningControls } from './lib/cqr.mjs';
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
const cdmJson = (bytes) => JSON.parse(flatc.generateJSON(publishedSchema('CDM'), { path: '/cdm.bin', data: bytes }, { defaultsJson: true }));
const nativeDocument = (syntax, text) => encodeCqr(flatc, { NATIVE_DOCUMENT: { SERIALIZATION: syntax, CONTENT: Array.from(new TextEncoder().encode(text)) } });
const documentText = (frame) => new TextDecoder().decode(new Uint8Array(decodeCqr(flatc, frame.payload).NATIVE_DOCUMENT.CONTENT));

async function call(h, methodId, inputs) {
  const r = await h.invoke({ methodId, inputs });
  assert.equal(r.statusCode, 0, `${methodId}: ${r.errorCode ?? ''} ${r.errorMessage ?? ''}`);
  return r;
}
const port = (r, id) => r.outputs.find((f) => f.portId === id);
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
    keys.forEach((key, c) => assert.ok(near(o.COVARIANCE[c] * 1e6, num(k[key].value), 1e-3, 1e-12), `${name}: OBJECT${i + 1} ${key}`));
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
    const event = decodeCqr(flatc, port(await call(h, 'assess_conjunction', [{ portId: 'request', payload: request }]), 'result').payload).EVENT_RESULT;
    const before = Date.now();
    const first = port(await call(h, 'emit_cdm', [{ portId: 'request', payload: request }]), 'cdm').payload;
    const second = port(await call(h, 'emit_cdm', [{ portId: 'request', payload: request }]), 'cdm').payload;
    const after = Date.now();
    const { kvn, record, orekit } = await conforms('oem', h, first);

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

// MODEL COVARIANCE (to be added by the implementer): see the task brief. An element-set pair whose
// covariance comes from the empirical model must write COVARIANCE_METHOD DEFAULT in the FlatBuffer, the
// KVN and the XML, never CALCULATED, with the calibration label (Calibrated and its reference, or
// Uncalibrated) in each object's comments; run the same conforms() on it.
