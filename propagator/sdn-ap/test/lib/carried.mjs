// The carried forecast (SPEC 18) for the tests: a forecast made by the module (a seeded set flown in GCRF at a fine
// step: smooth, and the module's own numbers), fitted with the forecast carried, and flown. JS only moves bytes and
// compares numbers the module produced.
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { pcfAtmosphereFamily } from "spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js";
import { wasmPath } from "./module.mjs";
import { configuration, XP_FORCES } from "./pcf.mjs";
import { T, seedOcm, flight } from "./ocm.mjs";
import { packOem, rfm } from "./frames.mjs";

export const MU = 398600.4418;
/** AP under a gravity cap on the theory's flux model (no rows): a TEMEOFEPOCH set. */
export const AP_TESS_FORCES = Object.freeze({ EPHEMERIS_SOURCE: "", ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 8 });
export const EPOCH = "2026-10-15T00:00:00.000";
const EPOCH_MS = Date.parse(`${EPOCH}Z`);
/** ISO text of `s` seconds after EPOCH, to the nanosecond. */
export function isoAt(s) {
  const whole = Math.floor(s), ns = Math.round((s - whole) * 1e9);
  const w = ns === 1e9 ? whole + 1 : whole;
  return `${new Date(EPOCH_MS + w * 1000).toISOString().slice(0, 19)}.${String(ns === 1e9 ? 0 : ns).padStart(9, "0")}`;
}
/** Mean motion (rev/day) of a semi-major axis (km), for seeding. */
export const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);

/**
 * The orbit classes of SPEC 18's bound: a, e, i and the step of the fit's states (s: at most 0.05 rad of arc, 30 s in
 * low orbit); `ap` flies AP under a gravity cap (TEMEOFEPOCH), otherwise stock SGP4XP (TEMEOFDATE); `days` the carried
 * span.
 */
export const CLASSES = Object.freeze([
  { name: "LEO 300 km", a: 6678.137, e: 0.0005, i: 51.6, step: 30, days: 1, ap: true },
  { name: "LEO 500 km", a: 6878.137, e: 0.001, i: 97.4, step: 30, days: 1, ap: false },
  { name: "LEO 830 km", a: 7208.137, e: 0.0012, i: 98.7, step: 30, days: 1, ap: true },
  { name: "LEO 1336 km", a: 7714.137, e: 0.0008, i: 66.04, step: 30, days: 1, ap: false },
  { name: "MEO", a: 26560, e: 0.005, i: 55, step: 120, days: 2, ap: true },
  { name: "GEO", a: 42164.2, e: 0.0002, i: 0.05, step: 120, days: 3, ap: true },
  { name: "IGSO", a: 42164.2, e: 0.075, i: 55, step: 120, days: 3, ap: false },
  { name: "GTO e 0.72", a: 6628.137 / 0.28, e: 0.72, i: 27, step: 30, days: 1, ap: false },
  { name: "Molniya", a: 26560, e: 0.74, i: 63.4, step: 30, days: 1, ap: false, argp: 270 },
  { name: "THEMIS-like", a: 40940, e: 1 - 7278.137 / 40940, i: 10, step: 30, days: 2, ap: false },
  { name: "TESS-like", a: 241800, e: 0.55, i: 37, step: 120, days: 14, ap: false },
  { name: "HEO e 0.9", a: 6878.137 / 0.1, e: 0.9, i: 63.4, step: 30, days: 2, ap: false, argp: 270 },
]);

/** A command harness on this build (or `file`). */
export const harness = (file = wasmPath) => createStandaloneHarness("browser", file, { surface: "command" });

/** One call: the outputs, or throws with the module's error. */
export async function call(h, methodId, inputs) {
  const r = await h.invoke({ methodId, inputs });
  if (r.statusCode !== 0) {
    const e = new Error(`${methodId}: ${r.errorCode}: ${r.errorMessage}`);
    e.code = r.errorCode;
    throw e;
  }
  return r.outputs;
}
/** One call's refusal code, or null when it ran. */
export async function refusal(h, methodId, inputs) {
  const r = await h.invoke({ methodId, inputs });
  return r.statusCode === 0 ? null : r.errorCode;
}

