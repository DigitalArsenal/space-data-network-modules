// XM-fast: configuration, the frozen-plan guard (PLAN.md, config.json and build.json committed unchanged; the run's own
// sources committed for a scored run), the modules checkout with every wasm pinned to build.json, the store and helpers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const dir = path.dirname(new URL(import.meta.url).pathname);
export const root = path.resolve(dir, '../..');
export const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
export const build = JSON.parse(fs.readFileSync(path.join(root, config.build.file)));
export const store = process.env.XM_STORE ?? config.store;
export const results = path.join(root, 'results/xp-atmosphere-merit');
export const g1Dir = path.join(root, 'experiments/sdn-gp-starlink-ffm-match');
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const DAY = 86400000;
export const HOUR = 3600000;
export const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { maxBuffer: 1 << 28 });

/** PLAN.md, config.json and build.json committed and unchanged: every step that reads data runs only then. */
export function frozen() {
  if (!config.frozen) throw new Error('the plan is not frozen');
  for (const rel of ['experiments/xp-atmosphere-merit/PLAN.md', 'experiments/xp-atmosphere-merit/config.json', config.build.file]) {
    const committed = git(root, 'show', `HEAD:${rel}`);
    if (!committed.equals(fs.readFileSync(path.join(root, rel)))) throw new Error(`commit the frozen ${rel} before data access`);
  }
}

/** The run's sources: a scored run and the check use committed sources only; their SHA-256 go in every row. */
export const SOURCES = ['run.mjs', 'table.mjs', 'common.mjs', 'lib/modules.mjs', 'lib/sds.mjs', 'lib/truth.mjs', 'lib/weather.mjs', 'lib/dca.mjs', 'lib/public.mjs'];
export function sourcesCommitted() {
  const out = {};
  for (const file of SOURCES) {
    const rel = `experiments/xp-atmosphere-merit/${file}`, bytes = fs.readFileSync(path.join(dir, file));
    let committed;
    try { committed = git(root, 'show', `HEAD:${rel}`); } catch { throw new Error(`${rel} is not committed`); }
    if (!committed.equals(bytes)) throw new Error(`${rel} differs from HEAD; commit it before a scored run`);
    out[file] = sha256(bytes);
  }
  return out;
}

/** The modules checkout (SDN_MODULES_ROOT, else the stack's canonical one): it holds build.json's commit, its host files equal
 *  that commit and its installed packages are the registered versions. Wasm never comes from its working tree (pinned()). */
let modulesCache = null;
export function modulesRoot() {
  if (modulesCache) return modulesCache;
  const candidate = path.resolve(process.env.SDN_MODULES_ROOT ?? path.join(root, '../../main-packages/space-data-network-modules'));
  try { git(candidate, 'cat-file', '-e', `${build.modulesCommit}^{commit}`); } catch { throw new Error(`modules checkout ${candidate} lacks the registered commit ${build.modulesCommit}`); }
  try { git(candidate, 'diff', '--quiet', build.modulesCommit, '--', ...build.hostFiles.paths); } catch { throw new Error(`${build.hostFiles.paths.join(', ')} in ${candidate} differ from ${build.modulesCommit}`); }
  for (const [rel, packages] of Object.entries(build.packages)) for (const [name, want] of Object.entries(packages)) {
    const got = JSON.parse(fs.readFileSync(path.join(candidate, rel, 'node_modules', name, 'package.json'), 'utf8')).version;
    if (got !== want) throw new Error(`${rel}: ${name} ${got} is installed, registered ${want}`);
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
export const iso = (t) => new Date(Math.round(t)).toISOString();
export const ms = (text) => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
export const dateOf = (t) => new Date(t).toISOString().slice(0, 10);
export const dayStart = (t) => Date.parse(`${dateOf(t)}T00:00:00Z`);
/** The UTC days from `from` to `to` (YYYY-MM-DD, inclusive), as millisecond midnights. */
export function daysOf(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(t);
  return out;
}
/** The ISO 8601 week of a UTC time: "YYYY-Www". */
export function isoWeek(t) {
  const d = new Date(dayStart(t));
  const day = (d.getUTCDay() + 6) % 7;                     // Monday 0
  d.setUTCDate(d.getUTCDate() - day + 3);                  // the week's Thursday
  const year = d.getUTCFullYear(), jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - jan4) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
export const median = (v) => { const a = v.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const k = Math.floor(a.length / 2); return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2; };
export const rms = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);
