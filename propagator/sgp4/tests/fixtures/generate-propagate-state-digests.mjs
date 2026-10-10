// Writes tests/fixtures/propagate-state-1.1.0-digests.json from a 1.1.0
// browser artifact (module.js and module.wasm in one directory). The
// committed digests come from propagator/sgp4 1.1.0 (space-data-network-modules
// 37a0801f; dist/browser/module.wasm SHA-256 754dc90b...):
//
//   mkdir v1.1.0
//   git show 37a0801f:propagator/sgp4/dist/browser/module.js > v1.1.0/module.js
//   git show 37a0801f:propagator/sgp4/dist/browser/module.wasm > v1.1.0/module.wasm
//   node tests/fixtures/generate-propagate-state-digests.mjs v1.1.0
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadRawSgp4Module } from "../lib/pivInvokeHelper.mjs";
import { legacyRounds } from "../legacy-propagate-state-cases.mjs";

const dir = process.argv[2];
if (!dir) throw new Error("usage: generate-propagate-state-digests.mjs <directory with the 1.1.0 module.js and module.wasm>");
const distDir = path.resolve(dir);
const module = await loadRawSgp4Module(distDir);
let rounds;
try {
  rounds = legacyRounds(module);
} finally {
  module._plugin_destroy();
}
const out = {
  source: "propagator/sgp4 1.1.0 (space-data-network-modules 37a0801f), dist/browser",
  module: crypto.createHash("sha256").update(fs.readFileSync(path.join(distDir, "module.wasm"))).digest("hex"),
  rounds,
};
fs.writeFileSync(new URL("./propagate-state-1.1.0-digests.json", import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${rounds.length} rounds`);
