#!/usr/bin/env node
// GMAT R2022a reference trajectories for propagator/hpop.
//
// GMAT (NASA Goddard, Apache-2.0) propagates the cross-validation cases
// (../xval/xval-cases.json) from the Orekit file's initial GCRF states with
// the Orekit file's constants, and the GCRF states every hour for a day are
// written. HPOP's tests replay the same initial states; nothing in the test
// run regenerates this file.
//
//   node tests/fixtures/gmat/make-gmat-reference.mjs <GmatConsole> <work dir> <out.json> [only]
//
// Written into <work dir>:
//   - EGM2008-hpop.cof: the coefficients HPOP embeds (lib/egm2008_data.h, the
//     numbers ../orekit/make-gfc.mjs gave Orekit) in GMAT's .cof format, with
//     GM 3.986004415e14 m^3/s^2 and radius 6378136.3 m, tide model None;
//   - eop-2026-08.txt: GMAT's IERS C04-format EOP file with the pole and
//     UT1-UTC rows Orekit and HPOP read (../orekit/eop-2026-08.json). Its
//     nutation offset columns are zero: GMAT R2022a does not apply them
//     (changing them leaves the trajectories bit-identical; changing UT1-UTC
//     by 1 s moves LEO400 F3 by 2.4 m, so the rows are read);
//   - gmat_startup_file.txt: GMAT's own, every path absolute, that EOP file;
//   - one script per case; Sun and Moon from JPL DE440 (the repo's
//     de440-2026.bsp, GMAT's SPICE ephemeris source).
// Constants are the Orekit file's: Earth GM 398600.4415 km^3/s^2, Sun and
// Moon GM from the DE440 header (as Orekit reads lnxp1990.440), Sun radius
// 695 700 km, shadow-body radius 6378.137 km, 1361 W/m^2 at 1 au
// (149 597 870.7 km), mass 1000 kg, area 20 m^2, Cr 1.3, Cd 2.2, constant
// F10.7 = F10.7a = 150 and Kp 3 (GMAT takes Kp; Kp 3 is ap 15). Nutation is
// evaluated at every call (Earth.NutationUpdateInterval = 0; GMAT's default
// reuses it for 60 s). PrinceDormand78 at 1e-13, steps of at most 60 s:
// RungeKutta89 at 1e-14 / 30 s and PrinceDormand78 at 1e-13 / 10 s move GEO
// by less than 0.1 mm over the day.
//
// Axes. GMAT integrates in its MJ2000Eq axes, in which it also reads the
// SPICE (ICRF) ephemerides, and builds the Earth-fixed field from the
// IAU 1976/1980 (FK5) reduction without nutation offsets, whose pole is
// tens of mas from the CIP. Its "ICRF" axes are tied to the Earth-fixed
// frame by IAU 2000A instead, so a state given in ICRF axes is placed
// correctly relative to the field. That tie drifts relative to the
// integration axes by about 0.13 mas over the day (2.7 cm on GEO point
// mass when reported in ICRF axes). So the initial state is given in ICRF
// axes (field geometry right at the epoch), every sample is reported in
// MJ2000Eq axes as integrated, and those are rotated back to GCRF with the
// one, fixed rotation GMAT used at the epoch (from the epoch state reported
// in both axes). The drift is recorded per case ("icrfDriftM").
//
// Drag is Jacchia-Roberts: NRLMSISE-00 is a plugin the macOS R2022a build
// does not ship (MSISE90 and Jacchia-Roberts load). HPOP evaluates
// Jacchia-Roberts with GMAT's constants, so those cases compare like with
// like and HPOP is asked for JACCHIA_ROBERTS on them; they are not
// comparable with the NRLMSISE-00 drag of Orekit and Tudat.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeEgm2008Cof } from '../xval/egm2008-cof.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [gmat, work, out, only] = process.argv.slice(2);
if (!out) throw new Error('usage: make-gmat-reference.mjs <GmatConsole> <work dir> <out.json> [only]');
const gmatRoot = path.resolve(path.dirname(gmat), '..');
fs.mkdirSync(work, { recursive: true });

