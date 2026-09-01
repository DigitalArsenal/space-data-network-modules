import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  BoundedTopK,
  cellAttemptAppendBound,
  commitCellAttempt,
  FixedHistogram,
  recoverCellAttempt,
  SourceRequestObserver,
  appendRequestObservation,
  canonicalJson,
  emitCompletionSourceManifest,
  ensureSourceEpoch,
  mergeBoundedFramedStores,
  mergeOceanSkips,
  MAX_CELL_ATTEMPT_APPEND_BYTES,
  observationForRequest,
  publicationPolicyContract,
  sha256,
  sourcePolicyAllowsUrl,
  sourcePolicyContract,
  sourceObservationLine,
  validateCachedSource,
} from "../source-provenance.mjs";
import { BoundedGranuleCache } from "../build-support.mjs";
import { iterateStreamFile } from "../dtt-reader.mjs";
import { recoverPlannedCellAttempt } from "../run.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const COORDINATOR = path.join(HERE, "..", "global-build.mjs");
const CROSS_CHECK = path.join(HERE, "..", "cross-check-accuracy.mjs");
const PROVENANCE_URL = new URL("../source-provenance.mjs", import.meta.url).href;
const LIGURIA_OCEAN_RECEIPT = path.join(HERE, "..", "evidence", "liguria-z11", "ocean-skipped.json");

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-provenance-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sourcePolicyConfig({ epoch = "2023-04-01T00:00:00.000Z", manifest = "source-manifest.ndjson" } = {}) {
  return {
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
  };
}

