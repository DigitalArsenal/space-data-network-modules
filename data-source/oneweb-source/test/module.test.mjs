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
import createOnewebSourcePluginManifest from "../manifest.js";

function encodeEmbeddedManifest() {
  return encodePlgManifest(legacyManifestToPlg(createOnewebSourcePluginManifest()));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "dist", "oneweb-source.wasm");
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
  assert.equal(manifest.pluginId, "com.orbpro.oneweb-source");
  assert.equal(manifest.pluginFamily, "data_source");
  const methodIds = (manifest.methods || []).map((m) => m.methodId);
  assert.ok(methodIds.includes("pull"), `missing pull method (have: ${methodIds.join(", ")})`);
  const caps = (manifest.hostCapabilities || []).map((c) => c.capability);
  for (const cap of ["http", "storage_write", "wallet_sign", "crypto_sign", "pubsub"]) {
    assert.ok(caps.includes(cap), `missing host capability: ${cap} (have: ${caps.join(", ")})`);
  }
  const timers = manifest.timers || [];
  const pullTimer = timers.find((t) => t.timerId === "oneweb-pull");
  assert.ok(pullTimer, `missing oneweb-pull timer (have: ${timers.map((t) => t.timerId).join(", ")})`);
  assert.equal(pullTimer.methodId, "pull");
});

test("built WASM embeds + returns the real manifest", async () => {
  const encoded = encodeEmbeddedManifest();
  const { stripWasmCustomSections } = await import("space-data-module-sdk/bundle");
  const loadable = stripWasmCustomSections(loadWasm());
  const stub = () => 0;
  const { instance } = await WebAssembly.instantiate(loadable, {
    space_data_module_host: { call: stub, response_len: stub, read_response: stub, clear_response: stub, last_status_code: stub },
  });
  const ex = instance.exports;
  const size = ex.plugin_get_manifest_flatbuffer_size();
  assert.equal(size, encoded.length, `embedded manifest size ${size} != encoded ${encoded.length}`);
  const ptr = ex.plugin_get_manifest_flatbuffer();
  const mem = new Uint8Array(ex.memory.buffer, ptr, size);
  assert.equal(decodePluginManifest(new Uint8Array(mem)).pluginId, "com.orbpro.oneweb-source");
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture-driven end-to-end pull (A2.2c). Serves the trimmed real LTEF over
// http.request; captures storage.write + pubsub.publish. No live network.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const LTEF_URL = "https://ephemeris.oneweb.net/ltef/ltef.csv";
const FIXTURE_FILE = "ltef.sample.csv";

function u32le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
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
    if (url === LTEF_URL) {
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
      } else if (op === "storage.write") {
        const data = Buffer.from(req.data, "base64");
        captured.storage.push({ schema: req.schema, data });
        meta = { ok: true, result: { cid: "cid-" + crypto.createHash("sha256").update(data).digest("hex") } };
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

  const wasm = await WebAssembly.instantiate(loadable, { space_data_module_host: host });
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
  const summary = JSON.parse(new TextDecoder().decode(readBytes(resultPtr, outLen)));
  return { summary, ...captured };
}

test("pull: LTEF parse → capped OEM shells + signed PNMs (honest, no fabricated state)", async () => {
  const { summary, storage, publishes } = await runPull({ objectCap: 3 });

  assert.equal(summary.ok, true);
  assert.equal(summary.fetch_status, 200);
  assert.equal(summary.ltef_rows, 5, "5 fixture rows");
  assert.equal(summary.object_cap, 3);
  assert.equal(summary.records, 3, "capped to 3 satellite records");
  assert.equal(summary.record_schema, "OEM");
  assert.equal(summary.decode_status, "unresolved-ltef-encoding");
  assert.equal(summary.fetched, 1);
  assert.equal(summary.stored, 3);
  assert.equal(summary.signed, 3);
  assert.equal(summary.published, 3);

  assert.equal(storage.length, 3);
  for (const w of storage) assert.equal(w.schema, "OEM");

  // First record: schema-exact OEM shell with honest, validated metadata.
  const rec0 = JSON.parse(storage[0].data.toString("utf8"));
  assert.equal(rec0.CCSDS_OEM_VERS, 2.0);
  assert.equal(rec0.ORIGINATOR, "OneWeb");
  const blk0 = rec0.EPHEMERIS_DATA_BLOCK[0];
  assert.equal(blk0.OBJECT_NAME, "ONEWEB-7");
  assert.equal(blk0.OBJECT_ID, "", "LTEF carries no international designator");
  assert.equal(blk0.NORAD_CAT_ID, 0, "LTEF carries no NORAD id");
  assert.equal(blk0.CENTER_NAME, "EARTH");
  assert.equal(blk0.REFERENCE_FRAME, "UNKNOWN", "LTEF declares no frame; decode unresolved");
  assert.equal(blk0.TIME_SYSTEM, "UTC");
  // GPS-epoch seconds -> UTC (validated against the feed's timestamp.txt).
  assert.equal(blk0.START_TIME, "2026-07-13T12:33:21Z");
  assert.equal(blk0.STOP_TIME, "2026-07-13T12:33:21Z");
  assert.equal(blk0.STEP_SIZE, 0);
  assert.deepEqual(blk0.EPHEMERIS_DATA_LINES, [], "NO fabricated state vectors (honest empty)");
  assert.ok(String(blk0.COMMENT).includes("UNRESOLVED"), "block documents the unresolved decode");

  // Signed PNM.
  assert.equal(publishes.length, 3);
  const pub0 = publishes.find((p) => p.message.PNM.FILE_ID === "oneweb:OEM:7:2026-07-13T12:33:21Z");
  assert.ok(pub0, "published PNM for slot 7");
  assert.equal(pub0.topic, "sdn/data-source/oneweb");
  const pnm = pub0.message.PNM;
  for (const k of ["MULTIFORMAT_ADDRESS", "PUBLISH_TIMESTAMP", "CID", "FILE_NAME", "FILE_ID", "SIGNATURE", "SIGNATURE_TYPE"]) {
    assert.ok(k in pnm, `PNM missing ${k}`);
  }
  assert.equal(pnm.SIGNATURE_TYPE, "ed25519");
  assert.equal(pnm.FILE_NAME, "ltef.csv");
  assert.equal(pnm.PUBLISH_TIMESTAMP, "2026-07-13T12:33:21Z");
  assert.ok(pnm.CID.startsWith("cid-"));
  assert.equal(pnm.MULTIFORMAT_ADDRESS, "/ipfs/" + pnm.CID);
  assert.ok(Buffer.from(pnm.SIGNATURE, "base64").length > 0);

  // Provenance: raw file bound by SHA-256 + the raw encoded row preserved for a
  // future spec-based decode, flagged unresolved.
  const prov = pub0.message.provenance;
  const expectedSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(FIXTURES_DIR, FIXTURE_FILE))).digest("hex");
  assert.equal(prov.SOURCE_SHA256, expectedSha);
  assert.equal(prov.SOURCE_NAME, "oneweb");
  assert.equal(prov.DATA_SOURCE, "OneWeb-E");
  assert.equal(prov.RECORD_SCHEMA, "OEM");
  assert.equal(prov.OBJECT_NAME, "ONEWEB-7");
  assert.equal(prov.LTEF_SLOT, 7);
  assert.equal(prov.LTEF_COLUMNS, 17);
  assert.equal(prov.LTEF_EPOCH_GPS, 1467981201);
  assert.equal(prov.LTEF_EPOCH_UTC, "2026-07-13T12:33:21Z");
  assert.equal(prov.LTEF_REF_EPOCH_GPS, 1467979199);
  assert.equal(prov.LTEF_REF_EPOCH_UTC, "2026-07-13T11:59:59Z");
  assert.equal(prov.LTEF_RAW, "7,1467981201,1467979199,-74,-2,1897,4096,103868,252012,-30,-75,2,0,0,0,0,16");
  assert.equal(prov.DECODE_STATUS, "unresolved-ltef-encoding");
  assert.equal(prov.SOURCE_URL, LTEF_URL);
});

