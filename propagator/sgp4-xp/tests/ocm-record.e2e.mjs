#!/usr/bin/env node
// E2E (task modules-sgp4-xp-ocm-fit-20261103): the Space Force module writes and flies $OCM element sets.
// - fit of tests/fixtures/xp-fit-current.oem (a synthetic 48 h SGP4-XP ephemeris and NASA's ISS ephemeris) emits one
//   $OCM per block, equal bit for bit to the $OCM recorded from the 0.2.1 dist (tests/fixtures/xp-fit-current.ocm,
//   tests/fixtures/record.mjs): MEAN_ELEMENTS, FIT_STATISTICS and HELD_OUT_DAYS, OD_DYNAMIC_PARAMETERS, identity;
//   the forces are stock XP (THEORY_FLUX_MODEL, {JXX,1970}, EGM-96, caps 0, no rows); PVN.PRODUCER names the library;
//   assertNoUserDefined on every record.
// - propagate flies the fitted $OCM: over the 721 fitted epochs of block 1 its states differ from the fitted
//   ephemeris by FIT_RMS_KM; an $OCM of theory AP is theory-not-flown:AP, UNSPECIFIED mean-element-theory-unspecified,
//   an unnamed theory theory-not-flown:UNKNOWN, an $OMM on 'ocm' omm-not-flown, a frame on the removed port 'omm'
//   unknown-input-port, rows or WEATHER_SOURCE RECORDS weather-source-not-stock, NRLMSISE-00 atmosphere-not-stock,
//   a gravity cap gravity-terms-not-stock.
// - ingest_omm: the foreign $OMM (tests/fixtures/xp-fit-current.omm, 19 free-form parameters) is user-defined-parameters:19, one parameter
//   user-defined-parameters:1, theory AP theory-not-ingestable:AP; the same $OMM without its list gives an $OCM with
//   the same elements, stock forces and no list, which flies to the fitted $OCM's states bit for bit.
// - The sources: no addParameter, no OBD; the free-form list is named only by the boundary's refusal by count.
// JS only moves bytes and compares numbers the module produced.
//   cd propagator/sgp4-xp && node tests/ocm-record.e2e.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import * as O from 'spacedatastandards.org/lib/js/OCM/main.js';
import * as M from 'spacedatastandards.org/lib/js/OMM/main.js';
import { assertNoUserDefined } from '../../../common/tests/no-user-defined.mjs';
import { loadModule } from './lib/module.mjs';
import { readOem } from './lib/sds.mjs';

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)));
const records = (bytes) => {
  const out = [];
  for (let at = 0; at < bytes.length;) { const n = bytes.readUInt32LE(at); out.push(new Uint8Array(bytes.subarray(at, at + 4 + n))); at += 4 + n; }
  return out;
};
const bb = (bytes) => new flatbuffers.ByteBuffer(new Uint8Array(bytes));
const ocmOf = (bytes) => O.OCM.getSizePrefixedRootAsOCM(bb(bytes)).unpack();
const ommOf = (bytes) => M.OMM.getSizePrefixedRootAsOMM(bb(bytes)).unpack();
const packOcm = (t) => { const b = new flatbuffers.Builder(4096); O.OCM.finishSizePrefixedOCMBuffer(b, t.pack(b)); return b.asUint8Array().slice(); };
const packOmm = (t) => { const b = new flatbuffers.Builder(4096); M.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b)); return b.asUint8Array().slice(); };
const TYPE = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' });
const frame = (portId, code, payload) => ({ portId, typeRef: TYPE(code), payload: Buffer.from(payload) });
const module = await loadModule();
const invoke = (methodId, inputs) => module.refused(methodId, inputs);
const refused = (label, r, code) => check(r.statusCode !== 0 && r.errorCode === code, `${label}: expected ${code}, got ${r.statusCode === 0 ? 'success' : `${r.errorCode} ${r.errorMessage}`}`);
try {
  // ---- fit
  const recorded = records(fixture('xp-fit-current.ocm')).map(ocmOf);
  const fitted = await invoke('fit', [frame('ephemeris', 'OEM', fixture('xp-fit-current.oem'))]);
  check(fitted.statusCode === 0, `fit: ${fitted.errorCode} ${fitted.errorMessage}`);
  const out = fitted.statusCode === 0 ? fitted.outputs : [];
  check(out.length === 2 && out.every((o) => o.portId === 'elements'), `fit outputs: ${out.map((o) => o.portId).join(', ')}`);
  const sets = out.map((o) => new Uint8Array(o.payload));
  let bits = 0;
  sets.forEach((bytes, k) => {
    try { assertNoUserDefined(bytes); } catch (e) { check(false, `fit block ${k + 1}: ${e.message}`); }
    const o = ocmOf(bytes), me = o.MEAN_ELEMENTS, want = recorded[k];
    if (!want) { check(false, `block ${k + 1}: no recorded $OCM`); return; }
    const same = (a, b, what) => { bits += 1; check(Object.is(a, b), `block ${k + 1} ${what}: ${a} against ${b}`); };
    check(me.MEAN_ELEMENT_THEORY === O.meanElementSource.SGP4XP, `block ${k + 1}: theory ${me.MEAN_ELEMENT_THEORY}`);
    for (const key of ['EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BTERM', 'AGOM']) same(me[key], want.MEAN_ELEMENTS[key], key);
    check(me.BSTAR === 0 && me.MEAN_MOTION_DOT === 0 && me.MEAN_MOTION_DDOT === 0, `block ${k + 1}: SGP4 terms written`);
    const pt = o.PERTURBATIONS;
    check(pt.WEATHER_SOURCE === O.pcfWeatherSource.THEORY_FLUX_MODEL && pt.ATMOSPHERIC_MODEL?.MODEL === O.AtmosphericModelFamily.JXX && pt.ATMOSPHERIC_MODEL?.YEAR === 1970 &&
      pt.GRAVITY_MODEL === 'EGM-96' && pt.DENSITY_CORRECTION === O.pcfDensityCorrection.NONE && pt.MAXIMUM_TESSERAL_DEGREE === 0 && pt.MAXIMUM_ZONAL_DEGREE === 0 &&
      pt.SPACE_WEATHER.length === 0 && pt.DENSITY_CORRECTION_NODE_TIMES_MS.length === 0, `block ${k + 1}: forces ${JSON.stringify({ ws: pt.WEATHER_SOURCE, g: pt.GRAVITY_MODEL, atm: pt.ATMOSPHERIC_MODEL })}`);
    check(o.ORB_AVERAGING === 'BROUWER' && o.TRAJ_REF_FRAME?.NAME === 'TEMEOFDATE' && o.CENTER_NAME === 'EARTH' && o.STATE_DATA.length === 0, `block ${k + 1}: averaging, frame, center, states`);
    check(o.METADATA.NORAD_CAT_ID === want.METADATA.NORAD_CAT_ID && o.HEADER.ORIGINATOR === want.HEADER.ORIGINATOR && o.HEADER.CREATION_DATE === want.HEADER.CREATION_DATE, `block ${k + 1}: identity`);
    check(/US Space Force Sgp4Prop 9\.1\.1\.0/.test(o.PROVENANCE?.PRODUCER ?? '') && o.PROVENANCE.PRODUCER === want.PROVENANCE.PRODUCER && o.PROVENANCE.ORIGINATOR === want.PROVENANCE.ORIGINATOR, `block ${k + 1}: PRODUCER ${o.PROVENANCE?.PRODUCER}`);
    const od = o.ORBIT_DETERMINATION, fs_ = od.FIT_STATISTICS, wf = want.ORBIT_DETERMINATION.FIT_STATISTICS;
    check(od.OD_EPOCH === me.EPOCH && od.OD_ESTIMATOR === 1 && od.OD_OBSERVATIONS_USED === fs_.FIT_STATES && od.ACTUAL_OD_SPAN === want.ORBIT_DETERMINATION.ACTUAL_OD_SPAN, `block ${k + 1}: OD block`);
    const dyn = Object.fromEntries(od.OD_DYNAMIC_PARAMETERS.map((x) => [x.NAME, x]));
    same(dyn.DRAG_AREA_OVER_MASS?.VALUE, me.BTERM, 'OD_DYNAMIC_PARAMETERS BTERM');
    same(dyn.SRP_AREA_OVER_MASS?.VALUE, me.AGOM, 'OD_DYNAMIC_PARAMETERS AGOM');
    for (const key of ['FIT_START', 'FIT_STOP', 'FIT_STATES', 'FIT_RMS_KM', 'FIT_MAX_KM', 'FIT_RADIAL_RMS_KM', 'FIT_IN_TRACK_RMS_KM', 'FIT_CROSS_TRACK_RMS_KM', 'ITERATIONS', 'CONVERGED',
      'HELD_OUT_STOP', 'HELD_OUT_STATES', 'HELD_OUT_RMS_KM', 'HELD_OUT_MAX_KM']) same(fs_[key], wf[key], key);
    check(fs_.HELD_OUT_DAYS.length === wf.HELD_OUT_DAYS.length && fs_.HELD_OUT_DAYS.every((d, i) => d.DAY === wf.HELD_OUT_DAYS[i].DAY && d.STATES === wf.HELD_OUT_DAYS[i].STATES && Object.is(d.RMS_KM, wf.HELD_OUT_DAYS[i].RMS_KM)), `block ${k + 1}: held-out days`);
    console.log(`block ${k + 1}: ${me.EPOCH} n ${me.MEAN_MOTION} BTERM ${me.BTERM} AGOM ${me.AGOM}; fit ${fs_.FIT_STATES} states ${fs_.FIT_RMS_KM} km, held out ${fs_.HELD_OUT_STATES} ${fs_.HELD_OUT_RMS_KM} km`);
  });
  console.log(`fit: ${sets.length} $OCM; ${bits} values bit for bit against the recorded $OCM`);

  // ---- propagate the fitted set over block 1's fitted epochs
  const inputBlock = readOem(fixture('xp-fit-current.oem')).EPHEMERIS_DATA_BLOCK[0];
  const fitLines = inputBlock.EPHEMERIS_DATA_LINES.filter((l) => l.EPOCH <= '2024-04-10T12:00:00.000000Z');
  const { OEM, OEMT, ephemerisDataBlockT, ephemerisDataLineT } = await import('spacedatastandards.org/lib/js/OEM/main.js');
  const gridOf = (lines) => {
    const t = new OEMT(); const blk = new ephemerisDataBlockT();
    blk.EPHEMERIS_DATA_LINES = lines.map((l) => Object.assign(new ephemerisDataLineT(), { EPOCH: l.EPOCH }));
    blk.CENTER_NAME = 'EARTH'; t.EPHEMERIS_DATA_BLOCK = [blk];
    const b = new flatbuffers.Builder(1 << 16); OEM.finishSizePrefixedOEMBuffer(b, t.pack(b)); return b.asUint8Array().slice();
  };
  const grid = gridOf(fitLines);
  const flown = sets[0] ? await invoke('propagate', [frame('ocm', 'OCM', sets[0]), frame('grid', 'OEM', grid)]) : { statusCode: -1 };
  check(flown.statusCode === 0, `propagate the fitted $OCM: ${flown.errorCode} ${flown.errorMessage}`);
  const flownLines = flown.statusCode === 0 ? readOem(new Uint8Array(flown.outputs[0].payload)).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES : [];
  if (flownLines.length === fitLines.length && sets[0]) {
    let ss = 0;
    flownLines.forEach((l, i) => { const f = fitLines[i]; ss += (l.X - f.X) ** 2 + (l.Y - f.Y) ** 2 + (l.Z - f.Z) ** 2; });
    const rms = Math.sqrt(ss / fitLines.length), want = ocmOf(sets[0]).ORBIT_DETERMINATION.FIT_STATISTICS.FIT_RMS_KM;
    console.log(`propagate: ${flownLines.length} states, RMS against the fitted ephemeris ${rms} km, FIT_RMS_KM ${want} km`);
    check(Math.abs(rms - want) <= 1e-9 * want, `the flown set's RMS ${rms} km is not FIT_RMS_KM ${want} km`);
  } else check(false, `propagate returned ${flownLines.length} of ${fitLines.length} states`);

  // ---- refusals by name
  if (sets[0]) {
    const variant = (edit) => { const t = ocmOf(sets[0]); edit(t); return packOcm(t); };
    const fly = (bytes) => invoke('propagate', [frame('ocm', 'OCM', bytes)]);
    refused('theory AP', await fly(variant((t) => { t.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY = O.meanElementSource.AP; })), 'theory-not-flown:AP');
    refused('theory UNSPECIFIED', await fly(variant((t) => { t.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY = O.meanElementSource.UNSPECIFIED; })), 'mean-element-theory-unspecified');
    refused('an unnamed theory', await fly(variant((t) => { t.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY = 99; })), 'theory-not-flown:UNKNOWN');
    refused("an $OMM on 'ocm'", await fly(fixture('xp-fit-current.omm').subarray(0, 4 + fixture('xp-fit-current.omm').readUInt32LE(0))), 'omm-not-flown');
    refused("a frame on the removed port 'omm'", await invoke('propagate', [frame('ocm', 'OCM', sets[0]), frame('omm', 'OMM', records(fixture('xp-fit-current.omm'))[0])]), 'unknown-input-port');
    refused('space-weather rows', await fly(variant((t) => { t.PERTURBATIONS.SPACE_WEATHER = [Object.assign(new O.SPWT(), { DATE: '2024-04-09', F107_OBS: 150, F107_OBS_CENTER81: 150, AP_AVG: 10 })]; })), 'weather-source-not-stock');
    refused('WEATHER_SOURCE RECORDS', await fly(variant((t) => { t.PERTURBATIONS.WEATHER_SOURCE = O.pcfWeatherSource.RECORDS; })), 'weather-source-not-stock');
    refused('NRLMSISE-00', await fly(variant((t) => { t.PERTURBATIONS.ATMOSPHERIC_MODEL = new O.ATMT(O.AtmosphericModelFamily.NRLMSIS00E, 2000); })), 'atmosphere-not-stock');
    refused('a tesseral cap', await fly(variant((t) => { t.PERTURBATIONS.MAXIMUM_TESSERAL_DEGREE = 8; })), 'gravity-terms-not-stock');
  }

  // ---- ingest_omm, the $OMM boundary
  const omm1 = records(fixture('xp-fit-current.omm'))[0];
  const ingest = (bytes) => invoke('ingest_omm', [frame('omm', 'OMM', bytes)]);
  refused('the foreign $OMM', await ingest(omm1), 'user-defined-parameters:19');
  const bare = ommOf(omm1); bare.USER_DEFINED_PARAMETERS = [];
  const one = ommOf(omm1); one.USER_DEFINED_PARAMETERS = [new M.OMMUserDefinedParameterT('NAME', 'VALUE')];
  refused('one parameter', await ingest(packOmm(one)), 'user-defined-parameters:1');
  const ap = ommOf(omm1); ap.USER_DEFINED_PARAMETERS = []; ap.MEAN_ELEMENT_THEORY = O.meanElementSource.AP;
  refused('theory AP', await ingest(packOmm(ap)), 'theory-not-ingestable:AP');
  const ingested = await ingest(packOmm(bare));
  check(ingested.statusCode === 0 && ingested.outputs.length === 1 && ingested.outputs[0].portId === 'ocm', `ingest_omm: ${ingested.errorCode} ${ingested.errorMessage}`);
  if (ingested.statusCode === 0 && sets[0]) {
    const bytes = new Uint8Array(ingested.outputs[0].payload);
    try { assertNoUserDefined(bytes); } catch (e) { check(false, `ingest_omm: ${e.message}`); }
    const o = ocmOf(bytes), x = ocmOf(sets[0]).MEAN_ELEMENTS;
    check(['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BTERM', 'AGOM', 'EPOCH'].every((key) => Object.is(o.MEAN_ELEMENTS[key], x[key])), 'the ingested $OCM\'s elements are not the fitted $OCM\'s');
    check(o.PERTURBATIONS.WEATHER_SOURCE === O.pcfWeatherSource.THEORY_FLUX_MODEL && o.PERTURBATIONS.GRAVITY_MODEL === 'EGM-96' && o.METADATA.NORAD_CAT_ID === 25544, 'the ingested $OCM\'s forces or identity');
    const again = await invoke('propagate', [frame('ocm', 'OCM', bytes), frame('grid', 'OEM', grid)]);
    const lines = again.statusCode === 0 ? readOem(new Uint8Array(again.outputs[0].payload)).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES : [];
    check(lines.length === flownLines.length && lines.every((l, i) => ['X', 'Y', 'Z', 'X_DOT', 'Y_DOT', 'Z_DOT'].every((key) => Object.is(l[key], flownLines[i][key]))), 'the ingested $OCM does not fly to the fitted $OCM\'s states');
    console.log(`ingest_omm: one $OCM, ${lines.length} states bit for bit with the fitted set's`);
  }
} finally {
  await module.destroy();
}

// ---- the sources
const src = fileURLToPath(new URL('../src/', import.meta.url));
for (const file of fs.readdirSync(src)) {
  const text = fs.readFileSync(src + file, 'utf8');
  check(!/addParameter|\bOBD\b|\$OBD/.test(text), `src/${file} names addParameter or OBD`);
  const lines = text.split('\n').filter((l) => l.includes('USER_DEFINED_PARAMETERS'));
  check(lines.every((l) => /const size_t listed = o\.USER_DEFINED_PARAMETERS\.size\(\)/.test(l)) && (file === 'sds.hpp' ? lines.length === 1 : lines.length === 0), `src/${file}: USER_DEFINED_PARAMETERS beyond the boundary's refusal by count`);
}

if (failures.length) {
  console.error(`OCM RECORD: FAIL (${failures.length})\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('OCM RECORD: PASS');