/**
 * SPEC 18.8: the runs a block's COMMENT states, "SOURCES: <source> <first>-<last> <first epoch> TO <last epoch>; ...",
 * as [{ source, first, last, from, to }], or null when the COMMENT states none. Throws on a COMMENT that starts
 * "SOURCES:" but does not follow the grammar.
 */
export function sourcesOf(comment) {
  if (!comment || !comment.startsWith("SOURCES: ")) return null;
  // SPEC 18.8: the runs, then after ". " the switches not blended (14.3)
  const end = comment.indexOf(". ");
  if (end >= 0 && !comment.slice(end + 2).startsWith("Not blended (SPEC 14.3): ")) throw new Error(`a SOURCES comment with a tail that does not parse: "${comment}"`);
  return comment.slice("SOURCES: ".length, end >= 0 ? end : comment.length).split("; ").map((run) => {
    const m = /^(CARRIED FORECAST|HAND-OVER|THEORY|BLEND) (\d+)-(\d+) (\S+) TO (\S+)$/.exec(run);
    if (!m) throw new Error(`a SOURCES run that does not parse: "${run}"`);
    return { source: m[1], first: Number(m[2]), last: Number(m[3]), from: m[4], to: m[5] };
  });
}
/** Every state of an $OEM in order, `source` beside it from its block's SOURCES COMMENT (null without one); the runs
 * checked against the lines: contiguous from 0 to the last, each run's epochs the lines' own. */
export const oemLines = (bytes) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack().EPHEMERIS_DATA_BLOCK
  .flatMap((b) => {
    const runs = sourcesOf(b.COMMENT), lines = b.EPHEMERIS_DATA_LINES;
    if (runs) {
      let next = 0;
      for (const r of runs) {
        if (r.first !== next || r.last < r.first || r.last >= lines.length || lines[r.first].EPOCH !== r.from || lines[r.last].EPOCH !== r.to)
          throw new Error(`a SOURCES run that does not match the lines: ${JSON.stringify(r)}`);
        next = r.last + 1;
      }
      if (next !== lines.length) throw new Error(`the SOURCES runs end at state ${next}, the block holds ${lines.length}`);
    }
    return lines.map((l, k) => Object.assign(l, { source: runs ? runs.find((r) => k >= r.first && k <= r.last).source : null }));
  });
export const ocmOf = (bytes) => OCM.getRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack();

/** The seed set of a class: stock SGP4XP or AP under a cap, at perigee at the epoch. */
export function seedOf(c) {
  return seedOcm({ epoch: EPOCH, n: revPerDay(c.a), e: c.e, i: c.i, raan: 40, argp: c.argp ?? 30, ma: 0, bterm: 0.002, agom: 0.01, norad: 99300,
    name: c.name, tesseral: c.ap ? 8 : 0 });
}

/** The states of `set` at seconds `times` from the epoch, in `frame` (pcfOutputFrame): [{ t, r, v }] (km, km/s). */
export async function fly(h, set, times, frame = pcfOutputFrame.GCRF) {
  const out = [];
  for (let k = 0; k < times.length; k += 50000) {
    const part = times.slice(k, k + 50000);
    const o = await call(h, "propagate", flight([set], { output: { EPOCHS: part.map(isoAt), FRAME: frame } }));
    oemLines(o.find((q) => q.portId === "ephemeris").payload).forEach((l, j) => out.push({ t: part[j], r: [l.X, l.Y, l.Z], v: [l.X_DOT, l.Y_DOT, l.Z_DOT], epoch: l.EPOCH, source: l.source }));
  }
  return out;
}

/** An $OEM block of states [{ t, r, v }] in `frame` (TEME or GCRF), the fit arc its first `fitHours`; `positionsOnly`
 * writes no velocity. */
