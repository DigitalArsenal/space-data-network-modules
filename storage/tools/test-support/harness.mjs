// Shared test host for the storage modules: the BUILT artifacts linked into compiled flows and run on the WasmEdge leg of
// the SDK flow runtime host (createFlowRuntimeHost, runtimeTarget "wasmedge"), every hostcall decoded from its SDS $PIV
// request and answered with a real $PIV response at the space_data_module_host import. The node's credential store, its
// keyslot oracle (a REAL X25519 + HKDF-SHA256 + AES-256-GCM seal made here with node:crypto, opened by the test host),
// node.publicKey and the clock are played by this file; http.request is a real HTTP exchange (the mock S3 server, or R2).
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SUPPORT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MODULES_ROOT = path.resolve(SUPPORT_DIR, "..", "..", "..");

// The SDK is the one the object-s3 package installed (this directory is not a package: nothing here depends on it).
const SDK_PACKAGE = path.join(MODULES_ROOT, "storage", "object-s3", "package.json");
const sdkRequire = createRequire(SDK_PACKAGE);
const sdk = (name) => import(pathToFileURL(sdkRequire.resolve(`space-data-module-sdk/${name}`)).href);
const { decodeFlowNotice, decodeHostCall, encodeHostCallResult, encodeModuleConfig, encodeTimerTick } = await sdk("runtime-contracts");
const { decodeHttpResponse, encodeHttpRequest: encodeHtq } = await sdk("http");
const { createFlowRuntimeHost } = await sdk("flow");
// The standards checkout: SPACE_DATA_STANDARDS_ROOT, else the sibling of this repo, else (a task worktree) the stack
// checkout this repo is a submodule of, found through the shared git directory.
function findStandardsRoot() {
  if (process.env.SPACE_DATA_STANDARDS_ROOT) return process.env.SPACE_DATA_STANDARDS_ROOT;
  const sibling = path.resolve(MODULES_ROOT, "..", "spacedatastandards.org");
  if (fs.existsSync(path.join(sibling, "lib", "ts"))) return sibling;
  try {
    const common = execFileSync("git", ["-C", MODULES_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    const at = common.indexOf(`${path.sep}.git${path.sep}modules${path.sep}`);
    if (at > 0) return path.join(common.slice(0, at), "repos", "main-packages", "spacedatastandards.org");
  } catch { /* fall through */ }
  return sibling;
}
export const STANDARDS_ROOT = findStandardsRoot();

// ---- SDS records ---------------------------------------------------------------------------------------------------
async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const flatbuffersEntry = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: flatbuffersEntry }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
export const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);
export const APR = await loadStandard("APR");
export const QRP = await loadStandard("QRP");
export const FIL = await loadStandard("FIL");

export const typeRef = (schemaName, fileIdentifier, rootTypeName) => ({ schemaName, fileIdentifier, rootTypeName, wireFormat: "flatbuffer" });
export const T = {
  APR: typeRef("APR.fbs", "$APR", "APR"),
  QRP: typeRef("QRP.fbs", "$QRP", "QRP"),
  HTQ: typeRef("HttpRequestAbi.fbs", "$HTQ", "HttpRequest"),
};

