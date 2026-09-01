import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  BoundedTopK,
  SourceRequestObserver,
  appendRequestObservation,
  emitCompletionSourceManifest,
  ensureSourceEpoch,
  mergeBoundedFramedStores,
  mergeOceanSkips,
  observationForRequest,
  sha256,
  sourcePolicyAllowsUrl,
  sourcePolicyContract,
} from "../source-provenance.mjs";
import { iterateStreamFile } from "../dtt-reader.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const COORDINATOR = path.join(HERE, "..", "global-build.mjs");
const CROSS_CHECK = path.join(HERE, "..", "cross-check-accuracy.mjs");
const PROVENANCE_URL = new URL("../source-provenance.mjs", import.meta.url).href;

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-provenance-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function contract({ epoch = "2023-04-01T00:00:00.000Z", manifest = "source-manifest.ndjson" } = {}) {
  return sourcePolicyContract({
    cache_max_bytes: 96 * 1024 ** 3,
    source_policy: {
      version: 1,
      provider: "test-provider",
      dataset_epoch: epoch,
      url_policy: {
        base_url: "https://example.test/",
        dem_template: "dem/{NS}{LAT2}/{EW}{LON3}",
        water_template: "water/{NS}{LAT2}/{EW}{LON3}",
      },
      request: { timeout_ms: 1000, retries: 1, retry_base_ms: 1, max_outstanding: 8 },
      no_data: {
        http_404: "record-no-coverage-never-retry",
        non_water: "fail",
      },
      ocean_policy: "only paired all-water observations synthesize water",
      cache: { max_bytes: 96 * 1024 ** 3 },
      manifest: {
        format: "canonical-jsonl-v1",
        digest: "sha256",
        shard_log: "source-observations.ndjson",
        completion_manifest: manifest,
      },
    },
  });
}

function fetched(body, { status = 200, hit = false } = {}) {
  return { status, hit, body: Buffer.from(body) };
}

function framed(records) {
  return Buffer.concat(records.flatMap((record) => {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(record.length);
    return [length, record];
  }));
}

test("source epoch refuses torn receipts, legacy cache bytes, and changed policy resumes", (t) => {
  const root = temporary(t);
  const policy = contract();
  const torn = path.join(root, "torn");
  fs.mkdirSync(torn, { recursive: true });
  fs.writeFileSync(path.join(torn, "source-epoch.json"), "{torn");
  assert.throws(() => ensureSourceEpoch(torn, policy), /torn or unreadable/);

  const legacy = path.join(root, "legacy");
  fs.mkdirSync(path.join(legacy, "entries", "old"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "entries", "old", "bytes"), "unattributed");
  assert.throws(() => ensureSourceEpoch(legacy, policy), /legacy cache entries/);

  const cache = path.join(root, "cache");
  ensureSourceEpoch(cache, policy);
  assert.throws(() => ensureSourceEpoch(cache, contract({ epoch: "2024-01-01T00:00:00.000Z" })), /mix source policy epochs/);
});

test("source policy permits only its immutable base URL and naming templates", () => {
  const policy = contract();
  assert.equal(sourcePolicyAllowsUrl(policy, "https://example.test/dem/N45/E006"), true);
  assert.equal(sourcePolicyAllowsUrl(policy, "https://example.test/dem/N45/E006?mutable=1"), false);
  assert.equal(sourcePolicyAllowsUrl(policy, "https://other.test/dem/N45/E006"), false);
  assert.throws(() => sourcePolicyContract({
    cache_max_bytes: policy.cacheMaxBytes,
    source_policy: policy.policy,
    flow_config: { retrieved_at: "2099-01-01T00:00:00.000Z" },
  }), /must not prefill flow_config\.retrieved_at/);
});

test("same URL cannot change content within a source epoch", (t) => {
  const cache = path.join(temporary(t), "cache");
  ensureSourceEpoch(cache, contract());
  const url = "https://example.test/granule.tif";
  const first = observationForRequest({
    cacheDir: cache, url, fetched: fetched("first"),
    networkObservation: { etag: "one", observed_at: "2026-09-01T00:00:00.000Z" },
  });
  assert.equal(first.content_length, 5);
  assert.throws(() => observationForRequest({
    cacheDir: cache, url, fetched: fetched("second"),
    networkObservation: { etag: "two", observed_at: "2026-09-01T00:01:00.000Z" },
  }), /source changed/);
});

