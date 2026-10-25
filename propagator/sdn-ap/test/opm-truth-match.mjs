#!/usr/bin/env node
// Which Vimpel objects have an independent precise orbit? (owner 2026-10-25: "doesn't vimpel in the datefirst.txt
// file match their elements with anything that we DO know the precise orbit of?") Writes aggregates only: counts per
// source, and the nearest candidates as Vimpel numbers with their separations; no Vimpel row, no reference state.
//   1. datefirst: Vimpel number -> NORAD links against each source's own NORAD numbers.
//   2. Elements: every Vimpel object of the three tables against every reference object at the nearest reference epoch
//      (sdnap_osculating_elements; a, e, i, RAAN and the argument of latitude, the latter with |dt| n of slack).
//   3. THEMIS A, D, E (NASA SSCWeb definitive positions, GEI J2000, 1 min): every Vimpel object within 3,000 km of their
//      semi-major axis, its state (normalize_vimpel) carried to the nearest minute by sdnap_kepler_at; the separation.
//   4. The public catalog (Space-Track GP of the 10-12 table's epochs, local, licensed; counts only): each Vimpel state
//      against every GP set by the module's SGP4 in 2-minute bins; how many lie within 10 km, and how many of those
//      have a precise orbit in 1.
// Inputs (local; none is committed): the archive below or SDN_ARCHIVE.
//   node test/opm-truth-match.mjs --out test/results/opm-truth-match.json
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { ncdContainerFormat } from "spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OPM } from "spacedatastandards.org/lib/js/OPM/OPM.js";
import { jdOf } from "./lib/frames.mjs";
import { openModule, THEORY } from "./lib/module.mjs";

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const A = process.env.SDN_ARCHIVE ?? "/opt/data/sdn-archive";
const MODULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TABLES = { "2026-09-07": `${A}/vimpel-e3/orbits.20260907.txt`, "2026-09-21": `${A}/vimpel-e3/orbits.20260921.txt`, "2026-10-12": `${A}/vimpel-e3/fetch-20261025/orbits.20261012.txt` };
const DATEFIRST = `${A}/vimpel-e3/datefirst.txt`;
const GP = arg("gp", `${A}/spacetrack/gp/2026/2026-10-13.json.gz`);
const R = `${A}/reference-states/reference`;
const deg = 180 / Math.PI;
const ang = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const m = await openModule();
const x = m.x, buf = x.sdnap_alloc(512), f64 = (o, n) => new Float64Array(m.harness.memory.buffer, buf + o, n);
const osc = (r, v) => { f64(0, 3).set(r); f64(24, 3).set(v); return x.sdnap_osculating_elements(buf, buf + 24, buf + 48) === 0 ? Array.from(f64(48, 6)) : null; };
const vimpel = Object.fromEntries(Object.entries(TABLES).map(([k, f]) => [k, fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => {
  const c = l.split(",").map((s) => s.trim()), s = c[3];
  return { id: String(Number(c[1])), t: Date.UTC(+s.slice(4, 8), +s.slice(2, 4) - 1, +s.slice(0, 2), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)), a: +c[5], i: +c[6], node: +c[7], e: +c[8], u: +c[9], w: +c[10] };
})]));
const report = { task: "modules-sdn-ap-osculating-opm-input-20261025", created: new Date().toISOString(),
  inputs: { tables: Object.fromEntries(Object.entries(TABLES).map(([k, f]) => [k, { objects: vimpel[k].length, sha256: sha(f) }])), datefirstSha256: sha(DATEFIRST) } };