const OREKIT = JSON.parse(fs.readFileSync(path.join(here, '../orekit/orekit-reference.json'), 'utf8'));
const EOP = JSON.parse(fs.readFileSync(path.join(here, '../orekit/eop-2026-08.json'), 'utf8'));
const LIST = JSON.parse(fs.readFileSync(path.join(here, '../xval/xval-cases.json'), 'utf8')).cases;
const KERNEL = path.resolve(here, '../../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp');
const K = OREKIT.constants;
// DE440 header: GMS and GMB / (1 + EMRAT), au^3/day^2 to km^3/s^2.
const AU_KM = 149597870.7, AU3_DAY2 = AU_KM ** 3 / 86400 ** 2;
const GM_SUN = 2.9591220828411951e-04 * AU3_DAY2, GM_MOON = 8.9970116036316091e-10 * AU3_DAY2 / (1 + 81.3005682214972154);

writeEgm2008Cof(path.join(work, 'EGM2008-hpop.cof'), K);

// IERS C04 layout, as GMAT's eopc04_08.62-now: year month day MJD x y (")
// UT1-UTC LOD (s) dPsi dEps (") and their errors (dPsi, dEps unused).
const civil = (mjd) => { const d = new Date((mjd - 40587) * 86400000); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };
const eopLines = EOP.rows.map((r) => {
  const [y, mo, d] = civil(r.mjd);
  return `${String(y).padStart(4)}${String(mo).padStart(4)}${String(d).padStart(4)}${String(r.mjd).padStart(7)}${r.xPoleArcsec.toFixed(6).padStart(11)}${r.yPoleArcsec.toFixed(6).padStart(11)}`
    + `${r.ut1MinusUtcS.toFixed(7).padStart(12)}${(r.lodMs / 1000).toFixed(7).padStart(12)}${'0.000000'.padStart(11)}${'0.000000'.padStart(11)}`
    + '   0.000000   0.000000  0.0000000  0.0000000    0.000000    0.000000';
});
const originalEop = fs.readFileSync(path.join(gmatRoot, 'data/planetary_coeff/eopc04_08.62-now'), 'latin1').split('\n');
const firstData = originalEop.findIndex((l) => /^\s*\d{4}\s+\d+\s+\d+\s+\d{5}\s/.test(l));
fs.writeFileSync(path.join(work, 'eop-2026-08.txt'), `${[...originalEop.slice(0, firstData), ...eopLines].join('\n')}\n`);

// GMAT's startup file, every path absolute, the EOP file replaced.
const startup = fs.readFileSync(path.join(gmatRoot, 'bin/gmat_startup_file.txt'), 'utf8').split('\n').map((line) => {
  if (/^PLUGIN\s/.test(line)) return /libPythonInterface|libMatlabInterface|libOpenFrames/.test(line) ? `# ${line}` : line.replace('../', `${gmatRoot}/`);
  if (/^ROOT_PATH\s/.test(line)) return `ROOT_PATH                = ${gmatRoot}/`;
  if (/^OUTPUT_PATH\s/.test(line)) return `OUTPUT_PATH              = ${path.resolve(work)}/`;
  if (/^EOP_FILE\s/.test(line)) return `EOP_FILE                 = ${path.resolve(work, 'eop-2026-08.txt')}`;
  return line;
}).join('\n');
fs.writeFileSync(path.join(work, 'gmat_startup_file.txt'), startup);

