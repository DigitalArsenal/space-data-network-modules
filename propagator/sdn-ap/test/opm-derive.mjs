#!/usr/bin/env node
// SDN's own osculating sets derived from JSC Vimpel's osculating-element table (owner 2026-10-25: "create our own
// osculating elements from Vimpel so we're not republishing theirs ... propagate the elements and create new osculating
// elements 1/4 period"). Every number comes from a module; JS moves bytes:
//   1. files/orbit-products `normalize_vimpel`: each table row to its J2000 $OPM (the printed osculating elements' state
//      at the reference epoch, GM 398,600.4418 km^3/s^2).
//   2. sdn-ap `sdnap_osculating_elements_about`: the period P of that state about the record's GM; the new epoch is
//      the reference epoch plus P/4, to the millisecond.
//   3. propagator/ffm `invoke`: the state carried P/4 under the full force model of propagator/ffm/catalog-configuration
//      (`fullForceRequest`: EGM2008 70x70; Sun, Moon, Venus, Mars, Jupiter from DE440s; cannonball SRP with the conical
//      shadow, Cr*A/m 0.02 m^2/kg; Knocke Earth radiation; NRLMSISE-00 drag, Cd*A/m 0.01 m^2/kg, on the daily space
//      weather; IERS 2010 solid tides, FES2004 ocean tides 30x30, IERS 2010 relativity; RK78 at 1e-14), in EME2000
//      (INITIAL.COORDINATE_SYSTEM MEAN_EQUATOR_EQUINOX_J2000), with the Earth orientation and space weather of the
//      experiment's environment record.
//   4. sdn-ap `sdnap_osculating_elements_about`: the carried state as osculating elements about the same GM.
// Each derived set is one size-prefixed $OPM (EME2000, UTC, the state and the Keplerian block, GM, MASS 1 kg with
// DRAG_AREA 0.01 / DRAG_COEFF 1 and SOLAR_RAD_AREA 0.02 / SOLAR_RAD_COEFF 1: the forces the derivation assumed), the
// credit in COMMENT, the stream written to --out. Vimpel's own rows are read here and never written.
//   node test/opm-derive.mjs --table orbits.YYYYMMDD.txt --out derived.opm [--limit N]
// Needs: npm ci in this package, files/orbit-products, propagator/ffm and analysis/od; the DE440s kernel and the
// environment record (paths below, or SDNAP_KERNEL / SDNAP_FFM_ENVIRONMENT).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { ncdContainerFormat } from "spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js";
import { OPM, OPMT } from "spacedatastandards.org/lib/js/OPM/OPM.js";
import { OPMUserDefinedParameterT } from "spacedatastandards.org/lib/js/OPM/OPMUserDefinedParameter.js";
import { openModule } from "./lib/module.mjs";

export const CREDIT = "Derived from JSC Vimpel orbit data (spacedata.vimpel.ru): each set propagated one quarter period with FFM and re-expressed as osculating elements.";
const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const here = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.resolve(here, "../../..");
const KERNEL = process.env.SDNAP_KERNEL ?? "/opt/data/sdn-archive/hac/naif-kernels/spk/planets/de440s.bsp";
const ENV_FILE = process.env.SDNAP_FFM_ENVIRONMENT ?? "/opt/data/sdn-archive/sdn-gp-starlink-ffm-match/environment/environment.json";
const imp = (p) => import(pathToFileURL(path.join(MODULES, p)));
const catalog = await imp("propagator/ffm/catalog.mjs");
const envmod = await imp("analysis/od/scripts/operator-environment.mjs");
const fb = await imp("propagator/ffm/node_modules/flatbuffers/mjs/flatbuffers.js");
const P = catalog.prw;
const harness = async (dir, surface) => createBrowserModuleHarness({
  wasmSource: fs.readFileSync(path.join(MODULES, dir, "dist/isomorphic/module.wasm")),
  manifest: JSON.parse(fs.readFileSync(path.join(MODULES, dir, "plugin-manifest.json"), "utf8")), surface });

