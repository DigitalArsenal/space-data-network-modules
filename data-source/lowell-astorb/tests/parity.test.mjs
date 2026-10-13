// Tri-runtime parity (browser, native WasmEdge, container WasmEdge) for the
// portable astorb module: the same range plan, the same $SBD records from the
// same astorb.dat bytes, and the same refusals, in every runtime. Opt in with
// SDN_RUN_ASTORB_PARITY=1 (needs Chromium, a wasmedge binary in
// SDM_WASMEDGE_BINARY or PATH, and the pinned parity image in Docker).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { normalizeParityFixture, runParityHarness, formatParityReport } from "space-data-module-sdk/testing";

const head = fs.readFileSync(new URL("./fixtures/astorb-2026-10-12-head.dat", import.meta.url), "latin1").split("\n").filter(Boolean);
const RANGE = 48 * 1024 * 1024;
function catalog(rows) {
  const lines = [...head];
  for (let n = 1; n <= rows; n++) lines.push(String(500000 + n).padStart(6, " ") + head[19].slice(6));
  return zlib.gzipSync(Buffer.from(lines.join("\n") + "\n", "latin1"));
}
function ranges(gz) {
  return Array.from({ length: 3 }, (_, i) => {
    const header = Buffer.alloc(8);
    header.write("$HRB");
    const a = i * RANGE;
    if (a >= gz.length) { header.writeInt32LE(416, 4); return header; }
    header.writeInt32LE(206, 4);
    return Buffer.concat([header, gz.subarray(a, Math.min(a + RANGE, gz.length))]);
  });
}
const wire = (portId, value) => {
  const payload = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  return { portId, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.length }, payloadBase64: payload.toString("base64") };
};
const job = { source_url: "https://ftp.lowell.edu/pub/elgb/astorb.dat.gz", provider_id: "lowell-astorb", source_name: "astorb-numbered" };
const receipt = { retrieved_at_ms: 1791800000000, producer_peer_id: "16Uiu2HAm1apfD3rAJJjgx4AC5Ms3PejRBwoqEsKpRx36uYwXuW9h" };
const parse = (gz) => ({ methodId: "parse_astorb", inputs: [wire("job", job), wire("receipt", receipt), ...ranges(gz).map((r, i) => wire(`response${i}`, r))] });

test("plan_astorb and parse_astorb agree in Chromium, native WasmEdge and container WasmEdge", { skip: process.env.SDN_RUN_ASTORB_PARITY !== "1" }, async () => {
  const plan = await normalizeParityFixture({
    name: "lowell-astorb",
    threadCounts: [1],
    cases: [
      { id: "plan", request: { methodId: "plan_astorb", inputs: [wire("config", { access: "anonymous" })] }, expect: "ok" },
      { id: "parse-100k", request: parse(catalog(100000)), expect: "ok" },
      // A refusal is an error status in the response (the same bytes in every lane), not a process exit.
      { id: "refuse-short-file", request: parse(catalog(1000)), expect: "ok" } ,
    ],
  });
  const report = await runParityHarness({ wasmPath: fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)), plan, autoBuildDockerImage: false, timeoutMs: 900000, log: (m) => console.log(m) });
  console.log(formatParityReport(report));
  assert.equal(report.ok, true, formatParityReport(report));
  assert.equal(report.lanes.length, 3);
});
