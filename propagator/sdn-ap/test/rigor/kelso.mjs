// T.S. Kelso's questions (catalog and data practice): does the module take the whole public catalog without
// surprises, refuse what is malformed, carry each element set's identity through to its output, and cost what the
// paper says it costs?
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { THEORY, wasmPath } from "../lib/module.mjs";
import { configuration } from "../lib/pcf.mjs";
import { elementsOf, tleLines } from "../lib/tle.mjs";
import { defineCheck, EARTH_RADIUS_WGS72_KM, hypot3, moduleStates, NotMeasured, REVIEWERS } from "./lib/rigor.mjs";

const OMM_TYPE = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" };

/** The newest public GP snapshot (Space-Track gp class, JSON, gzip) on this host: SDN_GP_SNAPSHOT or the archive's latest. */
function snapshot() {
  if (process.env.SDN_GP_SNAPSHOT) return process.env.SDN_GP_SNAPSHOT;
  const root = "/opt/data/sdn-archive/spacetrack/gp";
  if (!fs.existsSync(root)) return null;
  const year = fs.readdirSync(root).sort().at(-1);
  const file = year && fs.readdirSync(path.join(root, year)).filter((f) => f.endsWith(".json.gz")).sort().at(-1);
  return file ? path.join(root, year, file) : null;
}

