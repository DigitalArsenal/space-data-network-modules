#!/usr/bin/env node
// E2E (task modules-element-sync-ocm-lane-20261103): the $OCM element-set lane beside the SGP4 $OMM lane, on the
// fixtures of tests/fixtures (PROVENANCE.md), every merge on the browser host and native WasmEdge, byte-identical.
// - The SGP4 lane is unchanged: on the recorded inputs, the omm, store and notice frames and the OMM expire and summary
//   frames equal the 0.1.0 dist's (merge-before.json) byte for byte, and the omm stream is the input $OMM bytes.
// - A cached window plus a pulled dataset: one $OMM lane (the two SGP4 sets) and one $OCM lane (XP and AP sets) deduped
//   on (NORAD_CAT_ID, INTERNATIONAL_DESIGNATOR, MEAN_ELEMENT_THEORY, ORIGINATOR, EPOCH); the duplicate XP set is dropped;
//   every $OCM out is its input's bytes (the AP record's 34 SPACE_WEATHER rows and 21 nodes included); LIMIT keeps the
//   newest epochs per lane.
// - Refused by name, no output: MEAN_ELEMENT_THEORY UNSPECIFIED, no MEAN_ELEMENTS, USER_DEFINED_PARAMETERS on an $OCM
//   and on a foreign $OMM, an $OCM frame on the $OMM port and the reverse.
// - The AP record packs into 4 MiB chunks: the count is printed and every frame holds it (the last the rest).
// assertNoUserDefined on every record out. JS only moves bytes: the element sets come out of the producing modules.
//   node tests/ocm-lane.e2e.mjs
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OCM, OCMT } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { UserDefinedParametersT } from "spacedatastandards.org/lib/js/OCM/UserDefinedParameters.js";
import { QRP } from "spacedatastandards.org/lib/js/QRP/QRP.js";
import { assertNoUserDefined } from "../../../common/tests/no-user-defined.mjs";
import { fixture, ommInputs, windowRequest } from "./fixtures/record.mjs";

const wasmPath = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const modules = fileURLToPath(new URL("../../../", import.meta.url));
const before = JSON.parse(fixture("merge-before.json"));
const T = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const records = (buf) => { const out = []; let at = 0; while (at < buf.length) { const n = buf.readUInt32LE(at); out.push(Buffer.from(buf.subarray(at + 4, at + 4 + n))); at += 4 + n; } return out; };
const prefixed = (rs) => Buffer.concat(rs.flatMap((r) => { const p = Buffer.alloc(4); p.writeUInt32LE(r.length); return [p, Buffer.from(r)]; }));
const ocmOf = (b) => OCM.getRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(b)));
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); return ok; };

const xp = fixture("xp.ocm"), ap = fixture("ap.ocm");
const sgp4 = records(fixture("sgp4.omm"));
const notice = fixture("notice.pnv");

/// `bytes` with MEAN_ELEMENTS.EPOCH rewritten in place to `epoch` (same length): a second set of the same series.
function reEpoch(bytes, epoch) {
  const out = Buffer.from(bytes);
  const me = ocmOf(out).MEAN_ELEMENTS();
  const was = me.EPOCH();
  if (epoch.length !== was.length) throw new Error(`reEpoch: ${epoch} is not as long as ${was}`);
  const at = me.bb.__indirect(me.bb_pos + me.bb.__offset(me.bb_pos, 6)) + 4;
  if (out.subarray(at, at + was.length).toString() !== was) throw new Error("reEpoch: EPOCH not found");
  out.write(epoch, at, "latin1");
  return out;
}
/// The record `bytes` edited through the bindings (a refusal's input).
function repack(bytes, edit) {
  const t = ocmOf(bytes).unpack();
  edit(t);
  const b = new flatbuffers.Builder(8192);
  OCM.finishOCMBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
}

