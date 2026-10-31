// XM7, local, not committed: FFM against Orekit 13.1 on LEO400 W1 at the storm epochs, rows and Earth orientation as Orekit read them.
// A: the test wasm on rows with AP1..AP8 against Orekit switch 9 = -1. B: the test wasm on rows without them against switch 1.
// C: the pinned wasm against switch 1. D: the test wasm on rows with them against switch 1, the size of the effect.
import fs from 'node:fs';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { EOP, SPW, requestInputs, score } from '../../lib/orekitCases.mjs';

const [X, TEST, BASE] = process.argv.slice(2);
Object.assign(EOP, JSON.parse(fs.readFileSync(`${X}/eop-jan.json`, 'utf8')));
const all = JSON.parse(fs.readFileSync(`${X}/spw-jan.json`, 'utf8')).rows;
console.log('rows', all.length, 'keys', Object.keys(all[0]).filter((k) => /^AP/.test(k)).join(','), 'sample 01-19', JSON.stringify(all.find((r) => r.DATE.startsWith('2026-01-19'))).slice(0, 220));
const noAp = all.map((r) => ({ ...r, AP1: 0, AP2: 0, AP3: 0, AP4: 0, AP5: 0, AP6: 0, AP7: 0, AP8: 0 }));
const manifest = JSON.parse(fs.readFileSync(new URL('../../../plugin-manifest.json', import.meta.url), 'utf8'));
const run = async (wasmPath, rows, ref, maxStep) => {
  SPW.rows = rows;
  const c = JSON.parse(fs.readFileSync(ref, 'utf8')).cases[0];
  c.epochUtc = c.samples[0][7];
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct' });
  try {
    const response = await harness.invoke({ methodId: 'invoke', inputs: requestInputs(c, { maxStep }) });
    if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
    return score(c, response);
  } finally { harness.destroy(); }
};
for (const [stem] of [['2026-01-19-000000'], ['2026-01-20-120000'], ['2026-01-25-000000']]) {
  const m1 = `${X}/out-${stem}-s-1.json`, p1 = `${X}/out-${stem}-s1.json`;
  for (const maxStep of [300, 30]) {
    const A = await run(TEST, all, m1, maxStep), B = await run(TEST, noAp, p1, maxStep), C = await run(BASE, all, p1, maxStep), D = await run(TEST, all, p1, maxStep);
    const f = (x) => `${x.worst.toFixed(4)} m at ${x.worstAt / 3600} h`;
    console.log(`${stem} steps<=${maxStep}s A ${f(A)} | B ${f(B)} | C ${f(C)} | D ${f(D)}`);
  }
}
process.exit(0);
