import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";

// Fixtures are real NAIF records: the Sun (10) and Earth-Moon barycentre (3)
// segments of DE440s for 2020-2030 and the DE440 lunar PA records for the same
// decade, as CSPICE spksub/pckw02 cut them (Phase-1 dataset, 2026-10-12). They
// stand in for de440s.bsp and moon_pa_de440_200625.bpc; every other source
// answers an empty DAF. The module must copy the records unchanged and fetch
// only the ranges it needs. (The full run against the live NAIF and SSD files,
// 159 MB of ranges, produced all 53 Phase-1 files with every segment
// descriptor, name and data word identical.)
const require = createRequire(import.meta.url);
const sds = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(require.resolve("spacedatastandards.org/package.json"));
const { ByteBuffer } = require("flatbuffers");
const { PNM } = await import(pathToFileURL(path.join(sds, "lib/js/PNM/main.js")));
const wasmPath = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url)));
const wasm = fs.readFileSync(wasmPath);
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const de440s = fixture("de440s-2020-sun-emb.bsp");
const moon = fixture("moon-pa-2020.bpc");

// An empty DAF: file record, one summary record with no summaries, one name record.
function emptyDaf(pck) {
  const b = Buffer.alloc(3 * 1024);
  b.write(pck ? "DAF/PCK " : "DAF/SPK ", 0, "latin1");
  b.writeInt32LE(2, 8); b.writeInt32LE(pck ? 5 : 6, 12);
  b.writeInt32LE(2, 76); b.writeInt32LE(2, 80); b.writeInt32LE(3 * 128 + 1, 84);
  b.write("LTL-IEEE", 88, "latin1");
  return b;
}
const served = new Map();
function serve(url) {
  const base = url.split("?")[0];
  if (base.endsWith("/de440s.bsp")) return de440s;
  if (base.endsWith("/moon_pa_de440_200625.bpc")) return moon;
  if (base.endsWith(".bsp")) return emptyDaf(false);
  if (/\.(tpc|tf)$/.test(base)) {
    if (!served.has(base)) served.set(base, Buffer.from(`KPL/PCK\n\\begindata\nSTUB_${path.basename(base).replace(/\W/g, "_")} = ( 1 )\n`));
    return served.get(base);
  }
  return null;
}
function respond(request, status304 = false) {
  const header = Buffer.alloc(8);
  header.write("$HRB");
  if (status304) { header.writeInt32LE(304, 4); return header; }
  const bytes = serve(request.url);
  if (!bytes) { header.writeInt32LE(404, 4); return header; }
  const range = request.headers?.Range;
  if (!range) { header.writeInt32LE(200, 4); return Buffer.concat([header, bytes]); }
  const [a, b] = range.slice(6).split("-").map(Number);
  header.writeInt32LE(206, 4);
  return Buffer.concat([header, bytes.subarray(a, Math.min(b + 1, bytes.length))]);
}
const input = (portId, value) => {
  const payload = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
  return { portId, payload, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.length } };
};
const outs = (r, port) => r.outputs.filter((f) => f.portId === port).map((f) => Buffer.from(f.payload));
const J = (b) => JSON.parse(b.toString());
async function harness(t) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: "direct" });
  t.after(() => h.destroy());
  return h;
}

// DAF segments: descriptor, name and the data words, independent of addresses.
function segments(bytes) {
  const nd = bytes.readInt32LE(8), ni = bytes.readInt32LE(12), ss = nd + Math.ceil(ni / 2);
  const out = [];
  for (let rec = bytes.readInt32LE(76); rec;) {
    const o = (rec - 1) * 1024, n = bytes.readDoubleLE(o + 16);
    for (let i = 0; i < n; i++) {
      const s = o + 24 + i * ss * 8;
      const ic = Array.from({ length: ni }, (_, j) => bytes.readInt32LE(s + 16 + j * 4));
      out.push({ dc: [bytes.readDoubleLE(s), bytes.readDoubleLE(s + 8)], ic: ic.slice(0, ni - 2),
        name: bytes.subarray(o + 1024 + i * ss * 8, o + 1024 + (i + 1) * ss * 8).toString("latin1").trimEnd(),
        data: bytes.subarray((ic[ni - 2] - 1) * 8, ic[ni - 1] * 8) });
    }
    rec = bytes.readDoubleLE(o);
  }
  return out;
}

