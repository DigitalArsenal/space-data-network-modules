import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodePluginManifest } from "space-data-module-sdk";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";
import createIssSourcePluginManifest from "../manifest.js";

function encodeEmbeddedManifest() {
  return encodePlgManifest(legacyManifestToPlg(createIssSourcePluginManifest()));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "dist", "iss-source.wasm");
const KEYPAIR_PATH =
  process.env.SDN_MODULE_SIGNING_KEYPAIR ||
  path.resolve(__dirname, "../../../../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json");

const REQUIRED_EXPORTS = [
  "plugin_invoke_stream",
  "plugin_alloc",
  "plugin_free",
  "plugin_get_manifest_flatbuffer",
  "plugin_get_manifest_flatbuffer_size",
];
const REQUIRED_HOST_IMPORTS = ["call", "response_len", "read_response"];

function loadWasm() {
  assert.ok(fs.existsSync(WASM_PATH), `built module not found at ${WASM_PATH}; run \`node build.mjs\` first`);
  return new Uint8Array(fs.readFileSync(WASM_PATH));
}

const WASI_STUB = { fd_close: () => 0, fd_write: () => 0, fd_seek: () => 0 };

test("module builds as a valid signed SDN artifact", async () => {
  const keypair = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  await verifyModuleArtifact(loadWasm(), { trustedPublicKeys: [keypair.publicKeyHex], requireSignature: true });
});

test("module exports the canonical plugin ABI", async () => {
  const { exports } = await inspectModule(loadWasm());
  const names = exports.map((e) => (typeof e === "string" ? e : e.name));
  for (const name of REQUIRED_EXPORTS) assert.ok(names.includes(name), `missing ABI export: ${name}`);
});

test("pull imports the space_data_module_host host-call bridge", async () => {
  const { imports } = await inspectModule(loadWasm());
  const hostImports = imports.filter((i) => i.module === "space_data_module_host").map((i) => i.name);
  for (const name of REQUIRED_HOST_IMPORTS) {
    assert.ok(hostImports.includes(name), `missing host-call import: ${name} (have: ${hostImports.join(", ")})`);
  }
});

test("manifest declares the executable data-source contract", async () => {
  const manifest = decodePluginManifest(encodeEmbeddedManifest());
  assert.equal(manifest.pluginId, "com.orbpro.iss-source");
  assert.equal(manifest.pluginFamily, "data_source");
  const methodIds = (manifest.methods || []).map((m) => m.methodId);
  assert.ok(methodIds.includes("pull"), `missing pull method (have: ${methodIds.join(", ")})`);
  const caps = (manifest.hostCapabilities || []).map((c) => c.capability);
  for (const cap of ["http", "storage_ingest", "wallet_sign", "crypto_sign", "pubsub"]) {
    assert.ok(caps.includes(cap), `missing host capability: ${cap} (have: ${caps.join(", ")})`);
  }
  // A2.2c-3: storage_ingest (NOT storage_write); a missing STORAGE_INGEST enum
  // would clamp the decode to CLOCK — assert neither leaks through.
  assert.ok(!caps.includes("storage_write"), "storage_write must be gone (migrated to storage_ingest)");
  assert.ok(!caps.includes("clock"), "storage_ingest must not decode as a CLOCK fallback");
  const timers = manifest.timers || [];
  const pullTimer = timers.find((t) => t.timerId === "iss-pull");
  assert.ok(pullTimer, `missing iss-pull timer (have: ${timers.map((t) => t.timerId).join(", ")})`);
  assert.equal(pullTimer.methodId, "pull");
});

