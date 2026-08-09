// Drives the REAL wasm module against the REAL provider services, performing the
// host's http connector step here so the fetch is genuine rather than fixtured.
// Not a unit test: this is the "verify the endpoint against the live service
// before compiling it in" step the endpoints task demands.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sdkTesting = fileURLToPath(new URL(import.meta.resolve("space-data-module-sdk/testing")));
const sdkRoot = path.resolve(path.dirname(sdkTesting), "..", "..");
const req = createRequire(path.join(sdkRoot, "package.json"));
const flatbuffers = req("flatbuffers");
const { HttpRequest } = req(path.join(sdkRoot, "src/generated/http/sdn/http/http-request.js"));
const enc = new TextEncoder(), dec = new TextDecoder();

function htq({ method = "POST", path: p = "/api/v1/cellular/aggregate", body = "" }) {
  const b = new flatbuffers.Builder(1024);
  const m = b.createString(method), pa = b.createString(p), q = b.createString("");
  const bo = HttpRequest.createBodyVector(b, enc.encode(body));
  HttpRequest.startHttpRequest(b);
  HttpRequest.addMethod(b, m); HttpRequest.addPath(b, pa);
  HttpRequest.addQuery(b, q); HttpRequest.addBody(b, bo);
  HttpRequest.finishHttpRequestBuffer(b, HttpRequest.endHttpRequest(b));
  return { portId: "request", typeRef: { wireFormat: "flatbuffer" }, payload: b.asUint8Array() };
}
const json = (portId, v) => ({ portId, typeRef: { wireFormat: "flatbuffer" }, payload: enc.encode(JSON.stringify(v)) });
const byPort = (r) => { const m = new Map(); for (const f of r.outputs) m.set(f.portId, f); return m; };
const framesFor = (r, id) => r.outputs.filter((f) => f.portId === id);

const harness = await createBrowserModuleHarness({
  wasmSource: fs.readFileSync(`${ROOT}/dist/isomorphic/module.wasm`),
  manifest: JSON.parse(fs.readFileSync(`${ROOT}/plugin-manifest.json`, "utf8")),
  surface: "direct",
});

const PROVIDERS = process.env.E2E_PROVIDERS
  ? process.env.E2E_PROVIDERS.split(",")
  : ["openstreetmap-overpass", "fcc-uls-3650"];

// Fetch ONCE, then replay the same responses through every merge method. If each
// method refetched, a difference between methods could be a difference in what
// the providers happened to serve that second rather than a difference in
// deconfliction — which is the only thing this is trying to show.
const routed = await harness.invoke({
  methodId: "route",
  inputs: [htq({ body: JSON.stringify({ PROVIDERS, METHOD: "CENTROID", LIMIT: 400 }) })],
});
const job = JSON.parse(dec.decode(byPort(routed).get("job").payload));
const descriptors = framesFor(routed, "requests").map((f) => JSON.parse(dec.decode(f.payload)));
console.log("descriptors:", descriptors.length, "| consulted:", job.providers_consulted);

const responses = [];
for (const d of descriptors) {
  try {
    const res = await fetch(d.url, { headers: d.headers, signal: AbortSignal.timeout(45000) });
    const text = await res.text();
    console.log(`  fetch ${d.provider_id} @ ${new URL(d.url).host} -> ${res.status} ${text.length}B`);
    responses.push({ provider_id: d.provider_id, status: res.status, headers: {}, bodyB64: Buffer.from(text).toString("base64") });
  } catch (e) {
    console.log(`  fetch ${d.provider_id} @ ${new URL(d.url).host} -> FAILED ${String(e.message).slice(0, 60)}`);
  }
}

const parsed = await harness.invoke({
  methodId: "parse",
  inputs: [json("job", job), ...responses.map((r) => json("responses", r))],
});
const reports = JSON.parse(dec.decode(byPort(parsed).get("reports").payload));
const perProvider = {};
for (const r of reports) perProvider[r.provider_id] = (perProvider[r.provider_id] || 0) + 1;
console.log("REPORTS decoded:", reports.length, JSON.stringify(perProvider));
for (const id of PROVIDERS) {
  const s = reports.find((r) => r.provider_id === id);
  if (s) console.log(`  sample ${id}:`, JSON.stringify(s).slice(0, 170));
}

// The job carries `method` as the tbsMergeMethod ORDINAL, not its name. Passing
// the name here made atof() read 0 and every method silently ran as
// SINGLE_SOURCE — five identical rows that looked like "deconfliction does
// nothing" when the defect was entirely in this harness.
const METHODS = { SINGLE_SOURCE: 0, HIGHEST_SAMPLE_COUNT: 1, MOST_RECENT: 2, AUTHORITY_PRECEDENCE: 3, CENTROID: 4 };
for (const [METHOD, ordinal] of Object.entries(METHODS)) {
  const merged = await harness.invoke({
    methodId: "deconflict",
    inputs: [json("job", { ...job, method: ordinal }), json("reports", reports)],
  });
  const mp = byPort(merged);
  const stream = mp.get("records").payload;
  let off = 0, n = 0, ident = "";
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  while (off < stream.byteLength) { const len = view.getUint32(off, true); off += 4; if (!n) ident = dec.decode(stream.subarray(off + 4, off + 8)); off += len; n++; }
  const d = JSON.parse(dec.decode(mp.get("decision").payload));
  console.log(`${METHOD.padEnd(22)} -> sites=${String(n).padEnd(4)} collapsed=${String(d.collapsed).padEnd(4)} multiProvider=${String(d.multiProviderSites).padEnd(4)} ident=${ident} bytes=${stream.byteLength}`);
}
await harness.destroy();
