#!/usr/bin/env node
// Records tests/fixtures/answers-2-1-1.json: what this build of the OD node (nodes/od/dist/isomorphic/module.wasm)
// answers on the inputs of its tests (tests/lib/answers.mjs), each fitted three times (PROVENANCE.md). The node
// computes every record; this script moves bytes, hashes them and times the invocations.
//   cd flows/supplemental-omm && node tests/fixtures/record-answers.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageRoot, sha256 } from "../lib/flow.mjs";
import { answerInputs, answersOf, median } from "../lib/answers.mjs";

const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "nodes/od/plugin-manifest.json"), "utf8"));
const wasm = fs.readFileSync(path.join(packageRoot, "nodes/od/dist/isomorphic/module.wasm"));
const load = [os.loadavg()[0]];
const inputs = [];
for (const [name, frames] of Object.entries(await answerInputs())) {
  inputs.push({ name, ...(await answersOf(frames)) });
}
load.push(os.loadavg()[0]);
const out = {
  "//": "The OD node 2.1.1 (over propagator/sgp4-xp 0.2.1) on the inputs of its tests (tests/lib/answers.mjs): per input every record of the omm and ocm streams in output order, SHA-256 of its bytes with the version in PROVENANCE.PRODUCER masked; the notices; the wall time of each of three fits, ms (tests/fixtures/record-answers.mjs; PROVENANCE.md).",
  node: { version: manifest.version, sha256: sha256(wasm), bytes: wasm.length },
  load1: load.map((l) => Math.round(l * 10) / 10),
  inputs,
};
fs.writeFileSync(path.join(packageRoot, "tests/fixtures/answers-2-1-1.json"), `${JSON.stringify(out, null, 1)}\n`);
for (const input of inputs) {
  const kinds = {};
  for (const r of input.records) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  console.log(`${input.name}: ${input.invocations} invocations, ${JSON.stringify(kinds)}, labels ${JSON.stringify(input.versions)}, fit ms ${input.ms.join(" ")} (median ${median(input.ms)})`);
}
console.log(`recorded ${inputs.length} inputs from ${out.node.version} (${out.node.sha256}); 1-minute load ${out.load1.join(" to ")}`);
process.exit(0);
