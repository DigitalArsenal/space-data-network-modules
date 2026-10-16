// The input files GMAT reads for the HPOP reference cases, written from the
// tool-neutral case export (../cases/hpop-reference-cases.json) and the
// coefficients HPOP embeds. Representation only: every number is copied.
//
//   writeCof(out, field, export)   a gravity field as GMAT .cof (POTFIELD,
//                                  RECOEF n m C S, fully normalized)
//   writeEopC04(out, rows, gmatRoot, offsets)
//                                  IERS C04 ("old format") EOP rows
//   writeCssi(out)                 the synthetic CSSI space weather file the
//                                  W1 cases were built from
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../..');

// Fixed columns of 15 significant digits, as GMAT's own EGM96.cof; every
// embedded coefficient has at most 15, which is checked.
const e15 = (v, exact = true) => {
  const text = `${v < 0 ? '-' : ' '}${Math.abs(v).toExponential(14).toUpperCase().replace(/E([+-])(\d)$/, 'E$10$2')}`;
  if (exact && Number(text) !== v) throw new Error(`${v} does not fit 15 digits`);
  return text;
};

// `field` is a case's forces.gravityField: model (EGM2008 | EGM96), degree,
// order and, if set, tesseralDegree (terms of order >= 1 kept only up to that
// degree; the rest are written as zero, which is the same truncated model).
// `add` ({'n,m': [dC, dS]}) adds fixed increments to named coefficients.
export function writeCof(out, field, cases, add = {}) {
  const header = path.join(repo, cases.models.gravityFields[field.model].path);
  const text = fs.readFileSync(header, 'utf8');
  const rows = [...text.matchAll(/\{\s*(\d+),\s*(\d+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\}/g)]
    .map((m) => ({ n: Number(m[1]), m: Number(m[2]), c: Number(m[3]), s: Number(m[4]) }))
    .filter((r) => r.n >= 2 && r.n <= field.degree && r.m <= field.order);
  const cut = field.tesseralDegree;
  const gm = cases.constants.earthGmM3S2, radius = field.radiusM;
  fs.writeFileSync(out, [
    'COMMENT   1', `CCCCC  ${field.model} to ${field.degree}x${field.order}${cut !== undefined ? ` (order >= 1 to degree ${cut})` : ''} as embedded in HPOP (${cases.models.gravityFields[field.model].path}), tide-free`,
    `POTFIELD${String(field.degree).padStart(3)}${String(field.order).padStart(3)}  1 ${gm.toExponential(14).toUpperCase()} ${radius.toExponential(14).toUpperCase()} 1.00000000000000E+00`.replace(/E\+(\d)\b/g, 'E+0$1'),
    ...rows.map((r) => {
      const zero = cut !== undefined && r.m >= 1 && r.n > cut;
      const [dc, ds] = add[`${r.n},${r.m}`] ?? [0, 0];
      const exact = !add[`${r.n},${r.m}`];
      return `RECOEF${String(r.n).padStart(5)}${String(r.m).padStart(3)}   ${e15(zero ? 0 : r.c + dc, exact)}${r.m > 0 ? e15(zero ? 0 : r.s + ds, exact) : ''}`;
    }),
    'END  ', '',
  ].join('\r\n'));
  return { path: out, coefficients: rows.length };
}

// IERS C04 layout, as GMAT's eopc04_08.62-now: year month day MJD x y (")
// UT1-UTC LOD (s) dPsi dEps (") and their errors. GMAT's own header is kept;
// the data rows are the case export's. `offsets(mjd)` gives the dPsi, dEps
// columns (arcsec); without it they are zero.
export function writeEopC04(out, rows, gmatRoot, offsets) {
  const civil = (mjd) => { const d = new Date((mjd - 40587) * 86400000); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };
  const lines = rows.map((r) => {
    const [y, mo, d] = civil(r.mjd);
    const [dPsi, dEps] = offsets ? offsets(r.mjd) : [0, 0];
    return `${String(y).padStart(4)}${String(mo).padStart(4)}${String(d).padStart(4)}${String(r.mjd).padStart(7)}${r.xPoleArcsec.toFixed(6).padStart(11)}${r.yPoleArcsec.toFixed(6).padStart(11)}`
      + `${r.ut1MinusUtcS.toFixed(7).padStart(12)}${(r.lodMs / 1000).toFixed(7).padStart(12)}${dPsi.toFixed(6).padStart(11)}${dEps.toFixed(6).padStart(11)}`
      + '   0.000000   0.000000  0.0000000  0.0000000    0.000000    0.000000';
  });
  const original = fs.readFileSync(path.join(gmatRoot, 'data/planetary_coeff/eopc04_08.62-now'), 'latin1').split('\n');
  const firstData = original.findIndex((l) => /^\s*\d{4}\s+\d+\s+\d+\s+\d{5}\s/.test(l));
  fs.writeFileSync(out, `${[...original.slice(0, firstData), ...lines].join('\n')}\n`);
  return out;
}

// The synthetic CSSI file the Orekit W1 cases read: the fixture generator is
// deterministic (seeded), and its rows are checked against the case export's.
//
// layout 'published' keeps the file as Orekit read it (rows from 2026-08-01 in
// the DAILY_PREDICTED block); 'observed' moves those rows, unchanged, into the
// OBSERVED block. GMAT reads the two blocks by its own conventions
// (SolarFluxReader: F10.7 taken as measured at 20 h UT and interpolated in
// time; for daily-predicted rows the current day's record is looked up at
// epoch - 1 day); run-gmat.mjs --cssi constant gives GMAT the drivers HPOP and
// Orekit read from these rows instead.
export function writeCssi(dir, cases, layout = 'published') {
  execFileSync(process.execPath, [path.join(repo, 'propagator/hpop/tests/fixtures/orekit/make-synthetic-weather.mjs'), dir], { stdio: 'ignore' });
  let file = path.join(dir, 'CSSI-Space-Weather-Data/SpaceWeather-All-v1.2.txt');
  let text = fs.readFileSync(file, 'utf8');
  const lineOf = (iso) => { const [y, m, d] = iso.split('-'); return text.split('\n').find((l) => l.startsWith(`${y} ${m} ${d} `)); };
  for (const row of cases.spaceWeather.cssi.rows) {
    const line = lineOf(row.DATE);
    if (!line) throw new Error(`CSSI row ${row.DATE} missing`);
    const f = line.trim().split(/\s+/).map(Number);
    if (f[14] !== row.AP1 || f[22] !== row.AP_AVG || f[26] !== row.F107_ADJ || f[30] !== row.F107_OBS || f[31] !== row.F107_OBS_CENTER81)
      throw new Error(`CSSI row ${row.DATE} differs from the case export`);
  }
  if (layout === 'observed') {
    const block = (name) => text.match(new RegExp(`BEGIN ${name}\\n([\\s\\S]*?)END ${name}\\n`))[1];
    const rows = block('OBSERVED') + block('DAILY_PREDICTED');
    text = text.replace(/NUM_OBSERVED_POINTS \d+\nBEGIN OBSERVED\n[\s\S]*?END OBSERVED\n/, `NUM_OBSERVED_POINTS ${rows.trim().split('\n').length}\nBEGIN OBSERVED\n${rows}END OBSERVED\n`)
      .replace(/NUM_DAILY_PREDICTED_POINTS \d+\nBEGIN DAILY_PREDICTED\n[\s\S]*?END DAILY_PREDICTED\n/, 'NUM_DAILY_PREDICTED_POINTS 0\nBEGIN DAILY_PREDICTED\nEND DAILY_PREDICTED\n');
    file = path.join(dir, `SpaceWeather-All-v1.2-${layout}.txt`);
    fs.writeFileSync(file, text);
  } else if (layout !== 'published') throw new Error(`CSSI layout ${layout}`);
  return file;
}
