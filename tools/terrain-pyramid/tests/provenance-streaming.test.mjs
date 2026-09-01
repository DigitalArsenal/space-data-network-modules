import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  BoundedTopK,
  commitCellAttempt,
  FixedHistogram,
  recoverCellAttempt,
  SourceRequestObserver,
  appendRequestObservation,
  emitCompletionSourceManifest,
  ensureSourceEpoch,
  mergeBoundedFramedStores,
  mergeOceanSkips,
  observationForRequest,
  publicationPolicyContract,
  sha256,
  sourcePolicyAllowsUrl,
  sourcePolicyContract,
  validateCachedSource,
} from "../source-provenance.mjs";
import { BoundedGranuleCache } from "../build-support.mjs";
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
    flow_config: { dataset_epoch: epoch },
    source_policy: {
      version: 1,
      provider: "test-provider",
      dataset_epoch: epoch,
      url_policy: {
        base_url: "https://example.test/",
        dem_template: "dem/{NS}{LAT2}/{EW}{LON3}",
        water_template: "water/{NS}{LAT2}/{EW}{LON3}",
      },
      request: { timeout_ms: 1000, retries: 1, retry_base_ms: 1, max_outstanding: 8, max_response_bytes: 1024 * 1024 },
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
  assert.equal(sourcePolicyAllowsUrl(policy, "https://example.test/dem/N89/E179"), true);
  assert.equal(sourcePolicyAllowsUrl(policy, "https://example.test/dem/S90/W180"), true);
  for (const invalid of ["N90/E000", "S00/E000", "N00/W000", "N89/E180", "N99/E999"]) {
    assert.equal(sourcePolicyAllowsUrl(policy, `https://example.test/dem/${invalid}`), false, `${invalid} is outside canonical Copernicus bounds`);
  }
  const copernicusPolicy = sourcePolicyContract(JSON.parse(fs.readFileSync(path.join(HERE, "..", "regions", "global-z10.json"), "utf8")));
  assert.equal(sourcePolicyAllowsUrl(copernicusPolicy,
    "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/Copernicus_DSM_COG_10_N89_00_E179_00_DEM/Copernicus_DSM_COG_10_N89_00_E179_00_DEM.tif"), true);
  assert.equal(sourcePolicyAllowsUrl(copernicusPolicy,
    "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/Copernicus_DSM_COG_10_N89_00_E179_00_DEM/Copernicus_DSM_COG_10_N88_00_E179_00_DEM.tif"), false,
  "directory and filename coordinates must agree");
  assert.throws(() => sourcePolicyContract({
    cache_max_bytes: policy.cacheMaxBytes,
    source_policy: policy.policy,
    flow_config: { dataset_epoch: policy.datasetEpoch, retrieved_at: "2099-01-01T00:00:00.000Z" },
  }), /must not prefill flow_config\.retrieved_at/);
  assert.throws(() => sourcePolicyContract({
    cache_max_bytes: policy.cacheMaxBytes,
    source_policy: policy.policy,
    flow_config: { dataset_epoch: "wrong-epoch" },
  }), /flow_config\.dataset_epoch must equal/);
});

test("publication policy has explicit bounded store/static ceilings and binds synth grid", () => {
  const runConfig = {
    publication_policy: {
      version: 1,
      max_verified_store_bytes: 12 * 1024 ** 3,
      max_static_directory_bytes: 128 * 1024 ** 3,
      synthesized_tile_grid_size: 2,
      static_directory_basis: "measured compressed store plus bounded static representation",
    },
    flow_config: { terrain_synth_grid_size: 2 },
  };
  const policy = publicationPolicyContract(runConfig);
  assert.match(policy.digest, /^[0-9a-f]{64}$/);
  assert.equal(policy.policy.synthesized_tile_grid_size, 2);
  assert.throws(() => publicationPolicyContract({
    ...runConfig,
    publication_policy: { ...runConfig.publication_policy, max_static_directory_bytes: 1024 ** 4 },
  }), /may not exceed/);
  assert.throws(() => publicationPolicyContract({
    ...runConfig, flow_config: { terrain_synth_grid_size: 65 },
  }), /must equal/);
});

