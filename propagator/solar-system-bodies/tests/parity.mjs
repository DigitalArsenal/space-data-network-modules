// Tri-runtime parity (browser, WasmEdge, Docker WasmEdge) of `evaluate`:
// identical request bytes must give byte-identical responses, and identical
// error classes, in every lane.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
// Kernels: the committed DE440 2026 excerpt (files/orbit-products, made by
// CSPICE spksub_c) and the NAIF text PCKs when SSB_KERNELS_DIR has them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatParityReport, normalizeParityFixture, runParityHarness } from "space-data-module-sdk/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const excerpt = path.resolve(here, "../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp");
const dir = process.env.SSB_KERNELS_DIR;
const text = ["pck00011.tpc", "gm_de440.tpc"].map((n) => dir && path.join(dir, n)).filter((p) => p && fs.existsSync(p));
const kernel = (file) => ({ portId: "kernel", payloadHex: fs.readFileSync(file).toString("hex") });
const request = (body) => ({ portId: "request", payloadHex: Buffer.from(JSON.stringify(body)).toString("hex") });
const kernels = [...text.map(kernel), kernel(excerpt)];
const et = (2461100.5 - 2451545.0) * 86400; // 2026-03-01 TDB, inside the excerpt

const cases = [
  { id: "catalog", body: { operation: "catalog" } },
  { id: "states-ssb", body: { operation: "states", params: { et, ids: [10, 199, 299, 399, 301], center: 0 } } },
  { id: "states-geocentric", body: { operation: "states", params: { jdTai: [2461100, 43200], ids: [301, 10], center: 399 } } },
  { id: "orientations", body: { operation: "orientations", params: { et, ids: [10, 199, 299, 399, 499] } } },
  { id: "apparent", body: { operation: "apparent", params: { et, ids: [10, 199, 299, 301], observer_m: [-2.6e10, 1.33e11, 5.77e10] } } },
  { id: "hill-radius", body: { operation: "hill_radius", params: { et, id: 399 } } },
  { id: "observer", body: { operation: "observer_state", params: { et, central: 399, camera_position_m: [4e8, 0, 0], camera_velocity_m_s: [0, 0, 0] } } },
  { id: "out-of-range", body: { operation: "states", params: { et: 0, ids: [399], center: 0 } } },
  { id: "refused-operation", body: { operation: "no_such_operation", params: { et } } },
];
const plan = await normalizeParityFixture({
  name: "solar-system-bodies 0.1.0 evaluate",
  cases: cases.map((c) => ({ id: c.id, request: { methodId: "evaluate", inputs: [...kernels, request(c.body)] } })),
});
const report = await runParityHarness({ wasmPath: path.join(here, "..", "dist", "isomorphic", "module.wasm"), plan, timeoutMs: 300000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(path.join(here, "..", "conformance"), { recursive: true });
fs.writeFileSync(path.join(here, "..", "conformance", "parity.json"), `${JSON.stringify({ ...report, wasmPath: "dist/isomorphic/module.wasm" }, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
