import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import zlib from "node:zlib";

import {
  BoundedGranuleCache,
  canonicalJson,
  compareCodeUnits,
  createSortedJsonRunWriter,
  evaluateTerrainEdgeFacts,
  fetchWithRetry,
  initializeGlobalState,
  iterateBoundedLines,
  MAX_GLOBAL_SHARDS,
  makeShardConfigs,
  markShard,
  recordSetDigest,
  readGenerationCacheEntry,
  saveGlobalState,
  sha256,
  mergeSortedJsonRuns,
  writeSortedJsonRuns,
} from "../build-support.mjs";
import { iterateStreamFile, readDtt } from "../dtt-reader.mjs";
import { writeDttRecord } from "../dtt-projection.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SUPPORT_URL = new URL("../build-support.mjs", import.meta.url).href;
const COORDINATOR = path.join(HERE, "..", "global-build.mjs");
const REHEARSAL_RUNNER = path.join(HERE, "fixtures", "rehearsal-runner.mjs");
const REAL_REHEARSAL = path.join(HERE, "..", "rehearse.mjs");
const VERIFY = path.join(HERE, "..", "verify.mjs");
const SOURCE_SDS = path.join(HERE, "..", "..", "..", "data-source", "terrain-source", "node_modules", "spacedatastandards.org", "index.js");
// The generated FlatBuffer SDK alone exceeds Node 25's 32 MiB startup heap.
// Keep the production verifier's tight-heap proof independent of that test
// fixture generator; normal runs still exercise the schema-backed fixtures.
const tightHeapSuite = process.execArgv.some((arg) => arg === "--max-old-space-size=32");
const sds = tightHeapSuite ? null : await import(SOURCE_SDS);
const schemaTest = (name, options, fn) => test(name, { ...options, skip: tightHeapSuite || options?.skip }, fn);
// A schema-generated, one-frame fixture committed as bytes so this production
// verifier proof does not load the SDK that itself exceeds a 32 MiB Node heap.
const TIGHT_HEAP_DTTSTREAM = "tAIAAGAAAAAkRFRUAABWAHgAdAAAAHMAbAAAAAAAAABkAFwAVABMAEQAPAA7ADQAMAAAAAAAAAAAAC8AKAAAAAAAHAAAABQAAAATAAAAAAAAAAAAAAAAAAAADAAAAAgAAAAEAFYAAAB0AAAA1AAAAAwAAAAAAAABAAAAAAAA8D8AAAAAAADwPwAAAAA0AQAAAAAAAkgBAAD4AQAAAAAAAQAAAAAAAPA/AAAAAAAA8D8AAAAAAOBQwAAAAAAAsGPAAAAAAACAVsAAAAAAAIBmwAMAAAAAAAABwAEAAEYAAAAiMTIyMDA3NjgwOWJmYmRiOWMyOGRiZDlhMjBhYTM3NTkyODYxZDZmMDliYWU4YzBlYjNlM2Q2NGE3OGFjY2IyZGEyMjIiAAAAABYAFAAQAAAAAAAMAAAAAAAAAAgABAAWAAAAEAAAACAAAAA8AAAAWAAAAAwAAAB0ZXN0IGxpY2VuY2UAAAAAGAAAADIwMjYtMDktMDFUMDA6MDA6MDAuMDAwWgAAAAAYAAAAMjAyNi0wOS0wMVQwMDowMDowMC4wMDBaAAAAABEAAABzdHJlYW1pbmctZml4dHVyZQAAAAcAAABFR00yMDA4AAAADgAYAAAAFAAMAAgABAAOAAAAFAAAABwAAAA/AAAAAAAAAFwAAAAEAAAAZ3ppcAAAAABEAAAAMTIyMDA3NjgwOWJmYmRiOWMyOGRiZDlhMjBhYTM3NTkyODYxZDZmMDliYWU4YzBlYjNlM2Q2NGE3OGFjY2IyZGEyMjIAAAAAPwAAAB+LCAAAAAAAABNjYMAFGuwhmDzAAib//Wdg+PsfxoIBJjiLmYERzmeG0oxgGkQygeWA4iBFDADgWE+9qgAAAAADAAAAMS4wABoAAABzdHJlYW1pbmctdmVyaWZpZXItZml4dHVyZQAA";

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-global-build-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function response(status, body = "") {
  return { status, ok: status >= 200 && status < 300, arrayBuffer: async () => Buffer.from(body) };
}

test("production verifier accepts a schema fixture in a 32 MiB child heap", async (t) => {
  const outDir = temporary(t);
  fs.writeFileSync(path.join(outDir, "tiles.dttstream"), Buffer.from(TIGHT_HEAP_DTTSTREAM, "base64"));
  await execFileAsync(process.execPath, ["--max-old-space-size=32", VERIFY, "--out", outDir, "--json"], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const report = JSON.parse(fs.readFileSync(path.join(outDir, "verify-report.json"), "utf8"));
  assert.equal(report.tiles, 1);
  assert.equal(report.layerJson.availabilityPath, "terrain-available.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, "terrain-available.json"), "utf8"))[0], [{ startX: 0, startY: 0, endX: 1, endY: 0 }]);
  assert.match(fs.readFileSync(path.join(outDir, "available-but-unstored.ndjson"), "utf8"), /^0\/1\/0$/m,
    "the forced opposite level-zero root is a promised static tile");
});

schemaTest("production verifier completes a high-record global-style stream in a 32 MiB child heap", { timeout: 180_000 }, async (t) => {
  const outDir = temporary(t);
  const records = 20_000;
  const handle = fs.openSync(path.join(outDir, "tiles.dttstream"), "w");
  try {
    // 20 distinct z9 rows force hundreds of fact runs and multi-pass bounded
    // joins; unlike a duplicate-failure probe, this reaches all PASS outputs.
    for (let index = 0; index < records; index += 1) {
      appendTerrainFrame(handle, syntheticTerrainRecord({
        level: 9,
        x: index % 1024,
        y: Math.floor(index / 1024),
        serial: index,
      }));
    }
  } finally {
    fs.closeSync(handle);
  }
  await execFileAsync(process.execPath, ["--max-old-space-size=32", VERIFY, "--out", outDir, "--json"], {
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  });
  const report = JSON.parse(fs.readFileSync(path.join(outDir, "verify-report.json"), "utf8"));
  assert.equal(report.tiles, records);
  assert.equal(report.distinctAddresses, records);
  assert.equal(report.problemCount, 0);
  assert.ok(report.edgeAdjacenciesChecked > 10_000, "high-record child must reach bounded edge validation");
});

test("bounded cache evicts completed cells but never a leased granule", async (t) => {
  const cache = new BoundedGranuleCache({ dir: temporary(t), maxBytes: 1000, owner: "test", now: (() => { let n = 0; return () => ++n; })() });
  const a = "a".repeat(600);
  const b = "b".repeat(600);
  await cache.fetch("https://example.test/a", { fetchImpl: async () => response(200, a) });
  assert.ok(cache.usageBytes() <= 1000);
  await assert.rejects(
    cache.fetch("https://example.test/b", { fetchImpl: async () => response(200, b) }),
    /leased granules/,
  );
  await cache.release("https://example.test/a");
  await cache.release("https://example.test/b");
  await cache.fetch("https://example.test/b", { fetchImpl: async () => response(200, b) });
  assert.ok(cache.usageBytes() <= 1000);
  assert.equal(await cache.get("https://example.test/a"), null);
  assert.equal((await cache.get("https://example.test/b")).body.toString(), b);
  assert.equal(cache.evictions, 1);
});

test("transient source failures retry deterministically and 404 does not", async () => {
  let calls = 0;
  const delays = [];
  const result = await fetchWithRetry("https://example.test/transient", {
    retries: 3,
    retryBaseMs: 5,
    sleepImpl: async (ms) => delays.push(ms),
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("socket reset");
      return response(200, "ok");
    },
  });
  assert.equal(result.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [5, 10]);
  calls = 0;
  const missing = await fetchWithRetry("https://example.test/missing", {
    retries: 3,
    fetchImpl: async () => { calls += 1; return response(404); },
  });
  assert.equal(missing.status, 404);
  assert.equal(calls, 1);
});

test("deterministic shard configs cover each regional longitude slice once", () => {
  const config = {
    flow_config: {
      regions: [{ name: "proof", west: 0, south: 40, east: 4, north: 42, max_level: 8, priority: 1 }],
    },
  };
  const first = makeShardConfigs(config, 2, { outDir: "/out", cacheDir: "/cache", cacheMaxBytes: 100 });
  const second = makeShardConfigs(config, 2, { outDir: "/out", cacheDir: "/cache", cacheMaxBytes: 100 });
  assert.deepEqual(first, second);
  const slices = first.flatMap((shard) => shard.flow_config.regions.map((r) => [r.west, r.east]));
  assert.deepEqual(slices, [[0, 1], [1, 2], [2, 3], [3, 4]]);
  assert.equal(first[0].global_shard.config_digest, sha256('{"flow_config":{"regions":[{"east":4,"max_level":8,"name":"proof","north":42,"priority":1,"south":40,"west":0}]}}'));
});

test("coordinator shard/region bounds reject unbounded allocations before slicing or state creation", async (t) => {
  const out = temporary(t);
  const bounded = {
    flow_config: {
      regions: [{ name: "proof", west: 0, south: 0, east: 1, north: 1 }],
    },
  };
  assert.throws(() => makeShardConfigs(bounded, MAX_GLOBAL_SHARDS + 1),
    /shardCount must be in/);
  assert.throws(() => initializeGlobalState(out, bounded, MAX_GLOBAL_SHARDS + 1),
    /shardCount must be in/);
  // This previously reached splitRegion's degree loop and allocated one cut
  // per arbitrary longitude degree. Canonical WGS84 input is rejected first.
  assert.throws(() => makeShardConfigs({
    flow_config: { regions: [{ name: "unbounded", west: -1_000_000_000, south: 0, east: 1_000_000_000, north: 1 }] },
  }, 1), /canonical longitude bounds/);
  assert.throws(() => makeShardConfigs({
    flow_config: { regions: [{ name: "wrapped", west: 170, south: 0, east: 190, north: 1 }] },
  }, 1), /canonical longitude bounds/);
  await assert.rejects(execFileAsync(process.execPath, [
    COORDINATOR, "--config", path.join(out, "never-read.json"), "--out", path.join(out, "coordinator-out"),
    "--shards", String(MAX_GLOBAL_SHARDS + 1),
  ]), /--shards may not exceed/);
});

test("state refuses a changed config and preserves a completed shard on resume", (t) => {
  const out = temporary(t);
  const config = { flow_config: { regions: [{ name: "proof", west: 0, south: 0, east: 2, north: 1 }] } };
  const state = initializeGlobalState(out, config, 2);
  markShard(state, 0, "running");
  markShard(state, 0, "complete", { outputDigest: "abc" });
  saveGlobalState(out, state);
  const resumed = initializeGlobalState(out, config, 2);
  assert.equal(resumed.shards[0].status, "complete");
  assert.equal(resumed.shards[0].attempts, 1);
  assert.throws(
    () => initializeGlobalState(out, { ...config, cache_max_bytes: 99 }, 2),
    /different config bytes/,
  );
});

test("stream reader carries frames across chunks without loading a full stream", async (t) => {
  const file = path.join(temporary(t), "tiles.dttstream");
  const frames = [Buffer.from("first"), Buffer.from("second-record")];
  fs.writeFileSync(file, Buffer.concat(frames.flatMap((frame) => {
    const length = Buffer.alloc(4); length.writeUInt32LE(frame.length); return [length, frame];
  })));
  const actual = [];
  for await (const frame of iterateStreamFile(file, { highWaterMark: 3 })) actual.push(frame.toString());
  assert.deepEqual(actual, ["first", "second-record"]);
});

test("stream reader rejects a corrupt oversized prefix before buffering it", async (t) => {
  const file = path.join(temporary(t), "oversized.dttstream");
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(1024 * 1024 + 1);
  fs.writeFileSync(file, prefix);
  await assert.rejects(async () => {
    for await (const unused of iterateStreamFile(file, { highWaterMark: 2 })) void unused;
  }, /terrain safety limit/);
});

test("read-only accuracy consumers resolve the cache current generation, not the retired flat layout", async (t) => {
  const dir = temporary(t);
  const cache = new BoundedGranuleCache({ dir, maxBytes: 4096, owner: "generation-reader" });
  const url = "https://example.test/current";
  await cache.fetch(url, { fetchImpl: async () => response(200, "immutable-body") });
  const entry = readGenerationCacheEntry(dir, url);
  assert.equal(entry?.status, 200);
  assert.equal(entry?.body.toString(), "immutable-body");
  await cache.release(url);
});

test("multi-worker parity identity is independent of merge order", () => {
  const a = [["8/1/1", "a"], ["8/2/1", "b"], ["9/4/2", "c"]];
  assert.equal(recordSetDigest(a), recordSetDigest([...a].reverse()));
});

test("bounded fact spool emits sorted fixed-size runs", (t) => {
  const dir = path.join(temporary(t), "facts");
  const runs = writeSortedJsonRuns(dir, [{ key: "c" }, { key: "a" }, { key: "b" }, { key: "d" }], { maxRows: 2 });
  assert.equal(runs.length, 2);
  assert.deepEqual(fs.readFileSync(runs[0], "utf8").trim().split("\n").map(JSON.parse).map((r) => r.key), ["a", "c"]);
  assert.deepEqual(fs.readFileSync(runs[1], "utf8").trim().split("\n").map(JSON.parse).map((r) => r.key), ["b", "d"]);
  const retry = writeSortedJsonRuns(dir, [{ key: "z" }], { maxRows: 2 });
  assert.deepEqual(retry.map((file) => path.basename(file)), ["run-000000.ndjson"]);
  assert.throws(() => writeSortedJsonRuns(dir, [{ key: "x", value: "x".repeat(32) }], { maxRowBytes: 16 }), /fact row exceeds/);
  assert.throws(() => writeSortedJsonRuns(dir, [{ key: "a" }, { key: "b" }, { key: "c" }], {
    maxRows: 1,
    maxRuns: 2,
  }), /admitted external-sort run count/);
  assert.equal(compareCodeUnits("Z", "a"), -1, "fact ordering is code-unit order, never host locale order");
});

test("bounded fact merge caps fan-in, cleans stale scratch, and finds duplicates across passes", async (t) => {
  const root = temporary(t);
  const runDir = path.join(root, "facts");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, "stale.ndjson"), '{"key":"must-not-survive"}\n');
  // One row per source run forces a seven-pass merge at fan-in two.  The three
  // copies of "a" deliberately begin in different batches.
  const runs = writeSortedJsonRuns(runDir, [
    { key: "q" }, { key: "a", source: 1 }, { key: "p" }, { key: "d" },
    { key: "a", source: 2 }, { key: "c" }, { key: "b" }, { key: "a", source: 3 },
    { key: "z" }, { key: "e" }, { key: "f" }, { key: "g" }, { key: "h" },
  ], { maxRows: 1 });
  const rows = [];
  const duplicates = [];
  await mergeSortedJsonRuns(runs, {
    scratchDir: scratch,
    maxOpenRuns: 2,
    onRow: async (row) => rows.push(row),
    onDuplicate: async (first, duplicate) => duplicates.push([first.source, duplicate.source]),
  });
  assert.deepEqual(rows.map((row) => row.key), ["a", "b", "c", "d", "e", "f", "g", "h", "p", "q", "z"]);
  assert.deepEqual(duplicates, [[1, 2], [1, 3]]);
  assert.equal(fs.existsSync(scratch), false, "all stale and intermediate scratch must be reclaimed");

  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, "stale-empty-merge.ndjson"), "discard\n");
  await mergeSortedJsonRuns([], { scratchDir: scratch });
  assert.equal(fs.existsSync(scratch), false, "an empty merge also reclaims stale scratch");

  const oversized = path.join(root, "oversized.ndjson");
  fs.writeFileSync(oversized, `${JSON.stringify({ key: "x", bytes: "x".repeat(128) })}\n`);
  await assert.rejects(
    mergeSortedJsonRuns([oversized], { scratchDir: path.join(root, "oversized-scratch"), maxRowBytes: 32 }),
    /fact row exceeds 32 bytes/,
  );
});

