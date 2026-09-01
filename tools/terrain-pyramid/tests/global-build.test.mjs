import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BoundedGranuleCache,
  fetchWithRetry,
  initializeGlobalState,
  makeShardConfigs,
  markShard,
  recordSetDigest,
  saveGlobalState,
  sha256,
} from "../build-support.mjs";
import { iterateStreamFile } from "../dtt-reader.mjs";

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
  cache.release("https://example.test/a");
  cache.release("https://example.test/b");
  await cache.fetch("https://example.test/b", { fetchImpl: async () => response(200, b) });
  assert.ok(cache.usageBytes() <= 1000);
  assert.equal(cache.get("https://example.test/a"), null);
  assert.equal(cache.get("https://example.test/b").body.toString(), b);
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

test("multi-worker parity identity is independent of merge order", () => {
  const a = [["8/1/1", "a"], ["8/2/1", "b"], ["9/4/2", "c"]];
  assert.equal(recordSetDigest(a), recordSetDigest([...a].reverse()));
});