test("source observer caps retained request metadata and refuses redirects", async () => {
  const seen = [];
  const observer = new SourceRequestObserver({
    timeoutMs: 1000,
    maxOutstanding: 1,
    fetchImpl: async (_url, options) => {
      seen.push(options);
      return { status: 200, headers: new Headers({ etag: "abc", "last-modified": "Mon, 01 Sep 2026 00:00:00 GMT" }) };
    },
  });
  await observer.fetch("https://example.test/a");
  await assert.rejects(observer.fetch("https://example.test/a"), /concurrent duplicate source request/);
  await assert.rejects(observer.fetch("https://example.test/b"), /exceeds 1 outstanding/);
  assert.equal(seen[0].redirect, "error");
  assert.equal(observer.take("https://example.test/a").etag, "abc");
});

test("a body-read failure can discard retained source headers before the next request", async () => {
  const observer = new SourceRequestObserver({
    timeoutMs: 1000,
    maxOutstanding: 1,
    fetchImpl: async () => ({
      status: 200,
      headers: new Headers({ etag: "body-will-fail" }),
      arrayBuffer: async () => { throw new Error("body read failed"); },
    }),
  });
  const response = await observer.fetch("https://example.test/a");
  await assert.rejects(response.arrayBuffer(), /body read failed/);
  observer.discard("https://example.test/a");
  await observer.fetch("https://example.test/b");
  assert.equal(observer.take("https://example.test/b").etag, "body-will-fail");
});

test("source epoch and per-URL receipts are stat-capped before JSON parsing", (t) => {
  const cache = path.join(temporary(t), "cache");
  const policy = contract();
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "source-epoch.json"), "x".repeat(5 * 1024));
  assert.throws(() => ensureSourceEpoch(cache, policy), /torn or unreadable/);

  const clean = path.join(temporary(t), "clean");
  ensureSourceEpoch(clean, policy);
  const url = "https://example.test/dem/N45/E006";
  fs.mkdirSync(path.join(clean, "source-observations"));
  fs.writeFileSync(path.join(clean, "source-observations", `${sha256(url)}.json`), "x".repeat(17 * 1024));
  assert.throws(() => observationForRequest({ cacheDir: clean, url, fetched: fetched("", { hit: true }) }),
    /source observation receipt exceeds/);
});

