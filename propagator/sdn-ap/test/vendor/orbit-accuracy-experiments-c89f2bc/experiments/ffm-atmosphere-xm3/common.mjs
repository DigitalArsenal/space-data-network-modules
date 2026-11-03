// XM3: configuration, the frozen-plan guard (PLAN.md, config.json and build.json committed unchanged; the run's own sources
// committed for a scored run), XM's code unchanged at its commit, XM's and XM2's stored rows (read only, digests checked), XM2's
// committed table (git show, SHA-256 checked), the modules checkout with every wasm pinned to build.json, the harness files SHA-256
// checked, the store and helpers. XM2's common.mjs (2f75aba) is the pattern; XM's own helpers (times, ISO weeks, RMS) are reused
// unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const dir = path.dirname(new URL(import.meta.url).pathname);
export const root = path.resolve(dir, '../..');
export const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
export const build = JSON.parse(fs.readFileSync(path.join(root, config.build.file)));
export const store = process.env.XM3_STORE ?? config.store;
export const results = path.join(root, 'results/ffm-atmosphere-xm3');
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { maxBuffer: 1 << 28 });

/** XM's code is imported unchanged: experiments/xp-atmosphere-merit equals the registered XM commit. */
export function xmUnchanged() {
  try { git(root, 'diff', '--quiet', config.xm.commit, '--', config.xm.dir); } catch { throw new Error(`${config.xm.dir} differs from XM's commit ${config.xm.commit}`); }
}
// Vendored copy (propagator/sdn-ap/test/vendor PROVENANCE.md): XM's directory is pinned by SHA-256 there.
export const { DAY, HOUR, iso, ms, dateOf, daysOf, isoWeek, rms, median } = await import(path.join(root, config.xm.dir, 'common.mjs'));

/** PLAN.md, config.json and build.json committed and unchanged: every step that reads registered data runs only then. */
export function frozen() {
  if (!config.frozen) throw new Error('the plan is not frozen');
  for (const rel of ['experiments/ffm-atmosphere-xm3/PLAN.md', 'experiments/ffm-atmosphere-xm3/config.json', config.build.file]) {
    let committed;
    try { committed = git(root, 'show', `HEAD:${rel}`); } catch { throw new Error(`commit the frozen ${rel} before data access`); }
    if (!committed.equals(fs.readFileSync(path.join(root, rel)))) throw new Error(`commit the frozen ${rel} before data access`);
  }
}

/** The run's sources: a scored run and the check use committed sources only; their SHA-256 go in every row. */
export const SOURCES = ['run.mjs', 'table.mjs', 'common.mjs', 'lib/ffm.mjs'];
export function sourcesCommitted() {
  const out = {};
  for (const file of SOURCES) {
    const rel = `experiments/ffm-atmosphere-xm3/${file}`, bytes = fs.readFileSync(path.join(dir, file));
    let committed;
    try { committed = git(root, 'show', `HEAD:${rel}`); } catch { throw new Error(`${rel} is not committed`); }
    if (!committed.equals(bytes)) throw new Error(`${rel} differs from HEAD; commit it before a scored run`);
    out[file] = sha256(bytes);
  }
  return out;
}

/** The harness files the F arms run through, at their registered SHA-256. */
export function harnessChecked() {
  for (const [rel, want] of Object.entries(build.harness.sha256)) {
    const got = sha256(fs.readFileSync(path.join(root, rel)));
    if (got !== want) throw new Error(`${rel} is ${got}, registered ${want}`);
  }
}

/** The modules checkout (SDN_MODULES_ROOT, else the stack's canonical one): it holds build.json's commit and its host files equal
 *  that commit and their registered SHA-256. Wasm never comes from its working tree (pinned()). */
let modulesCache = null;
export function modulesRoot() {
  if (modulesCache) return modulesCache;
  const candidate = path.resolve(process.env.SDN_MODULES_ROOT ?? path.join(root, '../../main-packages/space-data-network-modules'));
  try { git(candidate, 'cat-file', '-e', `${build.modulesCommit}^{commit}`); } catch { throw new Error(`modules checkout ${candidate} lacks the registered commit ${build.modulesCommit}`); }
  try { git(candidate, 'diff', '--quiet', build.modulesCommit, '--', ...build.hostFiles.paths); } catch { throw new Error(`${build.hostFiles.paths.join(', ')} in ${candidate} differ from ${build.modulesCommit}`); }
  for (const [rel, want] of Object.entries(build.hostFiles.sha256)) {
    const got = sha256(fs.readFileSync(path.join(candidate, rel)));
    if (got !== want) throw new Error(`${rel} is ${got}, registered ${want}`);
  }
  modulesCache = candidate;
  return candidate;
}