function contract(options = {}) {
  return sourcePolicyContract(sourcePolicyConfig(options));
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

function sortStageEntries(root) {
  return fs.readdirSync(root).filter((name) => name.includes("-sort-stage-"));
}

function sortLeasePath(outputFile, kind) {
  return path.join(path.dirname(outputFile), `.${path.basename(outputFile)}.${kind}-sort-lease.json`);
}

function assertSortResidue(root, { stages, leases }) {
  const entries = fs.readdirSync(root).filter((name) => name.includes("-sort-stage-") || name.includes("-sort-lease"));
  const stageEntries = entries.filter((name) => name.includes("-sort-stage-"));
  const leaseEntries = entries.filter((name) => name.endsWith("-sort-lease.json"));
  assert.equal(stageEntries.length, stages, "exact tokenized stage residue count");
  assert.equal(leaseEntries.length, leases, "exact fixed lease residue count");
}

function prepareSortCase(root, kind) {
  if (kind === "source") {
    const log = path.join(root, "source-observations.ndjson");
    const observation = {
      source_key: `sha256:${sha256("https://example.test/dem/N45/E006")}`,
      url: "https://example.test/dem/N45/E006",
      status: 200,
      content_length: 5,
      content_digest: sha256("bytes"),
      observed_at: "2026-09-01T00:00:00.000Z",
    };
    fs.writeFileSync(log, sourceObservationLine(observation, {
      requestedAt: "2026-09-01T00:00:00.000Z", cacheHit: false,
    }));
    return { kind, root, output: path.join(root, "source-manifest.ndjson"), log, policy: contract() };
  }
  if (kind === "terrain") {
    const input = path.join(root, "input.dttstream");
    fs.writeFileSync(input, framed([Buffer.from("8/1/1|sort-stage-record")]));
    return { kind, root, input, output: path.join(root, "merged.dttstream") };
  }
  const input = path.join(root, "input.lines");
  fs.writeFileSync(input, "8/1/1\n");
  return { kind, root, input, output: path.join(root, "ocean-skipped.lines") };
}

async function runSortCase(sortCase, options = {}) {
  const common = { sortRunBytes: 1024, maxRunBytes: 1024, fanIn: 2, ...options };
  if (sortCase.kind === "source") {
    return emitCompletionSourceManifest({
      outDir: sortCase.root, outputFile: sortCase.output, logFiles: [sortCase.log],
      contract: sortCase.policy, configDigest: "a".repeat(64),
      sortRunBytes: common.sortRunBytes, fanIn: common.fanIn,
      sortFaultPhase: common.sortFaultPhase,
      sortHoldMs: common.sortHoldMs,
    });
  }
  if (sortCase.kind === "terrain") {
    return mergeBoundedFramedStores({
      inputFiles: [sortCase.input], outputFile: sortCase.output,
      addressForRecord: (record) => record.toString("utf8").split("|", 1)[0],
      maxRunBytes: common.maxRunBytes, fanIn: common.fanIn,
      sortFaultPhase: common.sortFaultPhase,
      sortHoldMs: common.sortHoldMs,
    });
  }
  return mergeOceanSkips({
    inputFiles: [sortCase.input], outputFile: sortCase.output,
    maxRunBytes: common.maxRunBytes, fanIn: common.fanIn,
    sortFaultPhase: common.sortFaultPhase,
    sortHoldMs: common.sortHoldMs,
  });
}

function writeSortCrashChild(root) {
  const child = path.join(root, "sort-crash-child.mjs");
  fs.writeFileSync(child, `
    import path from "node:path";
    import { emitCompletionSourceManifest, mergeBoundedFramedStores, mergeOceanSkips, sourcePolicyContract } from ${JSON.stringify(PROVENANCE_URL)};
    const [kind, root, faultPhase, holdMs = "0"] = process.argv.slice(2);
    const options = { sortFaultPhase: faultPhase, sortHoldMs: Number(holdMs), fanIn: 2 };
    if (kind === "source") {
      const config = ${JSON.stringify(sourcePolicyConfig())};
      await emitCompletionSourceManifest({ outDir: root, outputFile: path.join(root, "source-manifest.ndjson"), logFiles: [path.join(root, "source-observations.ndjson")], contract: sourcePolicyContract(config), configDigest: "${"a".repeat(64)}", sortRunBytes: 1024, ...options });
    } else if (kind === "terrain") {
      await mergeBoundedFramedStores({ inputFiles: [path.join(root, "input.dttstream")], outputFile: path.join(root, "merged.dttstream"), addressForRecord: (record) => record.toString("utf8").split("|", 1)[0], maxRunBytes: 1024, ...options });
    } else {
      await mergeOceanSkips({ inputFiles: [path.join(root, "input.lines")], outputFile: path.join(root, "ocean-skipped.lines"), maxRunBytes: 1024, ...options });
    }
  `);
  return child;
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

test("new source epoch fsyncs its exact receipt and both cache directory entries before return", async (t) => {
  const root = temporary(t);
  const child = path.join(root, "epoch-durability-child.mjs");
  fs.writeFileSync(child, `
    import fs from "node:fs";
    import { ensureSourceEpoch, sourcePolicyContract } from ${JSON.stringify(PROVENANCE_URL)};
    const original = fs.fsyncSync;
    const calls = [];
    fs.fsyncSync = (fd) => { const stat = fs.fstatSync(fd); calls.push(stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other"); return original(fd); };
    const epoch = "2023-04-01T00:00:00.000Z";
    const contract = sourcePolicyContract({ cache_max_bytes: 96 * 1024 ** 3, flow_config: { dataset_epoch: epoch }, source_policy: {
      version: 1, provider: "test", dataset_epoch: epoch,
      url_policy: { base_url: "https://example.test/", dem_template: "dem/{NS}{LAT2}/{EW}{LON3}", water_template: "water/{NS}{LAT2}/{EW}{LON3}" },
      request: { timeout_ms: 1, retries: 0, retry_base_ms: 1, max_outstanding: 1, max_response_bytes: 1 },
      no_data: { http_404: "record-no-coverage-never-retry", non_water: "fail" }, ocean_policy: "test", cache: { max_bytes: 96 * 1024 ** 3 },
      manifest: { format: "canonical-jsonl-v1", digest: "sha256", shard_log: "source-observations.ndjson", completion_manifest: "source-manifest.ndjson" },
    }});
    ensureSourceEpoch(process.argv[2], contract);
    process.stdout.write(JSON.stringify(calls));
  `);
  const { stdout } = await execFileAsync(process.execPath, [child, path.join(root, "cache")]);
  const calls = JSON.parse(stdout);
  assert.ok(calls.filter((kind) => kind === "file").length >= 2,
    "creator fsyncs the written receipt and the same stable receipt read");
  assert.ok(calls.filter((kind) => kind === "directory").length >= 2,
    "creator fsyncs the receipt/cache directory and its parent before returning");
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

test("global Copernicus WBM policy admits only the planner's DEM AUXFILES form", () => {
  const config = JSON.parse(fs.readFileSync(path.join(HERE, "..", "regions", "global-z10.json"), "utf8"));
  const policy = sourcePolicyContract(config);
  const base = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/";
  const plannerWater = "Copernicus_DSM_COG_10_N89_00_E179_00_DEM/AUXFILES/" +
    "Copernicus_DSM_COG_10_N89_00_E179_00_WBM.tif";
  assert.equal(policy.policy.url_policy.water_template,
    "Copernicus_DSM_COG_10_{NS}{LAT2}_00_{EW}{LON3}_00_DEM/AUXFILES/" +
    "Copernicus_DSM_COG_10_{NS}{LAT2}_00_{EW}{LON3}_00_WBM.tif");
  assert.equal(sourcePolicyAllowsUrl(policy, `${base}${plannerWater}`), true,
    "the checked policy accepts the exact planner-produced WBM URL");
  assert.equal(sourcePolicyAllowsUrl(policy,
    `${base}Copernicus_DSM_COG_10_N89_00_E179_00_WBM/Copernicus_DSM_COG_10_N89_00_E179_00_WBM.tif`), false,
  "the obsolete nonexistent WBM directory form is not admissible");
  assert.equal(sourcePolicyAllowsUrl(policy,
    `${base}Copernicus_DSM_COG_10_N89_00_E179_00_DEM/AUXFILES/Copernicus_DSM_COG_10_N88_00_E179_00_WBM.tif`), false,
  "the WBM filename must repeat the planned latitude exactly");
  assert.equal(sourcePolicyAllowsUrl(policy,
    `${base}Copernicus_DSM_COG_10_N89_00_E179_00_DEM/AUXFILES/Copernicus_DSM_COG_10_N89_00_E178_00_WBM.tif`), false,
  "the WBM filename must repeat the planned longitude exactly");
});

test("global Copernicus DTT retrieved_at is derived from non-empty observed source evidence", () => {
  const config = JSON.parse(fs.readFileSync(path.join(HERE, "..", "regions", "global-z10.json"), "utf8"));
  assert.equal(Object.hasOwn(config.flow_config, "retrieved_at"), false,
    "checked source policy must not fabricate a fixed retrieval time");
  const runner = fs.readFileSync(path.join(HERE, "..", "run.mjs"), "utf8");
  assert.match(runner, /activeRetrievedAt = observations\.reduce\([\s\S]*observation\.observed_at/,
    "DTT lineage derives its retrieval time from immutable request observations");
  assert.match(runner, /assert\.ok\(activeRetrievedAt, "source-backed cell has no observed_at evidence for retrieved_at lineage"\)/,
    "a source-backed DTT cell rejects an empty derived retrieval lineage");
  assert.match(runner, /retrieved_at: activeRetrievedAt \?\? sourceRunStartedAt/,
    "the per-cell flow receives the evidence-derived timestamp");
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

test("receipt evidence rejects a symlink rather than following a foreign inode", (t) => {
  const root = temporary(t);
  const cache = path.join(root, "cache");
  const url = "https://example.test/dem/N45/E006";
  const body = Buffer.from("bytes");
  const observation = {
    source_key: `sha256:${sha256(url)}`, url, status: 200, content_length: body.length,
    content_digest: sha256(body), observed_at: "2026-09-01T00:00:00.000Z",
  };
  const receiptDir = path.join(cache, "source-observations");
  fs.mkdirSync(receiptDir, { recursive: true });
  const foreign = path.join(root, "foreign-receipt.json");
  fs.writeFileSync(foreign, `${JSON.stringify(observation)}\n`);
  fs.symlinkSync(foreign, path.join(receiptDir, `${sha256(url)}.json`));
  assert.throws(() => observationForRequest({
    cacheDir: cache, url, fetched: { status: 200, hit: false, body },
    networkObservation: { observed_at: observation.observed_at },
  }), /ELOOP|too many symbolic links/);
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
    { name: "source-observations", target: path.join(dir, "source-observations.ndjson"), bytes: Buffer.from("{\"source\":true}\n") },
    { name: "mark", target: path.join(dir, "irm.records"), bytes: Buffer.from("mark-frame") },
  ];
  const artifactSnapshot = (dir) => Object.fromEntries([
    "tiles.dttstream", "tiles.index.jsonl", "ocean-skipped.lines", "source-observations.ndjson", "irm.records", "resume-mark.json",
  ].map((name) => [name, fs.readFileSync(path.join(dir, name))]));
  const clean = path.join(root, "clean");
  fs.mkdirSync(clean);
  commitCellAttempt({
    outDir: clean, cell: 7, operations: makeOperations(clean), markJson: { cell: 7 },
  });
  const expected = artifactSnapshot(clean);

  for (const faultPhase of ["after-tiles", "after-index", "after-ocean", "after-source-observations", "after-mark", "after-chain"]) {
    const resumed = path.join(root, faultPhase);
    fs.mkdirSync(resumed);
    assert.throws(() => commitCellAttempt({
      outDir: resumed, cell: 7, operations: makeOperations(resumed), markJson: { cell: 7 }, faultPhase,
    }), faultPhase === "after-chain" ? /fault injection after artifact chain/ : new RegExp(`fault injection ${faultPhase}`));
    assert.equal(fs.existsSync(path.join(resumed, "cell-attempt.json")), true, `${faultPhase} retains a durable attempt`);
    const recovery = { outDir: resumed, maxAppendBytes: cellAttemptAppendBound(1), expectedCell: 7 };
    assert.equal(recoverCellAttempt(recovery), true, `${faultPhase} recovery completes the exact attempt`);
    assert.equal(recoverCellAttempt(recovery), false, `${faultPhase} recovery is idempotent and cannot append twice`);
    assert.deepEqual(artifactSnapshot(resumed), expected, `${faultPhase} resume equals a clean cell and has no duplicate merge input`);
    assert.equal(fs.existsSync(path.join(resumed, "cell-attempt.json")), false);
  }

  for (const name of ["tiles", "index", "ocean", "source-observations", "mark"]) {
    const resumed = path.join(root, `mid-${name}`);
    fs.mkdirSync(resumed);
    assert.throws(() => commitCellAttempt({
      outDir: resumed, cell: 7, operations: makeOperations(resumed), markJson: { cell: 7 }, faultPhase: `mid-${name}`,
    }), new RegExp(`fault injection mid-${name}`));
    assert.equal(recoverCellAttempt({ outDir: resumed, maxAppendBytes: cellAttemptAppendBound(1), expectedCell: 7 }), true, `mid-${name} recovery completes the exact staged suffix`);
    assert.deepEqual(artifactSnapshot(resumed), expected, `mid-${name} recovery neither loses nor duplicates a cell artifact`);
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
      { name: "source-observations", target: path.join(out, "source-observations.ndjson"), bytes: Buffer.from("{\\\"source\\\":true}\\n") },
      { name: "mark", target: path.join(out, "irm.records"), bytes: Buffer.from("mark-frame") },
    ] });
  `);
  await assert.rejects(execFileAsync(process.execPath, [child, midAppend]), /fault injection mid-tiles/);
  const partialBytes = fs.statSync(path.join(midAppend, "tiles.dttstream")).size;
  assert.ok(partialBytes > 0 && partialBytes < expected["tiles.dttstream"].length, "child left an actual partial tile append");
  assert.equal(recoverCellAttempt({ outDir: midAppend, maxAppendBytes: cellAttemptAppendBound(1), expectedCell: 7 }), true);
  assert.deepEqual(artifactSnapshot(midAppend), expected, "child-crash recovery finishes the exact staged suffix once");

  // The chain receipt is written after every append but before the readable
  // mark. A real process exit in that narrow window must accept the already
  // advanced chain receipt and finish only the final mark/cleanup.
  const afterChain = path.join(root, "after-chain-child-crash");
  fs.mkdirSync(afterChain);
  const chainChild = path.join(root, "after-chain-child.mjs");
  fs.writeFileSync(chainChild, `
    import path from "node:path";
    import { commitCellAttempt } from ${JSON.stringify(PROVENANCE_URL)};
    const out = process.argv[2];
    commitCellAttempt({ outDir: out, cell: 7, markJson: { cell: 7 }, faultPhase: "after-chain", operations: [
      { name: "tiles", target: path.join(out, "tiles.dttstream"), bytes: Buffer.from("tile-frame") },
      { name: "index", target: path.join(out, "tiles.index.jsonl"), bytes: Buffer.from('{"level":8}\\n') },
      { name: "ocean", target: path.join(out, "ocean-skipped.lines"), bytes: Buffer.from("8/1/2\\n") },
      { name: "source-observations", target: path.join(out, "source-observations.ndjson"), bytes: Buffer.from("{\\\"source\\\":true}\\n") },
      { name: "mark", target: path.join(out, "irm.records"), bytes: Buffer.from("mark-frame") },
    ] });
  `);
  await assert.rejects(execFileAsync(process.execPath, [chainChild, afterChain]), /fault injection after artifact chain/);
  assert.equal(recoverCellAttempt({ outDir: afterChain, maxAppendBytes: cellAttemptAppendBound(1), expectedCell: 7 }), true);
  assert.deepEqual(artifactSnapshot(afterChain), expected, "post-chain child crash preserves exact cell artifacts once");

  // The most subtle terminal window is after the readable sidecar is durable,
  // but before the journal/stage cleanup. The next real planner invocation
  // correctly names cell 8, not the journal's completed cell 7. SIGKILL here
  // proves terminal validation cleans only an exact sidecar+chain+artifact
  // match rather than rejecting it as a wrong live cell or replaying it.
  const afterResumeMark = path.join(root, "after-resume-mark-child-crash");
  fs.mkdirSync(afterResumeMark);
  const markChild = path.join(root, "after-resume-mark-child.mjs");
  fs.writeFileSync(markChild, `
    import path from "node:path";
    import { commitCellAttempt } from ${JSON.stringify(PROVENANCE_URL)};
    const out = process.argv[2];
    commitCellAttempt({ outDir: out, cell: 7, markJson: { cell: 7 }, faultPhase: "crash-after-resume-mark", operations: [
      { name: "tiles", target: path.join(out, "tiles.dttstream"), bytes: Buffer.from("tile-frame") },
      { name: "index", target: path.join(out, "tiles.index.jsonl"), bytes: Buffer.from('{"level":8}\\n') },
      { name: "ocean", target: path.join(out, "ocean-skipped.lines"), bytes: Buffer.from("8/1/2\\n") },
      { name: "source-observations", target: path.join(out, "source-observations.ndjson"), bytes: Buffer.from("{\\"source\\":true}\\n") },
      { name: "mark", target: path.join(out, "irm.records"), bytes: Buffer.from("mark-frame") },
    ] });
  `);
  await assert.rejects(execFileAsync(process.execPath, [markChild, afterResumeMark]),
    (error) => error.signal === "SIGKILL");
  assert.equal(fs.existsSync(path.join(afterResumeMark, "resume-mark.json")), true);
  assert.equal(fs.existsSync(path.join(afterResumeMark, "cell-attempt.json")), true);
  assert.equal(recoverCellAttempt({
    outDir: afterResumeMark,
    // This is the live planner's next-cell cap/identity, deliberately unlike
    // the completed journal. Terminal evidence, not journal self-assertion,
    // authorizes its exact cleanup.
    maxAppendBytes: cellAttemptAppendBound(1), expectedCell: 8,
  }), true);
  assert.equal(fs.existsSync(path.join(afterResumeMark, "cell-attempt.json")), false);
  assert.deepEqual(artifactSnapshot(afterResumeMark), expected,
    "terminal cleanup leaves exactly the completed cell before cell 8 starts");
  assert.doesNotThrow(() => commitCellAttempt({
    outDir: afterResumeMark, cell: 8, markJson: { cell: 8 }, maxAppendBytes: cellAttemptAppendBound(1),
    operations: [
      { name: "tiles", target: path.join(afterResumeMark, "tiles.dttstream"), bytes: Buffer.from("next-tile-frame") },
      { name: "mark", target: path.join(afterResumeMark, "irm.records"), bytes: Buffer.from("next-mark-frame") },
    ],
  }), "the actual next planned cell can proceed after terminal cleanup");

  // Drive the same planner/recovery handshake that run.mjs uses. The planner
  // sees the durable pre-attempt sidecar (cell 7) and therefore returns its
  // real next job (cell 8); it does not receive or trust journal authority.
  const plannerAfterResumeMark = path.join(root, "after-resume-mark-planner-child-crash");
  fs.mkdirSync(plannerAfterResumeMark);
  await assert.rejects(execFileAsync(process.execPath, [markChild, plannerAfterResumeMark]),
    (error) => error.signal === "SIGKILL");
  let plannedWith;
  const plannedRecovery = await recoverPlannedCellAttempt({
    outDir: plannerAfterResumeMark,
    planCell: async ({ markBytes }) => {
      plannedWith = JSON.parse(markBytes.toString("utf8"));
      return { job: { cell_index: 8, cell_tiles: 1 } };
    },
  });
  assert.deepEqual(plannedWith, { cell: 7 }, "run planner receives the pre-attempt sidecar bytes");
  assert.equal(plannedRecovery.recoveryPlan.job.cell_index, 8,
    "run planner selected the next cell before terminal journal cleanup");
  assert.equal(plannedRecovery.recovered, true);
  assert.equal(fs.existsSync(path.join(plannerAfterResumeMark, "cell-attempt.json")), false,
    "planner-integrated terminal recovery removes the completed prior attempt exactly once");
  assert.doesNotThrow(() => commitCellAttempt({
    outDir: plannerAfterResumeMark, cell: plannedRecovery.recoveryPlan.job.cell_index,
    markJson: { cell: 8 }, maxAppendBytes: cellAttemptAppendBound(plannedRecovery.recoveryPlan.job.cell_tiles),
    operations: [
      { name: "tiles", target: path.join(plannerAfterResumeMark, "tiles.dttstream"), bytes: Buffer.from("planner-next-tile") },
      { name: "mark", target: path.join(plannerAfterResumeMark, "irm.records"), bytes: Buffer.from("planner-next-mark") },
    ],
  }), "actual planner-selected next cell proceeds after its terminal predecessor cleanup");
});

test("planner-derived cell append bounds preserve Liguria-scale cells and reject a smaller live recovery bound", (t) => {
  const regional = JSON.parse(fs.readFileSync(path.join(HERE, "..", "evidence", "liguria-z11", "run-report.json"), "utf8"));
  const largest = regional.cellsDetail.reduce((best, cell) =>
    cell.tilesStored > best.tilesStored ? cell : best, regional.cellsDetail[0]);
  const measuredCellBytes = Math.ceil(largest.tilesStored * (regional.storeBytes / regional.tiles));
  assert.equal(largest.tilesStored, 1693);
  assert.ok(measuredCellBytes > 2 * 1024 * 1024, "checked Liguria evidence exceeds the rejected 2 MiB cap");
  assert.equal(cellAttemptAppendBound(largest.tilesInCell), MAX_CELL_ATTEMPT_APPEND_BYTES,
    "large approved cells use the reviewed 32 MiB ceiling, not a generic tiny cap");

  const root = temporary(t);
  const out = path.join(root, "out");
  fs.mkdirSync(out);
  const threeMiB = Buffer.alloc(3 * 1024 * 1024, 0x61);
  const maxAppendBytes = cellAttemptAppendBound(4);
  assert.ok(maxAppendBytes > threeMiB.length && maxAppendBytes <= MAX_CELL_ATTEMPT_APPEND_BYTES);
  assert.throws(() => commitCellAttempt({
    outDir: out, cell: 7, markJson: { cell: 7 }, maxAppendBytes, faultPhase: "after-tiles",
    operations: [
      { name: "tiles", target: path.join(out, "tiles.dttstream"), bytes: threeMiB },
      { name: "mark", target: path.join(out, "irm.records"), bytes: Buffer.from("mark-frame") },
    ],
  }), /fault injection after-tiles/);
  assert.throws(() => recoverCellAttempt({ outDir: out, maxAppendBytes: cellAttemptAppendBound(2), expectedCell: 7 }),
    /live staged append bound/);
  assert.throws(() => recoverCellAttempt({ outDir: out, maxAppendBytes, expectedCell: 8 }),
    /does not match the current live planner cell/);
  assert.equal(recoverCellAttempt({ outDir: out, maxAppendBytes, expectedCell: 7 }), true);
  assert.equal(fs.statSync(path.join(out, "tiles.dttstream")).size, threeMiB.length,
    "a >2 MiB staged tile stream commits exactly once under the live plan bound");
});

test("forged cell journal paths and chain targets cannot redirect recovery outside its run", (t) => {
  const root = temporary(t);
  const out = path.join(root, "out");
  const sentinel = path.join(root, "outside-sentinel");
  fs.mkdirSync(out);
  fs.writeFileSync(sentinel, "must remain outside\n");
  const operations = [
    { name: "tiles", target: path.join(out, "tiles.dttstream"), bytes: Buffer.from("tile-frame") },
    { name: "mark", target: path.join(out, "irm.records"), bytes: Buffer.from("mark-frame") },
  ];
  assert.throws(() => commitCellAttempt({ outDir: out, cell: 7, operations, markJson: { cell: 7 }, faultPhase: "after-tiles" }),
    /fault injection after-tiles/);
  const journalPath = path.join(out, "cell-attempt.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  // These are the former authority-bearing fields. v2 derives all of them
  // from this outDir/cell/approved artifact mapping and rejects their return.
  journal.stageDir = path.dirname(sentinel);
  journal.markPath = sentinel;
  journal.chainFile = sentinel;
  journal.operations[0].target = sentinel;
  journal.operations[0].stage = sentinel;
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(() => recoverCellAttempt({ outDir: out }), /unexpected authority-bearing fields/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "must remain outside\n");

  const rejected = path.join(root, "rejected");
  fs.mkdirSync(rejected);
  assert.throws(() => commitCellAttempt({ outDir: rejected, cell: 7, operations: operations.map((operation) => ({
    ...operation, target: path.join(rejected, path.basename(operation.target)),
  })), markJson: { cell: 7 }, faultPhase: "after-tiles" }), /fault injection after-tiles/);
  const forged = JSON.parse(fs.readFileSync(path.join(rejected, "cell-attempt.json"), "utf8"));
  forged.chains = { [sentinel]: { length: 1, digest: "0".repeat(64) } };
  fs.writeFileSync(path.join(rejected, "cell-attempt.json"), JSON.stringify(forged));
  assert.throws(() => recoverCellAttempt({ outDir: rejected }), /chains must name exactly/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "must remain outside\n");
});

test("source observation lines are bounded canonical cell-journal payloads", () => {
  const line = sourceObservationLine({
    source_key: `sha256:${"a".repeat(64)}`,
    url: "https://example.test/dem/N45/E006", status: 404,
    content_length: 0, content_digest: sha256(""), observed_at: "2026-09-01T00:00:00.000Z",
  }, { requestedAt: "2026-09-01T00:00:00.000Z", cacheHit: false });
  assert.ok(Buffer.isBuffer(line));
  assert.ok(line.length < 16 * 1024);
  assert.equal(line.toString("utf8").endsWith("\n"), true);
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

test("owned external-sort stages recover exact creator/recovery crash windows without leaking or racing", async (t) => {
  const root = temporary(t);
  const child = writeSortCrashChild(root);
  const kinds = [
    ["source", "source-manifest"],
    ["terrain", "terrain-merge"],
    ["ocean", "ocean-skip"],
  ];
  const creatorKills = [
    "crash-after-sort-stage-mkdir",
    "crash-mid-sort-stage-owner",
    "crash-after-sort-stage-owner",
  ];

  for (const [kind] of kinds) {
    const caseRoot = path.join(root, `${kind}-creator-kills`);
    fs.mkdirSync(caseRoot);
    const sortCase = prepareSortCase(caseRoot, kind);
    if (kind === "source") await runSortCase(sortCase);
    else fs.writeFileSync(sortCase.output, `prior-${kind}-output`);
    for (const phase of creatorKills) {
      const prior = fs.readFileSync(sortCase.output);
      await assert.rejects(execFileAsync(process.execPath, [child, kind, caseRoot, phase]),
        (error) => error.signal === "SIGKILL");
      assert.equal(sortStageEntries(caseRoot).length, 1,
        `${kind} has exactly one tokenized owned stage after ${phase}`);
      assertSortResidue(caseRoot, { stages: 1, leases: 1 });
      assert.deepEqual(fs.readFileSync(sortCase.output), prior,
        `${kind} preserves the pre-existing output until the staged result is installed`);
      await runSortCase(sortCase);
      assert.deepEqual(sortStageEntries(caseRoot), [], `${kind} reclaims its dead creator stage exactly once`);
      assertSortResidue(caseRoot, { stages: 0, leases: 0 });
      assert.ok(fs.statSync(sortCase.output).isFile());
    }
  }

  // Fixed lease creation is atomic self-contained symlink metadata. A kill
  // immediately afterward leaves no stage and one recoverable lease; there
  // is no candidate file whose JSON could be torn or mis-reaped.
  for (const [kind] of kinds) {
    const caseRoot = path.join(root, `${kind}-post-lease-create-kill`);
    fs.mkdirSync(caseRoot);
    const sortCase = prepareSortCase(caseRoot, kind);
    if (kind !== "source") fs.writeFileSync(sortCase.output, `prior-${kind}-output`);
    const prior = fs.existsSync(sortCase.output) ? fs.readFileSync(sortCase.output) : null;
    await assert.rejects(execFileAsync(process.execPath, [child, kind, caseRoot, "crash-after-sort-lease-create"]),
      (error) => error.signal === "SIGKILL");
    assert.deepEqual(sortStageEntries(caseRoot), [], `${kind} post-lease kill cannot create a stage`);
    assertSortResidue(caseRoot, { stages: 0, leases: 1 });
    if (prior) assert.deepEqual(fs.readFileSync(sortCase.output), prior);
    await runSortCase(sortCase);
    assertSortResidue(caseRoot, { stages: 0, leases: 0 });
  }

  // A recovery can itself die before, or while, removing a known-dead stage.
  // Repeated restart must accept only the fixed stage and converge to none.
  for (const phase of ["crash-before-sort-stage-recovery-delete", "crash-mid-sort-stage-recovery-delete"]) {
    const caseRoot = path.join(root, phase);
    fs.mkdirSync(caseRoot);
    const sortCase = prepareSortCase(caseRoot, "terrain");
    await assert.rejects(execFileAsync(process.execPath, [child, "terrain", caseRoot, "crash-after-sort-stage-owner"]),
      (error) => error.signal === "SIGKILL");
    await assert.rejects(execFileAsync(process.execPath, [child, "terrain", caseRoot, phase]),
      (error) => error.signal === "SIGKILL");
    assert.equal(sortStageEntries(caseRoot).length, 1, `${phase} leaves at most the exact fixed stage`);
    assertSortResidue(caseRoot, { stages: 1, leases: 1 });
    await runSortCase(sortCase);
    assert.deepEqual(sortStageEntries(caseRoot), [], `${phase} restart removes the partial recovery stage`);
    assertSortResidue(caseRoot, { stages: 0, leases: 0 });
  }

  // After the durable output rename, a kill may leave the owned stage behind.
  // Recovery is allowed to remove that stage only; the installed bytes remain.
  const installedRoot = path.join(root, "installed-output");
  fs.mkdirSync(installedRoot);
  const installed = prepareSortCase(installedRoot, "terrain");
  await assert.rejects(execFileAsync(process.execPath, [child, "terrain", installedRoot, "crash-after-sort-output-rename"]),
    (error) => error.signal === "SIGKILL");
  const installedBytes = fs.readFileSync(installed.output);
  assert.equal(sortStageEntries(installedRoot).length, 1);
  assertSortResidue(installedRoot, { stages: 1, leases: 1 });
  await runSortCase(installed);
  assert.deepEqual(fs.readFileSync(installed.output), installedBytes,
    "restart keeps the atomically installed terrain bytes after stage cleanup");
  assert.deepEqual(sortStageEntries(installedRoot), []);
  assertSortResidue(installedRoot, { stages: 0, leases: 0 });

  // A simultaneous owner is never treated as stale merely because the caller
  // wants the same fixed stage. The child deliberately holds its lease.
  const concurrentRoot = path.join(root, "concurrent");
  fs.mkdirSync(concurrentRoot);
  const concurrent = prepareSortCase(concurrentRoot, "terrain");
  const live = execFileAsync(process.execPath, [child, "terrain", concurrentRoot, "hold-after-sort-stage-mkdir", "1200"]);
  for (let attempt = 0; attempt < 120 && sortStageEntries(concurrentRoot).length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sortStageEntries(concurrentRoot).length, 1, "live writer acquired its tokenized stage");
  assertSortResidue(concurrentRoot, { stages: 1, leases: 1 });
  try {
    await assert.rejects(runSortCase(concurrent), /live process/);
  } finally {
    await live;
  }
  assert.deepEqual(sortStageEntries(concurrentRoot), [], "live owner cleans its own stage");
  assertSortResidue(concurrentRoot, { stages: 0, leases: 0 });

  // Never convert a malicious owner entry or copied owner token into cleanup
  // authority. In particular, no path under the stage may redirect an unlink.
  const sentinel = path.join(root, "external-sentinel");
  fs.writeFileSync(sentinel, "must survive sort-stage rejection");
  const adversarialRoot = path.join(root, "adversarial");
  fs.mkdirSync(adversarialRoot);
  const adversarial = prepareSortCase(adversarialRoot, "terrain");
  const adversarialLease = sortLeasePath(adversarial.output, "terrain-merge");
  fs.symlinkSync(sentinel, adversarialLease);
  await assert.rejects(runSortCase(adversarial), /malformed atomic metadata/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "must survive sort-stage rejection");
  assert.equal(fs.existsSync(adversarialLease), true);
  fs.unlinkSync(adversarialLease);
  // A malformed atomic link and a regular half-written legacy candidate are
  // both foreign state: neither is reaped, parsed as authority, or replaced.
  fs.symlinkSync("{", adversarialLease);
  await assert.rejects(runSortCase(adversarial), /malformed atomic metadata/);
  assert.equal(fs.readlinkSync(adversarialLease), "{");
  fs.unlinkSync(adversarialLease);
  fs.writeFileSync(adversarialLease, "{\"version\":");
  await assert.rejects(runSortCase(adversarial), /not atomic symlink metadata/);
  assert.equal(fs.readFileSync(adversarialLease, "utf8"), "{\"version\":");
  fs.unlinkSync(adversarialLease);
  // A schema-valid but foreign fixed lease is not a stale candidate. It must
  // remain exactly as found rather than being deleted or replaced by a new
  // writer.
  const foreignLease = canonicalJson({
    version: 1, kind: "foreign-sort", output: path.basename(adversarial.output), pid: 999999,
    identity: null, token: "00000000-0000-4000-8000-000000000001",
  });
  fs.symlinkSync(foreignLease, adversarialLease);
  await assert.rejects(runSortCase(adversarial), /sort lease kind does not match/);
  assert.equal(fs.readlinkSync(adversarialLease), foreignLease,
    "foreign schema-valid lease is preserved without recovery authority");
  fs.unlinkSync(adversarialLease);
  const token = "00000000-0000-4000-8000-000000000000";
  const adversarialStage = path.join(adversarialRoot,
    `.${path.basename(adversarial.output)}.terrain-merge-sort-stage-${token}`);
  fs.mkdirSync(adversarialStage);
  const stat = fs.lstatSync(adversarialStage, { bigint: true });
  fs.writeFileSync(path.join(adversarialStage, "owner.json"), JSON.stringify({
    version: 1, kind: "terrain-merge", output: path.basename(adversarial.output), pid: process.pid,
    identity: null, stageDev: String(stat.dev), stageIno: "0",
    token,
  }));
  fs.symlinkSync(canonicalJson({
    version: 1, kind: "terrain-merge", output: path.basename(adversarial.output), pid: 999999,
    identity: null, token,
  }), adversarialLease);
  await assert.rejects(runSortCase(adversarial), /foreign or replaced ownership/);
  assert.equal(fs.existsSync(adversarialStage), true, "copied/replaced owner cannot authorize stage deletion");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "must survive sort-stage rejection");
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
  const state = JSON.parse(fs.readFileSync(path.join(root, "out", "global-build-state.json"), "utf8"));
  fs.appendFileSync(state.shards[0].snapshots.sourceLog.path, "x");
  await assert.rejects(
    execFileAsync(process.execPath, [
      COORDINATOR, "--config", config, "--out", path.join(root, "out"),
      "--shards", "2", "--workers", "1", "--runner", runner,
    ]), /sourceLog snapshot (byte count|digest) changed/,
  );
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
    fs.writeFileSync(path.join(out, "ocean-skipped.json"), JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", minLevel: null, count: 0, addresses: [] }));
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
  const state = JSON.parse(fs.readFileSync(path.join(out, "global-build-state.json"), "utf8"));
  const verifierPolicy = {
    format: "terrain-publication-policy-v1",
    globalConfigDigest: merged.configDigest,
    maxVerifiedStoreBytes: publicationPolicy.max_verified_store_bytes,
    maxStaticDirectoryBytes: publicationPolicy.max_static_directory_bytes,
    synthGridSize: publicationPolicy.synthesized_tile_grid_size,
  };
  assert.deepEqual(shard.publicationPolicy.policy, publicationPolicy);
  assert.equal(shard.publicationPolicy.globalConfigDigest, merged.configDigest);
  assert.deepEqual(state.publicationPolicy, verifierPolicy);
  assert.deepEqual(merged.publicationPolicy, verifierPolicy);
});

test("source manifest sort workspace survives SIGKILL boundaries without contaminating the artifact transaction", async (t) => {
  const root = temporary(t);
  const policy = contract();
  const config = path.join(root, "run.json");
  const runner = path.join(root, "source-runner.mjs");
  fs.writeFileSync(config, JSON.stringify({
    cache_max_bytes: policy.cacheMaxBytes,
    source_policy: policy.policy,
    flow_config: { dataset_epoch: policy.datasetEpoch, regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }] },
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
    fs.writeFileSync(path.join(out, "run-report.json"), JSON.stringify({ drained: true, errors: [], sourceProvenance: {
      sourcePolicyDigest: contract.digest, datasetEpoch: contract.datasetEpoch,
      globalConfigDigest: value.global_config_digest,
    } }));
  `);
  const cases = [
    {
      fault: "--fault-source-manifest-crash-before-stage-link",
      workEntries: ["source-manifest.ndjson"], stagedEntries: [],
      label: "sort workspace before transaction reservation",
    },
    {
      fault: "--fault-source-manifest-crash-after-stage-link",
      workEntries: ["source-manifest.ndjson"], stagedEntries: ["source-manifest.ndjson"],
      label: "hard-linked stage before work-output unlink",
    },
    {
      fault: "--fault-source-manifest-crash-before-reserve",
      workEntries: [], stagedEntries: ["source-manifest.ndjson"],
      label: "durable unreserved stage after work-output cleanup",
    },
    {
      fault: "--fault-source-manifest-crash-after-reserve",
      workEntries: [], stagedEntries: [],
      label: "reserved and installed source manifest",
    },
  ];
  for (const scenario of cases) {
    const out = path.join(root, scenario.fault.slice(2));
    const baseArgs = [COORDINATOR, "--config", config, "--out", out, "--runner", runner];
    await assert.rejects(execFileAsync(process.execPath, [...baseArgs, scenario.fault]),
      (error) => error.signal === "SIGKILL", `${scenario.label} actually SIGKILLs`);
    const transaction = JSON.parse(fs.readFileSync(path.join(out, "global-artifact-transaction.json"), "utf8"));
    const stagedEntries = fs.readdirSync(transaction.stagingDir).sort();
    assert.deepEqual(stagedEntries, scenario.stagedEntries, `${scenario.label} leaves only its exact stage`);
    const work = path.join(out, ".source-manifest-sort-work");
    const workEntries = fs.readdirSync(work).sort();
    assert.deepEqual(workEntries, scenario.workEntries,
      `${scenario.label} leaves only fixed workspace protocol artifacts`);
    for (const name of workEntries) assert.equal(name, "source-manifest.ndjson");

    // This ordinary injected stop is reached only after startup recovered the
    // SIGKILL residue, rebuilt the exact source-manifest path, and installed
    // its fourth transaction member. It prevents the test from needing a
    // verifier runtime while proving the resume path itself.
    await assert.rejects(execFileAsync(process.execPath, [
      ...baseArgs, "--fault-after-source-manifest-reserve",
    ]), /fault injection after source manifest reserve/);
    assert.deepEqual(fs.readdirSync(work).sort(), [], `${scenario.label} resume consumes all workspace residue`);
    const resumed = JSON.parse(fs.readFileSync(path.join(out, "global-artifact-transaction.json"), "utf8"));
    assert.equal(resumed.entries.length, 4, `${scenario.label} resume has the exact four-member transaction`);
    assert.deepEqual(fs.readdirSync(resumed.stagingDir), [], `${scenario.label} resume finishes transaction staging empty`);
    assert.equal(fs.existsSync(path.join(out, "source-manifest.ndjson")), true,
      `${scenario.label} resume installs the immutable completion manifest`);
  }
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
      fs.writeFileSync(path.join(out, "ocean-skipped.json"), JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", minLevel: null, count: 0, addresses: [] }));
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
    fs.writeFileSync(path.join(out, "ocean-skipped.json"), JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", minLevel: null, count: 0, addresses: [] }));
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

test("an unmaterialized reserved artifact preserves an old destination on transaction recovery", async (t) => {
  const root = temporary(t);
  const out = path.join(root, "out");
  const config = path.join(root, "run.json");
  const runner = path.join(root, "runner.mjs");
  const staging = path.join(out, ".global-merge-stage-reservation");
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(config, JSON.stringify({
    flow_config: { regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }] },
  }));
  fs.writeFileSync(runner, `
    import fs from "node:fs"; import path from "node:path";
    const out = process.argv[process.argv.indexOf("--out") + 1]; fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "tiles.dttstream"), "");
    fs.writeFileSync(path.join(out, "run-report.json"), JSON.stringify({ drained: true, errors: [] }));
  `);
  const oldManifest = path.join(out, "source-manifest.ndjson");
  fs.writeFileSync(oldManifest, "old immutable receipt\n");
  const absent = (name) => ({
    staged: path.join(staging, name), destination: path.join(out, name),
    backup: path.join(out, `${name}.premerge-test`), hadDestination: false,
  });
  fs.writeFileSync(path.join(out, "global-artifact-transaction.json"), JSON.stringify({
    version: 1, stagingDir: staging,
    entries: [
      absent("tiles.dttstream"), absent("ocean-skipped.lines"), absent("ocean-skipped.json"),
      {
        staged: path.join(staging, "source-manifest.ndjson"), destination: oldManifest,
        backup: path.join(out, "source-manifest.ndjson.premerge-test"), hadDestination: true,
      },
    ],
  }));
  await assert.rejects(execFileAsync(process.execPath, [
    COORDINATOR, "--config", config, "--out", out, "--runner", runner, "--skip-verify", "--fault-after-shards", "1",
  ]), /fault injection after 1 completed shard/);
  assert.equal(fs.readFileSync(oldManifest, "utf8"), "old immutable receipt\n");
  assert.equal(fs.existsSync(path.join(out, "global-artifact-transaction.json")), false);
});

test("forged global artifact journals cannot follow symlinks, external paths, or duplicate entries", async (t) => {
  const root = temporary(t);
  const config = path.join(root, "run.json");
  const runner = path.join(root, "runner.mjs");
  const sentinel = path.join(root, "outside-sentinel");
  fs.writeFileSync(config, JSON.stringify({
    flow_config: { regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }] },
  }));
  fs.writeFileSync(runner, "throw new Error('forged transaction must fail before runner');\n");
  fs.writeFileSync(sentinel, "must remain outside\n");
  const names = ["tiles.dttstream", "ocean-skipped.lines", "ocean-skipped.json"];
  const makeAttempt = (kind) => {
    const out = path.join(root, `out-${kind}`);
    const staging = path.join(out, ".global-merge-stage-forged");
    fs.mkdirSync(staging, { recursive: true });
    const entries = names.map((name) => {
      fs.writeFileSync(path.join(staging, name), `${name}\n`);
      return {
        staged: path.join(staging, name), destination: path.join(out, name),
        backup: path.join(out, `${name}.premerge-test`), hadDestination: false,
      };
    });
    if (kind === "external") entries[0].destination = sentinel;
    if (kind === "symlink") fs.symlinkSync(sentinel, entries[0].backup);
    if (kind === "duplicate") entries[2] = { ...entries[0] };
    fs.writeFileSync(path.join(out, "global-artifact-transaction.json"), JSON.stringify({
      version: 1, stagingDir: staging, entries,
    }));
    return out;
  };
  for (const kind of ["external", "symlink", "duplicate"]) {
    const out = makeAttempt(kind);
    await assert.rejects(execFileAsync(process.execPath, [
      COORDINATOR, "--config", config, "--out", out, "--runner", runner, "--skip-verify",
    ]), /coordinator-owned|symbolic link|exact coordinator-owned artifact set/);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "must remain outside\n", `${kind} journal did not mutate its external sentinel`);
  }
});

test("terminal-state crash windows preserve artifacts until a resumed coordinator writes its final receipt", async (t) => {
  for (const flag of ["--fault-after-terminal-state", "--fault-after-verify"]) {
    const root = temporary(t);
    const out = path.join(root, "out");
    const config = path.join(root, "run.json");
    const runner = path.join(root, "runner.mjs");
    fs.writeFileSync(config, JSON.stringify({
      flow_config: { regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }] },
    }));
    fs.writeFileSync(runner, `
      import fs from "node:fs"; import path from "node:path";
      const out = process.argv[process.argv.indexOf("--out") + 1]; fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "tiles.dttstream"), "");
      fs.writeFileSync(path.join(out, "ocean-skipped.json"), JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", minLevel: null, count: 0, addresses: [] }));
      fs.writeFileSync(path.join(out, "run-report.json"), JSON.stringify({ drained: true, errors: [] }));
    `);
    await assert.rejects(execFileAsync(process.execPath, [
      COORDINATOR, "--config", config, "--out", out, "--runner", runner, "--skip-verify", flag,
    ]), /fault injection after (terminal global state|global verification)/);
    const stateBefore = fs.readFileSync(path.join(out, "global-build-state.json"));
    assert.equal(JSON.parse(stateBefore).completed, true, `${flag} persists terminal state first`);
    assert.equal(fs.existsSync(path.join(out, "global-artifact-transaction.json")), true, `${flag} retains rollback transaction`);
    assert.equal(fs.existsSync(path.join(out, "global-merge-report.json")), false, `${flag} does not expose final merge receipt`);
    const resumeArgs = [COORDINATOR, "--config", config, "--out", out, "--runner", runner, "--skip-verify"];
    if (flag === "--fault-after-verify") {
      // Model the exact v2 verifier write that precedes the injected crash.
      // A matching receipt must let resume finalize without rerunning shards
      // or replacing the immutable terminal state.
      fs.writeFileSync(path.join(out, "verify-report.json"), JSON.stringify({
        format: "terrain-verification-report-v1", publishable: true, problems: [],
        publicationInputs: {
          format: "terrain-publication-inputs-v2",
          globalState: {
            path: "global-build-state.json", bytes: stateBefore.length, sha256: sha256(stateBefore),
          },
          approvedConfig: (() => {
            const approved = fs.readFileSync(path.join(out, "approved-run-config.json"));
            return { path: "approved-run-config.json", bytes: approved.length, sha256: sha256(approved) };
          })(),
        },
      }));
      resumeArgs.pop();
    }
    await execFileAsync(process.execPath, resumeArgs);
    assert.deepEqual(fs.readFileSync(path.join(out, "global-build-state.json")), stateBefore,
      `${flag} resume does not mutate the terminal verifier input`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, "global-merge-report.json"), "utf8")).completion, "complete");
    assert.equal(fs.existsSync(path.join(out, "global-artifact-transaction.json")), false, `${flag} finalizes only after receipt`);
  }
});

