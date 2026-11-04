#!/usr/bin/env node
// Records the ocm-lane fixtures (see PROVENANCE.md). Inputs: an XP $OCM written by propagator/sgp4-xp 0.2.1 fit, an AP
// $OCM written here by the propagator/sdn-ap 0.5.1 dist's fit, two foreign SGP4 $OMM copied from
// hostcap/flatsql-store's fixtures, and a $PNV notice. Output: merge-before.json, what this module's dist answered on
// them before the $OCM lane. JS only moves bytes: every element set comes out of a module.
//   node tests/fixtures/record.mjs [--inputs] [--before]
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { QRP, QRPT } from "spacedatastandards.org/lib/js/QRP/QRP.js";
import { qrpKind } from "spacedatastandards.org/lib/js/QRP/qrpKind.js";
import { PNV, PNVT } from "spacedatastandards.org/lib/js/PNV/PNV.js";
import { PNVEntryT } from "spacedatastandards.org/lib/js/PNV/PNVEntry.js";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const modules = fileURLToPath(new URL("../../../../", import.meta.url));
const T = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const records = (buf) => { const out = []; let at = 0; while (at < buf.length) { const n = buf.readUInt32LE(at); out.push(buf.subarray(at + 4, at + 4 + n)); at += 4 + n; } return out; };
const prefixed = (rs) => Buffer.concat(rs.flatMap((r) => { const p = Buffer.alloc(4); p.writeUInt32LE(r.length); return [p, Buffer.from(r)]; }));

export const WINDOW = Object.freeze({ FROM: Date.parse("2026-01-01T00:00:00Z"), AS_OF: Date.parse("2026-11-04T00:00:00Z") });
export const windowRequest = ({ from = WINDOW.FROM, asOf = WINDOW.AS_OF, limit = 0 } = {}) => {
  const b = new flatbuffers.Builder(128);
  QRP.finishQRPBuffer(b, Object.assign(new QRPT(), { KIND: qrpKind.Request, SCHEMA_NAME: "OMM", FROM_EPOCH_MS: BigInt(from), AS_OF_MS: BigInt(asOf), LIMIT: limit }).pack(b));
  return b.asUint8Array().slice();
};
export const fixture = (name) => fs.readFileSync(here(name));
/// The OMM-lane inputs of the recording: SGP4 set 1 cached; sets 1 and 2 pulled beside the notice.
export const ommInputs = () => {
  const [a, b] = records(fixture("sgp4.omm"));
  return [
    { portId: "window", typeRef: T("QRP"), payload: windowRequest() },
    { portId: "cached", typeRef: T("OMM"), payload: prefixed([a]) },
    { portId: "pulled", typeRef: T("OMM"), payload: prefixed([a, b]) },
    { portId: "notice", typeRef: T("PNV"), payload: fixture("notice.pnv") },
  ];
};

