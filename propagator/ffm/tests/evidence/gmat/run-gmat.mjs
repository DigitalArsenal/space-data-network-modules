#!/usr/bin/env node
// NASA GMAT (Apache-2.0) on the FFM reference cases: every case of
// ../cases/ffm-reference-cases.json whose forces GMAT models, from the same
// initial state, epoch, constants, Earth orientation rows, space weather,
// DE440 kernel and gravity coefficients, sampled every hour for 24 h, and
// (with --stm) the 6x6 orbit state-transition matrix at every sample.
//
//   node tests/evidence/gmat/run-gmat.mjs <GmatConsole> <work dir> <out.json>
//        [--only <substring>] [--stm] [--integrator RK89|PD78] [--accuracy 1e-14]
//        [--max-step 30] [--atmosphere NRLMSISE00|JacchiaRoberts]
//        [--tide Solid|SolidAndPole|SolidStep2] [--cssi constant|observed|published]
//        [--geodetic <s>] [--cd <Cd>] [--flattening <f>]
//
// --geodetic writes <case>.geo.txt beside each report: UTC MJD (GMAT's, from
// 1941-01-05 12 h), geodetic latitude, longitude (deg) and height (km) every
// <s> seconds (the propagation is then stopped at those instants too).
// --cd replaces the drag coefficient (a diagnostic of anomalous-oxygen.mjs);
// --flattening the Earth's (a diagnostic: GMAT's shadow does not use it).
// Integrator: RungeKutta89 at 1e-14, steps <= 30 s (variants.mjs measures the
// alternatives).
//
// GMAT is a test oracle only; nothing here ships. Written into <work dir>:
// the .cof fields, the C04 EOP file, the CSSI file, GMAT's startup file (every
// path absolute) and one script and report per case. <out.json> holds the
// samples (meters, m/s; GCRF, or EME2000 for the EME2000 cases), the STMs,
// GMAT's version, the SHA-256 of GmatConsole and of every input file, and
// every setting.
//
// Settings that match FFM (the case export's "forces" and "constants"):
//   - Earth GM 398600.4415 km^3/s^2; the field from FFM's embedded EGM2008
//     or EGM96 coefficients (gmat-files.mjs writeCof), tide-free; G2's 36x36
//     with the terms of order >= 1 above degree 24 written as zero; Earth
//     radius 6378.137 km and WGS84 flattening (shadow and geodetic heights).
//   - Sun and Moon from the case export's DE440 kernel through SPICE, read at
//     TDB, with the DE440 header GMs; Sun radius 695 700 km.
//   - Cannonball radiation pressure, 1361 W/m^2 at 1 au, conical shadow.
//   - Drag NRLMSISE-00 (R2026a ships it; --atmosphere JacchiaRoberts for
//     R2022a, whose macOS build has none) with constant F10.7 = F10.7a = 150
//     and Kp 3 (Ap 15). W1 (--cssi constant, the default): the drivers FFM
//     reads from the CSSI rows on the arc's day, which are constant over it,
//     given to GMAT as constants; --cssi published | observed let GMAT read the
//     synthetic CSSI file itself (gmat-files.mjs writeCssi says how it reads
//     it differently).
//   - Earth orientation: GMAT's IAU 1976/1980 (FK5) reduction with the case
//     export's pole and UT1-UTC rows. See "Axes" below.
//   - Solid tides (T1, IERS 2010 section 6.2 steps 1 and 2, no pole tide):
//     GMAT's 'Solid' model is step 1 alone (elastic k2m, k3m, k+); its
//     'SolidAndPole' adds step 2 (frequency-dependent k21, k20, k22) and the
//     solid and ocean pole tides. --tide SolidStep2 (the default) selects
//     'SolidAndPole' and subtracts GMAT's own pole-tide increments (IERS 2010
//     eqs. 6.22 and 6.23 with its linear mean pole, from the EOP pole at
//     mid-arc; they move by under 1e-12 over the day) from C21 and S21 of the
//     .cof, which leaves steps 1 and 2. Relativity: GMAT's
//     RelativisticCorrection (Schwarzschild, Lense-Thirring and de Sitter, the
//     IERS 2010 set of the R2 cases).
//   - In-track thrust (I1): a thruster on LVLH axes (x radial, z orbit normal,
//     y along-track: the S axis of QSW) with constant thrust a*m and no mass
//     decrement.
//   - Nutation evaluated at every call (Earth.NutationUpdateInterval = 0).
//
// Axes. GMAT integrates in MJ2000Eq axes, whose Earth-fixed frame is the FK5
// reduction; its ICRF axes are tied to the Earth-fixed frame by IAU 2006/2000A.
// So the initial state is given in ICRF axes (the field geometry is right at
// the epoch), every sample is reported in MJ2000Eq axes as integrated and in
// ICRF axes, and the MJ2000Eq samples are rotated to GCRF by the one fixed
// rotation GMAT used at the epoch. The ICRF-axes samples differ from those by
// the drift of the two reductions over the day ("icrfDriftM"). The EME2000
// cases are given and scored in EME2000: their state goes to GCRF by the IERS
// 2003 frame bias (a fixed rotation) and their samples come back by it.
//
// Not modeled by GMAT, so not run: Schwarzschild alone (R1), the drag-area
// rate (B1), JB2008 (J1), Knocke Earth radiation (A1), ocean tides (O1, O2) and
// the C1/C2 Jacobian cases that combine them; with Jacchia-Roberts, W1.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeCof, writeCssi, writeEopC04 } from './gmat-files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../..');
const { values: o, positionals } = parseArgs({
  options: {
    only: { type: 'string' }, stm: { type: 'boolean', default: false },
    integrator: { type: 'string', default: 'RK89' }, accuracy: { type: 'string', default: '1e-14' },
    'max-step': { type: 'string', default: '30' }, atmosphere: { type: 'string', default: 'NRLMSISE00' },
    tide: { type: 'string', default: 'SolidStep2' }, cssi: { type: 'string', default: 'constant' },
    'eop-offsets': { type: 'string' }, geodetic: { type: 'string' }, cd: { type: 'string' }, flattening: { type: 'string' },
  },
  allowPositionals: true,
});
const [gmat, workArg, out] = positionals;
if (!out) throw new Error('usage: run-gmat.mjs <GmatConsole> <work dir> <out.json> [--only s] [--stm] ...');
const work = path.resolve(workArg);
fs.mkdirSync(work, { recursive: true });
const gmatRoot = path.resolve(path.dirname(gmat), '..');
const CASES = JSON.parse(fs.readFileSync(path.join(here, '../cases/ffm-reference-cases.json'), 'utf8'));
const K = CASES.constants;
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const KERNEL = path.join(repo, CASES.models.ephemeris.path);
if (sha256(KERNEL) !== CASES.models.ephemeris.sha256) throw new Error('DE440 kernel differs from the case export');