// --- sources (reference-state $OEM directories: GCRF; the object's NORAD number in the record)
const sub = (root, re) => (fs.existsSync(root) ? fs.readdirSync(root).filter((d) => re.test(d)).map((d) => path.join(root, d)) : []);
const readOem = (file) => OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(fs.readFileSync(file)))).unpack().EPHEMERIS_DATA_BLOCK[0];
function oemSource(name, dirs, every = 1) {
  const by = new Map();
  for (const d of dirs) for (const f of fs.readdirSync(d).filter((n) => n.endsWith(".oem"))) {
    let b; try { b = readOem(path.join(d, f)); } catch { continue; }
    const o = by.get(b.OBJECT.NORAD_CAT_ID) ?? { norad: b.OBJECT.NORAD_CAT_ID, label: b.OBJECT.OBJECT_NAME || String(b.OBJECT.NORAD_CAT_ID), states: [] };
    b.EPHEMERIS_DATA_LINES.forEach((L, k) => { if (k % every) return; const el = osc([L.X, L.Y, L.Z], [L.X_DOT, L.Y_DOT, L.Z_DOT]); if (el) o.states.push({ t: Date.parse(L.EPOCH.replace(/Z?$/, "Z")), iso: L.EPOCH.replace(/Z$/, ""), rv: [L.X, L.Y, L.Z, L.X_DOT, L.Y_DOT, L.Z_DOT], el }); });
    by.set(o.norad, o);
  }
  for (const o of by.values()) o.states.sort((a, b) => a.t - b.t);
  return { name, objects: [...by.values()] };
}
const sources = [
  oemSource("ESA finals (GNSS: GPS, GLONASS, Galileo, BeiDou, QZSS)", sub(R, /^ESA0OPSFIN_2026(24[5-9]|25[0-3]|26[0-6])/)),
  oemSource("IGS finals (GPS)", sub(R, /^IGS0OPSFIN_2026/)),
  oemSource("GFZ MGEX rapid (GNSS incl. BeiDou GEO/IGSO, QZSS)", sub(`${A}/sdn-gp-starlink-ffm-match/gnss-rapid/reference`, /^GFZ/)),
  oemSource("ILRS combination (LAGEOS-1/2, Etalon-1/2)", [...sub(R, /^ilrsa\.orb\.\w+\.26(08|09|10)/), ...sub(`${A}/sdn-gp-starlink-ffm-match/slr-ref/reference`, /^ilrsa/)], 4),
  oemSource("ILRS NSGF (Ajisai, Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2)", sub(R, /^nsgf\.orb\.\w+\.26(08|09|10)/), 2),
  oemSource("Swarm (ESA SP3C)", sub(R, /^SW_OPER/), 6),
  oemSource("LEO POD (Sentinel-6, CryoSat-2 and others)", sub(`${A}/reference-states/reference-leo-pod-2`, /./), 6),
];
const others = [
  { name: "TESS (MAST definitive SPK, -95)", norads: [43435], note: "a 246,000 km, e 0.49, i 56 deg (the experiment's fits); the Vimpel tables' largest a is 186,065 km" },
  { name: "Chandra (NAIF merged SPK, -151)", norads: [25867], note: "the kernel ends 2019-09-02, before every table held; the nearest Vimpel a is 75,884 km against Chandra's 80,786 km" },
  { name: "THEMIS A-E (NAIF 2013 SPKs)", norads: [30580, 30581, 30582, 30583, 30584], note: "the kernels end 2013-02; current orbits from SSCWeb in section themis" },
  { name: "TDRSS (NAIF TDRSS.bsp)", norads: [], note: "SPK type 10 (two-line elements), not a precise orbit; ends 2026-02" },
  { name: "ISS (NASA OEM)", norads: [25544], note: "" },
  { name: "Starlink operator sample", norads: fs.readFileSync(`${A}/operator-ephemerides/_capture/starlink-sample.txt`, "utf8").split(/\s+/).filter(Boolean).map(Number), note: "LEO; the tables hold 14 near-circular LEO objects" },
];
// 1. datefirst
const df = new Set();
for (const l of fs.readFileSync(DATEFIRST, "utf8").split("\n").slice(1)) { const f = l.trim().split(/\s+/); if (f.length >= 3 && /^\d+$/.test(f[0]) && /^\d+$/.test(f[2])) df.add(Number(f[2])); }
report.datefirst = { links: df.size, perSource: [...sources.map((s) => ({ source: s.name, objects: s.objects.length, linked: s.objects.filter((o) => df.has(o.norad)).length })),
  ...others.map((s) => ({ source: s.name, objects: s.norads.length, linked: s.norads.filter((n) => df.has(n)).length }))] };
