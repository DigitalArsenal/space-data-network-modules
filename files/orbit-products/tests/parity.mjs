// Tri-runtime parity of files/orbit-products' interchange methods: the browser (headless Chrome) and native
// WasmEdge lanes (the Docker leg is waived by the owner, 2026-10-22). Identical request bytes must give
// byte-identical outputs and the same exit class in every lane.
//   /Users/tj/software/terrain-work/lanes/headless-run env PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
//
// Every request is built the way the tests build it, with the SDS FlatBuffers: the $NCD that frames a file is also
// its request, and the refusals are cases too (the error code and message are part of the output, so a lane that
// refused for another reason fails the comparison).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatParityReport, normalizeParityFixture, runParityHarness } from "space-data-module-sdk/testing";

import { buildAem, syntheticAem } from "./lib/ck_synthetic.mjs";
import { AEM_TYPE, NCD_TYPE, descriptorOnly, frame, harness, input } from "./lib/ncd_frames.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIX = path.join(root, "fixtures", "interchange");
const wasmPath = path.join(root, "dist", "isomorphic", "module.wasm");
const bytes = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));
const text = (name) => fs.readFileSync(path.join(FIX, name), "utf8");
const enc = (s) => new TextEncoder().encode(s);

const cases = [];
const add = (id, request) => cases.push({ id, request });
const eof = (data, extra = {}) => ({ methodId: "normalize_sentinel_eof", inputs: [input("container", NCD_TYPE, frame(data, { formatName: "sentinel-eof", ...extra }))] });
const ckRead = (ck, clock, extra = {}) => ({ methodId: "normalize_naif_ck", inputs: [
  input("container", NCD_TYPE, frame(bytes(ck), { formatName: "naif-ck", ...extra })),
  input("sclk", NCD_TYPE, frame(bytes(clock), { formatName: "naif-sclk" }))] });
const ckWrite = (aem, clock, descriptor) => ({ methodId: "write_naif_ck", inputs: [
  input("attitude", AEM_TYPE, aem), input("sclk", NCD_TYPE, frame(bytes(clock), { formatName: "naif-sclk" })),
  ...(descriptor ? [input("descriptor", NCD_TYPE, descriptor)] : [])] });

// Sentinel EOF
for (const n of ["S1A_AUX_POEORB_V20240108_overlap", "S1A_AUX_POEORB_V20240109_overlap", "S1A_AUX_RESORB_V20240109_excerpt"]) add(`eof-read-${n}`, eof(bytes(`${n}.EOF`)));
add("eof-read-window", eof(bytes("S1A_AUX_POEORB_V20240108_overlap.EOF"), { startTime: "2024-01-09T23:30:00", stopTime: "2024-01-09T23:31:00" }));
add("eof-refused-unit", eof(enc(text("S1A_AUX_POEORB_V20240108_overlap.EOF").replace('<X unit="m">', '<X unit="km">'))));
add("eof-refused-count", eof(enc(text("S1A_AUX_POEORB_V20240108_overlap.EOF").replace('count="721"', 'count="720"'))));
add("eof-refused-unknown-element", eof(enc(text("S1A_AUX_POEORB_V20240108_overlap.EOF").replace("<Mission>", "<Program>x</Program><Mission>"))));
add("eof-refused-empty-selection", eof(bytes("S1A_AUX_POEORB_V20240108_overlap.EOF"), { startTime: "2030-01-01T00:00:00" }));

// NAIF CK
const KERNELS = [["msl_surf_rover_tlm_0179_0269_v1.bc", "MSL_76_SCLKSCET.00019.tsc"], ["msl_ra_straight_v1.bc", "MSL_76_SCLKSCET.00019.tsc"],
  ["msl_hga_zero_v1.bc", "MSL_76_SCLKSCET.00019.tsc"], ["insight_ida_enc_180505_181127_v1.bc", "NSY_SCLKSCET.00025.tsc"]];
for (const [ck, clock] of KERNELS) add(`ck-read-${ck}`, ckRead(ck, clock));
add("ck-read-one-instrument", ckRead("msl_ra_straight_v1.bc", "MSL_76_SCLKSCET.00019.tsc", { segments: [{ instrument: -76303 }] }));
add("ck-refused-type2", ckRead("insight_surf_nom_v2.bc", "NSY_SCLKSCET.00025.tsc"));
add("ck-refused-wrong-clock", ckRead("msl_hga_zero_v1.bc", "NSY_SCLKSCET.00025.tsc"));
const aem = buildAem(syntheticAem());
add("ck-write-synthetic", ckWrite(aem, "MSL_76_SCLKSCET.00019.tsc", descriptorOnly({ internalFileName: "SDN synthetic CK type 3", comments: ["parity"] })));
add("ck-refused-write-b2a", ckWrite(buildAem(syntheticAem().slice(0, 1), { dir: "B2A" }), "MSL_76_SCLKSCET.00019.tsc"));
add("ck-refused-write-time-system", ckWrite(buildAem(syntheticAem().slice(0, 1), { time: "UTC" }), "MSL_76_SCLKSCET.00019.tsc"));

const plan = await normalizeParityFixture({
  name: "files/orbit-products 0.2.0 interchange methods",
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