test("global static publication ceiling follows checked identity-directory expansion evidence", () => {
  const region = JSON.parse(fs.readFileSync(path.join(HERE, "..", "regions", "global-z10.json"), "utf8"));
  const regionalRun = JSON.parse(fs.readFileSync(path.join(HERE, "..", "evidence", "liguria-z11", "run-report.json"), "utf8"));
  const regionalPublication = JSON.parse(fs.readFileSync(path.join(HERE, "..", "evidence", "liguria-z11", "ipfs-publication.json"), "utf8"));
  const observedExpansion = regionalPublication.directoryBytes / regionalRun.storeBytes;
  const measuredGlobalUpperStoreBytes = 8.51 * 1024 ** 3;
  const minimumStaticCeiling = observedExpansion * measuredGlobalUpperStoreBytes;
  assert.equal(regionalRun.storeBytes, 35149748);
  assert.equal(regionalPublication.directoryBytes, 450180397);
  assert.ok(observedExpansion > 12.807 && observedExpansion < 12.808);
  assert.ok(region.publication_policy.max_static_directory_bytes >= minimumStaticCeiling,
    "global static ceiling must cover observed directory/store expansion at the global upper estimate");
  assert.equal(region.publication_policy.max_static_directory_bytes, 128 * 1024 ** 3,
    "global static ceiling is the reviewed 128 GiB binary bound, not a generic host-capacity value");
  assert.equal(region.publication_policy.max_verified_store_bytes, 12 * 1024 ** 3);
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

test("source request timeout remains active through a stalled response body", async (t) => {
  const cache = new BoundedGranuleCache({ dir: path.join(temporary(t), "cache"), maxBytes: 1024 * 1024, owner: "timeout" });
  let signal;
  const observer = new SourceRequestObserver({
    timeoutMs: 20,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        status: 200,
        ok: true,
        headers: new Headers({ etag: "headers-arrived" }),
        arrayBuffer: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("body aborted")), { once: true })),
      };
    },
  });
  const url = "https://example.test/dem/N45/E006";
  await assert.rejects(cache.fetch(url, { fetchImpl: observer.fetch.bind(observer) }), /body aborted/);
  assert.equal(signal.aborted, true);
  observer.discard(url);
  await cache.release(url);
});

test("cache consumes a terminal 404 body before its provenance callback publishes it", async (t) => {
  const cache = new BoundedGranuleCache({ dir: path.join(temporary(t), "cache"), maxBytes: 1024 * 1024, owner: "404-body" });
  let observed;
  await cache.fetch("https://example.test/dem/N45/E006", {
    fetchImpl: async () => ({ status: 404, ok: false, headers: new Headers(), arrayBuffer: async () => Buffer.from("no coverage") }),
    beforePublish: ({ status, body }) => { observed = { status, body: body.toString("utf8") }; },
  });
  assert.deepEqual(observed, { status: 404, body: "no coverage" });
  await cache.release("https://example.test/dem/N45/E006");
});

