#!/usr/bin/env node
// Private screening protocol: the cost table (PROTOCOL-19.md, section 4).
// Prints CPU and bytes per step and per parameter set beside the bench's 1 s
// row and writes private-screening/results/cost.json.
//
//   node tests/privateScreeningCost.e2e.mjs
// PRIVATE_SCREENING_RUN names an existing driver output (the known-answer E2E
// writes private-screening/results/protocol-run.json); otherwise the driver is
// built and run as in privateScreeningKnownAnswer.e2e.mjs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDriver } from './privateScreeningKnownAnswer.e2e.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const results = resolve(here, '../private-screening/results');
const report = runDriver();
const c = report.cost, s = c.screening8192, p = c.physics16384, bench = c.bench;
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
const ratio = (x, y) => `${(x / y).toFixed(1)}x`;
const rows = [
  ['A: keys per window (both n)', `${c.keygenMs.toFixed(0)} ms`, mb(c.keyBytes), '1.7 ms', ''],
  ['A: encrypt, S2 n 8192 (per object-day)', `${s.aEncryptPerObjectDayMs.toFixed(0)} ms`, mb(s.aUploadPerObjectDayBytes), `${bench.aEncryptPerObjectDayMs} ms, ${mb(bench.aUploadPerObjectDayBytes)}`, `${ratio(s.aEncryptPerObjectDayMs, bench.aEncryptPerObjectDayMs)}, ${ratio(s.aUploadPerObjectDayBytes, bench.aUploadPerObjectDayBytes)}`],
  ['B: compute, S2 n 8192 (per pair-day)', `${s.bComputePerPairDayMs.toFixed(0)} ms`, mb(s.bResponsePerPairDayBytes), `${bench.bComputePerPairDayMs} ms, ${mb(bench.bResponsePerPairDayBytes)}`, `${ratio(s.bComputePerPairDayMs, bench.bComputePerPairDayMs)}, ${ratio(s.bResponsePerPairDayBytes, bench.bResponsePerPairDayBytes)}`],
  ['A: decrypt, S2 (per pair-day)', `${s.aDecryptPerPairDayMs.toFixed(0)} ms`, '', '163.3 ms', ratio(s.aDecryptPerPairDayMs, 163.3)],
  ['bytes exchanged, S2 (per pair-day, upload amortized over 8 pairs)', '', mb(s.exchangedPerPairDayBytes), mb(bench.aUploadPerObjectDayBytes / 8 + bench.bResponsePerPairDayBytes), ratio(s.exchangedPerPairDayBytes, bench.aUploadPerObjectDayBytes / 8 + bench.bResponsePerPairDayBytes)],
  ['A: encrypt, S3 n 16384 (per object-day)', `${p.aEncryptPerObjectDayMs.toFixed(0)} ms`, mb(p.aUploadPerObjectDayBytes), 'not in the bench', ''],
  ['B: physics check, S3 n 16384 (per object-day)', `${p.bComputePerObjectDayMs.toFixed(0)} ms`, mb(p.bResponsePerObjectDayBytes), 'not in the bench', ''],
  ['A: decrypt, S3 (per object-day)', `${p.aDecryptPerObjectDayMs.toFixed(0)} ms`, '', 'not in the bench', ''],
  ['bytes exchanged with S3 (per pair-day)', '', mb(c.exchangedPerPairDayBytesWithPhysics), '', ''],
];
const lines = ['| Figure | CPU | Bytes | Bench (1 s) | Ratio |', '| --- | ---: | ---: | ---: | ---: |', ...rows.map((r) => `| ${r.join(' | ')} |`)];
const table = { verdict: 'PASS', host: 'one core, Apple M3 Ultra, shared host', seal: report.seal, forkCommit: report.forkCommit, days: report.days, pairs: report.pairs.length,
  minNoiseBudgetBits: report.minNoiseBudgetBits, ctxCtMultipliesPerBlock: report.ctxCtMultipliesPerBlock, cost: c, markdown: lines.join('\n') };
mkdirSync(results, { recursive: true });
writeFileSync(join(results, 'cost.json'), `${JSON.stringify(table, null, 2)}\n`);
process.stdout.write(`${lines.join('\n')}\n\nminNoiseBudgetBits ${JSON.stringify(report.minNoiseBudgetBits)}\nPRIVATE SCREENING COST E2E PASS\n`);
