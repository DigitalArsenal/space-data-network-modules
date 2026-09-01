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

// Read-only consumers (the accuracy lane) must use the same immutable
// generation selected by the bounded cache, rather than the pre-generation
// `<key>.bin` layout used by old regional runs.  This deliberately does not
// update LRU state or acquire a lease: a completed build owns the cache during
// its post-build verification and generation files are immutable.
export function readGenerationCacheEntry(cacheDir, url) {
  const key = urlCacheKey(url);
  const dir = path.join(cacheDir, "entries", key);
  let pointer;
  try { pointer = JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8")); } catch { return null; }
  if (!pointer?.generation || typeof pointer.generation !== "string") return null;
  const base = path.join(dir, pointer.generation);
  try {
    const status = Number(fs.readFileSync(`${base}.status`, "utf8").trim());
    if (!Number.isInteger(status)) return null;
    return { status, body: fs.readFileSync(`${base}.bin`) };
  } catch {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded external-sort primitive for global verifier facts.  Callers choose
// an intentionally small run size; no complete address set is retained.
export function writeSortedJsonRuns(dir, facts, { maxRows = 4096, compare = (a, b) => String(a.key).localeCompare(String(b.key)) } = {}) {
  assert.ok(Number.isSafeInteger(maxRows) && maxRows > 0, "maxRows must be positive");
  fs.mkdirSync(dir, { recursive: true });
  const runs = []; let rows = [];
  const flush = () => {
    if (!rows.length) return;
    rows.sort(compare);
    const file = path.join(dir, `run-${String(runs.length).padStart(6, "0")}.ndjson`);
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    runs.push(file); rows = [];
  };
  for (const fact of facts) { rows.push(fact); if (rows.length >= maxRows) flush(); }
  flush();
  return runs;
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
  onDiscardResponse = () => {},
} = {}) {
  assert.ok(Number.isInteger(retries) && retries >= 0, "retries must be a non-negative integer");
  assert.ok(Number.isFinite(retryBaseMs) && retryBaseMs >= 0, "retryBaseMs must be non-negative");
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!retryableStatus(response.status) || attempt === retries) return response;
      lastError = new Error(`transient HTTP ${response.status}`);
      // A source observer owns a live timer/metadata slot for every response.
      // Dispose the rejected attempt before retrying the same URL, otherwise
      // its next fetch is (correctly) seen as a duplicate in-flight request.
      try {
        if (response.body?.cancel) await response.body.cancel();
        else if (response.body?.getReader) {
          const reader = response.body.getReader();
          try { await reader.cancel(); } finally { reader.releaseLock?.(); }
        } else if (typeof response.arrayBuffer === "function") {
          await response.arrayBuffer();
        }
      } finally {
        await onDiscardResponse({ url, response, attempt });
      }
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

function responseHeader(response, name) {
  try {
    if (typeof response.headers?.get === "function") return response.headers.get(name) ?? undefined;
    if (response.headers && typeof response.headers === "object") return response.headers[name] ?? response.headers[name.toLowerCase()];
  } catch {}
  return undefined;
}

async function readResponseBodyBounded(response, {
  maxBytes = Infinity,
  requireStreaming = false,
  onLimit = undefined,
} = {}) {
  assert.ok(maxBytes === Infinity || (Number.isSafeInteger(maxBytes) && maxBytes >= 0),
    "response maxBytes must be a non-negative safe integer");
  const contentLength = responseHeader(response, "content-length");
  if (contentLength !== undefined) {
    assert.match(String(contentLength).trim(), /^\d+$/, "response Content-Length must be a decimal byte count");
    const announced = Number(contentLength);
    assert.ok(Number.isSafeInteger(announced), "response Content-Length exceeds safe integer range");
    if (announced > maxBytes) {
      await onLimit?.({ announced, maxBytes });
      try { await response.body?.cancel?.(); } catch {}
      throw new Error(`source response Content-Length ${announced} exceeds approved ${maxBytes}-byte object cap`);
    }
  }
  const chunks = [];
  let total = 0;
  const append = async (chunk) => {
    const bytes = Buffer.from(chunk);
    if (bytes.length > maxBytes - total) {
      await onLimit?.({ announced: total + bytes.length, maxBytes });
      throw new Error(`source response body exceeds approved ${maxBytes}-byte object cap`);
    }
    chunks.push(bytes);
    total += bytes.length;
  };
  const stream = response.body;
  if (stream?.getReader) {
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        await append(next.value);
      }
    } catch (error) {
      try { await reader.cancel(error); } catch {}
      throw error;
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    try {
      for await (const chunk of stream) await append(chunk);
    } catch (error) {
      stream.destroy?.(error);
      throw error;
    }
    return Buffer.concat(chunks, total);
  }
  // A no-content response is a valid streamed zero-byte object. Any body we
  // need to consume for a source-policy cut must expose a stream; arrayBuffer
  // would allocate it before the cap could be enforced.
  if (requireStreaming) {
    if (stream == null && (String(contentLength).trim() === "0" || response.status === 204)) return Buffer.alloc(0);
    throw new Error("source response has no readable streaming body");
  }
  const fallback = Buffer.from(await response.arrayBuffer());
  await append(fallback);
  return Buffer.concat(chunks, total);
}

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function readJson(file, fallback = null) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch {
    // Lock/lease metadata is advisory only when it can be authenticated below.
    // A torn or corrupt JSON file must never make every future process throw
    // forever; callers treat this as unknown ownership and reclaim after TTL.
    return fallback;
  }
}