test("bounded line reader rejects empty and oversized address-list rows", async (t) => {
  const file = path.join(temporary(t), "ocean-skipped.lines");
  fs.writeFileSync(file, "2/1/0\n12/10/10\n");
  const rows = [];
  for await (const row of iterateBoundedLines(file, { maxRowBytes: 32 })) rows.push(row.toString("utf8"));
  assert.deepEqual(rows, ["2/1/0", "12/10/10"]);

  fs.writeFileSync(file, "2/1/0\n\n");
  await assert.rejects(async () => {
    for await (const unused of iterateBoundedLines(file, { maxRowBytes: 32 })) void unused;
  }, /empty fact row/);

  fs.writeFileSync(file, `${"7".repeat(33)}\n`);
  await assert.rejects(async () => {
    for await (const unused of iterateBoundedLines(file, { maxRowBytes: 32 })) void unused;
  }, /fact row exceeds 32 bytes/);
});

function edgeBytes(values) {
  const bytes = Buffer.alloc(values.length * 8);
  for (let index = 0; index < values.length; index += 1) bytes.writeDoubleLE(values[index], index * 8);
  return bytes.toString("base64");
}

function edgeFact({ kind = "mesh", level = 8, orientation = "V", boundaryX = 0, boundaryY = 0, ownerAddress, ownerOrdinal, side, grid = 3, step = 0, values }) {
  const edge = kind === "mesh" ? edgeBytes(values) : Buffer.from(values).toString("base64");
  return {
    key: `${kind}|${level}|${orientation}|${boundaryX}|${boundaryY}`,
    kind,
    level,
    orientation,
    boundaryX,
    boundaryY,
    ownerAddress,
    ownerOrdinal,
    side,
    grid,
    step,
    edgeBytes: edge,
  };
}

test("streamed physical edge facts retain seam and mask metrics across run boundaries", async (t) => {
  const root = temporary(t);
  const writer = createSortedJsonRunWriter(path.join(root, "facts"), { maxRows: 1 });
  const zeroMask = Buffer.alloc(256);
  const changedMask = Buffer.alloc(256); changedMask[7] = 0xff;
  const facts = [
    // V pair has 5 versus 3 posts: its three common posts agree, while the
    // intermediate 5-post samples make a 2 m density-step crack.
    edgeFact({ boundaryX: 1, ownerAddress: "8/1/0", ownerOrdinal: 9, side: "west", grid: 3, values: [0, 0, 0] }),
    edgeFact({ orientation: "H", boundaryY: 1, ownerAddress: "8/0/1", ownerOrdinal: 8, side: "south", values: [1, 1, 1] }),
    edgeFact({ kind: "mask", boundaryX: 1, ownerAddress: "8/1/0", ownerOrdinal: 9, side: "west", values: zeroMask }),
    edgeFact({ boundaryX: 0, ownerAddress: "8/0/0", ownerOrdinal: 0, side: "west", values: [0, 0, 0] }), // singleton
    edgeFact({ boundaryX: 1, ownerAddress: "8/0/0", ownerOrdinal: 0, side: "east", grid: 5, values: [0, 2, 0, 2, 0] }),
    edgeFact({ kind: "mask", boundaryX: 1, ownerAddress: "8/0/0", ownerOrdinal: 0, side: "east", values: changedMask }),
    edgeFact({ orientation: "H", boundaryY: 1, ownerAddress: "8/0/0", ownerOrdinal: 0, side: "north", values: [1, 1, 1] }),
    // An impossible third owner is retained through the sort, then rejected
    // without being mistaken for a normal adjacency.
    edgeFact({ boundaryX: 2, ownerAddress: "8/1/0", ownerOrdinal: 9, side: "east", values: [0, 0, 0] }),
    edgeFact({ boundaryX: 2, ownerAddress: "8/2/0", ownerOrdinal: 10, side: "west", values: [0, 0, 0] }),
    edgeFact({ boundaryX: 2, ownerAddress: "8/1/0", ownerOrdinal: 11, side: "east", values: [0, 0, 0] }),
  ];
  for (const fact of facts) writer.push(fact);
  const result = await evaluateTerrainEdgeFacts(writer.finish(), {
    maxOpenRuns: 2,
    scratchDir: path.join(root, "scratch"),
  });
  const normalized = {
    adjacencies: result.adjacencies,
    mixedDensityAdjacencies: result.mixedDensityAdjacencies,
    worstDensityStepCrackM: result.crackByLevel.get(8)?.m,
    maskAdjacencies: result.maskAdjacencies,
    maskByteDisagreements: result.maskByteDisagreements,
    maskSeamExamples: result.maskSeamExamples,
    seamProblemCount: result.seamProblemCount,
    edgeGroupOverflowCount: result.edgeGroupOverflowCount,
    problemCount: result.problemCount,
    problemExamples: result.problemExamples,
  };
  assert.deepEqual(normalized, {
    adjacencies: 2,
    mixedDensityAdjacencies: 1,
    worstDensityStepCrackM: 2,
    maskAdjacencies: 1,
    maskByteDisagreements: 1,
    maskSeamExamples: ["8/0/0 east[7] = 0xff but 8/1/0 west[7] = 0x00"],
    seamProblemCount: 0,
    edgeGroupOverflowCount: 1,
    problemCount: 1,
    problemExamples: ["edge fact group mesh|8|V|2|0 has 3 rows; expected at most two"],
  });
});

