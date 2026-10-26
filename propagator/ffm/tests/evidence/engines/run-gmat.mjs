#!/usr/bin/env node
// NASA GMAT (Apache-2.0) on the engine benchmark plan (plan.mjs): the cases
// of the COMMON tier, timed. Each case runs as a 1-day and a 3-day script;
// the cost per object-day is the difference of their process CPU times over
// two days, so GmatConsole's start-up, script parsing and file loading cancel.
//
//   node tests/evidence/engines/run-gmat.mjs <GmatConsole> <work dir> [--only TEXT] [--reps 1] [--error-control RSSState] [--out gmat.json] [--scratch dir]
//
// Settings as tests/evidence/gmat/run-gmat.mjs (its header gives each one):
// FFM's EGM2008 coefficients (.cof, 70x70, tide-free), Earth GM 398600.4415,
// Sun and Moon from the plan's DE440 kernel through SPICE at TDB with the
// DE440 header GMs, Sun radius 695 700 km, cannonball radiation pressure at
// 1361 W/m^2 with GMAT's conical shadow, NRLMSISE-00 (R2026a) on constant
// F10.7 = F10.7a = 150, Kp 3, WGS84 Earth, GMAT's IAU 1976/1980 Earth
// orientation with the plan's pole and UT1-UTC rows, nutation every call.
// Integrator: PrinceDormand78 (RK8(7)13M, FFM's RKDP87 tableau). Error
// control --error-control (RSSState: the RSS of the error over the RSS of the
// state; FFM takes the largest component of err/(abs + rel |y|)); one
// Accuracy (relative) and no absolute tolerance. Fixed steps: MinStep =
// MaxStep with ErrorControl None. GMAT stops at every hourly sample.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { writeEopC04 } from '../gmat/gmat-files.mjs';
import { gmatRootOf, writeStartupFile } from '../../fixtures/gmat/gmat-console.mjs';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  only: { type: 'string' }, reps: { type: 'string', default: '1' }, 'error-control': { type: 'string', default: 'RSSState' },
  out: { type: 'string' }, tier: { type: 'string', default: 'COMMON' }, scratch: { type: 'string' },
} });
const [gmat, workArg] = positionals;
const work = path.resolve(workArg);
const plan = JSON.parse(fs.readFileSync(path.join(work, 'plan.json'), 'utf8'));
const dir = path.resolve(o.scratch ?? path.join(work, 'gmat'));
fs.mkdirSync(dir, { recursive: true });
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const gmatRoot = gmatRootOf(gmat);
const eop = JSON.parse(fs.readFileSync(plan.data.eop.path, 'utf8'));
const eopFile = path.join(dir, 'eop.txt');
writeEopC04(eopFile, eop.rows, gmatRoot);
const startup = writeStartupFile(gmat, dir, eopFile);

