// Independent CCSDS 508.0-B-1 (CDM) conformance checks. Nothing here uses the
// module: three separate readers judge what the module wrote.
//   1. The CCSDS NDM/XML 4.0.0 schema (SANA, tests/fixtures/ccsds-cdm/*.xsd) through xmllint.
//   2. A KVN checker built from the standard's tables 3-1 to 3-5 (keywords, order, units,
//      enumerations, obligatory items) and the SANA registries (sana-registries.json).
//   3. Orekit 13.1's CdmParser (OrekitCdmCheck.java) parsing the KVN and the XML.
// Oracles outside the repository: $CCSDS_ORACLE_ROOT (default ~/software/gmat09-authority)
// holds jars/ (orekit, hipparchus) and orekit-data/orekit-data-main.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'ccsds-cdm');
const ORACLE = process.env.CCSDS_ORACLE_ROOT ?? path.join(os.homedir(), 'software', 'gmat09-authority');
export const REGISTRIES = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'sana-registries.json'), 'utf8'));

// --- The standard's tables ---------------------------------------------------------------
// [keyword, unit (null = none), obligatory]
const HEADER = [['CCSDS_CDM_VERS', null, 1], ['COMMENT', null, 0], ['CREATION_DATE', null, 1], ['ORIGINATOR', null, 1],
  ['MESSAGE_FOR', null, 0], ['MESSAGE_ID', null, 1]];
const RELATIVE = [['COMMENT', null, 0], ['TCA', null, 1], ['MISS_DISTANCE', 'm', 1], ['RELATIVE_SPEED', 'm/s', 0],
  ['RELATIVE_POSITION_R', 'm', 0], ['RELATIVE_POSITION_T', 'm', 0], ['RELATIVE_POSITION_N', 'm', 0],
  ['RELATIVE_VELOCITY_R', 'm/s', 0], ['RELATIVE_VELOCITY_T', 'm/s', 0], ['RELATIVE_VELOCITY_N', 'm/s', 0],
  ['START_SCREEN_PERIOD', null, 0], ['STOP_SCREEN_PERIOD', null, 0], ['SCREEN_VOLUME_FRAME', null, 0],
  ['SCREEN_VOLUME_SHAPE', null, 0], ['SCREEN_VOLUME_X', 'm', 0], ['SCREEN_VOLUME_Y', 'm', 0], ['SCREEN_VOLUME_Z', 'm', 0],
  ['SCREEN_ENTRY_TIME', null, 0], ['SCREEN_EXIT_TIME', null, 0], ['COLLISION_PROBABILITY', null, 0],
  ['COLLISION_PROBABILITY_METHOD', null, 0]];
const METADATA = [['COMMENT', null, 0], ['OBJECT', null, 1], ['OBJECT_DESIGNATOR', null, 1], ['CATALOG_NAME', null, 1],
  ['OBJECT_NAME', null, 1], ['INTERNATIONAL_DESIGNATOR', null, 1], ['OBJECT_TYPE', null, 0],
  ['OPERATOR_CONTACT_POSITION', null, 0], ['OPERATOR_ORGANIZATION', null, 0], ['OPERATOR_PHONE', null, 0],
  ['OPERATOR_EMAIL', null, 0], ['EPHEMERIS_NAME', null, 1], ['COVARIANCE_METHOD', null, 1], ['MANEUVERABLE', null, 1],
  ['ORBIT_CENTER', null, 0], ['REF_FRAME', null, 1], ['GRAVITY_MODEL', null, 0], ['ATMOSPHERIC_MODEL', null, 0],
  ['N_BODY_PERTURBATIONS', null, 0], ['SOLAR_RAD_PRESSURE', null, 0], ['EARTH_TIDES', null, 0], ['INTRACK_THRUST', null, 0]];
const OD = [['TIME_LASTOB_START', null, 0], ['TIME_LASTOB_END', null, 0], ['RECOMMENDED_OD_SPAN', 'd', 0],
  ['ACTUAL_OD_SPAN', 'd', 0], ['OBS_AVAILABLE', null, 0], ['OBS_USED', null, 0], ['TRACKS_AVAILABLE', null, 0],
  ['TRACKS_USED', null, 0], ['RESIDUALS_ACCEPTED', '%', 0], ['WEIGHTED_RMS', null, 0]];
