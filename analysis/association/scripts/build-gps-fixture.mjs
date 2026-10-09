#!/usr/bin/env node
// Builds tests/fixtures/gps-20260802.json.gz from public precise-orbit
// products: two independent analysis results for the same day, and the
// IERS Earth orientation for it. Parsing and selection only; the test does
// the geometry.
//
//   node scripts/build-gps-fixture.mjs [--products DIR] [--reference DIR]
//
// Inputs (defaults: the SDN archive layout written by
// analysis/reference-states/scripts/fetch-reference-products.mjs):
//   ESA0OPSFIN_20262140000_01D_05M_ORB.SP3.gz  ESA/ESOC final GNSS orbits (GPS + Galileo + ...), IGS20, 5 min
//   IGS0OPSFIN_20262140000_01D_15M_ORB.SP3.gz  IGS final combined GPS orbits, IGc20, 15 min
//   IGS0OPSFIN_20262140000_01D_15M_ORB/*.oem   the same IGS orbits as GCRF/UTC $OEM with covariance (analysis/reference-states)
//   eopc04.1962-now                            IERS EOP 20 C04
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OEM, flatbuffers } from '../tests/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { products: { type: 'string' }, reference: { type: 'string' } } });
const products = values.products ?? '/opt/data/sdn-archive/reference-states/products';
const reference = values.reference ?? '/opt/data/sdn-archive/reference-states/reference';
const ESA = path.join(products, 'ESA0OPSFIN_20262140000_01D_05M_ORB.SP3.gz');
const IGS = path.join(products, 'IGS0OPSFIN_20262140000_01D_15M_ORB.SP3.gz');
const IGS_OEM = path.join(reference, 'IGS0OPSFIN_20262140000_01D_15M_ORB');
const C04 = path.join(products, 'eopc04.1962-now');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sources = [];
const read = (file, what, url) => {
  const bytes = fs.readFileSync(file);
  sources.push({ file: path.basename(file), sha256: sha256(bytes), what, url });
  return bytes;
};

// SP3-d: '*  yyyy mm dd hh mm ss' epoch lines, 'Psnn x y z clock' records (km).
// Epochs are GPS time; kept as 'YYYY-MM-DDTHH:MM:SS' GPST text.
function sp3(bytes, keep) {
  const out = new Map();  // epoch -> Map(sat -> [x, y, z])
  let epoch = null;
  for (const line of zlib.gunzipSync(bytes).toString('latin1').split('\n')) {
    if (line.startsWith('* ')) {
      const [y, mo, d, h, mi, s] = line.slice(2).trim().split(/\s+/).map(Number);
      const p = (n) => String(n).padStart(2, '0');
      epoch = `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(Math.round(s))}`;
      if (keep(epoch)) out.set(epoch, new Map()); else epoch = null;
    } else if (line.startsWith('P') && epoch) {
      const sat = line.slice(1, 4);
      const xyz = [line.slice(4, 18), line.slice(18, 32), line.slice(32, 46)].map(Number);
      if (/^[GE]/.test(sat) && xyz.every((v) => Number.isFinite(v) && v !== 0)) out.get(epoch).set(sat, xyz);
    }
  }
  return out;
}

const minutes = (text) => (Date.parse(`${text}Z`) - Date.parse('2026-08-02T00:00:00Z')) / 60000;
const inWindow = (lo, hi) => (epoch) => minutes(epoch) >= lo && minutes(epoch) <= hi;
// Observation epochs 06:00-08:00 GPST every 15 min; ESA truth 05:15-08:45
// (Lagrange windows around t - tau); IGS GCRF predictions 05:00-09:00.
const esa = sp3(read(ESA, 'ESA/ESOC final GNSS orbits (observation truth)', 'https://navigation-office.esa.int/products/gnss-products/2430/ESA0OPSFIN_20262140000_01D_05M_ORB.SP3.gz'), inWindow(315, 525));
const igs = sp3(read(IGS, 'IGS final combined GPS orbits (Earth-fixed, for the ITRF-to-GCRF rotation)', 'https://igs.bkg.bund.de/root_ftp/IGS/products/2430/IGS0OPSFIN_20262140000_01D_15M_ORB.SP3.gz'), inWindow(360, 480));

