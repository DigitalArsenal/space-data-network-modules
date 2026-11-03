// XP2F: configuration, the registration guard (PLAN.md and config.json as registered, amendments only at the plan's end), the run's own sources committed, XM's and XM3's
// code unchanged at their commits, XM's config set in process to this store, these creation days and the normalized RSGA folder, and the windows. Everything else is XM's.
// XP2F_CONTROL=1 leaves XM's config and store alone: the spent-window control, which reads only XM's windows.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const dir = path.dirname(new URL(import.meta.url).pathname);
export const root = path.resolve(dir, '../..');
export const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
export const build = JSON.parse(fs.readFileSync(path.join(root, config.build.file)));
export const control = process.env.XP2F_CONTROL === '1';
export const store = process.env.XP2F_STORE ?? config.store;
export const results = process.env.XP2F_RESULTS ?? path.join(root, 'results/xp2-fit-design');
const git = (...a) => execFileSync('git', ['-C', root, ...a], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
const here = 'experiments/xp2-fit-design';

/** The registration commit, pushed to origin wip/<task>/registration before any score. */
export const REGISTRATION = '60fb94a617dd63b8313e8d4ea41899aa844384c6';

// Vendored copy (propagator/sdn-ap/test/vendor PROVENANCE.md): the xm and xm3 directories are pinned by SHA-256 there.
if (control) delete process.env.XM_STORE; else process.env.XM_STORE = store;
export const XM = await import(path.join(root, config.xm.dir, 'common.mjs'));
if (!control) {
  XM.build.modulesCommit = build.modulesCommit;                                      // every XM wasm is byte-identical there; pinned() checks each SHA-256
  XM.config.public.creationDays = config.public.creationDays;
  XM.config.spaceWeather.rsgaDirs = [path.join(store, 'rsga/normalized')];
}
export const { DAY, HOUR, iso, ms, dateOf, daysOf, isoWeek, rms, median, sha256, write, appendJsonl, readJsonl, args } = XM;

/** PLAN.md and config.json as registered: every step that reads registered data runs only then. An amendment goes at the plan's end. */
export function frozen() {
  if (!config.frozen) throw new Error('the plan is not frozen');
  const plan = git('show', `${REGISTRATION}:${here}/PLAN.md`), now = fs.readFileSync(path.join(dir, 'PLAN.md'));
  if (now.length < plan.length || !now.subarray(0, plan.length).equals(plan)) throw new Error(`PLAN.md differs from the registration ${REGISTRATION}; an amendment goes at its end`);
  for (const f of ['config.json', 'build.json']) if (!git('show', `${REGISTRATION}:${here}/${f}`).equals(fs.readFileSync(path.join(dir, f)))) throw new Error(`${f} differs from the registration ${REGISTRATION}`);
}

/** A file as committed: at HEAD once the experiment is on main, until then at the runner's wip commit. null when neither holds it. */
export function committed(rel) {
  for (const ref of ['HEAD', `${config.wipRefPrefix}/runner`]) {
    try { return git('show', `${ref}:${rel}`); } catch { /* the next ref */ }
  }
  return null;
}
export const SOURCES = ['run.mjs', 'table.mjs', 'common.mjs', 'prepare.mjs', 'fetch-swarm.mjs', 'lib/rsga.mjs', 'lib/rso.mjs', 'lib/sgp4fit.mjs'];
/** The run's sources: a scored run and the check use committed sources only; their SHA-256 go in every row. */
export function sourcesCommitted() {
  const out = {};
  for (const file of SOURCES) {
    const rel = `${here}/${file}`, bytes = fs.readFileSync(path.join(dir, file)), got = committed(rel);
    if (!got) throw new Error(`${rel} is not committed`);
    if (!got.equals(bytes)) throw new Error(`${rel} differs from its commit; commit it before a scored run`);
    out[file] = sha256(bytes);
  }
  return out;
}

const OBJECTS = new Map(config.objects.map((o) => [o.norad, o]));
export const objectOf = (norad) => OBJECTS.get(Number(norad));
/** Every registered window of a span: { key, span, o, date, cutoffMs }. */
export function windows(span) {
  const s = config.spans[span], out = [];
  for (const t of daysOf(s.from, s.to)) for (const n of s.objects) out.push({ key: `P|${n}|${dateOf(t)}`, span, o: objectOf(n), date: dateOf(t), cutoffMs: t });
  return out;
}
export const spanOfDate = (date) => Object.keys(config.spans).find((k) => date >= config.spans[k].from && date <= config.spans[k].to) ?? null;