/** A module's wasm and manifest at build.json's commit (git show), SHA-256 checked, kept under <store>/build/<commit>/<module>:
 *  { file, bytes, manifest }. */
export function pinned(modules, rel) {
  const want = build.wasmSha256[rel];
  if (!want) throw new Error(`${rel} is not in build.json`);
  const out = path.join(store, 'build', build.modulesCommit, rel);
  const file = path.join(out, 'module.wasm'), manifestFile = path.join(out, 'plugin-manifest.json');
  const atomic = (target, bytes) => { const temp = `${target}.${process.pid}.tmp`; fs.writeFileSync(temp, bytes); fs.renameSync(temp, target); };
  if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== want || !fs.existsSync(manifestFile)) {
    const bytes = git(modules, 'show', `${build.modulesCommit}:${rel}/dist/isomorphic/module.wasm`);
    if (sha256(bytes) !== want) throw new Error(`${rel} at ${build.modulesCommit} is ${sha256(bytes)}, registered ${want}`);
    fs.mkdirSync(out, { recursive: true });
    atomic(file, bytes);
    atomic(manifestFile, git(modules, 'show', `${build.modulesCommit}:${rel}/plugin-manifest.json`));
  }
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== want) throw new Error(`${file} is not the registered ${want}`);
  return { file, bytes, manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')) };
}

/** A row without its run-dependent fields (timing, sources, build): the form every digest and exact comparison uses (XM2's). */
export const comparable = (r) => JSON.stringify({ ...r, timing: undefined, sources: undefined, build: undefined });

/** XM's stored rows (read only), one per key, their digest checked against config.xm.rowsDigest (XM2's xmRows). */
export function xmRows() {
  const dirXm = path.join(config.xm.store, 'rows');
  const byKey = new Map();
  for (const f of fs.readdirSync(dirXm).filter((x) => x.endsWith('.jsonl')).sort()) for (const r of readJsonl(path.join(dirXm, f))) if (!byKey.has(r.key)) byKey.set(r.key, r);
  const rows = [...byKey.values()].sort((x, y) => (x.key < y.key ? -1 : 1));
  const digest = sha256(rows.map(comparable).join('\n'));
  if (!digest.startsWith(config.xm.rowsDigest)) throw new Error(`XM's stored rows digest ${digest.slice(0, 12)} is not the registered ${config.xm.rowsDigest}`);
  return byKey;
}

/** XM2's stored rows, primary (A1): its registered O rows with each window of O.A1.jsonl in place (XM2 table.mjs storedRows('A1')),
 *  read only, their digest checked against config.xm2.rowsDigest; a Map by key. */
export function xm2Rows() {
  const dirXm2 = path.join(config.xm2.store, 'rows');
  const byId = new Map();
  for (const f of fs.readdirSync(dirXm2).filter((x) => /^[OM]\.s\d+\.jsonl$/.test(x)).sort()) for (const r of readJsonl(path.join(dirXm2, f))) { const id = `${r.condition}|${r.key}`; if (!byId.has(id)) byId.set(id, r); }
  for (const c of ['O', 'M']) for (const r of readJsonl(path.join(dirXm2, `${c}.A1.jsonl`))) { const id = `${r.condition}|${r.key}`; if (byId.has(id)) byId.set(id, r); }
  const rows = [...byId.values()].sort((x, y) => (`${x.condition}|${x.key}` < `${y.condition}|${y.key}` ? -1 : 1));
  const digest = sha256(rows.map(comparable).join('\n'));
  if (!digest.startsWith(config.xm2.rowsDigest)) throw new Error(`XM2's stored rows digest ${digest.slice(0, 12)} is not the registered ${config.xm2.rowsDigest}`);
  return new Map(rows.filter((r) => r.condition === 'O').map((r) => [r.key, r]));
}

/** XM2's committed table (git show at config.xm2.commit), SHA-256 checked. */
export function xm2Table() {
  const bytes = git(root, 'show', `${config.xm2.commit}:${config.xm2.table.path}`);
  if (sha256(bytes) !== config.xm2.table.sha256) throw new Error(`XM2's ${config.xm2.table.path} at ${config.xm2.commit} is not the registered ${config.xm2.table.sha256}`);
  return JSON.parse(bytes.toString('utf8'));
}

export function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}
export function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}
export const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
