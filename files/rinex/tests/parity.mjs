// Tri-runtime parity of files/rinex: the browser (headless Chrome) and native WasmEdge lanes (the Docker leg is
// waived by the owner, 2026-10-22). Identical request bytes must give byte-identical outputs and the same exit class.
//   /Users/tj/software/terrain-work/lanes/headless-run env PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatParityReport, normalizeParityFixture, runParityHarness } from "space-data-module-sdk/testing";

import { NCD_TYPE, frame, input } from "../../orbit-products/tests/lib/ncd_frames.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wasmPath = path.join(root, "dist", "isomorphic", "module.wasm");
const OBS = "WTZR00DEU_R_20250190000_01D_30S_MO.first20.rnx";
const bytes = new Uint8Array(fs.readFileSync(path.join(root, "fixtures", OBS)));
const text = fs.readFileSync(path.join(root, "fixtures", OBS), "latin1");
const enc = (s) => new TextEncoder().encode(s);

const cases = [];
const add = (id, request) => cases.push({ id, request });
const obs = (data, extra = {}) => ({ methodId: "read_observations", inputs: [input("container", NCD_TYPE, frame(data, { formatName: "rinex-obs", ...extra }))] });

add("obs-read-all", obs(bytes));
add("obs-read-window", obs(bytes, { startTime: "2025-01-19T00:02:00", stopTime: "2025-01-19T00:04:00" }));
add("obs-read-gps-only", obs(bytes, { segments: [{ name: "G" }] }));
add("obs-read-galileo-beidou", obs(bytes, { segments: [{ name: "E" }, { name: "C" }] }));
add("obs-refused-version-2", obs(enc(text.replace(/^ {5}3\.05/, "     2.11"))));
add("obs-refused-epoch-flag", obs(enc(text.replace("> 2025 01 19 00 01 00.0000000  0 50", "> 2025 01 19 00 01 00.0000000  1 50"))));
add("obs-refused-iono-type", obs(enc(text.replace("I    4 C5A D5A L5A S5A", "I    4 C5A D5A I5A S5A"))));
add("nav-refused-not-in-sds", obs(new Uint8Array(fs.readFileSync(path.join(root, "fixtures", "BRDC00WRD_R_20250190000_01D_GN.head.rnx")))));
add("nav-refused-version-4", obs(new Uint8Array(fs.readFileSync(path.join(root, "fixtures", "BRD400DLR_S_20250190000_01D_MN.head.rnx")))));
add("obs-refused-count", obs(enc(text.replace("> 2025 01 19 00 01 00.0000000  0 50", "> 2025 01 19 00 01 00.0000000  0 49"))));
add("obs-refused-empty-selection", obs(bytes, { startTime: "2030-01-01T00:00:00" }));
add("obs-refused-bad-selection", obs(bytes, { segments: [{ name: "GPS" }] }));

const plan = await normalizeParityFixture({
  name: "files/rinex 0.1.0 methods",
  cases: cases.map((c) => ({ ...c, expect: "ok", request: { ...c.request,
    inputs: c.request.inputs.map(({ payload, ...p }) => ({ ...p, payloadHex: Buffer.from(payload).toString("hex") })) } })),
});
const lanes = (process.env.PARITY_LANES ?? "browser,wasmedge").split(",");
const report = await runParityHarness({ wasmPath, plan, lanes, timeoutMs: 600000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(path.join(root, "conformance"), { recursive: true });
fs.writeFileSync(path.join(root, "conformance", "parity.json"), `${JSON.stringify({ ...report, wasmPath: "dist/isomorphic/module.wasm", dockerLeg: "waived by the owner, 2026-10-22" }, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
assert.equal(createHash("sha256").update(fs.readFileSync(wasmPath)).digest("hex"), report.artifactSha256);
