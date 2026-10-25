#!/usr/bin/env node
// E2E for data-source/sdn-element-sync: three SDN nodes (A publishes, B pulls, C is seeded by B) with the element
// sets moving as bytes between them and the module's `merge` deciding what each node keeps.
//
//   A  publishes a signed catalog: SGP4 and SGP4XP $OMM sets (SGP4XP from two originators), one per object per day for 9 days, and a
//      $PNV notice carrying the Ed25519 signature (verified by the receiving node's p2p connector, here node:crypto).
//   B  pulls A's latest dataset through its p2p connector (no direct HTTP from the module), merges it into a rolling
//      7-day window, writes the new sets to its cache and applies the expire cutoff; then restarts with the network
//      down and serves the same window from its cache; then two days later pulls the next catalog and the oldest
//      days expire.
//   C  is seeded by B: B re-serves its cached sets with A's notice byte for byte; C's window equals B's and A's
//      signature still verifies at C (nothing was re-signed). An unsigned or tampered pull is refused.
//
// Every merge runs on the browser lane and on native WasmEdge (the SDK wasi-threads runner); each output's bytes
// must be identical. The Docker WasmEdge lane is waived by owner ruling (2026-10-22).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OMM, OMMT } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { QRP, QRPT } from "spacedatastandards.org/lib/js/QRP/QRP.js";
import { qrpKind } from "spacedatastandards.org/lib/js/QRP/qrpKind.js";
import { PNV, PNVT } from "spacedatastandards.org/lib/js/PNV/PNV.js";
import { PNVEntryT } from "spacedatastandards.org/lib/js/PNV/PNVEntry.js";

const wasmPath = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const DAY = 86400000;
const NOW0 = Date.parse("2026-10-25T12:00:00Z");
const T = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code });

// --- bytes ----------------------------------------------------------------------------------------------------------
const finish = (root, id, finisher) => { const b = new flatbuffers.Builder(256); finisher(b, root.pack(b)); return b.asUint8Array(); };
const ommBytes = (o) => finish(Object.assign(new OMMT(), o), "$OMM", (b, off) => OMM.finishOMMBuffer(b, off));
const prefixed = (records) => { const parts = []; for (const r of records) { const p = new Uint8Array(4 + r.length); new DataView(p.buffer).setUint32(0, r.length, true); p.set(r, 4); parts.push(p); } return Buffer.concat(parts); };
const unprefix = (buf) => { const out = []; let at = 0; const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); while (at < buf.length) { const n = v.getUint32(at, true); out.push(buf.subarray(at + 4, at + 4 + n)); at += 4 + n; } return out; };
const windowRequest = ({ now, days, limit = 0 }) => finish(Object.assign(new QRPT(), { KIND: qrpKind.Request, SCHEMA_NAME: "OMM", FROM_EPOCH_MS: BigInt(now - days * DAY), AS_OF_MS: BigInt(now), LIMIT: limit }), "$QRP", (b, off) => QRP.finishQRPBuffer(b, off));
const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest("hex");

