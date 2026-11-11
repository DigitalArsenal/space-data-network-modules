// $OCM element sets for the tests: the 0.4.0 fixtures' fits made by the module (AP under gravity caps 31 and 20 and
// NRLMSISE-00 on the fixture rows, stock SGP4XP), a record edited through the bindings to trigger a refusal, and the
// frames of a flight. JS only moves bytes: every element set comes out of the module.
import fs from "node:fs";
import * as flatbuffers from "flatbuffers";
import { OCM, OCMT } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { HeaderT } from "spacedatastandards.org/lib/js/OCM/Header.js";
import { MetadataT } from "spacedatastandards.org/lib/js/OCM/Metadata.js";
import { OCMMeanElementsT } from "spacedatastandards.org/lib/js/OCM/OCMMeanElements.js";
import { PerturbationsT } from "spacedatastandards.org/lib/js/OCM/Perturbations.js";
import { ATMT } from "spacedatastandards.org/lib/js/OCM/ATM.js";
import { AtmosphericModelFamily } from "spacedatastandards.org/lib/js/OCM/AtmosphericModelFamily.js";
import { SPW, SPWT } from "spacedatastandards.org/lib/js/OCM/SPW.js";
import { RFMT } from "spacedatastandards.org/lib/js/OCM/RFM.js";
import { RFMUnion } from "spacedatastandards.org/lib/js/OCM/RFMUnion.js";
import { CelestialFrameWrapperT } from "spacedatastandards.org/lib/js/OCM/CelestialFrameWrapper.js";
import { CelestialFrame } from "spacedatastandards.org/lib/js/OCM/CelestialFrame.js";
import { CustomFrameWrapperT } from "spacedatastandards.org/lib/js/OCM/CustomFrameWrapper.js";
import { CustomFrame } from "spacedatastandards.org/lib/js/OCM/CustomFrame.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { configuration, MSIS_FORCES, XP_FORCES } from "./pcf.mjs";
import { inputs, GRID } from "./fixture-inputs.mjs";

export const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });

/// fit's FORCES of the AP fixture: gravity caps 31 and 20, NRLMSISE-00 on the daily rows.
export const AP_FORCES = Object.freeze({ ...MSIS_FORCES, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true,
  MAXIMUM_DEGREE: 20, WEATHER_SOURCE: pcfWeatherSource.RECORDS });

export const ocmOf = (bytes) => OCM.getRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();

/// The record `bytes` with `edit(t)` applied to its object form, packed again.
export function repackOcm(bytes, edit) {
  const t = ocmOf(bytes);
  edit(t);
  const b = new flatbuffers.Builder(8192);
  OCM.finishOCMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}

/// The AP and XP $OCM of the fixture inputs, fitted by the module behind `h` (a standalone harness).
export async function fixtureSets(h) {
  const { arc, rows } = inputs();
  const fit = async (config, spw) => {
    const r = await h.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: T("OEM"), payload: arc }, config,
      ...(spw ? [{ portId: "space_weather", typeRef: T("SPW"), payload: spw }] : [])] });
    if (r.statusCode !== 0) throw new Error(`fit: ${r.errorCode} ${r.errorMessage}`);
    return new Uint8Array(r.outputs[0].payload);
  };
  return {
    ap: await fit(configuration({ theory: "AP", forces: AP_FORCES }), rows.bytes),
    xp: await fit(configuration({ theory: "SGP4XP", forces: XP_FORCES })),
    rows,
  };
}

/// The fixture grid as the $PCF OUTPUT of a flight.
export const GRID_OUTPUT = Object.freeze({ START_TIME: GRID.start, STOP_TIME: GRID.stop, STEP_SECONDS: GRID.step });

/// The frames of a flight: 'ocm' records and, when `pcf` is given, its 'configuration'.
export const flight = (records, pcf = null) => [
  ...records.map((payload) => ({ portId: "ocm", typeRef: T("OCM"), payload })),
  ...(pcf ? [configuration(pcf)] : []),
];