const K = plan.constants, sc = plan.spacecraft, w = plan.spaceWeather;
const AU_KM = K.auM / 1000, AU3_DAY2 = (K.auM ** 3) / 86400 ** 2;
const GM_SUN = 2.9591220828411951e-04 * AU3_DAY2, GM_MOON = 8.9970116036316091e-10 * AU3_DAY2 / (1 + 81.3005682214972154);
const g = (v) => v.toPrecision(17);
const utcGregorian = (iso) => {
  const d = new Date(`${iso}Z`), months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${iso.slice(11, 23)}`;
};
const REPORT = 'Sat.UTCModJulian Sat.EarthMJ2000Eq.X Sat.EarthMJ2000Eq.Y Sat.EarthMJ2000Eq.Z Sat.EarthMJ2000Eq.VX Sat.EarthMJ2000Eq.VY Sat.EarthMJ2000Eq.VZ Sat.EarthICRF.X Sat.EarthICRF.Y Sat.EarthICRF.Z Sat.EarthICRF.VX Sat.EarthICRF.VY Sat.EarthICRF.VZ';

function script(c, report, hours) {
  const f = c.forces, s = c.settings;
  const [x, y, z] = c.positionM, [vx, vy, vz] = c.velocityMS;
  const fixed = s.kind === 'fixed';
  if (f.thirdBodies.some((b) => !['SUN', 'MOON'].includes(b)) || f.solidTides || f.oceanTides || f.relativity || f.earthRadiation)
    throw new Error(`${c.id}: not a COMMON-tier case`);
  return `% ${c.id} (propagator/ffm/tests/evidence/engines/run-gmat.mjs)
GMAT SolarSystem.EphemerisSource = 'SPICE';
GMAT SolarSystem.SPKFilename = '${plan.data.kernel.path}';
GMAT SolarSystem.UseTTForEphemeris = false;
GMAT SolarSystem.EphemerisUpdateInterval = 0;
GMAT Earth.Mu = ${g(K.earthGmM3S2 / 1e9)};
GMAT Earth.EquatorialRadius = ${(K.wgs84.equatorialRadiusM / 1000).toFixed(3)};
GMAT Earth.Flattening = ${g(1 / K.wgs84.inverseFlattening)};
GMAT Earth.NutationUpdateInterval = 0;
GMAT Sun.Mu = ${g(GM_SUN / 1e9)};
GMAT Sun.EquatorialRadius = ${K.sunRadiusM / 1000};
GMAT Luna.Mu = ${g(GM_MOON / 1e9)};

Create Spacecraft Sat;
GMAT Sat.DateFormat = UTCGregorian;
GMAT Sat.Epoch = '${utcGregorian(plan.epochUtc)}';
GMAT Sat.CoordinateSystem = EarthICRF;
GMAT Sat.DisplayStateType = Cartesian;
GMAT Sat.X = ${g(x / 1000)};
GMAT Sat.Y = ${g(y / 1000)};
GMAT Sat.Z = ${g(z / 1000)};
GMAT Sat.VX = ${g(vx / 1000)};
GMAT Sat.VY = ${g(vy / 1000)};
GMAT Sat.VZ = ${g(vz / 1000)};
GMAT Sat.DryMass = ${sc.massKg};
GMAT Sat.Cd = ${sc.cd};
GMAT Sat.Cr = ${sc.cr};
GMAT Sat.DragArea = ${sc.areaM2};
GMAT Sat.SRPArea = ${sc.areaM2};

Create ForceModel FM;
GMAT FM.CentralBody = Earth;
GMAT FM.PrimaryBodies = {Earth};
GMAT FM.GravityField.Earth.Degree = ${f.gravity.degree};
GMAT FM.GravityField.Earth.Order = ${f.gravity.order};
GMAT FM.GravityField.Earth.PotentialFile = '${plan.data.cof.path}';
GMAT FM.GravityField.Earth.TideModel = 'None';
GMAT FM.PointMasses = {Sun, Luna};
GMAT FM.SRP = On;
GMAT FM.SRP.Flux = ${K.solarIrradianceAt1AuWM2};
GMAT FM.SRP.Nominal_Sun = ${AU_KM};
GMAT FM.SRP.SRPModel = Spherical;
${f.drag ? `GMAT FM.Drag.AtmosphereModel = NRLMSISE00;
GMAT FM.Drag.HistoricWeatherSource = 'ConstantFluxAndGeoMag';
GMAT FM.Drag.PredictedWeatherSource = 'ConstantFluxAndGeoMag';
GMAT FM.Drag.F107 = ${w.f107};
GMAT FM.Drag.F107A = ${w.f107a};
GMAT FM.Drag.MagneticIndex = ${w.kp};` : ''}
GMAT FM.RelativisticCorrection = Off;
GMAT FM.ErrorControl = ${fixed ? 'None' : o['error-control']};

Create Propagator Prop;
GMAT Prop.FM = FM;
GMAT Prop.Type = PrinceDormand78;
GMAT Prop.InitialStepSize = ${fixed ? s.stepS : s.initialStepS};
GMAT Prop.Accuracy = ${fixed ? 1e-6 : s.relativeTolerance};
GMAT Prop.MinStep = ${fixed ? s.stepS : s.minStepS};
GMAT Prop.MaxStep = ${fixed ? s.stepS : s.maxStepS};
GMAT Prop.MaxStepAttempts = 200;
GMAT Prop.StopIfAccuracyIsViolated = false;

Create ReportFile Out;
GMAT Out.Filename = '${report}';
GMAT Out.Precision = 17;
GMAT Out.WriteHeaders = false;
GMAT Out.LeftJustify = On;
GMAT Out.ZeroFill = Off;
GMAT Out.ColumnWidth = 28;

Create Variable I;
BeginMissionSequence;
Report Out ${REPORT};
For I = 1:${hours};
  Propagate Prop(Sat) {Sat.ElapsedSecs = ${plan.sampleStepS}};
  Report Out ${REPORT};
EndFor;
`;
}

// Process CPU (user + system) of one GmatConsole run, from /usr/bin/time -p.
function runGmat(file) {
  const r = spawnSync('/usr/bin/time', ['-p', gmat, '--startup_file', startup, '--logfile', file.replace(/\.script$/, '.log'), '--verbose', 'off', '--run', file],
    { cwd: path.dirname(gmat), encoding: 'utf8', timeout: 3600000 });
  if (r.status !== 0) throw new Error(`GmatConsole failed on ${file}: ${r.stderr.slice(-500)}`);
  const t = (k) => Number(new RegExp(`^${k}\\s+([0-9.]+)`, 'm').exec(r.stderr)[1]);
  return { cpuS: t('user') + t('sys'), wallS: t('real') };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(...a); return a.map((v) => v / n); };
const triad = (r, v) => { const e1 = unit(r), e3 = unit(cross(r, v)); return [e1, cross(e3, e1), e3]; };
const mul = (M, v) => M.map((row) => dot(row, v));

const results = [];
const hours3 = plan.days * 24, hours1 = 24;
for (const c of plan.cases) {
  if (c.tier !== o.tier || (o.only && !c.id.includes(o.only))) continue;
  const slug = c.id.replace(/\s+/g, '_');
  const runs = {};
  for (const [label, hours] of [['1d', hours1], ['3d', hours3]]) {
    const report = path.join(dir, `${slug}.${label}.txt`), file = path.join(dir, `${slug}.${label}.script`);
    fs.writeFileSync(file, script(c, report, hours));
    let best = null;
    for (let i = 0; i < Number(o.reps); ++i) {
      fs.rmSync(report, { force: true });
      const t = runGmat(file);
      if (!best || t.cpuS < best.cpuS) best = t;
    }
    runs[label] = { ...best, report };
  }
  const rows = fs.readFileSync(runs['3d'].report, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  if (rows.length !== hours3 + 1) throw new Error(`${c.id}: ${rows.length} report rows`);
  // GMAT integrates in MJ2000Eq; the epoch's fixed rotation to GCRF from the epoch state in both axes.
  const [mj, icrf] = [triad(rows[0].slice(1, 4), rows[0].slice(4, 7)), triad(rows[0].slice(7, 10), rows[0].slice(10, 13))];
  const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => mj.reduce((s, e, k) => s + icrf[k][i] * e[j], 0)));
  const samples = rows.map((r, i) => {
    const t = Math.round((r[0] - rows[0][0]) * 86400 * 1000) / 1000;
    if (Math.abs(t - plan.sampleOffsetsS[i]) > 1e-3) throw new Error(`${c.id}: sample ${i} at ${t} s`);
    return [plan.sampleOffsetsS[i], ...mul(R, r.slice(1, 4)).map((x) => x * 1000)];
  });
  const perDay = (runs['3d'].cpuS - runs['1d'].cpuS) / (plan.days - 1);
  const s = c.settings;
  results.push({ engine: 'GMAT', id: c.id, orbit: c.orbit, regime: c.regime, tier: c.tier, integrator: c.integrator,
    method: s.kind === 'fixed' ? `PrinceDormand78 (RK8(7)13M) fixed ${s.stepS} s, ErrorControl None` : `PrinceDormand78 (RK8(7)13M) Accuracy ${s.relativeTolerance}, ErrorControl ${o['error-control']}, max step ${s.maxStepS} s, stops at each hourly sample`,
    cpuS1d: runs['1d'].cpuS, cpuS3d: runs['3d'].cpuS, wallS3d: runs['3d'].wallS, cpuSPerObjectDay: perDay,
    fixedCostS: runs['1d'].cpuS - perDay, samples });
  console.error(`${c.id}: ${perDay.toFixed(4)} CPU-s/object-day (1 d ${runs['1d'].cpuS.toFixed(2)} s, 3 d ${runs['3d'].cpuS.toFixed(2)} s)`);
}
const doc = { engine: 'GMAT', version: `GMAT ${path.basename(gmatRoot)} (${fs.readdirSync(path.dirname(gmat)).find((d) => d.endsWith('.app')) ?? ''})`,
  runtime: 'GmatConsole, one process per run', gmatConsoleSha256: sha256(gmat), host: { cpu: os.cpus()[0]?.model, loadAverage: os.loadavg() },
  planSha256: sha256(path.join(work, 'plan.json')), errorControl: o['error-control'], reps: Number(o.reps), results };
const out = o.out ?? path.join(work, 'gmat.json');
fs.writeFileSync(out, `${JSON.stringify(doc)}\n`);
console.error(`-> ${out}`);
