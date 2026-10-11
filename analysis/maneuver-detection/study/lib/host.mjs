// The host side of analysis/maneuver-detection for the studies: loads modules
// through the SDK harness, encodes element sets as $OMM, and routes the
// detector's propagation queries to the plugged propagator. This file moves
// bytes and converts units at the boundary (m -> km); every orbit computation
// is a module's.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { ORBPRO_OMM_RECORD, ORBPRO_STATE_VECTOR } from 'space-data-module-sdk/generated/propagator-abi';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODULE_DIR = path.resolve(here, '../..');
export const MODULES = path.resolve(MODULE_DIR, '../..');
const standards = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(path.join(MODULE_DIR, 'package.json')).resolve('spacedatastandards.org/package.json'));
const requireStandards = createRequire(path.join(standards, 'package.json'));
export const flatbuffers = requireStandards('flatbuffers');
const load = async (code) => import(pathToFileURL(path.join(standards, `lib/js/${code}/main.js`)));
export const [OMM, OEM, MNV] = await Promise.all(['OMM', 'OEM', 'MNV'].map(load));

export const TYPES = {
  OMM: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' },
  OEM: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' },
  MNV: { schemaName: 'MNV.fbs', fileIdentifier: '$MNV', rootTypeName: 'MNV', wireFormat: 'flatbuffer' },
};
export const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });
export const iso = (s) => new Date(Math.round(s * 1000)).toISOString();
export const seconds = (text) => {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z?$/.exec(String(text).trim());
  if (!m) throw new Error(`not an ISO time: ${text}`);
  return Date.parse(`${m[1]}Z`) / 1000 + (m[2] ? Number(`0${m[2]}`) : 0);
};

// A module by its path in the modules checkout; invoke() throws on failure.
export async function loadModule(relative, root = MODULES) {
  const dir = path.join(root, relative);
  const wasm = fs.readFileSync(path.join(dir, 'dist/isomorphic/module.wasm'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin-manifest.json'), 'utf8'));
  const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  return {
    manifest,
    async invoke(methodId, inputs) {
      const response = await harness.invoke({ methodId, inputs });
      if (response.statusCode !== 0) throw new Error(`${relative} ${methodId}: ${response.errorCode ?? response.statusCode}: ${response.errorMessage}`);
      return response;
    },
    destroy: () => harness.destroy(),
  };
}
export const outputsOf = (response, port) => response.outputs.filter((f) => f.portId === port).map((f) => new Uint8Array(f.payload));
export const jsonOf = (response, port) => JSON.parse(Buffer.from(outputsOf(response, port)[0]).toString('utf8'));

// ── element sets ──────────────────────────────────────────────────────────────
// One GP JSON row (Space-Track field names) as a size-prefixed $OMM.
export function ommRecord(row) {
  const t = new OMM.OMMT();
  const num = (k) => (row[k] === undefined || row[k] === null || row[k] === '' ? 0 : Number(row[k]));
  Object.assign(t, {
    OBJECT_NAME: row.OBJECT_NAME ?? '', OBJECT_ID: row.OBJECT_ID ?? '', NORAD_CAT_ID: num('NORAD_CAT_ID'),
    EPOCH: String(row.EPOCH), MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4,
    MEAN_MOTION: num('MEAN_MOTION'), ECCENTRICITY: num('ECCENTRICITY'), INCLINATION: num('INCLINATION'), RA_OF_ASC_NODE: num('RA_OF_ASC_NODE'),
    ARG_OF_PERICENTER: num('ARG_OF_PERICENTER'), MEAN_ANOMALY: num('MEAN_ANOMALY'), BSTAR: num('BSTAR'),
    MEAN_MOTION_DOT: num('MEAN_MOTION_DOT'), MEAN_MOTION_DDOT: num('MEAN_MOTION_DDOT'), REV_AT_EPOCH: num('REV_AT_EPOCH'),
    ELEMENT_SET_NO: num('ELEMENT_SET_NO'), COMMENT: row.GP_ID ? `GP_ID ${row.GP_ID}` : '',
  });
  const b = new flatbuffers.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return b.asUint8Array();
}
export const ommStream = (rows) => Buffer.concat(rows.map((r) => Buffer.from(ommRecord(r))));

// ── providers: each answers a propagation_requests frame with $OEM frames, one
// data block per query in query order ───────────────────────────────────────────
const byObject = (queries) => {
  const groups = [];
  for (const q of queries) {
    if (!groups.length || groups.at(-1).object !== q.object) groups.push({ object: q.object, norad: q.norad, queries: [] });
    groups.at(-1).queries.push(q);
  }
  return groups;
};
const refusal = (q, reason) => {
  const b = new OEM.ephemerisDataBlockT();
  b.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: q.norad, OBJECT_ID: q.object_id ?? '' });
  b.COMMENT = `REFUSED ${reason}`.slice(0, 300);
  b.CENTER_NAME = 'EARTH';
  b.TIME_SYSTEM = OEM.timingStandard.UTC;
  b.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: 'TEME' });
  return b;
};
export function oemFrame(blocks, creation = '2026-10-11T00:00:00.000Z') {
  const m = new OEM.OEMT();
  m.CREATION_DATE = creation;
  m.EPHEMERIS_DATA_BLOCK = blocks;
  const b = new flatbuffers.Builder(1 << 20);
  OEM.OEM.finishOEMBuffer(b, m.pack(b));
  return b.asUint8Array();
}
const julian = (s) => s / 86400 + 2440587.5;