test("external multi-chunk manifest merge deduplicates deterministically across fan-in", async (t) => {
  const root = temporary(t);
  const policy = contract();
  const cache = path.join(root, "cache");
  ensureSourceEpoch(cache, policy);
  const source = observationForRequest({
    cacheDir: cache,
    url: "https://example.test/granule.tif",
    fetched: fetched("bytes"),
    networkObservation: { etag: "immutable", observed_at: "2026-09-01T00:00:00.000Z" },
  });
  const logs = [];
  for (let index = 0; index < 65; index += 1) {
    const log = path.join(root, `shard-${index}.ndjson`);
    appendRequestObservation(log, source, {
      requestedAt: `2026-09-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      cacheHit: index !== 0,
    });
    logs.push(log);
  }
  const receipt = await emitCompletionSourceManifest({
    outDir: root,
    logFiles: logs,
    contract: policy,
    configDigest: "f".repeat(64),
    sortRunBytes: 1,
    fanIn: 2,
  });
  assert.equal(receipt.observations, 1);
  const manifest = fs.readFileSync(path.join(root, receipt.path), "utf8").trim();
  assert.equal(manifest.split("\n").length, 1);
  assert.equal(manifest.includes("requested_at"), false, "worker scheduling evidence stays in the per-request shard log");
  assert.equal(manifest.includes("cache_hit"), false);
  const repeat = await emitCompletionSourceManifest({
    outDir: root, logFiles: logs, contract: policy, configDigest: "f".repeat(64), sortRunBytes: 1, fanIn: 2,
  });
  assert.deepEqual(repeat, receipt, "an immutable manifest may be read back but never rewritten with new bytes");
});

test("byte-capped JSONL reader rejects an unterminated oversized line under a constrained heap", async (t) => {
  const root = temporary(t);
  const policy = contract();
  const log = path.join(root, "oversized.ndjson");
  fs.writeFileSync(log, "x".repeat(20 * 1024));
  await assert.rejects(
    emitCompletionSourceManifest({ outDir: root, logFiles: [log], contract: policy, configDigest: "a".repeat(64) }),
    /exceeds 16384 bytes/,
  );
  assert.equal(fs.existsSync(path.join(root, "source-manifest.ndjson")), false);
});

test("incomplete source-policy coordinator cannot emit a completion manifest", async (t) => {
  const root = temporary(t);
  const config = path.join(root, "run.json");
  const policy = contract();
  fs.writeFileSync(config, JSON.stringify({
    cache_max_bytes: policy.cacheMaxBytes,
    source_policy: policy.policy,
    flow_config: { regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }] },
  }));
  await assert.rejects(
    execFileAsync(process.execPath, [COORDINATOR, "--config", config, "--out", path.join(root, "out"), "--skip-verify"]),
    /source-policy build may not use --skip-verify/,
  );
  assert.equal(fs.existsSync(path.join(root, "out", "source-manifest.ndjson")), false);
});

test("a fault after a source-backed shard checkpoint cannot emit a completion manifest", async (t) => {
  const root = temporary(t);
  const policy = contract();
  const config = path.join(root, "run.json");
  const runner = path.join(root, "source-runner.mjs");
  fs.writeFileSync(config, JSON.stringify({
    cache_max_bytes: policy.cacheMaxBytes,
    source_policy: policy.policy,
    flow_config: { regions: [{ name: "test", west: 0, south: 0, east: 2, north: 1 }] },
  }));
  fs.writeFileSync(runner, `
    import fs from "node:fs";
    import path from "node:path";
    import { canonicalJson, sha256, sourcePolicyContract } from ${JSON.stringify(PROVENANCE_URL)};
    const value = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--config") + 1], "utf8"));
    const out = process.argv[process.argv.indexOf("--out") + 1];
    const contract = sourcePolicyContract(value);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "tiles.dttstream"), "");
    const url = "https://example.test/dem/N45/E006";
    fs.writeFileSync(path.join(out, contract.policy.manifest.shard_log), canonicalJson({
      source_key: "sha256:" + sha256(url), url, status: 200, content_length: 0,
      content_digest: sha256(""), observed_at: "2026-09-01T00:00:00.000Z",
      requested_at: "2026-09-01T00:00:00.000Z", cache_hit: false,
    }) + "\\n");
    fs.writeFileSync(path.join(out, "run-report.json"), JSON.stringify({
      drained: true, errors: [], sourceProvenance: {
        sourcePolicyDigest: contract.digest, datasetEpoch: contract.datasetEpoch,
      },
    }));
  `);
  await assert.rejects(
    execFileAsync(process.execPath, [
      COORDINATOR, "--config", config, "--out", path.join(root, "out"),
      "--shards", "2", "--workers", "1", "--runner", runner, "--fault-after-shards", "1",
    ]),
    /fault injection after 1 completed shard/,
  );
  assert.equal(fs.existsSync(path.join(root, "out", "source-manifest.ndjson")), false);
  assert.equal(fs.existsSync(path.join(root, "out", "global-merge-report.json")), false);
});

test("bounded multi-run terrain merge preserves ordered output and duplicate parity", async (t) => {
  const root = temporary(t);
  const records = (address, fill) => Buffer.from(`${address}|${fill.repeat(900)}`);
  const a = records("8/1/1", "a");
  const b = records("8/2/1", "b");
  const c = records("9/4/2", "c");
  const first = path.join(root, "first.dttstream");
  const second = path.join(root, "second.dttstream");
  const merged = path.join(root, "merged.dttstream");
  fs.writeFileSync(first, framed([b, a]));
  fs.writeFileSync(second, framed([a, c]));
  const result = await mergeBoundedFramedStores({
    inputFiles: [first, second], outputFile: merged,
    addressForRecord: (record) => record.toString("utf8").split("|", 1)[0],
    maxRunBytes: 2048, fanIn: 2,
  });
  const output = [];
  for await (const record of iterateStreamFile(merged, { highWaterMark: 17 })) output.push(record.toString("utf8").split("|", 1)[0]);
  assert.deepEqual(output, ["8/1/1", "8/2/1", "9/4/2"]);
  assert.equal(result.records, 3);
  assert.equal(result.duplicates, 1);
  assert.match(result.recordSetDigest, /^[0-9a-f]{64}$/);
});

test("bounded terrain merge rejects different records at one shard address", async (t) => {
  const root = temporary(t);
  const first = path.join(root, "first.dttstream");
  const second = path.join(root, "second.dttstream");
  fs.writeFileSync(first, framed([Buffer.from("8/1/1|first")]));
  fs.writeFileSync(second, framed([Buffer.from("8/1/1|second")]));
  await assert.rejects(
    mergeBoundedFramedStores({
      inputFiles: [first, second], outputFile: path.join(root, "merged.dttstream"),
      addressForRecord: (record) => record.toString("utf8").split("|", 1)[0],
      maxRunBytes: 1024, fanIn: 2,
    }),
    /shards disagree on duplicate address 8\/1\/1/,
  );
});

test("ocean-skip merge streams legacy JSON and JSONL into a compact receipt", async (t) => {
  const root = temporary(t);
  const legacy = path.join(root, "legacy.json");
  const jsonl = path.join(root, "current.lines");
  const output = path.join(root, "ocean-skipped.lines");
  fs.writeFileSync(legacy, JSON.stringify({ generatedAt: "old", addresses: ["8/2/1", "8/1/1"] }));
  fs.writeFileSync(jsonl, "8/3/1\n");
  const receipt = await mergeOceanSkips({ inputFiles: [legacy, jsonl], outputFile: output, maxRunBytes: 1, fanIn: 2 });
  assert.equal(receipt.count, 3);
  assert.equal(receipt.duplicates, 0);
  assert.deepEqual(fs.readFileSync(output, "utf8").trim().split("\n"), ["8/1/1", "8/2/1", "8/3/1"]);
  assert.match(receipt.digest, /^[0-9a-f]{64}$/);
});

test("ocean-skip merge rejects duplicate shard coverage instead of hiding it", async (t) => {
  const root = temporary(t);
  const first = path.join(root, "first.lines");
  const second = path.join(root, "second.lines");
  fs.writeFileSync(first, "8/1/1\n");
  fs.writeFileSync(second, "8/1/1\n");
  await assert.rejects(
    mergeOceanSkips({ inputFiles: [first, second], outputFile: path.join(root, "merged.lines"), maxRunBytes: 1, fanIn: 2 }),
    /ocean-skip inputs overlap at 8\/1\/1/,
  );
});

test("constrained top-K heap retains the same streamed high-relief sample without per-record sorting", () => {
  const compareBest = (a, b) => a.relief - b.relief || b.x - a.x || b.y - a.y;
  const heap = new BoundedTopK(7, compareBest);
  for (let index = 0; index < 100_000; index += 1) {
    const row = { relief: index, x: index % 257, y: Math.floor(index / 257) };
    heap.add(row);
  }
  const expected = Array.from({ length: 7 }, (_, offset) => {
    const index = 99_999 - offset;
    return { relief: index, x: index % 257, y: Math.floor(index / 257) };
  });
  assert.equal(heap.heap.length, 7);
  assert.deepEqual(heap.ordered(), expected);
});

test("cross-check bounds its report before JSON.parse and rejects duplicate samples", async (t) => {
  const root = temporary(t);
  const report = path.join(root, "accuracy-report.json");
  fs.writeFileSync(report, "x".repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(
    execFileAsync(process.execPath, ["--max-old-space-size=32", CROSS_CHECK, "--out", root]),
    /accuracy report exceeds .* byte bound/,
  );
  fs.writeFileSync(report, JSON.stringify({
    levels: [{ level: 8, tiles: [{ address: "8/1/1" }, { address: "8/1/1" }] }],
  }));
  await assert.rejects(
    execFileAsync(process.execPath, [CROSS_CHECK, "--out", root]),
    /duplicate tile 8\/1\/1/,
  );
});

test("cross-check rejects a bounded report tile absent from the stream", async (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, "accuracy-report.json"), JSON.stringify({
    levels: [{ level: 8, tiles: [{ address: "8/1/1" }] }],
  }));
  fs.writeFileSync(path.join(root, "tiles.dttstream"), Buffer.alloc(0));
  await assert.rejects(
    execFileAsync(process.execPath, [CROSS_CHECK, "--out", root]),
    /names tile\(s\) missing from tiles\.dttstream: 8\/1\/1/,
  );
});