const catalog = [];
for (const name of fs.readdirSync(IGS_OEM).filter((n) => n.endsWith('.oem')).sort()) {
  const bytes = read(path.join(IGS_OEM, name), 'IGS final orbit as GCRF/UTC $OEM with covariance (catalog predictions)', null);
  const oem = OEM.OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack();
  for (const b of oem.EPHEMERIS_DATA_BLOCK) {
    const prn = /SP3 satellite (G\d\d)/.exec(b.COMMENT)?.[1];
    if (!prn) continue;
    const utcMinutes = (e) => (Date.parse(e) - Date.parse('2026-08-02T00:00:00Z')) / 60000;
    const keep = (e) => utcMinutes(e) >= 299 && utcMinutes(e) <= 540;
    catalog.push({
      prn, norad: b.OBJECT.NORAD_CAT_ID, objectId: b.OBJECT.OBJECT_ID, name: b.OBJECT.OBJECT_NAME,
      states: b.EPHEMERIS_DATA_LINES.filter((l) => keep(l.EPOCH)).map((l) => ({ epoch: l.EPOCH, state: [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] })),
      covariances: b.COVARIANCE_MATRIX_LINES.filter((l) => keep(l.EPOCH)).map((l) => ({ epoch: l.EPOCH,
        lower: ['CX_X', 'CY_X', 'CY_Y', 'CZ_X', 'CZ_Y', 'CZ_Z', 'CX_DOT_X', 'CX_DOT_Y', 'CX_DOT_Z', 'CX_DOT_X_DOT', 'CY_DOT_X', 'CY_DOT_Y', 'CY_DOT_Z',
          'CY_DOT_X_DOT', 'CY_DOT_Y_DOT', 'CZ_DOT_X', 'CZ_DOT_Y', 'CZ_DOT_Z', 'CZ_DOT_X_DOT', 'CZ_DOT_Y_DOT', 'CZ_DOT_Z_DOT'].map((k) => l[k]) })),
      comment: b.COMMENT,
    });
  }
}

const eop = [];
for (const line of read(C04, 'IERS EOP 20 C04', 'https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now').toString().split('\n')) {
  const f = line.trim().split(/\s+/);
  if (f.length < 13 || line.startsWith('#')) continue;
  const mjd = Number(f[4]);
  if (mjd === 61254 || mjd === 61255) {
    eop.push({ date: `${f[0]}-${f[1].padStart(2, '0')}-${f[2].padStart(2, '0')}`, mjd, xArcsec: Number(f[5]), yArcsec: Number(f[6]), dut1: Number(f[7]),
      dXArcsec: Number(f[8]), dYArcsec: Number(f[9]), lod: Number(f[12]) });
  }
}

const mapOut = (m) => Object.fromEntries([...m].map(([epoch, sats]) => [epoch, Object.fromEntries(sats)]));
const fixture = {
  description: 'GPS and Galileo on 2026-08-02 from two independent precise-orbit analyses. Truth for observations: ESA/ESOC final orbits (Earth-fixed IGS20, GPS time). Catalog predictions: the IGS final combined orbits as GCRF/UTC states with covariance (analysis/reference-states). igsItrf holds the IGS Earth-fixed positions at the observation epochs, from which the test recovers the IGS ITRF-to-GCRF rotation. Earth orientation: IERS EOP 20 C04.',
  timeScale: { sp3: 'GPS', gpsMinusUtcSeconds: 18 },
  sources,
  eop,
  observationEpochsGpst: [...igs.keys()],
  esaItrf: mapOut(esa),
  igsItrf: mapOut(igs),
  catalog,
};
const out = path.join(here, '../tests/fixtures/gps-20260802.json.gz');
fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(fixture), { level: 9 }));
console.log(`${out}: ${fs.statSync(out).size} bytes; ${catalog.length} catalog objects, ${esa.size} truth epochs, ${igs.size} observation epochs, ${eop.length} EOP rows`);