test("constrained heap streams more than one hundred thousand verifier edge facts", async (t) => {
  const root = temporary(t);
  const script = `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    const { createSortedJsonRunWriter, evaluateTerrainEdgeFacts } = await import(process.env.SUPPORT_URL);
    const edgeBytes = (values) => {
      const bytes = Buffer.alloc(values.length * 8);
      values.forEach((value, index) => bytes.writeDoubleLE(value, index * 8));
      return bytes.toString('base64');
    };
    const fact = ({ kind = 'mesh', level = 8, orientation = 'V', boundaryX = 0, boundaryY = 0, ownerAddress, ownerOrdinal, side, grid = 3, step = 0, values }) => ({
      key: kind + '|' + level + '|' + orientation + '|' + boundaryX + '|' + boundaryY,
      kind, level, orientation, boundaryX, boundaryY, ownerAddress, ownerOrdinal, side, grid, step,
      edgeBytes: kind === 'mesh' ? edgeBytes(values) : Buffer.from(values).toString('base64'),
    });
    const root = process.env.EDGE_ROOT;
    const writer = createSortedJsonRunWriter(path.join(root, 'facts'), { maxRows: 37 });
    for (let index = 0; index < 100_001; index += 1) {
      writer.push(fact({ level: 12, boundaryX: index + 10, ownerAddress: '12/' + index + '/0', ownerOrdinal: index * 2, side: 'east', values: [0, 0, 0] }));
      writer.push(fact({ level: 12, boundaryX: index + 10, ownerAddress: '12/' + (index + 1) + '/0', ownerOrdinal: index * 2 + 1, side: 'west', values: [100, 100, 100] }));
    }
    const zero = Buffer.alloc(256); const changed = Buffer.alloc(256); changed[9] = 0xff;
    writer.push(fact({ boundaryX: 1, ownerAddress: '8/1/0', ownerOrdinal: 9, side: 'west', grid: 3, values: [0, 0, 0] }));
    writer.push(fact({ orientation: 'H', boundaryY: 1, ownerAddress: '8/0/1', ownerOrdinal: 8, side: 'south', values: [1, 1, 1] }));
    writer.push(fact({ kind: 'mask', boundaryX: 1, ownerAddress: '8/1/0', ownerOrdinal: 9, side: 'west', values: zero }));
    writer.push(fact({ boundaryX: 1, ownerAddress: '8/0/0', ownerOrdinal: 0, side: 'east', grid: 5, values: [0, 2, 0, 2, 0] }));
    writer.push(fact({ kind: 'mask', boundaryX: 1, ownerAddress: '8/0/0', ownerOrdinal: 0, side: 'east', values: changed }));
    writer.push(fact({ orientation: 'H', boundaryY: 1, ownerAddress: '8/0/0', ownerOrdinal: 0, side: 'north', values: [1, 1, 1] }));
    writer.push(fact({ boundaryX: 2, ownerAddress: '8/1/0', ownerOrdinal: 9, side: 'east', values: [0, 0, 0] }));
    writer.push(fact({ boundaryX: 2, ownerAddress: '8/2/0', ownerOrdinal: 10, side: 'west', values: [0, 0, 0] }));
    writer.push(fact({ boundaryX: 2, ownerAddress: '8/1/0', ownerOrdinal: 11, side: 'east', values: [0, 0, 0] }));
    const result = await evaluateTerrainEdgeFacts(writer.finish(), { maxOpenRuns: 5, scratchDir: path.join(root, 'scratch') });
    assert.equal(result.adjacencies, 100_003);
    assert.equal(result.mixedDensityAdjacencies, 1);
    assert.equal(result.crackByLevel.get(8).m, 2);
    assert.equal(result.maskByteDisagreements, 1);
    assert.equal(result.seamProblemCount, 300_003);
    assert.equal(result.edgeGroupOverflowCount, 1);
    assert.equal(result.problemCount, 300_004);
    assert.ok(result.problemExamples.length <= 64);
    assert.ok(result.problemExamples[0].startsWith('seam at 12/0/0 east vs 12/1/0 west shared post 0 of 2:'));
    assert.ok(result.problemExamples.some((problem) => problem.includes('has 3 rows; expected at most two')));
    process.stdout.write(JSON.stringify({ heap: process.memoryUsage().heapUsed, adjacencies: result.adjacencies, problems: result.problemCount, examples: result.problemExamples.length }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "--eval", script], {
    env: { ...process.env, SUPPORT_URL, EDGE_ROOT: root },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.adjacencies, 100_003);
  assert.equal(result.problems, 300_004);
  assert.ok(result.examples <= 64);
  assert.ok(result.heap < 64 * 1024 * 1024, `child heap ${result.heap} exceeded its 64 MiB budget`);
});

function syntheticMeshPayload(serial, { waterMask = Buffer.from([0x00]) } = {}) {
  // The exact 2x2 shape the production encoder writes: remapped regular-grid
  // triangles, four ordered edge lists, and one id=2 watermask extension.
  void serial;
  assert.ok(waterMask.length === 1 || waterMask.length === 256 * 256);
  const mesh = Buffer.alloc(169 + waterMask.length);
  mesh.writeFloatLE(1, 24);
  mesh.writeFloatLE(1, 28);
  mesh.writeUInt32LE(4, 88);
  const writeDeltas = (offset, values) => {
    let previous = 0;
    for (let index = 0; index < values.length; index += 1) {
      const delta = values[index] - previous;
      mesh.writeUInt16LE(((delta << 1) ^ (delta >> 15)) & 0xffff, offset + index * 2);
      previous = values[index];
    }
  };
  writeDeltas(92, [0, 32767, 32767, 0]);
  writeDeltas(100, [0, 0, 32767, 32767]);
  writeDeltas(108, [0, 0, 0, 0]);
  mesh.writeUInt32LE(2, 116); // 2 * (grid - 1)^2 triangles
  for (const [index, code] of [0, 0, 0, 3, 1, 0].entries()) mesh.writeUInt16LE(code, 120 + index * 2);
  // Encoder remaps [BL, BR, TR, TL] by first appearance, then emits each edge
  // by scanning that remapped vertex order.
  const edges = [[0, 3], [0, 1], [1, 2], [2, 3]];
  let at = 132;
  for (const edge of edges) {
    mesh.writeUInt32LE(edge.length, at); at += 4;
    for (const vertex of edge) { mesh.writeUInt16LE(vertex, at); at += 2; }
  }
  mesh.writeUInt8(2, at);
  mesh.writeUInt32LE(waterMask.length, at + 1);
  Buffer.from(waterMask).copy(mesh, at + 5);
  return zlib.gzipSync(mesh);
}

function syntheticTerrainRecord({
  level,
  x,
  y,
  childAvailability = 0,
  serial = 0,
  payload = null,
  waterMaskKind = "UNIFORM_LAND",
  meshWaterMask = null,
  minHeightM = 1,
  maxHeightM = 1,
  verticalAccuracyM = 0,
  accuracyConfidence = 1,
  dataCoverageFraction = 1,
  digestOverride = null,
  etagOverride = null,
} = {}) {
  const raster = waterMaskKind === "RASTER" || waterMaskKind === 3;
  const uniformWater = waterMaskKind === "UNIFORM_WATER" || waterMaskKind === 2;
  const rawMask = raster ? Buffer.from(meshWaterMask ?? Buffer.alloc(256 * 256, 0x00)) : null;
  const meshMask = raster ? rawMask : Buffer.from([uniformWater ? 0xff : 0x00]);
  const resolvedPayload = payload ?? syntheticMeshPayload(serial, { waterMask: meshMask });
  const compressedMask = raster ? zlib.gzipSync(rawMask) : null;
  const digest = `1220${createHash("sha256").update(resolvedPayload).digest("hex")}`;
  const statedDigest = digestOverride ?? digest;
  const columns = 2 ** (level + 1);
  const rows = 2 ** level;
  // writeFB produces a size-prefixed FlatBuffer for standalone transport;
  // tiles.dttstream supplies its own frame, so its record is the raw suffix.
  return Buffer.from(writeDttRecord(sds, {
    TILESET_ID: "streaming-verifier-fixture",
    TILING_SCHEME: "GEOGRAPHIC_WGS84",
    LEVEL: level,
    X: x,
    Y: y,
    WEST_DEG: -180 + (x * 360) / columns,
    EAST_DEG: -180 + ((x + 1) * 360) / columns,
    SOUTH_DEG: -90 + (y * 180) / rows,
    NORTH_DEG: -90 + ((y + 1) * 180) / rows,
    MIN_HEIGHT_M: minHeightM,
    MAX_HEIGHT_M: maxHeightM,
    PAYLOAD_FORMAT: "QUANTIZED_MESH",
    PAYLOAD_FORMAT_VERSION: "1.0",
    PAYLOAD: {
      BYTES: resolvedPayload,
      SIZE_BYTES: resolvedPayload.length,
      DIGEST: statedDigest,
      CONTENT_ENCODING: "gzip",
    },
    VERTICAL_DATUM: "GEOID",
    VERTICAL_DATUM_NAME: "EGM2008",
    VERTICAL_ACCURACY_M: verticalAccuracyM,
    ACCURACY_CONFIDENCE: accuracyConfidence,
    DATA_COVERAGE_FRACTION: dataCoverageFraction,
    WATER_MASK_KIND: waterMaskKind,
    ...(raster ? {
      WATER_MASK: {
        BYTES: compressedMask,
        SIZE_BYTES: compressedMask.length,
        DIGEST: `1220${createHash("sha256").update(compressedMask).digest("hex")}`,
        CONTENT_ENCODING: "gzip",
        MEDIA_TYPE: "application/octet-stream",
      },
      WATER_MASK_WIDTH: 256,
      WATER_MASK_HEIGHT: 256,
    } : {}),
    CHILD_AVAILABILITY: childAvailability,
    MAX_LEVEL: 12,
    PROVENANCE: {
      DATASET_ID: "streaming-fixture",
      DATASET_EPOCH: "2026-09-01T00:00:00.000Z",
      RETRIEVED_AT: "2026-09-01T00:00:00.000Z",
      LICENSE: "test licence",
    },
    ETAG: etagOverride ?? `"${statedDigest}"`,
  })).subarray(4);
}

function appendTerrainFrame(handle, record) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(record.length);
  fs.writeSync(handle, length);
  fs.writeSync(handle, record);
}

function writeSyntheticTerrainStream(outDir, addresses = [{ level: 3, x: 0, y: 0 }]) {
  const handle = fs.openSync(path.join(outDir, "tiles.dttstream"), "w");
  try {
    addresses.forEach((address, serial) => appendTerrainFrame(handle, syntheticTerrainRecord({ ...address, serial })));
  } finally {
    fs.closeSync(handle);
  }
}

function writeGlobalVerificationInputs(outDir, records, {
  oceanLines = "4/15/0\n",
  mutateState = null,
  policyOverride = {},
} = {}) {
  const approvedConfig = {
    ...JSON.parse(fs.readFileSync(path.join(HERE, "..", "regions", "global-z10.json"), "utf8")),
    publication_policy: {
      version: 1,
      max_verified_store_bytes: 1024 * 1024,
      max_static_directory_bytes: 2 * 1024 * 1024,
      static_directory_basis: "verified-static-ipfs-directory",
      synthesized_tile_grid_size: 65,
      ...policyOverride,
    },
  };
  const rawPolicy = approvedConfig.publication_policy;
  const configDigestFinal = sha256(canonicalJson(approvedConfig));
  const wrapper = {
    policy: rawPolicy,
    digest: sha256(canonicalJson(rawPolicy)),
    globalConfigDigest: configDigestFinal,
  };
  const normalizedPolicy = {
    format: "terrain-publication-policy-v1",
    globalConfigDigest: configDigestFinal,
    maxVerifiedStoreBytes: rawPolicy.max_verified_store_bytes,
    maxStaticDirectoryBytes: rawPolicy.max_static_directory_bytes,
    synthGridSize: rawPolicy.synthesized_tile_grid_size,
  };
  const state = {
    version: 1,
    completed: true,
    configDigest: configDigestFinal,
    publicationPolicy: normalizedPolicy,
    merged: {
      completion: "complete",
      approvedConfigPath: "approved-run-config.json",
      records,
      configDigest: configDigestFinal,
      publicationPolicy: normalizedPolicy,
    },
  };
  mutateState?.(state, approvedConfig, wrapper);
  fs.writeFileSync(path.join(outDir, "approved-run-config.json"), JSON.stringify(approvedConfig));
  fs.writeFileSync(path.join(outDir, "global-build-state.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(outDir, "ocean-skipped.lines"), oceanLines);
  fs.writeFileSync(path.join(outDir, "ocean-skipped.json"), JSON.stringify({
    format: "terrain-ocean-skips-lines-v1",
    addressesPath: "ocean-skipped.lines",
    count: oceanLines.trim() ? oceanLines.trim().split("\n").length : 0,
    digest: createHash("sha256").update(oceanLines).digest("hex"),
  }));
  return { normalizedPolicy, runReportPolicy: wrapper };
}

schemaTest("constrained verifier streams address catalogues, receipt lines, and exact payload quantiles", {}, async (t) => {
  const outDir = temporary(t);
  const stream = path.join(outDir, "tiles.dttstream");
  const handle = fs.openSync(stream, "w");
  const payloadSizes = [];
  let serial = 0;
  const append = (address) => {
    const record = syntheticTerrainRecord({ ...address, serial: serial++ });
    payloadSizes.push(readDtt(record).payload.bytes.length);
    appendTerrainFrame(handle, record);
  };
  try {
    // Missing stored ancestors must become disk-backed placeholders, while the
    // set bit on 11/100/100 deliberately claims a child no availability row
    // can serve.  Levels 3..12 exercise a deep closure without an address map.
    for (let level = 3; level <= 10; level += 1) append({ level, x: 0, y: 0 });
    append({ level: 11, x: 100, y: 100, childAvailability: 1 });
    // A multi-row level-12 block forces thousands of streamed candidate and
    // parent/child facts; the duplicate is in a different record position.
    for (let y = 0; y < 64; y += 1) for (let x = 0; x < 80; x += 1) append({ level: 12, x, y });
    append({ level: 12, x: 0, y: 0 });
  } finally {
    fs.closeSync(handle);
  }
  const linesPath = path.join(outDir, "ocean-skipped.lines");
  fs.writeFileSync(linesPath, "2/1/0\n");
  const lineDigest = createHash("sha256").update(fs.readFileSync(linesPath)).digest("hex");
  fs.writeFileSync(path.join(outDir, "ocean-skipped.json"), JSON.stringify({
    format: "terrain-ocean-skips-lines-v1",
    addressesPath: "ocean-skipped.lines",
    count: 1,
    digest: lineDigest,
  }));

  let failure;
  try {
    await execFileAsync(process.execPath, ["--max-old-space-size=64", VERIFY, "--out", outDir, "--json"], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 1, "the deliberately bad duplicate/claim/floor fixture must fail verification");
  const sortedSizes = [...payloadSizes].sort((left, right) => left - right);
  const exact = (p) => sortedSizes[Math.floor((sortedSizes.length - 1) * p)];
  assert.equal(fs.existsSync(path.join(outDir, "verify-report.json")), false, "a failed verification must leave no publishable receipt");
  assert.deepEqual(sortedSizes, [...payloadSizes].sort((left, right) => left - right), "fixture remains a multi-size quantile rehearsal");
  assert.match(failure.stderr, /NOT PUBLISHABLE: 7 problems/);
  for (const temporaryName of [
    ".verify-address-facts", ".verify-address-merge", ".verify-size-facts", ".verify-size-merge",
    ".verify-closure-facts", ".verify-closure-merge", ".verify-membership-facts", ".verify-membership-merge",
    ".verify-available-candidates", ".verify-available-candidate-merge", ".verify-available-children",
  ]) assert.equal(fs.existsSync(path.join(outDir, temporaryName)), false, `${temporaryName} must be reclaimed`);
});

schemaTest("verifier accepts legacy ocean arrays and rejects malformed streamed ocean receipts", {}, async (t) => {
  const legacy = temporary(t);
  writeSyntheticTerrainStream(legacy);
  fs.writeFileSync(path.join(legacy, "ocean-skipped.json"), JSON.stringify({ addresses: ["3/1/0"] }));
  const legacyResult = await execFileAsync(process.execPath, ["--max-old-space-size=64", VERIFY, "--out", legacy, "--json"], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.match(legacyResult.stdout, /PUBLISHABLE/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacy, "verify-report.json"), "utf8")).oceanSkipsDeclared, 1);

  const rejectReceipt = async ({ name, lines, receipt, expected }) => {
    const root = temporary(t);
    const outDir = path.join(root, "out");
    fs.mkdirSync(outDir);
    writeSyntheticTerrainStream(outDir);
    const target = path.join(outDir, "ocean-skipped.lines");
    if (lines !== null) fs.writeFileSync(target, lines);
    const digest = lines === null ? "0".repeat(64) : createHash("sha256").update(Buffer.from(lines)).digest("hex");
    const escaped = path.join(root, "escaped-ocean-skipped.lines");
    if (receipt.escaped) fs.writeFileSync(escaped, "3/1/0\n");
    fs.writeFileSync(path.join(outDir, "ocean-skipped.json"), JSON.stringify({
      format: "terrain-ocean-skips-lines-v1",
      addressesPath: receipt.escaped ? "../escaped-ocean-skipped.lines" : "ocean-skipped.lines",
      count: lines?.split("\n").filter(Boolean).length ?? 0,
      digest,
      ...receipt,
    }));
    let failure;
    try {
      await execFileAsync(process.execPath, [VERIFY, "--out", outDir], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      failure = error;
    }
    assert.notEqual(failure, undefined, `${name} must refuse the receipt`);
    assert.match(failure.stderr, expected);
  };

  await rejectReceipt({
    name: "escaped pointer",
    lines: "3/1/0\n",
    receipt: { escaped: true },
    expected: /target escapes output directory/,
  });
  await rejectReceipt({
    name: "unsorted lines",
    lines: "3/2/0\n3/1/0\n",
    receipt: {},
    expected: /lines must be sorted and unique/,
  });
  await rejectReceipt({
    name: "lexically sorted but numerically out-of-order levels",
    lines: "10/0/0\n8/0/0\n9/0/0\n",
    receipt: {},
    expected: /level\/y\/x/,
  });
  await rejectReceipt({
    name: "duplicate mixed-level address",
    lines: "8/0/0\n9/0/0\n9/0/0\n10/0/0\n",
    receipt: {},
    expected: /level\/y\/x/,
  });
  await rejectReceipt({
    name: "digest mismatch",
    lines: "3/1/0\n",
    receipt: { digest: "f".repeat(64) },
    expected: /receipt digest mismatch/,
  });
});

async function runVerifierExpectFailure(outDir, pattern) {
  let failure;
  try {
    await execFileAsync(process.execPath, ["--max-old-space-size=64", VERIFY, "--out", outDir], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    failure = error;
  }
  assert.notEqual(failure, undefined, "verifier must reject malformed input");
  assert.match(failure.stderr, pattern);
  assert.equal(fs.existsSync(path.join(outDir, "verify-report.json")), false, "failed verification must remove any stale publishable receipt");
}

async function waitForVerifierReceiptBarrier(barrier) {
  const ready = `${barrier}.ready`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if (fs.readFileSync(ready, "utf8") === "ready\n") return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.ok(Date.now() < deadline, "verifier did not reach the receipted layer-config barrier");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function writeVerifierSwapWorkload(outDir) {
  const records = 8_000;
  const handle = fs.openSync(path.join(outDir, "tiles.dttstream"), "w");
  try {
    for (let index = 0; index < records; index += 1) {
      appendTerrainFrame(handle, syntheticTerrainRecord({
        level: 9,
        x: index % 1024,
        y: Math.floor(index / 1024),
        serial: index,
      }));
    }
  } finally {
    fs.closeSync(handle);
  }
}

const VERIFIER_STAGING_DIRECTORY = ".terrain-verifier-staging-v1";
const VERIFIER_RECOVERY_DIRECTORY = ".terrain-verifier-recovery-v1";
const VERIFIER_STAGE_FILES = Object.freeze({
  availability: "terrain-available.json.stage",
  availableButUnstored: "available-but-unstored.ndjson.stage",
  layerConfig: "layer-json-config.json.stage",
});
const VERIFIER_SCRATCH_DIRECTORIES = Object.freeze({
  edgeFacts: ".verify-edge-facts", edgeMerge: ".verify-edge-merge",
  addressFacts: ".verify-address-facts", addressMerge: ".verify-address-merge",
  sizeFacts: ".verify-size-facts", sizeMerge: ".verify-size-merge",
  closureFacts: ".verify-closure-facts", closureMerge: ".verify-closure-merge",
  membershipFacts: ".verify-membership-facts", membershipMerge: ".verify-membership-merge",
  candidateFacts: ".verify-available-candidates", candidateMerge: ".verify-available-candidate-merge",
  availableChildren: ".verify-available-children",
});

function startVerifier(outDir, extraEnv = {}) {
  return spawn(process.execPath, ["--max-old-space-size=64", VERIFY, "--out", outDir, "--json"], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ...extraEnv },
  });
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForVerifierStage(outDir, stageName) {
  const directory = path.join(outDir, VERIFIER_STAGING_DIRECTORY);
  const stage = path.join(directory, VERIFIER_STAGE_FILES[stageName]);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const stat = fs.lstatSync(stage, { bigint: true });
      if (stat.isFile()) {
        const owners = fs.readdirSync(directory)
          .filter((name) => /^owner\.[ab]\.json$/.test(name))
          .flatMap((name) => {
            try { return [JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))]; } catch { return []; }
          });
        if (owners.some((owner) => owner.stages?.[stageName]?.device === String(stat.dev)
          && owner.stages?.[stageName]?.inode === String(stat.ino))) return { directory, stage };
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.ok(Date.now() < deadline, `verifier did not create owned ${stageName} stage`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function waitForStagingBarrier(root, point) {
  const ready = `${root}.${point}.ready`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if (fs.readFileSync(ready, "utf8") === "ready\n") return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.ok(Date.now() < deadline, `verifier did not reach staging barrier ${point}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function killVerifierAtStage(outDir, stageName, extraEnv = {}) {
  const child = startVerifier(outDir, extraEnv);
  const exited = childExit(child);
  const stage = await waitForVerifierStage(outDir, stageName);
  assert.equal(child.kill("SIGKILL"), true, `kill verifier at ${stageName} stage`);
  assert.equal((await exited).signal, "SIGKILL");
  return stage;
}

async function killVerifierAtStagingBarrier(outDir, barrierRoot, point, occurrence = 1) {
  const child = startVerifier(outDir, {
    NODE_ENV: "test",
    TERRAIN_VERIFY_TEST_STAGING_BARRIER: point,
    TERRAIN_VERIFY_TEST_STAGING_BARRIER_OCCURRENCE: String(occurrence),
    TERRAIN_VERIFY_TEST_STAGING_BARRIER_PATH: barrierRoot,
  });
  const exited = childExit(child);
  await waitForStagingBarrier(barrierRoot, point);
  assert.equal(child.kill("SIGKILL"), true, `kill verifier at staging barrier ${point}`);
  assert.equal((await exited).signal, "SIGKILL");
}

const writeStagingFixture = (outDir) => fs.writeFileSync(
  path.join(outDir, "tiles.dttstream"), Buffer.from(TIGHT_HEAP_DTTSTREAM, "base64"),
);
const runStagedVerifier = (outDir) => execFileAsync(process.execPath, ["--max-old-space-size=64", VERIFY, "--out", outDir, "--json"], {
  timeout: 30_000, maxBuffer: 1024 * 1024,
});

schemaTest("verifier fails closed when generated availability is exchanged before the receipted layer config", { timeout: 180_000 }, async (t) => {
  const attempt = async (name, replace, expected) => {
    const root = temporary(t);
    const outDir = path.join(root, name);
    const barrier = path.join(root, "receipt-barrier");
    fs.mkdirSync(outDir);
    writeVerifierSwapWorkload(outDir);
    const invocation = execFileAsync(process.execPath, ["--max-old-space-size=64", VERIFY, "--out", outDir, "--json"], {
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        NODE_ENV: "test",
        TERRAIN_VERIFY_TEST_RECEIPT_BARRIER: barrier,
      },
    });
    await waitForVerifierReceiptBarrier(barrier);
    const availability = path.join(outDir, "terrain-available.json");
    const stat = fs.lstatSync(availability);
    assert.equal(stat.isFile(), true, "verifier must capture a regular generated availability file before the exchange");
    replace(availability, stat.size);
    fs.writeFileSync(`${barrier}.release`, "release\n", { flag: "wx" });
    let failure;
    try {
      await invocation;
    } catch (error) {
      failure = error;
    }
    assert.notEqual(failure, undefined, `${name} exchange must fail verification`);
    assert.match(failure.stderr, expected);
    assert.equal(fs.existsSync(path.join(outDir, "verify-report.json")), false,
      `${name} exchange must leave no publishable receipt`);
  };

  await attempt(
    "same-size-replacement",
    (availability, size) => {
      fs.rmSync(availability);
      fs.writeFileSync(availability, Buffer.alloc(size, 0x20));
    },
    /generated terrain availability pathname changed before layer config copy/,
  );

  const escaped = path.join(temporary(t), "availability-outside.json");
  fs.writeFileSync(escaped, "[]\n");
  await attempt(
    "symlink-replacement",
    (availability) => {
      fs.rmSync(availability);
      fs.symlinkSync(escaped, availability);
    },
    /generated terrain availability is not a regular file/,
  );
});

schemaTest("bounded verifier staging protects outputs across repeated kills and never follows a symlink", { timeout: 180_000 }, async (t) => {
  const root = temporary(t);
  const outDir = path.join(root, "out");
  fs.mkdirSync(outDir);
  writeVerifierSwapWorkload(outDir);
  const finalPath = path.join(outDir, "available-but-unstored.ndjson");
  const sentinel = path.join(root, "outside-sentinel.ndjson");
  fs.writeFileSync(sentinel, "outside-sentinel-must-survive\n");
  fs.symlinkSync(sentinel, finalPath);

  await execFileAsync(process.execPath, ["--max-old-space-size=64", VERIFY, "--out", outDir, "--json"], {
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(fs.readFileSync(sentinel, "utf8"), "outside-sentinel-must-survive\n");
  assert.equal(fs.lstatSync(finalPath).isFile(), true, "atomic rename replaces the symlink itself");
  assert.equal(fs.readFileSync(finalPath, "utf8").includes("outside-sentinel"), false);

  const predecessor = "previous-complete-output\n";
  fs.writeFileSync(finalPath, predecessor);
  fs.rmSync(path.join(outDir, "verify-report.json"));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const staged = await killVerifierAtStage(outDir, "availableButUnstored");
    assert.equal(fs.readFileSync(finalPath, "utf8"), predecessor,
      "a killed staged attempt leaves the prior complete output intact, never a torn final file");
    const names = fs.readdirSync(staged.directory).sort();
    assert.ok(names.length <= 2 + Object.keys(VERIFIER_STAGE_FILES).length + Object.keys(VERIFIER_SCRATCH_DIRECTORIES).length,
      "repeated kills retain a fixed bounded set of owner, output, and scratch paths");
    assert.ok(names.every((name) => /^owner\.[ab]\.json$/.test(name)
      || Object.values(VERIFIER_STAGE_FILES).includes(name)
      || Object.values(VERIFIER_SCRATCH_DIRECTORIES).includes(name)),
    "staging retains only exact verifier-owned names");
  }

  await execFileAsync(process.execPath, ["--max-old-space-size=64", VERIFY, "--out", outDir, "--json"], {
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  });
  assert.notEqual(fs.readFileSync(finalPath, "utf8"), predecessor, "a later complete attempt atomically replaces the predecessor");
  assert.equal(fs.existsSync(path.join(outDir, VERIFIER_STAGING_DIRECTORY)), false, "a clean completion removes its exact staging directory");
});

schemaTest("verifier staging recovers owned crash boundaries and refuses live or forged state", { timeout: 180_000 }, async (t) => {
  const writeFixture = writeStagingFixture;
  const run = runStagedVerifier;
  const finalForStage = {
    availability: "terrain-available.json",
    layerConfig: "layer-json-config.json",
    mountEntry: "mount-entry.json",
    verifyReport: "verify-report.json",
  };

  for (const stageName of Object.keys(finalForStage)) {
    const root = temporary(t);
    const outDir = path.join(root, stageName);
    fs.mkdirSync(outDir);
    writeFixture(outDir);
    await run(outDir);
    const final = path.join(outDir, finalForStage[stageName]);
    const predecessor = fs.existsSync(final) ? fs.readFileSync(final) : null;
    const barrier = path.join(root, `stage-${stageName}`);
    await killVerifierAtStagingBarrier(outDir, barrier, `stage-${stageName}-sealed`);
    if (predecessor !== null && stageName !== "verifyReport") {
      assert.deepEqual(fs.readFileSync(final), predecessor, `${stageName} kill preserves the prior complete final`);
    }
    assert.equal(fs.existsSync(path.join(outDir, VERIFIER_STAGING_DIRECTORY)), true, `${stageName} kill leaves one exact recoverable staging directory`);
    await run(outDir);
    assert.equal(fs.existsSync(path.join(outDir, VERIFIER_STAGING_DIRECTORY)), false, `${stageName} recovery removes staging residue`);
    assert.equal(fs.existsSync(path.join(outDir, VERIFIER_RECOVERY_DIRECTORY)), false, `${stageName} recovery removes recovery residue`);
  }

  for (const [point, occurrence] of [["mkdir-before-owner", 1], ["owner-before-write", 1], ["owner-before-write", 2], ["owner-after-write", 1]]) {
    const root = temporary(t);
    const outDir = path.join(root, `${point}-${occurrence}`);
    fs.mkdirSync(outDir);
    writeFixture(outDir);
    const barrier = path.join(root, "bootstrap");
    await killVerifierAtStagingBarrier(outDir, barrier, point, occurrence);
    await run(outDir);
    assert.equal(fs.existsSync(path.join(outDir, VERIFIER_STAGING_DIRECTORY)), false, `${point}/${occurrence} recovery removes staging residue`);
  }

  for (const point of ["lease-before-create", "lease-created-before-fsync"]) {
    const root = temporary(t);
    const outDir = path.join(root, point);
    fs.mkdirSync(outDir);
    writeFixture(outDir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const barrier = path.join(root, `${point}-${attempt}`);
      await killVerifierAtStagingBarrier(outDir, barrier, point);
      const lease = path.join(outDir, ".terrain-verifier-lease-v1");
      if (point === "lease-before-create") assert.equal(fs.existsSync(lease), false,
        "a pre-create kill leaves no partially written fixed lease");
      else assert.equal(fs.lstatSync(lease).isSymbolicLink(), true,
        "a post-create kill leaves only an atomic self-contained lease link");
    }
    await run(outDir);
    assert.equal(fs.existsSync(path.join(outDir, ".terrain-verifier-lease-v1")), false,
      "a clean verifier run reclaims the exact stale lease link");
  }
});

schemaTest("verifier staging reclaims every lease-owned fact scratch root", { timeout: 180_000 }, async (t) => {
  const writeFixture = writeStagingFixture;
  const run = runStagedVerifier;

  for (const [name, dirname] of Object.entries(VERIFIER_SCRATCH_DIRECTORIES)) {
    const root = temporary(t);
    const outDir = path.join(root, `scratch-${name}`);
    fs.mkdirSync(outDir);
    writeFixture(outDir);
    const barrier = path.join(root, `scratch-${name}`);
    await killVerifierAtStagingBarrier(outDir, barrier, `scratch-${name}-created`);
    assert.equal(fs.lstatSync(path.join(outDir, VERIFIER_STAGING_DIRECTORY, dirname)).isDirectory(), true,
      `${name} crash leaves exactly one recoverable scratch root`);
    await run(outDir);
    assert.equal(fs.existsSync(path.join(outDir, VERIFIER_STAGING_DIRECTORY, dirname)), false,
      `${name} root is reclaimed after a clean retry`);
    assert.equal(fs.existsSync(path.join(outDir, VERIFIER_STAGING_DIRECTORY)), false,
      `${name} retry leaves no staging residue`);
  }

  {
    const root = temporary(t);
    const outDir = path.join(root, "foreign-scratch-sibling");
    fs.mkdirSync(outDir);
    writeFixture(outDir);
    const sentinel = path.join(root, "outside-scratch-sentinel");
    fs.writeFileSync(sentinel, "outside scratch must survive\n");
    const foreignScratch = path.join(outDir, VERIFIER_SCRATCH_DIRECTORIES.edgeFacts);
    fs.symlinkSync(sentinel, foreignScratch);
    await run(outDir);
    assert.equal(fs.lstatSync(foreignScratch).isSymbolicLink(), true,
      "a fixed foreign scratch sibling is outside the owned staging namespace");
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside scratch must survive\n");
  }

  {
    const root = temporary(t);
    const outDir = path.join(root, "forged-creating-scratch");
    fs.mkdirSync(outDir);
    writeFixture(outDir);
    const barrier = path.join(root, "creating-scratch");
    await killVerifierAtStagingBarrier(outDir, barrier, "scratch-edgeFacts-creating");
    const sentinel = path.join(root, "creating-scratch-sentinel");
    fs.writeFileSync(sentinel, "must not be followed or removed\n");
    fs.symlinkSync(sentinel, path.join(outDir, VERIFIER_STAGING_DIRECTORY, VERIFIER_SCRATCH_DIRECTORIES.edgeFacts));
    await assert.rejects(run(outDir), /non-directory creating scratch/);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "must not be followed or removed\n");
    assert.equal(fs.lstatSync(path.join(outDir, VERIFIER_RECOVERY_DIRECTORY, VERIFIER_SCRATCH_DIRECTORIES.edgeFacts)).isSymbolicLink(), true);
  }
});

schemaTest("verifier staging resumes recovery and refuses live or forged state", { timeout: 180_000 }, async (t) => {
  const writeFixture = writeStagingFixture;
  const run = runStagedVerifier;

  for (const point of ["stage-availability-created", "recovery-after-rename", "recovery-after-stage-delete"]) {
    const root = temporary(t);
    const outDir = path.join(root, point);
    fs.mkdirSync(outDir);
    writeFixture(outDir);
    if (point.startsWith("recovery-")) await killVerifierAtStage(outDir, "availability");
    const barrier = path.join(root, "recovery");
    await killVerifierAtStagingBarrier(outDir, barrier, point);
    await run(outDir);
    assert.equal(fs.existsSync(path.join(outDir, VERIFIER_STAGING_DIRECTORY)), false, `${point} recovery removes staging residue`);
    assert.equal(fs.existsSync(path.join(outDir, VERIFIER_RECOVERY_DIRECTORY)), false, `${point} recovery removes recovery residue`);
  }

  const root = temporary(t);
  const outDir = path.join(root, "live");
  fs.mkdirSync(outDir);
  writeFixture(outDir);
  const barrier = path.join(root, "live-holder");
  const holder = startVerifier(outDir, {
    NODE_ENV: "test",
    TERRAIN_VERIFY_TEST_STAGING_BARRIER: "stage-availability-creating",
    TERRAIN_VERIFY_TEST_STAGING_BARRIER_PATH: barrier,
  });
  const holderExit = childExit(holder);
  await waitForStagingBarrier(barrier, "stage-availability-creating");
  await assert.rejects(run(outDir), /live or identity-ambiguous process/);
  assert.equal(holder.kill("SIGKILL"), true);
  assert.equal((await holderExit).signal, "SIGKILL");
  await run(outDir);

  const forgedRoot = temporary(t);
  const forgedOut = path.join(forgedRoot, "forged");
  fs.mkdirSync(forgedOut);
  writeFixture(forgedOut);
  const sentinel = path.join(forgedRoot, "outside-sentinel");
  fs.writeFileSync(sentinel, "must-not-be-touched\n");
  const forgedDirectory = path.join(forgedOut, VERIFIER_STAGING_DIRECTORY);
  fs.mkdirSync(forgedDirectory);
  fs.symlinkSync(sentinel, path.join(forgedDirectory, VERIFIER_STAGE_FILES.availability));
  await assert.rejects(run(forgedOut), /staging directory exists after lease acquisition/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "must-not-be-touched\n");
  assert.equal(fs.lstatSync(path.join(forgedDirectory, VERIFIER_STAGE_FILES.availability)).isSymbolicLink(), true);
});

schemaTest("verifier rejects bounded-decode bombs, truncated mesh sections, and invalid terrain fields", {}, async (t) => {
  const rejectOne = async (name, record, pattern) => {
    const outDir = temporary(t);
    const handle = fs.openSync(path.join(outDir, "tiles.dttstream"), "w");
    try { appendTerrainFrame(handle, record); } finally { fs.closeSync(handle); }
    await runVerifierExpectFailure(outDir, pattern);
  };

  await rejectOne(
    "gzip bomb",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 1, payload: zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024 + 1)) }),
    /bounded valid gzip payload/,
  );
  const truncated = Buffer.alloc(100); truncated.writeUInt32LE(4, 88);
  await rejectOne(
    "truncated vertex sections",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 2, payload: zlib.gzipSync(truncated) }),
    /truncates its u\/v\/h vertex sections/,
  );
  const malformedMesh = (mutate) => zlib.gzipSync(mutate(zlib.gunzipSync(syntheticMeshPayload(99))));
  await rejectOne(
    "truncated triangle section",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 8, payload: malformedMesh((raw) => raw.subarray(0, 119)) }),
    /truncates triangle count/,
  );
  await rejectOne(
    "impossible triangle count",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 9, payload: malformedMesh((raw) => { raw.writeUInt32LE(0xffffffff, 116); return raw; }) }),
    /shipping regular-grid triangle count/,
  );
  await rejectOne(
    "invalid high-water triangle index",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 10, payload: zlib.gzipSync(Buffer.concat([
      zlib.gunzipSync(syntheticMeshPayload(10)).subarray(0, 116),
      Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0]),
      zlib.gunzipSync(syntheticMeshPayload(10)).subarray(126),
    ])) }),
    /invalid high-water triangle index/,
  );
  await rejectOne(
    "invalid edge index",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 11, payload: zlib.gzipSync(Buffer.concat([
      zlib.gunzipSync(syntheticMeshPayload(11)).subarray(0, 132),
      Buffer.from([2, 0, 0, 0, 4, 0, 0, 0]),
      zlib.gunzipSync(syntheticMeshPayload(11)).subarray(140),
    ])) }),
    /west edge index exceeds vertex count/,
  );
  await rejectOne(
    "truncated extension body",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 12, payload: malformedMesh((raw) => { raw.writeUInt32LE(0xffffffff, 165); return raw; }) }),
    /watermask extension must be one uniform byte/,
  );
  await rejectOne(
    "trailing partial extension",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 13, payload: malformedMesh((raw) => Buffer.concat([raw, Buffer.from([1])])) }),
    /trailing mesh bytes/,
  );
  await rejectOne(
    "zero shipping triangles",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, payload: malformedMesh((raw) => { raw.writeUInt32LE(0, 116); return raw; }) }),
    /shipping regular-grid triangle count/,
  );
  await rejectOne(
    "wrapped zigzag coordinate",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, payload: malformedMesh((raw) => { raw.writeUInt16LE(0xffff, 92); return raw; }) }),
    /u coordinate is outside/,
  );
  await rejectOne(
    "non-finite quantized-mesh header coordinate",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, payload: malformedMesh((raw) => { raw.writeDoubleLE(Number.NaN, 32); return raw; }) }),
    /non-finite header coordinate/,
  );
  await rejectOne(
    "negative quantized-mesh bounding sphere radius",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, payload: malformedMesh((raw) => { raw.writeDoubleLE(-1, 56); return raw; }) }),
    /negative bounding-sphere radius/,
  );
  await rejectOne(
    "missing shipping edge",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, payload: malformedMesh((raw) => { raw.writeUInt32LE(0, 132); return raw; }) }),
    /west edge must contain exactly 2 vertices/,
  );
  await rejectOne(
    "opaque extension replaces watermask",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, payload: malformedMesh((raw) => { raw.writeUInt8(127, 164); return raw; }) }),
    /shipping watermask extension id 2/,
  );
  const meshRaster = Buffer.alloc(256 * 256, 0x00); meshRaster[17] = 0xff;
  await rejectOne(
    "DTT raster disagrees with embedded watermask",
    syntheticTerrainRecord({
      level: 3, x: 0, y: 0, waterMaskKind: "RASTER", meshWaterMask: Buffer.alloc(256 * 256, 0x00),
      payload: syntheticMeshPayload(1, { waterMask: meshRaster }),
    }),
    /disagrees with DTT WATER_MASK bytes/,
  );
  await rejectOne(
    "out of range coordinate",
    syntheticTerrainRecord({ level: 0, x: 2, y: 0, serial: 3 }),
    /outside geographic scheme bounds/,
  );
  await rejectOne(
    "reserved child bit",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 4, childAvailability: 0x10 }),
    /reserved bits/,
  );
  await rejectOne(
    "unknown mask enum",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 5, waterMaskKind: 99 }),
    /unsupported water-mask kind/,
  );
  await rejectOne(
    "negative accuracy",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 6, verticalAccuracyM: -1 }),
    /vertical accuracy is negative/,
  );
  await rejectOne(
    "non-finite coverage",
    syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 7, dataCoverageFraction: Number.NaN }),
    /non-finite dataCoverageFraction/,
  );
});