test("source response cap rejects announced and streamed overages before cache publication", async (t) => {
  const cache = new BoundedGranuleCache({ dir: path.join(temporary(t), "cache"), maxBytes: 1024 * 1024, owner: "response-cap" });
  const observer = new SourceRequestObserver({
    timeoutMs: 1000,
    fetchImpl: async () => ({
      status: 200, ok: true,
      headers: new Headers({ "content-length": "9" }),
      body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock: () => {} }) },
    }),
  });
  const url = "https://example.test/dem/N45/E006";
  await assert.rejects(cache.fetch(url, {
    fetchImpl: observer.fetch.bind(observer), maxResponseBytes: 8, requireStreamingBody: true,
    onBodyLimit: () => observer.abort(url),
  }), /Content-Length 9 exceeds approved 8-byte object cap/);
  assert.equal(observer.byUrl.get(url)?.controller.signal.aborted, true);
  assert.equal(await cache.get(url), null, "over-cap response never publishes a cache generation");
  observer.discard(url);
  await cache.release(url);

  const streamed = "https://example.test/dem/N45/E007";
  let cancelled = false;
  const streamObserver = new SourceRequestObserver({
    timeoutMs: 1000,
    fetchImpl: async () => ({
      status: 200, ok: true, headers: new Headers(),
      body: { getReader: () => ({
        read: async () => ({ done: false, value: Buffer.from("nine-bytes") }),
        cancel: async () => { cancelled = true; }, releaseLock: () => {},
      }) },
    }),
  });
  await assert.rejects(cache.fetch(streamed, {
    fetchImpl: streamObserver.fetch.bind(streamObserver), maxResponseBytes: 8, requireStreamingBody: true,
    onBodyLimit: () => streamObserver.abort(streamed),
  }), /body exceeds approved 8-byte object cap/);
  assert.equal(cancelled, true);
  assert.equal(streamObserver.byUrl.get(streamed)?.controller.signal.aborted, true);
  streamObserver.discard(streamed);
  await cache.release(streamed);
});

test("retry disposes a transient observer response before terminal source receipt/log publication", async (t) => {
  const cacheDir = path.join(temporary(t), "cache");
  const policy = contract();
  ensureSourceEpoch(cacheDir, policy);
  const cache = new BoundedGranuleCache({ dir: cacheDir, maxBytes: 1024 * 1024, owner: "retry-observer" });
  const url = "https://example.test/dem/N45/E006";
  let attempt = 0;
  const observer = new SourceRequestObserver({
    timeoutMs: 1000,
    fetchImpl: async () => {
      attempt += 1;
      const status = attempt === 1 ? 500 : 200;
      return { status, ok: status === 200, headers: new Headers({ etag: `attempt-${attempt}` }), arrayBuffer: async () => Buffer.from(status === 200 ? "final" : "retry") };
    },
  });
  let persisted;
  const fetchedResponse = await cache.fetch(url, {
    fetchImpl: observer.fetch.bind(observer), retries: 1, retryBaseMs: 0,
    onDiscardResponse: () => observer.discard(url),
    beforePublish: ({ status, body }) => {
      persisted = observationForRequest({ cacheDir, url, fetched: { status, body, hit: false }, networkObservation: observer.peek(url) });
      observer.take(url);
    },
  });
  const log = path.join(cacheDir, "terminal-only.ndjson");
  appendRequestObservation(log, persisted, { requestedAt: "2026-09-01T00:00:00.000Z", cacheHit: false });
  assert.equal(attempt, 2);
  assert.equal(fetchedResponse.status, 200);
  assert.equal(persisted.status, 200);
  assert.equal(persisted.content_digest, sha256("final"));
  assert.equal(observer.pending.size, 0);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "only terminal response is logged");
  await cache.release(url);
});

test("receipt callback precedes cache publication across races and leaves safe orphans on failure", async (t) => {
  const cacheDir = path.join(temporary(t), "cache");
  const policy = contract();
  ensureSourceEpoch(cacheDir, policy);
  const url = "https://example.test/dem/N45/E006";
  const persist = ({ status, body }) => observationForRequest({
    cacheDir, url, fetched: { status, body, hit: false },
    networkObservation: { etag: "immutable", observed_at: "2026-09-01T00:00:00.000Z" },
  });
  const first = new BoundedGranuleCache({ dir: cacheDir, maxBytes: 1024 * 1024, owner: "first" });
  await assert.rejects(first.fetch(url, {
    fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => Buffer.from("bytes") }),
    beforePublish: (value) => { persist(value); throw new Error("crash after receipt"); },
  }), /crash after receipt/);
  assert.equal(await first.get(url), null, "receipt-first orphan must not make a current cache entry visible");
  await first.release(url);

  const a = new BoundedGranuleCache({ dir: cacheDir, maxBytes: 1024 * 1024, owner: "a" });
  const b = new BoundedGranuleCache({ dir: cacheDir, maxBytes: 1024 * 1024, owner: "b" });
  let publishes = 0;
  const options = {
    fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => Buffer.from("bytes") }),
    beforePublish: (value) => { publishes += 1; persist(value); },
    beforeUse: (value) => validateCachedSource({ cacheDir, url, ...value }),
  };
  const [left, right] = await Promise.all([a.fetch(url, options), b.fetch(url, options)]);
  assert.equal(publishes, 1, "only the producer may persist/publish one generation");
  assert.equal(left.body.toString(), "bytes");
  assert.equal(right.body.toString(), "bytes");
  assert.equal(validateCachedSource({ cacheDir, url, status: 200, body: left.body }).etag, "immutable");
  await Promise.all([a.release(url), b.release(url)]);
});

