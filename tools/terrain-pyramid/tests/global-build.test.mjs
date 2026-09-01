import assert from "node:assert/strict";
import fs from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  BoundedGranuleCache,
  compareCodeUnits,
  createSortedJsonRunWriter,
  evaluateTerrainEdgeFacts,
  fetchWithRetry,
  initializeGlobalState,
  makeShardConfigs,
  markShard,
  recordSetDigest,
  readGenerationCacheEntry,
  saveGlobalState,
  sha256,
  mergeSortedJsonRuns,
  writeSortedJsonRuns,
} from "../build-support.mjs";
import { iterateStreamFile } from "../dtt-reader.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SUPPORT_URL = new URL("../build-support.mjs", import.meta.url).href;
const COORDINATOR = path.join(HERE, "..", "global-build.mjs");
const REHEARSAL_RUNNER = path.join(HERE, "fixtures", "rehearsal-runner.mjs");
const REAL_REHEARSAL = path.join(HERE, "..", "rehearse.mjs");

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-global-build-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function response(status, body = "") {
  return { status, ok: status >= 200 && status < 300, arrayBuffer: async () => Buffer.from(body) };
}

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
    assert.match(result.problemExamples[0], /^seam at 12\/0\/0 east vs 12\/1\/0 west shared post 0 of 2:/);
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