// --- node A: the publisher ------------------------------------------------------------------------------------------
const OBJECTS = [25544, 43013, 48274, 90001];
const LANES = [{ name: "SGP4", theory: 0, originator: "SDN" }, { name: "SGP4XP", theory: 1, originator: "SDN" }, { name: "SGP4XP-B", theory: 1, originator: "SDN-B" }];
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publisherKey = publicKey.export({ type: "spki", format: "der" });
function catalog(now, daysBack) {
  const sets = [];
  for (let d = daysBack; d >= 0; d--) {
    const epoch = new Date(Math.floor(now / DAY) * DAY - d * DAY + 6 * 3600e3).toISOString().replace("Z", "000");
    for (const norad of OBJECTS) for (const l of LANES) sets.push(ommBytes({ NORAD_CAT_ID: norad, OBJECT_ID: `1998-067${String.fromCharCode(65 + (norad % 20))}`, EPOCH: epoch, MEAN_ELEMENT_THEORY: l.theory, ORIGINATOR: l.originator, MEAN_MOTION: 15.5 + (Math.floor(now / DAY) - d) % 100 * 1e-4, INCLINATION: 51.6 }));
  }
  return prefixed(sets);
}
function publish(now, daysBack) {
  const batch = catalog(now, daysBack);
  const e = Object.assign(new PNVEntryT(), { PNM_CID: `bafy-${sha(batch).slice(0, 16)}`, PUBLISHER_PEER_ID: "12D3KooWPublisherA", STANDARD: "omm", SCHEMA_NAME: "OMM.fbs", CID: sha(batch).slice(0, 32), PUBLISHED_AT_MS: BigInt(now), SIGNATURE_TYPE: "ed25519", SIGNATURE: [...crypto.sign(null, batch, privateKey)], PUBLISHER_KEY: [...publisherKey], PNM_BYTES: [...Buffer.from(`PNM:${sha(batch)}`)] });
  return { batch, entry: e };
}
// The receiving node's p2p connector: verifies the publisher's signature over the batch it received (the host does this
// in the real node; the module reads only SIGNATURE_VERIFIED) and answers the notice.
function receive({ batch, entry }, { tamper = false, unsigned = false } = {}) {
  const data = tamper ? Buffer.from(batch).fill(batch.at(-1) ^ 1, batch.length - 1) : batch;
  const e = Object.assign(new PNVEntryT(), entry);
  e.SIGNATURE_VERIFIED = !unsigned && crypto.verify(null, data, crypto.createPublicKey({ key: Buffer.from(e.PUBLISHER_KEY), format: "der", type: "spki" }), Buffer.from(e.SIGNATURE));
  const notice = finish(Object.assign(new PNVT(), { VERIFIER_PEER_ID: "12D3KooWReceiver", GENERATED_AT_MS: BigInt(0), ENTRIES: [e] }), "$PNV", (b, off) => PNV.finishPNVBuffer(b, off));
  return { data, notice };
}

// --- the module on a lane -------------------------------------------------------------------------------------------
async function lanes() {
  const testing = path.dirname(fileURLToPath(import.meta.resolve("space-data-module-sdk/testing")));
  const { resolveWasmEdgeWasiThreadsRunner } = await import(pathToFileURL(path.join(testing, "buildWasmEdgeRunner.js")).href);
  const runner = process.env.SDM_WASMEDGE_RUNNER_BINARY || (await resolveWasmEdgeWasiThreadsRunner({}));
  return {
    browser: await createStandaloneHarness("browser", wasmPath, { surface: "command" }),
    wasmedge: await createStandaloneHarness("wasmedge", wasmPath, { surface: "command", wasmEdgeRunnerBinary: runner }),
  };
}
const ledger = { browser: [], wasmedge: [] };
async function merge(harnesses, label, { now, days = 7, limit = 0, cached = [], pulled = null, notices = [] }) {
  const inputs = [{ portId: "window", typeRef: T("QRP"), payload: windowRequest({ now, days, limit }) }];
  for (const c of cached) inputs.push({ portId: "cached", typeRef: T("OMM"), payload: c });
  if (pulled) inputs.push({ portId: "pulled", typeRef: T("OMM"), payload: pulled });
  for (const n of notices) inputs.push({ portId: "notice", typeRef: T("PNV"), payload: n });
  const results = {};
  for (const [lane, h] of Object.entries(harnesses)) {
    const r = await h.invoke({ methodId: "merge", inputs });
    if ((r.statusCode ?? 0) !== 0) assert.fail(`${label}/${lane}: ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? `[${v.length} bytes]` : v))}`);
    results[lane] = r;
    ledger[lane].push({ label, outputs: r.outputs.map((o) => `${o.portId}:${sha(o.payload)}`) });
  }
  assert.deepEqual(ledger.browser.at(-1).outputs, ledger.wasmedge.at(-1).outputs, `${label}: browser and WasmEdge outputs are byte-identical`);
  const r = results.browser;
  const port = (name) => r.outputs.filter((o) => o.portId === name).map((o) => Buffer.from(o.payload));
  const summary = QRP.getRootAsQRP(new flatbuffers.ByteBuffer(port("summary")[0])).unpack();
  return {
    omm: Buffer.concat(port("omm")), store: Buffer.concat(port("store")), notices: port("notice"),
    expire: QRP.getRootAsQRP(new flatbuffers.ByteBuffer(port("expire")[0])).unpack(), summary,
  };
}
const keyOf = (rec) => { const o = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(rec)).unpack(); return [o.NORAD_CAT_ID, o.OBJECT_ID, o.MEAN_ELEMENT_THEORY, o.ORIGINATOR, o.EPOCH]; };
const epochsOf = (stream) => unprefix(stream).map((r) => Date.parse(`${keyOf(r)[4]}Z`));

