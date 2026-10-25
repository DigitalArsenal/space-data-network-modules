#!/usr/bin/env node
// The SDN-AP rigor suite (sdn-ap-expert-rigor-suite-20261025; owner 2026-10-25: "write a series of rigor tests like
// you are TS Kelso or Dave Vallado or Felix Hoots to make sure every edit, every idea we are using passes muster").
// Each check is one E2E for one specific outcome; it prints the expert question it answers and the evidence it found.
//
//   node test/rigor/run.mjs [--tier fast|full] [--only id[,id...]] [--json FILE]
//
// --tier fast (the gauntlet tier, under its 5 min budget) runs the fast checks; full (nightly) runs every check.
// Every check runs in its own child process under a time cap (a module that never returns is a FAIL with that
// evidence, not a hung gate). known-failures.json lists failures already filed as tasks: such a check prints
// KNOWN-FAIL and its task and does not vote; a listed check that passes is a FAIL until its entry is removed, so the
// list only shrinks.
// Exit 0: no voting failure; 1: a check failed; 3: none failed but one could not measure (an input absent).
// The reference checks need the SGP4-XP harness (SDN_AP_ORACLE_ROOT, or GAUNTLET_STACK_ROOT / SDN_STACK_ROOT naming
// the stack whose closed-modules checkout holds it; lib/rigor.mjs oracleRoot).
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { checks as hoots } from "./hoots.mjs";
import { checks as vallado } from "./vallado.mjs";
import { checks as kelso } from "./kelso.mjs";
import { context, NotMeasured } from "./lib/rigor.mjs";

const SELF = fileURLToPath(import.meta.url);
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const all = [...hoots, ...vallado, ...kelso];
const ids = new Set(all.map((c) => c.id));
if (ids.size !== all.length) throw new Error("duplicate check id");

// --- one check in this process (the child)
const childId = arg("--child", null);
if (childId) {
  const c = all.find((k) => k.id === childId);
  const ctx = context();
  let result;
  try {
    result = await c.run(ctx);
    result.status = result.pass ? "PASS" : "FAIL";
  } catch (error) {
    result = error instanceof NotMeasured
      ? { status: "NOT-MEASURED", evidence: [error.message] }
      : { status: "FAIL", evidence: [`threw: ${error.stack || error}`] };
  }
  await ctx.close();
  process.stdout.write(`RIGOR-RESULT ${JSON.stringify({ status: result.status, evidence: result.evidence || [] })}\n`);
  process.exit(0);
}

const tier = arg("--tier", "full");
const only = arg("--only", null)?.split(",");
const jsonOut = arg("--json", null);
if (!["fast", "full"].includes(tier)) { console.error("--tier fast|full"); process.exit(2); }
for (const id of only || []) if (!ids.has(id)) { console.error(`unknown check ${id}`); process.exit(2); }
const known = JSON.parse(fs.readFileSync(new URL("./known-failures.json", import.meta.url), "utf8")).failures;
for (const id of Object.keys(known)) if (!ids.has(id)) { console.error(`known-failures.json names no check ${id}`); process.exit(2); }
const selected = all.filter((c) => (only ? only.includes(c.id) : tier === "full" || c.tier === "fast"));

/** The check in a child process; its whole process group is stopped at the cap. */
function runChild(c) {
  const capSec = c.timeoutSec || (c.tier === "fast" ? 90 : 900);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, "--child", c.id], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "", err = "", timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, capSec * 1e3);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.startsWith("RIGOR-RESULT "));
      if (line) return resolve(JSON.parse(line.slice(13)));
      resolve({ status: "FAIL", evidence: [timedOut ? `no result within ${capSec} s: the module (or the reference) did not return; process group stopped` : `child exited ${code} without a result: ${err.trim().split("\n").slice(-3).join(" | ")}`] });
    });
  });
}

const results = [];
const started = performance.now();
for (const c of selected) {
  const t0 = performance.now();
  console.log(`\n=== ${c.id} (${c.reviewer}, ${c.tier})`);
  console.log(`QUESTION: ${c.question}`);
  console.log(`SOURCE:   ${c.source}`);
  const result = await runChild(c);
  for (const line of result.evidence) console.log(`EVIDENCE: ${line}`);
  const entry = known[c.id];
  if (entry && result.status === "FAIL") result.status = "KNOWN-FAIL";
  else if (entry && result.status === "PASS") { result.status = "FAIL"; console.log(`EVIDENCE: listed in known-failures.json (task ${entry.task}) but passes: remove the entry`); }
  if (entry) console.log(`KNOWN:    ${entry.task}: ${entry.summary}`);
  const seconds = (performance.now() - t0) / 1e3;
  console.log(`RESULT:   ${result.status} (${seconds.toFixed(1)} s)`);
  results.push({ id: c.id, reviewer: c.reviewer, tier: c.tier, question: c.question, source: c.source, status: result.status, task: entry?.task, evidence: result.evidence, seconds });
}

const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\nRIGOR ${only ? "selected" : tier}: ${results.length} checks, ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("KNOWN-FAIL")} KNOWN-FAIL, ${count("NOT-MEASURED")} NOT-MEASURED in ${((performance.now() - started) / 1e3).toFixed(1)} s`);
for (const r of results) console.log(`  ${r.status.padEnd(12)} ${r.reviewer.padEnd(8)} ${r.id}${r.task ? ` (${r.task})` : ""}`);
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify({ tier, created: new Date().toISOString(), results }, null, 1)}\n`);
process.exit(count("FAIL") ? 1 : count("NOT-MEASURED") ? 3 : 0);
