#!/usr/bin/env node
// NASA GMAT R2022a Jacchia-Roberts densities for lib/jacchia_roberts.h.
//
//   node tests/fixtures/atmosphere/make-jacchia-roberts-gmat.mjs <GmatConsole> <work dir> <out.json>
//
// GMAT itself evaluates every density: GmatConsole reports the
// `Sat.FM.AtmosDensity` parameter of a JacchiaRoberts drag force (constant
// flux and Kp) at seeded random epochs (UTC 2000-01-01 to 2023-03-31, inside
// GMAT's shipped EOP file) and points (100-2500 km geodetic height, GMAT's
// Jacchia-Roberts range: it refuses heights at or below 100 km). Twenty
// scripts, each with its own F10.7, F10.7a and Kp, of 100 points each.
//
// Each row also carries the arguments GMAT gave its JacchiaRoberts()
// function, reconstructed from what GMAT reports, so lib/jacchia_roberts.h
// can be called with the same ones:
//   - the point and the Sun: Earth-centred MJ2000Eq position of the
//     spacecraft and of the Sun (DragForce::GetDensity gives the model the
//     Sun's GetState; the Sun is the spacecraft's EarthMJ2000Eq position less
//     its position in a Sun-centred MJ2000Eq system), km;
//   - the geodetic height and latitude: AtmosphereModel::CalculateGeodetics
//     (Vallado algorithm 12, GMAT's 1e-7 rad stopping tolerance, its degree
//     round trip) applied to the reported Earth-fixed position, km and rad;
//   - the UTC modified Julian date (JD - 2400000.5): GMAT's UTCModJulian
//     (JD - 2430000) + 29999.5;
//   - the polar radius: the scripted equatorial radius times (1 - flattening).
// The Earth is WGS84 (6378.137 km, 1/298.257223563). Density is GMAT's
// kg/km^3 times 1e-9, kg/m^3.
import fs from 'node:fs';
import path from 'node:path';
import { gmatVersion, runScript, writeStartupFile } from '../gmat/gmat-console.mjs';

const [gmat, work, out] = process.argv.slice(2);
if (!out) throw new Error('usage: make-jacchia-roberts-gmat.mjs <GmatConsole> <work dir> <out.json>');
fs.mkdirSync(work, { recursive: true });
const startupFile = writeStartupFile(gmat, work);

const RADIUS = 6378.137, FLATTENING = 1 / 298.257223563, POLAR = RADIUS * (1.0 - FLATTENING);
const SETS = 20, POINTS = 100, MJD_FIRST = 51544, MJD_LAST = 60034;
// mulberry32, seeded: the same rows on every run.
let seed = 0x4a52474d;
const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const between = (a, b) => a + (b - a) * random();
const f = (v) => v.toPrecision(17);

// AtmosphereModel::CalculateGeodetics, as GMAT R2022a compiles it.
const PI = 3.14159265358979323846, DEG_PER_RAD = 180.0 / PI, RAD_PER_DEG = PI / 180.0;
function geodetics([x, y, z]) {
  const rxy = Math.sqrt(x * x + y * y), ecc2 = FLATTENING * (2.0 - FLATTENING);
  let geoLat = Math.atan2(z, rxy), delta = 1.0, sinlat, cFactor;
  while (delta > 1.0e-7) {
    const oldlat = geoLat;
    sinlat = Math.sin(oldlat);
    cFactor = RADIUS / Math.sqrt(1.0 - ecc2 * sinlat * sinlat);
    geoLat = Math.atan2(z + cFactor * ecc2 * sinlat, rxy);
    delta = Math.abs(geoLat - oldlat);
  }
  sinlat = Math.sin(geoLat);
  cFactor = RADIUS / Math.sqrt(1.0 - ecc2 * sinlat * sinlat);
  const height = rxy / Math.cos(geoLat) - cFactor;
  return { height, latitude: geoLat * DEG_PER_RAD * RAD_PER_DEG };
}

