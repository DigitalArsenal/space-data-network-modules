#!/usr/bin/env node
// Scores of SDN-AP on SDN's derived osculating sets (test/opm-derive.mjs), each against the two-body motion of the same
// set (the floor). Every state comes from a module: SDN-AP through `propagate` with the set as an 'opm' frame
// (SPEC 13), EME2000 on explicit epochs; the floor through `sdnap_kepler_at` about the set's GM. JS reads the truth's
// numbers, differences them and takes statistics. Two measures (local data; only these aggregates are committed):
//   --prediction DIR   agreement with JSC Vimpel's own 7-day prediction: the table's ephemeris files (DIR holds the
//                      unpacked RAR: <id>_<YYYYMMDD>_<HHMMSS>, rows "index, x, y, z" km J2000 every 600 s from the
//                      file's epoch), every 12th row (2 h) after the derived set's epoch, the RMS of day 1, 2 and 3. Not
//                      an accuracy: Vimpel's prediction is itself a propagation of its elements.
//   --later TABLE      consistency with Vimpel's later determination: the same object's state in a later table
//                      (files/orbit-products normalize_vimpel: the printed elements' J2000 state at their epoch).
//   node test/opm-vimpel-score.mjs --derived derived.20261012.opm --prediction ephem.20261012/ --out prediction.json
//   node test/opm-vimpel-score.mjs --derived derived.20260907.opm --later orbits.20260921.txt --out later-0907.json
// --shard K/N scores every N-th set from the K-th and writes its per-set rows (--rows F, numbers only); --merge
// F1,F2,... --derived F (--prediction DIR | --later TABLE) --out F sums shards into the report.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { ncdContainerFormat } from "spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ephemerisDataBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { OPM } from "spacedatastandards.org/lib/js/OPM/OPM.js";
import { rfm } from "./lib/frames.mjs";
import { openModule, wasmPath } from "./lib/module.mjs";
import { configuration } from "./lib/pcf.mjs";

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const DERIVED = arg("derived"), PRED = arg("prediction"), LATER = arg("later"), OUT = arg("out"), LIMIT = Number(arg("limit", "0"));
const SHARD = arg("shard"), ROWS = arg("rows"), MERGE = arg("merge");
if (!DERIVED || (!PRED && !LATER)) { console.error("usage: opm-vimpel-score.mjs --derived F (--prediction DIR | --later TABLE) [--out F] [--limit N]"); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.resolve(here, "../../..");
const DAY = 86400000;
const command = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
const SDNAP = configuration({ theory: "SDNAP" });
const WEATHER = process.env.SDNAP_SPACE_WEATHER ?? "/opt/data/sdn-archive/sdn-gp-starlink-ffm-match/environment/space-weather-history.prw";
const weather = { portId: "space_weather_table", typeRef: { schemaName: "PRW.fbs", fileIdentifier: "$PRW", rootTypeName: "PRW" }, payload: new Uint8Array(fs.readFileSync(WEATHER)) };
const m = await openModule();
const x = m.x, buf = x.sdnap_alloc(256), f64 = (o, n) => new Float64Array(m.harness.memory.buffer, buf + o, n);
const iso = (t) => new Date(t).toISOString().replace("Z", "");

// the derived stream: size-prefixed $OPM records end to end
function records(bytes) {
  const out = [];
  for (let off = 0; off + 4 <= bytes.length;) {
    const n = bytes.readUInt32LE(off);
    const rec = new Uint8Array(bytes.subarray(off, off + 4 + n));
    out.push({ bytes: rec, opm: OPM.getSizePrefixedRootAsOPM(new flatbuffers.ByteBuffer(rec)).unpack() });
    off += 4 + n;
  }
  return out;
}
const regimeOf = (o) => (o.ECCENTRICITY >= 0.25 ? "HEO" : o.SEMI_MAJOR_AXIS < 8378 ? "LEO" : o.SEMI_MAJOR_AXIS > 41000 && o.SEMI_MAJOR_AXIS < 43500 && o.ECCENTRICITY < 0.1 ? "GEO" : o.SEMI_MAJOR_AXIS >= 43500 ? "beyond GEO" : "MEO");
const idOf = (o) => String(Number(o.OBJECT_NAME.replace(/^vimpel:/, "")));

/** SDN-AP's EME2000 positions of a batch of derived records on the union of their times (ms): one propagate call
 * (the call's density kernel is built once for the batch). Per record: { r: Map(time -> position) } or { error }. */
async function sdnapBatch(recs, timesList) {
  const union = [...new Set(timesList.flat())].sort((a, b) => a - b);
  const block = new ephemerisDataBlockT();
  block.CENTER_NAME = "EARTH"; block.REFERENCE_FRAME = rfm("EME2000"); block.TIME_SYSTEM = timingStandard.UTC;
  block.START_TIME = iso(union[0]); block.STOP_TIME = iso(union.at(-1));
  block.EPHEMERIS_DATA_LINES = union.map((t) => new ephemerisDataLineT(iso(t)));
  const o = new OEMT(); o.CCSDS_OEM_VERS = 3.0; o.ORIGINATOR = "SDN-AP score grid"; o.EPHEMERIS_DATA_BLOCK = [block];
  const b = new flatbuffers.Builder(1 << 16); OEM.finishOEMBuffer(b, o.pack(b));
  const grid = { portId: "grid", typeRef: { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" }, payload: b.asUint8Array() };
  const opmType = { schemaName: "OPM.fbs", fileIdentifier: "$OPM", rootTypeName: "OPM" };
  const r = await command.invoke({ methodId: "propagate", inputs: [SDNAP, weather, ...recs.map((rec) => ({ portId: "opm", typeRef: opmType, payload: rec.bytes })), grid] });
  if (r.statusCode !== 0) {
    if (recs.length === 1) return [{ error: r.errorCode }];
    // one refused record refuses the call: halve the batch until the refused ones stand alone
    const h = recs.length >> 1;
    return [...(await sdnapBatch(recs.slice(0, h), timesList.slice(0, h))), ...(await sdnapBatch(recs.slice(h), timesList.slice(h)))];
  }
  return r.outputs.map((f) => {
    const lines = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(f.payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
    return { r: new Map(lines.map((L, i) => [union[i], [L.X, L.Y, L.Z]])) };
  });
}
/** Two-body positions of the record's own state about its GM (sdnap_kepler_at). */
function twoBody(o, times) {
  const t0 = Date.parse(o.EPOCH);
  return times.map((t) => {
    f64(0, 6).set([o.X, o.Y, o.Z, o.X_DOT, o.Y_DOT, o.Z_DOT]);
    return x.sdnap_kepler_at(buf, buf + 24, o.GM, (t - t0) / 1000, buf + 48) === 0 ? Array.from(f64(48, 3)) : null;
  });
}
const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : NaN);
const q = (arr, f) => { const s = arr.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))].toPrecision(4) : null; };

