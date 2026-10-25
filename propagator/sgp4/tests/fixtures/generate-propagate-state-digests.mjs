// Writes tests/fixtures/propagate-state-digests.json: this release's answers to the 1.1.0-layout requests of
// legacy-propagate-state-cases.mjs, from a browser artifact (module.js and module.wasm in one directory; default
// dist/browser). A release that changes an answer commits new digests.
//   node tests/fixtures/generate-propagate-state-digests.mjs [dist/browser]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadRawSgp4Module } from "../lib/pivInvokeHelper.mjs";
import { legacyRounds } from "../legacy-propagate-state-cases.mjs";

const distDir = path.resolve(process.argv[2] ?? new URL("../../dist/browser", import.meta.url).pathname);
const { version } = JSON.parse(fs.readFileSync(new URL("../../plugin-manifest.json", import.meta.url), "utf8"));
const module = await loadRawSgp4Module(distDir);
let rounds;
try {
  rounds = legacyRounds(module);
} finally {
  module._plugin_destroy();
}
const out = {
  source: `propagator/sgp4 ${version}, dist/browser`,
  module: crypto.createHash("sha256").update(fs.readFileSync(path.join(distDir, "module.wasm"))).digest("hex"),
  rounds,
};
fs.writeFileSync(new URL("./propagate-state-digests.json", import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${rounds.length} rounds`);
