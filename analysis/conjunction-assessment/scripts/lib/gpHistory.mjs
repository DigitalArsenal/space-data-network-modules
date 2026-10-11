// Space-Track gp_history as the archive keeps it by CREATION_DATE: one
// gzipped JSON file per day (YYYY/YYYY-MM-DD.json.gz) or per follow-up
// window (<from>--<to>.json.gz). Reads records; no orbit computation.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DAY = 86400e3;
export const utcMs = (s) => Date.parse(/[Zz]$|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
// The values that make two element sets of one object the same set.
const ELEMENTS = ['EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY',
  'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
export const elementKey = (r) => ELEMENTS.map((k) => String(r[k])).join('|');

/** The archive files whose creation span meets [fromMs, toMs), in time order. */
export function creationFiles(dir, fromMs, toMs) {
  const iso = (x) => `${x.slice(0, 13)}:${x.slice(13, 15)}:${x.slice(15)}`;
  const files = [];
  for (const year of fs.readdirSync(dir).filter((y) => /^\d{4}$/.test(y))) {
    for (const name of fs.readdirSync(path.join(dir, year))) {
      let start, end;
      const day = /^(\d{4}-\d\d-\d\d)\.json\.gz$/.exec(name);
      const span = /^(\d{4}-\d\d-\d\dT\d{6}Z)--(\d{4}-\d\d-\d\dT\d{6}Z)\.json\.gz$/.exec(name);
      if (day) { start = Date.parse(`${day[1]}T00:00:00Z`); end = start + DAY; }
      else if (span) { start = Date.parse(iso(span[1])); end = Date.parse(iso(span[2])); }
      else continue;
      if (end > fromMs && start < toMs) files.push({ file: path.join(dir, year, name), start });
    }
  }
  return files.sort((a, b) => a.start - b.start).map((x) => x.file);
}

/** Records created in [fromMs, toMs), each once (by GP_ID), in creation order. */
export function recordsCreated(dir, fromMs, toMs) {
  const seen = new Set(), out = [];
  for (const file of creationFiles(dir, fromMs, toMs)) {
    for (const r of JSON.parse(zlib.gunzipSync(fs.readFileSync(file)))) {
      const created = utcMs(r.CREATION_DATE);
      if (created < fromMs || created >= toMs || seen.has(r.GP_ID)) continue;
      seen.add(r.GP_ID);
      out.push(r);
    }
  }
  return out.sort((a, b) => utcMs(a.CREATION_DATE) - utcMs(b.CREATION_DATE) || Number(a.NORAD_CAT_ID) - Number(b.NORAD_CAT_ID));
}
