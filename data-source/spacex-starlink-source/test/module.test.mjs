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
// Fixture-driven end-to-end pull (A2.2b). Instantiates the real built WASM with
// a mock `space_data_module_host` bridge that serves the checked-in MANIFEST +
// MEME fixtures over http.request, captures storage.write + pubsub.publish, and
// returns a signature for keyslot.sign. This exercises the actual C++ manifest
// parse → capped per-object fetch → MEME→canonical-OEM record → signed PNM
// publish flow against the rebuilt artifact (no live network).
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

  const wasm = await WebAssembly.instantiate(loadable, { space_data_module_host: host });
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
  const summary = JSON.parse(new TextDecoder().decode(readBytes(resultPtr, outLen)));
  return { summary, ...captured };
}

test("pull: manifest parse → capped per-object fetch → OEM records + signed PNMs", async () => {
  const { summary, storage, publishes } = await runPull({ objectCap: 2, fetchIntervalMs: 0 });

  // Manifest parsed (3 MEME lines) and fetch plan capped to 2.
  assert.equal(summary.ok, true);
  assert.equal(summary.discover_status, 200);
  assert.equal(summary.manifest_entries, 3);
  assert.equal(summary.object_cap, 2);
  assert.equal(summary.record_schema, "OEM");
  assert.equal(summary.fetched, 2, "capped to 2 objects");
  assert.equal(summary.stored, 2);
  assert.equal(summary.signed, 2);
  assert.equal(summary.published, 2);

  // Exactly two OEM records stored, honest schema (NOT a raw-listing "OEM" blob).
  assert.equal(storage.length, 2);
  for (const w of storage) assert.equal(w.schema, "OEM");

  // A2.2c-3: each record is ingested with SourceTags provenance and reconcile:"none".
  for (const w of storage) {
    assert.equal(w.reconcile, "none", "reconcile must be none (protects NORAD=0 siblings)");
    assert.equal(w.tags.source_name, "spacex-starlink", "SourceName is the fit-pipeline grouping key");
    assert.equal(w.tags.provider_id, "spacex-starlink", "provider_id reuses source_name in-guest");
    assert.equal(w.tags.content_key_id, "public");
    assert.match(w.tags.batch_id, /^[0-9a-f]{64}$/, "batch_id = source_sha256 (raw upstream bytes hash)");
    assert.ok(w.tags.source_url.startsWith(BASE_URL), "source_url is the per-object MEME URL");
  }
  // batch_id (source_sha256) matches an independent hash of the raw MEME bytes.
  {
    const memeName0 = "MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt";
    const rawSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(FIXTURES_DIR, "meme", memeName0))).digest("hex");
    assert.equal(storage[0].tags.batch_id, rawSha);
    assert.equal(storage[0].tags.source_url, BASE_URL + memeName0);
  }

  // Canonical record bytes carry schema-exact keys (NORAD_CAT_ID, not norad_cat_id).
  const rec0 = JSON.parse(storage[0].data.toString("utf8"));
  assert.equal(rec0.CCSDS_OEM_VERS, 2.0);
  assert.equal(rec0.ORIGINATOR, "SpaceX");
  const blk0 = rec0.EPHEMERIS_DATA_BLOCK[0];
  assert.equal(blk0.NORAD_CAT_ID, 67850);
  assert.equal(blk0.OBJECT_NAME, "STARLINK-36840");
  assert.equal(blk0.OBJECT_ID, ""); // MEME COSPAR field is SpaceX-internal, not an intl designator
  assert.equal(blk0.CENTER_NAME, "EARTH");
  assert.equal(blk0.REFERENCE_FRAME, "TEME");
  assert.equal(blk0.TIME_SYSTEM, "UTC");
  assert.equal(blk0.START_TIME, "2026-05-14T01:42:42Z");
  assert.equal(blk0.STOP_TIME, "2026-05-17T01:42:42Z");
  assert.equal(blk0.STEP_SIZE, 60);
  assert.equal(blk0.STATE_VECTOR_SIZE, 6);
  // 12 trimmed states × 6 components.
  assert.equal(blk0.EPHEMERIS_DATA.length, 72);
  // First MEME state row, preserved to full double precision.
  assert.ok(Math.abs(blk0.EPHEMERIS_DATA[0] - -2877.5130811997) < 1e-9);
  assert.ok(Math.abs(blk0.EPHEMERIS_DATA[5] - -3.1147385352) < 1e-9);

  // Signed PNM structure per published object.
  assert.equal(publishes.length, 2);
  const memeName = "MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt";
  const pub0 = publishes.find((p) => p.message.PNM.FILE_NAME === memeName);
  assert.ok(pub0, "published PNM for the first object");
  assert.equal(pub0.topic, "sdn/data-source/spacex-starlink");
  const pnm = pub0.message.PNM;
  // Schema-exact PNM keys.
  for (const k of ["MULTIFORMAT_ADDRESS", "PUBLISH_TIMESTAMP", "CID", "FILE_NAME", "FILE_ID", "SIGNATURE", "SIGNATURE_TYPE"]) {
    assert.ok(k in pnm, `PNM missing ${k}`);
  }
  assert.equal(pnm.SIGNATURE_TYPE, "ed25519");
  // A2.2c-3: PNM.CID is now the real in-guest CIDv1 (raw/sha2-256/base32), which
  // byte-matches the CID the host assigns for the stored record bytes.
  assert.ok(pnm.CID.startsWith("bafkrei"), `PNM.CID is a CIDv1 raw block (got ${pnm.CID})`);
  assert.equal(pnm.CID, cidV1RawSha256(storage[0].data), "PNM.CID == host CID of the stored OEM record");
  assert.equal(pnm.MULTIFORMAT_ADDRESS, "/ipfs/" + pnm.CID);
  assert.equal(pnm.FILE_ID, "spacex-starlink:OEM:67850:2026-05-14T01:42:42Z");
  assert.equal(pnm.PUBLISH_TIMESTAMP, "2026-05-14T02:02:54Z");
  // SIGNATURE is base64 of a non-empty signature.
  assert.ok(Buffer.from(pnm.SIGNATURE, "base64").length > 0);

  // Provenance sidecar binds the raw MEME source by SHA-256 (DPM convention),
  // matching an independent hash of the fixture bytes.
  const prov = pub0.message.provenance;
  const expectedSha = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(FIXTURES_DIR, "meme", memeName)))
    .digest("hex");
  assert.equal(prov.SOURCE_SHA256, expectedSha);
  assert.equal(prov.SOURCE_NAME, "spacex-starlink");
  assert.equal(prov.DATA_SOURCE, "SpaceX-E");
  assert.equal(prov.RECORD_SCHEMA, "OEM");
  assert.equal(prov.NORAD_CAT_ID, 67850);
  assert.equal(prov.STATE_COUNT, 12);
  assert.equal(prov.SOURCE_URL, BASE_URL + memeName);
});

test("pull: raising the cap fetches more and skips unknown objects (404-safe)", async () => {
  // cap 3 → plans all 3 manifest entries; the 3rd has no fixture (404) → skipped.
  const { summary, storage } = await runPull({ objectCap: 3 });
  assert.equal(summary.manifest_entries, 3);
  assert.equal(summary.fetched, 2, "third object 404s and is skipped");
  assert.equal(summary.stored, 2);
  assert.equal(storage.length, 2);
});

test("pull: no config uses the default object cap", async () => {
  const { summary } = await runPull(null);
  assert.equal(summary.object_cap, 25, "default per-pull object cap");
  // Only 2 fixtures resolve, so fetched is bounded by available objects.
  assert.equal(summary.fetched, 2);
});
