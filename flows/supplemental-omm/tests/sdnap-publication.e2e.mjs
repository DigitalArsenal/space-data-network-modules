#!/usr/bin/env node
// E2E (task modules-catalog-sdnap-publish-flow-20261025): the SDN-AP publication of both flows.
//   tests/sdnap.e2e.mjs          the supplemental-omm release fits SDN-AP beside the OD node, per ephemeris
//   tests/catalog-sdnap.e2e.mjs  the catalog-sdnap release fits SDN-AP for a catalog read from the store
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const script of ["sdnap.e2e.mjs", "catalog-sdnap.e2e.mjs"]) {
  const run = spawnSync(process.execPath, [path.join(here, script)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const lines = `${run.stdout}${run.stderr}`.split("\n").filter((line) => /^(PASS|FAIL|[A-Z-]+E2E )/.test(line));
  console.log(lines.join("\n"));
  if (run.status !== 0) failed += 1;
}
console.log(failed ? `SDNAP-PUBLICATION-E2E FAIL (${failed} flow(s))` : "SDNAP-PUBLICATION-E2E PASS");
process.exit(failed ? 1 : 0);
