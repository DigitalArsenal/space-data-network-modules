// Deterministic no-network runner used only to exercise global-build.mjs state
// transitions. It deliberately emits an empty, valid framed store; merge can
// then run without impersonating a terrain encoder.

import fs from "node:fs";
import path from "node:path";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]] = process.argv[i + 1];
const config = JSON.parse(fs.readFileSync(args["--config"], "utf8"));
const out = path.resolve(args["--out"]);
fs.mkdirSync(out, { recursive: true });
if (process.env.TERRAIN_REHEARSAL_LOG) {
  fs.appendFileSync(process.env.TERRAIN_REHEARSAL_LOG, `${config.global_shard.index}\n`);
}
fs.writeFileSync(path.join(out, "tiles.dttstream"), Buffer.alloc(0));
fs.writeFileSync(path.join(out, "run-report.json"), `${JSON.stringify({ drained: true, errors: [] })}\n`);