// --- the scenario ---------------------------------------------------------------------------------------------------
const harnesses = await lanes();
const checks = [];
const ok = (name) => { checks.push(name); console.log(`PASS ${name}`); };
class Node {
  constructor(name) { this.name = name; this.cache = new Map(); this.notices = []; this.network = 0; }
  write(stream, notice) { for (const r of unprefix(stream)) this.cache.set(keyOf(r).join("|"), Buffer.from(r)); if (notice) this.notices = [...new Set([...this.notices, ...notice.map((n) => Buffer.from(n).toString("hex"))])]; }
  expire(toMs) { for (const [k, r] of this.cache) if (Date.parse(`${keyOf(r)[4]}Z`) < toMs) this.cache.delete(k); }
  cachedFrames() { return this.cache.size ? [prefixed([...this.cache.values()])] : []; }
  seed() { return { batch: prefixed([...this.cache.values()]), notices: this.notices.map((h) => Buffer.from(h, "hex")) }; }
}
const B = new Node("B"), C = new Node("C");

// B pulls from A (now = day 0, 9 days of history available, the window keeps 7 days)
const a0 = publish(NOW0, 9);
const got0 = receive(a0);
B.network++;
const m1 = await merge(harnesses, "B first pull", { now: NOW0, pulled: got0.data, notices: [got0.notice] });
const catalogSize = OBJECTS.length * LANES.length;
const kept1 = unprefix(m1.omm);
assert.equal(kept1.length, catalogSize * 7, "7 days back from now keeps the 7 daily epochs at or after the window start (the 06:00 epoch 7 days back is before 12:00)");
assert.ok(epochsOf(m1.omm).every((t) => t >= NOW0 - 7 * DAY), "no set older than the window");
assert.deepEqual(new Set(kept1.map((r) => keyOf(r)[3] + keyOf(r)[2])), new Set(["SDN0", "SDN1", "SDN-B1"]), "SGP4 and SGP4XP sets of both originators all present");
const ordered = kept1.map((r) => keyOf(r));
assert.deepEqual(ordered, [...ordered].sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2] || (x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : 0) || (x[4] < y[4] ? -1 : x[4] > y[4] ? 1 : 0)), "snapshot sorted by object, theory, originator, epoch");
assert.equal(Buffer.compare(m1.store, m1.omm), 0, "first pull: every kept set is new for the cache");
assert.equal(m1.expire.TO_EPOCH_MS, BigInt(NOW0 - 7 * DAY));
assert.equal(m1.notices.length, 1);
assert.equal(Buffer.compare(m1.notices[0], got0.notice), 0, "notice passed through byte for byte");
assert.equal(m1.summary.RECORD_COUNT, kept1.length);
ok("B pulls A's signed catalog and keeps the 7-day window of all three lanes, sorted, expiry cutoff exact");
B.write(m1.store, m1.notices); B.expire(Number(m1.expire.TO_EPOCH_MS));

// the same pull again: nothing new, same snapshot
const m2 = await merge(harnesses, "B repeat pull", { now: NOW0, cached: B.cachedFrames(), pulled: got0.data, notices: [got0.notice] });
assert.equal(m2.store.length, 0, "a repeated pull stores nothing");
assert.equal(Buffer.compare(m2.omm, m1.omm), 0);
ok("a repeated pull adds nothing to the cache and the snapshot is unchanged");

// tampered and unsigned pulls are refused
for (const [name, opt] of [["tampered", { tamper: true }], ["unsigned", { unsigned: true }]]) {
  const bad = receive(publish(NOW0 + DAY, 9), opt);
  const m = await merge(harnesses, `B ${name} pull`, { now: NOW0 + DAY, cached: B.cachedFrames(), pulled: bad.data, notices: [bad.notice] });
  assert.equal(m.store.length, 0, `${name}: nothing stored`);
  assert.equal(m.summary.PARTIAL, true);
  assert.equal(m.notices.length, 0, `${name}: the notice is not seeded`);
}
const noNotice = await merge(harnesses, "B pull without notice", { now: NOW0, cached: B.cachedFrames(), pulled: got0.data });
assert.equal(noNotice.store.length, 0);
ok("a pull whose signature fails (tampered bytes), is unverified, or has no notice is refused and never cached or seeded");

