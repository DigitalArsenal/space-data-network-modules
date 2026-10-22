// Publishes an encoded level to the bucket and verifies it, then writes MANIFEST.json.
//
//   R2_AWS="<command that runs aws against the bucket>" node tools/big/publish.mjs [--source KEY] --dir DIR --level 9
//   R2_AWS=... node tools/big/publish.mjs [--source KEY] --dir DIR --manifest
//
// --source: a key of tools/big/sources.mjs its files live under imagery/<naif>/.
// --level L [--upload-only | --verify-only]: `aws s3 sync` of DIR/<prefix>/<L>/ (root.dtts for level 2) to s3://spaceaware/<prefix>/, then
// every ledger entry of that level is checked against the bucket's own listing: present, same bytes, ETag = the
// ledger's md5 (a single-part object's ETag is the MD5 of its bytes, so the stored bytes are the encoded bytes whose
// sha256 the ledger holds). Exit 1 on any miss.
// --manifest: <prefix>/MANIFEST.json (credit, licence, source, per-level files/bytes, the sha256 of the sorted
// ledger lines) from the ledger, uploaded and re-read.
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SOURCES, prefixOf } from "./sources.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = (name) => process.argv.includes(`--${name}`);
const dir = path.resolve(arg("dir", ""));
const aws = (process.env.R2_AWS ?? "").split(" ").filter(Boolean);
if (!arg("dir") || !aws.length) { console.error("usage: R2_AWS=<aws command> publish.mjs --dir DIR (--level L | --manifest)"); process.exit(2); }
const SRC = SOURCES[arg("source")];
if (!SRC) { console.error(`unknown --source: ${Object.keys(SOURCES).join(", ")}`); process.exit(2); }
const BUCKET = "spaceaware", PREFIX = prefixOf(SRC);
const run = (args, opts = {}) => execFileSync(aws[0], [...aws.slice(1), ...args], { maxBuffer: 1 << 30, ...opts });
const ledger = () => {
  const byPath = new Map();
  for (const line of fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n")) { const e = JSON.parse(line); byPath.set(e.path, e); }
  return [...byPath.values()].filter((e) => e.path.startsWith(`${PREFIX}/`)).sort((a, b) => (a.path < b.path ? -1 : 1));
};
const levelOf = (p) => (p.endsWith("/root.dtts") ? 2 : Number(p.slice(PREFIX.length + 1).split("/")[0]));
// Conditional writes make the no-overwrite rule atomic, including a writer
// racing the inventory check. Identical existing objects are read, never PUT.
const asyncRun = (args) => new Promise((resolve, reject) => execFile(aws[0], [...aws.slice(1), ...args], { maxBuffer: 64 << 20, encoding: "buffer" }, (error, stdout, stderr) => { if (error) { error.stderr = stderr; reject(error); } else resolve(stdout); }));
const putNew = async (file, key, type = "application/octet-stream") => {
  const bytes = fs.readFileSync(file), want = crypto.createHash("sha256").update(bytes).digest("hex");
  try {
    const old = await asyncRun(["s3", "cp", `s3://${BUCKET}/${key}`, "-"]);
    if (crypto.createHash("sha256").update(old).digest("hex") !== want) throw new Error(`refusing overwrite: ${key}`);
    return;
  } catch (e) {
    if (!/NoSuchKey|Not Found|404/.test(String(e.stderr))) throw e;
  }
  await asyncRun(["s3api", "put-object", "--bucket", BUCKET, "--key", key, "--body", file, "--if-none-match", "*", "--content-type", type]);
};
const listing = (prefix) => {
  const out = new Map();
  let token;
  do {
    const args = ["s3api", "list-objects-v2", "--bucket", BUCKET, "--prefix", prefix, "--output", "json", ...(token ? ["--starting-token", token] : [])];
    const res = JSON.parse(run(args).toString() || "{}");
    for (const o of res.Contents ?? []) out.set(o.Key, { size: o.Size, etag: o.ETag.replaceAll('"', "") });
    token = res.NextToken;
  } while (token);
  return out;
};

if (arg("level")) {
  const level = Number(arg("level"));
  if (flag("verify-only")) { /* the files were uploaded chunk by chunk and are gone locally: check the bucket against the ledger only */ }
  else {
    const pending = ledger().filter((e) => levelOf(e.path) === level && fs.existsSync(path.join(dir, e.path)));
    let next = 0, failure;
    await Promise.all(Array.from({ length: Math.min(64, pending.length) }, async () => {
      while (!failure && next < pending.length) { const e = pending[next++]; try { await putNew(path.join(dir, e.path), e.path); } catch (err) { failure ??= err; } }
    }));
    if (failure) throw failure;
  }
  const have = listing(level <= 2 ? `${PREFIX}/root.dtts` : `${PREFIX}/${level}/`);
  const want = ledger().filter((e) => levelOf(e.path) === level);
  let bytes = 0, bad = 0;
  for (const e of want) {
    const o = have.get(e.path);
    if (!o || o.size !== e.bytes || o.etag !== e.md5) { bad++; console.error(`MISMATCH ${e.path}: ${JSON.stringify(o)} vs ${e.bytes} ${e.md5}`); }
    bytes += e.bytes;
  }
  console.log(JSON.stringify({ level, files: want.length, bytes, inBucket: have.size, mismatches: bad }));
  if (bad || have.size < want.length) process.exit(1);
} else if (flag("manifest")) {
  const entries = ledger(), levels = {};
  for (const e of entries) { const l = (levels[levelOf(e.path)] ??= { files: 0, bytes: 0 }); l.files++; l.bytes += e.bytes; }
  const digest = crypto.createHash("sha256").update(entries.map((e) => `${e.path} ${e.bytes} ${e.sha256}`).join("\n")).digest("hex");
  const manifest = {
    body: SRC.body, naif: SRC.naif, product: SRC.product || null, tileset: SRC.tileset, scheme: "GEOGRAPHIC_TWO_ROOT_BODY (rows from the south)",
    tile: `256 px baseline JPEG, quality 88, ${SRC.bands === 3 ? "RGB" : "grayscale"}, $DTT records, 16 tiles a file`,
    layout: [`${PREFIX}/root.dtts (levels 0-2)`, `${PREFIX}/<L>/<x/16>_<row from south>.dtts (levels 3-${SRC.maxLevel})`], maxLevel: SRC.maxLevel,
    resolutionM: { deepestLevelEquator: SRC.resolutionM.deepest, source: SRC.resolutionM.source },
    source: { name: SRC.name, url: SRC.url, etag: SRC.etag, edition: SRC.edition, size: SRC.size, crs: SRC.crs },
    credit: SRC.credit, license: SRC.license, licenseUrl: SRC.licenseUrl,
    producer: "body-imagery-tiles 0.3.0", files: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0), levels, ledgerSha256: digest,
  };
  const file = path.join(dir, PREFIX, "MANIFEST.json");
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  await putNew(file, `${PREFIX}/MANIFEST.json`, "application/json");
  const back = JSON.parse(run(["s3", "cp", `s3://${BUCKET}/${PREFIX}/MANIFEST.json`, "-"]).toString());
  if (back.ledgerSha256 !== digest) { console.error("MANIFEST.json did not read back"); process.exit(1); }
  console.log(JSON.stringify({ files: manifest.files, bytes: manifest.bytes, levels, ledgerSha256: digest }));
}
