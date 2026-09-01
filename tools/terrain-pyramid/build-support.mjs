// Shared bounded-build primitives for the off-fleet terrain pyramid lane.
//
// These deliberately know nothing about the terrain encoder.  Keeping retry,
// cache accounting and shard state here makes them testable without cutting a
// tile or contacting Copernicus, and keeps the runner's host boundary small.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const GLOBAL_STATE_VERSION = 1;

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

// The stream order is an execution detail of independent workers.  Parity is
// the complete address-to-record-byte mapping, sorted before it is hashed.
export function recordSetDigest(entries) {
  return sha256([...entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, digest]) => `${key}:${digest}`).join("\n"));
}

export function urlCacheKey(url) {
  return sha256(url).slice(0, 32);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Fetch with deterministic exponential backoff.  A retry records neither a
 * cache success nor a source result; callers only persist the final response.
 * That prevents a partial or transient response becoming a durable resume
 * input.
 */
export async function fetchWithRetry(url, {
  fetchImpl = fetch,
  retries = 4,
  retryBaseMs = 250,
  sleepImpl = sleep,
  onRetry = () => {},
} = {}) {
  assert.ok(Number.isInteger(retries) && retries >= 0, "retries must be a non-negative integer");
  assert.ok(Number.isFinite(retryBaseMs) && retryBaseMs >= 0, "retryBaseMs must be non-negative");
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!retryableStatus(response.status) || attempt === retries) return response;
      lastError = new Error(`transient HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
    }
    const delayMs = retryBaseMs * 2 ** attempt;
    onRetry({ url, attempt: attempt + 1, delayMs, error: lastError });
    await sleepImpl(delayMs);
  }
  throw lastError ?? new Error(`fetch retry loop ended unexpectedly for ${url}`);
}

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);
}

function readJson(file, fallback = null) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

/**
 * A disk LRU shared safely enough for independent build processes.  A process
 * leases every URL from planning until its flow and WasmEdge parity pass have
 * consumed it; eviction never removes leased entries.  Files are atomically
 * renamed, so a competing producer sees either a completed cache record or a
 * miss and may harmlessly refetch it, never a truncated granule.
 */
export class BoundedGranuleCache {
  constructor({ dir, maxBytes, owner = `${process.pid}-${randomUUID()}`, now = () => Date.now() }) {
    assert.ok(dir, "cache dir is required");
    assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0, "cache maxBytes must be a positive safe integer");
    this.dir = path.resolve(dir);
    this.maxBytes = maxBytes;
    this.owner = owner;
    this.now = now;
    this.retries = 0;
    this.evictions = 0;
    fs.mkdirSync(path.join(this.dir, "leases"), { recursive: true });
  }

  paths(url) {
    const key = urlCacheKey(url);
    return {
      key,
      body: path.join(this.dir, `${key}.bin`),
      status: path.join(this.dir, `${key}.status`),
      meta: path.join(this.dir, `${key}.meta.json`),
      lease: path.join(this.dir, "leases", `${key}.${this.owner}`),
    };
  }

  acquire(url) {
    const entry = this.paths(url);
    atomicWrite(entry.lease, `${this.now()}\n`);
    return entry;
  }

  release(url) {
    safeUnlink(this.paths(url).lease);
  }

  releaseAll() {
    const suffix = `.${this.owner}`;
    for (const name of fs.readdirSync(path.join(this.dir, "leases"))) {
      if (name.endsWith(suffix)) safeUnlink(path.join(this.dir, "leases", name));
    }
  }

  hasLease(key) {
    const prefix = `${key}.`;
    return fs.readdirSync(path.join(this.dir, "leases")).some((name) => name.startsWith(prefix));
  }

  entries() {
    const rows = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".bin")) continue;
      const key = name.slice(0, -4);
      const body = path.join(this.dir, name);
      const meta = readJson(path.join(this.dir, `${key}.meta.json`), {});
      rows.push({
        key,
        body,
        status: path.join(this.dir, `${key}.status`),
        meta: path.join(this.dir, `${key}.meta.json`),
        // Count every cache-owned byte, not merely DEM bodies.  This keeps a
        // global run from trading the old unbounded granule directory for an
        // unbounded directory of status/metadata sidecars.
        bytes: [body, path.join(this.dir, `${key}.status`), path.join(this.dir, `${key}.meta.json`)]
          .filter((file) => fs.existsSync(file))
          .reduce((total, file) => total + fs.statSync(file).size, 0),
        lastUsed: Number(meta.lastUsed ?? 0),
      });
    }
    return rows;
  }

  usageBytes() {
    return this.entries().reduce((total, entry) => total + entry.bytes, 0);
  }

  evictFor(requiredBytes) {
    assert.ok(requiredBytes <= this.maxBytes, `one granule (${requiredBytes} B) exceeds cache cap ${this.maxBytes} B`);
    let used = this.usageBytes();
    if (used + requiredBytes <= this.maxBytes) return used;
    const candidates = this.entries()
      .filter((entry) => !this.hasLease(entry.key))
      .sort((a, b) => a.lastUsed - b.lastUsed || a.key.localeCompare(b.key));
    for (const entry of candidates) {
      if (used + requiredBytes <= this.maxBytes) break;
      safeUnlink(entry.body);
      safeUnlink(entry.status);
      safeUnlink(entry.meta);
      used -= entry.bytes;
      this.evictions += 1;
    }
    assert.ok(
      used + requiredBytes <= this.maxBytes,
      `cache cap ${this.maxBytes} B is exhausted by leased granules; release completed cells or raise cache_max_bytes`,
    );
    return used;
  }

  get(url) {
    const entry = this.paths(url);
    if (!fs.existsSync(entry.status) || !fs.existsSync(entry.body)) return null;
    const status = Number(fs.readFileSync(entry.status, "utf8"));
    if (!Number.isInteger(status)) return null;
    const body = fs.readFileSync(entry.body);
    atomicWrite(entry.meta, `${JSON.stringify({ url, bytes: body.length, lastUsed: this.now() })}\n`);
    return { status, body, hit: true };
  }

  put(url, status, body) {
    const entry = this.paths(url);
    const bytes = Buffer.from(body);
    const statusBytes = Buffer.byteLength(`${status}\n`);
    const metadata = `${JSON.stringify({ url, bytes: bytes.length, lastUsed: this.now() })}\n`;
    this.evictFor(bytes.length + statusBytes + Buffer.byteLength(metadata));
    atomicWrite(entry.body, bytes);
    atomicWrite(entry.status, `${status}\n`);
    atomicWrite(entry.meta, metadata);
    return { status, body: bytes, hit: false };
  }

  async fetch(url, options = {}) {
    this.acquire(url);
    const cached = this.get(url);
    if (cached) return cached;
    let retries = 0;
    const response = await fetchWithRetry(url, {
      ...options,
      onRetry: (event) => {
        retries += 1;
        options.onRetry?.(event);
      },
    });
    this.retries += retries;
    const body = response.ok ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
    return this.put(url, response.status, body);
  }
}

function splitRegion(region, shardCount) {
  const west = Number(region.west);
  const east = Number(region.east);
  assert.ok(Number.isFinite(west) && Number.isFinite(east) && east > west, `region ${region.name ?? "(unnamed)"} needs west < east`);
  const cuts = [west];
  // Start strictly east of the existing west edge: an integral west bound is
  // already in `cuts`, and repeating it would create an empty shard region.
  for (let degree = Math.floor(west) + 1; degree < east; degree += 1) cuts.push(degree);
  cuts.push(east);
  const output = Array.from({ length: shardCount }, () => []);
  for (let index = 0; index < cuts.length - 1; index += 1) {
    // Contiguous assignment minimises cross-shard boundary work while keeping
    // the partition deterministic from config bytes alone.
    const shard = Math.min(shardCount - 1, Math.floor((index * shardCount) / (cuts.length - 1)));
    output[shard].push({
      ...region,
      name: `${region.name ?? "region"}--shard-${String(shard).padStart(3, "0")}-slice-${String(index).padStart(4, "0")}`,
      west: cuts[index],
      east: cuts[index + 1],
    });
  }
  return output;
}

/** Build deterministic, non-overlapping longitude slices for independent runs. */
export function makeShardConfigs(runConfig, shardCount, { outDir, cacheDir, cacheMaxBytes } = {}) {
  assert.ok(Number.isInteger(shardCount) && shardCount > 0, "shardCount must be a positive integer");
  const flow = runConfig.flow_config ?? {};
  assert.ok(Array.isArray(flow.regions) && flow.regions.length > 0, "flow_config.regions is required");
  const regions = Array.from({ length: shardCount }, () => []);
  for (const region of flow.regions) {
    const pieces = splitRegion(region, shardCount);
    for (let shard = 0; shard < shardCount; shard += 1) regions[shard].push(...pieces[shard]);
  }
  return regions.map((shardRegions, shard) => ({
    ...runConfig,
    out: undefined,
    cache_dir: cacheDir,
    cache_max_bytes: cacheMaxBytes,
    global_shard: { index: shard, count: shardCount, config_digest: sha256(canonicalJson(runConfig)) },
    flow_config: { ...flow, regions: shardRegions },
    shard_out: outDir ? path.join(outDir, "shards", `shard-${String(shard).padStart(3, "0")}`) : undefined,
  }));
}

export function statePath(outDir) {
  return path.join(outDir, "global-build-state.json");
}

export function initializeGlobalState(outDir, runConfig, shardCount) {
  const file = statePath(outDir);
  const digest = sha256(canonicalJson(runConfig));
  const existing = readJson(file);
  if (existing) {
    assert.equal(existing.version, GLOBAL_STATE_VERSION, "unsupported global build state version");
    assert.equal(existing.configDigest, digest, "refusing to resume a state written for different config bytes");
    assert.equal(existing.shards.length, shardCount, "refusing to resume with a different shard count");
    return existing;
  }
  const state = {
    version: GLOBAL_STATE_VERSION,
    configDigest: digest,
    createdAt: new Date().toISOString(),
    shards: Array.from({ length: shardCount }, (_, index) => ({ index, status: "pending", attempts: 0 })),
  };
  atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function saveGlobalState(outDir, state) {
  atomicWrite(statePath(outDir), `${JSON.stringify(state, null, 2)}\n`);
}

export function markShard(state, index, status, detail = {}) {
  const shard = state.shards[index];
  assert.ok(shard, `unknown shard ${index}`);
  if (status === "running") shard.attempts += 1;
  Object.assign(shard, detail, { status, updatedAt: new Date().toISOString() });
  return shard;
}