// --- the module on both lanes ---------------------------------------------------------------------------------------
const testing = path.dirname(fileURLToPath(import.meta.resolve("space-data-module-sdk/testing")));
const { resolveWasmEdgeWasiThreadsRunner } = await import(pathToFileURL(path.join(testing, "buildWasmEdgeRunner.js")).href);
const runner = process.env.SDM_WASMEDGE_RUNNER_BINARY || (await resolveWasmEdgeWasiThreadsRunner({}));
const hosts = {
  browser: await createStandaloneHarness("browser", wasmPath, { surface: "command" }),
  wasmedge: await createStandaloneHarness("wasmedge", wasmPath, { surface: "command", wasmEdgeRunnerBinary: runner }),
};
let merges = 0;
async function merge(label, inputs) {
  const got = {};
  for (const [lane, h] of Object.entries(hosts)) got[lane] = await h.invoke({ methodId: "merge", inputs });
  const digest = (r) => JSON.stringify([r.statusCode ?? 0, r.errorCode ?? null, (r.outputs ?? []).map((o) => `${o.portId}:${sha(o.payload)}`)]);
  check(digest(got.browser) === digest(got.wasmedge), `${label}: browser and WasmEdge differ`);
  merges++;
  const r = got.browser;
  const port = (name) => (r.outputs ?? []).filter((o) => o.portId === name).map((o) => Buffer.from(o.payload));
  return { r, port, stream: (name) => port(name).flatMap(records) };
}
const frame = (portId, code, payload) => ({ portId, typeRef: T(code), payload });
const summaries = (m) => m.port("summary").map((b) => QRP.getRootAsQRP(new flatbuffers.ByteBuffer(new Uint8Array(b))));
const noUserDefined = (label, recs) => { for (const rec of recs) try { assertNoUserDefined(rec); } catch (e) { check(false, `${label}: ${e.message}`); } };
const recorded = (portId, k = 0) => before.outputs.filter((o) => o.portId === portId)[k];
const sameAsBefore = (label, m) => {
  for (const portId of ["omm", "store", "notice"]) {
    const now = m.port(portId);
    check(now.length === 1 && sha(now[0]) === recorded(portId).sha256, `${label}: ${portId} differs from the 0.1.0 dist`);
  }
  for (const portId of ["expire", "summary"]) {
    const now = m.port(portId);
    check(now.length === 2 && sha(now[0]) === recorded(portId).sha256, `${label}: the OMM ${portId} frame differs from the 0.1.0 dist`);
  }
};

// 1. the SGP4 lane alone, as recorded
const m0 = await merge("recorded inputs", ommInputs());
check(m0.r.statusCode === 0, `recorded inputs: ${m0.r.errorCode} ${m0.r.errorMessage}`);
sameAsBefore("recorded inputs", m0);
check(Buffer.compare(Buffer.concat(m0.port("omm")), fixture("sgp4.omm")) === 0, "the omm stream is not the input $OMM bytes");
check(m0.port("ocm").length === 0 && m0.port("store_ocm").length === 0, "an $OCM frame without $OCM input");

// 2. a cached window plus a pulled dataset, both lanes
const ap2 = reEpoch(ap, "2026-10-02T00:00:00.000000");
const both = [...ommInputs(),
  frame("cached_ocm", "OCM", prefixed([xp])),
  frame("pulled_ocm", "OCM", prefixed([xp, ap2, ap]))];
const m1 = await merge("both lanes", both);
check(m1.r.statusCode === 0, `both lanes: ${m1.r.errorCode} ${m1.r.errorMessage}`);
sameAsBefore("both lanes", m1);
const ocmOut = m1.stream("ocm"), ocmStored = m1.stream("store_ocm");
check(ocmOut.length === 3, `ocm lane: ${ocmOut.length} sets, expected 3 (XP once, AP twice)`);
check(ocmOut.length === 3 && [xp, ap, ap2].every((want, k) => Buffer.compare(ocmOut[k], want) === 0), "ocm lane: not the input bytes in key order (XP 25544, AP 90400 10-01, 10-02)");
check(ocmStored.length === 2 && Buffer.compare(ocmStored[0], ap) === 0 && Buffer.compare(ocmStored[1], ap2) === 0, `store_ocm: ${ocmStored.length} sets, expected the two AP sets`);
const apOut = ocmOf(ocmOut[1] ?? ap);
const rows = apOut.PERTURBATIONS()?.spaceWeatherLength() ?? 0, nodes = apOut.PERTURBATIONS()?.densityCorrectionNodeTimesMsLength() ?? 0;
check(rows === 34 && nodes === 21, `AP record out: ${rows} SPACE_WEATHER rows and ${nodes} nodes, expected 34 and 21`);
const [sOmm, sOcm] = summaries(m1);
check(sOmm?.SCHEMA_NAME() === "OMM" && sOcm?.SCHEMA_NAME() === "OCM", "summary: not one page per lane, OMM then OCM");
check(sOcm?.MESSAGE() === "kept=3 new=2 expired=0 unsigned-refused=0 malformed=0" && Number(sOcm?.SCANNED()) === 4, `OCM summary: ${sOcm?.MESSAGE()} scanned ${sOcm?.SCANNED()}`);
const expires = m1.port("expire").map((b) => QRP.getRootAsQRP(new flatbuffers.ByteBuffer(new Uint8Array(b))));
check(expires[1]?.SCHEMA_NAME() === "OCM" && expires[1]?.TO_EPOCH_MS() === expires[0]?.TO_EPOCH_MS(), "expire: no OCM cutoff at the window start");
noUserDefined("both lanes", [...m1.stream("omm"), ...m1.stream("store"), ...ocmOut, ...ocmStored]);

