// files/vcm-text, end to end through the built modules.
//
// 1. Round trip against the reader: files/orbit-products' synthetic
//    SP Vector/Covariance Message (fixtures/vcm_v2_sample.txt) read by its
//    normalize_vcm into an $OCM, written here by ocm_to_vcm, and read back by
//    normalize_vcm: the second $OCM states the same J2K state, ECI and EFG
//    states, covariance, coefficients and every other field as the first, to a
//    relative 1e-12 (equal in fact), and writing it again gives the same text.
// 2. An AP set: the AP $OCM fitted by propagator/sdn-ap to NASA's public ISS
//    ephemeris (tests/fixtures/iss-ap.ocm) with its states at the set's epoch
//    from propagator/sdn-ap's propagate in EME2000 and TEME: the J2K and ECI lines
//    hold those states to the message's digits (8 decimals of km, 12 of km/s),
//    the epoch line the set's epoch, the coefficients its BTERM and AGOM, and the
//    lines the set has no value for are left out.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { ncdContainerFormat } from "spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { PCF, PCFT } from "spacedatastandards.org/lib/js/PCF/PCF.js";
import { PCFOutputT } from "spacedatastandards.org/lib/js/PCF/PCFOutput.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const files = path.join(root, "..");
const modules = path.join(files, "..");
const dist = (dir) => ({ wasm: path.join(dir, "dist", "isomorphic", "module.wasm"), manifest: path.join(dir, "plugin-manifest.json") });
const WRITER = dist(root), READER = dist(path.join(files, "orbit-products")), AP = dist(path.join(modules, "propagator", "sdn-ap"));
const SAMPLE = path.join(files, "orbit-products", "fixtures", "vcm_v2_sample.txt");
const skip = [WRITER, READER, AP].some((d) => !fs.existsSync(d.wasm)) && "build files/vcm-text first (npm run build)";

const ref = (type) => ({ schemaName: `${type}.fbs`, fileIdentifier: `$${type}`, rootTypeName: type, wireFormat: "flatbuffer" });
async function harness(t, d) {
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(d.wasm), manifest: JSON.parse(fs.readFileSync(d.manifest, "utf8")), surface: "direct" });
  t.after(() => h.destroy());
  return h;
}
async function call(h, methodId, inputs) {
  const r = await h.invoke({ methodId, inputs: inputs.map(([portId, type, payload]) => ({ portId, typeRef: ref(type), payload })) });
  if (r.statusCode !== 0 && r.statusCode !== undefined) throw new Error(`${methodId}: ${r.errorCode ?? ""} ${r.errorMessage ?? ""}`);
  return r;
}
const out = (r, port) => r.outputs.filter((o) => o.portId === port).map((o) => new Uint8Array(o.payload));
const plain = (bytes, id) => (String.fromCharCode(...bytes.subarray(4, 8)) === id ? bytes : bytes.subarray(4));
const ocmOf = (bytes) => OCM.getRootAsOCM(new flatbuffers.ByteBuffer(plain(bytes, "$OCM"))).unpack();
const oemOf = (bytes) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(plain(bytes, "$OEM"))).unpack();

/** The frame normalize_vcm reads: a size-prefixed $NCD (vcm-v2-text, hash and length) and the text. */
function container(text) {
  const bytes = Buffer.from(text, "latin1");
  const b = new flatbuffers.Builder(256);
  const name = b.createString("vcm-v2-text"), sha = b.createString(createHash("sha256").update(bytes).digest("hex"));
  NCD.startNCD(b);
  NCD.addFormat(b, ncdContainerFormat.PROVIDER_DEFINED);
  NCD.addProviderDefinedFormatName(b, name);
  NCD.addSourceSha256(b, sha);
  NCD.addSourceByteLength(b, BigInt(bytes.length));
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  return Buffer.concat([b.asUint8Array(), bytes]);
}
/** ocm_to_vcm's frame: the descriptor checked against the text after it. */
function message(frame) {
  const size = new DataView(frame.buffer, frame.byteOffset).getUint32(0, true);
  const d = NCD.getRootAsNCD(new flatbuffers.ByteBuffer(frame.subarray(4, 4 + size)));
  const text = Buffer.from(frame.subarray(4 + size));
  assert.equal(d.PROVIDER_DEFINED_FORMAT_NAME(), "vcm-v2-text");
  assert.equal(Number(d.SOURCE_BYTE_LENGTH()), text.length);
  assert.equal(d.SOURCE_SHA256(), createHash("sha256").update(text).digest("hex"));
  return text.toString("latin1");
}
const read = async (reader, text) => ocmOf(out(await call(reader, "normalize_vcm", [["container", "NCD", container(text)]]), "orbit")[0]);
const write = async (writer, ocmBytes, states = []) => message(out(await call(writer, "ocm_to_vcm", [["ocm", "OCM", ocmBytes], ...states.map((s) => ["state", "OEM", s])]), "message")[0]);
const pack = (t) => { const b = new flatbuffers.Builder(4096); OCM.finishOCMBuffer(b, t.pack(b)); return b.asUint8Array().slice(); };
const close = (a, b) => a === b || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));
const numbersOf = (text) => text.trim().split(/\s+/).map(Number);

