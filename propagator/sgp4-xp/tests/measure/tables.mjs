// node tests/measure/tables.mjs [results/*.json ...] : the Markdown tables of tests/measure/README.md, from the result files.
// Nothing is computed here but formatting: the statistics are in the files (summary.mjs wrote them).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('results/', import.meta.url));
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
const km = (x) => (Number.isFinite(x) ? (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toFixed(3)) : '-');
const pct = (x) => (Number.isFinite(x) ? `${Math.round(100 * x)}%` : '-');

for (const file of files) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = r.summary;
  const days = Object.keys(s).filter((k) => /^day\d+$/.test(k)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  console.log(`### ${path.basename(file, '.json')}`);
  console.log('');
  console.log(`${r.objects} object${r.objects === 1 ? '' : 's'}, fits of ${r.fitHours} h every ${r.strideHours} h. Windows: ${s.windows.total}; SGP4-XP failed ${s.windows.xpFailed}; SGP4 (${r.sgp4Fitter ?? 'not run'}) failed ${s.windows.sgp4Failed}; both fitted ${s.windows.paired}.`);
  console.log('');
  console.log('Both fitters, on the windows both fitted (3D position RMS against the ephemeris, km, TEME):');
  console.log('');
  console.log('| Day | n | SGP4-XP median | SGP4-XP mean | SGP4 median | SGP4 mean | SGP4-XP closer |');
  console.log('| --- | --: | --: | --: | --: | --: | --: |');
  for (const d of days) {
    const x = s[d];
    console.log(`| ${d.slice(3) === '0' ? '0 (the fit)' : d.slice(3)} | ${x.xp.n ?? 0} | ${km(x.xp.median)} | ${km(x.xp.mean)} | ${km(x.sgp4.median)} | ${km(x.sgp4.mean)} | ${pct(x.xpCloser)} |`);
  }
  console.log('');
  console.log('SGP4-XP on every window it fitted (including those SGP4 did not):');
  console.log('');
  console.log('| Day | n | median | mean | 90th percentile |');
  console.log('| --- | --: | --: | --: | --: |');
  for (const d of Object.keys(s.xpOnly)) {
    const x = s.xpOnly[d];
    console.log(`| ${d.slice(3) === '0' ? '0 (the fit)' : d.slice(3)} | ${x.n ?? 0} | ${km(x.median)} | ${km(x.mean)} | ${km(x.p90)} |`);
  }
  console.log('');
}