/// An SGP4XP or AP $OCM made from elements, as a test's seed set (fit makes the others): theory AP unless the forces
/// are the theory's own; `rows` the $SPW rows (SPWT objects) under RECORDS; `solidTides` states AP's solid Earth tide
/// (PERTURBATIONS.SOLID_TIDES_MODEL IERS 2010, SPEC 16.14); `slow` the slow set (GRAVITY_MODEL "EGM2008; slow tesseral terms to
/// degree 70", SPEC 16.18). The module validates what it flies.
export function seedOcm({ epoch, n, e, i, raan, argp, ma, bterm = 0, agom = 0, norad = 0, name = null, msis = false, records = false, tesseral = 0, zonal = 0, rows = [], dca = null, solidTides = false, slow = false }) {
  const stock = !msis && !records && !tesseral && !zonal && !solidTides;
  const ofEpoch = tesseral > 0 || zonal > 0;
  const t = new OCMT();
  t.HEADER = Object.assign(new HeaderT(), { CCSDS_OCM_VERS: "3.0", ORIGINATOR: "SDN" });
  t.METADATA = Object.assign(new MetadataT(), { NORAD_CAT_ID: norad, OBJECT_NAME: name, TIME_SYSTEM: "UTC" });
  t.CENTER_NAME = "EARTH";
  t.TRAJ_REF_FRAME = ofEpoch ? new RFMT(RFMUnion.CustomFrameWrapper, new CustomFrameWrapperT(CustomFrame.TEMEOFEPOCH), 0, "TEMEOFEPOCH")
    : new RFMT(RFMUnion.CelestialFrameWrapper, new CelestialFrameWrapperT(CelestialFrame.TEMEOFDATE), 0, "TEMEOFDATE");
  if (ofEpoch) t.TRAJ_FRAME_EPOCH = epoch;
  t.ORB_AVERAGING = "BROUWER";
  t.MEAN_ELEMENTS = Object.assign(new OCMMeanElementsT(), { MEAN_ELEMENT_THEORY: stock ? 1 : 5, EPOCH: epoch, MEAN_MOTION: n, ECCENTRICITY: e, INCLINATION: i,
    RA_OF_ASC_NODE: raan, ARG_OF_PERICENTER: argp, MEAN_ANOMALY: ma, BTERM: bterm, AGOM: agom });
  const weather = records || msis;
  t.PERTURBATIONS = Object.assign(new PerturbationsT(), { ATMOSPHERIC_MODEL: new ATMT(msis ? AtmosphericModelFamily.NRLMSIS00E : AtmosphericModelFamily.JXX, msis ? 2000 : 1970),
    GRAVITY_MODEL: tesseral > 0 || zonal > 0 ? "EGM2008" : "EGM-96", MAXIMUM_TESSERAL_DEGREE: tesseral, MAXIMUM_ZONAL_DEGREE: zonal,
    WEATHER_SOURCE: weather ? pcfWeatherSource.RECORDS : pcfWeatherSource.THEORY_FLUX_MODEL, SPACE_WEATHER: weather ? rows : [] });
  if (solidTides) t.PERTURBATIONS.SOLID_TIDES_MODEL = "IERS 2010";
  if (slow) t.PERTURBATIONS.GRAVITY_MODEL = "EGM2008; slow tesseral terms to degree 70";
  if (dca) Object.assign(t.PERTURBATIONS, { DENSITY_CORRECTION: 1, DENSITY_CORRECTION_CID: dca.cid ?? "bafkreitestnodes",
    DENSITY_CORRECTION_NODE_TIMES_MS: dca.ms.map(BigInt), DENSITY_CORRECTION_LOG_DENSITY_SCALE_DIMENSIONLESS: dca.s });
  const b = new flatbuffers.Builder(8192);
  OCM.finishOCMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}

/// $SPW rows (SPWT, the five fields an $OCM carries) of `objects` (plain row objects), and, when `through` (an ISO
/// date) is past their last, the last row repeated on every later day: the same drivers the 0.4 store held past it.
export function rowsThrough(objects, through = null) {
  const pick = (r, date = r.DATE) => Object.assign(new SPWT(), { DATE: date, F107_OBS: r.F107_OBS, F107_OBS_CENTER81: r.F107_OBS_CENTER81, AP_AVG: r.AP_AVG, F107_DATA_TYPE: r.F107_DATA_TYPE ?? 0 });
  const out = objects.map((r) => pick(r));
  if (through) for (let d = Date.parse(`${out.at(-1).DATE}T00:00:00Z`) + 86400000; new Date(d).toISOString().slice(0, 10) <= through; d += 86400000) out.push(pick(objects.at(-1), new Date(d).toISOString().slice(0, 10)));
  return out;
}

/// $SPW rows end to end, size-prefixed (a 'space_weather' frame of fit).
export function spwStream(rows) {
  return Buffer.concat(rows.map((r) => { const b = new flatbuffers.Builder(256); SPW.finishSizePrefixedSPWBuffer(b, r.pack(b)); return b.asUint8Array(); }));
}

