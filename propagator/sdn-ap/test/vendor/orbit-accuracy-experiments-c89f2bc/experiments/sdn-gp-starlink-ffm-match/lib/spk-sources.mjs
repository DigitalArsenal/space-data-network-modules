// Ephemeris objects from NAIF SPK kernels: states by files/orbit-products `read_container` (SPK types 8, 9, 13; TDB epochs,
// J2000 axes, km and km/s), epochs to UTC by foundation/time `convert_time`, one module call each. JavaScript here selects
// segments, formats epoch strings and places the states in the experiment's object form; it converts nothing itself.
import path from 'node:path';
import { openContainers, readSpk } from './containers.mjs';
import { openTime, convertAll } from './timeconv.mjs';
import { withT } from './windows.mjs';
import { gate } from '../../../harness/truth-gate.mjs';

// Amendment A5: the windows of the highly elliptical orbits.
export const A5 = Object.freeze({
  fitHours: [24, 72], strideSeconds: 172800,
  themis: { span: ['2013-02-08T00:00:00Z', '2013-02-24T00:00:00Z'], objects: [['A', -650], ['D', -653], ['E', -654]] },
  chandra: { span: ['2018-03-01T00:00:00Z', '2018-04-30T00:00:00Z'] },
  artemis2: { span: ['2026-04-02T01:58:21Z', '2026-04-02T22:49:21Z'], fitHours: 8, minCoverage: 0.4 },
});

// Amendment A8b: TESS, Earth-centered highly elliptical (13.7 day), MAST definitive ephemeris files (doy 194 to 260 of 2026).
export const A8 = Object.freeze({ tess: { span: ['2026-06-29T13:02:00Z', '2026-09-17T13:00:00Z'], norad: 43435, stride: 5 } });

export const KERNELS = (archive) => path.join(archive, 'hac/naif-kernels/spk/missions');
/** The kernels of the A5 windows under KERNELS(archive). */
export const FILES = (dir) => ({
  themis: (letter) => path.join(dir, `themis/THEMIS_${letter}_2013_039_055.bsp`),
  chandra: path.join(dir, 'chandra/chandra_merged.bsp'),
  artemis2: path.join(dir, 'artemis2/art002_rec_260402_260410_jsc_bet_revf.bsp'),
});

const parseTdb = (text) => { // 'YYYY-MM-DDTHH:MM:SS.ffffff' -> { wholeMs (to the second), micro }
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?/.exec(text);
  return { second: Date.parse(`${m[1]}Z`), micro: Number((m[2] ?? '0').padEnd(6, '0').slice(0, 6)) };
};
const tdbString = (start, offsetSeconds) => { // start + whole seconds, microseconds kept
  const iso = new Date(start.second + offsetSeconds * 1000).toISOString().slice(0, 19);
  return `${iso}.${String(start.micro).padStart(6, '0')}`;
};

/** All states of the SPK's segments that overlap [fromUtcMs, toUtcMs] (plus a one-minute margin), epochs still TDB strings. */
export function tdbStates(oem, fromUtcMs, toUtcMs) {
  const rows = [];
  for (const block of oem.EPHEMERIS_DATA_BLOCK) {
    const margin = 70 * 1000 + 60000; // TDB runs about 69 s ahead of UTC
    if (block.EPHEMERIS_DATA?.length) {
      const start = parseTdb(block.START_TIME), n = block.EPHEMERIS_DATA.length / block.STATE_VECTOR_SIZE;
      const first = start.second, last = start.second + (n - 1) * block.STEP_SIZE * 1000;
      if (last + margin < fromUtcMs || first - margin > toUtcMs) continue;
      for (let i = 0; i < n; i += 1) {
        const t = first + i * block.STEP_SIZE * 1000;
        if (t + margin < fromUtcMs || t - margin > toUtcMs) continue;
        const d = block.EPHEMERIS_DATA, k = i * block.STATE_VECTOR_SIZE;
        rows.push({ tdb: tdbString(start, i * block.STEP_SIZE), r: [d[k], d[k + 1], d[k + 2]], v: [d[k + 3], d[k + 4], d[k + 5]] });
      }
    } else {
      for (const l of block.EPHEMERIS_DATA_LINES ?? []) {
        const t = parseTdb(l.EPOCH).second;
        if (t + margin < fromUtcMs || t - margin > toUtcMs) continue;
        rows.push({ tdb: l.EPOCH, r: [l.X, l.Y, l.Z], v: [l.X_DOT, l.Y_DOT, l.Z_DOT] });
      }
    }
  }
  return rows;
}

