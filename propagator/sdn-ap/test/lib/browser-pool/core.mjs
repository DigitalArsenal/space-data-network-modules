// The jobs of test/browser-pool.e2e.mjs, written once and run unchanged in a browser's hosting Worker and in Node: whatever
// differs between the two shows as a different digest. ctx = { H: the SDK's host handle, x: the instance's exports, threads: the
// pool threads asked, meta: { epochMs } }. JS only moves bytes and hashes what the module wrote.
const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });
const DAY = 86400000;
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(u8) {
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", u8)));
}
export const jdOf = (ms) => { const d = Math.floor(ms / DAY); return [d + 2440587.5, (ms - d * DAY) / DAY]; };
const grab = (ctx, ptr, bytes) => new Uint8Array(ctx.H.memory.buffer, ptr, bytes).slice();
const mem = (ctx) => ctx.H.memory.buffer.byteLength;
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };

// Validate the planes before hashing: equal bytes alone do not establish a useful result.
export function assertPlane(ctx, ptr, count, name) {
  const values = new Float64Array(ctx.H.memory.buffer, ptr, count);
  if (!values.every(Number.isFinite) || !values.some((v) => v !== 0)) throw new Error(`${name}: expected finite, non-zero output`);
}
export function assertPool(ctx, stats, before = 0) {
  // Older builds omit the two row counters; -1 identifies those absent counters.
  if (ctx.threads > 0 && stats.rowsOnPool >= 0 && !(stats.rowsOnPool > before && stats.poolThreadsWithRows > 1))
    throw new Error(`pool at ${ctx.threads} threads: expected rows on more than one pool thread`);
}
const apCaches = (ctx) => {
  if (!ctx.x.sdnap_cache_stats) return null;
  const p = ctx.x.sdnap_alloc(64);
  ctx.x.sdnap_cache_stats(p);
  const made = new Float64Array(ctx.H.memory.buffer, p, 8)[7];
  ctx.x.sdnap_free(p);
  return made;
};

/** sdnap_pool_stats: the doubles a build writes (an older build writes fewer: the rest read -1). */
export function poolStats(ctx) {
  const p = ctx.x.sdnap_alloc(16 * 8);
  new Float64Array(ctx.H.memory.buffer, p, 16).fill(-1);
  if (ctx.x.sdnap_pool_stats) ctx.x.sdnap_pool_stats(p, 16);
  const v = Array.from(new Float64Array(ctx.H.memory.buffer, p, 16));
  ctx.x.sdnap_free(p);
  return { threads: v[0], batches: v[1], refused: v[2], deferred: v[3], afterGrowth: v[4], dead: v[5], growths: v[10], rowsOnPool: v[14], poolThreadsWithRows: v[15] };
}
export function spawnInfo(ctx) {
  const t = ctx.H.threadHost;
  return t ? { spawned: t.spawnCount?.() ?? null, distinct: t.distinctOsThreadCount?.() ?? null } : null;
}

/** Size-prefixed records, end to end: [u32 length, record] ... ; the offsets of the first n. */
export function recordOffsets(bytes, n) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const off = [];
  let at = 0;
  for (let k = 0; k < n; k++) { off.push(at); at += 4 + dv.getUint32(at, true); }
  off.push(at);
  return off;
}

/** load_epochs_open, parts of `part` records through one staging buffer in the module's memory (freed afterwards), load_epochs_close. */
export async function loadParts(ctx, bytes, n, part = 1000) {
  const { H, x } = ctx;
  const off = recordOffsets(bytes, n);
  let widest = 0;
  for (let k = 0; k < n; k += part) widest = Math.max(widest, off[Math.min(k + part, n)] - off[k]);
  const staging = x.plugin_alloc(widest);
  if (!staging) throw new Error("plugin_alloc returned 0");
  const must = (r, what) => { if (r.statusCode !== 0) throw new Error(`${what}: ${r.errorCode}: ${r.errorMessage}`); };
  must(await H.invoke({ methodId: "load_epochs_open", inputs: [] }), "load_epochs_open");
  for (let k = 0; k < n; k += part) {
    const a = off[k], b = off[Math.min(k + part, n)];
    new Uint8Array(H.memory.buffer, staging, b - a).set(bytes.subarray(a, b));
    must(await H.invoke({ methodId: "load_epochs_part", externalArena: new Uint8Array(H.memory.buffer),
      inputs: [{ portId: "ocm", typeRef: T("OCM"), offset: staging, size: b - a, alignment: 8 }] }), `load_epochs_part at ${k}`);
  }
  must(await H.invoke({ methodId: "load_epochs_close", inputs: [] }), "load_epochs_close");
  x.plugin_free(staging, widest);
}

/** Element rows through the pool's own entry, sdnap_propagate_soa, at three instants: one digest of every double and status. */
export async function rowsJob(ctx, rowsBytes, n) {
  const { x } = ctx;
  const p = x.sdnap_alloc(rowsBytes.length);
  new Uint8Array(ctx.H.memory.buffer, p, rowsBytes.length).set(rowsBytes);
  const held = x.sdnap_init_elements(p, n);
  x.sdnap_free(p);
  if (held !== n) throw new Error(`sdnap_init_elements held ${held} of ${n}`);
  const out = x.sdnap_alloc(48 * n), status = x.sdnap_alloc(4 * n);
  const digests = [];
  let nonzero = 0;
  for (const d of [0, 1, 3]) {
    const [w, f] = jdOf(ctx.meta.epochMs + d * DAY);
    const rc = x.sdnap_propagate_soa(w, f, 0, n, 0, out, status);
    if (rc !== 0) throw new Error(`sdnap_propagate_soa returned ${rc}`);
    assertPlane(ctx, out, 6 * n, "state");
    const s = grab(ctx, status, 4 * n);
    for (const c of new Int32Array(s.buffer)) if (c !== 0) nonzero++;
    digests.push(await sha256Hex(concat(grab(ctx, out, 48 * n), s)));
  }
  assertPool(ctx, poolStats(ctx));
  return { n, digest: await sha256Hex(new TextEncoder().encode(digests.join(""))), nonzeroStatus: nonzero, pool: poolStats(ctx), spawn: spawnInfo(ctx) };
}

