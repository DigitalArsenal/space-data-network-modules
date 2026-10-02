// Shared by hpop-calibration.mjs and analysis/private-screening's decoy
// study: SGP4 element sets to GCRF epoch states (analysis/epoch-state, the
// HPOP screen's seeds), and HPOP resident propagation of arcs to target
// epochs over worker threads (hpop-calibration-worker.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { MPE, meanElementSource } from 'spacedatastandards.org/lib/js/MPE/main.js';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/main.js';

const modules = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SETTERS = ['addMeanMotion', 'addEccentricity', 'addInclination', 'addRaOfAscNode', 'addArgOfPericenter', 'addMeanAnomaly', 'addBstar'];

export const unixSeconds = (text) => {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z?$/.exec(text.trim());
  return Date.parse(`${m[1]}Z`) / 1000 + (m[2] ? Number(`0${m[2]}`) : 0);
};

// [{key, epoch (unix s), values: [n rev/day, e, i, raan, argp, ma deg, bstar]}]
// -> Map key -> {epoch, position, velocity} (GCRF km, km/s at the set's epoch).
export async function epochStates(list, batch = 20000) {
  const dir = path.join(modules, 'analysis/epoch-state');
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(dir, 'dist/isomorphic/module.wasm')),
    manifest: JSON.parse(fs.readFileSync(path.join(dir, 'plugin-manifest.json'), 'utf8')), surface: 'direct' });
  const states = new Map();
  try {
    for (let at = 0; at < list.length; at += batch) {
      const frames = list.slice(at, at + batch).map(({ key, epoch, values }) => {
        const b = new flatbuffers.Builder(256);
        const id = b.createString(`K:${key}`);
        MPE.startMPE(b);
        MPE.addEntityId(b, id);
        MPE.addEpoch(b, epoch);
        values.forEach((v, k) => MPE[SETTERS[k]](b, v));
        MPE.addMeanElementTheory(b, meanElementSource.SGP4);
        MPE.finishSizePrefixedMPEBuffer(b, MPE.endMPE(b));
        return b.asUint8Array();
      });
      const sizes = frames.map((f) => f.length + ((8 - (f.length % 8)) % 8));
      const payload = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
      let offset = 0;
      frames.forEach((f, i) => { payload.set(f, offset); offset += sizes[i]; });
      const res = await harness.invoke({ methodId: 'derive', inputs: [{ portId: 'elements', payload,
        typeRef: { schemaName: 'MPE.fbs', fileIdentifier: '$MPE', rootTypeName: 'MPE', wireFormat: 'aligned-binary', requiredAlignment: 8, byteLength: payload.byteLength } }] });
      if (res.statusCode !== 0) throw new Error(`epoch-state: ${res.errorCode}: ${res.errorMessage}`);
      const bytes = res.outputs.find((f) => f.portId === 'states')?.payload ?? new Uint8Array();
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let p = 0; p + 4 <= bytes.length;) {
        const n = view.getUint32(p, true);
        if (n === 0) { p += 4; continue; }
        const oem = OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(bytes.slice(p, p + 4 + n))).unpack();
        const block = oem.EPHEMERIS_DATA_BLOCK[0], line = block.EPHEMERIS_DATA_LINES[0];
        states.set(Number(/^K:(\d+)$/.exec(block.OBJECT.OBJECT_ID)[1]),
          { epoch: line.EPOCH, position: [line.X, line.Y, line.Z], velocity: [line.X_DOT, line.Y_DOT, line.Z_DOT] });
        p += 4 + n;
      }
    }
  } finally {
    await harness.destroy();
  }
  return states;
}

// arcs: [{arc, norad, seed: {epoch, position, velocity}, covariance?, targets: [ISO UTC]}]
// -> [{arc, samples: [{state, a?, u?} | {error}]}] in input order of each worker.
export async function propagateArcs(arcs, { variants, interval = 600, workers = Math.max(1, Math.min(12, os.availableParallelism() - 2)) }) {
  const count = Math.min(workers, arcs.length);
  const hpop = path.join(modules, 'propagator/hpop');
  let finished = 0;
  const started = performance.now();
  const parts = await Promise.all(Array.from({ length: count }, (_, w) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hpop-calibration-worker.mjs', import.meta.url));
    worker.on('message', (m) => {
      if (m.progress) {
        if (++finished % 100 === 0) process.stderr.write(`\r${finished}/${arcs.length} arcs, ${((performance.now() - started) / 1000).toFixed(0)} s`);
        return;
      }
      worker.terminate();
      m.error ? reject(new Error(m.error)) : resolve(m.results);
    });
    worker.on('error', reject);
    worker.postMessage({ wasmPath: path.join(hpop, 'dist/isomorphic/module.wasm'), manifestPath: path.join(hpop, 'plugin-manifest.json'),
      id: `hpop-${w}`, arcs: arcs.filter((_, i) => i % count === w), variants, interval });
  })));
  process.stderr.write('\n');
  return { results: parts.flat(), seconds: (performance.now() - started) / 1000 };
}
