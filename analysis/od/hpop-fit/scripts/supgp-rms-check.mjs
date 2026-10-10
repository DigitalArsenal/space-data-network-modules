// The rms.txt convention check (live, in memory): CelesTrak publishes, for
// each supplemental GP element set, the RMS of its fit to the operator's
// ephemeris. This module recomputes that RMS for each published set on the
// operator file held in memory (the per-coordinate RMS, TEME, km, every point
// of the set's window) and prints it beside the published value. Nothing is
// written: the ephemeris is fetched into memory and dropped.
//
//   node scripts/supgp-rms-check.mjs --ephemeris-url <url> --supgp <sup-gp.json> \
//     [--window-seconds 21600] [--format oem|meme] [--rms <x.rms.txt>]
//
// The SupGP JSON and rms.txt are element-set files (CelesTrak's collector
// archive, /opt/data/sdn-archive/celestrak/supgp/<group>/); fetch them only
// under analysis/conjunction-assessment/scripts/CELESTRAK_FETCH_POLICY.md.
import fs from 'node:fs';
import * as flatbuffers from 'flatbuffers';
import { OMM, OMMT } from 'spacedatastandards.org/lib/js/OMM/main.js';
import { loadFit } from '../tests/lib/harness.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const url = arg('ephemeris-url'), supgp = JSON.parse(fs.readFileSync(arg('supgp'), 'utf8'));
const window = Number(arg('window-seconds', 21600)), format = arg('format', '');

function omm(row) {
  const t = new OMMT();
  Object.assign(t, { OBJECT_NAME: row.OBJECT_NAME, OBJECT_ID: row.OBJECT_ID, EPOCH: row.EPOCH, MEAN_MOTION: row.MEAN_MOTION, ECCENTRICITY: row.ECCENTRICITY,
    INCLINATION: row.INCLINATION, RA_OF_ASC_NODE: row.RA_OF_ASC_NODE, ARG_OF_PERICENTER: row.ARG_OF_PERICENTER, MEAN_ANOMALY: row.MEAN_ANOMALY,
    NORAD_CAT_ID: row.NORAD_CAT_ID, BSTAR: row.BSTAR, MEAN_MOTION_DOT: row.MEAN_MOTION_DOT, MEAN_MOTION_DDOT: row.MEAN_MOTION_DDOT ?? 0 });
  const b = new flatbuffers.Builder(512);
  OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return b.asUint8Array();
}

const response = await fetch(url, { headers: { 'user-agent': 'sdn-od-rms-check/1.0' } });
if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const od = await loadFit();
const rows = [];
for (const row of supgp) {
  const r = await od.invoke({ methodId: 'fit', inputs: [
    { portId: 'ephemeris', typeRef: { schemaName: 'application/octet-stream' }, payload: bytes },
    { portId: 'options', typeRef: { schemaName: 'application/json' }, payload: Buffer.from(JSON.stringify({ hpop: false, closure: false, inputFormat: format, ommAnchor: 'reference', ommSpanSeconds: window, referenceRmsMaxKm: 1e9 })) },
    { portId: 'reference', typeRef: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' }, payload: omm(row) },
  ] });
  const result = r.statusCode === 0 ? JSON.parse(Buffer.from(r.outputs.find((o) => o.portId === 'result').payload).toString()) : { ok: false, failureCode: r.errorMessage };
  const ref = result.sgp4?.reference;
  rows.push({ name: row.OBJECT_NAME, epoch: row.EPOCH, published: Number(row.RMS), recomputed: ref ? Number(ref.rmsPerCoordinateKm.toFixed(4)) : null,
    n: ref?.n ?? 0, ours: result.sgp4 ? Number(result.sgp4.stats.rmsPerCoordinateKm.toFixed(4)) : null, note: result.ok ? '' : result.failureCode });
}
od.destroy?.();
const matched = rows.filter((r) => r.recomputed !== null && r.n > 0);
const diffs = matched.map((r) => r.recomputed - r.published);
console.log(JSON.stringify({ ephemerisSha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, windowSeconds: window, sets: rows.length, scored: matched.length,
  meanDiffKm: diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1), maxAbsDiffKm: Math.max(0, ...diffs.map(Math.abs)), rows }, null, 1));
