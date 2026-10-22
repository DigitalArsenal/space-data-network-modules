// The encode: one level of a body's imagery pyramid into files under --out, in the layout the engine's
// imageryFromTileFiles reads (imagery/<NAIF id>/root.dtts, .../<L>/<X16>_<Y>.dtts).
//
//   node tools/big/encode.mjs --source venus-magellan-left --out DIR --level 9 [--rows 0-1023] [--workers 4]
//
// --source is a key of tools/big/sources.mjs ; its deepest level is read from the mosaic.
//   node tools/encode.mjs --out DIR --level 8 --children DIR [--children-url https://terrain.spacedatanetwork.org]
//   node tools/encode.mjs --out DIR --level 2 --children DIR          (root.dtts: levels 0-2 from level 3)
//
// Level 9 reads the mosaic by HTTP range (one tile row = one range of about 45 MB, If-Match on the edition); levels
// 8..3 reduce the two child rows (rows 2r, 2r+1 of the level below) read from --children, or from the same layout
// at --children-url; level 2 is the root file. Rows are independent, so the files are byte-identical at any
// --workers. Existing files are kept (a stopped run resumes); every file written is appended to DIR/ledger.jsonl as
// {path, bytes, sha256, md5}.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCES, prefixOf } from "./sources.mjs";
import { fetchRows, openRunner } from "./runner.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const SOURCE_KEY = arg("source"), SRC = SOURCES[SOURCE_KEY];
if (!SRC) { console.error(`unknown --source ${SOURCE_KEY}: ${Object.keys(SOURCES).join(", ")}`); process.exit(2); }
const PREFIX = prefixOf(SRC), MAX_LEVEL = SRC.maxLevel;
const out = path.resolve(arg("out", ""));
const level = Number(arg("level", MAX_LEVEL));
const [r0, r1] = (arg("rows", `0-${(1 << level) - 1}`)).split("-").map(Number);
const workers = Number(arg("workers", 1));
const slice = arg("worker");  // "k/N", set by the launcher
const childrenDir = arg("children") && path.resolve(arg("children"));
const childrenUrl = arg("children-url");
if (!process.argv[1] || !arg("out") || !(level >= 2 && level <= MAX_LEVEL)) {
  console.error("usage: encode.mjs [--source KEY] --out DIR --level 2..max [--rows a-b] [--workers N] [--children DIR] [--children-url URL]");
  process.exit(2);
}

const nameOf = (l, x16, y) => (l <= 2 ? `${PREFIX}/root.dtts` : `${PREFIX}/${l}/${x16}_${y}.dtts`);
async function writeFiles(files) {
  for (const f of files) {
    const dest = path.join(out, f.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, f.bytes);
    fs.renameSync(tmp, dest);
    fs.appendFileSync(path.join(out, "ledger.jsonl"), `${JSON.stringify({ path: f.name, bytes: f.bytes.length, sha256: crypto.createHash("sha256").update(f.bytes).digest("hex"), md5: crypto.createHash("md5").update(f.bytes).digest("hex") })}\n`);
  }
}
async function readChild(name) {
  if (childrenDir && fs.existsSync(path.join(childrenDir, name))) return new Uint8Array(fs.readFileSync(path.join(childrenDir, name)));
  if (childrenUrl) {
    const res = await fetch(`${childrenUrl}/${name}`);
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    throw new Error(`${childrenUrl}/${name}: HTTP ${res.status}`);
  }
  throw new Error(`child file ${name} is in no --children source`);
}
const rowDone = (l, y) => (l <= 2 ? fs.existsSync(path.join(out, nameOf(2, 0, 0))) : Array.from({ length: Math.max(1, (2 << l) / 16) }, (_, k) => k).every((k) => fs.existsSync(path.join(out, nameOf(l, k, y)))));

async function work(k, n) {
  const runner = await openRunner({ source: SOURCE_KEY });
  let made = 0;
  for (let y = r0; y <= r1; y++) {
    if (y % n !== k) continue;
    if (rowDone(level, y)) continue;
    const t0 = Date.now();
    let files;
    if (level === MAX_LEVEL) {
      const { requests, fill, unit } = await runner.plan(y);
      const bands = [];
      for (const request of requests) bands.push(await fetchRows(request));
      files = await runner.direct(unit, 0, null, bands, fill ? await fetchRows(fill) : null);
    } else {
      const childLevel = level + 1, perRow = (2 << childLevel) / 16;
      const rows = level === 2 ? Array.from({ length: 1 << childLevel }, (_, i) => i) : [2 * y, 2 * y + 1];
      const children = [];
      for (const cy of rows) {
        const parts = [];
        for (let x16 = 0; x16 < perRow; x16++) parts.push(await readChild(nameOf(childLevel, x16, cy)));
        children.push(Buffer.concat(parts));  // size-prefixed streams concatenate
      }
      files = await runner.reduce(level, y, children);
    }
    await writeFiles(files);
    made++;
    console.log(`level ${level} row ${y}: ${files.length} files, ${files.reduce((a, f) => a + f.bytes.length, 0)} B, ${Date.now() - t0} ms`);
    if (level === 2) break;
  }
  runner.destroy();
  return made;
}

if (slice) {
  const [k, n] = slice.split("/").map(Number);
  await work(k, n);
} else if (workers > 1) {
  const codes = await Promise.all(Array.from({ length: workers }, (_, k) => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), "--worker", `${k}/${workers}`], { stdio: "inherit" });
    child.on("exit", resolve);
  })));
  if (codes.some((c) => c !== 0)) process.exit(1);
} else {
  await work(0, 1);
}