const ADDITIONAL = [['AREA_PC', 'm**2', 0], ['AREA_DRG', 'm**2', 0], ['AREA_SRP', 'm**2', 0], ['MASS', 'kg', 0],
  ['CD_AREA_OVER_MASS', 'm**2/kg', 0], ['CR_AREA_OVER_MASS', 'm**2/kg', 0], ['THRUST_ACCELERATION', 'm/s**2', 0],
  ['SEDR', 'W/kg', 0]];
const STATE = [['X', 'km', 1], ['Y', 'km', 1], ['Z', 'km', 1], ['X_DOT', 'km/s', 1], ['Y_DOT', 'km/s', 1], ['Z_DOT', 'km/s', 1]];
// Table 3-4: the 21 obligatory covariance keywords of the 6x6 position/velocity block, with their units.
const COVARIANCE_KEYS = ['CR_R', 'CT_R', 'CT_T', 'CN_R', 'CN_T', 'CN_N', 'CRDOT_R', 'CRDOT_T', 'CRDOT_N', 'CRDOT_RDOT', 'CTDOT_R',
  'CTDOT_T', 'CTDOT_N', 'CTDOT_RDOT', 'CTDOT_TDOT', 'CNDOT_R', 'CNDOT_T', 'CNDOT_N', 'CNDOT_RDOT', 'CNDOT_TDOT', 'CNDOT_NDOT'];
const covarianceUnit = (key) => {
  const [a, b] = key.split('_');
  const velocity = (name) => name.includes('DOT');
  if (velocity(a) && ['RDOT', 'TDOT', 'NDOT'].includes(b)) return 'm**2/s**2';
  return velocity(a) || velocity(b) ? 'm**2/s' : 'm**2';
};
const COVARIANCE_TABLE = COVARIANCE_KEYS.map((k) => [k, covarianceUnit(k), 1]);

const OBJECT_ORDER = [...METADATA, ...OD, ...ADDITIONAL, ...STATE, ...COVARIANCE_TABLE];
const ENUMS = {
  COVARIANCE_METHOD: ['CALCULATED', 'DEFAULT'],
  MANEUVERABLE: ['YES', 'NO', 'N/A'],
  REF_FRAME: ['EME2000', 'GCRF', 'ITRF'],
  OBJECT: ['OBJECT1', 'OBJECT2'],
  SCREEN_VOLUME_FRAME: ['RTN', 'TVN'],
  SCREEN_VOLUME_SHAPE: ['ELLIPSOID', 'BOX'],
};
const NUMERIC = new Set(['MISS_DISTANCE', 'RELATIVE_SPEED', 'RELATIVE_POSITION_R', 'RELATIVE_POSITION_T', 'RELATIVE_POSITION_N',
  'RELATIVE_VELOCITY_R', 'RELATIVE_VELOCITY_T', 'RELATIVE_VELOCITY_N', 'SCREEN_VOLUME_X', 'SCREEN_VOLUME_Y', 'SCREEN_VOLUME_Z',
  'COLLISION_PROBABILITY', 'RECOMMENDED_OD_SPAN', 'ACTUAL_OD_SPAN', 'OBS_AVAILABLE', 'OBS_USED', 'TRACKS_AVAILABLE', 'TRACKS_USED',
  'RESIDUALS_ACCEPTED', 'WEIGHTED_RMS', ...ADDITIONAL.map((r) => r[0]), ...STATE.map((r) => r[0]), ...COVARIANCE_KEYS]);
const EPOCH = /^\d{4}-(\d{2}-\d{2}|\d{3})T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;
const TOKEN_KEYS = new Set(['ORIGINATOR', 'MESSAGE_ID', 'OBJECT_DESIGNATOR', 'CATALOG_NAME', 'INTERNATIONAL_DESIGNATOR']);
const EPOCH_KEYS = new Set(['CREATION_DATE', 'TCA', 'START_SCREEN_PERIOD', 'STOP_SCREEN_PERIOD', 'SCREEN_ENTRY_TIME', 'SCREEN_EXIT_TIME', 'TIME_LASTOB_START', 'TIME_LASTOB_END']);

/** KVN text to {lines: [{key, value, unit}]}. */
export function parseKvn(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^COMMENT(\s|$)/.test(raw)) { lines.push({ key: 'COMMENT', value: raw.replace(/^COMMENT\s*/, ''), unit: null }); continue; }
    const m = /^([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:\[([^\]]*)\])?\s*$/.exec(raw);
    lines.push(m ? { key: m[1], value: m[2], unit: m[3] ?? null } : { key: null, raw });
  }
  return lines;
}

