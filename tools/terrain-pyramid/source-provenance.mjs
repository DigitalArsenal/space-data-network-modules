// Immutable source-observation support for global terrain cuts.
//
// The bounded granule cache owns bytes and eviction.  This companion owns the
// evidence that makes those bytes usable as a source: a response receipt per
// cache key, append-only per-request logs, and a completion-only canonical
// manifest assembled by external sort.  Neither the runner nor the merger
// keeps a world-sized URL map in memory.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { iterateStreamFile } from "./dtt-reader.mjs";

export const MAX_GLOBAL_SOURCE_CACHE_BYTES = 96 * 1024 ** 3;
export const SOURCE_MANIFEST_VERSION = 1;
const MAX_OBSERVATION_LINE_BYTES = 16 * 1024;
const SOURCE_SORT_RUN_BYTES = 4 * 1024 * 1024;
const SOURCE_SORT_FAN_IN = 32;
const MAX_MERGE_RECORD_LINE_BYTES = 2 * 1024 * 1024;
const TERRAIN_SORT_RUN_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_EPOCH_BYTES = 4 * 1024;
const MAX_SOURCE_RECEIPT_BYTES = 16 * 1024;
const MAX_SOURCE_URL_BYTES = 4 * 1024;
const MAX_SOURCE_HEADER_BYTES = 8 * 1024;
const MAX_SOURCE_TIMESTAMP_BYTES = 128;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceTemplatePattern(template) {
  const parts = template.split(/(\{(?:NS|LAT2|EW|LON3)\})/);
  const token = {
    "{NS}": "[NS]",
    "{LAT2}": "[0-9]{2}",
    "{EW}": "[EW]",
    "{LON3}": "[0-9]{3}",
  };
  const pattern = parts.map((part) => token[part] ?? escapeRegExp(part)).join("");
  // Refuse an unrecognised placeholder rather than turning it into a broad
  // endpoint allowance. The checked policy uses only the four coordinates.
  assert.equal(/\{[^}]+\}/.test(template.replace(/\{(?:NS|LAT2|EW|LON3)\}/g, "")), false,
    "source URL template has an unsupported placeholder");
  return pattern;
}

export function sourcePolicyAllowsUrl(contract, url) {
  return contract.urlPattern.test(url);
}

function assertBoundedText(value, maxBytes, label) {
  assert.equal(typeof value, "string", `${label} must be text`);
  assert.ok(Buffer.byteLength(value, "utf8") <= maxBytes,
    `${label} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

function directoryHasEntry(directory) {
  const handle = fs.opendirSync(directory);
  try {
    return handle.readSync() !== null;
  } finally {
    handle.closeSync();
  }
}

function readSmallJson(file, maxBytes, label) {
  const stat = fs.statSync(file);
  assert.ok(stat.isFile(), `${label} is not a regular file: ${file}`);
  assert.ok(stat.size <= maxBytes, `${label} exceeds ${maxBytes} byte bound: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** A fixed-capacity top-K heap for streaming summaries. compareBest(a,b) > 0 means a is preferred. */
export class BoundedTopK {
  constructor(cap, compareBest) {
    assert.ok(Number.isSafeInteger(cap) && cap > 0, "bounded top-K cap must be a positive integer");
    assert.equal(typeof compareBest, "function", "bounded top-K comparator is required");
    this.cap = cap;
    this.compareBest = compareBest;
    this.heap = [];
  }
  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compareBest(this.heap[index], this.heap[parent]) >= 0) break;
      [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
      index = parent;
    }
  }
  bubbleDown(index) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.heap.length && this.compareBest(this.heap[left], this.heap[smallest]) < 0) smallest = left;
      if (right < this.heap.length && this.compareBest(this.heap[right], this.heap[smallest]) < 0) smallest = right;
      if (smallest === index) return;
      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }
  add(entry) {
    if (this.heap.length < this.cap) {
      this.heap.push(entry);
      this.bubbleUp(this.heap.length - 1);
    } else if (this.compareBest(entry, this.heap[0]) > 0) {
      this.heap[0] = entry;
      this.bubbleDown(0);
    }
  }
  ordered() { return [...this.heap].sort((a, b) => -this.compareBest(a, b)); }
}

