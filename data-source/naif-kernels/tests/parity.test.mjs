// Tri-runtime parity (browser, native WasmEdge, container WasmEdge) for the
// NAIF kernel module: the range plan, the first DAF stage over real DE440s and
// lunar PA records (tests/fixtures), and the $PNM announcement, in every
// runtime. The stage inputs are made here with the browser harness, then
// replayed byte for byte in each lane. Opt in with SDN_RUN_NAIF_PARITY=1
// (Chromium, SDM_WASMEDGE_BINARY or wasmedge on PATH, the pinned image).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { normalizeParityFixture, runParityHarness, formatParityReport } from "space-data-module-sdk/testing";

const wasmPath = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url)));
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const de440s = fixture("de440s-2020-sun-emb.bsp"), moon = fixture("moon-pa-2020.bpc");
function emptyDaf(pck) {
  const b = Buffer.alloc(3 * 1024);
  b.write(pck ? "DAF/PCK " : "DAF/SPK ", 0, "latin1");
  b.writeInt32LE(2, 8); b.writeInt32LE(pck ? 5 : 6, 12);
  b.writeInt32LE(2, 76); b.writeInt32LE(2, 80); b.writeInt32LE(3 * 128 + 1, 84);
  b.write("LTL-IEEE", 88, "latin1");
  return b;
}
function respond(request) {
  const base = request.url.split("?")[0];
  const bytes = base.endsWith("/de440s.bsp") ? de440s : base.endsWith("/moon_pa_de440_200625.bpc") ? moon : base.endsWith(".bsp") ? emptyDaf(false) : Buffer.from("KPL/PCK\n\\begindata\nSTUB = ( 1 )\n");
  const header = Buffer.alloc(8);
  header.write("$HRB");
  const range = request.headers?.Range;
  if (!range) { header.writeInt32LE(200, 4); return Buffer.concat([header, bytes]); }
  const [a, b] = range.slice(6).split("-").map(Number);
  header.writeInt32LE(206, 4);
  return Buffer.concat([header, bytes.subarray(a, Math.min(b + 1, bytes.length))]);
}
const frame = (portId, value) => {
  const payload = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  return { portId, payload, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.length } };
};
const wire = (f) => ({ portId: f.portId, typeRef: f.typeRef, payloadBase64: Buffer.from(f.payload).toString("base64") });

test("plan_kernels, the first DAF stage and announce_kernels agree in Chromium, native and container WasmEdge", { skip: process.env.SDN_RUN_NAIF_PARITY !== "1" }, async () => {
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: "direct" });
  const config = frame("config", { access: "anonymous" });
  const planned = await h.invoke({ methodId: "plan_kernels", inputs: [config] });
  assert.equal(planned.statusCode, 0, planned.errorMessage);
  const state = planned.outputs.find((f) => f.portId === "state");
  const responses = planned.outputs.filter((f) => f.portId === "request").map((f) => frame("response", respond(JSON.parse(Buffer.from(f.payload)))));
  await h.destroy();
  const job = { files: [{ file: "core-2020.bsp", bytes: 4096, sha256: "a".repeat(64) }], inputs: [] };
  const plan = await normalizeParityFixture({
    name: "naif-kernels",
    threadCounts: [1],
    cases: [
      { id: "plan", request: { methodId: "plan_kernels", inputs: [wire(config)] }, expect: "ok" },
      { id: "first-daf-stage", request: { methodId: "advance", inputs: [wire(frame("state", state.payload)), ...responses.map(wire)] }, expect: "ok" },
      { id: "announce", request: { methodId: "announce_kernels", inputs: [wire(frame("job", job)), wire(frame("receipt", { retrieved_at_ms: 1791800000000, producer_peer_id: "16Uiu2HAm1LbvwjEHW2GDP2ZQZvwHLZrz2jbYoRLQmJEQ3wZ5Fm45" })), wire(frame("added", { name: "core-2020.bsp", cid: "bafkreitest", bytes: 4096 }))] }, expect: "ok" },
      // A refusal is an error status in the response (the same bytes in every lane), not a process exit.
      { id: "refuse-missing-response", request: { methodId: "advance", inputs: [wire(frame("state", state.payload)), ...responses.slice(1).map(wire)] }, expect: "ok" } ,
    ],
  });
  const report = await runParityHarness({ wasmPath, plan, autoBuildDockerImage: false, timeoutMs: 600000, log: (m) => console.log(m) });
  console.log(formatParityReport(report));
  assert.equal(report.ok, true, formatParityReport(report));
  assert.equal(report.lanes.length, 3);
});