// propagator/sgp4 1.2.0: one propagate_ephemeris per object with
// element_set_blocks (one block per set over its neighbour_sets each side:
// the same spans the detector asks for), TEME. A history SGP4 refuses as a
// whole is answered set by set, refusing only the sets that fail.
function propRequest({ catalogNumbers, stepSeconds, elementSetBlocks, neighbourSets = 2, epoch = 0, stopEpoch = 0 }) {
  const b = new flatbuffers.Builder(256);
  b.startVector(4, catalogNumbers.length, 4);
  for (let i = catalogNumbers.length - 1; i >= 0; --i) b.addInt32(catalogNumbers[i]);
  const cat = b.endVector();
  b.startObject(10);
  b.addFieldFloat64(0, epoch, 0);
  b.addFieldOffset(4, cat, 0);
  b.addFieldInt8(5, 0, 3);              // output_frame TEME (default ECEF)
  b.addFieldFloat64(6, stopEpoch, 0);
  b.addFieldFloat64(7, stepSeconds, 0);
  b.addFieldInt8(8, elementSetBlocks ? 1 : 0, 0);
  b.addFieldInt32(9, neighbourSets, 2);
  b.finish(b.endObject());
  return b.asUint8Array();
}
const PROP = { schemaName: 'orbpro.propagator.PropagatorBatchRequest', fileIdentifier: 'PROP', rootTypeName: 'PropagatorBatchRequest' };
const OMM_SGP4 = { schemaName: 'orbpro.sds.omm', fileIdentifier: '$OMM', rootTypeName: 'OMM' };

export async function sgp4Provider() {
  const call = async (rows, request) => {
    const sgp4 = await loadModule('propagator/sgp4');
    try {
      const r = await sgp4.invoke('propagate_ephemeris', [{ portId: 'request', payload: propRequest(request), typeRef: PROP },
        { portId: 'omm', payload: ommStream(rows), typeRef: OMM_SGP4 }]);
      const out = outputsOf(r, 'ephemeris');
      return OEM.OEM.getRootAsOEM(new flatbuffers.ByteBuffer(out[0])).unpack().EPHEMERIS_DATA_BLOCK;
    } finally {
      await sgp4.destroy();
    }
  };
  return {
    name: 'propagator/sgp4',
    async answer(requests, rows) {
      const frames = [];
      for (const g of byObject(requests.queries)) {
        const sets = g.queries.map((q) => rows[q.set]);
        const step = g.queries[0].step_s;
        let blocks;
        try {
          blocks = await call(sets, { catalogNumbers: [g.norad], stepSeconds: step, elementSetBlocks: true, neighbourSets: requests.neighbour_sets });
          if (blocks.length !== g.queries.length) throw new Error(`${blocks.length} blocks for ${g.queries.length} sets`);
        } catch {
          blocks = [];
          for (const q of g.queries) {
            try {
              const [b] = await call([rows[q.set]], { catalogNumbers: [g.norad], stepSeconds: step, elementSetBlocks: false,
                epoch: julian(seconds(q.start)), stopEpoch: julian(seconds(q.stop)) });
              blocks.push(b);
            } catch (e) {
              blocks.push(refusal(q, String(e.message ?? e)));
            }
          }
        }
        frames.push(oemFrame(blocks));
      }
      return frames;
    },
  };
}

