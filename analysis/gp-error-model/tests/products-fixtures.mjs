// Inputs for the tests and the parity run of attach_covariance and attribute_maneuvers: element sets, the states
// analysis/epoch-state derives from them, an operator ephemeris with covariance, a fit's $OCM, a recipe, maneuvers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
export const flatbuffers = require('flatbuffers');
const load = async (code) => import(pathToFileURL(path.join(root, `lib/js/${code}/main.js`)));
export const [OMM, OEM, OCM, MNV] = await Promise.all(['OMM', 'OEM', 'OCM', 'MNV'].map(load));

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
export const wasm = fs.readFileSync(here('../dist/isomorphic/module.wasm'));
export const manifest = JSON.parse(fs.readFileSync(here('../plugin-manifest.json')));
export const epochWasm = fs.readFileSync(here('../../epoch-state/dist/isomorphic/module.wasm'));
export const epochManifest = JSON.parse(fs.readFileSync(here('../../epoch-state/plugin-manifest.json')));
// E14's frozen S3-KC model with the held-out verdict of every cell (scripts/export-recipe-model.mjs).
export const kc = JSON.parse(fs.readFileSync(here('../data/e14-s3-kc.json')));

export const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });
const ref = (schemaName, fileIdentifier, rootTypeName, wireFormat = 'flatbuffer') => ({ schemaName, fileIdentifier, rootTypeName, wireFormat });
export const ommFrame = (portId, payload) => ({ portId, payload, typeRef: ref('OMM.fbs', '$OMM', 'OMM') });
export const oemFrame = (portId, payload) => ({ portId, payload, typeRef: ref('OEM.fbs', '$OEM', 'OEM') });
export const ocmFrame = (portId, payload) => ({ portId, payload, typeRef: ref('OCM.fbs', '$OCM', 'OCM') });
export const mnvFrame = (portId, payload) => ({ portId, payload, typeRef: ref('MNV.fbs', '$MNV', 'MNV') });
export const alignedOem = (portId, payload) => ({ portId, payload, typeRef: { ...ref('OEM.fbs', '$OEM', 'OEM', 'aligned-binary'), requiredAlignment: 8, byteLength: payload.byteLength } });

// ── element sets ──
// Vallado's SGP4-VER sets (analysis/epoch-state/tests): 6251 is 398 km (LEO-L), 28057 is 773 km (LEO-M), 5 is 2254 km
// with e 0.19 (MEO), 14128 is geostationary, 9880 has e 0.71 (HEO, a regime without a model).
export const vallado = JSON.parse(fs.readFileSync(here('../../epoch-state/tests/vallado-verification.json'))).cases;
export const valladoOmm = (satnum) => {
  const c = vallado.find((x) => x.satnum === satnum);
  return { objectId: c.entityId.startsWith('NORAD:') ? '' : c.entityId, norad: c.entityId.startsWith('NORAD:') ? satnum : 0, name: `VALLADO ${satnum}`,
    epoch: c.epochIso.replace('Z', ''), n: c.MEAN_MOTION, e: c.ECCENTRICITY, i: c.INCLINATION, raan: c.RA_OF_ASC_NODE, argp: c.ARG_OF_PERICENTER,
    m: c.MEAN_ANOMALY, bstar: c.BSTAR };
};
// A circular orbit at about 1,000 km (LEO-H, the regime E14 found realistic at 0 and 0.5 days) and one beyond every regime.
export const leoH = { objectId: '2026-101A', norad: 90101, name: 'LEO-H TEST', epoch: '2026-10-01T12:00:00.000000', n: 13.7, e: 0.001, i: 65, raan: 120, argp: 90, m: 10, bstar: 1e-5 };
export const beyond = { objectId: '2026-102A', norad: 90102, name: 'BEYOND TEST', epoch: '2026-10-01T12:00:00.000000', n: 0.6, e: 0.01, i: 5, raan: 10, argp: 20, m: 30, bstar: 0 };

export function encodeOmm(s, overrides = {}) {
  const t = new OMM.OMMT();
  Object.assign(t, { EPOCH: s.epoch, NORAD_CAT_ID: s.norad, OBJECT_ID: s.objectId, OBJECT_NAME: s.name, ORIGINATOR: 'TEST', COMMENT: 'GP_ID 1',
    MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4, MEAN_MOTION: s.n, ECCENTRICITY: s.e, INCLINATION: s.i, RA_OF_ASC_NODE: s.raan,
    ARG_OF_PERICENTER: s.argp, MEAN_ANOMALY: s.m, BSTAR: s.bstar, ...overrides });
  const b = new flatbuffers.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
}