test("round trip: normalize_vcm, ocm_to_vcm, normalize_vcm keeps every field", { skip }, async (t) => {
  const [writer, reader] = [await harness(t, WRITER), await harness(t, READER)];
  const first = await read(reader, fs.readFileSync(SAMPLE, "latin1"));
  const text = await write(writer, pack(first));
  const second = await read(reader, text);
  let checked = 0;
  for (let i = 0; i < 6; i += 1, checked += 1) assert.ok(close(first.STATE_DATA[i], second.STATE_DATA[i]), `J2K ${i}`);
  const params = (o) => Object.fromEntries(o.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));
  const [p1, p2] = [params(first), params(second)];
  assert.deepEqual(Object.keys(p2).sort(), Object.keys(p1).sort());
  for (const [k, v] of Object.entries(p1)) {
    if (k === "VCM_INTEGRATOR") { assert.equal(p2[k], v); checked += 1; continue; }
    const [a, b] = [numbersOf(v), numbersOf(p2[k])];
    assert.equal(b.length, a.length, k);
    a.forEach((x, i) => { assert.ok(close(x, b[i]), `${k}[${i}] ${x} ${b[i]}`); checked += 1; });
  }
  for (const k of ["GRAVITY_MODEL", "GRAVITY_DEGREE", "GRAVITY_ORDER", "FIXED_F10P7", "FIXED_F10P7_MEAN", "FIXED_GEOMAG_AP"]) { assert.equal(second.PERTURBATIONS[k], first.PERTURBATIONS[k], k); checked += 1; }
  assert.deepEqual(second.PERTURBATIONS.COMMENT, first.PERTURBATIONS.COMMENT);
  assert.deepEqual(second.PERTURBATIONS.N_BODY_PERTURBATIONS, first.PERTURBATIONS.N_BODY_PERTURBATIONS);
  for (const k of ["SEDR", "WEIGHTED_RMS", "OD_EPOCH"]) { assert.equal(second.ORBIT_DETERMINATION[k], first.ORBIT_DETERMINATION[k], k); checked += 1; }
  for (const k of ["OBJECT_DESIGNATOR", "INTERNATIONAL_DESIGNATOR", "EPOCH_TZERO", "TAIMUTC_AT_TZERO", "UT1MUTC_AT_TZERO", "NEXT_LEAP_EPOCH"]) { assert.equal(second.METADATA[k], first.METADATA[k], k); checked += 1; }
  assert.equal(second.ORB_REVNUM, first.ORB_REVNUM);
  assert.equal(second.HEADER.CREATION_DATE, first.HEADER.CREATION_DATE);
  assert.equal(second.HEADER.ORIGINATOR, first.HEADER.ORIGINATOR);
  assert.equal(await write(writer, pack(second)), text, "writing the read-back record again gives the same text");
  const covariance = numbersOf(p1.VCM_COVARIANCE_EQUINOCTIAL_LOWER_TRIANGLE).length;
  console.log(`VCM TEXT ROUND TRIP PASS: ${checked} values equal to 1e-12 (J2K state, ECI and EFG states, ${covariance} covariance terms, coefficients, sigmas, weather, time and identity), ${text.split("\r\n").length - 1} lines, text a fixed point`);
});