test("cell journal recovers exactly after each durable artifact boundary", async (t) => {
  const root = temporary(t);
  const makeOperations = (dir) => [
    { name: "tiles", target: path.join(dir, "tiles.dttstream"), bytes: Buffer.from("tile-frame") },
    { name: "index", target: path.join(dir, "tiles.index.jsonl"), bytes: Buffer.from('{"level":8}\n') },
    { name: "ocean", target: path.join(dir, "ocean-skipped.lines"), bytes: Buffer.from("8/1/2\n") },
    { name: "mark", target: path.join(dir, "irm.records"), bytes: Buffer.from("mark-frame") },
  ];
  const artifactSnapshot = (dir) => Object.fromEntries([
    "tiles.dttstream", "tiles.index.jsonl", "ocean-skipped.lines", "irm.records", "resume-mark.json",
  ].map((name) => [name, fs.readFileSync(path.join(dir, name))]));
  const clean = path.join(root, "clean");
  fs.mkdirSync(clean);
  commitCellAttempt({
    outDir: clean, cell: 7, operations: makeOperations(clean), markJson: { cell: 7 },
  });
  const expected = artifactSnapshot(clean);

  for (const faultPhase of ["after-tiles", "after-ocean", "after-mark"]) {
    const resumed = path.join(root, faultPhase);
    fs.mkdirSync(resumed);
    assert.throws(() => commitCellAttempt({
      outDir: resumed, cell: 7, operations: makeOperations(resumed), markJson: { cell: 7 }, faultPhase,
    }), new RegExp(`fault injection ${faultPhase}`));
    assert.equal(fs.existsSync(path.join(resumed, "cell-attempt.json")), true, `${faultPhase} retains a durable attempt`);
    assert.equal(recoverCellAttempt({ outDir: resumed }), true, `${faultPhase} recovery completes the exact attempt`);
    assert.equal(recoverCellAttempt({ outDir: resumed }), false, `${faultPhase} recovery is idempotent and cannot append twice`);
    assert.deepEqual(artifactSnapshot(resumed), expected, `${faultPhase} resume equals a clean cell and has no duplicate merge input`);
    assert.equal(fs.existsSync(path.join(resumed, "cell-attempt.json")), false);
  }

  // This is a separate process rather than an in-process caught exception:
  // the child dies after persisting a strict prefix of the staged tile append.
  // Startup recovery must recognize that prefix and finish it once.
  const midAppend = path.join(root, "mid-tiles-child-crash");
  fs.mkdirSync(midAppend);
  const child = path.join(root, "mid-tiles-child.mjs");
  fs.writeFileSync(child, `
    import path from "node:path";
    import { commitCellAttempt } from ${JSON.stringify(PROVENANCE_URL)};
    const out = process.argv[2];
    commitCellAttempt({ outDir: out, cell: 7, markJson: { cell: 7 }, faultPhase: "mid-tiles", operations: [
      { name: "tiles", target: path.join(out, "tiles.dttstream"), bytes: Buffer.from("tile-frame") },
      { name: "index", target: path.join(out, "tiles.index.jsonl"), bytes: Buffer.from('{"level":8}\\n') },
      { name: "ocean", target: path.join(out, "ocean-skipped.lines"), bytes: Buffer.from("8/1/2\\n") },
      { name: "mark", target: path.join(out, "irm.records"), bytes: Buffer.from("mark-frame") },
    ] });
  `);
  await assert.rejects(execFileAsync(process.execPath, [child, midAppend]), /fault injection mid-tiles/);
  const partialBytes = fs.statSync(path.join(midAppend, "tiles.dttstream")).size;
  assert.ok(partialBytes > 0 && partialBytes < expected["tiles.dttstream"].length, "child left an actual partial tile append");
  assert.equal(recoverCellAttempt({ outDir: midAppend }), true);
  assert.deepEqual(artifactSnapshot(midAppend), expected, "child-crash recovery finishes the exact staged suffix once");
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
    url: "https://example.test/dem/N45/E006",
    fetched: fetched("bytes"),
    networkObservation: { etag: "immutable", observed_at: "2026-09-01T00:00:00.000Z" },
  });
  const logs = [];
  for (let index = 0; index < 65; index += 1) {
    const log = path.join(root, `shard-${index}.ndjson`);
    appendRequestObservation(log, source, {
      requestedAt: `2026-09-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
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

test("completion manifest refuses foreign URLs and malformed source keys from a shard log", async (t) => {
  const root = temporary(t);
  const log = path.join(root, "bad.ndjson");
  const policy = contract();
  fs.writeFileSync(log, `${JSON.stringify({
    source_key: `sha256:${"0".repeat(64)}`,
    url: "https://foreign.example/DEM.tif", status: 200, content_length: 0,
    content_digest: sha256(""), observed_at: "2026-09-01T00:00:00.000Z",
    requested_at: "2026-09-01T00:00:00.000Z", cache_hit: false,
  })}\n`);
  await assert.rejects(
    emitCompletionSourceManifest({ outDir: root, logFiles: [log], contract: policy, configDigest: "a".repeat(64) }),
    /source observation key must equal SHA-256\(url\)/,
  );
});

test("incomplete source-policy coordinator cannot emit a completion manifest", async (t) => {
  const root = temporary(t);
  const config = path.join(root, "run.json");
  const policy = contract();
  fs.writeFileSync(config, JSON.stringify({
    cache_max_bytes: policy.cacheMaxBytes,
    source_policy: policy.policy,
    flow_config: { dataset_epoch: policy.datasetEpoch, regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }] },
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
    flow_config: { dataset_epoch: policy.datasetEpoch, regions: [{ name: "test", west: 0, south: 0, east: 2, north: 1 }] },
  }));
  fs.writeFileSync(runner, `
    import fs from "node:fs";
    import path from "node:path";
    import { appendRequestObservation, observationForRequest, sourcePolicyContract } from ${JSON.stringify(PROVENANCE_URL)};
    const value = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--config") + 1], "utf8"));
    const out = process.argv[process.argv.indexOf("--out") + 1];
    const contract = sourcePolicyContract(value);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "tiles.dttstream"), "");
    const url = "https://example.test/dem/N45/E006";
    const observation = observationForRequest({ cacheDir: value.cache_dir, url,
      fetched: { status: 200, hit: false, body: Buffer.alloc(0) },
      networkObservation: { observed_at: "2026-09-01T00:00:00.000Z" },
    });
    appendRequestObservation(path.join(out, contract.policy.manifest.shard_log), observation,
      { requestedAt: "2026-09-01T00:00:00.000Z", cacheHit: false });
    fs.writeFileSync(path.join(out, "run-report.json"), JSON.stringify({
      drained: true, errors: [], sourceProvenance: {
        sourcePolicyDigest: contract.digest, datasetEpoch: contract.datasetEpoch,
        globalConfigDigest: value.global_config_digest,
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

test("coordinator rejects a source shard with a mismatched immutable global config digest", async (t) => {
  const root = temporary(t);
  const policy = contract();
  const config = path.join(root, "run.json");
  const runner = path.join(root, "mismatch-runner.mjs");
  fs.writeFileSync(config, JSON.stringify({
    cache_max_bytes: policy.cacheMaxBytes, source_policy: policy.policy,
    flow_config: { dataset_epoch: policy.datasetEpoch, regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }] },
  }));
  fs.writeFileSync(runner, `
    import fs from "node:fs"; import path from "node:path";
    import { canonicalJson, sha256, sourcePolicyContract } from ${JSON.stringify(PROVENANCE_URL)};
    const value = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--config") + 1], "utf8"));
    const out = process.argv[process.argv.indexOf("--out") + 1]; const contract = sourcePolicyContract(value);
    fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "tiles.dttstream"), "");
    const url = "https://example.test/dem/N45/E006";
    fs.writeFileSync(path.join(out, contract.policy.manifest.shard_log), canonicalJson({ source_key: "sha256:" + sha256(url), url, status: 200, content_length: 0, content_digest: sha256(""), observed_at: "2026-09-01T00:00:00.000Z", requested_at: "2026-09-01T00:00:00.000Z", cache_hit: false }) + "\\n");
    fs.writeFileSync(path.join(out, "run-report.json"), JSON.stringify({ drained: true, errors: [], sourceProvenance: { sourcePolicyDigest: contract.digest, datasetEpoch: contract.datasetEpoch, globalConfigDigest: "0".repeat(64) } }));
  `);
  await assert.rejects(
    execFileAsync(process.execPath, [COORDINATOR, "--config", config, "--out", path.join(root, "out"), "--runner", runner]),
    /matching immutable global config digest/,
  );
});

test("coordinator refuses a custom source shard whose request log is outside policy", async (t) => {
  const root = temporary(t);
  const policy = contract();
  const config = path.join(root, "run.json");
  const runner = path.join(root, "foreign-log-runner.mjs");
  fs.writeFileSync(config, JSON.stringify({
    cache_max_bytes: policy.cacheMaxBytes, source_policy: policy.policy,
    flow_config: { dataset_epoch: policy.datasetEpoch, regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }] },
  }));
  fs.writeFileSync(runner, `
    import fs from "node:fs"; import path from "node:path";
    import { canonicalJson, sha256, sourcePolicyContract } from ${JSON.stringify(PROVENANCE_URL)};
    const value = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--config") + 1], "utf8"));
    const out = process.argv[process.argv.indexOf("--out") + 1]; const contract = sourcePolicyContract(value);
    fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "tiles.dttstream"), "");
    const url = "https://foreign.example/DEM.tif";
    fs.writeFileSync(path.join(out, contract.policy.manifest.shard_log), canonicalJson({ source_key: "sha256:" + sha256(url), url, status: 200, content_length: 0, content_digest: sha256(""), observed_at: "2026-09-01T00:00:00.000Z", requested_at: "2026-09-01T00:00:00.000Z", cache_hit: false }) + "\\n");
    fs.writeFileSync(path.join(out, "run-report.json"), JSON.stringify({ drained: true, errors: [], sourceProvenance: { sourcePolicyDigest: contract.digest, datasetEpoch: contract.datasetEpoch, globalConfigDigest: value.global_config_digest } }));
  `);
  await assert.rejects(
    execFileAsync(process.execPath, [COORDINATOR, "--config", config, "--out", path.join(root, "out"), "--runner", runner]),
    /outside the approved naming policy/,
  );
});

test("coordinator carries the exact publication policy and config digest through shard and merge receipts", async (t) => {
  const root = temporary(t);
  const config = path.join(root, "run.json");
  const runner = path.join(root, "publication-runner.mjs");
  const publicationPolicy = {
    version: 1,
    max_verified_store_bytes: 12 * 1024 ** 3,
    max_static_directory_bytes: 128 * 1024 ** 3,
    synthesized_tile_grid_size: 2,
    static_directory_basis: "test static budget",
  };
  fs.writeFileSync(config, JSON.stringify({
    publication_policy: publicationPolicy,
    flow_config: {
      terrain_synth_grid_size: 2,
      regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }],
    },
  }));
  fs.writeFileSync(runner, `
    import fs from "node:fs"; import path from "node:path";
    import { canonicalJson, sha256 } from ${JSON.stringify(PROVENANCE_URL)};
    const value = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--config") + 1], "utf8"));
    const out = process.argv[process.argv.indexOf("--out") + 1]; fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "tiles.dttstream"), "");
    fs.writeFileSync(path.join(out, "ocean-skipped.json"), JSON.stringify({ addresses: [] }));
    fs.writeFileSync(path.join(out, "run-report.json"), JSON.stringify({ drained: true, errors: [], publicationPolicy: {
      policy: value.publication_policy, digest: sha256(canonicalJson(value.publication_policy)), globalConfigDigest: value.global_config_digest,
    } }));
  `);
  const out = path.join(root, "out");
  await execFileAsync(process.execPath, [
    COORDINATOR, "--config", config, "--out", out, "--runner", runner, "--skip-verify",
  ]);
  const shard = JSON.parse(fs.readFileSync(path.join(out, "shards", "shard-000", "run-report.json"), "utf8"));
  const merged = JSON.parse(fs.readFileSync(path.join(out, "global-merge-report.json"), "utf8"));
  assert.deepEqual(shard.publicationPolicy.policy, publicationPolicy);
  assert.equal(shard.publicationPolicy.globalConfigDigest, merged.configDigest);
  assert.deepEqual(merged.publicationPolicy.policy, publicationPolicy);
  assert.equal(merged.publicationPolicy.digest, shard.publicationPolicy.digest);
  assert.equal(merged.publicationPolicy.globalConfigDigest, merged.configDigest);
});

