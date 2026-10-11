// Two-line element text, for the tests only: the module formats its own. A battery of valid sets for SGP4 (type 0)
// and SGP4-XP (type 4), a reader of the text into $OMM fields, and the Space Force library's own JavaScript runtime
// as the reference the module's numbers are compared with.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const ussfDir = fileURLToPath(new URL('../../third_party/ussf-sgp4/', import.meta.url));

export const checksum = (line) => {
  let sum = 0;
  for (let i = 0; i < 68; i += 1) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += Number(c);
    else if (c === '-') sum += 1;
  }
  return line.slice(0, 68) + (sum % 10);
};

// ±NNNNN±E, value 0.NNNNN x 10^E
export function exponentField(value) {
  if (value === 0) return ' 00000-0';
  const sign = value < 0 ? '-' : ' ';
  const a = Math.abs(value);
  let e = Math.floor(Math.log10(a)) + 1;
  let m = Math.round((a / 10 ** e) * 1e5);
  if (m >= 100000) { m = Math.round(m / 10); e += 1; }
  return `${sign}${String(m).padStart(5, '0')}${e < 0 ? '-' : '+'}${Math.abs(e)}`;
}
const readExponent = (f) => (f[0] === '-' ? -1 : 1) * (Number(f.slice(1, 6)) * 1e-5) * 10 ** ((f[6] === '-' ? -1 : 1) * Number(f[7]));

export function tleLines({ satnum = 99999, year = 24, day = 100.5, ndot = 0, second = 0, drag = 0, type = 0, inc, raan, ecc, argp, ma, mm, rev = 100 }) {
  const f = (x, w, d) => x.toFixed(d).padStart(w, ' ');
  const ndotText = (ndot < 0 ? '-' : ' ') + Math.abs(ndot).toFixed(8).replace(/^0/, '');
  const l1 = `1 ${String(satnum).padStart(5, '0')}U 00001A   ${String(year).padStart(2, '0')}${day.toFixed(8).padStart(12, '0')} ${ndotText} ${exponentField(second)} ${exponentField(drag)} ${type}  999`;
  const l2 = `2 ${String(satnum).padStart(5, '0')} ${f(inc, 8, 4)} ${f(raan, 8, 4)} ${ecc.toFixed(7).slice(2).padStart(7, '0')} ${f(argp, 8, 4)} ${f(ma, 8, 4)} ${f(mm, 11, 8)}${String(rev).padStart(5, ' ')}`;
  return [checksum(l1), checksum(l2)];
}

/** The $OMM fields (for ommBytes) of a set of lines. */
export function omm(lines, extra = {}) {
  const [l1, l2] = lines;
  const year = Number(l1.slice(18, 20));
  const day = Number(l1.slice(20, 32));
  const dayNumber = Math.floor(day);
  const ms = Date.UTC(year < 57 ? 2000 + year : 1900 + year, 0, 1) + (dayNumber - 1) * 86400000;
  const fraction = Math.round((day - dayNumber) * 1e8); // eight decimals of a day
  const seconds = (fraction * 864e-6);
  const base = new Date(ms).toISOString().slice(0, 10);
  const whole = Math.floor(seconds);
  const hh = String(Math.floor(whole / 3600)).padStart(2, '0'), mm = String(Math.floor((whole % 3600) / 60)).padStart(2, '0'), ss = String(whole % 60).padStart(2, '0');
  const micro = String(Math.round((seconds - whole) * 1e6)).padStart(6, '0');
  const type = Number(l1[62]);
  const out = {
    epoch: `${base}T${hh}:${mm}:${ss}.${micro}`, theory: type === 4 ? 'SGP4XP' : 'SGP4',
    inclination: Number(l2.slice(8, 16)), raan: Number(l2.slice(17, 25)), eccentricity: Number(`0.${l2.slice(26, 33)}`), argPerigee: Number(l2.slice(34, 42)),
    meanAnomaly: Number(l2.slice(43, 51)), meanMotion: Number(l2.slice(52, 63)), rev: Number(l2.slice(63, 68)), norad: Number(l1.slice(2, 7)),
    ...(type === 4 ? { bterm: readExponent(l1.slice(53, 61)), agom: readExponent(l1.slice(44, 52)) }
      : { bstar: readExponent(l1.slice(53, 61)), meanMotionDot: Number(l1.slice(33, 43)), meanMotionDdot: readExponent(l1.slice(44, 52)) }),
    ...extra,
  };
  return out;
}