test("an AP set: J2K and ECI from AP's propagate at the epoch, coefficients from BTERM and AGOM, nothing invented", { skip }, async (t) => {
  const [writer, ap] = [await harness(t, WRITER), await harness(t, AP)];
  const ocmBytes = new Uint8Array(fs.readFileSync(path.join(here, "fixtures", "iss-ap.ocm")));
  const set = ocmOf(ocmBytes);
  const epoch = set.MEAN_ELEMENTS.EPOCH;
  const at = (frame) => {
    const c = new PCFT();
    c.OUTPUT = Object.assign(new PCFOutputT(), { FRAME: pcfOutputFrame[frame], EPOCHS: [epoch] });
    const b = new flatbuffers.Builder(256); PCF.finishPCFBuffer(b, c.pack(b)); return b.asUint8Array().slice();
  };
  const fly = async (frame) => out(await call(ap, "propagate", [["ocm", "OCM", ocmBytes], ["configuration", "PCF", at(frame)]]), "ephemeris")[0];
  const [j2k, teme] = [await fly("EME2000"), await fly("TEME")];
  const text = await write(writer, ocmBytes, [j2k, teme]);
  const lines = text.split("\r\n").filter(Boolean).map((l) => l.replace(/^<> /, ""));
  const value = (label) => { const l = lines.find((x) => x.startsWith(label)); assert.ok(l, `${label} line`); return l.slice(label.length); };
  const ms = Date.parse(`${epoch.replace(/Z$/, "")}Z`), d = new Date(ms);
  const doy = Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  assert.match(value("EPOCH TIME (UTC): "), new RegExp(`^${d.getUTCFullYear()} ${String(doy).padStart(3, "0")} \\(${String(d.getUTCDate()).padStart(2, "0")} [A-Z]{3}\\) ${d.toISOString().slice(11, 23)} `));
  let worstKm = 0, worstKmS = 0;
  for (const [label, record] of [["J2K", j2k], ["ECI", teme]]) {
    const s = oemOf(record).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
    const pos = numbersOf(value(`${label} POS (KM): `)), vel = numbersOf(value(`${label} VEL (KM/S): `));
    [s.X, s.Y, s.Z].forEach((x, i) => { worstKm = Math.max(worstKm, Math.abs(pos[i] - x)); });
    [s.X_DOT, s.Y_DOT, s.Z_DOT].forEach((x, i) => { worstKmS = Math.max(worstKmS, Math.abs(vel[i] - x)); });
  }
  assert.ok(worstKm <= 5.0000001e-9, `position ${worstKm} km`);
  assert.ok(worstKmS <= 5.0000001e-13, `velocity ${worstKmS} km/s`);
  const coefficients = value("BALLISTIC COEF (M2/KG): ").split(" BDOT")[0], srp = value("SOLAR RAD PRESS COEFF (M2/KG): ").split("  EDR")[0];
  assert.equal(Number(coefficients), set.MEAN_ELEMENTS.BTERM);
  assert.equal(Number(srp), set.MEAN_ELEMENTS.AGOM);
  assert.match(value("GEOPOTENTIAL: "), new RegExp(`^${set.PERTURBATIONS.GRAVITY_MODEL} ${set.PERTURBATIONS.MAXIMUM_ZONAL_DEGREE}Z,${set.PERTURBATIONS.MAXIMUM_TESSERAL_DEGREE}T  DRAG: `));
  const absent = ["EFG POS", "SOLAR RAD PRESS:", "THRUST ACCEL", "SOLAR FLUX", "TAI-UTC", "POLAR MOT", "INTEGRATOR MODE", "STEP MODE", "INITIAL STEP", "VECTOR U,V,W", "VECTOR UD", "COVARIANCE MATRIX"];
  for (const label of absent) assert.ok(!lines.some((l) => l.startsWith(label)), `${label} is left out`);
  assert.equal(value("TIME CONST LEAP SECOND TIME (UTC): "), "2049 365 (31 DEC) 23:59:59.999");
  await assert.rejects(write(writer, ocmBytes, [j2k, j2k]), /state-duplicate/);
  console.log(`VCM TEXT AP SET PASS: ${lines.length} lines; J2K and ECI within ${worstKm.toExponential(2)} km and ${worstKmS.toExponential(2)} km/s of AP's propagate at ${epoch}; BTERM and AGOM exact; ${absent.length} lines left out`);
});