async function recordInputs() {
  // XP: the second record sgp4-xp 0.2.1 fit wrote (the NASA ISS block, a U.S. Government work)
  const xp = records(fs.readFileSync(`${modules}propagator/sgp4-xp/tests/fixtures/xp-fit-current.ocm`))[1];
  fs.writeFileSync(here("xp.ocm"), xp);
  // SGP4: the first two sets data-source/celestrak-supgp 2.0.0 writes for its synthetic SES-E feed (EPHEMERIS_TYPE 0)
  const supgp = `${modules}data-source/celestrak-supgp/`;
  const supgpRequire = createRequire(`${supgp}package.json`);
  const sdk = (p) => import(pathToFileURL(supgpRequire.resolve(`space-data-module-sdk/${p}`)).href);
  const { encodeHttpResponse, encodeTimerTick, decodeHttpRequest } = await sdk("runtime-contracts");
  const { createBrowserModuleHarness } = await sdk("testing");
  const host = await createBrowserModuleHarness({ wasmSource: new Uint8Array(fs.readFileSync(`${supgp}dist/isomorphic/module.wasm`)),
    manifest: JSON.parse(fs.readFileSync(`${supgp}dist/plugin-manifest.json`, "utf8")), surface: "direct", hostOptions: { config: { token: "SES-E", sourceName: "ses" } } });
  const tick = { portId: "tick", typeRef: { ...T("TimerTick"), fileIdentifier: "TICK" }, payload: encodeTimerTick({ triggerId: "supgp-pull", firedMs: Date.UTC(2026, 9, 14) }) };
  const asked = await host.invoke({ methodId: "request", inputs: [tick] });
  if (asked.statusCode !== 0) throw new Error(`supgp request: ${asked.errorMessage}`);
  const req = decodeHttpRequest(asked.outputs.find((f) => f.portId === "requests").payload);
  const body = fs.readFileSync(`${supgp}test/fixtures/SES-E.trimmed.json`);
  const parsed = await host.invoke({ methodId: "parse", inputs: [{ portId: "response", typeRef: { ...T("HttpResponse"), fileIdentifier: "HRSP" },
    payload: encodeHttpResponse({ url: req.url, status: 200, headers: { "content-type": "application/json" }, body, context: req.context, retrievedMs: Date.UTC(2026, 9, 14, 1) }) }] });
  host.destroy();
  if (parsed.statusCode !== 0) throw new Error(`supgp parse: ${parsed.errorMessage}`);
  const omm = parsed.outputs.filter((f) => f.typeRef?.fileIdentifier === "$OMM").flatMap((f) => {
    const p = Buffer.from(f.payload);
    return p.subarray(4, 8).toString() === "$OMM" ? [p] : records(p);
  });
  fs.writeFileSync(here("sgp4.omm"), prefixed(omm.slice(0, 2)));
  // AP: sdn-ap 0.5.1 fit on 48 h of the 550 km trajectory, NRLMSISE-00 on the daily rows with the open DCA; the epoch
  // is the arc's start, so FIT.WEATHER_HORIZON_DAYS 32 makes the 34 rows 2026-09-30 .. 2026-11-02
  const ap = `${modules}propagator/sdn-ap/`;
  const apRequire = createRequire(`${ap}package.json`);
  const { createStandaloneHarness: apHarness } = await import(pathToFileURL(apRequire.resolve("space-data-module-sdk/testing/isomorphic")).href);
  const { configuration } = await import(pathToFileURL(`${ap}test/lib/pcf.mjs`).href);
  const { AP_FORCES } = await import(pathToFileURL(`${ap}test/lib/ocm.mjs`).href);
  const { arcOem, spwRows } = await import(pathToFileURL(`${ap}test/lib/fixture-inputs.mjs`).href);
  const sds = (p) => import(pathToFileURL(apRequire.resolve(`spacedatastandards.org/lib/js/${p}`)).href);
  const { DCL, DCLT } = await sds("DCL/DCL.js");
  const { ATMT } = await sds("DCL/ATM.js");
  const { AtmosphericModelFamily } = await sds("DCL/AtmosphericModelFamily.js");
  const { dclCorrectionT } = await sds("DCL/dclCorrection.js");
  const { dclCorrectionForm } = await sds("DCL/dclCorrectionForm.js");
  const { dclStatus } = await sds("DCL/dclStatus.js");
  const { pcfDensityCorrection } = await sds("PCF/pcfDensityCorrection.js");
  const fb = await import(pathToFileURL(apRequire.resolve("flatbuffers")).href);
  // 6-hourly nodes 2026-09-30T00Z .. 2026-10-05T00Z, s = 0.01 (k mod 7 - 3)
  const t0 = Date.parse("2026-09-30T00:00:00Z");
  const nodes = Array.from({ length: 21 }, (_, k) => t0 + k * 6 * 3600e3);
  const dcl = Object.assign(new DCLT(), { STATUS: dclStatus.Solved, ATMOSPHERE: Object.assign(new ATMT(), { MODEL: AtmosphericModelFamily.NRLMSIS00E, YEAR: 2000 }),
    CORRECTION: Object.assign(new dclCorrectionT(), { FORM: dclCorrectionForm.LogDensityNodes, NODE_TIMES_MS: nodes.map(BigInt), NODE_LOG_DENSITY_SCALE_DIMENSIONLESS: nodes.map((_, k) => 0.01 * ((k % 7) - 3)) }) });
  const db = new fb.Builder(1024);
  DCL.finishDCLBuffer(db, dcl.pack(db));
  const h = await apHarness("browser", `${ap}dist/isomorphic/module.wasm`, { surface: "direct" });
  const r = await h.invoke({ methodId: "fit", inputs: [
    { portId: "ephemeris", typeRef: T("OEM"), payload: arcOem(48) },
    configuration({ theory: "AP", forces: { ...AP_FORCES, DENSITY_CORRECTION: pcfDensityCorrection.DCA_COMMON_MODE }, fit: { WEATHER_HORIZON_DAYS: 32 } }),
    { portId: "space_weather", typeRef: T("SPW"), payload: spwRows().bytes },
    { portId: "density_correction", typeRef: T("DCL"), payload: db.asUint8Array().slice() }] });
  if (r.statusCode !== 0) throw new Error(`sdn-ap fit: ${r.errorCode} ${r.errorMessage}`);
  fs.writeFileSync(here("ap.ocm"), new Uint8Array(r.outputs[0].payload));
  await h.destroy?.();
  // the notice: one entry, SIGNATURE_VERIFIED (the module reads only that)
  const e = Object.assign(new PNVEntryT(), { PNM_CID: "bafy-ocm-lane-fixture", PUBLISHER_PEER_ID: "12D3KooWPublisherA", STANDARD: "omm", SCHEMA_NAME: "OMM.fbs",
    CID: "ocm-lane-fixture", PUBLISHED_AT_MS: BigInt(WINDOW.AS_OF), SIGNATURE_TYPE: "ed25519", SIGNATURE_VERIFIED: true });
  const nb = new flatbuffers.Builder(256);
  PNV.finishPNVBuffer(nb, Object.assign(new PNVT(), { VERIFIER_PEER_ID: "12D3KooWReceiver", GENERATED_AT_MS: 0n, ENTRIES: [e] }).pack(nb));
  fs.writeFileSync(here("notice.pnv"), nb.asUint8Array().slice());
}