test("pull: default cap emits a record per fleet row (fixture has 5)", async () => {
  const { summary } = await runPull(null);
  assert.equal(summary.object_cap, 40, "default per-pull record cap");
  assert.equal(summary.records, 5, "all 5 fixture rows (< cap)");
  assert.equal(summary.published, 5);
});

test("pull: non-200 upstream fails closed", async () => {
  const { summary, storage, publishes } = await runPull(null, () => ({ status: 503, body: "" }));
  assert.equal(summary.fetch_status, 503);
  assert.equal(summary.fetched, 0);
  assert.equal(summary.records, 0);
  assert.equal(summary.stored, 0);
  assert.equal(summary.published, 0);
  assert.equal(storage.length, 0);
  assert.equal(publishes.length, 0);
});

test("pull: malformed LTEF (rows lacking slot+epochs) fails closed", async () => {
  const { summary, storage, publishes } = await runPull(null, () => ({
    status: 200,
    body: "garbage-no-commas\nnot,enough\nalso,just,two\n",
  }));
  assert.equal(summary.fetch_status, 200);
  assert.equal(summary.fetched, 1);
  // "also,just,two" has 3 cols but slot "also" is not an integer -> invalid.
  assert.equal(summary.records, 0, "no valid rows");
  assert.equal(summary.stored, 0);
  assert.equal(summary.published, 0);
  assert.equal(storage.length, 0);
  assert.equal(publishes.length, 0);
});