const utcGregorian = (iso) => {
  const d = new Date(`${iso}Z`), months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${iso.slice(11, 23)}`;
};
const f = (v) => v.toPrecision(17);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(...a); return a.map((x) => x / n); };

function script(c, report) {
  const [, x, y, z, vx, vy, vz] = c.samples[0];
  const field = c.degree > 0;
  return `% ${c.orbit} ${c.forces} (make-gmat-reference.mjs)
GMAT SolarSystem.EphemerisSource = 'SPICE';
GMAT SolarSystem.SPKFilename = '${KERNEL}';
GMAT Earth.Mu = ${f(K.gm / 1e9)};
GMAT Earth.EquatorialRadius = ${(K.shadowRadiusM / 1000).toFixed(3)};
GMAT Earth.NutationUpdateInterval = 0;
GMAT Sun.Mu = ${f(GM_SUN)};
GMAT Sun.EquatorialRadius = 695700;
GMAT Luna.Mu = ${f(GM_MOON)};

Create Spacecraft Sat;
GMAT Sat.DateFormat = UTCGregorian;
GMAT Sat.Epoch = '${utcGregorian(OREKIT.epochUtc)}';
GMAT Sat.CoordinateSystem = EarthICRF;
GMAT Sat.DisplayStateType = Cartesian;
GMAT Sat.X = ${f(x / 1000)};
GMAT Sat.Y = ${f(y / 1000)};
GMAT Sat.Z = ${f(z / 1000)};
GMAT Sat.VX = ${f(vx / 1000)};
GMAT Sat.VY = ${f(vy / 1000)};
GMAT Sat.VZ = ${f(vz / 1000)};
GMAT Sat.DryMass = ${K.massKg};
GMAT Sat.Cd = ${K.cd};
GMAT Sat.Cr = ${K.cr};
GMAT Sat.DragArea = ${K.areaM2};
GMAT Sat.SRPArea = ${K.areaM2};

Create ForceModel FM;
GMAT FM.CentralBody = Earth;
${field ? `GMAT FM.PrimaryBodies = {Earth};
GMAT FM.GravityField.Earth.Degree = ${c.degree};
GMAT FM.GravityField.Earth.Order = ${c.order};
GMAT FM.GravityField.Earth.PotentialFile = '${path.resolve(work, 'EGM2008-hpop.cof')}';
GMAT FM.GravityField.Earth.TideModel = 'None';` : 'GMAT FM.PointMasses = {Earth};'}
${c.thirdBodies ? `GMAT FM.PointMasses = {${field ? '' : 'Earth, '}Sun, Luna};` : ''}
GMAT FM.SRP = ${c.srp ? 'On' : 'Off'};
${c.srp ? `GMAT FM.SRP.Flux = 1361;
GMAT FM.SRP.Nominal_Sun = ${AU_KM};
GMAT FM.SRP.SRPModel = Spherical;` : ''}
${c.drag ? `GMAT FM.Drag.AtmosphereModel = JacchiaRoberts;
GMAT FM.Drag.HistoricWeatherSource = 'ConstantFluxAndGeoMag';
GMAT FM.Drag.PredictedWeatherSource = 'ConstantFluxAndGeoMag';
GMAT FM.Drag.F107 = ${K.f107};
GMAT FM.Drag.F107A = ${K.f107a};
GMAT FM.Drag.MagneticIndex = 3;` : ''}
GMAT FM.RelativisticCorrection = Off;
GMAT FM.ErrorControl = RSSStep;

Create Propagator Prop;
GMAT Prop.FM = FM;
GMAT Prop.Type = PrinceDormand78;
GMAT Prop.InitialStepSize = 30;
GMAT Prop.Accuracy = 1e-13;
GMAT Prop.MinStep = 0;
GMAT Prop.MaxStep = 60;
GMAT Prop.MaxStepAttempts = 200;
GMAT Prop.StopIfAccuracyIsViolated = true;

Create ReportFile Out;
GMAT Out.Filename = '${path.resolve(report)}';
GMAT Out.Precision = 17;
GMAT Out.WriteHeaders = false;
GMAT Out.LeftJustify = On;
GMAT Out.ZeroFill = Off;
GMAT Out.ColumnWidth = 28;

Create Variable I;
BeginMissionSequence;
Report Out Sat.UTCModJulian Sat.EarthMJ2000Eq.X Sat.EarthMJ2000Eq.Y Sat.EarthMJ2000Eq.Z Sat.EarthMJ2000Eq.VX Sat.EarthMJ2000Eq.VY Sat.EarthMJ2000Eq.VZ Sat.EarthICRF.X Sat.EarthICRF.Y Sat.EarthICRF.Z Sat.EarthICRF.VX Sat.EarthICRF.VY Sat.EarthICRF.VZ;
For I = 1:24;
  Propagate Prop(Sat) {Sat.ElapsedSecs = 3600};
  Report Out Sat.UTCModJulian Sat.EarthMJ2000Eq.X Sat.EarthMJ2000Eq.Y Sat.EarthMJ2000Eq.Z Sat.EarthMJ2000Eq.VX Sat.EarthMJ2000Eq.VY Sat.EarthMJ2000Eq.VZ Sat.EarthICRF.X Sat.EarthICRF.Y Sat.EarthICRF.Z Sat.EarthICRF.VX Sat.EarthICRF.VY Sat.EarthICRF.VZ;
EndFor;
`;
}

const version = execFileSync(gmat, ['--version'], { cwd: path.dirname(gmat), encoding: 'utf8' }).match(/Build Date:[^\n]*/)?.[0] ?? 'unknown';
const cases = [];
for (const name of LIST) {
  if (only && !name.includes(only)) continue;
  const c = OREKIT.cases.find((x) => `${x.orbit} ${x.forces}` === name);
  const slug = name.replace(/\s+/g, '_');
  const report = path.join(work, `${slug}.txt`), file = path.join(work, `${slug}.script`);
  fs.rmSync(report, { force: true });
  fs.writeFileSync(file, script(c, report));
  execFileSync(gmat, ['--startup_file', path.join(work, 'gmat_startup_file.txt'), '--logfile', path.join(work, `${slug}.log`), '--verbose', 'off', '--run', file], { cwd: path.dirname(gmat), stdio: 'ignore' });
  const rows = fs.readFileSync(report, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  if (rows.length !== 25) throw new Error(`${name}: ${rows.length} report rows (see ${slug}.log)`);
  // The fixed rotation from GMAT's integration axes to GCRF at the epoch,
  // from the epoch state in both (orthonormal triads of r, v).
  const triad = (r, v) => { const e1 = unit(r), e3 = unit(cross(r, v)); return [e1, cross(e3, e1), e3]; };
  const [mj, icrf] = [triad(rows[0].slice(1, 4), rows[0].slice(4, 7)), triad(rows[0].slice(7, 10), rows[0].slice(10, 13))];
  const toGcrf = (v) => [0, 1, 2].map((i) => mj.reduce((s, e, k) => s + icrf[k][i] * dot(e, v), 0));
  let icrfDriftM = 0;
  // Sample epochs are whole UTC hours; GMAT's UTCModJulian is days from 1941-01-05 12:00 UTC.
  const samples = rows.map((r, i) => {
    const t = i * 3600, iso = c.samples[i][7];
    const gmatT = (r[0] - rows[0][0]) * 86400;
    if (Math.abs(gmatT - t) > 1e-4) throw new Error(`${name}: GMAT sample ${i} at ${gmatT} s, not ${t} s`);
    const p = toGcrf(r.slice(1, 4)), v = toGcrf(r.slice(4, 7));
    icrfDriftM = Math.max(icrfDriftM, 1000 * Math.hypot(p[0] - r[7], p[1] - r[8], p[2] - r[9]));
    return [t, ...p.map((x) => Number((x * 1000).toFixed(6))), ...v.map((x) => Number((x * 1000).toFixed(9))), iso];
  });
  cases.push({ orbit: c.orbit, forces: c.forces, degree: c.degree, order: c.order, thirdBodies: c.thirdBodies, srp: c.srp, drag: c.drag, ...(c.drag ? { atmosphere: 'JACCHIA_ROBERTS' } : {}), icrfDriftM: Number(icrfDriftM.toExponential(3)), samples });
  console.error(`${name} done`);
}
const doc = {
  source: `GMAT R2022a (NASA GSFC, Apache-2.0; GmatConsole, ${version}), PrinceDormand78 at 1e-13 (steps <= 60 s); state in ICRF axes at the epoch, samples from the MJ2000Eq integration axes by the epoch's fixed rotation; Earth orientation IAU 1976/1980 (FK5) with the pole and UT1-UTC of ../orekit/eop-2026-08.json; Sun and Moon from DE440 via SPICE; drag Jacchia-Roberts`,
  epochUtc: OREKIT.epochUtc,
  constants: { ...K, gmSunKm3S2: GM_SUN, gmMoonKm3S2: GM_MOON, sunRadiusKm: 695700, kp: 3 },
  cases,
};
fs.writeFileSync(out, `${JSON.stringify(doc, null, 1).replace(/\[\n\s+([^\[\]{}]*?)\n\s+\]/g, (m, body) => `[${body.replace(/\n\s+/g, ' ')}]`)}\n`);