test("built WASM embeds + returns the real manifest", async () => {
  const encoded = encodeEmbeddedManifest();
  const { stripWasmCustomSections } = await import("space-data-module-sdk/bundle");
  const loadable = stripWasmCustomSections(loadWasm());
  const stub = () => 0;
  const { instance } = await WebAssembly.instantiate(loadable, {
    space_data_module_host: { call: stub, response_len: stub, read_response: stub, clear_response: stub, last_status_code: stub },
    wasi_snapshot_preview1: WASI_STUB,
  });
  const ex = instance.exports;
  const size = ex.plugin_get_manifest_flatbuffer_size();
  assert.equal(size, encoded.length, `embedded manifest size ${size} != encoded ${encoded.length}`);
  const ptr = ex.plugin_get_manifest_flatbuffer();
  const mem = new Uint8Array(ex.memory.buffer, ptr, size);
  assert.equal(decodePluginManifest(new Uint8Array(mem)).pluginId, "com.orbpro.iss-source");
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture-driven end-to-end pull (A2.2c). Instantiates the real built WASM with
// a mock `space_data_module_host` bridge that serves the checked-in trimmed ISS
// OEM over http.request, captures storage.write + pubsub.publish, and returns a
// signature for keyslot.sign. No live network is touched.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const SOURCE_URL = "https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt";
const FIXTURE_FILE = "ISS.OEM_J2K_EPH.sample.txt";

function u32le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}
// Parse a [u32le len][bytes]... size-prefixed record stream (the shape the guest
// sends to storage.ingest_with_source and the host's splitSizePrefixedStream reads).
function splitSizePrefixed(bytes) {
  const records = [];
  let off = 0;
  while (off < bytes.length) {
    const n = u32le(bytes, off);
    off += 4;
    records.push(Buffer.from(bytes.subarray(off, off + n)));
    off += n;
  }
  return records;
}

// Reference CIDv1(raw, sha2-256) in the CIDv1 default multibase (base32 lower,
// no pad, 'b' prefix) — the exact string the SDN host assigns for these bytes
// (storage.computeCID / go-cid). The module computes this in-guest for the PNM.
function cidV1RawSha256(bytes) {
  const digest = crypto.createHash("sha256").update(bytes).digest();
  const frame = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  const alpha = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "", buffer = 0, bits = 0;
  for (const byte of frame) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += alpha[(buffer >>> bits) & 31]; }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += alpha[(buffer << (5 - bits)) & 31];
  return "b" + out;
}

function buildEnvelope(metaObj) {
  const meta = new TextEncoder().encode(JSON.stringify(metaObj));
  const out = new Uint8Array(4 + meta.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, meta.length, true);
  out.set(meta, 4);
  dv.setUint32(4 + meta.length, 0, true);
  return out;
}

// `httpOverride(url)` lets a test inject a non-200 / malformed body.
async function runPull(config, httpOverride) {
  const { stripWasmCustomSections } = await import("space-data-module-sdk/bundle");
  const loadable = stripWasmCustomSections(loadWasm());

  const captured = { storage: [], publishes: [] };
  let responseBuf = new Uint8Array(0);
  let instance = null;
  const mem = () => new Uint8Array(instance.exports.memory.buffer);
  const readBytes = (ptr, len) => mem().slice(ptr, ptr + len);
  const readStr = (ptr, len) => new TextDecoder().decode(readBytes(ptr, len));
  const readReqMeta = (ptr, len) => {
    const bytes = readBytes(ptr, len);
    const metaLen = u32le(bytes, 0);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + metaLen)));
  };

  function serveHttp(url) {
    if (httpOverride) {
      const o = httpOverride(url);
      if (o) return o;
    }
    if (url === SOURCE_URL) {
      return { status: 200, body: fs.readFileSync(path.join(FIXTURES_DIR, FIXTURE_FILE), "utf8") };
    }
    return { status: 404, body: "" };
  }

  const host = {
    call(opPtr, opLen, payloadPtr, payloadLen) {
      const op = readStr(opPtr, opLen);
      const req = readReqMeta(payloadPtr, payloadLen);
      let meta;
      if (op === "http.request") {
        const r = serveHttp(req.url);
        meta = { ok: true, result: { status: r.status, body_encoding: "utf8", body: r.body } };
      } else if (op === "storage.ingest_with_source") {
        // A2.2c-3: records arrive as a base64 size-prefixed stream + SourceTags.
        const stream = Buffer.from(req.records, "base64");
        const records = splitSizePrefixed(stream);
        for (const data of records) {
          captured.storage.push({
            schema: req.schema,
            data,
            reconcile: req.reconcile,
            tags: {
              provider_id: req.provider_id,
              source_name: req.source_name,
              source_url: req.source_url,
              batch_id: req.batch_id,
              content_key_id: req.content_key_id,
            },
          });
        }
        meta = { ok: true, result: { schema: req.schema, inserted: records.length, batch_id: req.batch_id } };
      } else if (op === "keyslot.sign") {
        const sig = Buffer.alloc(64, 0x2b);
        meta = { ok: true, result: { signature: sig.toString("base64"), algorithm: "ed25519" } };
      } else if (op === "pubsub.publish") {
        captured.publishes.push({ topic: req.topic, message: JSON.parse(req.data) });
        meta = { ok: true, result: {} };
      } else {
        meta = { ok: false, error: { message: "unhandled op " + op } };
      }
      responseBuf = buildEnvelope(meta);
      return 0;
    },
    response_len() { return responseBuf.length; },
    read_response(dstPtr, dstLen) {
      const n = Math.min(dstLen, responseBuf.length);
      mem().set(responseBuf.subarray(0, n), dstPtr);
      return n;
    },
    clear_response() { responseBuf = new Uint8Array(0); return 0; },
    last_status_code() { return 0; },
  };

  const wasm = await WebAssembly.instantiate(loadable, { space_data_module_host: host, wasi_snapshot_preview1: WASI_STUB });
  instance = wasm.instance;
  const ex = instance.exports;

  const cfgBytes = config ? new TextEncoder().encode(JSON.stringify(config)) : new Uint8Array(0);
  let cfgPtr = 0;
  if (cfgBytes.length) {
    cfgPtr = ex.plugin_alloc(cfgBytes.length);
    mem().set(cfgBytes, cfgPtr);
  }
  const outLenPtr = ex.plugin_alloc(4);
  const resultPtr = ex.plugin_invoke_stream(cfgPtr, cfgBytes.length, outLenPtr);
  const outLen = u32le(mem(), outLenPtr);
  const resultBytes = readBytes(resultPtr, outLen);
  return { resultBytes, ...captured };
}

