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

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/**
 * A process-safe, bounded cache.  The global cache lock serializes capacity
 * reservation, eviction and publication. A per-URL producer lock serializes
 * a miss all the way through network fetch, so two workers cannot race a 200
 * and a 404 into different body/status generations. A published entry is one
 * immutable generation selected by an atomically renamed `current.json`.
 */
export class BoundedGranuleCache {
  constructor({
    dir,
    maxBytes,
    owner = `${process.pid}-${randomUUID()}`,
    pid = process.pid,
    now = () => Date.now(),
    isPidAlive = defaultPidAlive,
    leaseTtlMs = 30 * 60_000,
    lockWaitMs = 60_000,
  }) {
    assert.ok(dir, "cache dir is required");
    assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0, "cache maxBytes must be a positive safe integer");
    this.dir = path.resolve(dir);
    this.maxBytes = maxBytes;
    this.owner = owner;
    this.pid = pid;
    this.now = now;
    this.isPidAlive = isPidAlive;
    this.leaseTtlMs = leaseTtlMs;
    this.lockWaitMs = lockWaitMs;
    this.retries = 0;
    this.evictions = 0;
    for (const name of ["entries", "leases", "locks", "producer-locks"]) {
      fs.mkdirSync(path.join(this.dir, name), { recursive: true });
    }
  }

  key(url) { return urlCacheKey(url); }
  entryDir(key) { return path.join(this.dir, "entries", key); }
  pointerPath(key) { return path.join(this.entryDir(key), "current.json"); }
  leasePath(key) { return path.join(this.dir, "leases", `${key}.${this.owner}.json`); }

  paths(url) {
    const key = this.key(url);
    const current = readJson(this.pointerPath(key));
    const generation = current?.generation ?? "missing";
    const dir = this.entryDir(key);
    return {
      key,
      generation,
      body: path.join(dir, `${generation}.bin`),
      status: path.join(dir, `${generation}.status`),
      meta: path.join(dir, `${generation}.meta.json`),
      pointer: this.pointerPath(key),
      lease: this.leasePath(key),
    };
  }

  async withDirectoryLock(lockDir, action) {
    const ownerFile = path.join(lockDir, "owner.json");
    const token = randomUUID();
    const deadline = Date.now() + this.lockWaitMs;
    while (true) {
      try {
        fs.mkdirSync(lockDir);
        atomicWrite(ownerFile, `${JSON.stringify({ token, pid: this.pid, acquiredAt: this.now() })}\n`);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = readJson(ownerFile);
        const age = (() => { try { return this.now() - fs.statSync(lockDir).mtimeMs; } catch { return 0; } })();
        const dead = owner && !this.isPidAlive(Number(owner.pid));
        // A lock with no owner file can only be reclaimed after its bounded
        // grace period; otherwise another process between mkdir and write
        // could have its live lock stolen.
        if (dead || (!owner && age > this.leaseTtlMs)) {
          try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for cache lock ${path.basename(lockDir)}`);
        await sleep(10);
      }
    }
    try {
      return await action();
    } finally {
      const owner = readJson(ownerFile);
      if (owner?.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  withGlobalLock(action) { return this.withDirectoryLock(path.join(this.dir, "locks", "cache.lock"), action); }
  withProducerLock(key, action) { return this.withDirectoryLock(path.join(this.dir, "producer-locks", `${key}.lock`), action); }

  reclaimStaleLeasesUnlocked() {
    const leaseDir = path.join(this.dir, "leases");
    for (const name of fs.readdirSync(leaseDir)) {
      const file = path.join(leaseDir, name);
      const lease = readJson(file);
      const age = (() => { try { return this.now() - fs.statSync(file).mtimeMs; } catch { return 0; } })();
      const dead = lease && !this.isPidAlive(Number(lease.pid));
      if (dead || (!lease && age > this.leaseTtlMs)) safeUnlink(file);
    }
  }

  hasLeaseUnlocked(key) {
    const prefix = `${key}.`;
    return fs.readdirSync(path.join(this.dir, "leases")).some((name) => name.startsWith(prefix));
  }

  readEntryUnlocked(url) {
    const entry = this.paths(url);
    if (!fs.existsSync(entry.body) || !fs.existsSync(entry.status) || !fs.existsSync(entry.meta)) return null;
    const status = Number(fs.readFileSync(entry.status, "utf8"));
    if (!Number.isInteger(status)) return null;
    return { status, body: fs.readFileSync(entry.body), hit: true, entry };
  }

  cleanupEntryUnlocked(key) {
    const dir = this.entryDir(key);
    const pointer = readJson(this.pointerPath(key));
    if (!pointer?.generation || !fs.existsSync(dir)) return;
    const keep = new Set(["current.json", `${pointer.generation}.bin`, `${pointer.generation}.status`, `${pointer.generation}.meta.json`]);
    for (const name of fs.readdirSync(dir)) {
      if (!keep.has(name)) safeUnlink(path.join(dir, name));
    }
  }

  entriesUnlocked() {
    const root = path.join(this.dir, "entries");
    const rows = [];
    for (const key of fs.readdirSync(root)) {
      this.cleanupEntryUnlocked(key);
      const pointer = readJson(this.pointerPath(key));
      if (!pointer?.generation) continue;
      const dir = this.entryDir(key);
      const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
      if (!files.every((file) => fs.existsSync(file))) continue;
      rows.push({
        key,
        dir,
        bytes: files.reduce((total, file) => total + fs.statSync(file).size, 0),
        lastUsed: Number(pointer.lastUsed ?? 0),
      });
    }
    return rows;
  }

  usageBytes() { return this.entriesUnlocked().reduce((total, entry) => total + entry.bytes, 0); }

  evictForUnlocked(requiredBytes) {
    assert.ok(requiredBytes <= this.maxBytes, `one granule (${requiredBytes} B) exceeds cache cap ${this.maxBytes} B`);
    let used = this.usageBytes();
    if (used + requiredBytes <= this.maxBytes) return used;
    const candidates = this.entriesUnlocked()
      .filter((entry) => !this.hasLeaseUnlocked(entry.key))
      .sort((a, b) => a.lastUsed - b.lastUsed || a.key.localeCompare(b.key));
    for (const entry of candidates) {
      if (used + requiredBytes <= this.maxBytes) break;
      fs.rmSync(entry.dir, { recursive: true, force: true });
      used -= entry.bytes;
      this.evictions += 1;
    }
    assert.ok(used + requiredBytes <= this.maxBytes, `cache cap ${this.maxBytes} B is exhausted by leased granules; release completed cells or raise cache_max_bytes`);
    return used;
  }

  publishUnlocked(url, status, body) {
    const key = this.key(url);
    const dir = this.entryDir(key);
    fs.mkdirSync(dir, { recursive: true });
    const generation = randomUUID();
    const bytes = Buffer.from(body);
    const metadata = `${JSON.stringify({ url, status, bytes: bytes.length, generation })}\n`;
    const pointer = `${JSON.stringify({ generation, lastUsed: this.now() })}\n`;
    const requiredBytes = bytes.length + Buffer.byteLength(`${status}\n`) + Buffer.byteLength(metadata) + Buffer.byteLength(pointer);
    this.evictForUnlocked(requiredBytes);
    atomicWrite(path.join(dir, `${generation}.bin`), bytes);
    atomicWrite(path.join(dir, `${generation}.status`), `${status}\n`);
    atomicWrite(path.join(dir, `${generation}.meta.json`), metadata);
    atomicWrite(this.pointerPath(key), pointer);
    return this.readEntryUnlocked(url);
  }

  async acquire(url) {
    const key = this.key(url);
    await this.withGlobalLock(async () => {
      this.reclaimStaleLeasesUnlocked();
      atomicWrite(this.leasePath(key), `${JSON.stringify({ owner: this.owner, pid: this.pid, acquiredAt: this.now() })}\n`);
    });
    return this.paths(url);
  }

  async release(url) {
    await this.withGlobalLock(async () => safeUnlink(this.leasePath(this.key(url))));
  }

  async releaseAll() {
    await this.withGlobalLock(async () => {
      const suffix = `.${this.owner}.json`;
      for (const name of fs.readdirSync(path.join(this.dir, "leases"))) {
        if (name.endsWith(suffix)) safeUnlink(path.join(this.dir, "leases", name));
      }
    });
  }

  // Synchronous read for the runner's synchronous hostcall bridge.  Callers
  // must already hold their URL lease, which prevents eviction of its current
  // immutable generation while the flow consumes it.
  read(url) { return this.readEntryUnlocked(url); }

  async get(url) {
    return this.withGlobalLock(async () => {
      this.reclaimStaleLeasesUnlocked();
      const cached = this.readEntryUnlocked(url);
      if (!cached) return null;
      const pointer = readJson(cached.entry.pointer);
      atomicWrite(cached.entry.pointer, `${JSON.stringify({ ...pointer, lastUsed: this.now() })}\n`);
      return { status: cached.status, body: cached.body, hit: true };
    });
  }

  async put(url, status, body) {
    return this.withGlobalLock(async () => {
      this.reclaimStaleLeasesUnlocked();
      return { ...this.publishUnlocked(url, status, body), hit: false };
    });
  }

  async fetch(url, options = {}) {
    await this.acquire(url);
    const cached = await this.get(url);
    if (cached) return cached;
    const key = this.key(url);
    return this.withProducerLock(key, async () => {
      const appeared = await this.get(url);
      if (appeared) return appeared;
      let retries = 0;
      const response = await fetchWithRetry(url, {
        ...options,
        onRetry: (event) => { retries += 1; options.onRetry?.(event); },
      });
      this.retries += retries;
      const body = response.ok ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
      return this.put(url, response.status, body);
    });
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