schemaTest("every terminal non-problem gate removes a stale publication receipt", {}, async (t) => {
  const writeOne = (outDir, record, report = null) => {
    const handle = fs.openSync(path.join(outDir, "tiles.dttstream"), "w");
    try { appendTerrainFrame(handle, record); } finally { fs.closeSync(handle); }
    if (report) fs.writeFileSync(path.join(outDir, "run-report.json"), JSON.stringify(report));
  };
  const stale = temporary(t);
  writeSyntheticTerrainStream(stale);
  await execFileAsync(process.execPath, [VERIFY, "--out", stale], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(fs.existsSync(path.join(stale, "verify-report.json")), true, "fixture first creates a PASS receipt");
  fs.writeFileSync(path.join(stale, "run-report.json"), JSON.stringify({ encoderCounters: { edgeClampedPosts: 1 } }));
  await runVerifierExpectFailure(stale, /clamped posts/);

  const digestMismatch = temporary(t);
  writeOne(digestMismatch, syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 31, digestOverride: `1220${"0".repeat(64)}` }));
  await runVerifierExpectFailure(digestMismatch, /digest mismatches/);

  const noAccuracy = temporary(t);
  writeOne(noAccuracy, syntheticTerrainRecord({ level: 3, x: 0, y: 0, serial: 32, accuracyConfidence: 0 }));
  await runVerifierExpectFailure(noAccuracy, /no tile states a measured vertical accuracy/);

  const largeMask = Buffer.alloc(256 * 256);
  for (let index = 0; index < largeMask.length; index += 1) largeMask[index] = (index * 73) & 0xff;
  const largeRaw = zlib.gunzipSync(syntheticMeshPayload(33, { waterMask: largeMask }));
  const overQuantile = temporary(t);
  writeOne(overQuantile, syntheticTerrainRecord({
    level: 3, x: 0, y: 0, serial: 33, waterMaskKind: "RASTER", meshWaterMask: largeMask,
    payload: zlib.gzipSync(largeRaw, { level: 0 }),
  }));
  await runVerifierExpectFailure(overQuantile, /p50 .* over/);
});