/** Everything wrong with a CDM in KVN, against the standard's tables. */
export function checkKvn(text) {
  const errors = [];
  const lines = parseKvn(text);
  for (const l of lines) if (l.key === null) errors.push(`unparseable line: ${l.raw}`);
  const body = lines.filter((l) => l.key !== null);
  const objectAt = body.map((l, i) => (l.key === 'OBJECT' ? i : -1)).filter((i) => i >= 0);
  if (objectAt.length !== 2) { errors.push(`expected two OBJECT blocks, found ${objectAt.length}`); return errors; }
  const sections = [
    ['header+relative', body.slice(0, objectAt[0]), [...HEADER, ...RELATIVE], ['CCSDS_CDM_VERS', 'CREATION_DATE', 'ORIGINATOR', 'MESSAGE_ID', 'TCA', 'MISS_DISTANCE']],
    ['OBJECT1', body.slice(objectAt[0], objectAt[1]), OBJECT_ORDER, OBJECT_ORDER.filter((r) => r[2]).map((r) => r[0])],
    ['OBJECT2', body.slice(objectAt[1]), OBJECT_ORDER, OBJECT_ORDER.filter((r) => r[2]).map((r) => r[0])],
  ];
  const seenFrames = [];
  for (const [name, section, table, required] of sections) {
    const known = new Map(table.map((r) => [r[0], r]));
    const seen = new Map();
    let lastIndex = -1;
    const order = table.map((r) => r[0]);
    for (const { key, value, unit } of section) {
      const row = known.get(key);
      if (!row) { errors.push(`${name}: keyword ${key} is not in the standard`); continue; }
      if (key !== 'COMMENT') {
        if (seen.has(key)) errors.push(`${name}: ${key} repeated`);
        seen.set(key, value);
        const at = order.indexOf(key);
        if (at < lastIndex) errors.push(`${name}: ${key} is out of order`);
        lastIndex = Math.max(lastIndex, at);
      }
      const want = row[1];
      if (want !== null && unit !== want) errors.push(`${name}: ${key} unit ${unit === null ? '(none)' : `[${unit}]`}, the standard has [${want}]`);
      if (want === null && unit !== null) errors.push(`${name}: ${key} carries unit [${unit}], the standard has none`);
      if (ENUMS[key] && !ENUMS[key].includes(value)) errors.push(`${name}: ${key} = ${value}, allowed ${ENUMS[key].join('|')}`);
      if (EPOCH_KEYS.has(key) && !EPOCH.test(value)) errors.push(`${name}: ${key} = ${value} is not a CCSDS epoch`);
      if (NUMERIC.has(key) && !Number.isFinite(Number(value))) errors.push(`${name}: ${key} = ${value} is not a finite number`);
      if (TOKEN_KEYS.has(key) && !/^[A-Za-z0-9_-]+$/.test(value)) errors.push(`${name}: ${key} = ${value}: 5.2.9 allows alphanumeric text, '_' and '-' only`);
      if (key === 'CATALOG_NAME' && !REGISTRIES.CATALOG_NAME.values.includes(value)) errors.push(`${name}: CATALOG_NAME ${value} is not in the SANA cdm_catalog registry (${REGISTRIES.CATALOG_NAME.values.join(', ')})`);
      if (key === 'REF_FRAME') seenFrames.push(value);
    }
    for (const key of required) if (!seen.has(key)) errors.push(`${name}: obligatory ${key} is missing`);
    if (name === 'header+relative' && seen.has('CCSDS_CDM_VERS') && !/^\d+\.\d+$/.test(seen.get('CCSDS_CDM_VERS'))) errors.push('CCSDS_CDM_VERS is not x.y');
    if (name !== 'header+relative') {
      for (const key of ['CR_R', 'CT_T', 'CN_N', 'CRDOT_RDOT', 'CTDOT_TDOT', 'CNDOT_NDOT'])
        if (seen.has(key) && Number(seen.get(key)) < 0) errors.push(`${name}: ${key} is negative (a variance)`);
    }
  }
  if (new Set(seenFrames).size > 1) errors.push(`REF_FRAME differs between the objects: ${seenFrames.join(', ')}`);
  return errors;
}