async function recordBefore() {
  const wasm = fileURLToPath(new URL("../../dist/isomorphic/module.wasm", import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../dist/plugin-manifest.json", import.meta.url)), "utf8"));
  const h = await createStandaloneHarness("browser", wasm, { surface: "command" });
  const r = await h.invoke({ methodId: "merge", inputs: ommInputs() });
  if (r.statusCode !== 0) throw new Error(`merge: ${r.errorCode} ${r.errorMessage}`);
  const ocmOnCached = await h.invoke({ methodId: "merge", inputs: [ommInputs()[0], { portId: "cached", typeRef: T("OMM"), payload: fixture("ap.ocm") }] });
  await h.destroy?.();
  const before = {
    module: `${manifest.pluginId} ${manifest.version}`, wasmSha256: sha(fs.readFileSync(wasm)),
    inputs: Object.fromEntries(["xp.ocm", "ap.ocm", "sgp4.omm", "notice.pnv"].map((n) => [n, sha(fixture(n))])),
    outputs: r.outputs.map((o) => ({ portId: o.portId, bytes: o.payload.length, sha256: sha(o.payload) })),
    summary: QRP.getRootAsQRP(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "summary").payload)).MESSAGE(),
    ocmOnCached: { statusCode: ocmOnCached.statusCode, errorCode: ocmOnCached.errorCode },
  };
  fs.writeFileSync(here("merge-before.json"), `${JSON.stringify(before, null, 2)}\n`);
  console.log(JSON.stringify(before, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const all = process.argv.length === 2;
  if (all || process.argv.includes("--inputs")) await recordInputs();
  if (all || process.argv.includes("--before")) await recordBefore();
  process.exit(0);
}