/** An ephemeris object in the experiment's form (EME2000 axes = the SPK's J2000, UTC epochs) for a span of an SPK file. */
export async function spkObject(modules, { file, source, id, name, norad, fromUtc, toUtc, containers, time, raw = false }) { // raw: the kernel's states ungated (the truth gate's scan)
  const own = { containers: !containers, time: !time };
  containers ??= await openContainers(modules);
  time ??= await openTime(modules);
  try {
    const read = await readSpk(containers, file);
    if (read.error) throw new Error(`${path.basename(file)}: ${read.error}`);
    const rows = tdbStates(read.oem, Date.parse(fromUtc), Date.parse(toUtc));
    const utc = await convertAll(time, rows.map((x) => x.tdb));
    const lines = rows.map((x, i) => ({ epoch: utc[i], r: x.r, v: x.v })).filter((l) => Date.parse(l.epoch) >= Date.parse(fromUtc) && Date.parse(l.epoch) <= Date.parse(toUtc));
    lines.sort((a, b) => Date.parse(a.epoch) - Date.parse(b.epoch));
    // segments of one kernel can share their boundary epoch to within a microsecond: keep one state per half second
    const unique = [];
    for (const l of lines) if (!unique.length || Date.parse(l.epoch) - Date.parse(unique.at(-1).epoch) >= 500) unique.push(l);
    // the truth gate (harness/truth-gate.mjs): the sanity rule, and any state its ledger lists for this source and object
    return withT({ source, id, norad, name, objectId: '', originator: 'NAIF SPK', creation: '', frame: 'EME2000', timeSystem: 'UTC', lines: raw ? unique : gate(unique, { product: source, norad }).kept });
  } finally {
    if (own.containers) await containers.destroy();
    if (own.time) await time.destroy();
  }
}

/**
 * One ephemeris object from several overlapping SPK files of one target (TESS's definitive ephemeris is a file every few days):
 * the states of every file, every `stride`-th state of each segment, later files overriding earlier ones where they overlap
 * (the newer solution), epochs to UTC by foundation/time. Files are given oldest first.
 */
export async function spkObjectSeries(modules, { files, source, id, name, norad, fromUtc, toUtc, stride = 1, containers, time, raw = false }) {
  const own = { containers: !containers, time: !time };
  containers ??= await openContainers(modules);
  time ??= await openTime(modules);
  try {
    const byKey = new Map(); // second of the TDB epoch (rounded to the second) -> row; a later file overwrites
    for (const file of files) {
      const read = await readSpk(containers, file);
      if (read.error) throw new Error(`${path.basename(file)}: ${read.error}`);
      for (const block of read.oem.EPHEMERIS_DATA_BLOCK) {
        const lines = block.EPHEMERIS_DATA?.length ? null : block.EPHEMERIS_DATA_LINES ?? [];
        const rows = lines ? lines.map((l) => ({ tdb: l.EPOCH, r: [l.X, l.Y, l.Z], v: [l.X_DOT, l.Y_DOT, l.Z_DOT] })) : tdbStates({ EPHEMERIS_DATA_BLOCK: [block] }, Date.parse(fromUtc), Date.parse(toUtc));
        rows.forEach((row, i) => {
          if (i % stride) return;
          const t = parseTdb(row.tdb).second;
          if (t + 70000 + 60000 < Date.parse(fromUtc) || t - 70000 - 60000 > Date.parse(toUtc)) return;
          byKey.set(Math.round(t / 1000), row);
        });
      }
    }
    const rows = [...byKey.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
    const utc = await convertAll(time, rows.map((x) => x.tdb));
    const lines = rows.map((x, i) => ({ epoch: utc[i], r: x.r, v: x.v })).filter((l) => Date.parse(l.epoch) >= Date.parse(fromUtc) && Date.parse(l.epoch) <= Date.parse(toUtc));
    lines.sort((a, b) => Date.parse(a.epoch) - Date.parse(b.epoch));
    const unique = [];
    for (const l of lines) if (!unique.length || Date.parse(l.epoch) - Date.parse(unique.at(-1).epoch) >= 500) unique.push(l);
    // the truth gate (harness/truth-gate.mjs): the sanity rule, and any state its ledger lists for this source and object
    return withT({ source, id, norad, name, objectId: '', originator: 'NAIF SPK', creation: '', frame: 'EME2000', timeSystem: 'UTC', lines: raw ? unique : gate(unique, { product: source, norad }).kept });
  } finally {
    if (own.containers) await containers.destroy();
    if (own.time) await time.destroy();
  }
}
