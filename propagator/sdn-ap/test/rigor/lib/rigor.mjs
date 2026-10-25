// The rigor suite's frame: a check is one expert question with one specific outcome. Each prints the question,
// the evidence it found and PASS, FAIL or NOT-MEASURED (an input it reads is absent). JS only orchestrates the
// module and the black-box reference and computes test statistics: every state comes out of a WebAssembly module
// or the reference.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openModule } from "../../lib/module.mjs";
import { openReference } from "../../lib/oracle.mjs";
import { elementsOf } from "../../lib/tle.mjs";

export const REVIEWERS = Object.freeze({ HOOTS: "Hoots", VALLADO: "Vallado", KELSO: "Kelso" });

export class NotMeasured extends Error {}

/** A check: { id, reviewer, tier: "fast" | "full", question, source, run: async (ctx) => { pass, evidence: [lines] } }. */
export const defineCheck = (check) => Object.freeze(check);

/**
 * The SGP4-XP reference harness directory: SDN_AP_ORACLE_ROOT, else closed-modules origin/main
 * packages/sgp4-xp-oracle extracted (git archive, as the gauntlet's SDK checks do) from the stack named by
 * GAUNTLET_STACK_ROOT or SDN_STACK_ROOT into ~/.cache/sdn-gauntlet/sgp4-xp-oracle--<sha>. null when neither exists.
 */
export function oracleRoot() {
  if (process.env.SDN_AP_ORACLE_ROOT) return process.env.SDN_AP_ORACLE_ROOT;
  const stack = process.env.GAUNTLET_STACK_ROOT || process.env.SDN_STACK_ROOT;
  if (!stack) return null;
  const repo = path.join(stack, "repos/main-packages/space-data-network-closed-modules");
  if (!fs.existsSync(repo)) return null;
  let sha;
  try {
    sha = execFileSync("git", ["-C", repo, "rev-parse", "origin/main:packages/sgp4-xp-oracle"], { encoding: "utf8" }).trim();
  } catch { return null; }
  const dir = path.join(os.homedir(), ".cache/sdn-gauntlet", `sgp4-xp-oracle--${sha}`);
  if (!fs.existsSync(path.join(dir, "oracle.mjs"))) {
    const tmp = `${dir}.${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    execFileSync("sh", ["-c", `git -C "$1" archive "$2" | tar -x -C "$3"`, "sh", repo, sha, tmp]);
    if (fs.existsSync(dir)) fs.rmSync(tmp, { recursive: true, force: true }); else fs.renameSync(tmp, dir);
  }
  return dir;
}

/** The run's shared handles, opened on first use. */
export function context() {
  let module = null, reference = null;
  return {
    async module() { if (!module) module = await openModule(); return module; },
    async reference() {
      if (reference) return reference;
      const root = oracleRoot();
      if (!root) throw new NotMeasured("the SGP4-XP reference harness is absent (SDN_AP_ORACLE_ROOT, or GAUNTLET_STACK_ROOT with closed-modules)");
      process.env.SDN_AP_ORACLE_ROOT = root;
      reference = await openReference();
      return reference;
    },
    async close() { if (reference) await reference.close(); },
  };
}

export const hypot3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The module's states of every (set, time): one element row per sample. `rows` are element rows (module.mjs
 * elementRows fields), `times[k]` the minutes of row k. Returns [[{ ok, r, v }]] per row.
 */
export function moduleStates(module, rows, times) {
  const flat = [], minutes = [];
  rows.forEach((row, k) => times[k].forEach((t) => { flat.push(row); minutes.push(t); }));
  module.init(flat);
  const p = module.atMinutes(minutes);
  let j = 0;
  return rows.map((_, k) => times[k].map(() => {
    const out = { ok: p.status[j] === 0, r: [p.x[j], p.y[j], p.z[j]], v: [p.vx[j], p.vy[j], p.vz[j]] };
    j += 1;
    return out;
  }));
}

/**
 * Module against the black-box reference on two-line sets: per sample { set, t, both, onlyModule, onlyReference, dr (m) }.
 * `theoryOf(lines)` gives the element row (default: the set's own type, SGP4 or SGP4XP).
 */
export async function againstReference(ctx, sets, { rowOf = elementsOf } = {}) {
  const module = await ctx.module();
  const reference = await ctx.reference();
  const mine = moduleStates(module, sets.map((s) => rowOf(s.lines)), sets.map((s) => s.minutes));
  const samples = [];
  for (let k = 0; k < sets.length; k += 1) {
    const ref = await reference.propagate(sets[k].lines, sets[k].minutes);
    sets[k].minutes.forEach((t, j) => {
      const m = mine[k][j], o = ref ? ref[j] : null;
      const mOk = m.ok && m.r.every(Number.isFinite);
      samples.push({ set: sets[k], t, both: mOk && !!o, onlyModule: mOk && !o, onlyReference: !mOk && !!o,
        dr: mOk && o ? hypot3(m.r, o.r) * 1e3 : NaN });
    });
  }
  return samples;
}

/** Summary lines and the verdict of a reference comparison: every sample both answer within `limitM`, refusals the same. */
export function verdict(samples, limitM, label) {
  const both = samples.filter((s) => s.both);
  const worst = both.reduce((w, s) => (s.dr > w.dr ? s : w), { dr: 0 });
  const over = both.filter((s) => !(s.dr <= limitM));
  const mismatch = samples.filter((s) => s.onlyModule || s.onlyReference);
  const evidence = [
    `${label}: ${samples.length} samples, ${both.length} answered by both, ${mismatch.length} answered by one side only`,
    `worst ${worst.dr.toExponential(3)} m${worst.set ? ` (set ${worst.set.name || worst.set.lines[0].slice(2, 7)} at ${worst.t} min)` : ""}; limit ${limitM} m; ${over.length} over`,
    ...over.slice(0, 5).map((s) => `  over: ${s.set.name || s.set.lines[0].slice(2, 7)} t=${s.t} min ${s.dr.toExponential(3)} m`),
    ...Object.entries(mismatch.reduce((g, s) => {
      const key = `${s.set.name || s.set.lines[0].slice(2, 7)}: ${s.onlyModule ? "module answers, reference refuses" : "reference answers, module refuses"}`;
      (g[key] ||= []).push(s.t);
      return g;
    }, {})).slice(0, 8).map(([key, ts]) => `  one side: ${key} at ${ts.length} sample(s), ${ts[0]}..${ts.at(-1)} min`),
  ];
  return { pass: over.length === 0 && mismatch.length === 0, evidence };
}

export const days = (n, count) => Array.from({ length: count + 1 }, (_, k) => Math.round((k * n * 1440) / count * 1e3) / 1e3);