/** The method's SANA status: registered, or the relative section says it is not. */
export function checkProbabilityMethod(text) {
  const m = /^COLLISION_PROBABILITY_METHOD\s*=\s*(\S+)/m.exec(text);
  if (!m) return [];
  if (REGISTRIES.COLLISION_PROBABILITY_METHOD.values.includes(m[1])) return [];
  const relative = text.split(/^OBJECT\s*=/m)[0];
  return /^COMMENT.*unregistered/im.test(relative) ? [] : [`COLLISION_PROBABILITY_METHOD ${m[1]} is not in the SANA cdm_cpm registry and the relative section carries no COMMENT saying it is unregistered`];
}

/** Flat key map of a CDM in XML, matching parseKvn: {header: {...}, objects: [{...}, {...}]}. */
export function flattenXml(xml) {
  const out = { shared: {}, objects: [{}, {}] };
  let segment = -1;
  for (const m of xml.matchAll(/<(\/?)(\w+)([^>]*?)(\/?)>([^<]*)/g)) {
    const [, close, tag, attrs, , text] = m;
    if (tag === 'segment') { if (!close) segment += 1; continue; }
    if (close || !text.trim()) continue;
    const unit = /units="([^"]*)"/.exec(attrs)?.[1] ?? null;
    (segment < 0 ? out.shared : out.objects[segment])[tag] = { value: text.trim(), unit };
  }
  return out;
}

/** xmllint against the NDM/XML 4.0.0 schema; the root is <cdm>. Returns the errors. */
export function checkXmlSchema(file) {
  const r = spawnSync('xmllint', ['--noout', '--schema', path.join(FIXTURES, 'ndmxml-4.0.0-master-4.0.xsd'), file], { encoding: 'utf8' });
  return r.status === 0 ? [] : (r.stderr || r.stdout).split('\n').filter((l) => l.trim() && !/validates$/.test(l));
}

let compiled;
function compileOrekit() {
  if (compiled) return compiled;
  const jars = path.join(ORACLE, 'jars');
  if (!fs.existsSync(path.join(jars, 'orekit-13.1.jar'))) throw new Error(`Orekit jar not found under ${jars} (set CCSDS_ORACLE_ROOT)`);
  const data = path.join(ORACLE, 'orekit-data', 'orekit-data-main');
  if (!fs.existsSync(data)) throw new Error(`orekit-data not found at ${data}`);
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'orekit-cdm-'));
  execFileSync('javac', ['-cp', `${jars}/*`, '-d', classes, path.join(FIXTURES, 'OrekitCdmCheck.java'), path.join(FIXTURES, 'OrekitFrameCheck.java')], { stdio: 'inherit' });
  compiled = { classpath: `${classes}:${jars}/*`, data };
  return compiled;
}

/** Orekit's CdmParser over each file: {file: {rejected?: string, fields: {KEY: value}}}. */
export function orekitParse(files) {
  const { classpath, data } = compileOrekit();
  const out = execFileSync('java', ['-cp', classpath, 'OrekitCdmCheck', data, ...files], { encoding: 'utf8' });
  const result = {};
  let current;
  for (const line of out.split('\n')) {
    if (line.startsWith('FILE ')) { current = result[line.slice(5)] = { fields: {} }; continue; }
    if (!current || !line) continue;
    if (line.startsWith('REJECTED ')) { current.rejected = line.slice(9); continue; }
    const at = line.indexOf('=');
    current.fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return result;
}

/**
 * Orekit's TEME to EME2000 and GCRF transforms of states [{epoch: 'UTC ISO', state: [x y z vx vy vz] km, km/s}],
 * the independent answer for a CDM whose evaluation frame was TEME. Returns [{eme2000: [...6], gcrf: [...6]}].
 */
export function orekitTemeStates(states) {
  const { classpath, data } = compileOrekit();
  const input = states.map(({ epoch, state }) => `${epoch.replace(/Z$/, '')} ${state.join(' ')}`).join('\n');
  const out = execFileSync('java', ['-cp', classpath, 'OrekitFrameCheck', data], { encoding: 'utf8', input });
  return out.trim().split('\n').map((line) => {
    const v = line.split(' ').map(Number);
    return { eme2000: v.slice(0, 6), gcrf: v.slice(6, 12) };
  });
}

/** The COMMENT texts of each object's metadata section in XML: [[...], [...]]. */
export function xmlMetadataComments(xml) {
  return [...xml.matchAll(/<metadata>([\s\S]*?)<\/metadata>/g)].map((m) => [...m[1].matchAll(/<COMMENT>([^<]*)<\/COMMENT>/g)].map((c) => c[1].trim()));
}