export function sourcePolicyContract(runConfig) {
  const policy = runConfig?.source_policy;
  if (!policy) return null;
  assert.equal(policy.version, 1, "source_policy.version must be 1");
  assert.ok(typeof policy.dataset_epoch === "string" && policy.dataset_epoch.length > 0,
    "source_policy.dataset_epoch is required");
  assert.ok(typeof policy.provider === "string" && policy.provider.length > 0,
    "source_policy.provider is required");
  assert.ok(typeof policy.url_policy?.base_url === "string" && policy.url_policy.base_url.startsWith("https://"),
    "source_policy.url_policy.base_url must be an https URL");
  assert.ok(typeof policy.url_policy?.dem_template === "string" && policy.url_policy.dem_template.length > 0,
    "source_policy.url_policy.dem_template is required");
  assert.ok(typeof policy.url_policy?.water_template === "string" && policy.url_policy.water_template.length > 0,
    "source_policy.url_policy.water_template is required");
  assert.ok(!/[?#]/.test(policy.url_policy.base_url),
    "source_policy.url_policy.base_url must not carry a query or fragment");
  if (runConfig.flow_config?.source_url !== undefined) {
    assert.equal(runConfig.flow_config.source_url, policy.url_policy.base_url,
      "flow_config.source_url must equal source_policy.url_policy.base_url");
  }
  assert.equal(Object.hasOwn(runConfig.flow_config ?? {}, "retrieved_at"), false,
    "a source_policy run must not prefill flow_config.retrieved_at as an observation");
  assert.ok(Number.isSafeInteger(policy.request?.timeout_ms) && policy.request.timeout_ms > 0,
    "source_policy.request.timeout_ms must be a positive integer");
  if (runConfig.flow_config?.timeout_ms !== undefined) {
    assert.equal(runConfig.flow_config.timeout_ms, policy.request.timeout_ms,
      "flow_config.timeout_ms must equal source_policy.request.timeout_ms");
  }
  assert.ok(Number.isSafeInteger(policy.request?.retries) && policy.request.retries >= 0,
    "source_policy.request.retries must be a non-negative integer");
  assert.ok(Number.isSafeInteger(policy.request?.retry_base_ms) && policy.request.retry_base_ms >= 0,
    "source_policy.request.retry_base_ms must be a non-negative integer");
  assert.ok(Number.isSafeInteger(policy.request?.max_outstanding) && policy.request.max_outstanding >= 1 && policy.request.max_outstanding <= 64,
    "source_policy.request.max_outstanding must be an integer in [1, 64]");
  assert.equal(policy.no_data?.http_404, "record-no-coverage-never-retry",
    "source_policy.no_data.http_404 must explicitly preserve 404 observations");
  assert.ok(typeof policy.no_data?.non_water === "string" && policy.no_data.non_water.length > 0,
    "source_policy.no_data.non_water is required");
  assert.ok(typeof policy.ocean_policy === "string" && policy.ocean_policy.length > 0,
    "source_policy.ocean_policy is required");
  assert.ok(Number.isSafeInteger(policy.cache?.max_bytes) && policy.cache.max_bytes > 0,
    "source_policy.cache.max_bytes must be a positive safe integer");
  assert.ok(policy.cache.max_bytes <= MAX_GLOBAL_SOURCE_CACHE_BYTES,
    `source_policy.cache.max_bytes may not exceed ${MAX_GLOBAL_SOURCE_CACHE_BYTES} bytes (96 GiB)`);
  assert.equal(runConfig.cache_max_bytes, policy.cache.max_bytes,
    "cache_max_bytes must equal source_policy.cache.max_bytes");
  assert.equal(policy.manifest?.format, "canonical-jsonl-v1",
    "source_policy.manifest.format must be canonical-jsonl-v1");
  assert.equal(policy.manifest?.digest, "sha256",
    "source_policy.manifest.digest must be sha256");
  assert.ok(typeof policy.manifest?.shard_log === "string" && policy.manifest.shard_log.length > 0,
    "source_policy.manifest.shard_log is required");
  assert.ok(typeof policy.manifest?.completion_manifest === "string" && policy.manifest.completion_manifest.length > 0,
    "source_policy.manifest.completion_manifest is required");
  const urlPattern = new RegExp(`^${escapeRegExp(policy.url_policy.base_url)}(?:${
    sourceTemplatePattern(policy.url_policy.dem_template)
  }|${sourceTemplatePattern(policy.url_policy.water_template)})$`);
  return {
    policy,
    digest: sha256(canonicalJson(policy)),
    datasetEpoch: policy.dataset_epoch,
    cacheMaxBytes: policy.cache.max_bytes,
    urlPattern,
  };
}

export function ensureSourceEpoch(cacheDir, contract) {
  if (!contract) return null;
  const file = path.join(cacheDir, "source-epoch.json");
  const receipt = {
    version: SOURCE_MANIFEST_VERSION,
    sourcePolicyDigest: contract.digest,
    datasetEpoch: contract.datasetEpoch,
  };
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(file)) {
    const entries = path.join(cacheDir, "entries");
    // A cache from before this protocol has object bytes but no immutable
    // response receipts.  Binding that cache to a new policy would manufacture
    // provenance, so a new epoch may start only in an empty cache directory.
    if (fs.existsSync(entries) && directoryHasEntry(entries)) {
      throw new Error(`refusing to bind legacy cache entries without source receipts: ${cacheDir}`);
    }
  }
  try {
    const handle = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(handle, `${canonicalJson(receipt)}\n`); } finally { fs.closeSync(handle); }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let existing;
  try { existing = readSmallJson(file, MAX_SOURCE_EPOCH_BYTES, "source epoch receipt"); } catch {
    throw new Error(`source epoch receipt is torn or unreadable: ${file}`);
  }
  assert.equal(existing.version, receipt.version, `unsupported source epoch receipt in ${file}`);
  assert.equal(existing.sourcePolicyDigest, receipt.sourcePolicyDigest,
    `refusing to mix source policy epochs in cache ${cacheDir}`);
  assert.equal(existing.datasetEpoch, receipt.datasetEpoch,
    `refusing to mix dataset epochs in cache ${cacheDir}`);
  return { file, ...receipt };
}

