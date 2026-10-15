// Inputs for the integrator's tests and its parity run: a composed catalog, each source's products ($OMM, $OCM, $MNV)
// naming their source as analysis/gp-error-model writes them, and the recipe. Records are built with the object API of
// the pinned spacedatastandards.org package, so they are the bytes any producer of the standard would write.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { integrateRecipe, recipeFrame, decodeXmt } from './xmt-recipes.mjs';

const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
export const flatbuffers = require('flatbuffers');
const load = async (code) => import(pathToFileURL(path.join(root, `lib/js/${code}/main.js`)));
export const [OMM, OCM, MNV, CAT] = await Promise.all(['OMM', 'OCM', 'MNV', 'CAT'].map(load));

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
export const wasm = fs.readFileSync(here('../dist/isomorphic/module.wasm'));
export const manifest = JSON.parse(fs.readFileSync(here('../plugin-manifest.json')));

export const DAY = 86400;
export const ASOF = Date.UTC(2026, 9, 10) / 1000;
// An instant `days` before asOf, as an OMM writes its epoch (no zone) and as an OCM writes a state epoch.
const iso = (seconds) => new Date(seconds * 1000).toISOString();
export const ommEpoch = (daysBefore) => iso(ASOF - daysBefore * DAY).replace('Z', '');
export const ocmEpoch = (daysBefore) => iso(ASOF - daysBefore * DAY);
// The same instant as the integrator's report writes it: Unix milliseconds.
export const reportEpoch = (daysBefore) => BigInt(Math.round((ASOF - daysBefore * DAY) * 1000));

const finish = (finisher, build, size = 1024) => {
  const b = new flatbuffers.Builder(size);
  finisher(b, build(b));
  return Buffer.from(b.asUint8Array());
};

export function catRecord({ norad = 0, cospar = '', name = '', maneuverable = false } = {}) {
  const t = Object.assign(new CAT.CATT(), { OBJECT_NAME: name, OBJECT_ID: cospar, NORAD_CAT_ID: norad, MANEUVERABLE: maneuverable });
  return finish((b, o) => CAT.CAT.finishSizePrefixedCATBuffer(b, o), (b) => t.pack(b));
}

// The realism gp-error-model gives a product's covariance (COV_REALISM): rule 3 is the source's own model, here E14's cell.
export const labelOf = (regime, extra = {}) => ({ RULE: OMM.covarianceRule.SourceModel, MODEL_ID: 'e14-s3-0e678383cfbd', REGIME: regime,
  CALIBRATION: OMM.covarianceCalibration.Uncalibrated, MEAN_D2_OVER_3: 35.6, COVERAGE_95: 0.95, SAMPLES: 2355, OBJECTS: 5, ...extra });
const realism = (label) => Object.assign(new OMM.CVRT(), label);
const provenance = (source) => Object.assign(new OMM.PVNT(), { SOURCE_ID: source, ORIGINATOR: source });

export function ommRecord({ source, norad = 0, cospar = '', native = '', name = '', epoch, theory = OMM.meanElementSource.SGP4, label, bstar = 1e-4 }) {
  const t = Object.assign(new OMM.OMMT(), {
    OBJECT_NAME: name, OBJECT_ID: cospar, NORAD_CAT_ID: norad, USER_DEFINED_OBJECT_DESIGNATOR: native, EPOCH: epoch, MEAN_ELEMENT_THEORY: theory,
    MEAN_MOTION: 15.5, ECCENTRICITY: 0.001, INCLINATION: 51.6, RA_OF_ASC_NODE: 10, ARG_OF_PERICENTER: 20, MEAN_ANOMALY: 30, BSTAR: bstar,
    PROVENANCE: source ? provenance(source) : null,
    COV_REALISM: label ? realism(label) : null,
  });
  return finish((b, o) => OMM.OMM.finishSizePrefixedOMMBuffer(b, o), (b) => t.pack(b));
}

