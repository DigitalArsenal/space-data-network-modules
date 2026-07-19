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
import createStarlinkSourcePluginManifest from "../manifest.js";

// Encode the canonical manifest exactly as the build embeds it: the SDK's $PLG
// encoder (the format the Go node's PLG parser reads).
function encodeEmbeddedManifest() {
  return encodePlgManifest(legacyManifestToPlg(createStarlinkSourcePluginManifest()));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "dist", "spacex-starlink-source.wasm");
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

// The pull's host-call HTTP fetch requires these space_data_module_host imports.
const REQUIRED_HOST_IMPORTS = ["call", "response_len", "read_response"];

// The STANDALONE_WASM/PURE_WASI module imports a few wasi_snapshot_preview1 stdio
// shims (fd_close/fd_write/fd_seek) via the flatbuffers/$OEM headers' error paths.
// WasmEdge provides real WASI at runtime; the browser-style test harness stubs them.
const WASI_STUB = { fd_close: () => 0, fd_write: () => 0, fd_seek: () => 0 };

function loadWasm() {
  assert.ok(fs.existsSync(WASM_PATH), `built module not found at ${WASM_PATH}; run \`node build.mjs\` first`);
  return new Uint8Array(fs.readFileSync(WASM_PATH));
}

test("module builds as a valid signed SDN artifact", async () => {
  const keypair = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  await verifyModuleArtifact(loadWasm(), {
    trustedPublicKeys: [keypair.publicKeyHex],
    requireSignature: true,
  });
});

test("module exports the canonical plugin ABI", async () => {
  // inspectModule handles the signed artifact via the SDK's canonical
  // signature-strip (no hand-rolled section walking).
  const { exports } = await inspectModule(loadWasm());
  const names = exports.map((e) => (typeof e === "string" ? e : e.name));
  for (const name of REQUIRED_EXPORTS) {
    assert.ok(names.includes(name), `missing ABI export: ${name}`);
  }
});

test("pull imports the space_data_module_host host-call bridge", async () => {
  const { imports } = await inspectModule(loadWasm());
  const hostImports = imports.filter((i) => i.module === "space_data_module_host").map((i) => i.name);
  for (const name of REQUIRED_HOST_IMPORTS) {
    assert.ok(hostImports.includes(name), `missing host-call import: ${name} (have: ${hostImports.join(", ")})`);
  }
});

// The manifest the build embeds (via the SDK encoder) is what the node reads to
// grant host capabilities + schedule the timer. Round-trip it through the SDK
// codec and assert the data-source contract (family, pull method, the 5 host
// caps the pull's host-calls need, and the hourly pull timer).
test("manifest declares the executable data-source contract", async () => {
  const manifest = decodePluginManifest(encodeEmbeddedManifest());

  assert.equal(manifest.pluginId, "com.orbpro.spacex-starlink-source");
  assert.equal(manifest.pluginFamily, "data_source");

  const methodIds = (manifest.methods || []).map((m) => m.methodId);
  assert.ok(methodIds.includes("pull"), `missing pull method (have: ${methodIds.join(", ")})`);

  const caps = (manifest.hostCapabilities || []).map((c) => c.capability);
  for (const cap of ["http", "storage_ingest", "wallet_sign", "crypto_sign", "pubsub"]) {
    assert.ok(caps.includes(cap), `missing host capability: ${cap} (have: ${caps.join(", ")})`);
  }
  // A2.2c-3: the source-tag migration requires storage_ingest (NOT storage_write);
  // if the SDS PLG enum lacked STORAGE_INGEST the decoder would clamp it to CLOCK.
  assert.ok(!caps.includes("storage_write"), "storage_write must be gone (migrated to storage_ingest)");
  assert.ok(!caps.includes("clock"), "storage_ingest must not decode as a CLOCK fallback");

  const timers = manifest.timers || [];
  const pullTimer = timers.find((t) => t.timerId === "starlink-pull");
  assert.ok(pullTimer, `missing starlink-pull timer (have: ${timers.map((t) => t.timerId).join(", ")})`);
  assert.equal(pullTimer.methodId, "pull", "starlink-pull timer must invoke the pull method");
});