function sourceKey(url) { return `sha256:${sha256(url)}`; }
function receiptPath(cacheDir, url) {
  return path.join(cacheDir, "source-observations", `${sha256(url)}.json`);
}

// The shard log is an audit trail of logical requests, so it additionally
// carries requested_at and cache_hit.  The completion manifest instead names
// each immutable response once; leaving request scheduling fields in it would
// make otherwise identical completed cuts depend on worker timing.
function manifestObservation(observation) {
  return {
    source_key: observation.source_key,
    url: observation.url,
    status: observation.status,
    content_length: observation.content_length,
    content_digest: observation.content_digest,
    ...(observation.etag ? { etag: observation.etag } : {}),
    ...(observation.last_modified ? { last_modified: observation.last_modified } : {}),
    observed_at: observation.observed_at,
  };
}

export function sourceObservationIdentity(observation) {
  return canonicalJson({
    source_key: observation.source_key,
    url: observation.url,
    status: observation.status,
    content_length: observation.content_length,
    content_digest: observation.content_digest,
    etag: observation.etag ?? null,
    last_modified: observation.last_modified ?? null,
  });
}

function assertObservation(observation) {
  assert.match(observation?.source_key ?? "", /^sha256:[0-9a-f]{64}$/, "invalid source observation key");
  assertBoundedText(observation?.url, MAX_SOURCE_URL_BYTES, "source observation URL");
  assert.ok(observation.url.length > 0, "source observation URL is required");
  assert.ok(Number.isInteger(observation?.status), "source observation status is required");
  assert.ok(Number.isSafeInteger(observation?.content_length) && observation.content_length >= 0,
    "source observation content_length is required");
  assert.match(observation?.content_digest ?? "", /^[0-9a-f]{64}$/, "source observation SHA-256 digest is required");
  assertBoundedText(observation?.observed_at, MAX_SOURCE_TIMESTAMP_BYTES, "source observation observed_at");
  assert.ok(observation.observed_at.length > 0, "source observation observed_at is required");
  if (observation.etag !== undefined) assertBoundedText(observation.etag, MAX_SOURCE_HEADER_BYTES, "source observation ETag");
  if (observation.last_modified !== undefined) assertBoundedText(observation.last_modified, MAX_SOURCE_HEADER_BYTES, "source observation Last-Modified");
}

