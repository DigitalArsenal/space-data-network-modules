// Two-line element text for the tests (the oracle reads text): writing a set,
// and reading its fields back into the module's element rows. Text handling
// only; no dynamics.

export const checksum = (line) => {
  let sum = 0;
  for (let i = 0; i < 68; i += 1) {
    const c = line[i];
    if (c >= "0" && c <= "9") sum += Number(c);
    else if (c === "-") sum += 1;
  }
  return line.slice(0, 68) + (sum % 10);
};

/** "±NNNNN±E": 0.NNNNN x 10^E. */
export function exponentField(value) {
  if (value === 0) return " 00000-0";
  const sign = value < 0 ? "-" : " ";
  const a = Math.abs(value);
  let e = Math.floor(Math.log10(a)) + 1;
  let m = Math.round((a / 10 ** e) * 1e5);
  if (m >= 100000) { m = Math.round(m / 10); e += 1; }
  return `${sign}${String(m).padStart(5, "0")}${e < 0 ? "-" : "+"}${Math.abs(e)}`;
}
const readExponent = (f) => (f[0] === "-" ? -1 : 1) * (Number(f.slice(1, 6)) * 1e-5) * 10 ** ((f[6] === "-" ? -1 : 1) * Number(f[7]));

/**
 * Lines of one set. Type 0: `ndot` (rev/day^2), `nddot` (rev/day^3), `bstar`.
 * Type 4 (SGP4-XP): AGOM in the second-derivative field, BTERM in the B* field.
 */
export function tleLines({ satnum = 99999, year = 24, day = 100.5, type = 0, ndot = 0, nddot = 0, bstar = 0,
  bterm = 0, agom = 0, inc, raan, ecc, argp, ma, mm, rev = 0 }) {
  const f = (x, w, d) => x.toFixed(d).padStart(w, " ");
  const first = type === 4 ? 0 : ndot;
  const second = type === 4 ? agom : nddot;
  const drag = type === 4 ? bterm : bstar;
  const ndotText = (first < 0 ? "-" : " ") + Math.abs(first).toFixed(8).replace(/^0/, "");
  const l1 = `1 ${String(satnum).padStart(5, "0")}U 00001A   ${String(year).padStart(2, "0")}${day.toFixed(8).padStart(12, "0")} ${ndotText} ${exponentField(second)} ${exponentField(drag)} ${type}  999`;
  const l2 = `2 ${String(satnum).padStart(5, "0")} ${f(inc, 8, 4)} ${f(raan, 8, 4)} ${ecc.toFixed(7).slice(2).padStart(7, "0")} ${f(argp, 8, 4)} ${f(ma, 8, 4)} ${f(mm, 11, 8)}${String(rev).padStart(5, " ")}`;
  return [checksum(l1), checksum(l2)];
}

/** Days from 1970-01-01 of a civil date. */
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The element row fields (test/lib/module.mjs elementRows) of a set's lines. */
export function elementsOf(lines) {
  const [l1, l2] = lines;
  const yy = Number(l1.slice(18, 20));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const dayText = l1.slice(20, 32).trim();
  const [whole, fraction = "0"] = dayText.split(".");
  const type = Number(l1[62]);
  const e = {
    norad: Number(l1.slice(2, 7)),
    theory: type === 4 ? 4 : 0,
    epochWhole: 2440587.5 + daysFromCivil(year, 1, 1) + (Number(whole) - 1),
    epochFrac: Number(`0.${fraction}`),
    inc: Number(l2.slice(8, 16)),
    raan: Number(l2.slice(17, 25)),
    ecc: Number(`0.${l2.slice(26, 33).trim()}`),
    argp: Number(l2.slice(34, 42)),
    ma: Number(l2.slice(43, 51)),
    meanMotion: Number(l2.slice(52, 63)),
  };
  if (type === 4) {
    e.bterm = readExponent(l1.slice(53, 61));
    e.agom = readExponent(l1.slice(44, 52));
  } else {
    e.bstar = readExponent(l1.slice(53, 61));
    e.ndot = Number(l1.slice(33, 43));
    e.nddot = readExponent(l1.slice(44, 52));
  }
  return e;
}