export function forecastOem(states, fitHours, object = { norad: 99300, name: "CARRIED E2E" }, positionsOnly = false, frame = "TEME") {
  const lines = states.map((s) => Object.assign(new ephemerisDataLineT(), { EPOCH: isoAt(s.t), X: s.r[0], Y: s.r[1], Z: s.r[2],
    X_DOT: positionsOnly ? 0 : s.v[0], Y_DOT: positionsOnly ? 0 : s.v[1], Z_DOT: positionsOnly ? 0 : s.v[2] }));
  const last = states.findLast((s) => s.t <= fitHours * 3600) ?? states.at(-1);
  const block = Object.assign(new ephemerisDataBlockT(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: object.norad, OBJECT_NAME: object.name }), CENTER_NAME: "EARTH",
    REFERENCE_FRAME: rfm(frame), TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH,
    USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: isoAt(last.t), EPHEMERIS_DATA_LINES: lines });
  return packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
}

/** fit of `oem` under the class's forces, carrying START..STOP (seconds) when `carry` is given: the $OCM and $ODR. */
export async function fitCarried(h, c, oem, carry = null, more = {}) {
  const o = await call(h, "fit", [{ portId: "ephemeris", typeRef: T("OEM"), payload: oem },
    configuration({ theory: c.ap ? "AP" : "SGP4XP", forces: c.ap ? AP_TESS_FORCES : XP_FORCES, ...(carry ? { output: { START_TIME: isoAt(carry[0]), STOP_TIME: isoAt(carry[1]) } } : {}), ...more })]);
  return { ocm: new Uint8Array(o.find((q) => q.portId === "elements").payload), odr: new Uint8Array(o.find((q) => q.portId === "residuals").payload) };
}

/**
 * The forecast of class `c` and the record fitted to it. The forecast is the seed's states at `step` over `days` (an
 * analytic theory's velocity is not the derivative of its position: fit builds it from the positions, the 8-node
 * Lagrange path; `positionsOnly` leaves the velocities out of the block); `fine` the times between them (every `dense`
 * s, off the grid) the record is checked at.
 */
export async function carriedRecord(h, c, { dense = 10, fitHours = 12, positionsOnly = false, norad = 99300 } = {}) {
  const seed = seedOf(c);
  const span = c.days * 86400;
  // the block reaches 8 steps past each end of the carried span (an ephemeris longer than what is carried)
  // in TEME, the theory's own axes: its GCRF states carry the per-state matrix's rounding (about 1e-11 rad, 4 mm at
  // 376,000 km), which is not the forecast's
  const grid = Array.from({ length: Math.round(span / c.step) + 17 }, (_, k) => (k - 8) * c.step);
  const states = await fly(h, seed, grid, pcfOutputFrame.TEME);
  const oem = forecastOem(states, fitHours, { norad, name: c.name }, positionsOnly);
  const { ocm, odr } = await fitCarried(h, c, oem, [0, span]);
  const plain = (await fitCarried(h, c, oem)).ocm;
  const fine = Array.from({ length: Math.floor(span / dense) + 1 }, (_, k) => Math.min(span, k * dense + 0.5 * (k % 7) * 0.1));
  return { seed, oem, ocm, odr, plain, span, states, fine };
}

/**
 * The Hermite path: the record `ocm` flown at `step` (positions and velocities that agree, the series' own) as the
 * forecast of a second fit of class `c`; that record and the states.
 */
export async function hermiteRecord(h, c, ocm, span, step, fitHours = 12) {
  const grid = Array.from({ length: Math.round(span / step) + 1 }, (_, k) => k * step);
  const states = await fly(h, ocm, grid, pcfOutputFrame.TEME);
  const oem = forecastOem(states, fitHours);
  const inner = [8 * step, span - 8 * step];  // carried 8 steps inside the first record's span
  return { ocm: (await fitCarried(h, c, oem, inner)).ocm, states, inner };
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