function readReceipt(cacheDir, url) {
  try {
    const observation = readSmallJson(receiptPath(cacheDir, url), MAX_SOURCE_RECEIPT_BYTES, "source observation receipt");
    assertObservation(observation);
    assert.equal(observation.source_key, sourceKey(url), "source receipt URL key mismatch");
    assert.equal(observation.url, url, "source receipt URL mismatch");
    return observation;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function persistReceipt(cacheDir, observation) {
  const file = receiptPath(cacheDir, observation.url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = `${canonicalJson(observation)}\n`;
  try {
    const handle = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(handle, bytes); } finally { fs.closeSync(handle); }
    return observation;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readReceipt(cacheDir, observation.url);
    assert.ok(existing, `source receipt vanished while recording ${observation.url}`);
    assert.equal(sourceObservationIdentity(existing), sourceObservationIdentity(observation),
      `source changed during this policy epoch: ${observation.url}`);
    return existing;
  }
}

export class SourceRequestObserver {
  constructor({ timeoutMs, fetchImpl = fetch, maxOutstanding = 8, allowUrl = undefined } = {}) {
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "source request timeout must be a positive integer");
    assert.ok(Number.isSafeInteger(maxOutstanding) && maxOutstanding > 0,
      "source request observer maxOutstanding must be a positive integer");
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.maxOutstanding = maxOutstanding;
    this.allowUrl = allowUrl;
    this.byUrl = new Map();
    this.pending = new Set();
  }

  async fetch(url, options = {}) {
    assertBoundedText(url, MAX_SOURCE_URL_BYTES, "source request URL");
    assert.ok(!this.allowUrl || this.allowUrl(url), `source URL is outside the approved immutable naming policy: ${url}`);
    assert.ok(!this.pending.has(url), `concurrent duplicate source request is not permitted: ${url}`);
    assert.ok(this.pending.size < this.maxOutstanding,
      `source request observer exceeds ${this.maxOutstanding} outstanding observations`);
    this.pending.add(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...options, redirect: "error", signal: controller.signal });
      const header = (name) => {
        try {
          if (typeof response.headers?.get === "function") return response.headers.get(name) ?? undefined;
          if (response.headers && typeof response.headers === "object") return response.headers[name] ?? response.headers[name.toLowerCase()];
        } catch {}
        return undefined;
      };
      const etag = header("etag");
      const lastModified = header("last-modified");
      this.byUrl.set(url, {
        ...(etag ? { etag: assertBoundedText(String(etag), MAX_SOURCE_HEADER_BYTES, "response ETag") } : {}),
        ...(lastModified ? { last_modified: assertBoundedText(String(lastModified), MAX_SOURCE_HEADER_BYTES, "response Last-Modified") } : {}),
        observed_at: new Date().toISOString(),
      });
      return response;
    } catch (error) {
      this.byUrl.delete(url);
      this.pending.delete(url);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  take(url) {
    const observed = this.byUrl.get(url);
    this.byUrl.delete(url);
    this.pending.delete(url);
    return observed;
  }

  discard(url) {
    this.byUrl.delete(url);
    this.pending.delete(url);
  }
}

export function observationForRequest({ cacheDir, url, fetched, networkObservation = undefined }) {
  if (fetched.hit) {
    const existing = readReceipt(cacheDir, url);
    assert.ok(existing, `cached source object has no immutable observation receipt: ${url}`);
    return existing;
  }
  const observation = {
    source_key: sourceKey(url),
    url,
    status: fetched.status,
    content_length: fetched.body.length,
    content_digest: sha256(fetched.body),
    ...(networkObservation?.etag ? { etag: networkObservation.etag } : {}),
    ...(networkObservation?.last_modified ? { last_modified: networkObservation.last_modified } : {}),
    observed_at: networkObservation?.observed_at ?? new Date().toISOString(),
  };
  assertObservation(observation);
  return persistReceipt(cacheDir, observation);
}

export function appendRequestObservation(logFile, observation, { requestedAt, cacheHit }) {
  assertObservation(observation);
  assert.ok(typeof requestedAt === "string" && requestedAt.length > 0, "requestedAt is required");
  fs.appendFileSync(logFile, `${canonicalJson({ ...observation, requested_at: requestedAt, cache_hit: Boolean(cacheHit) })}\n`);
}

function codeUnitCompare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareObservation(a, b) {
  return codeUnitCompare(a.source_key, b.source_key) ||
    codeUnitCompare(sourceObservationIdentity(a), sourceObservationIdentity(b)) ||
    codeUnitCompare(a.observed_at, b.observed_at);
}

async function* boundedLines(file, maxBytes) {
  let pending = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4096 })) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(start, end);
      assert.ok(pending.length + segment.length <= maxBytes,
        `line exceeds ${maxBytes} bytes: ${file}`);
      if (newline < 0) {
        pending = pending.length ? Buffer.concat([pending, segment]) : Buffer.from(segment);
        break;
      }
      const bytes = pending.length ? Buffer.concat([pending, segment]) : segment;
      pending = Buffer.alloc(0);
      if (bytes.length) yield bytes;
      start = newline + 1;
    }
  }
  assert.equal(pending.length, 0, `JSONL file ends without a newline: ${file}`);
}