export function finish(object, id, sizePrefixed = false) {
  const b = new flatbuffers.Builder(512);
  const offset = object.pack(b);
  if (sizePrefixed) b.finishSizePrefixed(offset, id); else b.finish(offset, id);
  return b.asUint8Array().slice();
}
export function apr({ route, method = 0, params = {}, body, accept = 0, requestId }) {
  const t = new APR.APRT();
  t.ROUTE = route;
  t.METHOD = method;
  t.ACCEPT = accept;
  if (requestId) t.REQUEST_ID = requestId;
  t.PARAMETERS = Object.entries(params).map(([k, v]) => Object.assign(new APR.APRParameterT(), { NAME: k, VALUE: String(v) }));
  if (body) t.BODY = body instanceof Uint8Array ? body : Array.from(body);
  return finish(t, "$APR");
}
export const idAt = (b, at) => Buffer.from(b.subarray(at, at + 4)).toString("latin1");
export function readApr(bytes) {
  return APR.APR.getRootAsAPR(new flatbuffers.ByteBuffer(Uint8Array.from(bytes))).unpack();
}
export function readFil(bytes) {
  return FIL.FIL.getRootAsFIL(new flatbuffers.ByteBuffer(Uint8Array.from(bytes))).unpack();
}
export function readQrp(bytes, sizePrefixed) {
  const body = sizePrefixed ? bytes.subarray(4, 4 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)) : bytes;
  return QRP.QRP.getRootAsQRP(new flatbuffers.ByteBuffer(Uint8Array.from(body))).unpack();
}
export const cellValue = (c) => (c.KIND === QRP.qrpValueKind.Text ? c.TEXT_VALUE : c.KIND === QRP.qrpValueKind.Bool ? c.BOOL_VALUE
  : c.KIND === QRP.qrpValueKind.Int ? Number(c.INT_VALUE) : c.KIND === QRP.qrpValueKind.Float ? c.FLOAT_VALUE
  : c.KIND === QRP.qrpValueKind.Bytes ? Buffer.from(c.BYTES_VALUE) : null);
export const rowsOf = (page) => page.ROWS.map((r) => Object.fromEntries(page.COLUMNS.map((c, i) => [c.NAME, cellValue(r.CELLS[i])])));
export const paramsOf = (record) => Object.fromEntries((record.PARAMETERS ?? []).map((p) => [p.NAME, p.VALUE]));

// ---- the keyslot (a real X25519 slot; the test host plays the node's oracle) ---------------------------------------
export const slot = crypto.generateKeyPairSync("x25519");
export const SLOT_PUBLIC = slot.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const INFO = Buffer.from("sdn-server/keyslot.unwrap/v1");
const aesKey = (privateKey, publicKey) => Buffer.from(crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey, publicKey }), Buffer.alloc(0), INFO, 32));
const x25519Public = (raw) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), raw]), format: "der", type: "spki" });

// Seals to the test host's slot, or to `recipient` (a node's raw 32-byte X25519 wrapping key) when given.
export function seal(plaintext, slotId = "provider-wrapping", recipient = null) {
  const eph = crypto.generateKeyPairSync("x25519");
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey(eph.privateKey, recipient ? x25519Public(Buffer.from(recipient)) : slot.publicKey), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ slotId, ephemeralPublicKey: eph.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
    nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") });
}
function unwrap(raw) {
  const sealed = Buffer.from(raw.ciphertext);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey(slot.privateKey, x25519Public(Buffer.from(raw.ephemeral_public_key))), Buffer.from(raw.nonce));
  decipher.setAuthTag(sealed.subarray(-16));
  return Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
}

// ---- real HTTP, synchronous (the import cannot await) --------------------------------------------------------------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "storage-harness-"));
let exchange = 0;
export function syncHttp({ method, url, headers, body, timeoutMs }) {
  const id = path.join(WORK, `x${++exchange}`);
  const request = { method, url, headers, timeoutMs, ...(body && body.length ? { bodyPath: `${id}.req` } : {}) };
  if (request.bodyPath) fs.writeFileSync(request.bodyPath, body);
  fs.writeFileSync(`${id}.json.in`, JSON.stringify(request));
  const run = spawnSync(process.execPath, [path.join(SUPPORT_DIR, "http-helper.mjs"), `${id}.json.in`, id], { stdio: "pipe", maxBuffer: 1 << 20 });
  const meta = run.status === 0 ? JSON.parse(fs.readFileSync(`${id}.json`, "utf8")) : { status: 0, url, headers: "", error: `helper exited ${run.status}: ${String(run.stderr)}` };
  const responseBody = run.status === 0 ? fs.readFileSync(`${id}.body`) : Buffer.alloc(0);
  for (const f of [`${id}.req`, `${id}.json.in`, `${id}.json`, `${id}.body`]) fs.rmSync(f, { force: true });
  return { ...meta, body: responseBody };
}

