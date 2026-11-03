// The truth of PLAN.md (Groups), real products only, every state through harness/truth-gate.mjs (G1's readReference gates
// each file's states under its product and object):
//   Swarm A, B, C     ESA's reduced-dynamic SP3 COM, daily, 10 s (analysis/reference-states, the archive's reference states)
//   GRACE-FO 1, 2, TerraSAR-X   GFZ ISDC rapid science orbits, 14 h arcs every 12 h, 30 s (convert.mjs, this store)
//   Sentinel-1A, C, D Copernicus POEORB, 26 h files daily, 10 s (the archive's reference states)
//   GNSS              ESA final orbits (ESA0OPSFIN), daily, 5 min (the archive's reference states)
// A series takes each epoch from the newest file that starts at or before it (ruling 10). The ISS and the laser-ranged
// spheres are read as B2 read them (windows.mjs). Reading and selection only.
import fs from 'node:fs';
import path from 'node:path';
import { config, store, g1Dir, ms, DAY } from '../common.mjs';

const SRC = await import(path.join(g1Dir, 'lib/sources.mjs'));
const { screen } = await import(path.join(g1Dir, '../../harness/truth-gate.mjs'));

const ROOT = SRC.referenceRootDir;
const stamp = (s) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);

/** The product files of one object, in start order: [{ name, file, startMs, stopMs }] (the file holds the object). */
const indexCache = new Map();
export function productFiles(o) {
  const key = `${o.truth}|${o.norad}`;
  if (indexCache.has(key)) return indexCache.get(key);
  let list = [];
  if (o.truth === 'swarm') {
    list = fs.readdirSync(ROOT).filter((d) => d.startsWith(o.product)).map((d) => { const m = /__(\d{8}T\d{6})_(\d{8}T\d{6})_/.exec(d); return { name: d, file: path.join(ROOT, d, `${o.norad}.oem`), startMs: stamp(m[1]), stopMs: stamp(m[2]) }; });
  } else if (o.truth === 'sentinel1') {
    list = fs.readdirSync(ROOT).filter((d) => d.startsWith(o.product)).map((d) => { const m = /_V(\d{8}T\d{6})_(\d{8}T\d{6})$/.exec(d); return { name: d, file: path.join(ROOT, d, `${o.norad}.oem`), startMs: stamp(m[1]), stopMs: stamp(m[2]) }; });
  } else if (o.truth === 'gfz-rso') {
    const dir = path.join(store, 'reference');
    list = fs.readdirSync(dir).filter((d) => d.startsWith(`GFZOP_RSO_${o.code}_`)).map((d) => ({ name: d, file: path.join(dir, d, `${o.norad}.oem`), startMs: stamp(d.slice(16, 31)), stopMs: stamp(d.slice(32, 47)) }));
  } else if (o.truth === 'gnss') {
    list = fs.readdirSync(ROOT).filter((d) => /^ESA0OPSFIN_\d{11}_01D_05M_ORB$/.test(d)).map((d) => { const y = Number(d.slice(11, 15)), doy = Number(d.slice(15, 18)); const t = Date.UTC(y, 0, 1) + (doy - 1) * DAY; return { name: d, file: path.join(ROOT, d, `${o.norad}.oem`), startMs: t, stopMs: t + DAY }; });
  } else throw new Error(`no truth reader for ${o.truth}`);
  list = list.filter((f) => fs.existsSync(f.file)).sort((a, b) => a.startMs - b.startMs || a.name.localeCompare(b.name));
  indexCache.set(key, list);
  return list;
}

/** A product file's gated states, the last 32 files read kept in memory (consecutive cutoffs share most of their files). */
const fileCache = new Map();
function readCached(file) {
  if (fileCache.has(file)) { const v = fileCache.get(file); fileCache.delete(file); fileCache.set(file, v); return v; }
  const ref = SRC.readReference(file);
  fileCache.set(file, ref);
  if (fileCache.size > 32) fileCache.delete(fileCache.keys().next().value);
  return ref;
}

/** The object's states in [fromMs, toMs] (GCRF, UTC, km, km/s): [{epoch, r, v}], each epoch from the newest file that starts at or
 *  before it; the files read. */
export function series(o, fromMs, toMs) {
  const files = productFiles(o).filter((f) => f.stopMs >= fromMs - DAY && f.startMs <= toMs);
  let merged = [];
  const used = [];
  for (const f of files) {
    const ref = readCached(f.file);
    const lines = ref.lines.filter((l) => { const t = ms(l.epoch); return t >= fromMs && t <= toMs; });
    if (!lines.length) continue;
    const start = ms(ref.lines[0].epoch);
    merged = merged.filter((l) => ms(l.epoch) < start).concat(lines);  // the newer file from its first state on
    used.push(f.name);
  }
  merged.sort((a, b) => ms(a.epoch) - ms(b.epoch));
  return { lines: merged, files: used };
}

/** The truth gate's jump rule on a series (ruling 11), in memory: the candidates and the threshold. */
export function jumpScreen(lines) {
  return screen(lines.map((l) => ({ ms: ms(l.epoch), r: l.r, v: l.v })));
}

/** G1's thinning: every round(300 / step)-th state by the list's first spacing (lib/baselines.mjs). */
export function thinned(list, thinSeconds = config.fit.thinSeconds) {
  if (list.length < 2) return { chosen: list, every: 1, step: null };
  const step = (ms(list[1].epoch) - ms(list[0].epoch)) / 1000;
  const every = Math.max(1, Math.round(thinSeconds / step));
  return { chosen: list.filter((_, i) => i % every === 0), every, step };
}

/** The pairs of consecutive files that overlap, with the 3D RMS (m) of their differences at the epochs both hold (pre-check P1). */
export function overlaps(o, fromMs, toMs) {
  const files = productFiles(o).filter((f) => f.stopMs >= fromMs && f.startMs <= toMs);
  const out = [];
  let prev = null;
  for (const f of files) {
    const ref = SRC.readReference(f.file);
    const map = new Map(ref.lines.map((l) => [l.epoch, l.r]));
    if (prev) {
      let sum = 0, n = 0;
      for (const [epoch, r] of map) { const p = prev.map.get(epoch); if (p) { sum += (r[0] - p[0]) ** 2 + (r[1] - p[1]) ** 2 + (r[2] - p[2]) ** 2; n += 1; } }
      if (n) out.push({ a: prev.name, b: f.name, epochs: n, rms3dM: Math.sqrt(sum / n) * 1000 });
    }
    prev = { name: f.name, map };
  }
  return out;
}

/** The stated per-axis sigma (m) of each file of the object over [fromMs, toMs] (index.json statedSigmaM). */
export function statedSigmas(o, fromMs, toMs) {
  return productFiles(o).filter((f) => f.stopMs >= fromMs && f.startMs <= toMs).map((f) => {
    const index = JSON.parse(fs.readFileSync(path.join(path.dirname(f.file), 'index.json'), 'utf8'));
    return index.statedSigmaM ?? null;
  }).filter(Number.isFinite);
}
