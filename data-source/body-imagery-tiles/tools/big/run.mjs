// One source's whole pyramid, level by level, with the local disk bounded: encode, upload, verify against the bucket,
// delete the level once the next coarser one is made from it, then root.dtts and MANIFEST.json.
//
//   R2_AWS="<command running aws against the bucket>" node tools/big/run.mjs --source KEY --out DIR [--workers 3] [--chunk 128]
//
// --chunk N (even): the deepest level is encoded N rows at a time; each chunk is uploaded, its half as many rows of the level
// above are reduced from it, and it is deleted (a mosaic whose deepest level is tens of GB, Venus). Every step is resumable:
// existing files are kept, a finished chunk leaves DIR/_done/<L>_<a>-<b>.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCES, prefixOf } from "./sources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const key = arg("source"), S = SOURCES[key];
if (!S || !arg("out") || !process.env.R2_AWS) { console.error("usage: R2_AWS=<aws command> run.mjs --source KEY --out DIR [--workers N] [--chunk N]"); process.exit(2); }
const out = path.resolve(arg("out")), workers = arg("workers", "3"), chunk = Number(arg("chunk", 0));
const prefix = prefixOf(S), L = S.maxLevel;
const sh = (script, args) => {
  const r = spawnSync(process.execPath, [path.join(HERE, script), "--source", key, ...args], { stdio: "inherit", env: process.env });
  if (r.status !== 0) { console.error(`FAILED: ${script} ${args.join(" ")}`); process.exit(1); }
};
const encode = (level, extra = []) => sh("encode.mjs", ["--out", out, "--level", String(level), "--workers", workers, ...extra]);
const publish = (level, extra = []) => sh("publish.mjs", ["--dir", out, "--level", String(level), ...extra]);
const levelDir = (l) => path.join(out, prefix, String(l));
const drop = (l) => { fs.rmSync(levelDir(l), { recursive: true, force: true }); console.log(`removed local level ${l}`); };
const mark = (name) => path.join(out, "_done", name);
fs.mkdirSync(path.join(out, "_done"), { recursive: true });
const log = (s) => console.log(`[run ${key}] ${new Date().toISOString()} ${s}`);

const rowsAtL = 1 << L;
if (chunk) {
  for (let a = 0; a < rowsAtL; a += chunk) {
    const b = Math.min(rowsAtL, a + chunk) - 1, done = mark(`${L}_${a}-${b}`);
    if (fs.existsSync(done)) continue;
    log(`level ${L} rows ${a}-${b}`);
    encode(L, ["--rows", `${a}-${b}`]);
    publish(L, ["--upload-only"]);
    log(`level ${L - 1} rows ${a >> 1}-${b >> 1} from the chunk`);
    encode(L - 1, ["--rows", `${a >> 1}-${b >> 1}`, "--children", out]);
    drop(L);
    fs.writeFileSync(done, "");
  }
  publish(L, []);  // verifies the whole level against the bucket listing (all ledger entries)
} else {
  log(`level ${L}`);
  encode(L);
  publish(L);
}
for (let l = L - 1; l >= 3; l--) {
  log(`level ${l}`);
  if (!(chunk && l === L - 1)) encode(l, ["--children", out]);
  publish(l);
  drop(l + 1);  // level l is made and verified; the level it was reduced from is no longer needed
}
log("root");
encode(2, ["--children", out]);
publish(2);
drop(3);
sh("publish.mjs", ["--dir", out, "--manifest"]);
log("done");