// the cap keeps the newest epochs per lane
const capped = [frame("window", "QRP", windowRequest({ limit: 2 })), ...both.slice(1)];
const m2 = await merge("LIMIT 2", capped);
const cappedOut = m2.stream("ocm");
check(cappedOut.length === 2 && Buffer.compare(cappedOut[0], ap) === 0 && Buffer.compare(cappedOut[1], ap2) === 0, `LIMIT 2: ocm keeps ${cappedOut.length}, expected the two newest (AP 10-01, 10-02)`);
check(m2.stream("omm").length === 2 && summaries(m2)[1]?.TRUNCATED() === true && summaries(m2)[0]?.TRUNCATED() === false, "LIMIT 2: per lane");

// 3. refusals by name, no output
const refusal = async (label, inputs, code) => {
  const m = await merge(label, inputs);
  check(m.r.statusCode !== 0 && m.r.errorCode === code && (m.r.outputs ?? []).length === 0, `${label}: expected ${code}, got ${m.r.statusCode === 0 ? "success" : m.r.errorCode}`);
  return m.r.errorCode;
};
const win = frame("window", "QRP", windowRequest());
const xpOmm = records(fs.readFileSync(`${modules}propagator/sgp4-xp/tests/fixtures/xp-fit-current.omm`))[0];
const xpOmmCount = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(new Uint8Array(xpOmm))).userDefinedParametersLength();
const codes = [
  await refusal("theory UNSPECIFIED", [win, frame("cached_ocm", "OCM", repack(xp, (t) => { t.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY = 6; }))], "mean-element-theory-unspecified"),
  await refusal("no MEAN_ELEMENTS", [win, frame("cached_ocm", "OCM", repack(xp, (t) => { t.MEAN_ELEMENTS = null; }))], "mean-elements-missing"),
  await refusal("USER_DEFINED on an $OCM", [win, frame("pulled_ocm", "OCM", repack(ap, (t) => { t.USER_DEFINED_PARAMETERS = [new UserDefinedParametersT("A", "1"), new UserDefinedParametersT("B", "2")]; })), frame("notice", "PNV", notice)], "user-defined-parameters:2"),
  await refusal("USER_DEFINED on a foreign $OMM", [win, frame("pulled", "OMM", prefixed([xpOmm])), frame("notice", "PNV", notice)], `user-defined-parameters:${xpOmmCount}`),
  await refusal("an $OCM on the $OMM port", [win, frame("cached", "OMM", ap)], "invalid-omm-frame"),
  await refusal("an $OMM on the $OCM port", [win, frame("cached_ocm", "OCM", sgp4[0])], "invalid-ocm-frame"),
];
check(xpOmmCount > 0, "the foreign SGP4XP $OMM carries no USER_DEFINED list");

// 4. the AP record in 4 MiB chunks
const CHUNK = 4 << 20, perChunk = Math.floor(CHUNK / (4 + ap.length)), total = 2 * perChunk + 5;
const iso = (k) => new Date(Date.parse("2026-10-01T00:00:00Z") + k * 60000).toISOString().replace("Z", "000");
const many = Array.from({ length: total }, (_, k) => reEpoch(ap, iso(k)));
const m3 = await merge("chunks", [win, frame("pulled_ocm", "OCM", prefixed(many)), frame("notice", "PNV", notice)]);
const frames = m3.port("ocm");
const counts = frames.map((f) => records(f).length);
check(m3.r.statusCode === 0 && frames.length === 3 && counts[0] === perChunk && counts[1] === perChunk && counts[2] === 5 && frames.every((f) => f.length <= CHUNK),
  `chunks: ${frames.length} frames of ${counts.join(", ")} records, expected ${perChunk}, ${perChunk}, 5`);
check(Buffer.compare(Buffer.concat(frames), prefixed(many)) === 0, "chunks: the stream is not the input bytes");

for (const h of Object.values(hosts)) await h.destroy?.();
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`OCM LANE E2E: PASS: OMM lane = 0.1.0 dist bytes (omm ${recorded("omm").sha256.slice(0, 12)}); OCM lane kept 3 of 4 (duplicate XP dropped), ` +
  `stored 2, LIMIT 2 kept the 2 newest; refused ${codes.join(", ")}; AP record ${ap.length} B with ${rows} rows and ${nodes} nodes: ` +
  `${perChunk} records per 4 MiB chunk (${total} records -> ${frames.length} frames); ${merges} merges browser = WasmEdge`);
process.exit(0);