schemaTest("legacy ocean JSON consumes its complete object and availability stays exact for a checkerboard", {}, async (t) => {
  const legacy = temporary(t);
  writeSyntheticTerrainStream(legacy);
  fs.writeFileSync(path.join(legacy, "ocean-skipped.json"), '{"addresses":["3/1/0"]} trailing');
  await runVerifierExpectFailure(legacy, /trailing data/);

  const malformed = temporary(t);
  writeSyntheticTerrainStream(malformed);
  fs.writeFileSync(path.join(malformed, "ocean-skipped.json"), '{"count": nope, "addresses":["3/1/0"]}');
  await runVerifierExpectFailure(malformed, /invalid JSON metadata/);

  const legacyOrdering = temporary(t);
  writeSyntheticTerrainStream(legacyOrdering);
  fs.writeFileSync(path.join(legacyOrdering, "ocean-skipped.json"), '{"addresses":["10/0/0","8/0/0","9/0/0"]}');
  await runVerifierExpectFailure(legacyOrdering, /legacy ocean addresses must be sorted and unique by level\/y\/x/);

  const linked = temporary(t);
  writeSyntheticTerrainStream(linked);
  const legacyTarget = path.join(linked, "legacy-ocean.json");
  fs.writeFileSync(legacyTarget, '{"addresses":["3/1/0"]}');
  fs.symlinkSync(legacyTarget, path.join(linked, "ocean-skipped.json"));
  await runVerifierExpectFailure(linked, /ocean skip receipt is not a regular file/);

  const policyMismatch = temporary(t);
  writeSyntheticTerrainStream(policyMismatch);
  const authoritativePolicy = writeGlobalVerificationInputs(policyMismatch, 1);
  fs.writeFileSync(path.join(policyMismatch, "run-report.json"), JSON.stringify({
    globalConfigDigest: "b".repeat(64),
    publicationPolicy: authoritativePolicy.runReportPolicy,
  }));
  await runVerifierExpectFailure(policyMismatch, /does not match approved-run-config.json/);

  const overApprovedBound = temporary(t);
  writeSyntheticTerrainStream(overApprovedBound);
  writeGlobalVerificationInputs(overApprovedBound, 1, { policyOverride: { max_verified_store_bytes: 13 * 1024 ** 3 } });
  await runVerifierExpectFailure(overApprovedBound, /maxVerifiedStoreBytes exceeds/);

  const undersizedStatic = temporary(t);
  writeSyntheticTerrainStream(undersizedStatic);
  writeGlobalVerificationInputs(undersizedStatic, 1, {
    policyOverride: { max_verified_store_bytes: 2 * 1024 * 1024, max_static_directory_bytes: 1024 * 1024 },
  });
  await runVerifierExpectFailure(undersizedStatic, /maxStaticDirectoryBytes must cover/);

  const outDir = temporary(t);
  const addresses = [];
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) {
    if ((x + y) % 2) addresses.push({ level: 4, x, y });
  }
  writeSyntheticTerrainStream(outDir, addresses);
  const policyInputs = writeGlobalVerificationInputs(outDir, addresses.length);
  const publicationPolicy = policyInputs.normalizedPolicy;
  fs.writeFileSync(path.join(outDir, "run-report.json"), JSON.stringify({
    publicationPolicy: policyInputs.runReportPolicy,
    globalConfigDigest: publicationPolicy.globalConfigDigest,
  }));
  await execFileAsync(process.execPath, ["--max-old-space-size=64", VERIFY, "--out", outDir], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const config = JSON.parse(fs.readFileSync(path.join(outDir, "layer-json-config.json"), "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(outDir, "verify-report.json"), "utf8"));
  assert.equal(report.layerJson.availabilityPath, "terrain-available.json");
  assert.deepEqual(report.publicationPolicy, publicationPolicy);
  assert.equal(report.publicationPolicyLegacyUnbound, false);
  assert.equal(config.terrain_synth_grid_size, publicationPolicy.synthGridSize);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, report.layerJson.availabilityPath), "utf8")), config.terrain_available, "availability artifact and deployment config must share byte-equivalent availability");
  assert.equal(report.publicationInputs.format, "terrain-publication-inputs-v2");
  assert.deepEqual(Object.keys(report.publicationInputs).sort(), ["approvedConfig", "availableButUnstored", "format", "globalState", "layerConfig", "oceanAddresses", "oceanLegacyUnbound", "oceanReceipt", "tiles"]);
  for (const [name, relativePath] of [["tiles", "tiles.dttstream"], ["availableButUnstored", "available-but-unstored.ndjson"], ["layerConfig", "layer-json-config.json"], ["globalState", "global-build-state.json"], ["approvedConfig", "approved-run-config.json"], ["oceanReceipt", "ocean-skipped.json"], ["oceanAddresses", "ocean-skipped.lines"]]) {
    const receipt = report.publicationInputs[name];
    const bytes = fs.readFileSync(path.join(outDir, relativePath));
    assert.equal(receipt.path, relativePath);
    assert.equal(receipt.bytes, bytes.length);
    assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
  assert.equal(report.publicationInputs.tiles.records, addresses.length);
  assert.equal(report.publicationInputs.oceanLegacyUnbound, false);
  assert.equal(report.publicationInputs.oceanAddresses.addresses, 1);
  const actual = new Set();
  config.terrain_available.forEach((rectangles, level) => rectangles.forEach((rect) => {
    for (let y = rect.startY; y <= rect.endY; y += 1) for (let x = rect.startX; x <= rect.endX; x += 1) actual.add(`${level}/${x}/${y}`);
  }));
  const expected = new Set(["0/0/0", "0/1/0"]);
  for (const address of addresses) {
    for (let level = address.level, x = address.x, y = address.y; level > 0; level -= 1, x = Math.floor(x / 2), y = Math.floor(y / 2)) {
      expected.add(`${level}/${x}/${y}`);
    }
  }
  for (let level = 4, x = 15, y = 0; level > 0; level -= 1, x = Math.floor(x / 2), y = Math.floor(y / 2)) {
    expected.add(`${level}/${x}/${y}`);
  }
  assert.deepEqual([...actual].sort(), [...expected].sort(), "streamed rectangle output must preserve the old ancestor-closure semantics");
});