// run_pull returns an $OEM STREAM: [u32le count] then count x ([u32le len][$OEM]).
function parseOemStream(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const count = dv.getUint32(off, true); off += 4;
  const records = [];
  for (let i = 0; i < count; i++) {
    const len = dv.getUint32(off, true); off += 4;
    records.push(bytes.subarray(off, off + len)); off += len;
  }
  return { count, records, consumed: off };
}

test("pull: OEM fetch → in-memory $OEM stream (1 record, no store)", async () => {
  const { resultBytes, storage, publishes } = await runPull(null);
  const { count, records, consumed } = parseOemStream(resultBytes);

  // The single ISS OEM (15 states, EME2000) becomes one framed $OEM record. Full
  // $OEM validity is covered by the OD flow tests (TestODFlowStreamToPool) + the
  // od.fit reader; here we assert framing + the in-memory-only invariant.
  assert.equal(count, 1, "one ISS $OEM emitted");
  assert.equal(records.length, 1);
  assert.equal(consumed, resultBytes.length, "stream fully consumed");
  assert.ok(records[0].length > 8);
  assert.equal(new TextDecoder().decode(records[0].subarray(4, 8)), "$OEM", "record carries the $OEM file id");

  // Ephemeris in-memory only: nothing stored/signed/published.
  assert.equal(storage.length, 0, "no $OEM stored (in-memory-only invariant)");
  assert.equal(publishes.length, 0, "no PNM published for transient ephemeris");
});

test("pull: sourceUrl override is honored", async () => {
  const ALT = "https://example.test/ISS.OEM_J2K_EPH.txt";
  const { resultBytes } = await runPull({ sourceUrl: ALT }, (url) => {
    if (url === ALT) return { status: 200, body: fs.readFileSync(path.join(FIXTURES_DIR, FIXTURE_FILE), "utf8") };
    return null;
  });
  assert.equal(parseOemStream(resultBytes).count, 1, "override URL served -> one $OEM");
});

test("pull: non-200 upstream fails closed (empty stream, nothing stored)", async () => {
  const { resultBytes, storage } = await runPull(null, () => ({ status: 503, body: "" }));
  assert.equal(parseOemStream(resultBytes).count, 0);
  assert.equal(storage.length, 0);
});

test("pull: malformed body (no state vectors) fails closed", async () => {
  const { resultBytes, storage } = await runPull(null, () => ({
    status: 200,
    body: "CCSDS_OEM_VERS = 2.0\nCREATION_DATE = 2026-07-13T00:00:00\nMETA_START\nOBJECT_NAME = ISS\nMETA_STOP\n(garbage, no state lines)\n",
  }));
  assert.equal(parseOemStream(resultBytes).count, 0, "no parseable states -> empty stream");
  assert.equal(storage.length, 0);
});
