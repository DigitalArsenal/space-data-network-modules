// E2E (modules-terrain-raster-branch-reproducible-20261025): modules main re-encodes the small bodies' published relief
// byte for byte. For Mercury (199), Venus (299), Charon (901) and Pluto (999) the original source raster is read through
// the shipped terrain-source module exactly as flow-bodies.mjs publishes it (source pixels chosen by the WASM, the run
// clock pinned by the body's config), each file the walk names is hashed, and the hash must equal that file's entry in
// the LIVE terrain/<naif>/SHA256SUMS on https://terrain.spacedatanetwork.org. Their pole posts carry the body's axis
// (body-terrain-pole-normals-republish-20261025), so a module without both the raster reader and the pole fix fails.
//
//   node tests/small-body-reproduce.e2e.mjs
//     SMALL_BODY_NAIFS=901,299,199,999   bodies (default all four)
//     SMALL_BODY_SOURCES=<dir>           holds <x>/<source file> (default /Users/tj/software/terrain-work/body-terrain);
//                                        each file's sha256 must equal its config's sourceSha256
//     SMALL_BODY_FULL=1                  every block (6,308 files; ~25 min): the acceptance run. Without it: the root, the
//                                        first and last polar-row block of the deepest two levels, and a stride sample.
//     SMALL_BODY_WORKER=k SMALL_BODY_WORKERS=n   split the blocks over n separate processes (this script never spawns)
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { blocks, createRasterLane } from "../flow-bodies.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://terrain.spacedatanetwork.org";
const NAIFS = (process.env.SMALL_BODY_NAIFS ?? "901,299,199,999").split(",").map(Number);
const SOURCES = process.env.SMALL_BODY_SOURCES ?? "/Users/tj/software/terrain-work/body-terrain";
const FULL = process.env.SMALL_BODY_FULL === "1";
const WORKER = Number(process.env.SMALL_BODY_WORKER ?? 0);
const WORKERS = Number(process.env.SMALL_BODY_WORKERS ?? 1);
const STRIDE = 97;
const sha = (b) => createHash("sha256").update(b).digest("hex");

function findSource(config) {
  const name = path.basename(config.sourceFile);
  for (const dir of fs.readdirSync(SOURCES)) {
    const candidate = path.join(SOURCES, dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} is not under ${SOURCES}/*/`);
}
function fileSha256(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.allocUnsafe(8 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}
function selected(block, maxLevel) {
  if (FULL || block.index === 0) return true;
  const first = block.addresses[0];
  const rows = Math.max(1, (2 ** first.level) >> 2), row = first.y >> 2;
  if (first.level >= maxLevel - 1 && (row === 0 || row === rows - 1) && ((first.x >> 2) % 5 === 0 || first.level === 3)) return true;
  return block.index % STRIDE === 0;
}

let failed = 0;
for (const naif of NAIFS) {
  const config = JSON.parse(fs.readFileSync(path.join(here, "fixtures/small-body", `${naif}.json`), "utf8"));
  config.sourceFile = findSource(config);
  assert.equal(fileSha256(config.sourceFile), config.sourceSha256, `${naif}: the source raster is not the edition the config pins`);
  const liveRes = await fetch(`${BASE}/terrain/${naif}/SHA256SUMS?e2e=${Date.now()}`);
  assert.ok(liveRes.ok, `${naif}: live SHA256SUMS HTTP ${liveRes.status}`);
  const live = new Map((await liveRes.text()).trim().split("\n").map((l) => { const [h, k] = l.split(/\s+/); return [k, h]; }));
  const lane = await createRasterLane(config);
  let files = 0, blocksRun = 0;
  const bad = [];
  try {
    for (const block of blocks(config.maxLevel)) {
      if (block.index % WORKERS !== WORKER || !selected(block, config.maxLevel)) continue;
      let records;
      if (block.index === 0) { const parts = []; for (const a of block.addresses) parts.push(await lane.tile([a])); records = Buffer.concat(parts); }
      else records = await lane.tile(block.addresses);
      for (const file of await lane.pack(records)) {
        files++;
        if (live.get(file.name) !== sha(file.bytes)) bad.push(file.name);
      }
      blocksRun++;
      if (global.gc) global.gc();
    }
  } finally { await lane.destroy(); }
  const ok = files > 0 && bad.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${naif} ${config.version.replace(/-2026\d+$/, "")}: ${files} files from ${blocksRun} blocks ${FULL ? "(all)" : "(sample)"} ${ok ? "equal the live SHA256SUMS" : `differ from live: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ` (+${bad.length - 5})` : ""}`}`);
}
process.exit(failed ? 1 : 0);
