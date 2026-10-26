#!/usr/bin/env node
// The whole-catalog run's initial states for the reference engines: the same
// selection as scripts/benchmark-catalog.mjs (selectCatalog), each element
// set's GCRF state at its epoch from analysis/epoch-state (SGP4 at zero
// elapsed time, TEME -> GCRF: the states the FFM farm ingests), and each
// object's Cd*A/m from its B* by FFM's own export (catalog.mjs
// dragAreaOverMass) and Cr*A/m 0.02 m^2/kg (DEFAULT_SRP_AREA_OVER_MASS).
//
//   node tests/evidence/engines/catalog-states.mjs <catalog.json[.gz]> <out.tsv> [--objects N]
//
// <out.tsv>: norad, UTC epoch, x y z (m), vx vy vz (m/s), Cd*A/m, Cr*A/m.
// Encoding and decoding only; the states are the modules'.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as flatbuffers from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { MPE, meanElementSource } from 'spacedatastandards.org/lib/js/MPE/main.js';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/main.js';
import { loadCatalog, selectCatalog } from '../../../scripts/benchmark-catalog.mjs';
import * as catalog from '../../../catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(here, '../../../../..');
const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { objects: { type: 'string' } } });
const [catalogFile, out] = positionals;
const { records } = loadCatalog(catalogFile);
const selected = selectCatalog(records, o.objects ? Number(o.objects) : undefined).records;

const unixSeconds = (iso) => {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z?$/.exec(iso.trim());
  return Date.parse(`${m[1]}Z`) / 1000 + (m[2] ? Number(`0${m[2]}`) : 0);
};
const frames = selected.map((r) => {
  const b = new flatbuffers.Builder(256);
  const id = b.createString(`NORAD:${r.NORAD_CAT_ID}`);
  MPE.startMPE(b);
  MPE.addEntityId(b, id);
  MPE.addEpoch(b, unixSeconds(r.EPOCH));
  MPE.addMeanMotion(b, Number(r.MEAN_MOTION));
  MPE.addEccentricity(b, Number(r.ECCENTRICITY));
  MPE.addInclination(b, Number(r.INCLINATION));
  MPE.addRaOfAscNode(b, Number(r.RA_OF_ASC_NODE));
  MPE.addArgOfPericenter(b, Number(r.ARG_OF_PERICENTER));
  MPE.addMeanAnomaly(b, Number(r.MEAN_ANOMALY));
  MPE.addBstar(b, Number(r.BSTAR));
  MPE.addMeanElementTheory(b, meanElementSource.SGP4);
  MPE.finishSizePrefixedMPEBuffer(b, MPE.endMPE(b));
  return b.asUint8Array();
});
const sizes = frames.map((f) => f.length + ((8 - (f.length % 8)) % 8));
const payload = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
let at = 0;
frames.forEach((f, i) => { payload.set(f, at); at += sizes[i]; });

const epochState = path.join(modules, 'analysis/epoch-state');
const es = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(epochState, 'dist/isomorphic/module.wasm')),
  manifest: JSON.parse(fs.readFileSync(path.join(epochState, 'plugin-manifest.json'), 'utf8')), surface: 'direct' });
const response = await es.invoke({ methodId: 'derive', inputs: [{ portId: 'elements', payload,
  typeRef: { schemaName: 'MPE.fbs', fileIdentifier: '$MPE', rootTypeName: 'MPE', wireFormat: 'flatbuffer' } }] });
if (response.statusCode !== 0) throw new Error(`epoch-state: ${response.errorCode}: ${response.errorMessage}`);
await es.destroy();
const states = new Map();
const statesFrame = response.outputs.find((f) => f.portId === 'states').payload;
const view = new DataView(statesFrame.buffer, statesFrame.byteOffset, statesFrame.byteLength);
for (let p = 0; p + 4 <= statesFrame.length;) {
  const n = view.getUint32(p, true);
  if (n === 0) { p += 4; continue; }
  const oem = OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(statesFrame.slice(p, p + 4 + n))).unpack();
  p += 4 + n;
  const block = oem.EPHEMERIS_DATA_BLOCK[0], line = block.EPHEMERIS_DATA_LINES[0];
  const norad = Number(/NORAD:(\d+)/.exec(block.COMMENT ?? '')?.[1] ?? block.OBJECT?.NORAD_CAT_ID);
  states.set(norad, { epoch: line.EPOCH, state: [line.X, line.Y, line.Z, line.X_DOT, line.Y_DOT, line.Z_DOT].map((x) => x * 1000) });
}

const ffm = path.join(modules, 'propagator/ffm');
const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(ffm, 'dist/isomorphic/module.wasm')),
  manifest: JSON.parse(fs.readFileSync(path.join(ffm, 'plugin-manifest.json'), 'utf8')), surface: 'direct' });
const lines = [];
for (const r of selected) {
  const s = states.get(Number(r.NORAD_CAT_ID));
  if (!s) continue;
  const cdAm = catalog.dragAreaOverMass(harness.instance.exports, Number(r.BSTAR));
  lines.push([r.NORAD_CAT_ID, s.epoch, ...s.state.map((x) => x.toPrecision(17)), cdAm.toPrecision(17), catalog.DEFAULT_SRP_AREA_OVER_MASS].join('\t'));
}
await harness.destroy();
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.error(`${lines.length} of ${selected.length} selected element sets -> ${out}`);
