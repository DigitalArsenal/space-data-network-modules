// SMALL-BODY AND GIANT-PLANET IMAGERY, END TO END (body-imagery-small-r2-20261022).
//
// The module (tiles_plan / tiles_direct / tiles_reduce through the SDK harness, tools/small/encode.mjs) for every body of
// tools/small/bodies.json, against the source read an independent way by tools/small/verify.py: its own float64 separable area
// average over the GDAL georeference (mean |encoded - reference| < 4/255, four detailed patches registered within one level pixel),
// and the IAU gazetteer read on the ENCODED mosaic (no mirror, left edge 180 E: the longitude convention).
//   SMALL_WORK=<dir with src/ derived/ gaz/>  SMALL_BODIES=key,key (default: every body)  node --test tests/small.e2e.test.mjs
// Also: the same row encoded by 1 and 2 workers is byte-identical; with SMALL_VERIFY_R2=1 and R2_AWS=<command running aws against
// the bucket>, every file of each body's local ledger (SMALL_OUT) is in imagery/<naif>/ with its bytes and md5 (ETag), MANIFEST.json
// matches the ledger, and a HEAD of https://terrain.spacedatanetwork.org/imagery/<naif>/root.dtts with Origin https://spaceaware.io
// answers 200 + Access-Control-Allow-Origin.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(HERE, "../tools/small");
const WORK = process.env.SMALL_WORK;
const OUT = process.env.SMALL_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "small-e2e-"));
const doc = JSON.parse(fs.readFileSync(path.join(TOOLS, "bodies.json"), "utf8"));
const want = process.env.SMALL_BODIES?.split(",");
const bodies = doc.bodies.filter((b) => !want || want.includes(b.key));
const node = (script, args, opts = {}) => spawnSync(process.execPath, [path.join(TOOLS, script), ...args], { encoding: "utf8", maxBuffer: 1 << 28, ...opts });

test("the source table is the sources' own headers", { skip: !WORK }, () => {
  const out = path.join(os.tmpdir(), `sources-${process.pid}.hpp`);
  execFileSync("python3", ["-I", path.join(TOOLS, "gen-sources.py"), "--dir", WORK, "--out", out], { stdio: "pipe" });
  assert.equal(fs.readFileSync(out, "utf8"), fs.readFileSync(path.join(HERE, "../src/sources_small.hpp"), "utf8"));
  fs.rmSync(out);
});

test("byte-identical at any worker count", { skip: !WORK }, () => {
  const b = bodies.find((x) => x.max_level <= 4 && !x.derived) ?? bodies[0];
  const sums = [1, 2].map((w) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `small-w${w}-`));
    const r = node("encode.mjs", ["--body", b.key, "--out", dir, "--workers", String(w), "--derived", path.join(WORK, "derived")]);
    assert.equal(r.status, 0, r.stderr);
    const ledger = fs.readFileSync(path.join(dir, `ledger-${b.naif}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    fs.rmSync(dir, { recursive: true });
    return ledger.map((e) => `${e.path} ${e.sha256}`).sort().join("\n");
  });
  assert.equal(sums[0], sums[1]);
});

for (const b of bodies) {
  test(`${b.body}: encode, registration, orientation`, { skip: !WORK }, () => {
    if (!fs.existsSync(path.join(OUT, `ledger-${b.naif}.jsonl`))) {
      const r = node("encode.mjs", ["--body", b.key, "--out", OUT, "--workers", "2", "--derived", path.join(WORK, "derived")]);
      assert.equal(r.status, 0, r.stderr);
    }
    const v = spawnSync("python3", ["-I", path.join(TOOLS, "verify.py"), "--body", b.key, "--out", OUT, "--work", WORK], { encoding: "utf8", maxBuffer: 1 << 28 });
    assert.equal(v.status, 0, v.stdout + v.stderr);
    const result = JSON.parse(v.stdout.split("\n").find((l) => l.startsWith("RESULT ")).slice(7));
    assert.ok(result.mad < 4 && result.registration_ok && result.orientation_ok !== false, JSON.stringify(result));
  });

  test(`${b.body}: published to R2`, { skip: process.env.SMALL_VERIFY_R2 !== "1" }, async () => {
    const aws = (process.env.R2_AWS ?? "").split(" ").filter(Boolean);
    const run = (args) => execFileSync(aws[0], [...aws.slice(1), ...args], { maxBuffer: 1 << 30 }).toString();
    const ledger = new Map();
    for (const line of fs.readFileSync(path.join(OUT, `ledger-${b.naif}.jsonl`), "utf8").trim().split("\n")) { const e = JSON.parse(line); ledger.set(e.path, e); }
    const have = new Map();
    let token;
    do {
      const res = JSON.parse(run(["s3api", "list-objects-v2", "--bucket", "spaceaware", "--prefix", `imagery/${b.naif}/`, "--output", "json", ...(token ? ["--starting-token", token] : [])]) || "{}");
      for (const o of res.Contents ?? []) have.set(o.Key, { size: o.Size, etag: o.ETag.replaceAll('"', "") });
      token = res.NextToken;
    } while (token);
    for (const e of ledger.values()) assert.deepEqual(have.get(e.path), { size: e.bytes, etag: e.md5 }, e.path);
    const manifest = JSON.parse(run(["s3", "cp", `s3://spaceaware/imagery/${b.naif}/MANIFEST.json`, "-"]));
    assert.equal(manifest.files, ledger.size);
    assert.equal(manifest.credit, b.credit);
    const head = await fetch(`https://terrain.spacedatanetwork.org/imagery/${b.naif}/root.dtts`, { method: "HEAD", headers: { origin: "https://spaceaware.io" } });
    assert.equal(head.status, 200);
    assert.ok(head.headers.get("access-control-allow-origin"));
    const sha = crypto.createHash("sha256").update(Buffer.from(await (await fetch(`https://terrain.spacedatanetwork.org/imagery/${b.naif}/root.dtts`)).arrayBuffer())).digest("hex");
    assert.equal(sha, ledger.get(`imagery/${b.naif}/root.dtts`).sha256);
  });
}