test("global artifact-set rollback leaves no mixed files at every rename boundary", async (t) => {
  for (const boundary of [1, 2, 3]) {
    const root = temporary(t);
    const config = path.join(root, "run.json");
    const runner = path.join(root, "runner.mjs");
    fs.writeFileSync(config, JSON.stringify({
      flow_config: { regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }] },
    }));
    fs.writeFileSync(runner, `
      import fs from "node:fs"; import path from "node:path";
      const out = process.argv[process.argv.indexOf("--out") + 1];
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "tiles.dttstream"), "");
      fs.writeFileSync(path.join(out, "ocean-skipped.json"), JSON.stringify({ addresses: [] }));
      fs.writeFileSync(path.join(out, "run-report.json"), JSON.stringify({ drained: true, errors: [] }));
    `);
    const out = path.join(root, "out");
    await assert.rejects(
      execFileAsync(process.execPath, [
        COORDINATOR, "--config", config, "--out", out, "--runner", runner, "--skip-verify",
        "--fault-merge-rename-after", String(boundary),
      ]),
      new RegExp(`fault injection after ${boundary} global artifact rename`),
    );
    assert.equal(fs.existsSync(path.join(out, "tiles.dttstream")), false, `boundary ${boundary} left tiles behind`);
    assert.equal(fs.existsSync(path.join(out, "ocean-skipped.lines")), false, `boundary ${boundary} left ocean lines behind`);
    assert.equal(fs.existsSync(path.join(out, "ocean-skipped.json")), false, `boundary ${boundary} left ocean receipt behind`);
  }
});