const REPORT = 'Sat.UTCModJulian Sat.FM.AtmosDensity Sat.EarthFixed.X Sat.EarthFixed.Y Sat.EarthFixed.Z Sat.EarthMJ2000Eq.X Sat.EarthMJ2000Eq.Y Sat.EarthMJ2000Eq.Z Sat.SunMJ2000Eq.X Sat.SunMJ2000Eq.Y Sat.SunMJ2000Eq.Z';
const rows = [];
for (let set = 0; set < SETS; ++set) {
  const weather = { f107: Number(between(70, 250).toFixed(1)), f107a: Number(between(70, 250).toFixed(1)), kp: Number(between(0, 9).toFixed(2)) };
  const points = Array.from({ length: POINTS }, () => {
    const mjd = between(MJD_FIRST, MJD_LAST), r = RADIUS + between(110, 2470);
    const z = between(-1, 1), lon = between(0, 2 * Math.PI), s = Math.sqrt(1 - z * z);
    return { gmatMjd: mjd - 29999.5, position: [r * s * Math.cos(lon), r * s * Math.sin(lon), r * z] };
  });
  const report = path.join(work, `jr-${set}.txt`), script = path.join(work, `jr-${set}.script`);
  fs.rmSync(report, { force: true });
  fs.writeFileSync(script, `% Jacchia-Roberts densities, set ${set} (make-jacchia-roberts-gmat.mjs)
GMAT Earth.EquatorialRadius = ${RADIUS};
GMAT Earth.Flattening = ${f(FLATTENING)};
GMAT Earth.NutationUpdateInterval = 0;

Create CoordinateSystem SunMJ2000Eq;
GMAT SunMJ2000Eq.Origin = Sun;
GMAT SunMJ2000Eq.Axes = MJ2000Eq;

Create Spacecraft Sat;
GMAT Sat.DateFormat = UTCModJulian;
GMAT Sat.Epoch = '${f(points[0].gmatMjd)}';
GMAT Sat.CoordinateSystem = EarthMJ2000Eq;
GMAT Sat.X = ${f(points[0].position[0])};
GMAT Sat.Y = ${f(points[0].position[1])};
GMAT Sat.Z = ${f(points[0].position[2])};
GMAT Sat.VX = 0;
GMAT Sat.VY = 0;
GMAT Sat.VZ = 7;

Create ForceModel FM;
GMAT FM.CentralBody = Earth;
GMAT FM.PrimaryBodies = {Earth};
GMAT FM.GravityField.Earth.Degree = 0;
GMAT FM.GravityField.Earth.Order = 0;
GMAT FM.Drag.AtmosphereModel = JacchiaRoberts;
GMAT FM.Drag.HistoricWeatherSource = 'ConstantFluxAndGeoMag';
GMAT FM.Drag.PredictedWeatherSource = 'ConstantFluxAndGeoMag';
GMAT FM.Drag.F107 = ${weather.f107};
GMAT FM.Drag.F107A = ${weather.f107a};
GMAT FM.Drag.MagneticIndex = ${weather.kp};

Create Propagator Prop;
GMAT Prop.FM = FM;

Create ReportFile Out;
GMAT Out.Filename = '${path.resolve(report)}';
GMAT Out.Precision = 17;
GMAT Out.WriteHeaders = false;
GMAT Out.LeftJustify = On;
GMAT Out.ZeroFill = Off;
GMAT Out.ColumnWidth = 28;

BeginMissionSequence;
${points.map((p) => `Sat.Epoch.UTCModJulian = ${f(p.gmatMjd)};
Sat.EarthMJ2000Eq.X = ${f(p.position[0])};
Sat.EarthMJ2000Eq.Y = ${f(p.position[1])};
Sat.EarthMJ2000Eq.Z = ${f(p.position[2])};
Report Out ${REPORT};`).join('\n')}
`);
  runScript(gmat, startupFile, script);
  const lines = fs.readFileSync(report, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  if (lines.length !== POINTS) throw new Error(`set ${set}: ${lines.length} report rows (see ${script.replace(/\.script$/, '.log')})`);
  for (const [utcGmat, densityKgKm3, fx, fy, fz, x, y, z, sx, sy, sz] of lines) {
    const { height, latitude } = geodetics([fx, fy, fz]);
    const sun = [x - sx, y - sy, z - sz];
    rows.push([height, latitude, x, y, z, ...sun, utcGmat + 29999.5, POLAR, weather.f107, weather.f107a, weather.kp, densityKgKm3 * 1e-9]);
  }
  console.error(`set ${set} done`);
}

const doc = {
  source: `NASA GMAT R2022a (GSFC, Apache-2.0; GmatConsole, ${gmatVersion(gmat)}): Sat.FM.AtmosDensity of a JacchiaRoberts drag force with constant flux and Kp; arguments as GMAT's JacchiaRoberts() received them (make-jacchia-roberts-gmat.mjs); WGS84 Earth`,
  columns: ['heightKm', 'geodeticLatitudeRad', 'pointX', 'pointY', 'pointZ', 'sunX', 'sunY', 'sunZ', 'mjdUtc', 'polarRadiusKm', 'f107', 'f107a', 'kp', 'densityKgM3'],
  rows,
};
fs.writeFileSync(out, `{\n "source": ${JSON.stringify(doc.source)},\n "columns": ${JSON.stringify(doc.columns)},\n "rows": [\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n ]\n}\n`);
console.error(`${rows.length} rows -> ${out}`);