export const checks = [
  defineCheck({
    id: "kelso-catalog-scale", reviewer: REVIEWERS.KELSO, tier: "full", timeoutSec: 900,
    question: "Does the whole current public GP catalog go through the SGP4 base with no refusal the reference does not also make, and does a random sample of it match the reference within 1 m over a day?",
    source: "the newest public GP snapshot on the host (Space-Track gp class; statistics only, no record leaves the run); paper 12.1",
    async run(ctx) {
      const file = snapshot();
      if (!file) throw new NotMeasured("no public GP snapshot on this host (SDN_GP_SNAPSHOT)");
      const records = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8")).filter((r) => r.TLE_LINE1 && r.TLE_LINE2);
      const rows = records.map((r) => ({ ...elementsOf([r.TLE_LINE1, r.TLE_LINE2]), theory: THEORY.SGP4 }));
      const module = await ctx.module();
      const t0 = performance.now();
      const states = moduleStates(module, rows, rows.map(() => [0, 1440]));
      const seconds = (performance.now() - t0) / 1e3;
      const refusedIdx = states.map((s, k) => (s.some((x) => !x.ok) ? k : -1)).filter((k) => k >= 0);
      // every module refusal and a seeded random sample of the rest, against the reference
      let seed = 20261025;
      const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const sample = new Set(refusedIdx);
      while (sample.size < refusedIdx.length + 300) sample.add(Math.floor(rand() * rows.length));
      const reference = await ctx.reference();
      let disagreeRefusal = 0, worst = 0, compared = 0;
      const oneSide = [];
      let belowSurface = 0;
      for (const k of sample) {
        const ref = await reference.propagate([records[k].TLE_LINE1, records[k].TLE_LINE2], [0, 1440]);
        [0, 1].forEach((j) => {
          const m = states[k][j], o = ref ? ref[j] : null;
          if (!m.ok && o && Math.hypot(...o.r) < EARTH_RADIUS_WGS72_KM) { belowSurface += 1; return; }  // the radius trap (paper 1.1)
          if (m.ok !== !!o) { disagreeRefusal += 1; oneSide.push(`catalog ${records[k].NORAD_CAT_ID} (epoch ${records[k].EPOCH}) at ${[0, 1440][j]} min: ${m.ok ? "module answers, reference refuses" : "reference answers, module refuses"}`); return; }
          if (m.ok) { compared += 1; worst = Math.max(worst, hypot3(m.r, o.r) * 1e3); }
        });
      }
      return { pass: disagreeRefusal === 0 && worst <= 1, evidence: [
        `${path.basename(file)}: ${rows.length} sets, 2 times each in ${seconds.toFixed(2)} s (${((seconds * 1e6) / (2 * rows.length)).toFixed(2)} us per state, one thread, report only)`,
        `module refused ${refusedIdx.length} sets at epoch or +1 day; ${sample.size} sets against the reference: ${disagreeRefusal} samples where only one side answers (besides ${belowSurface} reference states below one Earth radius that the module refuses, the radius trap), worst ${worst.toExponential(3)} m over ${compared} samples (limit 1 m)`, ...oneSide.map((l) => `  one side: ${l}`)] };
    },
  }),
  defineCheck({
    id: "kelso-malformed-sets-refused", reviewer: REVIEWERS.KELSO, tier: "fast",
    question: "Is a malformed element set refused with a reason rather than propagated: e >= 1, e < 0, mean motion <= 0, a non-finite drag term, an inclination outside [0, 180] deg, for each theory?",
    source: "AIAA 2006-6753 App. D error traps; CCSDS 502.0-B-3 OMM value ranges; paper 1.1",
    async run(ctx) {
      const module = await ctx.module();
      const good = elementsOf(tleLines({ year: 26, day: 290.25, rev: 0, type: 0, bstar: 1e-4, inc: 51.6, raan: 10, ecc: 0.001, argp: 20, ma: 30, mm: 15.5 }));
      const bad = [["e = 1.2", { ecc: 1.2 }], ["e = -0.1", { ecc: -0.1 }], ["n = 0", { meanMotion: 0 }], ["n = -1", { meanMotion: -1 }],
        ["B* NaN", { bstar: NaN, bterm: NaN }], ["i = 200 deg", { inc: 200 }], ["n NaN", { meanMotion: NaN }]];
      const rows = [];
      for (const theory of [THEORY.SGP4, THEORY.SGP4XP, THEORY.SDNAP]) for (const [name, edit] of bad) rows.push({ name: `${name} (theory ${theory})`, row: { ...good, bterm: 0.01, ...edit, theory } });
      const out = moduleStates(module, rows.map((r) => r.row), rows.map(() => [0, 1440]));
      const accepted = rows.map((r, k) => ({ r, states: out[k].filter((s) => s.ok) })).filter((a) => a.states.length);
      return { pass: accepted.length === 0, evidence: [`${rows.length} malformed sets: ${rows.length - accepted.length} refused at every time`,
        ...accepted.map((a) => `  propagated: ${a.r.name}, ${a.states.length} state(s) reported good, ${a.states.every((s) => [...s.r, ...s.v].every(Number.isFinite)) ? "finite" : "NOT FINITE"}`)] };
    },
  }),
  defineCheck({
    id: "kelso-identity-carried", reviewer: REVIEWERS.KELSO, tier: "fast",
    question: "Does an output ephemeris carry its element set's identity: the catalog number (including an alpha-5 range number above 99999), the international designator and the name, unchanged?",
    source: "CCSDS 502.0-B-3 (OMM and OEM metadata); Space-Track alpha-5 numbering (catalog numbers 100000 to 339999 written as a letter and four digits)",
    async run() {
      const command = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
      const evidence = [];
      let ok = true;
      for (const [norad, id, name] of [[25544, "1998-067A", "ISS (ZARYA)"], [270000, "2026-901A", "ALPHA-5 T0000"], [339999, "2026-902Z", "ALPHA-5 Z9999"]]) {
        const b = new flatbuffers.Builder(512);
        const epoch = b.createString("2026-10-20T12:00:00.000000"), oid = b.createString(id), oname = b.createString(name);
        OMM.startOMM(b);
        OMM.addEpoch(b, epoch); OMM.addObjectId(b, oid); OMM.addObjectName(b, oname); OMM.addNoradCatId(b, norad);
        OMM.addMeanMotion(b, 15.5); OMM.addEccentricity(b, 0.001); OMM.addInclination(b, 51.6); OMM.addRaOfAscNode(b, 10);
        OMM.addArgOfPericenter(b, 20); OMM.addMeanAnomaly(b, 30); OMM.addBstar(b, 1e-4);
        OMM.finishOMMBuffer(b, OMM.endOMM(b));
        const r = await command.invoke({ methodId: "propagate", inputs: [configuration({}), { portId: "omm", typeRef: OMM_TYPE, payload: b.asUint8Array() }] });
        if (r.statusCode !== 0) { ok = false; evidence.push(`${norad}: propagate refused (${r.errorCode} ${r.errorMessage})`); continue; }
        const oem = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(r.outputs[0].payload)).unpack();
        const obj = oem.EPHEMERIS_DATA_BLOCK[0]?.OBJECT;
        const got = [obj?.NORAD_CAT_ID, obj?.OBJECT_ID, obj?.OBJECT_NAME];
        const same = got[0] === norad && got[1] === id && got[2] === name;
        ok &&= same;
        evidence.push(`${norad} ${id} "${name}" -> OEM OBJECT ${got.map((g) => JSON.stringify(g ?? null)).join(" ")} ${same ? "same" : "DIFFERENT"}`);
      }
      return { pass: ok, evidence };
    },
  }),
];
