import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { coarsen, assertGlobalCoverage, reductionLineage, REDUCER_PROCESSOR, DTT_STREAM_TYPE } from "../coarsen.mjs";
import { readDtt, readDttProvenance, splitStream } from "../dtt-reader.mjs";
import { writeDttRecord } from "../dtt-projection.mjs";
import { sha256 } from "../build-support.mjs";
import * as sds from "../../../data-source/terrain-source/node_modules/spacedatastandards.org/index.js";

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-native-coarsen-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function framed(record) { const prefix = Buffer.alloc(4); prefix.writeUInt32LE(record.length); return Buffer.concat([prefix, record]); }
// Schema-backed opaque I/O fixtures. These deliberately do not claim mesh or
// water numerical validity; native reduce_parent tests own those assertions.
function record({ level, x, y, children = null, queryOverride = {}, confidence = 1, processor = REDUCER_PROCESSOR }) {
  const query = children && {
    method: "reduce_parent", version: 1,
    children: children.map((bytes) => {
      const tile = readDtt(bytes);
      return { level: tile.level, x: tile.x, y: tile.y, digest: `1220${sha256(bytes)}` };
    }),
    heightBound: "child-cell-parent-cell-envelope-v1", waterReduction: "coverage-2x2-round-half-up-v1",
    meshDifferenceBoundM: 0, inheritedAccuracyComplete: confidence === 1, ...queryOverride,
  };
  return Buffer.from(writeDttRecord(sds, {
    TILESET_ID: "native-coarsen-io-fixture", TILING_SCHEME: "GEOGRAPHIC_WGS84", LEVEL: level, X: x, Y: y,
    PAYLOAD_FORMAT: "QUANTIZED_MESH", PAYLOAD_FORMAT_VERSION: "1.0",
    PAYLOAD: { BYTES: Uint8Array.of(1, 2, 3), SIZE_BYTES: 3 },
    VERTICAL_DATUM: "GEOID", VERTICAL_DATUM_NAME: "EGM2008", ACCURACY_CONFIDENCE: confidence,
    PROVENANCE: {
      DATASET_ID: "io-fixture", DATASET_EPOCH: "2026-09-09T00:00:00.000Z",
      RETRIEVED_AT: "2026-09-09T00:00:00.000Z", LICENSE: "test fixture",
      ...(children ? { SOURCE_QUERY: JSON.stringify(query), PROCESSOR: processor } : {}),
    },
  })).subarray(4);
}
function setup(t, level = 2) {
  const dir = temporary(t);
  const records = [];
  for (let y = 0; y < 2 ** level; y += 1) for (let x = 0; x < 2 ** (level + 1); x += 1) records.push(record({ level, x, y }));
  const inputFile = path.join(dir, "leaves.dttstream");
  fs.writeFileSync(inputFile, Buffer.concat([...records].reverse().map(framed)));
  return { dir, records, inputFile, outDir: path.join(dir, "output"), baseLevel: level, maxOutputBytes: 8 * 1024 ** 2 };
}
function nativeBoundary(onChildren = null) {
  return async (bytes) => {
    assert.ok(bytes instanceof Uint8Array);
    const children = [...splitStream(bytes)].map(Buffer.from);
    assert.equal(children.length, 4);
    onChildren?.(children);
    const child = readDtt(children[0]);
    return framed(record({ level: child.level - 1, x: Math.floor(child.x / 2), y: Math.floor(child.y / 2), children }));
  };
}
test("opaque native reduction sorts complete quartets and atomically receipts all levels", async (t) => {
  const options = setup(t);
  const before = fs.readFileSync(options.inputFile);
  let calls = 0;
  const result = await coarsen({ ...options, reduce: nativeBoundary((children) => {
    calls += 1;
    children.forEach((bytes, quadrant) => {
      const tile = readDtt(bytes);
      assert.equal(tile.y % 2 * 2 + tile.x % 2, quadrant);
    });
  }) });
  assert.equal(calls, 10); assert.equal(result.leaves, 32); assert.equal(result.parents, 10);
  assert.deepEqual(result.counts, { 0: 2, 1: 8, 2: 32 });
  assert.deepEqual(fs.readFileSync(options.inputFile), before);
  const output = fs.readFileSync(path.join(options.outDir, "tiles.dttstream"));
  assert.equal(result.output.sha256, sha256(output));
  const all = [...splitStream(output)];
  assert.deepEqual(all.slice(0, 32).map((r) => sha256(r)), [...options.records].reverse().map((r) => sha256(r)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(options.outDir, "coarsen-report.json"))), result);
  assert.deepEqual(fs.readdirSync(options.outDir).sort(), ["coarsen-report.json", "tiles.dttstream"]);
});
test("missing and duplicate children never yield a completion receipt", async (t) => {
  for (const kind of ["missing", "duplicate"]) {
    const options = setup(t, 1);
    const children = options.records.slice(0, 4);
    if (kind === "missing") children.pop(); else children[3] = children[0];
    fs.writeFileSync(options.inputFile, Buffer.concat(children.map(framed)));
    await assert.rejects(coarsen({ ...options, global: false, reduce: nativeBoundary() }), /incomplete native child quartet|duplicate or missing child|duplicate child/);
    assert.equal(fs.existsSync(path.join(options.outDir, "coarsen-report.json")), false);
  }
});
test("global leaf holes fail before native work and count equality cannot hide duplicate addresses", async (t) => {
  for (const sameCount of [false, true]) {
    const options = setup(t, 1);
    const children = [...options.records]; children.pop(); if (sameCount) children.push(children[0]);
    fs.writeFileSync(options.inputFile, Buffer.concat(children.map(framed)));
    let calls = 0;
    await assert.rejects(coarsen({ ...options, reduce: nativeBoundary(() => { calls += 1; }) }), /coverage is incomplete|duplicate/);
    if (!sameCount) assert.equal(calls, 0);
    assert.equal(fs.existsSync(path.join(options.outDir, "coarsen-report.json")), false);
  }
});
test("wrong native parent, changed lineage, extra frames and native refusal fail closed", async (t) => {
  for (const mode of ["address", "lineage", "extra", "refusal"]) {
    const options = setup(t, 1);
    await assert.rejects(coarsen({ ...options, reduce: async (bytes) => {
      if (mode === "refusal") throw new Error("native refusal");
      const children = [...splitStream(bytes)]; const child = readDtt(children[0]);
      const queryOverride = mode === "lineage" ? { children: children.map((r) => ({ ...readDtt(r), digest: `1220${"0".repeat(64)}` })) } : {};
      const parent = framed(record({ level: 0, x: mode === "address" ? 1 : Math.floor(child.x / 2), y: 0, children, queryOverride }));
      return mode === "extra" ? Buffer.concat([parent, parent]) : parent;
    } }), /wrong parent|lineage|exactly one parent|native refusal/);
    assert.equal(fs.existsSync(path.join(options.outDir, "coarsen-report.json")), false);
  }
});
test("output byte budget applies before completion and source mutation while awaiting native work is refused", async (t) => {
  const small = setup(t, 1);
  await assert.rejects(coarsen({ ...small, maxOutputBytes: fs.statSync(small.inputFile).size + 1, reduce: nativeBoundary() }), /output byte budget/);
  assert.equal(fs.existsSync(path.join(small.outDir, "coarsen-report.json")), false);
  const changed = setup(t, 1);
  let mutated = false;
  await assert.rejects(coarsen({ ...changed, reduce: nativeBoundary(() => {
    if (!mutated) { fs.appendFileSync(changed.inputFile, Buffer.alloc(4)); mutated = true; }
  }) }), /changed while coarsening/);
  assert.equal(fs.existsSync(path.join(changed.outDir, "coarsen-report.json")), false);
});
test("existing output and symbolic-link inputs are refused without changing their contents", async (t) => {
  const options = setup(t, 1);
  fs.mkdirSync(options.outDir); fs.writeFileSync(path.join(options.outDir, "foreign"), "keep");
  await assert.rejects(coarsen({ ...options, reduce: nativeBoundary() }), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(options.outDir, "foreign"), "utf8"), "keep");
  const link = path.join(options.dir, "input-link"); fs.symlinkSync(options.inputFile, link);
  await assert.rejects(coarsen({ ...options, inputFile: link, outDir: path.join(options.dir, "second"), reduce: nativeBoundary() }), /ELOOP/);
});
test("oversized framing is rejected before allocating the declared record", async (t) => {
  const options = setup(t, 1); const prefix = Buffer.alloc(4); prefix.writeUInt32LE(0xffffffff);
  fs.writeFileSync(options.inputFile, prefix);
  await assert.rejects(coarsen({ ...options, reduce: nativeBoundary() }), /exceeds|maxRecordBytes|record.*bound/);
});
test("finalization failure leaves no successful coarsen receipt", async (t) => {
  const options = setup(t, 1);
  await assert.rejects(coarsen({ ...options, reduce: nativeBoundary(), finalize: async () => { throw new Error("metadata refused"); } }), /metadata refused/);
  assert.equal(fs.existsSync(path.join(options.outDir, "coarsen-report.json")), false);
});
test("derived accuracy remains explicitly unavailable and native processor metadata is read verbatim", () => {
  const children = [0, 1, 2, 3].map((q) => record({ level: 1, x: q % 2, y: Math.floor(q / 2) }));
  const parent = record({ level: 0, x: 0, y: 0, children, confidence: 0 });
  assert.equal(readDttProvenance(parent).raw.PROCESSOR, REDUCER_PROCESSOR);
  assert.equal(reductionLineage(parent).inheritedAccuracyComplete, false);
  assert.throws(() => reductionLineage(record({ level: 0, x: 0, y: 0, children, processor: "unknown" })), /native reducer processor/);
  assert.throws(() => reductionLineage(record({ level: 0, x: 0, y: 0, children, confidence: 0.5 })), /confidence/);
});
test("global completeness requires two geographic roots and every intervening level", () => {
  assertGlobalCoverage({ 0: 2, 1: 8, 2: 32 }, 2);
  assert.throws(() => assertGlobalCoverage({ 0: 1, 1: 8, 2: 32 }, 2), /z0/);
  assert.throws(() => assertGlobalCoverage({ 0: 2, 2: 32 }, 2), /z1/);
});