// What GMAT models. Returns the reason a case is not run, or null.
function unsupported(c) {
  const f = c.forces;
  if (f.relativity === 'schwarzschild') return 'Schwarzschild alone: GMAT\'s RelativisticCorrection always adds Lense-Thirring and de Sitter';
  if (f.drag?.areaOverMassRateM2KgS) return 'drag-area rate: no GMAT equivalent';
  if (f.drag?.atmosphere === 'JB2008') return 'JB2008: not among GMAT\'s atmospheres';
  if (f.earthRadiation) return 'Knocke Earth radiation: not modeled by GMAT';
  if (f.oceanTides) return 'ocean tides: not modeled by GMAT';
  if (f.drag?.spaceWeather === 'cssi' && o.atmosphere === 'JacchiaRoberts')
    return 'Jacchia-Roberts on the CSSI rows: FFM reads the three-hourly Kp 6.7 h back, which constants cannot carry, and GMAT reads the rows by its own conventions';
  return null;
}

// ---- Shared input files ---------------------------------------------------
const files = {};
// GMAT's pole-tide increments to C21, S21 (HarmonicGravity::IncrementEarthTide):
// solid (IERS 2010 eq. 6.22) and ocean (eq. 6.23) pole tide on m1 = xp - xp_bar,
// m2 = -(yp - yp_bar) in arcsec, its mean pole xp_bar = 0.054 + 0.00083 t,
// yp_bar = 0.357 + 0.00395 t (t years of 365.25 days from J2000).
function gmatPoleTide(c) {
  const rows = CASES.earthOrientation[c.earthOrientation].rows;
  const mjd = Date.parse(`${c.epochUtc}Z`) / 86400000 + 40587 + 0.5;  // mid-arc, UTC
  const k = rows.findIndex((r) => r.mjd > mjd) - 1, w = mjd - rows[k].mjd;
  const xp = rows[k].xPoleArcsec * (1 - w) + rows[k + 1].xPoleArcsec * w, yp = rows[k].yPoleArcsec * (1 - w) + rows[k + 1].yPoleArcsec * w;
  const years = (mjd + 2400000.5 - 2451545.0) / 365.25;
  const m1 = xp - (0.054 + years * 0.00083), m2 = -(yp - (0.357 + years * 0.00395));
  return [-1.333e-9 * (m1 + 0.0115 * m2) - 2.2344e-10 * (m1 - 0.01737 * m2), -1.333e-9 * (m2 - 0.0115 * m1) - 1.7680e-10 * (m2 - 0.03351 * m1)];
}
const fieldFile = (field, c) => {
  const step2 = c.forces.solidTides && o.tide === 'SolidStep2';
  const key = `${field.model}-${field.degree}x${field.order}${field.tesseralDegree !== undefined ? `t${field.tesseralDegree}` : ''}${step2 ? `-no-pole-tide-${c.earthOrientation}` : ''}`;
  if (!files[key]) {
    const p = path.join(work, `${key}.cof`);
    const pole = step2 ? gmatPoleTide(c) : null;
    writeCof(p, field, CASES, pole ? { '2,1': [-pole[0], -pole[1]] } : {});
    if (pole) files[`${key}-increments`] = { path: p, poleTideC21: pole[0], poleTideS21: pole[1] };
    files[key] = { path: p, sha256: sha256(p) };
  }
  return files[key].path;
};
// dPsi, dEps columns: zero unless --eop-offsets <json {mjd: [dPsi", dEps"]}> is given.
const offsetTable = o['eop-offsets'] ? JSON.parse(fs.readFileSync(o['eop-offsets'], 'utf8')) : null;
const eopFile = (set) => {
  const key = `eop-${set}`;
  if (!files[key]) {
    const p = path.join(work, `${set}.c04.txt`);
    writeEopC04(p, CASES.earthOrientation[set].rows, gmatRoot, offsetTable ? (mjd) => offsetTable[mjd] : undefined);
    files[key] = { path: p, sha256: sha256(p) };
  }
  return files[key].path;
};
// W1 with --cssi constant: the drivers FFM and Orekit read from the CSSI rows
// through the arc's day d (tests: SpaceWeatherTable::at), given to GMAT as
// constants: F10.7 observed of d-1, the 81-day centered observed F10.7 of d,
// and Kp whose Ap in GMAT's table (AtmosphereModel::ConvertKpToAp) is the
// daily Ap of d. They hold from 0 h to 24 h; the arc's last instant (d+1 at
// 0 h) is the only one where FFM reads the next day's.
const GMAT_AP_OF_KP3 = [0, 2, 3, 4, 5, 6, 7, 9, 12, 15, 18, 22, 27, 32, 39, 48, 56, 67, 80, 94, 111, 132, 154, 179, 207, 236, 300, 400];
function cssiConstants(c) {
  const day = (k) => new Date(Date.parse(`${c.epochUtc.slice(0, 10)}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
  const rows = CASES.spaceWeather.cssi.rows, today = rows.find((r) => r.DATE === day(0)), yesterday = rows.find((r) => r.DATE === day(-1));
  const index = GMAT_AP_OF_KP3.indexOf(today.AP_AVG);
  if (index < 0) throw new Error(`daily Ap ${today.AP_AVG} is not in GMAT's Kp table`);
  return { f107: yesterday.F107_OBS, f107a: today.F107_OBS_CENTER81, kp: index / 3, ap: today.AP_AVG };
}
let cssiPath;
const cssiFile = () => {
  if (!cssiPath) { cssiPath = writeCssi(path.join(work, 'weather'), CASES, o.cssi); files.cssi = { path: cssiPath, sha256: sha256(cssiPath) }; }
  return cssiPath;
};

// GMAT's startup file with every path absolute, output into <work>, the
// Python/MATLAB/OpenFrames plugins left out, and the given EOP file.
const startupFiles = {};
function startupFile(eop) {
  if (startupFiles[eop]) return startupFiles[eop];
  const text = fs.readFileSync(path.join(gmatRoot, 'bin/gmat_startup_file.txt'), 'utf8').split('\n').map((line) => {
    if (/^PLUGIN\s/.test(line)) return /libPythonInterface|libMatlabInterface|libOpenFrames|libOVtoOFI|libExternalForceModel/.test(line) ? `# ${line}` : line.replace('../', `${gmatRoot}/`);
    if (/^ROOT_PATH\s/.test(line)) return `ROOT_PATH                = ${gmatRoot}/`;
    if (/^OUTPUT_PATH\s/.test(line)) return `OUTPUT_PATH              = ${work}/`;
    if (/^EOP_FILE\s/.test(line)) return `EOP_FILE                 = ${eop}`;
    return line;
  }).join('\n');
  const p = path.join(work, `gmat_startup_file.${path.basename(eop, '.txt')}.txt`);
  fs.writeFileSync(p, text);
  return (startupFiles[eop] = p);
}

const version = execFileSync(gmat, ['--version'], { cwd: path.dirname(gmat), encoding: 'utf8' }).match(/Build Date:[^\n]*/)?.[0] ?? 'unknown';

// ---- Script ---------------------------------------------------------------
const AU_KM = K.auM / 1000;
const g = (v) => v.toPrecision(17);
const utcGregorian = (iso) => {
  const d = new Date(`${iso}Z`), months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${iso.slice(11, 23)}`;
};
const INTEGRATORS = { PD78: 'PrinceDormand78', RK89: 'RungeKutta89' };
// IERS 2003 frame bias (IERS Conventions 2010, eq. 5.21 with xi0, eta0, da0):
// GCRF = B^T EME2000, to second order as the Conventions give it.
const MAS = Math.PI / 180 / 3600000;
const [XI0, ETA0, DA0] = [-16.617 * MAS, -6.819 * MAS, -14.6 * MAS];
const BIAS = [
  [1 - (DA0 ** 2 + XI0 ** 2) / 2, DA0, -XI0],
  [-DA0 - ETA0 * XI0, 1 - (DA0 ** 2 + ETA0 ** 2) / 2, -ETA0],
  [XI0 - ETA0 * DA0, ETA0 + XI0 * DA0, 1 - (ETA0 ** 2 + XI0 ** 2) / 2],
];
const mul = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const mulT = (m, v) => [0, 1, 2].map((i) => m[0][i] * v[0] + m[1][i] * v[1] + m[2][i] * v[2]);

const REPORT = 'Sat.UTCModJulian Sat.EarthMJ2000Eq.X Sat.EarthMJ2000Eq.Y Sat.EarthMJ2000Eq.Z Sat.EarthMJ2000Eq.VX Sat.EarthMJ2000Eq.VY Sat.EarthMJ2000Eq.VZ Sat.EarthICRF.X Sat.EarthICRF.Y Sat.EarthICRF.Z Sat.EarthICRF.VX Sat.EarthICRF.VY Sat.EarthICRF.VZ';
function script(c, report, stm, geo) {
  const geoLine = 'Report Geo Sat.UTCModJulian Sat.Earth.Latitude Sat.Earth.Longitude Sat.Earth.Altitude;';
  const f = c.forces, field = f.gravityField;
  let [x, y, z] = c.initialState.positionM, [vx, vy, vz] = c.initialState.velocityMS;
  if (c.frame === 'EME2000') { [x, y, z] = mulT(BIAS, [x, y, z]); [vx, vy, vz] = mulT(BIAS, [vx, vy, vz]); }
  const third = f.thirdBodies.length > 0;
  const drag = f.drag, atmosphere = o.atmosphere;
  const weather = drag && (drag.spaceWeather === 'cssi' && o.cssi === 'constant'
    ? (() => { const w = cssiConstants(c); return `GMAT FM.Drag.HistoricWeatherSource = 'ConstantFluxAndGeoMag';\nGMAT FM.Drag.PredictedWeatherSource = 'ConstantFluxAndGeoMag';\nGMAT FM.Drag.F107 = ${w.f107};\nGMAT FM.Drag.F107A = ${w.f107a};\nGMAT FM.Drag.MagneticIndex = ${g(w.kp)};`; })()
    : drag.spaceWeather === 'cssi'
    // With every row in the observed block nothing is predicted (R2022a takes no CSSI predicted source).
    ? `GMAT FM.Drag.HistoricWeatherSource = 'CSSISpaceWeatherFile';\nGMAT FM.Drag.PredictedWeatherSource = '${o.cssi === 'observed' ? 'ConstantFluxAndGeoMag' : 'CSSISpaceWeatherFile'}';\nGMAT FM.Drag.CSSISpaceWeatherFile = '${cssiFile()}';`
    : `GMAT FM.Drag.HistoricWeatherSource = 'ConstantFluxAndGeoMag';\nGMAT FM.Drag.PredictedWeatherSource = 'ConstantFluxAndGeoMag';\nGMAT FM.Drag.F107 = ${CASES.spaceWeather.constant.f107};\nGMAT FM.Drag.F107A = ${CASES.spaceWeather.constant.f107a};\nGMAT FM.Drag.MagneticIndex = ${CASES.spaceWeather.constant.kp};`);
  const thrust = f.inTrackAccelerationMS2 ? f.inTrackAccelerationMS2 : 0;
  const reportLine = `Report Out ${REPORT}${stm ? ' Sat.OrbitSTM' : ''};`;
  return `% ${c.id} (propagator/ffm/tests/evidence/gmat/run-gmat.mjs)
GMAT SolarSystem.EphemerisSource = 'SPICE';
GMAT SolarSystem.SPKFilename = '${KERNEL}';
GMAT SolarSystem.UseTTForEphemeris = false;
GMAT SolarSystem.EphemerisUpdateInterval = 0;
GMAT Earth.Mu = ${g(K.earthGmM3S2 / 1e9)};
GMAT Earth.EquatorialRadius = ${(K.wgs84.equatorialRadiusM / 1000).toFixed(3)};
GMAT Earth.Flattening = ${o.flattening ?? g(1 / K.wgs84.inverseFlattening)};
GMAT Earth.NutationUpdateInterval = 0;
GMAT Sun.Mu = ${g(K.sunGmM3S2 / 1e9)};
GMAT Sun.EquatorialRadius = ${K.sunRadiusM / 1000};
GMAT Luna.Mu = ${g(K.moonGmM3S2 / 1e9)};

Create Spacecraft Sat;
GMAT Sat.DateFormat = UTCGregorian;
GMAT Sat.Epoch = '${utcGregorian(c.epochUtc)}';
GMAT Sat.CoordinateSystem = EarthICRF;
GMAT Sat.DisplayStateType = Cartesian;
GMAT Sat.X = ${g(x / 1000)};
GMAT Sat.Y = ${g(y / 1000)};
GMAT Sat.Z = ${g(z / 1000)};
GMAT Sat.VX = ${g(vx / 1000)};
GMAT Sat.VY = ${g(vy / 1000)};
GMAT Sat.VZ = ${g(vz / 1000)};
GMAT Sat.DryMass = ${thrust ? K.spacecraft.massKg - 100 : K.spacecraft.massKg};
GMAT Sat.Cd = ${o.cd ?? K.spacecraft.cd};
GMAT Sat.Cr = ${K.spacecraft.cr};
GMAT Sat.DragArea = ${K.spacecraft.areaM2};
GMAT Sat.SRPArea = ${K.spacecraft.areaM2};
${thrust ? `GMAT Sat.Tanks = {Tank};
GMAT Sat.Thrusters = {Thruster};
Create ChemicalTank Tank;
GMAT Tank.FuelMass = 100;
GMAT Tank.AllowNegativeFuelMass = true;
Create ChemicalThruster Thruster;
GMAT Thruster.CoordinateSystem = Local;
GMAT Thruster.Origin = Earth;
GMAT Thruster.Axes = LVLH;
GMAT Thruster.ThrustDirection1 = 0;
GMAT Thruster.ThrustDirection2 = 1;
GMAT Thruster.ThrustDirection3 = 0;
GMAT Thruster.DutyCycle = 1;
GMAT Thruster.ThrustScaleFactor = 1;
GMAT Thruster.DecrementMass = false;
GMAT Thruster.Tank = {Tank};
GMAT Thruster.C1 = ${g(thrust * K.spacecraft.massKg)};
GMAT Thruster.C2 = 0;
GMAT Thruster.C3 = 0;
GMAT Thruster.K1 = 300;
GMAT Thruster.K2 = 0;
GMAT Thruster.K3 = 0;
Create FiniteBurn Burn;
GMAT Burn.Thrusters = {Thruster};
` : ''}
Create ForceModel FM;
GMAT FM.CentralBody = Earth;
${field ? `GMAT FM.PrimaryBodies = {Earth};
GMAT FM.GravityField.Earth.Degree = ${field.degree};
GMAT FM.GravityField.Earth.Order = ${field.order};
GMAT FM.GravityField.Earth.PotentialFile = '${fieldFile(field, c)}';
GMAT FM.GravityField.Earth.TideModel = '${f.solidTides ? (o.tide === 'SolidStep2' ? 'SolidAndPole' : o.tide) : 'None'}';
${third ? 'GMAT FM.PointMasses = {Sun, Luna};' : ''}` : `GMAT FM.PointMasses = {Earth${third ? ', Sun, Luna' : ''}};`}
GMAT FM.SRP = ${f.solarRadiationPressure ? 'On' : 'Off'};
${f.solarRadiationPressure ? `GMAT FM.SRP.Flux = ${K.solarIrradianceAt1AuWM2};
GMAT FM.SRP.Nominal_Sun = ${AU_KM};
GMAT FM.SRP.SRPModel = Spherical;` : ''}
${drag ? `GMAT FM.Drag.AtmosphereModel = ${atmosphere};
${weather}` : ''}
GMAT FM.RelativisticCorrection = ${f.relativity === 'iers2010' ? 'On' : 'Off'};
GMAT FM.ErrorControl = RSSStep;

Create Propagator Prop;
GMAT Prop.FM = FM;
GMAT Prop.Type = ${INTEGRATORS[o.integrator]};
GMAT Prop.InitialStepSize = 30;
GMAT Prop.Accuracy = ${o.accuracy};
GMAT Prop.MinStep = 0;
GMAT Prop.MaxStep = ${o['max-step']};
GMAT Prop.MaxStepAttempts = 200;
GMAT Prop.StopIfAccuracyIsViolated = true;

Create ReportFile Out;
GMAT Out.Filename = '${report}';
GMAT Out.Precision = 17;
GMAT Out.WriteHeaders = false;
GMAT Out.LeftJustify = On;
GMAT Out.ZeroFill = Off;
GMAT Out.ColumnWidth = 28;

${geo ? `Create ReportFile Geo;
GMAT Geo.Filename = '${geo}';
GMAT Geo.Precision = 17;
GMAT Geo.WriteHeaders = false;
GMAT Geo.LeftJustify = On;
GMAT Geo.ZeroFill = Off;
GMAT Geo.ColumnWidth = 28;
` : ''}
Create Variable I J;
BeginMissionSequence;
${thrust ? 'BeginFiniteBurn Burn(Sat);\n' : ''}${reportLine}${geo ? `\n${geoLine}` : ''}
For I = 1:24;
${geo ? `  For J = 1:${3600 / Number(o.geodetic)};
    Propagate Prop(Sat${stm ? ", 'STM'" : ''}) {Sat.ElapsedSecs = ${Number(o.geodetic)}};
    ${geoLine}
  EndFor;` : `  Propagate Prop(Sat${stm ? ", 'STM'" : ''}) {Sat.ElapsedSecs = 3600};`}
  ${reportLine}
EndFor;
${thrust ? 'EndFiniteBurn Burn(Sat);\n' : ''}`;
}

// ---- Run ------------------------------------------------------------------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(...a); return a.map((v) => v / n); };
const triad = (r, v) => { const e1 = unit(r), e3 = unit(cross(r, v)); return [e1, cross(e3, e1), e3]; };

const results = [], skipped = [];
const started = Date.now();
for (const c of CASES.cases) {
  if (o.only && !c.id.includes(o.only)) continue;
  const why = unsupported(c);
  if (why) { skipped.push({ id: c.id, reason: why }); continue; }
  const slug = c.id.replace(/\s+/g, '_') + (o.stm ? '.stm' : '');
  const report = path.join(work, `${slug}.txt`), file = path.join(work, `${slug}.script`);
  fs.rmSync(report, { force: true });
  const geo = o.geodetic ? path.join(work, `${slug}.geo.txt`) : null;
  if (geo) fs.rmSync(geo, { force: true });
  fs.writeFileSync(file, script(c, report, o.stm, geo));
  const t0 = Date.now();
  try {
    execFileSync(gmat, ['--startup_file', startupFile(eopFile(c.earthOrientation)), '--logfile', file.replace(/\.script$/, '.log'), '--verbose', 'off', '--run', file],
      { cwd: path.dirname(gmat), stdio: 'ignore', timeout: 3600000 });
  } catch (err) { throw new Error(`${c.id}: GmatConsole failed (${err.message}); see ${file.replace(/\.script$/, '.log')}`); }
  const seconds = (Date.now() - t0) / 1000;
  // With --stm GMAT writes the 6x6 OrbitSTM row by row: five more lines per sample.
  const lines = fs.readFileSync(report, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const rows = o.stm ? lines.filter((_, i) => i % 6 === 0).map((l, k) => [...l, ...lines.slice(6 * k + 1, 6 * k + 6).flat()]) : lines;
  if (rows.length !== 25) throw new Error(`${c.id}: ${rows.length} report rows (see ${slug}.log)`);
  // The fixed rotation from GMAT's integration axes to GCRF at the epoch, from
  // the epoch state in both (orthonormal triads of r and v).
  const [mj, icrf] = [triad(rows[0].slice(1, 4), rows[0].slice(4, 7)), triad(rows[0].slice(7, 10), rows[0].slice(10, 13))];
  const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => mj.reduce((s, e, k) => s + icrf[k][i] * e[j], 0)));
  const toOut = (v) => { const gcrf = mul(R, v); return c.frame === 'EME2000' ? mul(BIAS, gcrf) : gcrf; };
  let icrfDriftM = 0;
  const samples = rows.map((r, i) => {
    const t = c.sampleOffsetsS[i];
    const gmatT = (r[0] - rows[0][0]) * 86400;
    if (Math.abs(gmatT - t) > 1e-3) throw new Error(`${c.id}: GMAT sample ${i} at ${gmatT} s, not ${t} s`);
    const p = toOut(r.slice(1, 4)), v = toOut(r.slice(4, 7));
    const pIcrf = c.frame === 'EME2000' ? mul(BIAS, r.slice(7, 10)) : r.slice(7, 10);
    icrfDriftM = Math.max(icrfDriftM, 1000 * Math.hypot(p[0] - pIcrf[0], p[1] - pIcrf[1], p[2] - pIcrf[2]));
    return [t, ...p.map((x) => Number((x * 1000).toFixed(6))), ...v.map((x) => Number((x * 1000).toFixed(9)))];
  });
  const entry = { id: c.id, orbit: c.orbit, forceSet: c.forceSet, row: c.row, toleranceClass: c.toleranceClass, frame: c.frame,
    ...(c.forces.drag ? { atmosphere: o.atmosphere === 'NRLMSISE00' ? 'NRLMSISE00' : 'JACCHIA_ROBERTS' } : {}),
    icrfDriftM: Number(icrfDriftM.toExponential(3)), gmatSeconds: seconds, reportSha256: sha256(report), samples };
  if (o.stm) {
    // Orbit STM, row-major 6x6 in MJ2000Eq axes: to GCRF (or EME2000) as Q Phi Q^T, Q = diag(M, M).
    const M = c.frame === 'EME2000' ? BIAS.map((row) => [0, 1, 2].map((j) => row.reduce((s, b, k) => s + b * R[k][j], 0))) : R;
    entry.stm = rows.map((r) => {
      const phi = r.slice(13, 49);
      if (phi.length !== 36) throw new Error(`${c.id}: STM has ${phi.length} values`);
      const out = new Array(36).fill(0);
      const q = (i, k) => ((i < 3) === (k < 3) ? M[i % 3][k % 3] : 0);
      for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j) {
        let s = 0;
        for (let k = 0; k < 6; ++k) for (let l = 0; l < 6; ++l) { const a = q(i, k), b = q(j, l); if (a && b) s += a * phi[k * 6 + l] * b; }
        out[i * 6 + j] = Number(s.toPrecision(15));
      }
      return out;
    });
  }
  results.push(entry);
  console.error(`${c.id}: ${seconds.toFixed(1)} s, ICRF drift ${icrfDriftM.toExponential(2)} m`);
}

const doc = {
  about: 'NASA GMAT trajectories for the FFM reference cases (tests/evidence/gmat/run-gmat.mjs). Samples [t s, x y z m, vx vy vz m/s], GCRF (EME2000 for the EME2000 cases); stm: 6x6 orbit STM, row-major, same axes.',
  tool: {
    name: 'GMAT (NASA GSFC, Apache-2.0), GmatConsole', version, install: path.basename(gmatRoot),
    gmatConsoleSha256: sha256(gmat),
    gmatBaseSha256: (() => { const p = fs.readdirSync(path.join(path.dirname(gmat), fs.readdirSync(path.dirname(gmat)).find((d) => d.endsWith('.app')) ?? '.', 'Contents/Frameworks')).find((n) => /^libGmatBase\.R\d{4}a\.dylib$/.test(n)); return p ? sha256(path.join(path.dirname(gmat), fs.readdirSync(path.dirname(gmat)).find((d) => d.endsWith('.app')), 'Contents/Frameworks', p)) : null; })(),
  },
  settings: {
    integrator: INTEGRATORS[o.integrator], accuracy: Number(o.accuracy), maxStepS: Number(o['max-step']), errorControl: 'RSSStep',
    atmosphere: o.atmosphere, stm: o.stm, ...(o.cd ? { cd: Number(o.cd) } : {}), ...(o.geodetic ? { geodeticEveryS: Number(o.geodetic) } : {}), solidTideModel: o.tide, cssiRows: o.cssi, eopOffsets: o['eop-offsets'] ? path.basename(o['eop-offsets']) : 'zero dPsi, dEps',
    earthOrientation: 'GMAT IAU 1976/1980 (FK5) with the case export pole and UT1-UTC rows; NutationUpdateInterval 0',
    axes: 'initial state in EarthICRF; samples from EarthMJ2000Eq (integration axes) by the epoch\'s fixed rotation to GCRF; EME2000 cases through the IERS 2003 frame bias',
    ephemeris: 'SPICE, the case export DE440 kernel, TDB',
  },
  caseExportSha256: sha256(path.join(here, '../cases/ffm-reference-cases.json')),
  inputFiles: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { file: path.basename(v.path), ...(v.sha256 ? { sha256: v.sha256 } : { poleTideC21: v.poleTideC21, poleTideS21: v.poleTideS21, note: 'GMAT pole-tide increments subtracted from C21, S21 of this file' }) }])),
  wallSeconds: (Date.now() - started) / 1000,
  skipped,
  cases: results,
};
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(doc, null, 1).replace(/\[\n\s+([^\[\]{}]*?)\n\s+\]/g, (m, body) => `[${body.replace(/\n\s+/g, ' ')}]`)}\n`);
console.error(`${results.length} cases, ${skipped.length} not modeled -> ${out}`);