// 2. elements
report.elements = [];
for (const src of sources) {
  const all = [];
  for (const [tk, rows] of Object.entries(vimpel)) for (const o of src.objects) {
    if (!o.states.length) continue;
    const a0 = o.states[0].el[0];
    for (const v of rows) {
      if (Math.abs(v.a - a0) > 0.02 * a0) continue;
      let lo = 0, hi = o.states.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (o.states[mid].t < v.t) lo = mid; else hi = mid; }
      const s = Math.abs(o.states[lo].t - v.t) < Math.abs(o.states[hi].t - v.t) ? o.states[lo] : o.states[hi];
      const dt = (v.t - s.t) / 1000, [a, e, i, node, argp, M] = s.el;
      const du = Math.abs(dt) > 86400 ? null : Math.max(0, ang(argp + M, v.u) - Math.sqrt(398600.4418 / a ** 3) * deg * Math.abs(dt));
      const score = Math.hypot((v.a - a) / (0.002 * a), (v.e - e) / 0.01, (v.i - i) / 0.2, (ang(v.node, node) * Math.sin(i / deg)) / 0.5, du === null ? 0 : du);
      all.push({ table: tk, vimpel: v.id, norad: o.norad, reference: o.label, score, da: v.a - a, de: v.e - e, di: v.i - i, dnode: ang(v.node, node), du, dtS: dt, v, s });
    }
  }
  all.sort((p, q) => p.score - q.score);
  const overlap = all.filter((c) => c.du !== null);
  const times = src.objects.flatMap((o) => o.states.map((s) => s.t));
  // the position check of each element candidate: the Vimpel state (sdnap_insertion_state, J2000 elements -> TEME)
  // against the reference state rotated to TEME (sdnap_frame_probe) and carried dt by sdnap_kepler_at
  const separation = (c) => {
    const jv = jdOf(new Date(c.v.t).toISOString().replace("Z", ""));
    f64(0, 6).set([c.v.a, c.v.e, c.v.i, c.v.node, c.v.w, c.v.u]);
    if (x.sdnap_insertion_state(jv.whole, jv.frac, buf, 2, buf + 48) !== 0) return null;
    const vs = Array.from(f64(48, 3));
    const jr = jdOf(c.s.iso);
    f64(96, 6).set(c.s.rv);
    if (x.sdnap_frame_probe(jr.whole, jr.frac, buf + 96, buf + 144, 0) < 0) return null;  // GCRF -> TEME at the reference epoch
    if (x.sdnap_kepler_at(buf + 144, buf + 168, 398600.4418, c.dtS, buf + 192) !== 0) return null;
    const rs = f64(192, 3);
    return Math.hypot(rs[0] - vs[0], rs[1] - vs[1], rs[2] - vs[2]);
  };
  const r4 = ({ v, s, ...c }) => Object.fromEntries(Object.entries(c).map(([k, q]) => [k, typeof q === "number" ? +q.toPrecision(4) : q]));
  report.elements.push({ source: src.name, objects: src.objects.length,
    span: times.length ? [new Date(times.reduce((p, q) => Math.min(p, q))).toISOString().slice(0, 10), new Date(times.reduce((p, q) => Math.max(p, q))).toISOString().slice(0, 10)] : null,
    pairsWithinADayOfAReferenceEpoch: overlap.length, elementCandidates: overlap.filter((c) => c.score < 1).length,
    matchesWithin50km: overlap.filter((c) => c.score < 1).map(separation).filter((d) => d !== null && d < 50).length,
    nearest: (overlap.length ? overlap : all).slice(0, 3).map((c) => ({ ...r4(c), separationKm: c.du === null ? null : +(separation(c) ?? NaN).toFixed(1) })) });
}
// 3. THEMIS by position
const container = (text) => { const bytes = Buffer.from(text), b = new flatbuffers.Builder(1024); const kind = b.createString("vimpel-orbits-text"), name = b.createString(""), s = b.createString(createHash("sha256").update(bytes).digest("hex")); NCD.startNCD(b); NCD.addFormat(b, ncdContainerFormat.PROVIDER_DEFINED); NCD.addProviderDefinedFormatName(b, kind); NCD.addInternalFileName(b, name); NCD.addSourceSha256(b, s); NCD.addSourceByteLength(b, BigInt(bytes.length)); NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b)); return new Uint8Array(Buffer.concat([b.asUint8Array(), bytes])); };
const op = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(MODULES, "files/orbit-products/dist/isomorphic/module.wasm")), manifest: JSON.parse(fs.readFileSync(path.join(MODULES, "files/orbit-products/plugin-manifest.json"), "utf8")), surface: "command" });
const T = `${A}/hac/sscweb-themis`;
const truth = {};
for (const f of fs.existsSync(T) ? fs.readdirSync(T).filter((n) => n.endsWith(".json")) : []) for (const s of JSON.parse(fs.readFileSync(path.join(T, f)))[1].Result[1].Data[1]) {
  const d = s[1], c = d.Coordinates[1][0][1];
  (truth[d.Id] ??= []).push(...d.Time[1].map((q, k) => ({ t: Date.parse(q[1]), r: [c.X[1][k], c.Y[1][k], c.Z[1][k]] })));
}
for (const k of Object.keys(truth)) truth[k].sort((a, b) => a.t - b.t);
report.themis = { source: "NASA SSCWeb (sscweb.gsfc.nasa.gov) THEMIS-A, -D, -E definitive positions, GEI J2000, 1 min", files: fs.existsSync(T) ? fs.readdirSync(T).filter((n) => n.endsWith(".json")).map((n) => ({ file: n, sha256: sha(path.join(T, n)) })) : [], tables: {} };
for (const [tk, file] of Object.entries(TABLES)) {
  const rows = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() && Math.abs(+l.split(",")[5] - 46055) < 3000).join("\n") + "\n";
  const ncd = container(rows);
  const r = await op.invoke({ methodId: "normalize_vimpel", inputs: [{ portId: "container", typeRef: { schemaName: "NCD.fbs", fileIdentifier: "$NCD", rootTypeName: "NCD", wireFormat: "aligned-binary", requiredAlignment: 8, byteLength: ncd.length }, payload: ncd }] });
  const opms = (r.outputs ?? []).filter((o) => o.portId === "states").map((o) => OPM.getSizePrefixedRootAsOPM(new flatbuffers.ByteBuffer(new Uint8Array(o.payload))).unpack());
  report.themis.tables[tk] = { candidates: opms.length };
  for (const [id, tr] of Object.entries(truth)) {
    const best = [];
    for (const o of opms) {
      const t = Date.parse(o.EPOCH);
      let lo = 0, hi = tr.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid].t < t) lo = mid; else hi = mid; }
      const q = Math.abs(tr[lo].t - t) < Math.abs(tr[hi].t - t) ? tr[lo] : tr[hi];
      if (Math.abs(q.t - t) > 120000) continue;
      f64(0, 6).set([o.X, o.Y, o.Z, o.X_DOT, o.Y_DOT, o.Z_DOT]);
      if (x.sdnap_kepler_at(buf, buf + 24, o.GM, (q.t - t) / 1000, buf + 48) !== 0) continue;
      const s = f64(48, 3);
      best.push({ vimpel: o.OBJECT_NAME.replace("vimpel:", ""), separationKm: +Math.hypot(s[0] - q.r[0], s[1] - q.r[1], s[2] - q.r[2]).toFixed(1) });
    }
    best.sort((a, b) => a.separationKm - b.separationKm);
    report.themis.tables[tk][id] = best.slice(0, 2);
  }
}
// 4. the public catalog (counts only)
if (fs.existsSync(GP)) {
  const gp = JSON.parse(zlib.gunzipSync(fs.readFileSync(GP))).filter((g) => g.MEAN_ELEMENT_THEORY === "SGP4" && +g.MEAN_MOTION > 0.5);
  const sets = gp.map((g) => { const t = jdOf(g.EPOCH); return { epochWhole: t.whole, epochFrac: t.frac, meanMotion: +g.MEAN_MOTION, ecc: +g.ECCENTRICITY, inc: +g.INCLINATION, raan: +g.RA_OF_ASC_NODE, argp: +g.ARG_OF_PERICENTER, ma: +g.MEAN_ANOMALY, bstar: +g.BSTAR, ndot: +g.MEAN_MOTION_DOT, nddot: +g.MEAN_MOTION_DDOT, norad: +g.NORAD_CAT_ID, theory: THEORY.SGP4 }; });
  m.init(sets);
  const precise = new Set([...sources.flatMap((s) => s.objects.map((o) => o.norad)), ...others.flatMap((s) => s.norads)]);
  const bins = new Map();
  for (const v of vimpel["2026-10-12"]) { const b = Math.round(v.t / 120000) * 120000; if (!bins.has(b)) bins.set(b, []); bins.get(b).push(v); }
  const near = [];
  for (const [b, list] of bins) {
    const j = jdOf(new Date(b).toISOString().replace("Z", ""));
    const P = m.atJd(j.whole, j.frac);
    for (const v of list) {
      const jv = jdOf(new Date(v.t).toISOString().replace("Z", ""));
      f64(0, 6).set([v.a, v.e, v.i, v.node, v.w, v.u]);
      if (x.sdnap_insertion_state(jv.whole, jv.frac, buf, 2, buf + 48) !== 0) continue;
      const s = Array.from(f64(48, 3)), dt = (v.t - b) / 1000;
      let best = Infinity, bi = -1;
      for (let k = 0; k < sets.length; ++k) {
        if (P.status[k] !== 0) continue;
        const d = (P.x[k] + P.vx[k] * dt - s[0]) ** 2 + (P.y[k] + P.vy[k] * dt - s[1]) ** 2 + (P.z[k] + P.vz[k] * dt - s[2]) ** 2;
        if (d < best) { best = d; bi = k; }
      }
      near.push({ sep: Math.sqrt(best), norad: sets[bi]?.norad });
    }
  }
  const within = (km) => near.filter((n) => n.sep < km);
  report.publicCatalog = { source: `Space-Track GP ${path.basename(GP)} (local, licensed; counts only)`, gpSets: sets.length, vimpelObjects: near.length,
    within10km: within(10).length, within50km: within(50).length, within10kmWithAPreciseOrbit: within(10).filter((n) => precise.has(n.norad)).length };
}
const out = arg("out");
console.log(JSON.stringify(report, null, 1));
if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
process.exit(0);