function random(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
/** `count` valid sets cycling LEO, sun-synchronous, MEO, GEO and HEO orbits, alternately SGP4 and SGP4-XP. */
export function battery(count, seed = 1234) {
  const r = random(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const kind = i % 5;
    let mm, ecc, inc;
    if (kind === 0) { mm = 15.0 + r(); ecc = r() * 0.02; inc = 20 + r() * 80; }
    else if (kind === 1) { mm = 14.2 + r() * 1.2; ecc = r() * 0.005; inc = 96 + r() * 3; }
    else if (kind === 2) { mm = 1.8 + r() * 0.5; ecc = r() * 0.02; inc = 50 + r() * 10; }
    else if (kind === 3) { mm = 1.0027 + (r() - 0.5) * 0.002; ecc = r() * 0.003; inc = r() * 15; }
    else { mm = 2.0 + r(); ecc = 0.5 + r() * 0.25; inc = 60 + r() * 5; }
    const type = i % 2 === 0 ? 0 : 4;
    const low = kind <= 1;
    const lines = tleLines({
      satnum: 10000 + i, year: 24, day: 100.5 + r() * 100, ndot: type === 0 ? r() * 1e-4 : 0, second: type === 4 ? r() * 0.03 : 0,
      drag: low ? (type === 0 ? r() * 4e-4 : r() * 0.02) : (type === 0 ? r() * 1e-5 : r() * 0.001), type,
      inc, raan: r() * 360, ecc, argp: r() * 360, ma: r() * 360, mm, rev: Math.floor(r() * 90000),
    });
    out.push({ index: i, kind, type, lines });
  }
  return out;
}

/** The Space Force library through its own Emscripten JavaScript runtime: the reference. */
export async function referenceLibrary() {
  const glue = path.join(ussfDir, 'Sgp4Prop.xp.js');
  const M = require(glue);
  M.print = () => {};
  M.printErr = () => {};
  if (!M.calledRun) await new Promise((resolve) => { M.onRuntimeInitialized = resolve; });
  const text = (s) => { const b = new TextEncoder().encode(s); const p = M._malloc(b.length + 1); M.HEAPU8.set(b, p); M.HEAPU8[p + b.length] = 0; return p; };
  return {
    /** States {error, minutes, r[3], v[3]} of a set at times given in minutes from its epoch, or null when the library refuses it. */
    propagate(lines, minutes) {
      const p1 = text(lines[0]), p2 = text(lines[1]);
      const key = M._TleAddSatFrLines_wasm(p1, p2);
      M._free(p1); M._free(p2);
      if (key < 0n) return null;
      const keyPtr = M._malloc(8), errPtr = M._malloc(8), out = M._malloc(64 * minutes.length);
      M.HEAP64[keyPtr >> 3] = BigInt(key);
      M.HEAP64[errPtr >> 3] = 0n;
      if (M._Sgp4InitSats_wasm(keyPtr, 1, errPtr) !== 0) { M._TleRemoveSats_wasm(keyPtr, 1, errPtr); return null; }
      minutes.forEach((t, i) => M._Sgp4PropPosVel_wasm(keyPtr, 1, t, 1, 1.0, out + 64 * i));
      const raw = new Float64Array(M.HEAPU8.buffer.slice(out, out + 64 * minutes.length));
      M._Sgp4RemoveSats_wasm(keyPtr, 1, errPtr);
      M._TleRemoveSats_wasm(keyPtr, 1, errPtr);
      M._free(keyPtr); M._free(errPtr); M._free(out);
      return minutes.map((t, i) => ({ error: raw[8 * i], minutes: raw[8 * i + 1], r: Array.from(raw.subarray(8 * i + 2, 8 * i + 5)), v: Array.from(raw.subarray(8 * i + 5, 8 * i + 8)) }));
    },
  };
}
