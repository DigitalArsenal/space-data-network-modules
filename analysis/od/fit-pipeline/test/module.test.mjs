/*
 * OD Fit Pipeline module test (App 2, A2.3).
 *
 * Instantiates the rebuilt PURE_WASI module with a mock `space_data_module_host`
 * bridge that:
 *   - serves plugin.getConfig (empty → request payload drives the run),
 *   - serves storage.query("OEM") from a fixture constellation of canonical OEM
 *     records built from the SAME reference fixtures the OD gate uses (Starlink
 *     MEME → compact OEM, ISS CCSDS OEM → verbose OEM) plus honest-skip records,
 *   - captures storage.write (the fitted OMM records) + pubsub.publish (the signed
 *     PNMs), and returns a signature for keyslot.sign.
 *
 * It proves the real C++ path: storage.query → oem_record_to_series →
 * od::fit_sgp4_series → schema-exact OMM + provenance → signed PNM publish, per
 * provider, with an honest skip taxonomy — against the rebuilt artifact, no
 * network. The existing OD `fit` module and its gate suite are untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { inspectModule } from "space-data-module-sdk";
import { decodePluginManifest } from "space-data-module-sdk";
import { encodePlgManifest, legacyManifestToPlg } from "space-data-module-sdk/manifest";
import createOdFitPipelinePluginManifest from "../manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "dist", "od-fit-pipeline.wasm");
// __dirname = <root>/analysis/od/fit-pipeline/test → <root> is 4 up; the SDK dev
// keypair lives at repos/ancillary-packages (two more up from <root>).
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const KEYPAIR_PATH =
  process.env.SDN_MODULE_SIGNING_KEYPAIR ||
  path.resolve(REPO_ROOT, "../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json");

// Reference fixtures the OD gate suite already ships (read-only reuse).
const REF_DIR = path.join(__dirname, "..", "..", "tests", "data", "supgp-reference");
const STARLINK_MEME_DIR = path.join(REF_DIR, "starlink", "meme");
const ISS_OEM_PATH = path.join(REF_DIR, "iss", "ISS.OEM_J2K_EPH.trimmed.txt");

// ── faithful OEM-record builders (mirror the adapters' storage.write output) ──

function normalizeUtc(s) {
  s = s.trim().replace(/ UTC$/, "").replace(" ", "T");
  return s.endsWith("Z") ? s : s + "Z";
}

// SpaceX MEME → compact row-major SDS OEM JSON (Starlink adapter shape).
function memeToCompactOem(memePath) {
  const text = fs.readFileSync(memePath, "utf8");
  const base = path.basename(memePath);
  const parts = base.split("_");
  const norad = Number.parseInt(parts[1], 10);
  const objectName = parts[2];
  const lines = text.split(/\r?\n/);
  let start = "";
  let step = 60;
  for (const line of lines) {
    const s = line.match(/ephemeris_start:([^]*?)ephemeris_stop:/);
    if (s) start = normalizeUtc(s[1]);
    const z = line.match(/step_size:(\d+)/);
    if (z) step = Number.parseInt(z[1], 10);
  }
  const data = [];
  for (const line of lines) {
    const toks = line.trim().split(/\s+/);
    if (toks.length >= 7 && /^\d{13}/.test(toks[0])) {
      for (let c = 1; c <= 6; c++) data.push(Number.parseFloat(toks[c]));
    }
  }
  const stopIdx = data.length / 6;
  const stop = start; // not used by the fit; kept for shape fidelity
  return {
    json: JSON.stringify({
      CCSDS_OEM_VERS: 2.0,
      CREATION_DATE: start,
      ORIGINATOR: "SpaceX",
      CLASSIFICATION: "UNCLASSIFIED",
      EPHEMERIS_DATA_BLOCK: [
        {
          OBJECT_NAME: objectName,
          OBJECT_ID: "",
          NORAD_CAT_ID: norad,
          CENTER_NAME: "EARTH",
          REFERENCE_FRAME: "TEME",
          TIME_SYSTEM: "UTC",
          START_TIME: start,
          STOP_TIME: stop,
          STEP_SIZE: step,
          STATE_VECTOR_SIZE: 6,
          EPHEMERIS_DATA: data,
        },
      ],
    }),
    norad,
    stateCount: stopIdx,
  };
}

// NASA ISS CCSDS OEM KVN → verbose explicit-epoch SDS OEM JSON (ISS adapter shape).
function issToVerboseOem(oemPath) {
  const text = fs.readFileSync(oemPath, "utf8");
  const lines = text.split(/\r?\n/);
  const meta = {};
  let inMeta = false;
  const states = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith("COMMENT")) continue;
    if (t === "META_START") { inMeta = true; continue; }
    if (t === "META_STOP") { inMeta = false; continue; }
    if (inMeta) {
      const m = t.match(/^(\w+)\s*=\s*(.+)$/);
      if (m) meta[m[1]] = m[2].trim();
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(t) && !t.includes("=")) {
      const toks = t.split(/\s+/);
      if (toks.length >= 7) {
        states.push({
          EPOCH: toks[0],
          X: Number.parseFloat(toks[1]),
          Y: Number.parseFloat(toks[2]),
          Z: Number.parseFloat(toks[3]),
          X_DOT: Number.parseFloat(toks[4]),
          Y_DOT: Number.parseFloat(toks[5]),
          Z_DOT: Number.parseFloat(toks[6]),
        });
      }
    }
  }
  return {
    json: JSON.stringify({
      CCSDS_OEM_VERS: 2.0,
      CREATION_DATE: meta.START_TIME || "",
      ORIGINATOR: "NASA",
      CLASSIFICATION: "UNCLASSIFIED",
      EPHEMERIS_DATA_BLOCK: [
        {
          OBJECT_NAME: meta.OBJECT_NAME || "ISS",
          OBJECT_ID: meta.OBJECT_ID || "1998-067-A",
          NORAD_CAT_ID: 25544,
          CENTER_NAME: (meta.CENTER_NAME || "EARTH").toUpperCase(),
          REFERENCE_FRAME: meta.REF_FRAME || "EME2000",
          TIME_SYSTEM: meta.TIME_SYSTEM || "UTC",
          START_TIME: meta.START_TIME || "",
          STOP_TIME: meta.STOP_TIME || "",
          STEP_SIZE: 0,
          STATE_VECTOR_SIZE: 6,
          EPHEMERIS_DATA_LINES: states,
        },
      ],
    }),
    norad: 25544,
    stateCount: states.length,
  };
}

// A OneWeb-style honest "shell" (undecodable LTEF): declared frame UNKNOWN, no
// state data — the pipeline must SKIP it, never fabricate a fit.
function onewebShellOem() {
  return JSON.stringify({
    CCSDS_OEM_VERS: 2.0,
    ORIGINATOR: "OneWeb",
    EPHEMERIS_DATA_BLOCK: [
      {
        OBJECT_NAME: "ONEWEB-0001",
        OBJECT_ID: "",
        NORAD_CAT_ID: 44057,
        CENTER_NAME: "EARTH",
        REFERENCE_FRAME: "UNKNOWN",
        TIME_SYSTEM: "UTC",
        START_TIME: "",
        STEP_SIZE: 0,
        STATE_VECTOR_SIZE: 6,
        EPHEMERIS_DATA_LINES: [],
      },
    ],
  });
}

// ── GLONASS-style IGS20 (ECEF) + GPS-time + position-only fixture ─────────────
// A2.4-prereq: the OD side now transforms ECEF->TEME (GMST) and GPS->UTC and fits
// position-only. To make an END-TO-END fixture that actually fits, we build a
// self-consistent Keplerian GLONASS-like orbit in TEME and rotate it to ECEF with
// the SAME GMST formula the C++ uses (od::gmst_1982), then label epochs in GPS
// time. The pipeline round-trips GPS->UTC + ECEF->TEME and recovers the orbit.
// This is synthetic test scaffolding (a self-consistent orbit), NOT fabricated
// provider data. The real IAC GLONASS SP3 arc drives the native OD fit test.
const MU_KM = 398600.8;
function gmst1982Rad(jdUt1) {
  const t = (jdUt1 - 2451545.0) / 36525.0;
  let sec = 67310.54841 + (876600.0 * 3600.0 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t * t * t;
  sec = sec % 86400.0;
  if (sec < 0) sec += 86400.0;
  let rad = ((sec * (Math.PI / 180.0)) / 240.0) % (2 * Math.PI);
  if (rad < 0) rad += 2 * Math.PI;
  return rad;
}
// TEME -> ECEF is rot_z(+gmst) (inverse of the OD ecef_to_teme = rot_z(-gmst)).
function temeToEcef(gmst, r) {
  const c = Math.cos(gmst), s = Math.sin(gmst);
  return [c * r[0] + s * r[1], -s * r[0] + c * r[1], r[2]];
}
// JD at 0h UTC of a Gregorian date (matches od::jd_from_ymd).
function jdFromYmd(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  const jdn = d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
  return jdn - 0.5;
}
function glonassPositionOnlyOem({ objectName = "R03", norad = 0, count = 16 } = {}) {
  const a = 25510.0;          // km (GLONASS semi-major axis)
  const inc = 64.8 * Math.PI / 180.0;
  const n = Math.sqrt(MU_KM / (a * a * a));   // rad/s
  const jdUtc0 = jdFromYmd(2026, 7, 11);      // 2026-07-11 00:00 UTC
  const gpsOffsetDays = 18.0 / 86400.0;       // UTC = GPS - 18 s in 2026
  const lines = [];
  for (let i = 0; i < count; i++) {
    const dt = i * 900.0;                      // s
    const jdUtc = jdUtc0 + dt / 86400.0;
    const theta = n * dt;                      // argument of latitude (RAAN=0, circular)
    const rTeme = [
      a * Math.cos(theta),
      a * Math.sin(theta) * Math.cos(inc),
      a * Math.sin(theta) * Math.sin(inc),
    ];
    const rEcef = temeToEcef(gmst1982Rad(jdUtc), rTeme);
    // Label the epoch in GPS time (UTC + 18 s); the pipeline converts back.
    const jdGps = jdUtc + gpsOffsetDays;
    const iso = jdGpsToIso(jdGps);
    lines.push({ EPOCH: iso, X: rEcef[0], Y: rEcef[1], Z: rEcef[2] });
  }
  return JSON.stringify({
    CCSDS_OEM_VERS: 2.0,
    ORIGINATOR: "IAC",
    EPHEMERIS_DATA_BLOCK: [
      {
        OBJECT_NAME: objectName,
        OBJECT_ID: "",
        NORAD_CAT_ID: norad,
        CENTER_NAME: "EARTH",
        REFERENCE_FRAME: "IGS20",
        TIME_SYSTEM: "GPS",
        STEP_SIZE: 0,
        STATE_VECTOR_SIZE: 3,
        EPHEMERIS_DATA_LINES: lines,
      },
    ],
  });
}
// Render a JD (UTC-labeled numeric) to an ISO string the OD iso_to_jd accepts.
function jdGpsToIso(jd) {
  const ms = (jd - 2440587.5) * 86400000.0;
  return new Date(Math.round(ms)).toISOString().replace("Z", "");
}

// A still-unsupported frame (local-orbit RSW) → fail-closed skip, keeping the
// unsupported-frame taxonomy tested now that ITRF/IGS20/ECEF are supported.
function unsupportedFrameOem() {
  const lines = [];
  for (let i = 0; i < 12; i++) {
    lines.push({
      EPOCH: `2026-07-13T00:${String(i).padStart(2, "0")}:00.000`,
      X: 15000 + i, Y: -12000 + i, Z: 18000 + i, X_DOT: 1.1, Y_DOT: -2.2, Z_DOT: 0.5,
    });
  }
  return JSON.stringify({
    CCSDS_OEM_VERS: 2.0,
    ORIGINATOR: "IAC",
    EPHEMERIS_DATA_BLOCK: [
      {
        OBJECT_NAME: "COSMOS-RSW",
        OBJECT_ID: "",
        NORAD_CAT_ID: 0,
        CENTER_NAME: "EARTH",
        REFERENCE_FRAME: "RSW",
        TIME_SYSTEM: "UTC",
        STEP_SIZE: 0,
        STATE_VECTOR_SIZE: 6,
        EPHEMERIS_DATA_LINES: lines,
      },
    ],
  });
}

function record(cid, sourceName, jsonStr) {
  return {
    CID: cid,
    RowID: 1,
    PeerID: "",
    Timestamp: "2026-07-13T00:00:00Z",
    Data: Buffer.from(jsonStr, "utf8").toString("base64"),
    Signature: "",
    SourceTags: { ProviderID: "", SourceName: sourceName, SourceURL: "", BatchID: "" },
    StreamPath: "",
    StreamOffset: 0,
    RecordLength: jsonStr.length,
  };
}

function buildFixtureConstellation() {
  const memeFiles = fs
    .readdirSync(STARLINK_MEME_DIR)
    .filter((f) => f.startsWith("MEME_") && f.endsWith(".txt"))
    .sort()
    .slice(0, 3)
    .map((f) => path.join(STARLINK_MEME_DIR, f));

  const records = [];
  for (const mp of memeFiles) {
    const oem = memeToCompactOem(mp);
    records.push(record(`cid-sx-${oem.norad}`, "spacex-starlink", oem.json));
  }
  const iss = issToVerboseOem(ISS_OEM_PATH);
  records.push(record("cid-iss-25544", "iss", iss.json));

  // Honest-skip fixture: undecodable shell (unsupported UNKNOWN frame / empty).
  records.push(record("cid-oneweb-shell", "oneweb", onewebShellOem()));
  // GLONASS: a fittable IGS20 (ECEF) + GPS-time + position-only orbit (A2.4-prereq
  // capability), plus a still-unsupported RSW frame that must fail-closed.
  records.push(record("cid-glonass-igs20", "glonass", glonassPositionOnlyOem()));
  records.push(record("cid-glonass-rsw", "glonass", unsupportedFrameOem()));
  // Unconfigured provider (no matching provider config).
  records.push(record("cid-planet-x", "planet", onewebShellOem()));

  return { records, starlinkCount: memeFiles.length };
}

// ── mock host bridge ─────────────────────────────────────────────────────────

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

function loadWasm() {
  assert.ok(fs.existsSync(WASM_PATH), `built module not found at ${WASM_PATH}; run \`node build.mjs\` first`);
  return new Uint8Array(fs.readFileSync(WASM_PATH));
}

async function runPipeline(config, fixtureRecords) {
  const { stripWasmCustomSections } = await import("space-data-module-sdk/bundle");
  const loadable = stripWasmCustomSections(loadWasm());

  const captured = { storage: [], publishes: [], queries: 0 };
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

  const host = {
    call(opPtr, opLen, payloadPtr, payloadLen) {
      const op = readStr(opPtr, opLen);
      const req = readReqMeta(payloadPtr, payloadLen);
      let meta;
      if (op === "plugin.getConfig") {
        meta = { ok: false, error: { message: "no module config" } };
      } else if (op === "storage.query") {
        captured.queries++;
        assert.equal(req.schema, "OEM", "pipeline queries the OEM schema");
        meta = { ok: true, result: fixtureRecords };
      } else if (op === "storage.write") {
        const data = Buffer.from(req.data, "base64");
        captured.storage.push({ schema: req.schema, data });
        meta = { ok: true, result: { cid: "cid-omm-" + crypto.createHash("sha256").update(data).digest("hex").slice(0, 16) } };
      } else if (op === "keyslot.sign") {
        meta = { ok: true, result: { signature: Buffer.alloc(64, 0x2b).toString("base64"), algorithm: "ed25519" } };
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

  // The PURE_WASI build imports a small wasi_snapshot_preview1 set (stdio/environ
  // pulled in by libc++ iostream/exception machinery). None are exercised on the
  // happy path; stub them so the module instantiates in plain Node (the real SDN
  // host provides a full WASI runtime). Mirrors what the WasmEdge/browser hosts do.
  const wasi = {
    fd_close: () => 0,
    fd_seek: () => 0,
    fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) => {
      const dv = new DataView(instance.exports.memory.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) total += dv.getUint32(iovsPtr + i * 8 + 4, true);
      dv.setUint32(nwrittenPtr, total, true);
      return 0;
    },
    environ_sizes_get: (countPtr, sizePtr) => {
      const dv = new DataView(instance.exports.memory.buffer);
      dv.setUint32(countPtr, 0, true);
      dv.setUint32(sizePtr, 0, true);
      return 0;
    },
    environ_get: () => 0,
  };

  const wasm = await WebAssembly.instantiate(loadable, { space_data_module_host: host, wasi_snapshot_preview1: wasi });
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

const PIPELINE_CONFIG = {
  querySchema: "OEM",
  queryLimit: 500,
  providers: [
    {
      sourceName: "spacex-starlink",
      dataSource: "SpaceX-E",
      outputTopic: "sdn/supgp/spacex-starlink",
      signingSlot: "node-signing",
      signatureType: "ed25519",
      fileIdPrefix: "sdn-supgp-spacex-starlink",
      fit: { maxIterations: 50, fitWindowSec: 11520, subsample: 0 },
    },
    { sourceName: "iss", dataSource: "ISS-E", outputTopic: "sdn/supgp/iss", fit: { maxIterations: 60 } },
    { sourceName: "oneweb", dataSource: "OneWeb-E", outputTopic: "sdn/supgp/oneweb" },
    // GLONASS is a short synthetic arc of a pure-Keplerian orbit (not perfectly
    // SGP4-representable), so the fit is credible but need not trip the strict
    // convergence flag — this exercises the ECEF/GPS/position-only PATH.
    { sourceName: "glonass", dataSource: "GLONASS-RE", outputTopic: "sdn/supgp/glonass", requireConverged: false },
  ],
};

// ── ABI + manifest contract ───────────────────────────────────────────────────

const REQUIRED_EXPORTS = [
  "plugin_invoke_stream",
  "plugin_alloc",
  "plugin_free",
  "plugin_get_manifest_flatbuffer",
  "plugin_get_manifest_flatbuffer_size",
];

test("module builds as a valid signed SDN artifact", async () => {
  const keypair = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  await verifyModuleArtifact(loadWasm(), { trustedPublicKeys: [keypair.publicKeyHex], requireSignature: true });
});

test("module exports the canonical plugin ABI", async () => {
  const { exports } = await inspectModule(loadWasm());
  const names = exports.map((e) => (typeof e === "string" ? e : e.name));
  for (const name of REQUIRED_EXPORTS) {
    assert.ok(names.includes(name), `missing ABI export: ${name}`);
  }
});

test("manifest declares the storage_query read lane + timers + fit_pipeline method", async () => {
  const manifest = decodePluginManifest(encodePlgManifest(legacyManifestToPlg(createOdFitPipelinePluginManifest())));
  assert.equal(manifest.pluginId, "com.orbpro.od-fit-pipeline");

  const methodIds = (manifest.methods || []).map((m) => m.methodId);
  assert.ok(methodIds.includes("fit_pipeline"), `missing fit_pipeline method (have: ${methodIds.join(", ")})`);

  const caps = (manifest.hostCapabilities || []).map((c) => c.capability);
  for (const cap of ["storage_query", "storage_write", "wallet_sign", "crypto_sign", "pubsub"]) {
    assert.ok(caps.includes(cap), `missing host capability: ${cap} (have: ${caps.join(", ")})`);
  }

  const timers = manifest.timers || [];
  const t = timers.find((x) => x.timerId === "od-fit-pull");
  assert.ok(t, `missing od-fit-pull timer (have: ${timers.map((x) => x.timerId).join(", ")})`);
  assert.equal(t.methodId, "fit_pipeline", "od-fit-pull timer must invoke fit_pipeline");
});

// ── end-to-end fixture constellation ──────────────────────────────────────────

test("pipeline: storage.query → per-object fit → schema-exact OMM + signed PNM, per provider", async () => {
  const { records, starlinkCount } = buildFixtureConstellation();
  const { summary, storage, publishes, queries } = await runPipeline(PIPELINE_CONFIG, records);

  assert.equal(summary.ok, true);
  assert.equal(summary.query_ok, true, "storage.query lane worked");
  assert.ok(queries >= 1, "pipeline issued a storage.query read");
  assert.equal(summary.records_seen, records.length);
  assert.equal(summary.unconfigured, 1, "the planet record has no configured provider");

  const byProvider = Object.fromEntries(summary.providers.map((p) => [p.source_name, p]));

  // Starlink: every reference object fits + publishes.
  const sx = byProvider["spacex-starlink"];
  assert.equal(sx.data_source, "SpaceX-E");
  assert.equal(sx.candidates, starlinkCount);
  assert.equal(sx.fitted, starlinkCount, "all Starlink reference objects fit");
  assert.equal(sx.published, starlinkCount);
  assert.equal(sx.stored, starlinkCount);
  assert.equal(sx.signed, starlinkCount);

  // ISS (verbose EME2000 → TEME) fits + publishes.
  const iss = byProvider["iss"];
  assert.equal(iss.fitted, 1, "ISS verbose OEM fits");
  assert.equal(iss.published, 1);

  // Honest skip taxonomy: undecodable shell (UNKNOWN frame / empty).
  const ow = byProvider["oneweb"];
  assert.equal(ow.fitted, 0);
  assert.ok(ow.skipped.some((s) => s.includes("unsupported-frame:UNKNOWN") || s.includes("empty-ephemeris")), `oneweb skip reason: ${JSON.stringify(ow.skipped)}`);

  // GLONASS: the IGS20 (ECEF) + GPS-time + position-only orbit now FITS; the RSW
  // (local-orbit) record still fails closed. No registry -> unmapped-object-id.
  const gl = byProvider["glonass"];
  assert.equal(gl.candidates, 2, "glonass has the IGS20 orbit + the RSW skip record");
  assert.equal(gl.fitted, 1, "the position-only IGS20/GPS orbit fits");
  assert.equal(gl.published, 1);
  assert.equal(gl.id_unmapped, 1, "no registry configured -> honest unmapped-object-id");
  assert.equal(gl.id_mapped, 0);
  assert.ok(gl.skipped.some((s) => s.includes("unsupported-frame:RSW")), `glonass skip reasons: ${JSON.stringify(gl.skipped)}`);

  // Total published OMM records = fittable objects (Starlink + ISS + GLONASS).
  const totalPublished = summary.providers.reduce((a, p) => a + p.published, 0);
  assert.equal(totalPublished, starlinkCount + 2);
  assert.equal(storage.length, totalPublished, "one stored OMM per published fit");
  assert.equal(publishes.length, totalPublished);

  // Every stored record is an OMM with schema-exact GP keys + provenance lineage.
  for (const w of storage) {
    assert.equal(w.schema, "OMM");
    const omm = JSON.parse(w.data.toString("utf8"));
    for (const k of ["NORAD_CAT_ID", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "EPOCH", "DATA_SOURCE"]) {
      assert.ok(k in omm, `stored OMM missing schema key ${k}`);
    }
    assert.ok(["SpaceX-E", "ISS-E", "GLONASS-RE"].includes(omm.DATA_SOURCE), `unexpected DATA_SOURCE ${omm.DATA_SOURCE}`);
    assert.ok(Array.isArray(omm.COMMENT) && omm.COMMENT.length > 0, "OMM carries COMMENT provenance");
    assert.ok(typeof omm.USER_DEFINED_SDN_SOURCE_CID === "string" && omm.USER_DEFINED_SDN_SOURCE_CID.length > 0, "OMM carries source CID lineage");
    assert.ok(/^[0-9a-f]{64}$/.test(omm.USER_DEFINED_SDN_SOURCE_SHA256), "OMM carries source SHA-256 lineage");
    assert.ok(["source", "registry-mapped", "unmapped-object-id"].includes(omm.USER_DEFINED_SDN_ID_STATUS), `OMM carries an ID-status tag (got ${omm.USER_DEFINED_SDN_ID_STATUS})`);
    // GLONASS is unmapped here -> honest-empty NORAD; the others carry their IDs.
    if (omm.DATA_SOURCE === "GLONASS-RE") {
      assert.equal(omm.USER_DEFINED_SDN_ID_STATUS, "unmapped-object-id");
      assert.equal(omm.NORAD_CAT_ID, 0, "unmapped GLONASS OMM keeps NORAD honest-empty");
    } else {
      assert.equal(omm.CONVERGED, true, "published Starlink/ISS OMM fits are converged");
    }
  }

  // Every publish is a schema-exact PNM on the provider's OMM topic + provenance sidecar.
  for (const p of publishes) {
    assert.ok(p.topic.startsWith("sdn/supgp/"), `unexpected topic ${p.topic}`);
    const pnm = p.message.PNM;
    for (const k of ["MULTIFORMAT_ADDRESS", "PUBLISH_TIMESTAMP", "CID", "FILE_NAME", "FILE_ID", "SIGNATURE", "SIGNATURE_TYPE"]) {
      assert.ok(k in pnm, `PNM missing ${k}`);
    }
    assert.equal(pnm.SIGNATURE_TYPE, "ed25519");
    assert.ok(pnm.FILE_ID.includes(":OMM:"), `FILE_ID not an OMM partition: ${pnm.FILE_ID}`);
    const prov = p.message.provenance;
    assert.equal(prov.RECORD_SCHEMA, "OMM");
    assert.equal(prov.SOURCE_RECORD_SCHEMA, "OEM");
    assert.ok(/^[0-9a-f]{64}$/.test(prov.SOURCE_SHA256), "provenance carries source SHA-256");
  }
});

test("pipeline: ISS OMM is physically plausible (EME2000→TEME fit sanity)", async () => {
  const { records } = buildFixtureConstellation();
  const { storage } = await runPipeline(PIPELINE_CONFIG, records);
  const issOmm = storage
    .map((w) => JSON.parse(w.data.toString("utf8")))
    .find((o) => o.DATA_SOURCE === "ISS-E");
  assert.ok(issOmm, "ISS OMM produced");
  assert.equal(issOmm.NORAD_CAT_ID, 25544);
  assert.ok(issOmm.MEAN_MOTION > 15.3 && issOmm.MEAN_MOTION < 15.7, `MEAN_MOTION=${issOmm.MEAN_MOTION} not ISS-like`);
  assert.ok(issOmm.INCLINATION > 51.0 && issOmm.INCLINATION < 52.2, `INCLINATION=${issOmm.INCLINATION} not ISS-like`);
  assert.ok(issOmm.ECCENTRICITY < 0.01, `ECCENTRICITY=${issOmm.ECCENTRICITY} too high`);
});

test("pipeline: ID registry seam maps a GLONASS slot -> NORAD (owner data), else honest-empty", async () => {
  // With an owner-supplied idRegistry mapping the record's OBJECT_NAME ("R03")
  // to a NORAD/COSPAR, the fitted GLONASS OMM carries those IDs and is tagged
  // "registry-mapped". Without a match, IDs stay honest-empty + "unmapped-object-id".
  const { records } = buildFixtureConstellation();
  const configWithRegistry = {
    ...PIPELINE_CONFIG,
    idRegistry: {
      "R03": { NORAD_CAT_ID: 32275, OBJECT_ID: "2007-052A" },
      // A decoy entry for a different key proves lookup is exact-match, not fuzzy.
      "R99": { NORAD_CAT_ID: 99998, OBJECT_ID: "1999-099Z" },
    },
  };
  const { summary, storage } = await runPipeline(configWithRegistry, records);
  const gl = Object.fromEntries(summary.providers.map((p) => [p.source_name, p]))["glonass"];
  assert.equal(gl.fitted, 1, "the IGS20 orbit still fits with a registry configured");
  assert.equal(gl.id_mapped, 1, "R03 resolved via the registry");
  assert.equal(gl.id_unmapped, 0);

  const glonassOmm = storage
    .map((w) => JSON.parse(w.data.toString("utf8")))
    .find((o) => o.DATA_SOURCE === "GLONASS-RE");
  assert.ok(glonassOmm, "GLONASS OMM produced");
  assert.equal(glonassOmm.NORAD_CAT_ID, 32275, "registry NORAD applied (never fabricated in-parser)");
  assert.equal(glonassOmm.OBJECT_ID, "2007-052A", "registry COSPAR applied");
  assert.equal(glonassOmm.USER_DEFINED_SDN_ID_STATUS, "registry-mapped");
  // The ECEF->TEME + GPS->UTC + position-only fit recovers credible GLONASS
  // elements: n ~2.13 rev/day (period ~11.26 h), i ~64.8 deg, near-circular.
  assert.ok(glonassOmm.MEAN_MOTION > 2.0 && glonassOmm.MEAN_MOTION < 2.3, `GLONASS MEAN_MOTION=${glonassOmm.MEAN_MOTION}`);
  assert.ok(glonassOmm.INCLINATION > 63.0 && glonassOmm.INCLINATION < 67.0, `GLONASS INCLINATION=${glonassOmm.INCLINATION}`);
  assert.ok(glonassOmm.ECCENTRICITY < 0.02, `GLONASS ECCENTRICITY=${glonassOmm.ECCENTRICITY}`);

  // Control: the SAME records with NO registry stay honest-empty + unmapped.
  const { summary: s2, storage: st2 } = await runPipeline(PIPELINE_CONFIG, records);
  const gl2 = Object.fromEntries(s2.providers.map((p) => [p.source_name, p]))["glonass"];
  assert.equal(gl2.id_mapped, 0);
  assert.equal(gl2.id_unmapped, 1);
  const glonassOmm2 = st2.map((w) => JSON.parse(w.data.toString("utf8"))).find((o) => o.DATA_SOURCE === "GLONASS-RE");
  assert.equal(glonassOmm2.NORAD_CAT_ID, 0, "no registry -> honest-empty NORAD");
  assert.equal(glonassOmm2.USER_DEFINED_SDN_ID_STATUS, "unmapped-object-id");
});

test("pipeline: cron nil input falls back to compiled provider defaults (no crash)", async () => {
  // Cron invokes with nil/empty input; plugin.getConfig returns nothing → the
  // compiled fallback (spacex-starlink + iss) drives. Records still fit.
  const { records, starlinkCount } = buildFixtureConstellation();
  const { summary } = await runPipeline(null, records);
  assert.equal(summary.ok, true);
  const byProvider = Object.fromEntries(summary.providers.map((p) => [p.source_name, p]));
  assert.ok(byProvider["spacex-starlink"], "fallback config includes spacex-starlink");
  assert.equal(byProvider["spacex-starlink"].fitted, starlinkCount);
  assert.equal(byProvider["iss"].fitted, 1);
});
