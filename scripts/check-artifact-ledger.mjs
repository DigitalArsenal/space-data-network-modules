#!/usr/bin/env node
// E2E, task modules-artifact-ledger-refresh-20261104: scripts/artifact-provenance.json describes the committed dists exactly.
//   1. every ledger entry names a committed dist whose sha256 and byte count equal the entry's;
//   2. every committed dist wasm has an entry (so every module with a dist has one);
//   3. a dist that carries a build-provenance file agrees with it (sha256 of the wasm it describes);
//   4. the landed hashes and versions below are present.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ledger = JSON.parse(fs.readFileSync(path.join(root, "scripts", "artifact-provenance.json"), "utf8")).artifacts;
const committed = execFileSync("git", ["-C", root, "ls-files", "*.wasm"], { encoding: "utf8" }).split("\n").filter((f) => f.includes("/dist/"));

const problems = [];
let matched = 0;
for (const [rel, entry] of Object.entries(ledger)) {
  if (!committed.includes(rel)) { problems.push(`${rel}: ledger entry names no committed dist`); continue; }
  const bytes = fs.readFileSync(path.join(root, rel));
  if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) problems.push(`${rel}: dist is ${sha256(bytes)} (${bytes.length} B), ledger ${entry.sha256} (${entry.bytes} B)`);
  else matched++;
}
const missing = committed.filter((rel) => !(rel in ledger));
for (const rel of missing) problems.push(`${rel}: committed dist with no ledger entry`);

// a dist's own build-provenance file describes its isomorphic module.wasm
let provenanceFiles = 0;
for (const rel of committed.filter((f) => f.endsWith("/dist/isomorphic/module.wasm"))) {
  const dist = path.dirname(path.dirname(path.join(root, rel)));
  const json = path.join(dist, "build-provenance.json");
  const txt = path.join(dist, "build-provenance.txt");
  const bytes = fs.readFileSync(path.join(root, rel));
  const claimed = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, "utf8")).sha256
    : fs.existsSync(txt) ? fs.readFileSync(txt, "utf8").match(/^sha256 (\S+)$/m)?.[1] : null;
  if (claimed == null) continue;
  provenanceFiles++;
  if (claimed !== sha256(bytes)) problems.push(`${rel}: build-provenance says ${claimed}, dist is ${sha256(bytes)}`);
}

const landed = [
  ["propagator/sdn-ap", "0.5.2", "74388314396a8f8c4bc962b63566b01ee8a99e1d8a295e8233fac36d5683500d"],
  ["data-source/sdn-element-sync", "0.2.0", "37f0ea34ccc2bf7b90de6bdffa1f3d47b954eef7388f0b374ff6e5ca42712897"],
  ["propagator/ffm", "2.1.0", "318db198d611da632a461de0c5aa6e280ffaa913cc2a1324034d1844e06c4fd6"],
];
for (const [dir, version, hash] of landed) {
  const entry = ledger[`${dir}/dist/isomorphic/module.wasm`];
  if (entry?.sha256 !== hash) problems.push(`${dir}: ledger has ${entry?.sha256}, expected ${hash}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, dir, "dist", "plugin-manifest.json"), "utf8"));
  if (manifest.version !== version) problems.push(`${dir}: dist manifest is ${manifest.version}, expected ${version}`);
}
const sync = JSON.parse(fs.readFileSync(path.join(root, "data-source/sdn-element-sync/dist/build-provenance.json"), "utf8"));
if (sync.sha256 !== landed[1][2]) problems.push(`sdn-element-sync build-provenance.json says ${sync.sha256}`);

if (problems.length) { console.error(`FAIL artifact ledger: ${problems.length} disagreements\n${problems.map((p) => `  - ${p}`).join("\n")}`); process.exit(1); }
console.log(`PASS artifact ledger: ${matched}/${Object.keys(ledger).length} entries equal their dist sha256, ${committed.length} committed dists all ledgered, ${provenanceFiles} build-provenance files agree, ${landed.length} landed hashes present`);