/** The NCD container normalize_vimpel reads: [descriptor][the table's bytes], hash-checked. */
function container(text) {
  const bytes = Buffer.from(text), b = new flatbuffers.Builder(1024);
  const kind = b.createString("vimpel-orbits-text"), name = b.createString(""), sha = b.createString(createHash("sha256").update(bytes).digest("hex"));
  NCD.startNCD(b); NCD.addFormat(b, ncdContainerFormat.PROVIDER_DEFINED); NCD.addProviderDefinedFormatName(b, kind); NCD.addInternalFileName(b, name);
  NCD.addSourceSha256(b, sha); NCD.addSourceByteLength(b, BigInt(bytes.length)); NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  return new Uint8Array(Buffer.concat([b.asUint8Array(), bytes]));
}
const readOpm = (bytes) => { const u = new Uint8Array(bytes); try { return OPM.getSizePrefixedRootAsOPM(new flatbuffers.ByteBuffer(u)).unpack(); } catch { return OPM.getRootAsOPM(new flatbuffers.ByteBuffer(u)).unpack(); } };

export async function derive({ tablePath, limit = 0, onRow }) {
  const text = fs.readFileSync(tablePath, "utf8");
  const op = await harness("files/orbit-products", "command");
  const ncd = container(text);
  const r = await op.invoke({ methodId: "normalize_vimpel", inputs: [{ portId: "container", typeRef: { schemaName: "NCD.fbs", fileIdentifier: "$NCD", rootTypeName: "NCD", wireFormat: "aligned-binary", requiredAlignment: 8, byteLength: ncd.length }, payload: ncd }] });
  if (r.statusCode !== 0) throw new Error(`normalize_vimpel: ${r.errorCode} ${r.errorMessage}`);
  let sources = r.outputs.filter((o) => o.portId === "states").map((o) => readOpm(o.payload));
  if (limit > 0) sources = sources.slice(0, limit);
  const ffm = await harness("propagator/ffm", "direct");
  const env = JSON.parse(fs.readFileSync(ENV_FILE, "utf8"));
  const ffmInputs = [envmod.input("kernel", "PRW", catalog.kernelRecord(fs.readFileSync(KERNEL))),
    ...Object.entries(env.inputs).map(([k, b64]) => envmod.input(k, "PRW", new Uint8Array(Buffer.from(b64, "base64"))))];
  const eme = () => Object.assign(new P.RFMCoordinateSystemT(), { NAME: "EME2000", AXIS_TYPE: P.rfmAxisType.MEAN_EQUATOR_EQUINOX_J2000, AXIS_REFERENCE_BODY_ID: 399,
    ORIGIN: Object.assign(new P.RFMOriginT(), { KIND: P.rfmOriginKind.CELESTIAL_BODY, CELESTIAL_BODY_ID: 399 }) });
  const m = await openModule();
  const x = m.x, buf = x.sdnap_alloc(256), f64 = (o, n) => new Float64Array(m.harness.memory.buffer, buf + o, n);
  const elementsAbout = (s, gm) => { f64(0, 6).set(s); return x.sdnap_osculating_elements_about(buf, buf + 24, gm, buf + 48) === 0 ? Array.from(f64(48, 8)) : null; };
  const out = [], refused = {};
  const refuse = (why) => { refused[why] = (refused[why] ?? 0) + 1; };
  for (const s of sources) {
    const state0 = [s.X, s.Y, s.Z, s.X_DOT, s.Y_DOT, s.Z_DOT];
    const e0 = elementsAbout(state0, s.GM);
    if (!e0) { refuse("open-orbit"); continue; }
    const t0 = Date.parse(s.EPOCH), shiftMs = Math.round(e0[7] * 1000 / 4);
    const target = new Date(t0 + shiftMs).toISOString();
    const req = catalog.fullForceRequest({ epoch: s.EPOCH, state: state0.map((v) => v * 1000), target });
    req.INITIAL.STATE.COORDINATE_SYSTEM_NAME = "EME2000";
    req.INITIAL.COORDINATE_SYSTEM = eme();
    const rr = await ffm.invoke({ methodId: "invoke", inputs: [{ portId: "request", typeRef: catalog.TYPE, payload: catalog.encode("EXECUTION_REQUEST", req) }, ...ffmInputs] });
    if (rr.statusCode !== 0) { refuse(`ffm:${rr.errorCode}`); continue; }
    const res = P.PRW.getSizePrefixedRootAsPRW(new fb.ByteBuffer(new Uint8Array(rr.outputs.find((f) => f.portId === "response").payload))).unpack().EXECUTION_RESULT;
    const fin = res.FINAL_SAMPLE?.STATE?.STATE;
    if (!fin) { refuse("ffm:no-final-sample"); continue; }
    const state1 = ["POSITION", "VELOCITY"].flatMap((k) => ["X", "Y", "Z"].map((c) => fin[k][c] / 1000));
    const e1 = elementsAbout(state1, s.GM);
    if (!e1) { refuse("open-orbit-after"); continue; }
    const d = Object.assign(new OPMT(), {
      CCSDS_OPM_VERS: "2.0", ORIGINATOR: "SDN (derived)", OBJECT_NAME: s.OBJECT_NAME, CENTER_NAME: "EARTH", REF_FRAME: "EME2000", TIME_SYSTEM: "UTC",
      EPOCH: target, X: state1[0], Y: state1[1], Z: state1[2], X_DOT: state1[3], Y_DOT: state1[4], Z_DOT: state1[5],
      SEMI_MAJOR_AXIS: e1[0], ECCENTRICITY: e1[1], INCLINATION: e1[2], RA_OF_ASC_NODE: e1[3], ARG_OF_PERICENTER: e1[4], TRUE_ANOMALY: e1[5], MEAN_ANOMALY: e1[6],
      GM: s.GM, MASS: 1, DRAG_AREA: catalog.DEFAULT_DRAG_AREA_OVER_MASS, DRAG_COEFF: 1, SOLAR_RAD_AREA: catalog.DEFAULT_SRP_AREA_OVER_MASS, SOLAR_RAD_COEFF: 1,
      COMMENT: CREDIT,
      USER_DEFINED_PARAMETERS: [["SDN_DERIVATION", "FFM full force, one quarter period (propagator/ffm catalog-configuration fullForceRequest), EME2000"],
        ["SDN_EPOCH_SHIFT_SECONDS", (shiftMs / 1000).toFixed(3)]].map(([k, v]) => new OPMUserDefinedParameterT(k, v)),
    });
    const b = new flatbuffers.Builder(1024);
    b.forceDefaults(true);  // every scalar on the wire: a zero element is an element
    OPM.finishSizePrefixedOPMBuffer(b, d.pack(b));
    const bytes = b.asUint8Array().slice();
    out.push(bytes);
    onRow?.(out.length, sources.length);
  }
  return { records: out, sources: sources.length, refused };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const tablePath = arg("table"), outPath = arg("out");
  if (!tablePath || !outPath) { console.error("usage: opm-derive.mjs --table orbits.YYYYMMDD.txt --out derived.opm [--limit N]"); process.exit(1); }
  const t0 = performance.now();
  const { records, sources, refused } = await derive({ tablePath, limit: Number(arg("limit", "0")), onRow: (k, n) => { if (k % 500 === 0) console.log(`${k}/${n}`); } });
  const stream = Buffer.concat(records.map((r) => Buffer.from(r)));
  fs.writeFileSync(outPath, stream);
  const table = fs.readFileSync(tablePath);
  console.log(JSON.stringify({ table: path.basename(tablePath), tableSha256: createHash("sha256").update(table).digest("hex"), sources, derived: records.length, refused,
    out: outPath, outSha256: createHash("sha256").update(stream).digest("hex"), seconds: +((performance.now() - t0) / 1000).toFixed(1) }, null, 1));
  process.exit(0);
}
