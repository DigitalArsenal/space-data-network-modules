// The consumer's path, a cross-check only (#386): this checkout's foundation/frames (dist/isomorphic/module.wasm, 0.3.0
// since modules PR 12: TEME by AIAA 2006-6753, GMST82 on the x axis) turning AP's TEME output into GCRF, to be compared
// with the module's own GCRF output of the same flight. The archive replays score the module's own GCRF output; the
// pinned foundation/frames 0.2.0 (its TEME placed by GMST06, #389) gives only their old figures.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {experiments} from './experiments.mjs';

const framesRoot = fileURLToPath(new URL('../../../../foundation/frames/', import.meta.url));

/** foundation/frames of this checkout: {version, convert(lines, from, to) -> [{epoch, r, v}] km, close()}. */
export async function openCheckoutFrames() {
  const wasm = fs.readFileSync(path.join(framesRoot, 'dist/isomorphic/module.wasm'));
  const manifest = JSON.parse(fs.readFileSync(path.join(framesRoot, 'plugin-manifest.json'), 'utf8'));
  const entry = createRequire(path.join(framesRoot, 'package.json')).resolve('space-data-module-sdk/host/browser-module');
  const {createBrowserModuleHarness} = await import(pathToFileURL(entry).href);
  const harness = await createBrowserModuleHarness({wasmSource: wasm, manifest, surface: 'direct'});
  const frames = {
    async call(methodId, inputs) {
      const r = await harness.invoke({methodId, inputs});
      if (r.statusCode !== 0) throw new Error(`foundation/frames ${methodId}: ${r.errorCode ?? r.statusCode}: ${r.errorMessage}`);
      const out = {};
      for (const o of r.outputs) out[o.portId] = Buffer.from(o.payload);
      return out;
    },
  };
  const F = await import(path.join(experiments, 'experiments/sdn-gp-starlink-ffm-match/lib/frames.mjs'));
  return {
    version: manifest.version,
    async convert(lines, from, to) {
      const out = [];
      for (const l of lines) {
        const s = await F.transformState(frames, from, to, l.epoch, [...l.r, ...l.v]);
        out.push({epoch: l.epoch, r: s.slice(0, 3), v: s.slice(3, 6)});
      }
      return out;
    },
    close: () => harness.destroy(),
  };
}

/** The largest position distance (m) between two state lists of the same epochs (km). */
export const largestMeters = (a, b) => Math.max(...a.map((s, k) => 1000 * Math.hypot(...s.r.map((x, j) => x - b[k].r[j]))));
