// node tests/measure/resummarize.mjs results/<source>.json ... : recomputes each file's summary from its rows
// (when summary.mjs changes, or to read a result file written by an older run).
import fs from 'node:fs';
import { summarize } from './lib/summary.mjs';

for (const file of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  r.summary = summarize(r.rows, r.leads);
  fs.writeFileSync(file, `${JSON.stringify(r, null, 1)}\n`);
  console.log(`${file}: ${r.rows.length} windows`);
}
