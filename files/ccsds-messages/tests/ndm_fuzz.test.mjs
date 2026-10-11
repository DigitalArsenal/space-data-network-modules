// ndm_fuzz.test.mjs — whatever the engine reads, it writes, and what it writes it reads back as the very
// same record; whatever it does not read it refuses by name. tests/ndm_fuzz.cpp mutates every fixture, in KVN
// and in XML, thousands of times and checks that against the engine built natively with the address and
// undefined-behaviour sanitizers (when the host compiler has them): the corpus is the fixtures, the oracle
// is the engine's own reader, and the failures it prints are mutated messages kept in a directory.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FlatcRunner } from "flatc-wasm";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const compiler = ["clang++", "c++"].find((c) => spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0);
const skip = !compiler && "no host c++ compiler";
const ROUNDS = 150;

test("every mutated fixture is refused by name or read, written in both syntaxes and read back as the same record", { skip }, async (t) => {
  const work = mkdtempSync(path.join(tmpdir(), "ndm-fuzz-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const runtime = path.join(work, "fb");
  const runner = await FlatcRunner.init();
  for (const [name, contents] of Object.entries(runner.getEmbeddedRuntime("cpp"))) {
    const target = path.join(runtime, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  const include = ["-std=c++17", "-O1", "-g", "-I", path.join(packageRoot, "src"), "-I", path.join(packageRoot, "src", "generated", "sds"),
    "-I", path.join(packageRoot, "third_party", "pugixml"), "-I", runtime, "-I", here, path.join(here, "ndm_fuzz.cpp")];
  const binary = path.join(work, "ndm_fuzz");
  const sanitized = spawnSync(compiler, [...include, "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined", "-o", binary], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (sanitized.status !== 0) execFileSync(compiler, [...include, "-o", binary], { stdio: "pipe", maxBuffer: 16 * 1024 * 1024 });

  const failures = path.join(work, "failures");
  mkdirSync(failures);
  const r = spawnSync(binary, [String(ROUNDS), path.join(packageRoot, "fixtures"), failures], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}\n${readdirSync(failures).join(" ")}`);
  const outcome = (name) => Number((new RegExp(`^\\s+${name}\\s+(\\d+)$`, "m").exec(r.stdout) ?? [0, 0])[1]);
  assert.equal(readdirSync(failures).length, 0);
  assert.ok(outcome("read") > 100, `only ${outcome("read")} of the mutations were read:\n${r.stdout}`);
  assert.ok(outcome("roundtrip") > 100, r.stdout);
  assert.ok(outcome("refused:unknown-keyword") + outcome("refused:unknown-structure") + outcome("refused:missing-keyword") + outcome("refused:duplicate-keyword") > 100, r.stdout);
});