// An $OCM as attach_covariance writes it: the state at the set's epoch, the object under CATALOG_NAME NORAD, the source in
// PROVENANCE and the realism of each state's covariance in COV_REALISM.
export function ocmRecord({ source, norad = 0, cospar = '', native = '', epoch, label, calibration = OCM.covarianceCalibration.Uncalibrated }) {
  const meta = Object.assign(new OCM.MetadataT(), {
    OBJECT_NAME: 'TEST', INTERNATIONAL_DESIGNATOR: cospar, CATALOG_NAME: native ? source : 'NORAD', OBJECT_DESIGNATOR: native || (norad ? String(norad) : ''),
    TIME_SYSTEM: 'UTC', EPOCH_TZERO: epoch,
  });
  const t = Object.assign(new OCM.OCMT(), {
    METADATA: meta, STATE_EPOCHS: [epoch], STATE_DATA: [7000, 0, 0, 0, 7.5, 0], COV_CALIBRATION: calibration,
    PROVENANCE: source ? provenance(source) : null,
    COV_REALISM: label ? [realism(label)] : [],
  });
  return finish((b, o) => OCM.OCM.finishSizePrefixedOCMBuffer(b, o), (b) => t.pack(b));
}

export function mnvRecord({ source, id, norad = 0, cospar = '', native = '', at, status = MNV.maneuverStatus.DETECTED, dv = 0, tags = [] }) {
  const t = Object.assign(new MNV.MNVT(), {
    ID: id, SAT_NO: norad, ORIG_OBJECT_ID: cospar, ON_ORBIT: native, STATUS: status, EVENT_START_TIME: at, DELTA_VEL: dv,
    PROVENANCE: source ? provenance(source) : null,
    TAGS: tags,
  });
  return finish((b, o) => MNV.MNV.finishSizePrefixedMNVBuffer(b, o), (b) => t.pack(b));
}

// ── invoking ──
const ref = (schemaName, fileIdentifier, rootTypeName) => ({ schemaName, fileIdentifier, rootTypeName, wireFormat: 'flatbuffer' });
export const frames = {
  recipe: (value) => recipeFrame(integrateRecipe(value)),
  catalog: (payload) => ({ portId: 'catalog', payload, typeRef: ref('CAT.fbs', '$CAT', 'CAT') }),
  ephemerides: (payload) => ({ portId: 'ephemerides', payload, typeRef: ref('OEM.fbs', '$OEM', 'OEM') }),
  omm: (payload) => ({ portId: 'omm_products', payload, typeRef: ref('OMM.fbs', '$OMM', 'OMM') }),
  ocm: (payload) => ({ portId: 'ocm_products', payload, typeRef: ref('OCM.fbs', '$OCM', 'OCM') }),
  mnv: (payload) => ({ portId: 'mnv_products', payload, typeRef: ref('MNV.fbs', '$MNV', 'MNV') }),
};
export const stream = (records) => Buffer.concat(records);

export async function integrate(inputs) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  try {
    const response = await h.invoke({ methodId: 'integrate_catalog', inputs });
    const port = (id) => response.outputs.filter((f) => f.portId === id).map((f) => Buffer.from(f.payload));
    return {
      response,
      statusCode: response.statusCode,
      message: `${response.errorCode ?? ''} ${response.errorMessage ?? ''}`.trim(),
      reportBytes: port('report')[0] ?? null,
      report: port('report').length ? decodeXmt(port('report')[0]).INTEGRATE_REPORT : null,
      catalog: Buffer.concat(port('catalog')),
      omm: Buffer.concat(port('omm')),
      ocm: Buffer.concat(port('ocm')),
      mnv: Buffer.concat(port('mnv')),
    };
  } finally {
    h.destroy();
  }
}

// ── reading ──
export function records(bytes) {
  const out = [];
  for (let at = 0; at < bytes.length;) {
    const size = bytes.readUInt32LE(at);
    out.push(bytes.subarray(at, at + 4 + size));
    at += 4 + size;
  }
  return out;
}
export const unpackOmm = (record) => OMM.OMM.getSizePrefixedRootAsOMM(new flatbuffers.ByteBuffer(new Uint8Array(record))).unpack();
export const unpackMnv = (record) => MNV.MNV.getSizePrefixedRootAsMNV(new flatbuffers.ByteBuffer(new Uint8Array(record))).unpack();
export const unpackCat = (record) => CAT.CAT.getSizePrefixedRootAsCAT(new flatbuffers.ByteBuffer(new Uint8Array(record))).unpack();
export const unpackOcm = (record) => OCM.OCM.getSizePrefixedRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(record))).unpack();

// ── identities as the store keys records ──
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// CIDv1 (raw, sha2-256) in lower-case base32 with the multibase prefix b, computed here from the definition.
export function cidOf(bytes) {
  const raw = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), createHash('sha256').update(bytes).digest()]);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, buffer = 0, out = '';
  for (const byte of raw) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += alphabet[(buffer >> bits) & 31]; }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return `b${out}`;
}