/// The fit's figures an E2E reads from the record: the elements, FIT_STATISTICS and the OD COMMENT; under LOG_NORMAL the
/// posterior sigma of ln BTERM is sigma_B / B of the covariance (the delta method the fit writes it by).
export function fittedOf(bytes) {
  const o = ocmOf(bytes), me = o.MEAN_ELEMENTS, st = o.ORBIT_DETERMINATION?.FIT_STATISTICS;
  const kinds = o.COV_PARAMETER_KINDS ?? [], N = o.COV_SIZE;
  const diagonal = (kind) => { const at = 6 + kinds.indexOf(kind); return kinds.includes(kind) ? o.COVARIANCE_DATA[(at * (at + 1)) / 2 + at] : NaN; };
  return { epoch: me.EPOCH, n: me.MEAN_MOTION, e: me.ECCENTRICITY, bterm: me.BTERM, agom: me.AGOM, theory: me.MEAN_ELEMENT_THEORY, N,
    comment: (o.ORBIT_DETERMINATION?.COMMENT ?? []).join("; "), wrms: st?.FIT_RMS_KM, accepted: st?.FIT_STATES,
    sigmaLog: Math.sqrt(diagonal(1)) / me.BTERM, agomSigma: Math.sqrt(diagonal(3)) };
}

/// A 0.4 build (its embedded manifest has no export_omm): the E2Es whose registered baseline is a 0.4 release drive it as
/// it was ($OMM, FORCES at flight, $SPW frames), this build on $OCM.
export const legacyBuild = (file) => !fs.readFileSync(file).includes("export_omm");

/// $SPW rows of a 'space_weather' frame (size-prefixed records end to end) and the same rows with a day the source lacks
/// taking the row before it (the hold the experiments' XA and XM take, e2865b1) and the last one held on every day
/// through `through` (ISO date): the drivers a 0.4 build held past its rows, as rows a record carries (one per UTC day).
export function heldRows(bytes, through) {
  const rows = [];
  for (let at = 0; at + 4 <= bytes.length;) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
    const row = SPW.getSizePrefixedRootAsSPW(new flatbuffers.ByteBuffer(bytes.subarray(at, at + 4 + len))).unpack();
    for (let d = rows.length ? Date.parse(`${rows.at(-1).DATE}T00:00:00Z`) + 86400000 : Infinity; d < Date.parse(`${row.DATE}T00:00:00Z`); d += 86400000)
      rows.push({ ...rows.at(-1), DATE: new Date(d).toISOString().slice(0, 10) });
    rows.push(row);
    at += 4 + len;
  }
  return spwStream(rowsThrough(rows, through));
}