// B restarts with the network down: the window comes from the cache alone
const networkBefore = B.network;
const restart = await merge(harnesses, "B offline restart", { now: NOW0, cached: B.cachedFrames() });
assert.equal(B.network, networkBefore, "no network use on an offline restart");
assert.equal(Buffer.compare(restart.omm, m1.omm), 0, "offline restart serves the identical window from cache");
assert.equal(restart.store.length, 0);
ok("B restarts offline and serves the identical 7-day window from its cache");

// two days later: the next catalog arrives, the oldest days expire
const NOW2 = NOW0 + 2 * DAY;
const a2 = publish(NOW2, 9), got2 = receive(a2);
const m3 = await merge(harnesses, "B two days later", { now: NOW2, cached: B.cachedFrames(), pulled: got2.data, notices: [got2.notice] });
assert.ok(epochsOf(m3.omm).every((t) => t >= NOW2 - 7 * DAY), "window slid");
assert.equal(unprefix(m3.omm).length, catalogSize * 7);
assert.equal(unprefix(m3.store).length, catalogSize * 2, "two new epochs per object and lane");
B.write(m3.store, m3.notices); B.expire(Number(m3.expire.TO_EPOCH_MS));
assert.ok([...B.cache.values()].every((r) => Date.parse(`${keyOf(r)[4]}Z`) >= NOW2 - 7 * DAY), "the cache dropped the expired epochs");
ok("two days later only the two new epochs are stored and the cache drops what left the window");

// a re-issued set (same key, new content) replaces the cached one; the cache is not asked to store the unchanged rest
const reissue = unprefix(m3.omm)[5];
const revised = ommBytes({ ...OMM.getRootAsOMM(new flatbuffers.ByteBuffer(reissue)).unpack(), MEAN_MOTION: 14.25 });
const mUpd = await merge(harnesses, "re-issued set", { now: NOW2, cached: B.cachedFrames(), pulled: prefixed([revised]), notices: [got2.notice] });
assert.equal(unprefix(mUpd.store).length, 1, "only the changed set is stored");
assert.equal(unprefix(mUpd.omm).length, catalogSize * 7, "and replaces its cached twin in the window");
ok("a re-issued set with the same key and new content replaces the cached one; the rest is not rewritten");

// a cap drops the oldest epochs first
const capped = await merge(harnesses, "cap", { now: NOW2, cached: B.cachedFrames(), limit: catalogSize * 3 });
assert.equal(unprefix(capped.omm).length, catalogSize * 3);
assert.equal(capped.summary.TRUNCATED, true);
assert.ok(Math.min(...epochsOf(capped.omm)) >= Math.min(...epochsOf(m3.omm)) + 4 * DAY);
ok("a LIMIT keeps the newest epochs and reports TRUNCATED");

// C is seeded by B: A's notice rides byte for byte; its signature still verifies at C
const seed = B.seed();
assert.ok(seed.notices.length >= 1);
const received = seed.notices.map((n) => PNV.getRootAsPNV(new flatbuffers.ByteBuffer(n)).unpack().ENTRIES[0]);
// C verifies the original publisher signature over the original catalog bytes A published
assert.ok(received.some((e) => crypto.verify(null, got2.data, crypto.createPublicKey({ key: Buffer.from(e.PUBLISHER_KEY), format: "der", type: "spki" }), Buffer.from(e.SIGNATURE))), "A's signature verifies at C");
const m4 = await merge(harnesses, "C seeded by B", { now: NOW2, pulled: got2.data, notices: [got2.notice] });
C.write(m4.store, m4.notices); C.expire(Number(m4.expire.TO_EPOCH_MS));
const fromSeed = await merge(harnesses, "C window from B's cached sets", { now: NOW2, cached: [seed.batch] });
assert.equal(Buffer.compare(fromSeed.omm, m3.omm), 0, "C's window from B's re-seeded sets equals B's window");
assert.deepEqual(m4.notices.map((n) => sha(n)), [sha(got2.notice)], "the notice C re-seeds is the one it received");
ok("B re-seeds C: same window, A's signed notice unchanged and still verifying");

// parity ledger
const identical = JSON.stringify(ledger.browser) === JSON.stringify(ledger.wasmedge);
assert.ok(identical, "browser and WasmEdge digests identical for every merge");
ok(`parity: ${ledger.browser.length} merges byte-identical on the browser host and native WasmEdge (Docker lane waived by owner ruling 2026-10-22)`);
for (const h of Object.values(harnesses)) await h.destroy?.();
console.log(JSON.stringify({ checks: checks.length, merges: ledger.browser.length }));