test("resumption rejects a changed coordinator-owned shard snapshot", async (t) => {
  for (const snapshotName of ["report", "tiles", "oceanJson"]) {
    const root = temporary(t);
    const out = path.join(root, "out");
    const config = path.join(root, "run.json");
    const runner = path.join(root, "runner.mjs");
    fs.writeFileSync(config, JSON.stringify({
      flow_config: { regions: [{ name: "test", west: 0, south: 0, east: 1, north: 1 }] },
    }));
    fs.writeFileSync(runner, `
      import fs from "node:fs"; import path from "node:path";
      const out = process.argv[process.argv.indexOf("--out") + 1]; fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "tiles.dttstream"), "");
      fs.writeFileSync(path.join(out, "ocean-skipped.json"), JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", minLevel: null, count: 0, addresses: [] }));
      fs.writeFileSync(path.join(out, "run-report.json"), JSON.stringify({ drained: true, errors: [] }));
    `);
    await execFileAsync(process.execPath, [COORDINATOR, "--config", config, "--out", out, "--runner", runner, "--skip-verify"]);
    const state = JSON.parse(fs.readFileSync(path.join(out, "global-build-state.json"), "utf8"));
    fs.appendFileSync(state.shards[0].snapshots[snapshotName].path, "x");
    await assert.rejects(execFileAsync(process.execPath, [
      COORDINATOR, "--config", config, "--out", out, "--runner", runner, "--skip-verify",
    ]), new RegExp(`${snapshotName} snapshot (byte count|digest) changed`));
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

test("external terrain and ocean sorts retain only bounded fan-in state across many runs", async (t) => {
  const root = temporary(t);
  const terrainInput = path.join(root, "many-terrain.dttstream");
  const terrainOutput = path.join(root, "many-terrain-merged.dttstream");
  const terrainRecords = Array.from({ length: 192 }, (_, index) =>
    Buffer.from(`8/${index}/1|${String(index).padStart(3, "0")}-${"x".repeat(300)}`));
  fs.writeFileSync(terrainInput, framed(terrainRecords));
  const terrain = await mergeBoundedFramedStores({
    inputFiles: [terrainInput], outputFile: terrainOutput,
    addressForRecord: (record) => record.toString("utf8").split("|", 1)[0],
    maxRunBytes: 1024, fanIn: 2,
  });
  assert.equal(terrain.records, terrainRecords.length);
  let terrainCount = 0;
  for await (const unused of iterateStreamFile(terrainOutput, { highWaterMark: 97 })) {
    void unused;
    terrainCount += 1;
  }
  assert.equal(terrainCount, terrainRecords.length);

  const oceanInput = path.join(root, "many-ocean.lines");
  const oceanOutput = path.join(root, "many-ocean-merged.lines");
  fs.writeFileSync(oceanInput, Array.from({ length: 192 }, (_, index) => `10/${index}/0`).join("\n") + "\n");
  const ocean = await mergeOceanSkips({
    inputFiles: [oceanInput], outputFile: oceanOutput, maxRunBytes: 1, fanIn: 2,
  });
  assert.equal(ocean.count, 192);
  assert.equal(fs.readFileSync(oceanOutput, "utf8").trim().split("\n").length, 192);
});

test("ocean-skip merge streams legacy JSON and JSONL into a compact receipt", async (t) => {
  const root = temporary(t);
  const legacy = path.join(root, "legacy.json");
  const emptyCurrent = path.join(root, "empty-current.json");
  const jsonl = path.join(root, "current.lines");
  const output = path.join(root, "ocean-skipped.lines");
  fs.writeFileSync(legacy, JSON.stringify({
    generatedAt: "2026-09-01T00:00:00.000Z",
    minLevel: 8,
    count: 2,
    addresses: ["8/2/1", "8/1/1"],
  }));
  // A current runner creates no .lines file when it skipped no ocean tiles;
  // its complete zero-count receipt is still a valid shard input and must add
  // nothing.  Keep this byte shape aligned with run.mjs.
  fs.writeFileSync(emptyCurrent, JSON.stringify({
    generatedAt: "2026-09-01T00:00:00.000Z",
    format: "terrain-ocean-skips-lines-v1",
    addressesPath: "ocean-skipped.lines",
    minLevel: null,
    count: 0,
    digest: sha256(""),
  }));
  fs.writeFileSync(jsonl, "8/3/1\n");
  const receipt = await mergeOceanSkips({ inputFiles: [legacy, emptyCurrent, jsonl], outputFile: output, maxRunBytes: 1, fanIn: 2 });
  assert.equal(receipt.count, 3);
  assert.equal(receipt.duplicates, 0);
  assert.deepEqual(fs.readFileSync(output, "utf8").trim().split("\n"), ["8/1/1", "8/2/1", "8/3/1"]);
  assert.match(receipt.digest, /^[0-9a-f]{64}$/);
});

test("ocean-skip merge accepts committed old-run address evidence", async (t) => {
  const root = temporary(t);
  const output = path.join(root, "ocean-skipped.lines");
  const evidence = JSON.parse(fs.readFileSync(LIGURIA_OCEAN_RECEIPT, "utf8"));
  assert.deepEqual(Object.keys(evidence).sort(), ["addresses", "count", "generatedAt", "minLevel"]);
  const receipt = await mergeOceanSkips({ inputFiles: [LIGURIA_OCEAN_RECEIPT], outputFile: output, maxRunBytes: 1024, fanIn: 2 });
  assert.equal(receipt.count, evidence.count);
  assert.equal(receipt.duplicateLinesWithinShards, 0);
  assert.equal(fs.readFileSync(output, "utf8").trim().split("\n").length, evidence.count);
});

test("ocean-skip legacy receipts retain duplicate recovery accounting", async (t) => {
  const root = temporary(t);
  const input = path.join(root, "legacy.json");
  const output = path.join(root, "ocean-skipped.lines");
  fs.writeFileSync(input, JSON.stringify({
    generatedAt: "2026-09-01T00:00:00.000Z",
    minLevel: 8,
    count: 3,
    addresses: ["8/1/1", "8/1/1", "8/2/1"],
  }));
  const receipt = await mergeOceanSkips({ inputFiles: [input], outputFile: output, maxRunBytes: 1, fanIn: 2 });
  assert.equal(receipt.count, 2);
  assert.equal(receipt.duplicateLinesWithinShards, 1);
  assert.deepEqual(fs.readFileSync(output, "utf8").trim().split("\n"), ["8/1/1", "8/2/1"]);
});

test("ocean-skip merge rejects duplicate object keys and malformed receipt metadata", async (t) => {
  const root = temporary(t);
  const output = path.join(root, "ocean-skipped.lines");
  const emptyDigest = sha256("");
  const exactEmpty = {
    generatedAt: "2026-09-01T00:00:00.000Z",
    format: "terrain-ocean-skips-lines-v1",
    addressesPath: "ocean-skipped.lines",
    minLevel: null,
    count: 0,
    digest: emptyDigest,
  };
  const exactLegacy = {
    generatedAt: "2026-09-01T00:00:00.000Z",
    minLevel: 8,
    count: 1,
    addresses: ["8/1/1"],
  };
  const compact = (members) => `{${members}}`;
  const exactMembers = JSON.stringify(exactEmpty).slice(1, -1);
  const { count: exactCount, ...withoutCount } = exactEmpty;
  const { addressesPath: exactAddressesPath, ...withoutAddressesPath } = exactEmpty;
  void exactCount;
  void exactAddressesPath;
  const membersWithoutCount = JSON.stringify(withoutCount).slice(1, -1);
  const cases = [
    [
      "reverse-order count bypass",
      compact(`${membersWithoutCount},"count":1,"count":0`),
      /duplicate key count/,
    ],
    [
      "duplicate address arrays",
      '{"addresses":[],"addresses":[]}',
      /duplicate key addresses/,
    ],
    [
      "duplicate format",
      compact(`${exactMembers},"format":"terrain-ocean-skips-lines-v1"`),
      /duplicate key format/,
    ],
    [
      "duplicate formerly ignored timestamp",
      compact(`${exactMembers},"generatedAt":"2026-09-01T00:00:01.000Z"`),
      /duplicate key generatedAt/,
    ],
    [
      "extra modern member on legacy receipt",
      JSON.stringify({ ...exactLegacy, format: "terrain-ocean-skips-lines-v1" }),
      /address receipt has an unexpected shape/,
    ],
    [
      "unknown receipt key",
      JSON.stringify({ ...exactLegacy, ignored: true }),
      /unsupported key ignored/,
    ],
    [
      "legacy count mismatch",
      JSON.stringify({ ...exactLegacy, count: 2 }),
      /count does not match streamed addresses/,
    ],
    [
      "legacy minimum mismatch",
      JSON.stringify({ ...exactLegacy, minLevel: 9 }),
      /minLevel does not match streamed addresses/,
    ],
    [
      "wrong compact address path",
      JSON.stringify({ ...exactEmpty, addressesPath: "elsewhere.lines" }),
      /must name ocean-skipped\.lines/,
    ],
    [
      "missing compact address path",
      JSON.stringify(withoutAddressesPath),
      /unexpected shape/,
    ],
    [
      "nonempty compact receipt",
      JSON.stringify({ ...exactEmpty, count: 1 }),
      /count must be zero/,
    ],
    [
      "nonempty minimum level",
      JSON.stringify({ ...exactEmpty, minLevel: 8 }),
      /minLevel must be null/,
    ],
    [
      "wrong empty digest",
      JSON.stringify({ ...exactEmpty, digest: "0".repeat(64) }),
      /empty SHA-256/,
    ],
    [
      "noncanonical runner timestamp",
      JSON.stringify({ ...exactEmpty, generatedAt: "old" }),
      /canonical RFC3339 UTC milliseconds/,
    ],
  ];
  for (const [name, bytes, expected] of cases) {
    const input = path.join(root, `${name.replaceAll(" ", "-")}.json`);
    fs.writeFileSync(input, bytes);
    await assert.rejects(
      mergeOceanSkips({ inputFiles: [input], outputFile: output, maxRunBytes: 1, fanIn: 2 }),
      expected,
      name,
    );
  }
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