export async function startMockS3({ accessKey, secret, bucket, region }) {
  const child = spawn(process.execPath, [path.join(SUPPORT_DIR, "mock-s3.mjs"), accessKey, secret, bucket, region], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`mock-s3 exited ${code}`)));
    child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const control = async (p, init) => (await fetch(`${endpoint}${p}`, init)).text();
  return {
    endpoint,
    state: async () => JSON.parse(await control("/_mock/state")),
    failPart: (n) => control(`/_mock/fail-part?n=${n}`, { method: "POST" }),
    seed: (key, size, modified) => control(`/_mock/seed?key=${encodeURIComponent(key)}&size=${size}${modified ? `&modified=${encodeURIComponent(modified)}` : ""}`, { method: "POST" }),
    objectBytes: async (key) => { const state = await (await fetch(`${endpoint}/_mock/state`)).json(); return state.objects[key]; },
    reset: () => control("/_mock/reset", { method: "POST" }),
    stop: () => child.kill(),
  };
}

// ---- the node: the credential store, the keyslot, the clock, http --------------------------------------------------
export function createNode({ store = new Map(), publicKey = "hex", refuseWrites = false, refuseReads = false, now = null, http = syncHttp, withClock = true, config = null } = {}) {
  const calls = [];
  const answer = (call) => {
    const id = call.params?.ID;
    switch (call.op) {
      case "plugin.getConfig":
        return { ok: true, op: call.op, raw: { config: encodeModuleConfig(config ?? {}) } };
      case "node.publicKey":
        if (publicKey === "none") return { ok: false, error: { code: "unsupported", message: "no node key" } };
        return { ok: true, op: call.op, raw: { value: publicKey === "hex" ? SLOT_PUBLIC.toString("hex") : SLOT_PUBLIC } };
      case "clock.nowIso":
        if (!withClock) return { ok: false, error: { code: "unsupported", message: "no clock" } };
        return { ok: true, op: call.op, raw: { value: now ?? new Date().toISOString() } };
      case "secrets.status":
        return { ok: true, op: call.op, result: { ID: id, CONFIGURED: store.has(id) } };
      case "secrets.get": {
        if (refuseReads) return { ok: false, error: { code: "not-authorized", message: "no read grant" } };
        const held = store.get(id);
        return { ok: true, op: call.op, result: { ID: id, USERNAME: held?.username ?? "", CONFIGURED: !!held }, raw: { secret: held ? Buffer.from(held.secret) : new Uint8Array(0) } };
      }
      case "secrets.put":
        if (refuseWrites) return { ok: false, error: { code: "not-authorized", message: "no write grant" } };
        store.set(id, { username: call.params.USERNAME ?? "", secret: Buffer.from(call.raw.secret).toString() });
        return { ok: true, op: call.op, result: { ID: id, CONFIGURED: true } };
      case "secrets.clear":
        if (refuseWrites) return { ok: false, error: { code: "not-authorized", message: "no write grant" } };
        store.delete(id);
        return { ok: true, op: call.op };
      case "keyslot.unwrap":
        if (call.params.SLOT_ID !== "provider-wrapping") return { ok: false, error: { code: "invalid-params", message: "unknown slot" } };
        try { return { ok: true, op: call.op, raw: { data: unwrap(call.raw) } }; } catch { return { ok: false, error: { code: "failed", message: "open failed" } }; }
      case "http.request": {
        const headers = {};
        for (const line of Buffer.from(call.raw.headers ?? []).toString().split("\r\n")) {
          const at = line.indexOf(":");
          if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
        }
        const response = http({ method: call.params.METHOD || "GET", url: Buffer.from(call.raw.url).toString(), headers, body: call.raw.body, timeoutMs: call.params.TIMEOUT_MS || undefined });
        if (!response.status) return { ok: false, error: { code: "failed", message: response.error || "exchange failed" } };
        const max = Number(call.params.MAX_BYTES || 0);
        if (max && response.body.length > max) return { ok: false, error: { code: "too-large", message: `body of ${response.body.length} bytes exceeds MAX_BYTES ${max}` } };
        return { ok: true, op: call.op, result: { STATUS: response.status, RETRIEVED_MS: BigInt(Date.now()) }, raw: { url: response.url, headers: response.headers, body: response.body } };
      }
      default:
        return { ok: false, error: { code: "unsupported", message: call.op } };
    }
  };
  return { calls, store, answer };
}