function cacheChild({ dir, maxBytes, url, status, body, delayMs = 0, holdMs = 0, release = false }) {
  const script = `
    const { BoundedGranuleCache } = await import(process.env.SUPPORT_URL);
    const cache = new BoundedGranuleCache({ dir: process.env.CACHE_DIR, maxBytes: Number(process.env.CACHE_MAX) });
    const response = { status: Number(process.env.STATUS), ok: Number(process.env.STATUS) >= 200 && Number(process.env.STATUS) < 300, arrayBuffer: async () => Buffer.from(process.env.BODY) };
    const result = await cache.fetch(process.env.URL, { fetchImpl: async () => { if (Number(process.env.DELAY)) await new Promise((r) => setTimeout(r, Number(process.env.DELAY))); return response; } });
    if (Number(process.env.HOLD)) await new Promise((r) => setTimeout(r, Number(process.env.HOLD)));
    if (process.env.RELEASE === '1') await cache.release(process.env.URL);
    process.stdout.write(JSON.stringify({ status: result.status, body: result.body.toString() }));
  `;
  return execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, SUPPORT_URL, CACHE_DIR: dir, CACHE_MAX: String(maxBytes), URL: url, STATUS: String(status), BODY: body, DELAY: String(delayMs), HOLD: String(holdMs), RELEASE: release ? "1" : "0" },
  });
}