async function* jsonl(file) {
  for await (const bytes of boundedLines(file, MAX_OBSERVATION_LINE_BYTES)) {
    const row = JSON.parse(bytes.toString("utf8"));
    assertObservation(row);
    yield row;
  }
}

function flushRun(rows, dir, ordinal) {
  if (!rows.length) return null;
  rows.sort(compareObservation);
  const file = path.join(dir, `run-${String(ordinal).padStart(8, "0")}.ndjson`);
  fs.writeFileSync(file, `${rows.map(canonicalJson).join("\n")}\n`);
  rows.length = 0;
  return file;
}

async function sortObservationLogs(logFiles, dir, maxRunBytes) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  let bytes = 0;
  const runs = [];
  for (const file of logFiles) {
    assert.ok(fs.existsSync(file), `missing completed shard source log: ${file}`);
    for await (const row of jsonl(file)) {
      const canonical = canonicalJson(row);
      rows.push(row);
      bytes += Buffer.byteLength(canonical) + 1;
      if (bytes >= maxRunBytes) {
        runs.push(flushRun(rows, dir, runs.length));
        bytes = 0;
      }
    }
  }
  const final = flushRun(rows, dir, runs.length);
  if (final) runs.push(final);
  return runs;
}

async function mergeObservationGroup(inputFiles, output) {
  const iterators = inputFiles.map((file) => jsonl(file));
  const current = await Promise.all(iterators.map((iterator) => iterator.next()));
  const handle = fs.openSync(output, "w", 0o600);
  let previous = null;
  let count = 0;
  const emit = (row) => {
    fs.writeSync(handle, `${canonicalJson(row)}\n`);
    count += 1;
  };
  try {
    while (true) {
      let selected = -1;
      for (let i = 0; i < current.length; i += 1) {
        if (current[i].done) continue;
        if (selected < 0 || compareObservation(current[i].value, current[selected].value) < 0) selected = i;
      }
      if (selected < 0) break;
      const row = current[selected].value;
      current[selected] = await iterators[selected].next();
      if (!previous || row.source_key !== previous.source_key) {
        if (previous) emit(previous);
        previous = row;
        continue;
      }
      assert.equal(sourceObservationIdentity(previous), sourceObservationIdentity(row),
        `source changed during this policy epoch: ${row.url}`);
      // Input is sorted by observed_at after identity, so retaining the first
      // observation is deterministic even when workers finish in another order.
    }
    if (previous) emit(previous);
  } finally {
    fs.closeSync(handle);
  }
  return count;
}

async function collapseRuns(runs, sortDir, fanIn) {
  let round = 0;
  let active = runs;
  while (active.length > 1) {
    const next = [];
    for (let start = 0; start < active.length; start += fanIn) {
      const file = path.join(sortDir, `merge-${String(round).padStart(4, "0")}-${String(next.length).padStart(6, "0")}.ndjson`);
      await mergeObservationGroup(active.slice(start, start + fanIn), file);
      next.push(file);
    }
    for (const file of active) fs.unlinkSync(file);
    active = next;
    round += 1;
  }
  return active[0] ?? null;
}

async function digestFile(file) {
  const hash = createHash("sha256");
  let count = 0;
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  for await (const unused of jsonl(file)) { void unused; count += 1; }
  return { digest: hash.digest("hex"), count };
}