async function runAll(h) {
  let result = await h.invoke({ methodId: "plan_kernels", inputs: [input("config", { access: "anonymous" })] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  let fetched = 0;
  for (let stage = 1; stage <= 5; stage++) {
    const requests = outs(result, "request").map(J);
    const responses = requests.map((r) => respond(r));
    fetched += responses.reduce((n, r) => n + r.length - 8, 0);
    const state = outs(result, "state")[0];
    result = await h.invoke({ methodId: stage < 5 ? "advance" : "build_kernels", inputs: [input("state", state), ...responses.map((r) => input("response", r))] });
    assert.equal(result.statusCode, 0, `stage ${stage}: ${result.errorMessage}`);
  }
  const files = new Map(outs(result, "file").map((f) => {
    const n = f.readUInt32LE(0);
    return [f.subarray(4, 4 + n).toString(), f.subarray(4 + n)];
  }));
  return { files, job: J(outs(result, "job")[0]), fetched };
}

test("the artifact satisfies the SDK contract", async () => {
  const report = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: sds });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test("every range has its own URL and the first stage asks only for DAF file records", async (t) => {
  const h = await harness(t);
  const result = await h.invoke({ methodId: "plan_kernels", inputs: [input("config", { access: "anonymous" })] });
  const requests = outs(result, "request").map(J);
  assert.equal(requests.length, 9);
  for (const r of requests) {
    assert.equal(r.headers.Range, "bytes=0-1023");
    assert.equal(r.url.endsWith("?sdn-range=0-1023"), true);
    assert.match(r.url, /^https:\/\/(naif|ssd)\.jpl\.nasa\.gov\//);
  }
});

test("a decade shard carries the source's Chebyshev records unchanged, fetched by range", async (t) => {
  const h = await harness(t);
  const { files, job, fetched } = await runAll(h);
  const core = segments(files.get("core-2020.bsp"));
  const source = segments(de440s);
  assert.deepEqual(core.map((s) => s.ic[0]), source.map((s) => s.ic[0])); // the source order
  for (const target of [3, 10]) {
    const a = core.find((s) => s.ic[0] === target), b = source.find((s) => s.ic[0] === target);
    assert.deepEqual(a.dc, b.dc);
    assert.deepEqual(a.ic, b.ic);
    assert.equal(a.name, b.name);
    assert.equal(Buffer.compare(a.data, b.data), 0, `segment ${target} data differs`);
  }
  const lunar = segments(files.get("moon-pa-2020.bpc")), lunarSource = segments(moon);
  assert.equal(lunar.length, 1);
  assert.deepEqual(lunar[0].ic, lunarSource[0].ic);
  assert.equal(Buffer.compare(lunar[0].data, lunarSource[0].data), 0, "lunar PA data differs");
  for (const name of ["pck00011.tpc", "gm_de440.tpc", "moon_de440_250416.tf"]) {
    assert.equal(Buffer.compare(files.get(name), [...served.entries()].find(([u]) => u.endsWith(name))[1]), 0);
  }
  // Only the records a shard needs crossed the wire: less than the sources.
  assert.ok(fetched < de440s.length + moon.length + 64 * 1024, `fetched ${fetched} bytes`);
  const listed = job.files.map((f) => f.file);
  assert.ok(listed.includes("core-2020.bsp") && listed.includes("moon-pa-2020.bpc"));
});

test("an unchanged cycle ends at the first stage", async (t) => {
  const h = await harness(t);
  const plan = await h.invoke({ methodId: "plan_kernels", inputs: [input("config", { access: "anonymous" })] });
  const requests = outs(plan, "request").map(J);
  const result = await h.invoke({ methodId: "advance", inputs: [input("state", outs(plan, "state")[0]), ...requests.map((r) => input("response", respond(r, true)))] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.equal(outs(result, "request").length, 0);
  assert.deepEqual(J(outs(result, "status")[0]), { skipped: "not-modified", status: 304, unchanged: true });
});

test("announces one $PNM per added file with its CID, and refuses a missing add", async (t) => {
  const h = await harness(t);
  const { job } = await runAll(h);
  const receipt = { retrieved_at_ms: 1791800000000, producer_peer_id: "16Uiu2HAmTest" };
  const added = job.files.map((f, i) => ({ name: f.file, cid: `bafkreitest${i}`, bytes: f.bytes }));
  const result = await h.invoke({ methodId: "announce_kernels", inputs: [input("job", job), input("receipt", receipt), ...added.map((a) => input("added", a))] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  const bytes = result.outputs.find((f) => f.portId === "records").payload;
  const records = [];
  for (let o = 0; o < bytes.length;) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + o, 4).getUint32(0, true) + 4;
    records.push(PNM.getSizePrefixedRootAsPNM(new ByteBuffer(bytes.slice(o, o + size))).unpack());
    o += size;
  }
  assert.equal(records.length, job.files.length);
  const core = records.find((r) => r.FILE_NAME === "core-2020.bsp");
  const index = job.files.findIndex((f) => f.file === "core-2020.bsp");
  assert.equal(core.CID, `bafkreitest${index}`);
  assert.equal(core.MULTIFORMAT_ADDRESS, `/ipfs/bafkreitest${index}`);
  assert.equal(core.FILE_ID, `naif:ssb-kernels:core-2020.bsp:${job.files[index].sha256}`);
  const meta = J(Buffer.from(result.outputs.find((f) => f.portId === "meta").payload));
  assert.equal(meta.schema, "PNM.fbs");
  assert.equal(meta.provider_id, "naif");
  assert.equal(meta.source_name, "ssb-kernels");
  const missing = await h.invoke({ methodId: "announce_kernels", inputs: [input("job", job), input("receipt", receipt), ...added.slice(1).map((a) => input("added", a))] });
  assert.notEqual(missing.statusCode, 0);
  assert.equal(missing.outputs.length, 0);
});