test("separate shard processes reserve capacity under one cap", async (t) => {
  const dir = temporary(t);
  const maxBytes = 1000;
  const outcomes = await Promise.allSettled([
    cacheChild({ dir, maxBytes, url: "https://example.test/a", status: 200, body: "a".repeat(600), holdMs: 300 }),
    cacheChild({ dir, maxBytes, url: "https://example.test/b", status: 200, body: "b".repeat(600), delayMs: 50 }),
  ]);
  assert.ok(outcomes.some((outcome) => outcome.status === "fulfilled"));
  assert.ok(outcomes.some((outcome) => outcome.status === "rejected"), "a live leased entry must block over-cap concurrent publication");
  const observer = new BoundedGranuleCache({ dir, maxBytes, owner: "observer" });
  assert.ok(observer.usageBytes() <= maxBytes, `usage ${observer.usageBytes()} exceeded cap ${maxBytes}`);
});

test("same URL producers publish one coherent generation across processes", async (t) => {
  const dir = temporary(t);
  const options = { dir, maxBytes: 4096, url: "https://example.test/same", release: true };
  const [first, second] = await Promise.all([
    cacheChild({ ...options, status: 200, body: "land", delayMs: 20 }),
    cacheChild({ ...options, status: 404, body: "", delayMs: 0 }),
  ]);
  const a = JSON.parse(first.stdout);
  const b = JSON.parse(second.stdout);
  const cache = new BoundedGranuleCache({ dir, maxBytes: 4096, owner: "observer" });
  const published = await cache.get(options.url);
  assert.deepEqual(a, b, "the producer that lost the URL lock must return the published generation");
  assert.deepEqual(a, { status: published.status, body: published.body.toString() });
});