test("actual compiled native reducer passes opaque host transport and the production verifier", async (t) => {
  const nativeDir = new URL("../../../data-source/terrain-source/", import.meta.url);
  const { createBrowserModuleHarness } = await import(new URL("node_modules/space-data-module-sdk/src/testing/index.js", nativeDir));
  const wasm = fs.readFileSync(new URL("dist/isomorphic/module.wasm", nativeDir));
  const manifest = JSON.parse(fs.readFileSync(new URL("plugin-manifest.json", nativeDir), "utf8"));
  const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: "direct" });
  t.after(() => harness.destroy());
  const dir = temporary(t); const inputFile = path.join(dir, "leaves.dttstream");
  const sourceBytes = fs.readFileSync(new URL("tests/fixtures/parent-lod/analytic.dttstream", nativeDir));
  fs.writeFileSync(inputFile, sourceBytes);
  let calls = 0;
  const outDir = path.join(dir, "derived");
  const report = await coarsen({ inputFile, outDir, baseLevel: 8, minimumLevel: 7, global: false,
    maxOutputBytes: 1024 * 1024, runtime: { wasmSha256: sha256(wasm) },
    reduce: async (payload) => {
      calls += 1;
      const response = await harness.invoke({ methodId: "reduce_parent", inputs: [{ portId: "children", typeRef: DTT_STREAM_TYPE, payload }] });
      assert.equal(response.statusCode, 0, response.errorMessage);
      return response.outputs.find((output) => output.portId === "records").payload;
    },
  });
  assert.equal(calls, 1); assert.equal(report.parents, 1); assert.equal(report.leaves, 4);
  assert.deepEqual(fs.readFileSync(inputFile), sourceBytes);
  await promisify(execFile)(process.execPath, [new URL("../verify.mjs", import.meta.url).pathname, "--out", outDir], { maxBuffer: 1024 * 1024 });
  const verified = JSON.parse(fs.readFileSync(path.join(outDir, "verify-report.json"), "utf8"));
  assert.equal(verified.validated, true); assert.equal(verified.nativeDerivedAccuracy.tiles, 1);
  assert.equal(verified.nativeDerivedAccuracy.withInheritedSourceAccuracy, 1);
  assert.equal(verified.tilesStatingMeasuredAccuracy, 4);
});