function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function defaultProcessIdentity(pid) {
  try {
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    // /proc/pid/stat field 22 is starttime; afterCommand starts at field 3.
    const start = afterCommand[19];
    return start ? { pid, startToken: `${boot}:${start}` } : { pid, startToken: null };
  } catch {
    return { pid, startToken: null };
  }
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
    processIdentity = defaultProcessIdentity,
    leaseTtlMs = 30 * 60_000,
    // On platforms without a process start token (notably macOS), a live PID
    // alone cannot prove ownership because PIDs can be reused. Holders write a
    // heartbeat every 20 s; five minutes without one is a bounded crash/stall
    // recovery window, deliberately separate from the 30-minute cache lease.
    identitylessHeartbeatTtlMs = 5 * 60_000,
    heartbeatIntervalMs = 20_000,
    // Test-only interleave hook for the stale-owner/recovery race.
    onHeartbeatBeforeWrite = () => {},
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
    this.processIdentity = processIdentity;
    this.identity = processIdentity(pid);
    this.leaseTtlMs = leaseTtlMs;
    assert.ok(Number.isSafeInteger(identitylessHeartbeatTtlMs) && identitylessHeartbeatTtlMs > 0, "identitylessHeartbeatTtlMs must be a positive safe integer");
    assert.ok(Number.isSafeInteger(heartbeatIntervalMs) && heartbeatIntervalMs > 0 && heartbeatIntervalMs < identitylessHeartbeatTtlMs, "heartbeatIntervalMs must be positive and shorter than identitylessHeartbeatTtlMs");
    this.identitylessHeartbeatTtlMs = identitylessHeartbeatTtlMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.onHeartbeatBeforeWrite = onHeartbeatBeforeWrite;
    this.lockWaitMs = lockWaitMs;
    this.retries = 0;
    this.evictions = 0;
    this.leaseHeartbeats = new Map();
    for (const name of ["entries", "leases", "lease-heartbeats", "locks", "producer-locks"]) {
      fs.mkdirSync(path.join(this.dir, name), { recursive: true });
    }
  }

  key(url) { return urlCacheKey(url); }
  entryDir(key) { return path.join(this.dir, "entries", key); }
  pointerPath(key) { return path.join(this.entryDir(key), "current.json"); }
  leasePath(key) { return path.join(this.dir, "leases", `${key}.${this.owner}.json`); }
  heartbeatPath(ownerFile, token) {
    if (ownerFile.startsWith(path.join(this.dir, "leases") + path.sep)) {
      return path.join(this.dir, "lease-heartbeats", `${path.basename(ownerFile)}.${token}.heartbeat`);
    }
    return path.join(path.dirname(ownerFile), `.heartbeat-${token}`);
  }

  ownerRecord(token = undefined) {
    return { ...(token ? { token } : {}), owner: this.owner, pid: this.pid, identity: this.identity, acquiredAt: this.now() };
  }

  heartbeatAge(ownerFile, owner, fallbackAge) {
    if (!owner?.token) return fallbackAge;
    try {
      const heartbeat = Number(fs.readFileSync(this.heartbeatPath(ownerFile, owner.token), "utf8"));
      return Number.isFinite(heartbeat) ? Math.max(0, this.now() - heartbeat) : fallbackAge;
    } catch {
      return fallbackAge;
    }
  }

  // Returns true only for a live owner that either has a matching durable
  // process identity or, where that cannot be observed, a recent heartbeat.
  // A reused PID with no start token is conservatively protected for the short
  // heartbeat crash bound, never for the ordinary (30-minute) lease TTL.
  ownerStillMatches(owner, ownerFile, age) {
    if (!owner || !this.isPidAlive(Number(owner.pid))) return false;
    const recorded = owner.identity?.startToken;
    const observed = this.processIdentity(Number(owner.pid))?.startToken;
    if (recorded && observed) return recorded === observed;
    return this.heartbeatAge(ownerFile, owner, age) <= this.identitylessHeartbeatTtlMs;
  }

  refreshHeartbeat(file, token) {
    const owner = readJson(file);
    // Never write a successor's metadata. Heartbeats are token-named sidecars:
    // an old owner that resumes after its directory was reclaimed can at worst
    // leave an ignored old-token pulse, never replace the new owner's record.
    if (!owner || owner.token !== token) return false;
    this.onHeartbeatBeforeWrite({ file, token });
    try {
      // Deliberately NOT atomicWrite: that helper mkdirs its parent. A stale
      // timer after recovery must get ENOENT, not recreate an owner directory
      // containing only a heartbeat. If a successor raced in, the post-write
      // token check removes this old token's otherwise harmless sidecar.
      fs.writeFileSync(this.heartbeatPath(file, token), `${this.now()}\n`);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    const after = readJson(file);
    if (!after || after.token !== token) {
      safeUnlink(this.heartbeatPath(file, token));
      return false;
    }
    return true;
  }

  startHeartbeat(file, token) {
    this.refreshHeartbeat(file, token);
    const timer = setInterval(() => {
      try { this.refreshHeartbeat(file, token); } catch {}
    }, this.heartbeatIntervalMs);
    timer.unref?.();
    return timer;
  }

  stopLeaseHeartbeat(file) {
    const heartbeat = this.leaseHeartbeats.get(file);
    if (heartbeat) {
      clearInterval(heartbeat.timer);
      safeUnlink(this.heartbeatPath(file, heartbeat.token));
    }
    this.leaseHeartbeats.delete(file);
  }

  removeLeaseHeartbeats(file, token = null) {
    const root = path.join(this.dir, "lease-heartbeats");
    const prefix = `${path.basename(file)}.`;
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith(prefix) && (!token || name === `${path.basename(file)}.${token}.heartbeat`)) {
        safeUnlink(path.join(root, name));
      }
    }
  }

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
        atomicWrite(ownerFile, `${JSON.stringify(this.ownerRecord(token))}\n`);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = readJson(ownerFile);
        const age = (() => { try { return this.now() - fs.statSync(lockDir).mtimeMs; } catch { return 0; } })();
        const ownerValid = owner && Number.isInteger(Number(owner.pid));
        const dead = ownerValid && !this.isPidAlive(Number(owner.pid));
        const staleOwner = ownerValid && !this.ownerStillMatches(owner, ownerFile, age);
        // A lock with no owner file can only be reclaimed after its bounded
        // grace period; otherwise another process between mkdir and write
        // could have its live lock stolen.
        // A matching process identity is the only unbounded lock owner. An
        // identity-less live owner remains safe while its holder heartbeat is
        // fresh; a missing/corrupt owner receives the longer mkdir/write grace.
        if (dead || staleOwner || (!ownerValid && age > this.leaseTtlMs)) {
          try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for cache lock ${path.basename(lockDir)}`);
        await sleep(10);
      }
    }
    const heartbeat = this.startHeartbeat(ownerFile, token);
    try {
      return await action();
    } finally {
      clearInterval(heartbeat);
      safeUnlink(this.heartbeatPath(ownerFile, token));
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
      const valid = lease && Number.isInteger(Number(lease.pid));
      const dead = valid && !this.isPidAlive(Number(lease.pid));
      const staleOwner = valid && !this.ownerStillMatches(lease, file, age);
      // A dead/reused identity or an identity-less owner with no fresh holder
      // heartbeat is stale. Corrupt metadata gets the longer mkdir/write grace.
      if (dead || staleOwner || (!valid && age > this.leaseTtlMs)) {
        safeUnlink(file);
        this.removeLeaseHeartbeats(file, lease?.token);
      }
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
    if (!fs.existsSync(dir)) return false;
    if (!pointer?.generation) {
      fs.rmSync(dir, { recursive: true, force: true });
      return false;
    }
    const keep = new Set(["current.json", `${pointer.generation}.bin`, `${pointer.generation}.status`, `${pointer.generation}.meta.json`]);
    if (![...keep].every((name) => fs.existsSync(path.join(dir, name)))) {
      fs.rmSync(dir, { recursive: true, force: true });
      return false;
    }
    for (const name of fs.readdirSync(dir)) {
      if (!keep.has(name)) safeUnlink(path.join(dir, name));
    }
    return true;
  }

  entriesUnlocked({ reclaimOrphans = false } = {}) {
    const root = path.join(this.dir, "entries");
    const rows = [];
    for (const key of fs.readdirSync(root)) {
      if (reclaimOrphans && !this.cleanupEntryUnlocked(key)) continue;
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

  async usageBytesLocked() {
    return this.withGlobalLock(async () => {
      this.reclaimStaleLeasesUnlocked();
      return this.entriesUnlocked({ reclaimOrphans: true }).reduce((total, entry) => total + entry.bytes, 0);
    });
  }

  evictForUnlocked(requiredBytes) {
    assert.ok(requiredBytes <= this.maxBytes, `one granule (${requiredBytes} B) exceeds cache cap ${this.maxBytes} B`);
    let used = this.entriesUnlocked({ reclaimOrphans: true }).reduce((total, entry) => total + entry.bytes, 0);
    if (used + requiredBytes <= this.maxBytes) return used;
    const candidates = this.entriesUnlocked({ reclaimOrphans: true })
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
    const generation = randomUUID();
    const bytes = Buffer.from(body);
    const metadata = `${JSON.stringify({ url, status, bytes: bytes.length, generation })}\n`;
    const pointer = `${JSON.stringify({ generation, lastUsed: this.now() })}\n`;
    const requiredBytes = bytes.length + Buffer.byteLength(`${status}\n`) + Buffer.byteLength(metadata) + Buffer.byteLength(pointer);
    this.evictForUnlocked(requiredBytes);
    const dir = this.entryDir(key);
    fs.mkdirSync(dir, { recursive: true });
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
      this.entriesUnlocked({ reclaimOrphans: true });
      const lease = this.leasePath(key);
      const token = randomUUID();
      atomicWrite(lease, `${JSON.stringify(this.ownerRecord(token))}\n`);
      this.stopLeaseHeartbeat(lease);
      this.leaseHeartbeats.set(lease, { timer: this.startHeartbeat(lease, token), token });
    });
    return this.paths(url);
  }

  async release(url) {
    const lease = this.leasePath(this.key(url));
    this.stopLeaseHeartbeat(lease);
    await this.withGlobalLock(async () => {
      safeUnlink(lease);
      this.removeLeaseHeartbeats(lease);
    });
  }

  async releaseAll() {
    await this.withGlobalLock(async () => {
      const suffix = `.${this.owner}.json`;
      for (const name of fs.readdirSync(path.join(this.dir, "leases"))) {
        if (name.endsWith(suffix)) {
          const lease = path.join(this.dir, "leases", name);
          this.stopLeaseHeartbeat(lease);
          safeUnlink(lease);
          this.removeLeaseHeartbeats(lease);
        }
      }
    });
  }

  // Synchronous read for the runner's synchronous hostcall bridge.  Callers
  // must already hold their URL lease, which prevents eviction of its current
  // immutable generation while the flow consumes it.
  read(url) { return this.readEntryUnlocked(url); }

  async get(url, { beforeUse = undefined } = {}) {
    return this.withGlobalLock(async () => {
      this.reclaimStaleLeasesUnlocked();
      this.entriesUnlocked({ reclaimOrphans: true });
      const cached = this.readEntryUnlocked(url);
      if (!cached) return null;
      // A source-backed caller may make cache visibility contingent on a
      // receipt.  Run this while the current pointer is still protected by
      // the cache lock so an unattributed generation is never returned.
      await beforeUse?.({ url, status: cached.status, body: cached.body });
      const pointer = readJson(cached.entry.pointer);
      atomicWrite(cached.entry.pointer, `${JSON.stringify({ ...pointer, lastUsed: this.now() })}\n`);
      return { status: cached.status, body: cached.body, hit: true };
    });
  }

  async put(url, status, body, { beforePublish = undefined } = {}) {
    return this.withGlobalLock(async () => {
      this.reclaimStaleLeasesUnlocked();
      this.entriesUnlocked({ reclaimOrphans: true });
      // The immutable body is complete, but current.json has not been made
      // visible yet.  Provenance receipts belong in this exact window: a
      // callback failure leaves no cache generation for another worker to use.
      await beforePublish?.({ url, status, body: Buffer.from(body) });
      return { ...this.publishUnlocked(url, status, body), hit: false };
    });
  }

  async fetch(url, options = {}) {
    await this.acquire(url);
    const cached = await this.get(url, { beforeUse: options.beforeUse });
    if (cached) return cached;
    const key = this.key(url);
    return this.withProducerLock(key, async () => {
      const appeared = await this.get(url, { beforeUse: options.beforeUse });
      if (appeared) return appeared;
      let retries = 0;
      const response = await fetchWithRetry(url, {
        ...options,
        onRetry: (event) => { retries += 1; options.onRetry?.(event); },
      });
      this.retries += retries;
      // Consume every terminal response before provenance is allowed to
      // publish it. A 404 is evidence too: leaving its body unread would let
      // the request timeout stop at headers and would record a fabricated
      // zero-length response digest rather than what the provider returned.
      // Source-policy callers require a stream so the cap is checked before
      // a hostile response can allocate an arbitrary arrayBuffer.
      const body = await readResponseBodyBounded(response, {
        maxBytes: options.maxResponseBytes,
        requireStreaming: options.requireStreamingBody,
        onLimit: options.onBodyLimit,
      });
      return this.put(url, response.status, body, { beforePublish: options.beforePublish });
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