// The states of element sets at their epochs plus `ages` days: analysis/epoch-state derive_omm.
export async function deriveStates(ommStream, ages = [0]) {
  const h = await createBrowserModuleHarness({ wasmSource: epochWasm, manifest: epochManifest, surface: 'direct' });
  try {
    const r = await h.invoke({ methodId: 'derive_omm', inputs: [ommFrame('omm', ommStream), json('options', { ages })] });
    if (r.statusCode !== 0) throw new Error(r.errorMessage);
    const frame = r.outputs.find((f) => f.portId === 'states');
    return frame ? Buffer.from(frame.payload) : Buffer.alloc(0);
  } finally {
    h.destroy();
  }
}

// ── recipe ──
export function recipeFor({ id = 'celestrak-gp', kind = 'element-set', lineage = 'space-track-gp', own = true, pooled = true, licence = 'cite-only', fitClass = '', extra = {} } = {}) {
  return {
    version: 1,
    source: { id, kind, lineage, originator: id === 'celestrak-gp' ? 'CelesTrak' : `${id} originator`, provider: `sdn:${id}`, licence: { class: licence, id: `${id}-terms` }, ...(fitClass ? { fitClass } : {}) },
    producer: 'SDN catalog pipeline',
    created: '2026-10-11T00:00:00Z',
    models: [{ ...kc, sources: own ? [id] : [], pooled }],
    ...extra,
  };
}

// ── operator ephemeris with covariance, and a fit ──
export function operatorOem({ objectId, norad = 0, name = '', frame = 'GCRF', covFrame = 'UVW', rows, cov }) {
  const block = new OEM.ephemerisDataBlockT();
  Object.assign(block, { CENTER_NAME: 'EARTH', TIME_SYSTEM: OEM.timingStandard.UTC, START_TIME: rows[0].epoch, STOP_TIME: rows.at(-1).epoch });
  block.OBJECT = Object.assign(new OEM.CATT(), { OBJECT_ID: objectId, NORAD_CAT_ID: norad, OBJECT_NAME: name });
  block.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: frame });
  if (covFrame) block.COV_REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: covFrame });
  block.EPHEMERIS_DATA_LINES = rows.map((row) => {
    const l = new OEM.ephemerisDataLineT();
    l.EPOCH = row.epoch;
    [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = row.x;
    return l;
  });
  const names = ['CX_X', 'CY_X', 'CY_Y', 'CZ_X', 'CZ_Y', 'CZ_Z', 'CX_DOT_X', 'CX_DOT_Y', 'CX_DOT_Z', 'CX_DOT_X_DOT', 'CY_DOT_X', 'CY_DOT_Y', 'CY_DOT_Z',
    'CY_DOT_X_DOT', 'CY_DOT_Y_DOT', 'CZ_DOT_X', 'CZ_DOT_Y', 'CZ_DOT_Z', 'CZ_DOT_X_DOT', 'CZ_DOT_Y_DOT', 'CZ_DOT_Z_DOT'];
  block.COVARIANCE_MATRIX_LINES = (cov ?? []).map((c) => {
    const l = new OEM.covarianceMatrixLineT();
    l.EPOCH = c.epoch;
    names.forEach((n, k) => { l[n] = c.lower[k]; });
    return l;
  });
  const b = new flatbuffers.Builder(4096);
  OEM.OEM.finishSizePrefixedOEMBuffer(b, Object.assign(new OEM.OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }).pack(b));
  return Buffer.from(b.asUint8Array());
}

// What analysis/od emits for a fit: one state in TEME with its formal covariance, the object named by CATALOG_NAME.
export function fitOcm({ norad, name, epoch, x, lower }) {
  const t = new OCM.OCMT();
  t.HEADER = Object.assign(new OCM.HeaderT(), { CCSDS_OCM_VERS: '3.0', ORIGINATOR: 'SDN-OD' });
  t.METADATA = Object.assign(new OCM.MetadataT(), { OBJECT_NAME: name, CATALOG_NAME: String(norad), TIME_SYSTEM: 'UTC', START_TIME: epoch, STOP_TIME: epoch });
  t.TRAJ_TYPE = OCM.trajectoryType.CARTESIAN_PV;
  t.STATE_VECTOR_SIZE = 6;
  t.STATE_DATA = x;
  t.COVARIANCE_DATA = lower;
  t.USER_DEFINED_PARAMETERS = [Object.assign(new OCM.UserDefinedParametersT(), { PARAM_NAME: 'STATE_REFERENCE_FRAME', PARAM_VALUE: 'TEME' })];
  const b = new flatbuffers.Builder(1024);
  OCM.OCM.finishSizePrefixedOCMBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
}

// A size-prefixed $MNV, or (plain) one FlatBuffer as analysis/maneuver-detection frames each of its events.
export function encodeMnv(fields = {}, { plain = false } = {}) {
  const t = new MNV.MNVT();
  Object.assign(t, { ID: 'M1', SAT_NO: 25544, STATUS: MNV.maneuverStatus.DETECTED, EVENT_START_TIME: '2026-10-01T12:00:00.000Z', DELTA_VEL: 0.002, ALGORITHM: 'D1', TAGS: ['existing'], ...fields });
  const b = new flatbuffers.Builder(512);
  if (plain) MNV.MNV.finishMNVBuffer(b, t.pack(b));
  else MNV.MNV.finishSizePrefixedMNVBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
}

