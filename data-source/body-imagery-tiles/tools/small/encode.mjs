// The encode for one small body: one level of its imagery pyramid into files under --out, in the layout the engine's
// imageryFromTileFiles reads (imagery/<NAIF id>/root.dtts, imagery/<NAIF id>/<L>/<X16>_<Y>.dtts).
//
//   node tools/small/encode.mjs --body <key> --out DIR [--derived DIR] [--workers 2]     the whole pyramid, deepest level first
//   node tools/small/encode.mjs --body <key> --out DIR --level L [--rows a-b] [--workers 2]
//
// The deepest level reads the source by HTTP range (one tile row = one range of whole source rows, If-Match on the edition;
// a derived source - Mimas, Titan - is read from the file under --derived); every coarser level down to 3 reduces the two child
// rows of the level below, level 2 builds root.dtts (levels 0-2) from level 3. Rows are independent, so the files are
// byte-identical at any --workers. Existing files are kept; every file written is appended to DIR/<naif>/ledger.jsonl.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchRows, openRunner } from "./runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const BODIES = JSON.parse(fs.readFileSync(path.join(HERE, "bodies.json"), "utf8")).bodies;
const body = BODIES.find((b) => b.key === arg("body"));
if (!body || !arg("out")) { console.error("usage: encode.mjs --body <key> --out DIR [--level L] [--rows a-b] [--workers N] [--derived DIR]"); process.exit(2); }
const NAIF = body.naif, MAX = body.max_level;
const out = path.resolve(arg("out"));
const derived = body.derived ? path.join(path.resolve(arg("derived", ".")), body.derived) : null;
const modules = path.resolve(HERE, "../..");
const nameOf = (l, x16, y) => (l <= 2 ? `imagery/${NAIF}/root.dtts` : `imagery/${NAIF}/${l}/${x16}_${y}.dtts`);
const ledgerPath = path.join(out, `ledger-${NAIF}.jsonl`);

async function writeFiles(files) {
  for (const f of files) {
    const dest = path.join(out, f.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, f.bytes);
    fs.renameSync(tmp, dest);
    fs.appendFileSync(ledgerPath, `${JSON.stringify({ path: f.name, bytes: f.bytes.length, sha256: crypto.createHash("sha256").update(f.bytes).digest("hex"), md5: crypto.createHash("md5").update(f.bytes).digest("hex") })}\n`);
  }
}
const readChild = (name) => new Uint8Array(fs.readFileSync(path.join(out, name)));
const rowDone = (l, y) => (l <= 2 ? fs.existsSync(path.join(out, nameOf(2, 0, 0))) : Array.from({ length: Math.max(1, (2 << l) / 16) }, (_, k) => k).every((k) => fs.existsSync(path.join(out, nameOf(l, k, y)))));

async function work(level, [r0, r1], k, n) {
  const runner = await openRunner({ modules });
  let made = 0;
  for (let y = r0; y <= (MAX <= 2 && level === MAX ? 0 : r1); y++) {
    if (y % n !== k || rowDone(level, y) || (level === 2 && k !== 0)) continue;
    let files;
    if (level === MAX) {
      const { requests, unit } = await runner.plan(NAIF, level, MAX <= 2 ? 0 : y);
      const answers = [];
      for (const request of requests) { const { status, body: rows } = await fetchRows(request, { localFile: derived }); answers.push({ url: request.url, status, body: rows }); }
      files = await runner.direct(unit, answers);
    } else {
      const child = level + 1, perRow = (2 << child) / 16;
      const rows = level === 2 ? Array.from({ length: 1 << child }, (_, i) => i) : [2 * y, 2 * y + 1];
      const children = [];
      for (const cy of rows) {
        const parts = [];
        for (let x16 = 0; x16 < perRow; x16++) parts.push(readChild(nameOf(child, x16, cy)));
        children.push(Buffer.concat(parts));  // size-prefixed streams concatenate
      }
      files = await runner.reduce(NAIF, level, y, children);
    }
    await writeFiles(files);
    made++;
    if (level === 2) break;
  }
  runner.destroy();
  return made;
}
const levels = arg("level") ? [Number(arg("level"))] : MAX <= 2 ? [MAX] : Array.from({ length: MAX - 1 }, (_, i) => MAX - i);  // MAX..2
const workers = Number(arg("workers", 1)), slice = arg("worker");
if (slice) {
  const [k, n] = slice.split("/").map(Number);
  for (const l of levels) await work(l, (arg("rows", `0-${(1 << l) - 1}`)).split("-").map(Number), k, n);
} else {
  // each level to completion before the next reads it
  for (const l of levels) {
    const codes = await Promise.all(Array.from({ length: workers }, (_, k) => new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), "--level", String(l), "--worker", `${k}/${workers}`], { stdio: "inherit" });
      child.on("exit", resolve);
    })));
    if (codes.some((c) => c !== 0)) process.exit(1);
    console.log(`${body.key}: level ${l} done`);
  }
}