test("global artifact transaction recovers an actual process exit between artifact renames", async (t) => {
  const root = temporary(t);
  const config = path.join(root, "run.json");
  const runner = path.join(root, "runner.mjs");
  fs.writeFileSync(config, JSON.stringify({
    flow_config: { regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }] },
  }));
  fs.writeFileSync(runner, `
    import fs from "node:fs"; import path from "node:path";
    const out = process.argv[process.argv.indexOf("--out") + 1]; fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "tiles.dttstream"), "");
    fs.writeFileSync(path.join(out, "ocean-skipped.json"), JSON.stringify({ addresses: [] }));
    fs.writeFileSync(path.join(out, "run-report.json"), JSON.stringify({ drained: true, errors: [] }));
  `);
  for (const boundary of [1, 2, 3]) {
    const out = path.join(root, `out-${boundary}`);
    await assert.rejects(execFileAsync(process.execPath, [
      COORDINATOR, "--config", config, "--out", out, "--runner", runner, "--skip-verify",
      "--fault-merge-crash-after", String(boundary),
    ]));
    assert.equal(fs.existsSync(path.join(out, "global-artifact-transaction.json")), true);
    await execFileAsync(process.execPath, [COORDINATOR, "--config", config, "--out", out, "--runner", runner, "--skip-verify"]);
    const receipt = JSON.parse(fs.readFileSync(path.join(out, "global-merge-report.json"), "utf8"));
    assert.equal(receipt.completion, "complete");
    assert.equal(fs.existsSync(path.join(out, "global-artifact-transaction.json")), false);
    for (const name of ["tiles.dttstream", "ocean-skipped.lines", "ocean-skipped.json"]) {
      assert.equal(fs.existsSync(path.join(out, name)), true, `boundary ${boundary} recovered artifact set includes ${name}`);
    }
  }
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