async function writeCanonicalManifest(input, output) {
  const handle = fs.openSync(output, "w", 0o600);
  try {
    for await (const row of jsonl(input)) {
      fs.writeSync(handle, `${canonicalJson(manifestObservation(row))}\n`);
    }
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Merge completed shard logs into a source manifest.  This is called only
 * after verify.mjs has passed.  The final file is installed with link(2), so a
 * resume cannot silently overwrite an earlier completion receipt.
 */
export async function emitCompletionSourceManifest({
  outDir, logFiles, contract, configDigest,
  // Narrow test hooks prove the external merge remains correct across many
  // chunks without making a unit test manufacture gigabytes of log data.
  sortRunBytes = SOURCE_SORT_RUN_BYTES,
  fanIn = SOURCE_SORT_FAN_IN,
}) {
  assert.ok(contract, "a source contract is required for a completion manifest");
  const final = path.resolve(outDir, contract.policy.manifest.completion_manifest);
  assert.ok(final.startsWith(`${path.resolve(outDir)}${path.sep}`),
    "source_policy.manifest.completion_manifest must stay inside the global output");
  const sortDir = fs.mkdtempSync(path.join(outDir, ".source-manifest-runs-"));
  const temporary = path.join(outDir, `.source-manifest-${process.pid}.tmp`);
  try {
    assert.ok(Number.isSafeInteger(sortRunBytes) && sortRunBytes > 0, "sortRunBytes must be positive");
    assert.ok(Number.isSafeInteger(fanIn) && fanIn > 1, "fanIn must exceed one");
    const runs = await sortObservationLogs(logFiles, sortDir, sortRunBytes);
    assert.ok(runs.length > 0, "a source-backed completion has no source observations");
    const collapsed = await collapseRuns(runs, sortDir, fanIn);
    assert.ok(collapsed, "source observation merge produced no manifest run");
    await writeCanonicalManifest(collapsed, temporary);
    const receipt = await digestFile(temporary);
    assert.ok(receipt.count > 0, "a source-backed completion has an empty source manifest");
    fs.mkdirSync(path.dirname(final), { recursive: true });
    try {
      fs.linkSync(temporary, final);
      fs.chmodSync(final, 0o444);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await digestFile(final);
      assert.deepEqual(existing, receipt,
        `refusing to overwrite immutable source manifest with different bytes: ${final}`);
    }
    return {
      path: path.relative(outDir, final),
      digest: receipt.digest,
      observations: receipt.count,
      configDigest,
      sourcePolicyDigest: contract.digest,
      datasetEpoch: contract.datasetEpoch,
      format: contract.policy.manifest.format,
    };
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.rmSync(sortDir, { recursive: true, force: true });
  }
}

function compareRecordRow(a, b) {
  return codeUnitCompare(a.address, b.address) || codeUnitCompare(a.digest, b.digest);
}

async function* recordRows(file) {
  for await (const bytes of boundedLines(file, MAX_MERGE_RECORD_LINE_BYTES)) {
    const row = JSON.parse(bytes.toString("utf8"));
    assert.match(row?.address ?? "", /^\d+\/\d+\/\d+$/, `invalid terrain address in ${file}`);
    assert.match(row?.digest ?? "", /^[0-9a-f]{64}$/, `invalid terrain digest in ${file}`);
    assert.ok(typeof row?.data === "string", `missing terrain record bytes in ${file}`);
    assert.ok(Number.isSafeInteger(row?.duplicates) && row.duplicates >= 0, `invalid terrain duplicate count in ${file}`);
    yield row;
  }
}

function flushRecordRun(rows, dir, ordinal) {
  if (!rows.length) return null;
  rows.sort(compareRecordRow);
  const file = path.join(dir, `terrain-run-${String(ordinal).padStart(8, "0")}.ndjson`);
  fs.writeFileSync(file, `${rows.map(canonicalJson).join("\n")}\n`);
  rows.length = 0;
  return file;
}

async function writeRecordRuns(inputFiles, dir, addressForRecord, maxRunBytes) {
  const runs = [];
  const rows = [];
  let bytes = 0;
  for (const file of inputFiles) {
    for await (const record of iterateStreamFile(file)) {
      const address = addressForRecord(record);
      assert.match(address, /^\d+\/\d+\/\d+$/, `invalid terrain address from ${file}`);
      const row = { address, digest: sha256(record), data: Buffer.from(record).toString("base64"), duplicates: 0 };
      const size = Buffer.byteLength(row.data) + 256;
      assert.ok(size <= maxRunBytes, `terrain record at ${address} exceeds merge run bound ${maxRunBytes}`);
      rows.push(row);
      bytes += size;
      if (bytes >= maxRunBytes) {
        runs.push(flushRecordRun(rows, dir, runs.length));
        bytes = 0;
      }
    }
  }
  const final = flushRecordRun(rows, dir, runs.length);
  if (final) runs.push(final);
  return runs;
}

async function mergeRecordGroup(inputFiles, output) {
  const iterators = inputFiles.map((file) => recordRows(file));
  const current = await Promise.all(iterators.map((iterator) => iterator.next()));
  const handle = fs.openSync(output, "w", 0o600);
  try {
    let previous = null;
    while (true) {
      let selected = -1;
      for (let i = 0; i < current.length; i += 1) {
        if (current[i].done) continue;
        if (selected < 0 || compareRecordRow(current[i].value, current[selected].value) < 0) selected = i;
      }
      if (selected < 0) break;
      const row = current[selected].value;
      current[selected] = await iterators[selected].next();
      if (!previous || row.address !== previous.address) {
        if (previous) fs.writeSync(handle, `${canonicalJson(previous)}\n`);
        previous = row;
        continue;
      }
      assert.equal(previous.digest, row.digest, `shards disagree on duplicate address ${row.address}`);
      previous.duplicates += row.duplicates + 1;
    }
    if (previous) fs.writeSync(handle, `${canonicalJson(previous)}\n`);
  } finally {
    fs.closeSync(handle);
  }
}

async function collapseRecordRuns(runs, dir, fanIn) {
  let active = runs;
  let round = 0;
  while (active.length > 1) {
    const next = [];
    for (let start = 0; start < active.length; start += fanIn) {
      const file = path.join(dir, `terrain-merge-${String(round).padStart(4, "0")}-${String(next.length).padStart(6, "0")}.ndjson`);
      await mergeRecordGroup(active.slice(start, start + fanIn), file);
      next.push(file);
    }
    for (const file of active) fs.unlinkSync(file);
    active = next;
    round += 1;
  }
  if (!active.length) return null;
  // A single initial run is still only sorted, not de-duplicated. Normalize
  // it through the same merge path so one small shard set cannot bypass the
  // overlap check that multi-run input receives.
  const normalized = path.join(dir, `terrain-normalized-${String(round).padStart(4, "0")}.ndjson`);
  await mergeRecordGroup(active, normalized);
  fs.unlinkSync(active[0]);
  return normalized;
}

/** Stream, sort, de-duplicate and merge framed terrain stores without an O(N) address map. */
export async function mergeBoundedFramedStores({
  inputFiles, outputFile, addressForRecord,
  maxRunBytes = TERRAIN_SORT_RUN_BYTES, fanIn = SOURCE_SORT_FAN_IN,
}) {
  assert.ok(Number.isSafeInteger(maxRunBytes) && maxRunBytes > 0, "maxRunBytes must be positive");
  assert.ok(Number.isSafeInteger(fanIn) && fanIn > 1, "fanIn must exceed one");
  const outputDir = path.dirname(outputFile);
  const sortDir = fs.mkdtempSync(path.join(outputDir, ".terrain-merge-runs-"));
  try {
    const runs = await writeRecordRuns(inputFiles, sortDir, addressForRecord, maxRunBytes);
    const collapsed = await collapseRecordRuns(runs, sortDir, fanIn);
    const handle = fs.openSync(outputFile, "w", 0o600);
    const hash = createHash("sha256");
    let records = 0;
    let duplicates = 0;
    try {
      if (collapsed) {
        for await (const row of recordRows(collapsed)) {
          const record = Buffer.from(row.data, "base64");
          assert.equal(sha256(record), row.digest, `terrain merge run has corrupt bytes for ${row.address}`);
          const length = Buffer.alloc(4);
          length.writeUInt32LE(record.length);
          fs.writeSync(handle, length);
          fs.writeSync(handle, record);
          if (records > 0) hash.update("\n");
          hash.update(`${row.address}:${row.digest}`);
          records += 1;
          duplicates += row.duplicates;
        }
      }
    } finally {
      fs.closeSync(handle);
    }
    return { records, duplicates, recordSetDigest: hash.digest("hex") };
  } finally {
    fs.rmSync(sortDir, { recursive: true, force: true });
  }
}

function assertOceanAddress(address, file) {
  assert.match(address, /^\d+\/\d+\/\d+$/, `invalid ocean-skip address in ${file}`);
  return address;
}

async function* legacyOceanAddresses(file) {
  // Parse just the address array instead of JSON.parse()ing a global array.
  // These are simple ASCII x/y/z strings written by prior runners; reject
  // escapes and any changed shape rather than guessing at a broader JSON API.
  let state = "key";
  let inString = false;
  let escaped = false;
  let token = "";
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4096 })) {
    for (const char of chunk.toString("utf8")) {
      if (inString) {
        if (escaped) throw new Error(`escaped legacy ocean address/key is unsupported: ${file}`);
        if (char === "\\") { escaped = true; continue; }
        if (char === "\"") {
          inString = false;
          if (state === "key") state = token === "addresses" ? "colon" : "key";
          else if (state === "array") yield assertOceanAddress(token, file);
          token = "";
        } else {
          assert.ok(token.length < 128, `legacy ocean token is too long: ${file}`);
          token += char;
        }
        continue;
      }
      if (char === "\"") { inString = true; token = ""; continue; }
      if (state === "colon" && char === ":") state = "array-start";
      else if (state === "array-start" && char === "[") state = "array";
      else if (state === "array" && char === "]") state = "done";
    }
  }
  assert.equal(inString, false, `unterminated legacy ocean string: ${file}`);
  assert.equal(state, "done", `legacy ocean file has no complete addresses array: ${file}`);
}

