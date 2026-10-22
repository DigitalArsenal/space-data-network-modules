// Publishes one encoded small body to the bucket, verifies it, writes imagery/<naif>/MANIFEST.json.
//   R2_AWS="<command that runs aws against the bucket>" node tools/small/publish.mjs --body <key> --out DIR [--src-sha256 <hex>]
// `aws s3 sync` of DIR/imagery/<naif>/, then every ledger entry is checked against the bucket's own listing (present, same bytes,
// ETag = the ledger md5: a single-part object's ETag is the MD5 of its bytes), then MANIFEST.json is uploaded and read back.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const doc = JSON.parse(fs.readFileSync(path.join(HERE, "bodies.json"), "utf8"));
const body = doc.bodies.find((b) => b.key === arg("body"));
const aws = (process.env.R2_AWS ?? "").split(" ").filter(Boolean);
if (!body || !arg("out") || !aws.length) { console.error("usage: R2_AWS=<aws command> publish.mjs --body <key> --out DIR [--src-sha256 hex]"); process.exit(2); }
const dir = path.resolve(arg("out")), BUCKET = "spaceaware", PREFIX = `imagery/${body.naif}`;
const run = (args, o = {}) => execFileSync(aws[0], [...aws.slice(1), ...args], { maxBuffer: 1 << 30, ...o });
const byPath = new Map();
for (const line of fs.readFileSync(path.join(dir, `ledger-${body.naif}.jsonl`), "utf8").trim().split("\n")) { const e = JSON.parse(line); byPath.set(e.path, e); }
const ledger = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
const levelOf = (p) => (p.endsWith("/root.dtts") ? 2 : Number(p.split("/")[2]));
function listing() {
  const out = new Map();
  let token;
  do {
    const res = JSON.parse(run(["s3api", "list-objects-v2", "--bucket", BUCKET, "--prefix", `${PREFIX}/`, "--output", "json", ...(token ? ["--starting-token", token] : [])]).toString() || "{}");
    for (const o of res.Contents ?? []) out.set(o.Key, { size: o.Size, etag: o.ETag.replaceAll('"', "") });
    token = res.NextToken;
  } while (token);
  return out;
}
run(["s3", "sync", path.join(dir, PREFIX), `s3://${BUCKET}/${PREFIX}/`, "--exclude", "MANIFEST.json", "--only-show-errors"], { stdio: "inherit" });
const have = listing();
let bad = 0;
for (const e of ledger) {
  const o = have.get(e.path);
  if (!o || o.size !== e.bytes || o.etag !== e.md5) { bad++; console.error(`MISMATCH ${e.path}: ${JSON.stringify(o)} vs ${e.bytes} ${e.md5}`); }
}
if (bad) process.exit(1);
const levels = {};
for (const e of ledger) { const l = (levels[levelOf(e.path)] ??= { files: 0, bytes: 0 }); l.files++; l.bytes += e.bytes; }
const digest = crypto.createHash("sha256").update(ledger.map((e) => `${e.path} ${e.bytes} ${e.sha256}`).join("\n")).digest("hex");
const manifest = {
  body: body.body, naif: body.naif, tileset: body.key, scheme: "GEOGRAPHIC_TWO_ROOT_BODY (x from 180 W, rows from the south, planetocentric, east longitude)",
  tile: "256 px baseline JPEG, quality 88, $DTT records, 16 tiles a file",
  layout: [`${PREFIX}/root.dtts (levels 0-2)`, `${PREFIX}/<L>/<x/16>_<row from south>.dtts (levels 3-${body.max_level})`], maxLevel: body.max_level,
  source: { name: body.dataset, url: body.url, edition: body.epoch, sha256: arg("src-sha256", null), derived: body.derived ?? null },
  credit: body.credit, license: body.license, licenseUrl: body.license_url ?? doc.usgs,
  longitude: "The source GeoTIFF's geotransform read literally as east longitude (verified against the IAU gazetteer); no column mirror.",
  producer: "body-imagery-tiles 0.3.0", files: ledger.length, bytes: ledger.reduce((n, e) => n + e.bytes, 0), levels, ledgerSha256: digest,
};
const file = path.join(dir, PREFIX, "MANIFEST.json");
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
run(["s3", "cp", file, `s3://${BUCKET}/${PREFIX}/MANIFEST.json`, "--content-type", "application/json", "--only-show-errors"]);
const back = JSON.parse(run(["s3", "cp", `s3://${BUCKET}/${PREFIX}/MANIFEST.json`, "-"]).toString());
if (back.ledgerSha256 !== digest) { console.error("MANIFEST.json did not read back"); process.exit(1); }
console.log(JSON.stringify({ body: body.key, files: manifest.files, bytes: manifest.bytes, inBucket: have.size, ledgerSha256: digest }));