test("cache reclaims interrupted and corrupt publication windows before capacity admission", async (t) => {
  const dir = temporary(t);
  const entries = path.join(dir, "entries");
  // These model death before current.json, a torn pointer, and death after a
  // pointer but before its whole immutable generation was published.
  fs.mkdirSync(path.join(entries, "empty"), { recursive: true });
  fs.writeFileSync(path.join(entries, "empty", "orphan.bin"), "x".repeat(700));
  fs.mkdirSync(path.join(entries, "torn"), { recursive: true });
  fs.writeFileSync(path.join(entries, "torn", "current.json"), "{not json");
  fs.writeFileSync(path.join(entries, "torn", "generation.bin"), "x".repeat(700));
  fs.mkdirSync(path.join(entries, "partial"), { recursive: true });
  fs.writeFileSync(path.join(entries, "partial", "current.json"), JSON.stringify({ generation: "g", lastUsed: 0 }));
  fs.writeFileSync(path.join(entries, "partial", "g.bin"), "x".repeat(700));
  const cache = new BoundedGranuleCache({ dir, maxBytes: 1000, owner: "resume" });
  await cache.fetch("https://example.test/live", { fetchImpl: async () => response(200, "v".repeat(600)) });
  assert.equal(fs.readdirSync(entries).length, 1, "all unpublished/corrupt generations must be reclaimed");
  assert.ok(await cache.usageBytesLocked() <= 1000);
});

test("resume reclaims a lease owned by a killed process", async (t) => {
  const dir = temporary(t);
  const maxBytes = 1000;
  const killed = new BoundedGranuleCache({ dir, maxBytes, owner: "killed", pid: 424242, isPidAlive: (pid) => pid === 424242 });
  await killed.fetch("https://example.test/a", { fetchImpl: async () => response(200, "a".repeat(600)) });
  const resumed = new BoundedGranuleCache({ dir, maxBytes, owner: "resumed", isPidAlive: () => false });
  await resumed.fetch("https://example.test/b", { fetchImpl: async () => response(200, "b".repeat(600)) });
  assert.equal(await resumed.get("https://example.test/a"), null);
  assert.equal((await resumed.get("https://example.test/b")).body.length, 600);
});

test("resume reclaims a live reused PID whose process identity changed", async (t) => {
  const dir = temporary(t);
  const maxBytes = 1000;
  const old = new BoundedGranuleCache({
    dir, maxBytes, owner: "old", pid: 77,
    isPidAlive: (pid) => pid === 77,
    processIdentity: (pid) => ({ pid, startToken: "boot:old" }),
  });
  await old.fetch("https://example.test/a", { fetchImpl: async () => response(200, "a".repeat(600)) });
  const resumed = new BoundedGranuleCache({
    dir, maxBytes, owner: "resumed",
    isPidAlive: (pid) => pid === 77,
    processIdentity: (pid) => ({ pid, startToken: "boot:new" }),
  });
  await resumed.fetch("https://example.test/b", { fetchImpl: async () => response(200, "b".repeat(600)) });
  assert.equal(await resumed.get("https://example.test/a"), null);
  assert.equal((await resumed.get("https://example.test/b")).body.length, 600);
});

test("identity-less live leases survive the ordinary TTL while their holder heartbeat is fresh", async (t) => {
  const dir = temporary(t);
  const maxBytes = 1000;
  const started = Date.now();
  let now = started;
  const ownerOptions = {
    dir, maxBytes, pid: 77, isPidAlive: (pid) => pid === 77,
    processIdentity: (pid) => ({ pid, startToken: null }), now: () => now,
    leaseTtlMs: 100, identitylessHeartbeatTtlMs: 1_000, heartbeatIntervalMs: 10,
  };
  const held = new BoundedGranuleCache({ ...ownerOptions, owner: "held" });
  const urlA = "https://example.test/a";
  await held.fetch(urlA, { fetchImpl: async () => response(200, "a".repeat(600)) });
  now = started + 500; // Beyond ordinary lease TTL, inside the identity-less crash bound.
  await held.refreshHeartbeat(held.leasePath(held.key(urlA)), JSON.parse(fs.readFileSync(held.leasePath(held.key(urlA)), "utf8")).token);
  now = started + 1_050; // Still > ordinary TTL, but heartbeat is only 550 ms old.
  const resumed = new BoundedGranuleCache({ ...ownerOptions, owner: "resumed" });
  await assert.rejects(
    resumed.fetch("https://example.test/b", { fetchImpl: async () => response(200, "b".repeat(600)) }),
    /leased granules/,
  );
  held.stopLeaseHeartbeat(held.leasePath(held.key(urlA))); // Model a killed/stalled holder.
  now = started + 3_000; // No holder heartbeat for > crash bound: recover the reservation.
  await resumed.fetch("https://example.test/b", { fetchImpl: async () => response(200, "b".repeat(600)) });
  assert.equal(await resumed.get(urlA), null);
  await held.releaseAll();
  await resumed.releaseAll();
});

test("identity-less live directory locks heartbeat through long work and stop on cleanup", async (t) => {
  const dir = temporary(t);
  const options = {
    dir, maxBytes: 4096, pid: 77, isPidAlive: (pid) => pid === 77,
    processIdentity: (pid) => ({ pid, startToken: null }),
    leaseTtlMs: 10, identitylessHeartbeatTtlMs: 40, heartbeatIntervalMs: 5, lockWaitMs: 20,
  };
  const held = new BoundedGranuleCache({ ...options, owner: "held" });
  const contender = new BoundedGranuleCache({ ...options, owner: "contender" });
  const lock = path.join(dir, "producer-locks", "live.lock");
  let release;
  const complete = new Promise((resolve) => { release = resolve; });
  const holding = held.withDirectoryLock(lock, async () => complete);
  await new Promise((resolve) => setTimeout(resolve, 55));
  await assert.rejects(contender.withDirectoryLock(lock, async () => {}), /timed out waiting for cache lock/);
  release();
  await holding;
  await contender.withDirectoryLock(lock, async () => {});
});

test("an interleaved stale heartbeat never resurrects or disturbs a successor lock", async (t) => {
  const dir = temporary(t);
  const lock = path.join(dir, "producer-locks", "race.lock");
  const oldToken = "old-owner";
  const successorToken = "successor-owner";
  let swapOnPulse = true;
  const old = new BoundedGranuleCache({
    dir, maxBytes: 4096, owner: "old", heartbeatIntervalMs: 5, identitylessHeartbeatTtlMs: 40,
    onHeartbeatBeforeWrite: () => {
      if (!swapOnPulse) return;
      swapOnPulse = false;
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ token: successorToken, pid: process.pid, identity: { startToken: null } }));
    },
  });
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ token: oldToken, pid: process.pid, identity: { startToken: null } }));
  const timer = old.startHeartbeat(path.join(lock, "owner.json"), oldToken);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token, successorToken);
  assert.equal(fs.existsSync(path.join(lock, `.heartbeat-${oldToken}`)), false, "old pulse must not remain in successor lock");
  fs.rmSync(lock, { recursive: true, force: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(lock), false, "old timer must not recreate a recovered lock directory");
  clearInterval(timer);
  const successor = new BoundedGranuleCache({ dir, maxBytes: 4096, owner: "successor" });
  await successor.withDirectoryLock(lock, async () => {});
});

test("malformed lock and lease metadata fail closed after their bounded TTL", async (t) => {
  const dir = temporary(t);
  const now = () => 10_000;
  const cache = new BoundedGranuleCache({ dir, maxBytes: 1000, owner: "resume", now, leaseTtlMs: 100, lockWaitMs: 100 });
  const lock = path.join(dir, "locks", "cache.lock");
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), "{broken");
  fs.utimesSync(lock, 0, 0);
  const key = cache.key("https://example.test/stale");
  const lease = path.join(dir, "leases", `${key}.dead.json`);
  fs.writeFileSync(lease, "{broken");
  fs.utimesSync(lease, 0, 0);
  await cache.fetch("https://example.test/stale", { fetchImpl: async () => response(200, "ok") });
  assert.equal(fs.existsSync(lease), false);
});

test("coordinator fault after a checkpoint resumes without recutting it", async (t) => {
  const root = temporary(t);
  const config = path.join(root, "run.json");
  const log = path.join(root, "runner.log");
  fs.writeFileSync(config, JSON.stringify({ flow_config: { regions: [{ name: "west", west: 0, south: 0, east: 2, north: 1 }] } }));
  const common = [COORDINATOR, "--config", config, "--out", root, "--shards", "2", "--workers", "1", "--runner", REHEARSAL_RUNNER, "--skip-verify"];
  await assert.rejects(
    execFileAsync(process.execPath, [...common, "--fault-after-shards", "1"], { env: { ...process.env, TERRAIN_REHEARSAL_LOG: log } }),
    /fault injection after 1 completed shard/,
  );
  const stateAfterFault = JSON.parse(fs.readFileSync(path.join(root, "global-build-state.json"), "utf8"));
  assert.equal(stateAfterFault.shards[0].status, "complete");
  await execFileAsync(process.execPath, common, { env: { ...process.env, TERRAIN_REHEARSAL_LOG: log } });
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["0", "1"]);
});

test("real two-region terrain artifact rehearsal matches single and concurrent shard records", async (t) => {
  const report = path.join(temporary(t), "rehearsal.json");
  const result = await execFileAsync(process.execPath, [REAL_REHEARSAL, "--out", report]);
  const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(parsed.parity, "PASS");
  assert.equal(parsed.regions.length, 1);
  assert.ok(parsed.records > 0);
  assert.match(parsed.execution, /run\.mjs single lane.*2 OS workers/);
  assert.match(result.stdout, /"parity":"PASS"/);
});
