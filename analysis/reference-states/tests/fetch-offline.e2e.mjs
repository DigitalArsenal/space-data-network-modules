// The truth fetch runs from a clean checkout, offline-proved (modules-reference-states-fetch-install-20261031).
//
//   node analysis/reference-states/tests/fetch-offline.e2e.mjs
//
// 1. Resolution: the module's install is the SDK and the standards it declares, and the harness frame import the fetch script
//    uses resolves from it (no test harness, no second install).
// 2. The plan: `--dry-run` for a fixed range lists every file the run would request or read for ESA finals (and the IGS final
//    they back up), DORIS, Sentinel-1 POEORB, ILRS and GFZ Kp, with the network trapped (a fetch call fails the run).
// 3. The conversion, offline: one spent day (ESA0OPSFIN 2024-09-24) read from the archive's cached products with --offline
//    gives, byte for byte, the 77 $OEM files and index.json the archive holds from the original fetch.
// Nothing is fetched. The backfill itself awaits the owner (question O5).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const script = path.join(root, 'scripts/fetch-reference-products.mjs');
const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).devDependencies;
const scratch = fs.mkdtempSync(path.join(process.env.SDN_SCRATCH ?? os.tmpdir(), 'fetch-offline-'));

// ── 1. resolution ──
const need = createRequire(path.join(root, 'package.json'));
for (const name of ['space-data-module-sdk', 'spacedatastandards.org']) {
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'))).version;
  assert.equal(installed, declared[name], `${name}: installed ${installed}, declared ${declared[name]}`);
}
await import('space-data-module-sdk/host/browser-module');
const standards = path.dirname(need.resolve('spacedatastandards.org/package.json'));
process.env.SPACE_DATA_STANDARDS_ROOT = standards;
const frames = await import(pathToFileURL(path.resolve(root, '../../data-source/eop-parser/tests/frames.mjs')).href);
const frame = frames.body(Buffer.from('x'));
assert.equal(frame.portId, 'body');
assert.equal(Buffer.from(frame.payload).toString('latin1', 4, 8), '$FIL', 'the body frame is one $FIL');
console.log(`resolution: SDK ${declared['space-data-module-sdk']}, standards ${declared['spacedatastandards.org']}, body frame $FIL`);