let derived = records(fs.readFileSync(DERIVED));
if (LIMIT > 0) derived = derived.slice(0, LIMIT);
if (SHARD) { const [k, n] = SHARD.split("/").map(Number); derived = derived.filter((_, i) => i % n === k); }
const per = [];  // { regime, ... }
const refused = {};
const BATCH = Number(arg("batch", "100"));
if (MERGE) {
  for (const f of MERGE.split(",")) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    per.push(...j.per);
    for (const [k, v] of Object.entries(j.refused)) refused[k] = (refused[k] ?? 0) + v;
  }
} else if (PRED) {
  const files = new Map(fs.readdirSync(PRED).map((f) => [String(Number(f.split("_")[0])), f]));
  const jobs = [];
  for (const rec of derived) {
    const o = rec.opm, f = files.get(idOf(o));
    if (!f) { refused["no ephemeris"] = (refused["no ephemeris"] ?? 0) + 1; continue; }
    const [, ymd, hms] = f.split("_");
    const t0 = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), +hms.slice(0, 2), +hms.slice(2, 4), +hms.slice(4, 6));
    const rows = fs.readFileSync(path.join(PRED, f), "utf8").split("\n").map((l) => l.split(",").map(Number)).filter((c) => c.length === 4 && c.every(Number.isFinite));
    const tD = Date.parse(o.EPOCH);
    const pts = rows.map((c) => ({ t: t0 + c[0] * 600000, r: c.slice(1) })).filter((pt) => pt.t > tD && pt.t <= tD + 3 * DAY).filter((_, i) => i % 12 === 0);
    if (pts.length < 6) { refused["prediction span"] = (refused["prediction span"] ?? 0) + 1; continue; }
    jobs.push({ rec, pts, tD });
  }
  for (let k = 0; k < jobs.length; k += BATCH) {
    const batch = jobs.slice(k, k + BATCH);
    const res = await sdnapBatch(batch.map((j) => j.rec), batch.map((j) => j.pts.map((pt) => pt.t)));
    batch.forEach((j, i) => {
      if (res[i].error) { refused[res[i].error] = (refused[res[i].error] ?? 0) + 1; return; }
      const times = j.pts.map((pt) => pt.t), a = times.map((t) => res[i].r.get(t)), b = twoBody(j.rec.opm, times);
      const days = {};
      for (let day = 1; day <= 3; ++day) {
        const sel = j.pts.map((pt, n) => [pt, n]).filter(([pt]) => pt.t > j.tD + (day - 1) * DAY && pt.t <= j.tD + day * DAY);
        if (!sel.length) continue;
        const rms = (ff) => Math.sqrt(sel.reduce((acc, [pt, n]) => acc + dist(ff[n], pt.r) ** 2, 0) / sel.length);
        days[day] = { sdnap: rms(a), twoBody: rms(b) };
      }
      per.push({ regime: regimeOf(j.rec.opm), days });
    });
    console.log(`${Math.min(k + BATCH, jobs.length)}/${jobs.length}`);
  }
} else {
  // the later table's states by normalize_vimpel
  const text = fs.readFileSync(LATER, "utf8"), bytes = Buffer.from(text), b = new flatbuffers.Builder(1024);
  const kind = b.createString("vimpel-orbits-text"), name = b.createString(""), sha = b.createString(createHash("sha256").update(bytes).digest("hex"));
  NCD.startNCD(b); NCD.addFormat(b, ncdContainerFormat.PROVIDER_DEFINED); NCD.addProviderDefinedFormatName(b, kind); NCD.addInternalFileName(b, name);
  NCD.addSourceSha256(b, sha); NCD.addSourceByteLength(b, BigInt(bytes.length)); NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  const ncd = new Uint8Array(Buffer.concat([b.asUint8Array(), bytes]));
  const op = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(MODULES, "files/orbit-products/dist/isomorphic/module.wasm")),
    manifest: JSON.parse(fs.readFileSync(path.join(MODULES, "files/orbit-products/plugin-manifest.json"), "utf8")), surface: "command" });
  const r = await op.invoke({ methodId: "normalize_vimpel", inputs: [{ portId: "container", typeRef: { schemaName: "NCD.fbs", fileIdentifier: "$NCD", rootTypeName: "NCD", wireFormat: "aligned-binary", requiredAlignment: 8, byteLength: ncd.length }, payload: ncd }] });
  if (r.statusCode !== 0) throw new Error(`normalize_vimpel: ${r.errorCode}`);
  const later = new Map(r.outputs.filter((o) => o.portId === "states").map((o) => OPM.getSizePrefixedRootAsOPM(new flatbuffers.ByteBuffer(new Uint8Array(o.payload))).unpack()).map((o) => [idOf(o), o]));
  const jobs = [];
  for (const rec of derived) {
    const o = rec.opm, l = later.get(idOf(o));
    if (!l) { refused["not in the later table"] = (refused["not in the later table"] ?? 0) + 1; continue; }
    const t = Date.parse(l.EPOCH), tD = Date.parse(o.EPOCH);
    if (!(t > tD)) { refused["later epoch not after"] = (refused["later epoch not after"] ?? 0) + 1; continue; }
    jobs.push({ rec, l, t, tD });
  }
  for (let k = 0; k < jobs.length; k += BATCH) {
    const batch = jobs.slice(k, k + BATCH);
    const res = await sdnapBatch(batch.map((j) => j.rec), batch.map((j) => [j.t]));
    batch.forEach((j, i) => {
      if (res[i].error) { refused[res[i].error] = (refused[res[i].error] ?? 0) + 1; return; }
      const truth = [j.l.X, j.l.Y, j.l.Z];
      per.push({ regime: regimeOf(j.rec.opm), horizonDays: (j.t - j.tD) / DAY, sdnap: dist(res[i].r.get(j.t), truth), twoBody: dist(twoBody(j.rec.opm, [j.t])[0], truth) });
    });
    console.log(`${Math.min(k + BATCH, jobs.length)}/${jobs.length}`);
  }
}
if (ROWS) { fs.writeFileSync(ROWS, JSON.stringify({ per, refused })); process.exit(0); }
const summary = {};
for (const regime of ["GEO", "MEO", "HEO", "LEO", "beyond GEO"]) {
  const rows = per.filter((p) => p.regime === regime);
  if (!rows.length) continue;
  if (PRED) {
    summary[regime] = { objects: rows.length };
    for (const day of [1, 2, 3]) {
      const a = rows.map((p) => p.days[day]?.sdnap), b = rows.map((p) => p.days[day]?.twoBody);
      const both = rows.filter((p) => p.days[day]);
      summary[regime][`day${day}`] = { sdnapMedianKm: q(a, 0.5), sdnapP90Km: q(a, 0.9), twoBodyMedianKm: q(b, 0.5), twoBodyP90Km: q(b, 0.9),
        sdnapCloser: both.length ? +(both.filter((p) => p.days[day].sdnap < p.days[day].twoBody).length / both.length).toFixed(3) : null };
    }
  } else {
    const a = rows.map((p) => p.sdnap), b = rows.map((p) => p.twoBody), h = rows.map((p) => p.horizonDays);
    summary[regime] = { objects: rows.length, horizonDaysMedian: q(h, 0.5), horizonDaysRange: [q(h, 0), q(h, 1)], sdnapMedianKm: q(a, 0.5), sdnapP90Km: q(a, 0.9),
      twoBodyMedianKm: q(b, 0.5), twoBodyP90Km: q(b, 0.9), sdnapCloser: +(rows.filter((p) => p.sdnap < p.twoBody).length / rows.length).toFixed(3) };
  }
}
const report = {
  measure: PRED ? "agreement with JSC Vimpel's own 7-day prediction" : "consistency with JSC Vimpel's later determination",
  derived: path.basename(DERIVED), derivedSha256: createHash("sha256").update(fs.readFileSync(DERIVED)).digest("hex"),
  truth: PRED ? `ephemeris files of ${path.basename(path.resolve(PRED))}` : path.basename(LATER), moduleSha256: createHash("sha256").update(fs.readFileSync(wasmPath)).digest("hex"),
  scored: per.length, notScored: refused, summary,
};
console.log(JSON.stringify(report, null, 1));
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
process.exit(0);
