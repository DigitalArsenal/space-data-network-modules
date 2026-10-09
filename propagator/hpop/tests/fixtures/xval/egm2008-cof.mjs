// HPOP's embedded EGM2008 field (lib/egm2008_data.h) to degree 20 as a
// GMAT-format .cof file (POTFIELD header, RECOEF n m C S, fully normalized),
// the format GMAT and Nyx both read. The same numbers ../orekit/make-gfc.mjs
// gave Orekit. Representation only.
import fs from 'node:fs';

// Fixed columns of 15 significant digits, as GMAT's own EGM96.cof (C
// right-aligned in 24, S in 21); every embedded coefficient has at most 15,
// which is checked.
const e = (v) => {
  const text = `${v < 0 ? '-' : ' '}${Math.abs(v).toExponential(14).toUpperCase().replace(/E([+-])(\d)$/, 'E$10$2')}`;
  if (Number(text) !== v) throw new Error(`${v} does not fit 15 digits`);
  return text;
};

export function writeEgm2008Cof(out, { gm, fieldRadiusM }) {
  const header = fs.readFileSync(new URL('../../../lib/egm2008_data.h', import.meta.url), 'utf8');
  const coefficients = [...header.matchAll(/\{\s*(\d+),\s*(\d+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\}/g)]
    .map((m) => ({ n: Number(m[1]), m: Number(m[2]), c: Number(m[3]), s: Number(m[4]) })).filter((r) => r.n <= 20 && r.n >= 2);
  fs.writeFileSync(out, [
    'COMMENT   1', 'CCCCC  EGM2008 to 20x20 as embedded in HPOP (lib/egm2008_data.h), tide-free',
    `POTFIELD 20 20  1 ${gm.toExponential(14).toUpperCase()} ${fieldRadiusM.toExponential(14).toUpperCase()} 1.00000000000000E+00`.replace(/E\+(\d)\b/g, 'E+0$1'),
    ...coefficients.map((r) => `RECOEF${String(r.n).padStart(5)}${String(r.m).padStart(3)}   ${e(r.c)}${r.m > 0 ? e(r.s) : ''}`),
    'END  ', '',
  ].join('\r\n'));
}