// Prove the manifest is actually embedded in (and returned by) the built WASM:
// instantiate the loadable module with stub host imports and assert
// plugin_get_manifest_flatbuffer_size() matches the SDK-encoded length, then
// decode the exact bytes the module returns and re-assert the plugin id.
test("built WASM embeds + returns the real manifest", async () => {
  const encoded = encodeEmbeddedManifest();
  const { stripWasmCustomSections } = await import("space-data-module-sdk/bundle");
  const loadable = stripWasmCustomSections(loadWasm());

  const stub = () => 0;
  const { instance } = await WebAssembly.instantiate(loadable, {
    space_data_module_host: {
      call: stub,
      response_len: stub,
      read_response: stub,
      clear_response: stub,
      last_status_code: stub,
    },
    wasi_snapshot_preview1: WASI_STUB,
  });
  const ex = instance.exports;
  const size = ex.plugin_get_manifest_flatbuffer_size();
  assert.equal(size, encoded.length, `embedded manifest size ${size} != encoded ${encoded.length}`);

  const ptr = ex.plugin_get_manifest_flatbuffer();
  const mem = new Uint8Array(ex.memory.buffer, ptr, size);
  const fromWasm = decodePluginManifest(new Uint8Array(mem));
  assert.equal(fromWasm.pluginId, "com.orbpro.spacex-starlink-source");
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture-driven end-to-end pull (SDN OD-flow). Instantiates the real built WASM
// with a mock `space_data_module_host` bridge that serves the checked-in MANIFEST
// + MEME fixtures over http.request (and would capture any storage/pubsub, which
// the OD-flow pull no longer uses). Exercises the actual C++ manifest parse →
// capped per-object fetch → MEME→$OEM FlatBuffer → in-memory $OEM STREAM flow
// against the rebuilt artifact (no live network, nothing stored).
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const MANIFEST_URL = "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt";
const BASE_URL = "https://api.starlink.com/public-files/ephemerides/";

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

// Build a hostcall response envelope: [u32 metaLen][metaJSON][u32 0 segments].
function buildEnvelope(metaObj) {
  const meta = new TextEncoder().encode(JSON.stringify(metaObj));
  const out = new Uint8Array(4 + meta.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, meta.length, true);
  out.set(meta, 4);
  dv.setUint32(4 + meta.length, 0, true); // segment_count = 0
  return out;
}

// Serve the http.request capability from the checked-in fixtures.
function serveHttp(url) {
  if (url.endsWith("MANIFEST.txt")) {
    return { status: 200, body: fs.readFileSync(path.join(FIXTURES_DIR, "MANIFEST.sample.txt"), "utf8") };
  }
  const name = url.slice(BASE_URL.length);
  const p = path.join(FIXTURES_DIR, "meme", name);
  if (fs.existsSync(p)) return { status: 200, body: fs.readFileSync(p, "utf8") };
  return { status: 404, body: "" }; // unknown object → module skips it
}

// Drive plugin_invoke_stream with an optional JSON config, collecting the
// storage.write records and pubsub.publish messages the module emits.
async function runPull(config) {
  const { stripWasmCustomSections } = await import("space-data-module-sdk/bundle");
  const loadable = stripWasmCustomSections(loadWasm());

  const captured = { storage: [], publishes: [] };
  let responseBuf = new Uint8Array(0);
  let instance = null;
  const mem = () => new Uint8Array(instance.exports.memory.buffer);
  const readBytes = (ptr, len) => mem().slice(ptr, ptr + len);
  const readStr = (ptr, len) => new TextDecoder().decode(readBytes(ptr, len));
  // A hostcall request payload is [u32 metaLen][metaJSON][u32 segCount][...].
  const readReqMeta = (ptr, len) => {
    const bytes = readBytes(ptr, len);
    const metaLen = u32le(bytes, 0);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + metaLen)));
  };

  const host = {
    call(opPtr, opLen, payloadPtr, payloadLen) {
      const op = readStr(opPtr, opLen);
      const req = readReqMeta(payloadPtr, payloadLen);
      let meta;
      if (op === "http.request") {
        captured.http = captured.http || [];
        captured.http.push({ url: req.url, headers: req.headers || {} });
        const r = serveHttp(req.url);
        // Emulate a range server: a Range request on a MEME file yields 206.
        const isMeme = !req.url.endsWith("MANIFEST.txt");
        const hasRange = req.headers && req.headers.Range;
        const status = (isMeme && hasRange && r.status === 200) ? 206 : r.status;
        meta = { ok: true, result: { status, body_encoding: "utf8", body: r.body } };
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
        // Deterministic non-empty signature (64 bytes); the module only needs
        // a non-empty signature to mark the PNM signed.
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

  // Write the optional JSON config into guest memory.
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

// run_pull now returns an $OEM STREAM (never a store): [u32le count] then count ×
// ([u32le len][non-size-prefixed $OEM]). Parse it into the record byte slices.
function parseOemStream(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const count = dv.getUint32(off, true);
  off += 4;
  const records = [];
  for (let i = 0; i < count; i++) {
    const len = dv.getUint32(off, true);
    off += 4;
    records.push(bytes.subarray(off, off + len));
    off += len;
  }
  return { count, records, consumed: off };
}

test("pull: manifest parse → capped per-object fetch → in-memory $OEM stream (no store)", async () => {
  const { resultBytes, storage, publishes } = await runPull({ objectCap: 2, fetchIntervalMs: 0 });
  const { count, records, consumed } = parseOemStream(resultBytes);

  // Manifest parsed (3 MEME lines), fetch plan capped to 2 → two $OEM records
  // framed in the stream. (Full $OEM validity — TEME frame, NORAD, states — is
  // covered by the native meme_oem_test against the same fixtures.)
  assert.equal(count, 2, "capped to 2 objects");
  assert.equal(records.length, 2);
  assert.equal(consumed, resultBytes.length, "stream fully consumed (no trailing bytes)");

  // Each framed record is an aligned-binary SDS $OEM (file identifier at bytes[4:8]
  // of the non-size-prefixed buffer, the shape od.fit consumes).
  for (const rec of records) {
    assert.ok(rec.length > 8, "record non-empty");
    assert.equal(new TextDecoder().decode(rec.subarray(4, 8)), "$OEM", "record carries the $OEM file id");
  }

  // Ephemeris is IN-MEMORY ONLY (SDN OD-flow invariant): nothing stored, signed,
  // or published — provenance rides on the RESULT records the OD flow's store node
  // writes, not on the transient $OEM.
  assert.equal(storage.length, 0, "no $OEM stored (in-memory-only invariant)");
  assert.equal(publishes.length, 0, "no PNM published for transient ephemeris");
});

test("pull: raising the cap fetches more and skips unknown objects (404-safe)", async () => {
  // cap 3 → plans all 3 manifest entries; the 3rd has no fixture (404) → skipped.
  const { resultBytes, storage } = await runPull({ objectCap: 3 });
  const { count } = parseOemStream(resultBytes);
  assert.equal(count, 2, "third object 404s and is skipped");
  assert.equal(storage.length, 0, "no $OEM stored");
});

test("pull: no config uses the default (unlimited) cap (still an in-memory $OEM stream)", async () => {
  const { resultBytes } = await runPull(null);
  const { count } = parseOemStream(resultBytes);
  // Default cap is now UNLIMITED (whole catalog); only 2 fixtures resolve here.
  assert.equal(count, 2);
});

// ── host-concurrent batch protocol (full-constellation scale) ────────────────

test("probe: returns a bare u32le object count (no per-object fetch)", async () => {
  const { resultBytes, http } = await runPull({ probe: true });
  // Sample manifest has 3 MEME entries; default cap is unlimited (whole catalog).
  assert.equal(resultBytes.length, 4, "probe returns exactly a u32le");
  assert.equal(u32le(resultBytes, 0), 3, "probe count = manifest entries");
  // Probe fetches ONLY the manifest — never any MEME object file.
  const memeFetches = (http || []).filter((h) => !h.url.endsWith("MANIFEST.txt"));
  assert.equal(memeFetches.length, 0, "probe fetched no object files");
});

test("batch: offset/count select a window into the manifest", async () => {
  const first = parseOemStream((await runPull({ offset: 0, count: 1 })).resultBytes);
  assert.equal(first.count, 1, "offset 0 count 1 -> the first object");
  // offset 2 is the 3rd manifest entry, which 404s (no fixture) -> 0 objects.
  const tail = parseOemStream((await runPull({ offset: 2, count: 5 })).resultBytes);
  assert.equal(tail.count, 0, "tail window past the resolvable fixtures is empty");
});

test("range: object files are range-fetched to the fit window (Range header, 206)", async () => {
  const { http } = await runPull({ objectCap: 2 });
  const memeFetches = (http || []).filter((h) => !h.url.endsWith("MANIFEST.txt"));
  assert.ok(memeFetches.length >= 1, "at least one object fetched");
  for (const f of memeFetches) {
    assert.ok(f.headers.Range, `object fetch carries a Range header (${f.url})`);
    assert.match(f.headers.Range, /^bytes=0-\d+$/, "Range is a leading byte window");
  }
});

test("range: rangeBytes=0 opts out (full-file fetch, no Range header)", async () => {
  const { http } = await runPull({ objectCap: 2, rangeBytes: 0 });
  const memeFetches = (http || []).filter((h) => !h.url.endsWith("MANIFEST.txt"));
  for (const f of memeFetches) {
    assert.ok(!f.headers.Range, "no Range header when rangeBytes=0");
  }
});
