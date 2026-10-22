// Publishes an encoded level to the bucket and verifies it, then writes MANIFEST.json.
//
//   R2_AWS="<command that runs aws against the bucket>" node tools/publish.mjs --dir DIR --level 9
//   R2_AWS=... node tools/publish.mjs --dir DIR --manifest [--delete-local-level 9]
//
// --level L: `aws s3 sync` of DIR/imagery/499/<L>/ (root.dtts for level 2) to s3://spaceaware/imagery/499/, then
// every ledger entry of that level is checked against the bucket's own listing: present, same bytes, ETag = the
// ledger's md5 (a single-part object's ETag is the MD5 of its bytes, so the stored bytes are the encoded bytes whose
// sha256 the ledger holds). Exit 1 on any miss.
// --manifest: imagery/499/MANIFEST.json (credit, licence, source, per-level files/bytes, the sha256 of the sorted
// ledger lines) from the ledger, uploaded and re-read.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = (name) => process.argv.includes(`--${name}`);
const dir = path.resolve(arg("dir", ""));
const aws = (process.env.R2_AWS ?? "").split(" ").filter(Boolean);
if (!arg("dir") || !aws.length) { console.error("usage: R2_AWS=<aws command> publish.mjs --dir DIR (--level L | --manifest)"); process.exit(2); }
const BUCKET = "spaceaware", PREFIX = "imagery/499";
const run = (args, opts = {}) => execFileSync(aws[0], [...aws.slice(1), ...args], { maxBuffer: 1 << 30, ...opts });
const ledger = () => {
  const byPath = new Map();
  for (const line of fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n")) { const e = JSON.parse(line); byPath.set(e.path, e); }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
};
const levelOf = (p) => (p.endsWith("/root.dtts") ? 2 : Number(p.split("/")[2]));
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
  if (level <= 2) run(["s3", "cp", path.join(dir, PREFIX, "root.dtts"), `s3://${BUCKET}/${PREFIX}/root.dtts`, "--only-show-errors"]);
  else run(["s3", "sync", path.join(dir, PREFIX, String(level)), `s3://${BUCKET}/${PREFIX}/${level}/`, "--only-show-errors"], { stdio: "inherit" });
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
    body: "Mars", naif: 499, tileset: "themis-day-ir-mars", scheme: "GEOGRAPHIC_TWO_ROOT_BODY (rows from the south)", tile: "256 px baseline JPEG, quality 88, $DTT records, 16 tiles a file",
    layout: ["imagery/499/root.dtts (levels 0-2)", "imagery/499/<L>/<x/16>_<row from south>.dtts (levels 3-9)"], maxLevel: 9, resolutionM: { level9Equator: 81.4, source: 100 },
    source: { name: "Mars Odyssey THEMIS Day IR global mosaic 100 m v12", url: "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12.tif", etag: "f6a82c639d6c2b4b2c499fb99663728c-2715", edition: "2022-11-10T03:49:10Z", size: [213390, 106696], crs: "planetocentric, MOLA sphere 3396190 m" },
    credit: "THEMIS: NASA/JPL/ASU (Christensen et al. 2004; Edwards et al. 2011, JGR 116, E10008); mosaic USGS Astrogeology",
    license: "Public domain (NASA/JPL/ASU)", licenseUrl: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
    producer: "body-imagery-tiles 0.2.0", files: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0), levels, ledgerSha256: digest,
  };
  const file = path.join(dir, PREFIX, "MANIFEST.json");
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  run(["s3", "cp", file, `s3://${BUCKET}/${PREFIX}/MANIFEST.json`, "--content-type", "application/json", "--only-show-errors"]);
  const back = JSON.parse(run(["s3", "cp", `s3://${BUCKET}/${PREFIX}/MANIFEST.json`, "-"]).toString());
  if (back.ledgerSha256 !== digest) { console.error("MANIFEST.json did not read back"); process.exit(1); }
  console.log(JSON.stringify({ files: manifest.files, bytes: manifest.bytes, levels, ledgerSha256: digest }));
}