// ---- flows ---------------------------------------------------------------------------------------------------------
const SDK_CLI = () => path.join(path.resolve(path.dirname(sdkRequire.resolve("space-data-module-sdk/compiler")), "..", ".."), "bin", "space-data-module.js");

// A committed flow (flows/<name>.flow.json) and its deps (flows/<name>/deps.json, paths relative to that directory).
export function loadFlow(name) {
  const flows = path.join(MODULES_ROOT, "flows");
  const flow = JSON.parse(fs.readFileSync(path.join(flows, `${name}.flow.json`), "utf8"));
  const raw = JSON.parse(fs.readFileSync(path.join(flows, name, "deps.json"), "utf8"));
  return { flow, deps: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, path.resolve(flows, name, v)])) };
}

// Compiles a flow with the SDK CLI and returns runtime.wasm.
export function compileFlow({ flow, deps }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-flow-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify(flow, null, 2));
  fs.writeFileSync(path.join(dir, "deps.json"), JSON.stringify(deps));
  execFileSync(process.execPath, [SDK_CLI(), "flow", "compile", path.join(dir, "flow.json"), "--deps", path.join(dir, "deps.json"), "--out", path.join(dir, "dist")], { stdio: "pipe", env: { ...process.env, SPACE_DATA_STANDARDS_ROOT: STANDARDS_ROOT } });
  const wasm = fs.readFileSync(path.join(dir, "dist", "runtime.wasm"));
  fs.rmSync(dir, { recursive: true, force: true });
  return wasm;
}

// Runs a compiled flow once: `inputs` are [{ trigger: <index into flow.triggers>, portId, payload }], every egress frame is
// returned. The node answers the hostcalls.
export async function runFlow({ wasm, node, inputs, sinks = ["sdn.flow.egress:emit"] }) {
  const memoryRef = { memory: null };
  let own = new Uint8Array(0);
  const imports = { space_data_module_host: {
    call(opPtr, opLen, ptr, len) {
      const call = decodeHostCall(Uint8Array.from(new Uint8Array(memoryRef.memory.buffer, ptr, len)));
      node.calls.push({ op: call.op, params: call.params });
      const r = node.answer(call);
      own = encodeHostCallResult(r.ok ? { ...r, op: call.op } : r);
      return 0;
    },
    response_len: () => own.length,
    read_response(dst, len) { const n = Math.min(len, own.length); new Uint8Array(memoryRef.memory.buffer).set(own.subarray(0, n), dst); return n; },
  } };
  const host = await createFlowRuntimeHost({ wasmSource: new Uint8Array(wasm), extraImports: imports, runtimeTarget: "wasmedge" });
  memoryRef.memory = host.memory;
  for (const input of inputs) host.enqueueTriggerFrame(input.trigger ?? 0, { portId: input.portId, bytes: input.payload });
  const outputs = [];
  const handlers = Object.fromEntries(sinks.map((s) => [s, ({ frames }) => { for (const f of frames) outputs.push(Uint8Array.from(f.bytes)); return { statusCode: 0 }; }]));
  await host.drain(handlers);
  return { outputs, host };
}

export { assert, decodeFlowNotice, decodeHttpResponse, encodeHtq, encodeTimerTick };