async function* oceanAddresses(file) {
  if (file.endsWith(".lines") || file.endsWith(".ndjson")) {
    for await (const bytes of boundedLines(file, 128)) yield assertOceanAddress(bytes.toString("utf8"), file);
  } else {
    yield* legacyOceanAddresses(file);
  }
}

async function mergeOceanGroup(inputFiles, output) {
  const iterators = inputFiles.map((file) => oceanAddresses(file));
  const current = await Promise.all(iterators.map((iterator) => iterator.next()));
  const handle = fs.openSync(output, "w", 0o600);
  let previous = null;
  let count = 0;
  try {
    while (true) {
      let selected = -1;
      for (let i = 0; i < current.length; i += 1) {
        if (current[i].done) continue;
        if (selected < 0 || codeUnitCompare(current[i].value, current[selected].value) < 0) selected = i;
      }
      if (selected < 0) break;
      const address = current[selected].value;
      current[selected] = await iterators[selected].next();
      if (address !== previous) {
        fs.writeSync(handle, `${address}\n`);
        previous = address;
        count += 1;
      } else {
        throw new Error(`ocean-skip inputs overlap at ${address}; refusing to hide duplicate shard coverage`);
      }
    }
  } finally {
    fs.closeSync(handle);
  }
  return count;
}