/// This build through the SDK's isomorphic harness with the interface the archive replays call (the vendored
/// experiments' openAp: fit(oem, pcf, extra), propagate(set, grid, pcf, extra, count)), on $OCM: fit's $PCF as the replay
/// gives it (0.4 FORCES: ENABLE_DRAG selects NRLMSISE-00, rows otherwise Jacchia 1970 on them) written as this build's
/// fit FORCES; its rows held past their last day through the 30-day horizon the record carries (as the 0.4 builds held
/// them); the flight the $OCM alone, its output times and axes the grid template's as $PCF OUTPUT.
export async function openApOcm(file) {
  const { createStandaloneHarness } = await import("space-data-module-sdk/testing/isomorphic");
  const { PCF } = await import("spacedatastandards.org/lib/js/PCF/PCF.js");
  const { PCFForceModelT } = await import("spacedatastandards.org/lib/js/PCF/PCFForceModel.js");
  const { pcfAtmosphereFamily } = await import("spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js");
  const { OEM } = await import("spacedatastandards.org/lib/js/OEM/OEM.js");
  const h = await createStandaloneHarness("browser", file, { surface: "direct" });
  const oemOf = (bytes) => { const u = new Uint8Array(bytes); const p = String.fromCharCode(...u.slice(8, 12)) === "$OEM";
    return (p ? OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(u)) : OEM.getRootAsOEM(new flatbuffers.ByteBuffer(u))).unpack(); };
  const fitPcf = (bytes, rows) => {
    const c = PCF.getRootAsPCF(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack();
    const f = c.FORCES ?? Object.assign(new PCFForceModelT(), { EPHEMERIS_SOURCE: "" });
    const msis = !!f.ENABLE_DRAG;
    f.ENABLE_DRAG = false;
    f.ATMOSPHERE_MODEL = msis ? pcfAtmosphereFamily.NRLMSISE00 : pcfAtmosphereFamily.JACCHIA70;
    f.WEATHER_SOURCE = msis || rows ? pcfWeatherSource.RECORDS : pcfWeatherSource.UNSPECIFIED;
    f.WEATHER_EXTENSION = 0;
    c.FORCES = f;
    c.OUTPUT = null;
    if (c.THEORY === 2 && (msis || rows || f.HAS_MAXIMUM_TESSERAL_DEGREE || f.HAS_MAXIMUM_DEGREE)) c.THEORY = 0;
    const b = new flatbuffers.Builder(1024);
    b.finish(c.pack(b), "$PCF");
    return b.asUint8Array().slice();
  };
  const T2 = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });
  return {
    async fit(oem, pcf, extra) {
      const lines = oemOf(oem).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
      const last = Date.parse(`${lines.at(-1).EPOCH.slice(0, 10)}T00:00:00Z`);
      const rows = extra?.rows ? heldRows(new Uint8Array(extra.rows), new Date(last + 32 * 86400000).toISOString().slice(0, 10)) : null;
      const inputs = [{ portId: "ephemeris", typeRef: T2("OEM"), payload: oem }, { portId: "configuration", typeRef: T2("PCF"), payload: fitPcf(pcf, rows) },
        ...(rows ? [{ portId: "space_weather", typeRef: T2("SPW"), payload: new Uint8Array(rows) }] : [])];
      let r;
      try { r = await h.invoke({ methodId: "fit", inputs }); } catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 240) }; }
      if (r.statusCode !== 0) return { ok: false, error: `${r.errorCode}: ${String(r.errorMessage).slice(0, 200)}` };
      return { ok: true, omm: new Uint8Array(r.outputs.find((o) => o.portId === "elements").payload), obd: null };
    },
    async propagate(set, grid, pcf, extra, count) {
      const blk = oemOf(grid).EPHEMERIS_DATA_BLOCK[0];
      const frame = { TEME: 1, TEMEOFDATE: 1, GCRF: 2, ICRF: 2, EME2000: 3, J2000: 3 }[String(blk.REFERENCE_FRAME?.NAME ?? "TEME").toUpperCase()] ?? 1;
      const output = (blk.EPHEMERIS_DATA_LINES ?? []).length ? { EPOCHS: blk.EPHEMERIS_DATA_LINES.map((l) => l.EPOCH), FRAME: frame }
        : { START_TIME: blk.START_TIME, STOP_TIME: blk.STOP_TIME, STEP_SECONDS: blk.STEP_SIZE || 60, FRAME: frame };
      const r = await h.invoke({ methodId: "propagate", inputs: flight([set], { output }) });
      if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode}: ${String(r.errorMessage).slice(0, 200)}`);
      const lines = oemOf(r.outputs.find((o) => o.portId === "ephemeris").payload).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.map((l) => ({ epoch: l.EPOCH, r: [l.X, l.Y, l.Z], v: [l.X_DOT, l.Y_DOT, l.Z_DOT] }));
      if (lines.length !== count) throw new Error(`propagate returned ${lines.length} of ${count} states`);
      return lines;
    },
  };
}

/// A fitted set's figures as the vendored readFitOmm gives an $OMM's: the elements, the fit RMS, the OD COMMENT.
export function readFitOcm(bytes) {
  const f = fittedOf(bytes);
  return { u: { COMMENT: f.comment }, epoch: f.epoch, bterm: f.bterm, agom: f.agom, fitRmsKm: f.wrms, states: f.accepted, sigmaLnB: f.sigmaLog };
}

/// The record with its process noise set to `noise` (s_e, s_i, s_l, s_d, the start t_a: COV_PROPAGATION's NOISE_*), the
/// share c restated so the record keeps its invariant s_d = c |rate| n (a rate of 0 is restated as 1 / n): a calibration's
/// probe of the propagated covariance under each size alone.
export function withNoise(bytes, [se, si, sl, sd, ta]) {
  return repackOcm(bytes, (t) => {
    const p = t.COV_PROPAGATION, n = t.MEAN_ELEMENTS.MEAN_MOTION * 2 * Math.PI;
    Object.assign(p, { NOISE_ECCENTRICITY_PER_DAY: se, NOISE_INCLINATION_PER_DAY: si, NOISE_MEAN_MOTION_RELATIVE: sl, NOISE_NON_GRAVITATIONAL_RAD_DAY2: sd, NOISE_START_MINUTES: ta });
    if (p.NON_GRAVITATIONAL_RATE_PER_DAY === 0 && sd !== 0) p.NON_GRAVITATIONAL_RATE_PER_DAY = 1 / n;
    p.NON_GRAVITATIONAL_SHARE = sd === 0 ? 0 : sd / (Math.abs(p.NON_GRAVITATIONAL_RATE_PER_DAY) * n);
  });
}

/// A fitted record's covariance model as the 0.4 USER_DEFINED_SDNAP_COV_* rows stated it: the noise (s_e, s_i, s_l,
/// s_d, t_a), the rate, the regime.
export function noiseOf(bytes) {
  const o = ocmOf(bytes), p = o.COV_PROPAGATION;
  return p ? { noise: [p.NOISE_ECCENTRICITY_PER_DAY, p.NOISE_INCLINATION_PER_DAY, p.NOISE_MEAN_MOTION_RELATIVE, p.NOISE_NON_GRAVITATIONAL_RAD_DAY2, p.NOISE_START_MINUTES],
    ngRate: p.NON_GRAVITATIONAL_RATE_PER_DAY, regime: o.COV_REALISM?.[0]?.REGIME, nDay: o.MEAN_ELEMENTS.MEAN_MOTION * 2 * Math.PI } : null;
}