test("ocean-skip merge orders canonical addresses by numeric level, then y, then x", async (t) => {
  const root = temporary(t);
  const one = path.join(root, "one.lines");
  const two = path.join(root, "two.lines");
  const output = path.join(root, "merged.lines");
  fs.writeFileSync(one, "10/0/0\n8/1/2\n8/7/1\n");
  fs.writeFileSync(two, "9/0/0\n8/0/2\n");
  await mergeOceanSkips({ inputFiles: [one, two], outputFile: output, maxRunBytes: 1, fanIn: 2 });
  assert.deepEqual(fs.readFileSync(output, "utf8").trim().split("\n"), [
    "8/7/1", "8/0/2", "8/1/2", "9/0/0", "10/0/0",
  ]);
  fs.writeFileSync(one, "08/1/1\n");
  await assert.rejects(
    mergeOceanSkips({ inputFiles: [one], outputFile: path.join(root, "bad.lines") }),
    /invalid canonical ocean-skip address/,
  );
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

test("ocean-skip merge safely collapses duplicate recovery lines inside one shard", async (t) => {
  const root = temporary(t);
  const shard = path.join(root, "shard.lines");
  const output = path.join(root, "merged.lines");
  fs.writeFileSync(shard, "8/1/1\n8/1/1\n8/2/1\n");
  const receipt = await mergeOceanSkips({ inputFiles: [shard], outputFile: output, maxRunBytes: 1, fanIn: 2 });
  assert.equal(receipt.count, 2);
  assert.equal(receipt.duplicateLinesWithinShards, 1);
  assert.deepEqual(fs.readFileSync(output, "utf8").trim().split("\n"), ["8/1/1", "8/2/1"]);
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

test("fixed histogram preserves exact quantiles for a large streamed cell without record retention", () => {
  const histogram = new FixedHistogram(4096);
  for (let index = 0; index < 1_000_000; index += 1) histogram.add(index % 4097);
  assert.equal(histogram.bins.length, 4097);
  assert.equal(histogram.count, 1_000_000);
  assert.equal(histogram.percentile(0.5), 2047);
  assert.equal(histogram.max, 4096);
});

test("cross-check bounds its report before JSON.parse and rejects duplicate samples", async (t) => {
  const root = temporary(t);
  const report = path.join(root, "accuracy-report.json");
  fs.writeFileSync(report, "x".repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(
    execFileAsync(process.execPath, ["--max-old-space-size=32", CROSS_CHECK, "--out", root, "--allow-legacy-regional"]),
    /accuracy report exceeds .* byte bound/,
  );
  fs.writeFileSync(report, JSON.stringify({
    levels: [{ level: 8, tiles: [{ address: "8/1/1" }, { address: "8/1/1" }] }],
  }));
  await assert.rejects(
    execFileAsync(process.execPath, [CROSS_CHECK, "--out", root, "--allow-legacy-regional"]),
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
    execFileAsync(process.execPath, [CROSS_CHECK, "--out", root, "--allow-legacy-regional"]),
    /names tile\(s\) missing from tiles\.dttstream: 8\/1\/1/,
  );
});