// propagator/keplerian-reference through the propagator ABI (plugin_init_omm,
// plugin_propagate): Earth-fixed metres per the ABI, written as Earth-fixed km.
export async function keplerianProvider() {
  const bytes = fs.readFileSync(path.join(MODULES, 'propagator/keplerian-reference/dist/isomorphic/module.wasm'));
  const compiled = await WebAssembly.compile(bytes);
  return {
    name: 'propagator/keplerian-reference',
    async answer(requests, rows) {
      const frames = [];
      for (const g of byObject(requests.queries)) {
        const wasi = new WASI({ version: 'preview1', args: ['module'], env: {} });
        const instance = await WebAssembly.instantiate(compiled, wasi.getImportObject());
        const x = instance.exports;
        const { size, offsets } = ORBPRO_OMM_RECORD;
        const records = g.queries.map((q) => rows[q.set]);
        const buffer = new ArrayBuffer(size * records.length);
        const view = new DataView(buffer);
        records.forEach((r, i) => {
          const base = i * size;
          view.setFloat64(base + offsets.epoch_jd, julian(seconds(r.EPOCH)), true);
          view.setFloat64(base + offsets.mean_motion, Number(r.MEAN_MOTION), true);
          view.setFloat64(base + offsets.eccentricity, Number(r.ECCENTRICITY), true);
          view.setFloat64(base + offsets.inclination, Number(r.INCLINATION), true);
          view.setFloat64(base + offsets.ra_of_asc_node, Number(r.RA_OF_ASC_NODE), true);
          view.setFloat64(base + offsets.arg_of_pericenter, Number(r.ARG_OF_PERICENTER), true);
          view.setFloat64(base + offsets.mean_anomaly, Number(r.MEAN_ANOMALY), true);
          view.setFloat64(base + offsets.bstar, Number(r.BSTAR ?? 0), true);
          view.setUint32(base + offsets.norad_cat_id, Number(r.NORAD_CAT_ID), true);
        });
        const p = x.plugin_alloc(buffer.byteLength);
        new Uint8Array(x.memory.buffer).set(new Uint8Array(buffer), p);
        const count = x.plugin_init_omm(p, records.length);
        x.plugin_free(p);
        if (count !== records.length) throw new Error(`keplerian-reference took ${count} of ${records.length} element sets`);
        const out = x.plugin_alloc(ORBPRO_STATE_VECTOR.size);
        const blocks = g.queries.map((q, i) => {
          const start = seconds(q.start), stop = seconds(q.stop);
          const data = [];
          let ok = true;
          for (let k = 0; ; ++k) {
            const t = Math.min(stop, start + k * q.step_s);
            const status = x.plugin_propagate(julian(t), i, out);
            if (status !== 0) { ok = false; break; }
            const v = new DataView(x.memory.buffer, out, ORBPRO_STATE_VECTOR.size);
            const o = ORBPRO_STATE_VECTOR.offsets;
            data.push(...[0, 1, 2].map((c) => v.getFloat64(o.position + 8 * c, true) / 1000), ...[0, 1, 2].map((c) => v.getFloat64(o.velocity + 8 * c, true) / 1000));
            if (t >= stop) break;
          }
          if (!ok) return refusal(q, 'plugin_propagate refused a sample');
          const b = new OEM.ephemerisDataBlockT();
          b.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: q.norad, OBJECT_ID: q.object_id ?? '' });
          b.CENTER_NAME = 'EARTH';
          b.TIME_SYSTEM = OEM.timingStandard.UTC;
          b.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: 'ECEF' });
          b.START_TIME = iso(start);
          b.STEP_SIZE = q.step_s;
          b.EPHEMERIS_DATA = data;
          // The last interval may be shorter than the step: write lines instead.
          if ((stop - start) % q.step_s !== 0) {
            b.STEP_SIZE = 0;
            b.EPHEMERIS_DATA = [];
            b.EPHEMERIS_DATA_LINES = [];
            for (let k = 0; k * 6 < data.length; ++k) {
              const line = new OEM.ephemerisDataLineT();
              line.EPOCH = iso(Math.min(stop, start + k * q.step_s));
              [line.X, line.Y, line.Z, line.X_DOT, line.Y_DOT, line.Z_DOT] = data.slice(6 * k, 6 * k + 6);
              b.EPHEMERIS_DATA_LINES.push(line);
            }
          }
          return b;
        });
        x.plugin_free(out);
        x.plugin_destroy();
        frames.push(oemFrame(blocks));
      }
      return frames;
    },
  };
}

// The detector over one provider: queries, routed answers, detection. One set
// of answers serves every options variant (the variants must share
// neighbour_sets and grid_step_s, which decide the queries).
export async function detectWith(detector, provider, rows, variants) {
  const stream = ommStream(rows);
  const base = [{ portId: 'element_sets', payload: stream, typeRef: TYPES.OMM }];
  const first = await detector.invoke('detect_maneuvers', [...base, json('options', variants[0])]);
  const requests = jsonOf(first, 'propagation_requests');
  const answers = await provider.answer(requests, rows);
  const results = [];
  for (const options of variants) {
    const r = await detector.invoke('detect_maneuvers', [...base, json('options', options),
      ...answers.map((a) => ({ portId: 'propagation', payload: a, typeRef: TYPES.OEM }))]);
    results.push({ report: jsonOf(r, 'report'), maneuvers: outputsOf(r, 'maneuvers') });
  }
  return { queries: requests.queries.length, results };
}

export const unpackMnv = (bytes) => MNV.MNV.getRootAsMNV(new flatbuffers.ByteBuffer(bytes)).unpack();
export function mnvRecord(fields) {
  const t = Object.assign(new MNV.MNVT(), fields);
  const b = new flatbuffers.Builder(1024);
  MNV.MNV.finishSizePrefixedMNVBuffer(b, t.pack(b));
  return b.asUint8Array();
}
// Plain $MNV frames (detector outputs) as one size-prefixed stream.
export function mnvStream(frames) {
  return Buffer.concat(frames.map((f) => {
    const t = unpackMnv(f);
    return Buffer.from(mnvRecord(t));
  }));
}
