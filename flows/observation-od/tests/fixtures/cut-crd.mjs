#!/usr/bin/env node
// Cuts the two-day fixture from EDC's monthly Starlette CRD v2 file: every pass (h1 to h8, verbatim) whose h4 session
// starts at or after FROM and ends at or before TO, at a pad the SINEX fixture holds (7403, Arequipa, is not in
// ilrsa.pos+eop.260718.v90), then the file's closing H9. Text selection only.
//   node tests/fixtures/cut-crd.mjs <starlette_202607.np2> > tests/fixtures/starlette-20260713T15-20260715T15.np2
import fs from 'node:fs';
const FROM = Date.UTC(2026, 6, 13, 15), TO = Date.UTC(2026, 6, 15, 15);
const lines = fs.readFileSync(process.argv[2], 'latin1').split('\n');
const out = [];
const NO_COORDINATES = new Set(['7403']);
let pass = null, keep = false, pad = '';
for (const line of lines) {
  const rec = line.slice(0, 2).toLowerCase();
  if (rec === 'h1') { pass = [line]; keep = false; continue; }
  if (rec === 'h9') { out.push(line); break; }
  if (!pass) continue;
  pass.push(line);
  if (rec === 'h2') pad = line.trim().split(/\s+/)[2];
  if (rec === 'h4') {
    const f = line.trim().split(/\s+/).map(Number);
    const start = Date.UTC(f[2], f[3] - 1, f[4], f[5], f[6], f[7]), end = Date.UTC(f[8], f[9] - 1, f[10], f[11], f[12], f[13]);
    keep = start >= FROM && end <= TO && !NO_COORDINATES.has(pad);
  }
  if (rec === 'h8') { if (keep) out.push(...pass); pass = null; }
}
process.stdout.write(`${out.join('\n')}\n`);