/** An AP catalog (records with a covariance) loaded in parts: all states at five instants, then once with the covariance planes. */
export async function apJob(ctx, bytes, n) {
  const { x } = ctx;
  const cachesBefore = apCaches(ctx);
  await loadParts(ctx, bytes, n);
  if (x.sdnap_epochs_series) {
    const info = x.sdnap_alloc(24);
    try {
      for (let i = 0; i < n; i++) {
        if (x.sdnap_epochs_series(i, info, 0, 0) !== 0 || new Float64Array(ctx.H.memory.buffer, info, 3)[1] !== 4)
          throw new Error("AP series: expected loaded non-SGP4 theory");
      }
    } finally { x.sdnap_free(info); }
  }
  // Series metadata uses the shared non-SGP4 enum; tesseral cache creation identifies AP execution.
  // Builds without sdnap_cache_stats expose no tesseral execution counter.

  const out = x.sdnap_alloc(48 * n), status = x.sdnap_alloc(4 * n), cov = x.sdnap_alloc(288 * n);
  const before = poolStats(ctx), memBefore = mem(ctx);
  const digests = [];
  let nonzero = 0;
  const ask = async (days, withCov) => {
    const [w, f] = jdOf(ctx.meta.epochMs + days * DAY);
    const rc = x.sdnap_epochs_at(w, f, 0, n, 0, out, status, withCov ? cov : 0);
    if (rc !== 0) throw new Error(`sdnap_epochs_at returned ${rc} at ${days} d`);
    assertPlane(ctx, out, 6 * n, "state");
    const s = grab(ctx, status, 4 * n);
    for (const c of new Int32Array(s.buffer)) if (c !== 0) nonzero++;
    let bytesOut = concat(grab(ctx, out, 48 * n), s);
    if (withCov) {
      assertPlane(ctx, cov, 36 * n, "covariance");
      bytesOut = concat(bytesOut, grab(ctx, cov, 288 * n));
    }
    return sha256Hex(bytesOut);
  };
  for (const d of [0, 0.5, 1, 2, 3]) digests.push(await ask(d, false));
  digests.push(await ask(2, true));
  const after = poolStats(ctx);
  assertPool(ctx, after, before.rowsOnPool);
  if (cachesBefore !== null && !(apCaches(ctx) > cachesBefore)) throw new Error("AP execution: no tesseral caches created");
  return { n, digest: await sha256Hex(new TextEncoder().encode(digests.join(""))), digests, nonzeroStatus: nonzero, poolBefore: before, pool: after, growthsDuringPasses: after.growths - before.growths,
    memBefore, memAfter: mem(ctx), spawn: spawnInfo(ctx) };
}

/** The frame path (SPEC 19), when the build has its exports: open by the host rules, a complete fill in slices, three instants in TEME and Earth-fixed. */
export async function framesJob(ctx, n, sliceRows) {
  const { H, x } = ctx;
  if (typeof x.sdnap_frames_open !== "function") return { present: false };
  const out = x.sdnap_alloc(48 * n + 64), status = x.sdnap_alloc(4 * n + 64), result = x.sdnap_alloc(64), statp = x.sdnap_alloc(256);
  const stats = () => { x.sdnap_frames_stats(statp); return Array.from(new Float64Array(H.memory.buffer, statp, 20)); };
  const budgetOf = (served) => 850 * served + 32 * n + 1048576;  // SPEC 19.6's rule
  let rc = x.sdnap_frames_open(budgetOf(n), 0);
  if (rc !== 0) throw new Error(`sdnap_frames_open returned ${rc}`);
  const served = stats()[1];
  x.sdnap_frames_close();
  rc = x.sdnap_frames_open(budgetOf(served), 0);
  if (rc !== 0) throw new Error(`sdnap_frames_open (sized) returned ${rc}`);
  const now = ctx.meta.epochMs + 60 * 60000;
  let calls = 0, r;
  do {
    const [w, f] = jdOf(now);
    rc = x.sdnap_frames_refill(w, f, 180, sliceRows, 0, 0, result);
    if (rc !== 0) throw new Error(`sdnap_frames_refill returned ${rc}`);
    r = Array.from(new Int32Array(H.memory.buffer, result, 6));
    calls++;
  } while (r[0] + r[1] > 0 && r[2] + r[3] > 0);
  const digests = [];
  let nonzero = 0;
  for (const frame of [0, 3]) for (const minutes of [60, 75, 90]) {
    const [w, f] = jdOf(ctx.meta.epochMs + minutes * 60000);
    rc = x.sdnap_frames_at(w, f, 0, n, frame, out, status);
    if (rc !== 0) throw new Error(`sdnap_frames_at returned ${rc}`);
    assertPlane(ctx, out, 6 * n, "state");
    const s = grab(ctx, status, 4 * n);
    for (const c of new Int32Array(s.buffer)) if (c !== 0) nonzero++;
    digests.push(await sha256Hex(concat(grab(ctx, out, 48 * n), s)));
  }
  return { present: true, n, served, calls, digest: await sha256Hex(new TextEncoder().encode(digests.join(""))), digests, nonzeroStatus: nonzero, stats: stats() };
}

export { T, mem };
