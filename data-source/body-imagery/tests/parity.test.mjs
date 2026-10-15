// Tri-runtime parity (browser, native WasmEdge, container WasmEdge) for the
// body imagery module: the range plan, a data stage decoding a synthetic
// Titan mosaic (tests/synthetic.mjs) into the output grid, and the build of
// its tile pack and texture, byte for byte in every runtime. The stage inputs
// are made here with the browser harness, then replayed in each lane. Opt in
// with SDN_RUN_IMAGERY_PARITY=1 (Chromium, SDM_WASMEDGE_BINARY or wasmedge on
// PATH, the pinned image).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { normalizeParityFixture, runParityHarness, formatParityReport } from "space-data-module-sdk/testing";
import { TITAN, geotiff } from "./synthetic.mjs";

const wasmPath = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url)));
const frame = (portId, value) => {
  const payload = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  return { portId, payload, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.length } };
};
const wire = (f) => ({ portId: f.portId, typeRef: f.typeRef, payloadBase64: Buffer.from(f.payload).toString("base64") });
const tiff = geotiff(TITAN, { tiled: false });
function respond(request) {
  const r = JSON.parse(Buffer.from(request.payload));
  const [a, b] = r.headers.Range.replace("bytes=", "").split("-").map(Number);
  const header = Buffer.alloc(8);
  header.write("$HRB");
  header.writeInt32LE(206, 4);
  return frame("response", Buffer.concat([header, tiff.subarray(a, Math.min(b + 1, tiff.length))]));
}

test("plan_imagery, a data stage and build_imagery agree in Chromium, native and container WasmEdge", { skip: process.env.SDN_RUN_IMAGERY_PARITY !== "1" }, async () => {
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: "direct" });
  const config = frame("config", { access: "anonymous", bodies: [TITAN.naif] });
  const cases = [{ id: "plan", request: { methodId: "plan_imagery", inputs: [wire(config)] }, expect: "ok" }];
  let r = await h.invoke({ methodId: "plan_imagery", inputs: [config] });
  for (let stage = 1; stage <= 3; stage++) {
    const state = frame("state", r.outputs.find((f) => f.portId === "state").payload);
    const responses = r.outputs.filter((f) => f.portId === "request").map(respond);
    const method = stage === 3 ? "build_imagery" : "advance_imagery";
    cases.push({ id: `${method}-${stage}`, request: { methodId: method, inputs: [wire(state), ...responses.map(wire)] }, expect: "ok" });
    r = await h.invoke({ methodId: method, inputs: [state, ...responses] });
    assert.equal(r.statusCode, 0, r.errorMessage);
  }
  await h.destroy();
  // A refusal is an error status in the response (the same bytes in every lane), not a process exit.
  cases.push({ id: "refuse-keyed-source", request: { methodId: "plan_imagery", inputs: [wire(frame("config", { access: "keyed" }))] }, expect: "ok" } );
  const plan = await normalizeParityFixture({ name: "body-imagery", threadCounts: [1], cases });
  const report = await runParityHarness({ wasmPath, plan, autoBuildDockerImage: false, timeoutMs: 600000, log: (m) => console.log(m) });
  console.log(formatParityReport(report));
  assert.equal(report.ok, true, formatParityReport(report));
  assert.equal(report.lanes.length, 3);
});