// ── 2. the dry-run plan on a fixed range, the network trapped ──
const trap = path.join(scratch, 'no-network.mjs');
fs.writeFileSync(trap, "globalThis.fetch = () => { throw new Error('network touched: fetch called'); };\n");
const archive = path.join(scratch, 'local-archive');
// DORIS and GFZ RSO arcs are read from the local archive: names only, laid out as the real one is.
const doris = path.join(archive, 'ids-doris', 'ssa');
fs.mkdirSync(doris, { recursive: true });
fs.writeFileSync(path.join(doris, 'ssacs220.b26240.e26248.D__.sp3.001.Z'), '');   // 2026 days 240-248: meets the range
fs.writeFileSync(path.join(doris, 'ssacs220.b26100.e26108.D__.sp3.001.Z'), '');   // 2026 days 100-108: does not
const out = path.join(scratch, 'out');
const run = (args) => JSON.parse(execFileSync(process.execPath, ['--import', trap, script, ...args], { encoding: 'utf8', env: { ...process.env, SPACE_DATA_STANDARDS_ROOT: standards } }));
const plan = run(['--from', '2026-09-01', '--to', '2026-09-03', '--products', 'gps,sentinel1,slr,swarm,doris,kp', '--dry-run', '--out', out, '--local-archive', archive]);
const pick = (f) => plan.entries.filter(f);
// ESA finals (the fallback behind the IGS final), by the GPS week (2434) and day of year (244-246) of 2026-09-01..03.
const gps = pick((e) => e.product === 'gps');
assert.deepEqual(gps.map((e) => [e.day, e.role, e.name]), [
  ['2026-09-01', 'download', 'IGS0OPSFIN_20262440000_01D_15M_ORB.SP3.gz'], ['2026-09-01', 'fallback', 'ESA0OPSFIN_20262440000_01D_05M_ORB.SP3.gz'],
  ['2026-09-02', 'download', 'IGS0OPSFIN_20262450000_01D_15M_ORB.SP3.gz'], ['2026-09-02', 'fallback', 'ESA0OPSFIN_20262450000_01D_05M_ORB.SP3.gz'],
  ['2026-09-03', 'download', 'IGS0OPSFIN_20262460000_01D_15M_ORB.SP3.gz'], ['2026-09-03', 'fallback', 'ESA0OPSFIN_20262460000_01D_05M_ORB.SP3.gz'],
]);
assert.equal(gps[1].url, 'https://navigation-office.esa.int/products/gnss-products/2434/ESA0OPSFIN_20262440000_01D_05M_ORB.SP3.gz');
assert.equal(gps[0].url, 'https://igs.bkg.bund.de/root_ftp/IGS/products/2434/IGS0OPSFIN_20262440000_01D_15M_ORB.SP3.gz');
assert.ok(gps.every((e) => e.cached === false), 'nothing is cached in a fresh out directory');
// Earth orientation and the satellite identities every conversion reads.
assert.deepEqual(pick((e) => e.product === 'eop' || e.product === 'igs-metadata').map((e) => e.name), ['eopc04.1962-now', 'igs_satellite_metadata.snx']);
// Sentinel-1 POEORB: one listing per unit and day, files valid from the day before.
const s1 = pick((e) => e.product === 'sentinel1');
assert.deepEqual(s1.map((e) => `${e.day} ${e.unit}`), ['2026-09-01', '2026-09-02', '2026-09-03'].flatMap((d) => ['S1A', 'S1C', 'S1D'].map((u) => `${d} ${u}`)));
assert.equal(s1[0].url, 'https://step.esa.int/auxdata/orbits/Sentinel-1/POEORB/S1A/2026/09/');
assert.equal(s1[0].validFrom, '2026-08-31');
// ILRS: the year listing once, then each satellite's arc directory for each day (taken where an arc ends that day).
const slr = pick((e) => e.product === 'slr');
assert.equal(slr[0].url, 'https://edc.dgfi.tum.de/pub/slr/products/orbits/TRF/lageos1/2026/');
assert.equal(slr.length, 1 + 3 * 4);
assert.equal(slr[1].url, 'https://edc.dgfi.tum.de/pub/slr/products/orbits/TRF/lageos1/2026/260901/');
// Swarm: reduced-dynamic and kinematic listings per satellite and day.
assert.equal(pick((e) => e.product === 'swarm').length, 3 * 3 * 2);
// DORIS: the local arc that meets the range, not the one that does not.
assert.deepEqual(pick((e) => e.product === 'doris').map((e) => e.name), ['ssacs220.b26240.e26248.D__.sp3.001.Z']);
// GFZ Kp: fetched by the space-weather collector, named in the plan.
const kp = pick((e) => e.product === 'kp');
assert.deepEqual(kp.map((e) => [e.role, e.name, e.url]), [['collector', 'Kp_ap_Ap_SN_F107_nowcast.txt', 'https://kp.gfz.de/fileadmin/files_for_gfz_cms/Kp_ap_Ap_SN_F107_nowcast.txt']]);
assert.ok(!fs.existsSync(out), 'a dry run writes nothing');
console.log(`dry-run: ${plan.entries.length} entries for 2026-09-01..2026-09-03 (gps ${gps.length}, sentinel1 ${s1.length}, slr ${slr.length}, swarm 18, doris 1, kp 1), network trapped, nothing written`);

// ── 3. one spent day converted offline, byte for byte against the archive ──
const archived = '/opt/data/sdn-archive/reference-states';
const key = 'ESA0OPSFIN_20242680000_01D_05M_ORB';
assert.ok(fs.existsSync(path.join(archived, 'reference', key)), `the archive's ${key} is missing`);
const cache = path.join(scratch, 'convert');
fs.mkdirSync(path.join(cache, 'products'), { recursive: true });
for (const f of [`${key}.SP3.gz`, 'eopc04.1962-now', 'igs_satellite_metadata.snx'])
  fs.symlinkSync(path.join(archived, 'products', f), path.join(cache, 'products', f));
execFileSync(process.execPath, ['--import', trap, script, '--from', '2024-09-24', '--to', '2024-09-24', '--products', 'gps', '--offline', '--out', cache],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPACE_DATA_STANDARDS_ROOT: standards } });
const want = fs.readdirSync(path.join(archived, 'reference', key)).sort(), got = fs.readdirSync(path.join(cache, 'reference', key)).sort();
assert.deepEqual(got, want, 'the same files');
let bytes = 0;
for (const f of want) {
  const a = fs.readFileSync(path.join(archived, 'reference', key, f)), b = fs.readFileSync(path.join(cache, 'reference', key, f));
  assert.ok(a.equals(b), `${f} differs from the archive`);
  bytes += a.length;
}
assert.equal(want.filter((f) => f.endsWith('.oem')).length, 77);
console.log(`conversion: ${key} offline, ${want.length} files (77 $OEM + index.json), ${bytes} bytes, byte-identical to the archive`);
fs.rmSync(scratch, { recursive: true, force: true });
console.log('PASS');