function flushOceanRun(rows, dir, ordinal) {
  if (!rows.length) return null;
  rows.sort(codeUnitCompare);
  let duplicates = 0;
  let duplicateAddress = null;
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i] === rows[i - 1]) {
      duplicates += 1;
      duplicateAddress ??= rows[i];
    }
  }
  assert.equal(duplicates, 0,
    `ocean-skip inputs contain ${duplicates} duplicate address(es), first ${duplicateAddress}; refusing to hide shard overlap`);
  const run = path.join(dir, `ocean-run-${String(ordinal).padStart(8, "0")}.lines`);
  fs.writeFileSync(run, `${rows.join("\n")}\n`);
  rows.length = 0;
  return run;
}

/** Produce the stream-friendly global ocean-skip artifact, accepting legacy JSON inputs. */
export async function mergeOceanSkips({ inputFiles, outputFile, maxRunBytes = SOURCE_SORT_RUN_BYTES, fanIn = SOURCE_SORT_FAN_IN }) {
  assert.ok(Number.isSafeInteger(maxRunBytes) && maxRunBytes > 0, "maxRunBytes must be positive");
  assert.ok(Number.isSafeInteger(fanIn) && fanIn > 1, "fanIn must exceed one");
  const sortDir = fs.mkdtempSync(path.join(path.dirname(outputFile), ".ocean-skip-runs-"));
  try {
    const rows = [];
    const runs = [];
    let bytes = 0;
    for (const file of inputFiles) {
      if (!fs.existsSync(file)) continue;
      for await (const address of oceanAddresses(file)) {
        rows.push(address);
        bytes += Buffer.byteLength(address) + 1;
        if (bytes >= maxRunBytes) {
          runs.push(flushOceanRun(rows, sortDir, runs.length));
          bytes = 0;
        }
      }
    }
    if (rows.length) {
      runs.push(flushOceanRun(rows, sortDir, runs.length));
    }
    let active = runs;
    let round = 0;
    while (active.length > 1) {
      const next = [];
      for (let start = 0; start < active.length; start += fanIn) {
        const file = path.join(sortDir, `ocean-merge-${String(round).padStart(4, "0")}-${String(next.length).padStart(6, "0")}.lines`);
        await mergeOceanGroup(active.slice(start, start + fanIn), file);
        next.push(file);
      }
      for (const file of active) fs.unlinkSync(file);
      active = next; round += 1;
    }
    const final = active[0];
    if (final) fs.renameSync(final, outputFile);
    else fs.writeFileSync(outputFile, "");
    const hash = createHash("sha256");
    let count = 0;
    for await (const chunk of fs.createReadStream(outputFile)) hash.update(chunk);
    for await (const unused of oceanAddresses(outputFile)) { void unused; count += 1; }
    return { count, duplicates: 0, digest: hash.digest("hex"), path: path.basename(outputFile) };
  } finally {
    fs.rmSync(sortDir, { recursive: true, force: true });
  }
}
