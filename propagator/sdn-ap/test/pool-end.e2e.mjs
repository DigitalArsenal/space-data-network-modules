#!/usr/bin/env node
// SPEC 9: the pool's threads wait for batches for the life of the instance and the module has no export that stops them. A Node process that started a
// pool ends when the host destroys the instance's harness (it terminates the wasi-thread workers), and stays alive when it does not.
// Two child processes start four pool threads on the module under test (SDNAP_WASM, or the committed dist):
//  - ended by test/lib/end.mjs (the harness destroyed): the child exits by itself with status 0 within 15 s, without the helper's deadline firing;
//  - left alone: the child is still alive 8 s after its script ended; the test stops it by its own process id.
//   node test/pool-end.e2e.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openModule } from "./lib/module.mjs";
import { endTest } from "./lib/end.mjs";

if (process.argv[2] === "child") {
  const m = await openModule({ threads: 4 });
  console.log(`running ${m.threads}`);
  if (process.argv[3] === "end") await endTest(0);
} else {
  const run = (mode) => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child", mode], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const t0 = Date.now();
    let aliveAfterScript = null;
    const probe = setTimeout(() => { aliveAfterScript = child.exitCode === null && child.signalCode === null; if (mode === "alone" && aliveAfterScript) child.kill("SIGTERM"); }, mode === "alone" ? 8000 : 15000);
    child.on("close", (code, signal) => { clearTimeout(probe); resolve({ code, signal, out, err, aliveAfterScript, seconds: (Date.now() - t0) / 1000 }); });
  });
  const ended = await run("end");
  assert.match(ended.out, /running 4/, `the child started four pool threads: ${ended.out}${ended.err}`);
  assert.equal(ended.code, 0, `the child ended by endTest exits with status 0: ${ended.err}`);
  assert.equal(ended.aliveAfterScript, null, "the child ended by endTest is gone before the 15 s probe");
  assert.ok(!/still alive/.test(ended.err), `the helper's deadline did not fire: ${ended.err}`);
  const alone = await run("alone");
  assert.match(alone.out, /running 4/, "the control child started four pool threads");
  assert.equal(alone.aliveAfterScript, true, "a child that started a pool and destroyed nothing is still alive 8 s after its script ended");
  console.log(`POOL-END PASS: destroying the harness ended a process with four pool threads in ${ended.seconds.toFixed(1)} s; the control with nothing destroyed was still alive after 8 s`);
  await endTest(0);
}
