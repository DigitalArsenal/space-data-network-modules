// ONE UNIT OF THE MOON'S WALK, WHOLE: lola_plan -> local PDS responses -> tile (every tile of the unit) -> pack, in
// a fresh process, so its peak RSS is one unit's (run it under `/usr/bin/time -l`). Prints the unit, the files pack
// wrote and their sizes, and the process's own peak RSS.
//
// Usage: LOLA_DIR=~/software/data/lola node tools/moon-unit.mjs <unit index> [out-dir]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMoonLane } from "./moon-lane.mjs";

const [index, outDir] = [Number(process.argv[2] ?? 0), process.argv[3]];
const lane = await createMoonLane({ lolaDir: process.env.LOLA_DIR ?? path.join(os.homedir(), "software/data/lola") });
const unit = await lane.planUnit(index);
if (!unit) throw new Error(`unit ${index} is past the end of the walk`);
const lines = unit.requests.slice(1).reduce((n, r) => {
  const [, a, b] = r.headers.range.match(/bytes=(\d+)-(\d+)/).map(Number);
  return n + b - a + 1;
}, 0);
const { response, ms, records, report } = await lane.encode(unit);
if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
const files = await lane.pack(unit, records);
if (outDir) {
  for (const f of files) {
    fs.mkdirSync(path.join(outDir, path.dirname(f.name)), { recursive: true });
    fs.writeFileSync(path.join(outDir, f.name), f.bytes);
  }
}
lane.destroy();
console.log(JSON.stringify({
  unit: index,
  notes: unit.job.notes,
  rangeBytes: lines,
  tiles: report.tiles.length,
  recordsBytes: records.length,
  files: files.length,
  largestFileBytes: Math.max(...files.map((f) => f.bytes.length)),
  encodeSeconds: +(ms / 1000).toFixed(1),
  peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
}));