// ── reading records back ──
export function records(bytes) {
  const out = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length;) {
    const size = view.getUint32(at, true);
    if (size === 0) { at += 4; continue; }
    out.push(bytes.subarray(at, at + 4 + size));
    at += 4 + size;
  }
  return out;
}
export const unpackOcm = (b) => OCM.OCM.getSizePrefixedRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(b))).unpack();
export const unpackOmm = (b) => OMM.OMM.getSizePrefixedRootAsOMM(new flatbuffers.ByteBuffer(new Uint8Array(b))).unpack();
export const unpackMnv = (b) => MNV.MNV.getSizePrefixedRootAsMNV(new flatbuffers.ByteBuffer(new Uint8Array(b))).unpack();

// What a record's PROVENANCE (PVN) holds for a recipe's source, derived from the recipe: SOURCE_KIND and LICENSE_CLASS by the
// names the registry gives them, the rest as the recipe states them. PRODUCER is the software that made the record.
const PVN_KINDS = { 'element-set': OMM.pvnSourceKind.ElementSet, ephemeris: OMM.pvnSourceKind.Ephemeris, observation: OMM.pvnSourceKind.Observation };
export const PVN_LICENCES = { reproducible: OMM.pvnLicenseClass.Reproducible, 'cite-only': OMM.pvnLicenseClass.CiteOnly, 'share-alike': OMM.pvnLicenseClass.ShareAlike,
  'non-commercial': OMM.pvnLicenseClass.NonCommercial };
export const expectedProvenance = (recipe, producer = recipe.producer) => ({
  SOURCE_ID: recipe.source.id, SOURCE_KIND: PVN_KINDS[recipe.source.kind], ORIGINATOR: recipe.source.originator, PROVIDER_ID: recipe.source.provider, PRODUCER: producer,
  LICENSE_CLASS: PVN_LICENCES[recipe.source.licence.class], LICENSE_ID: recipe.source.licence.id ?? null, LINEAGE: recipe.source.lineage ?? recipe.source.id,
});
const PVN_FIELDS = ['SOURCE_ID', 'SOURCE_KIND', 'ORIGINATOR', 'PROVIDER_ID', 'PRODUCER', 'LICENSE_CLASS', 'LICENSE_ID', 'LINEAGE'];
export const provenanceOf = (record) => (record.PROVENANCE ? Object.fromEntries(PVN_FIELDS.map((f) => [f, record.PROVENANCE[f]])) : null);
// A record names its source in PROVENANCE and carries no label of it in USER_DEFINED_PARAMETERS or TAGS.
export function assertSourceNamed(record, recipe, producer) {
  assert.deepEqual(provenanceOf(record), expectedProvenance(recipe, producer));
  assert.deepEqual(record.USER_DEFINED_PARAMETERS ?? [], []);
  assert.deepEqual((record.TAGS ?? []).filter((t) => /^(originator|source|provider|licence|licence-id|lineage|producer):/.test(t)), []);
}

export async function call(methodId, inputs) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  try {
    const r = await h.invoke({ methodId, inputs });
    return r;
  } finally {
    h.destroy();
  }
}
export function output(response, portId) {
  const frames = response.outputs.filter((f) => f.portId === portId);
  return frames.length ? Buffer.concat(frames.map((f) => Buffer.from(f.payload))) : Buffer.alloc(0);
}
export const reportOf = (response) => JSON.parse(output(response, 'report').toString());

// What the module must give, computed here from the model file: the covariance of regime `regime` at `age` days, linear
// in age between bin centres and held at the first and last (km, km/s; lower triangle of the 6x6, RTN).
export function expectedCovariance(regime, age) {
  const strata = kc.strata.filter((s) => s.regime === regime).sort((a, b) => a.ageIndex - b.ageIndex);
  const centre = (s) => 0.5 * (kc.ageBinsDays[s.ageIndex][0] + kc.ageBinsDays[s.ageIndex][1]);
  if (age <= centre(strata[0])) return strata[0].covariance;
  if (age >= centre(strata.at(-1))) return strata.at(-1).covariance;
  for (let k = 0; k + 1 < strata.length; k++) {
    if (age >= centre(strata[k]) && age <= centre(strata[k + 1])) {
      const f = (age - centre(strata[k])) / (centre(strata[k + 1]) - centre(strata[k]));
      return strata[k].covariance.map((x, i) => (1 - f) * x + f * strata[k + 1].covariance[i]);
    }
  }
  throw new Error('age outside the model');
}
export const cellOf = (regime, ageIndex) => kc.cells.find((c) => c.regime === regime && c.ageIndex === ageIndex);
