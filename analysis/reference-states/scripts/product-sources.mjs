// Where every reference product comes from: URLs, file names, local-archive paths and identities, and the plan of what a run
// from --from to --to would fetch or read. Pure: no network, no module, no download. fetch-reference-products.mjs builds its
// requests from these functions, and --dry-run prints plan() without running anything else.
import fs from 'node:fs';
import path from 'node:path';

export const DAY = 86400000;
export const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const dayOfYear = (ms) => Math.round((ms - Date.UTC(new Date(ms).getUTCFullYear(), 0, 1)) / DAY) + 1;
export const gpsWeek = (ms) => Math.floor((ms - Date.UTC(1980, 0, 6)) / (7 * DAY));
export const yymmdd = (ms) => new Date(ms).toISOString().slice(2, 10).replaceAll('-', '');
const basename = (url) => path.basename(new URL(url).pathname);

// ── Earth orientation and GNSS identities ──
export const EOP_URLS = { c04: 'https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now', finals: 'https://datacenter.iers.org/data/9/finals2000A.all' };
export const SINEX_URL = 'https://files.igs.org/pub/station/general/igs_satellite_metadata.snx';

// ── GPS: the IGS combined final orbit at BKG; where BKG no longer holds the day, ESA's final orbit (an IGS analysis centre, 5 min) ──
export function gpsFiles(day) {
  const d3 = `${new Date(day).getUTCFullYear()}${String(dayOfYear(day)).padStart(3, '0')}`, week = gpsWeek(day);
  const igs = `IGS0OPSFIN_${d3}0000_01D_15M_ORB.SP3.gz`, esa = `ESA0OPSFIN_${d3}0000_01D_05M_ORB.SP3.gz`;
  return {
    primary: { name: igs, url: `https://igs.bkg.bund.de/root_ftp/IGS/products/${week}/${igs}` },
    fallback: { name: esa, url: `https://navigation-office.esa.int/products/gnss-products/${week}/${esa}` },
  };
}

// ── MGEX: a local copy under cddis/gnss/products/<week>/ ──
export function mgexFile(day, product, localArchive) {
  const name = `${product}${new Date(day).getUTCFullYear()}${String(dayOfYear(day)).padStart(3, '0')}0000_01D_05M_ORB.SP3.gz`;
  return { name, file: path.join(localArchive, 'cddis', 'gnss', 'products', String(gpsWeek(day)), name) };
}

// ── ILRS combined weekly arcs (EDC layout since October 2026) ──
export const SLR = { lageos1: { norad: 8820, objectId: '1976-039A', name: 'LAGEOS 1' }, lageos2: { norad: 22195, objectId: '1992-070B', name: 'LAGEOS 2' },
  etalon1: { norad: 19751, objectId: '1989-001C', name: 'ETALON 1' }, etalon2: { norad: 20026, objectId: '1989-039C', name: 'ETALON 2' } };
export const slrArcBase = (sat, arcDay) => `https://edc.dgfi.tum.de/pub/slr/products/orbits/TRF/${sat}/20${yymmdd(arcDay).slice(0, 2)}/${yymmdd(arcDay)}/`;
export const slrNamePattern = (sat, arcDay) => `[a-z]+\\.orb\\.${sat}\\.${yymmdd(arcDay)}\\.v\\d+\\.sp3\\.gz`;
export const slrYearListing = (year) => `https://edc.dgfi.tum.de/pub/slr/products/orbits/TRF/lageos1/${year}/`;

// ── ILRS analysis-centre (NSGF) 4-day arcs ──
export const SLR_DAILY = { ajisai: { norad: 16908, objectId: '1986-061A', name: 'AJISAI' }, starlette: { norad: 7646, objectId: '1975-010A', name: 'STARLETTE' },
  stella: { norad: 22824, objectId: '1993-061B', name: 'STELLA' }, larets: { norad: 27944, objectId: '2003-042F', name: 'LARETS' },
  westpac: { norad: 25398, objectId: '1998-043E', name: 'WESTPAC' }, lares: { norad: 38077, objectId: '2012-006A', name: 'LARES' },
  lares2: { norad: 53105, objectId: '2022-080A', name: 'LARES-2' } };
export const slrDailyFile = (sat, ms) =>
  `https://edc.dgfi.tum.de/pub/slr/products/orbits/rapid/${sat}/${new Date(ms).getUTCFullYear()}/${yymmdd(ms)}/nsgf.orb.${sat}.${yymmdd(ms)}.v000.sp3.gz`;

// ── Sentinel-1 AUX_POEORB (files valid from 22:59:42 the day before) ──
export const S1 = { S1A: { norad: 39634, objectId: '2014-016A', name: 'SENTINEL 1A' }, S1C: { norad: 62261, objectId: '2024-235A', name: 'SENTINEL 1C' },
  S1D: { norad: 66315, objectId: '2025-251A', name: 'SENTINEL-1D' } };
export function sentinel1Base(unit, day) {
  const d = new Date(day);
  return `https://step.esa.int/auxdata/orbits/Sentinel-1/POEORB/${unit}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/`;
}
export const S1_NAME_PATTERN = 'S1[A-D]_OPER_AUX_POEORB_OPOD_\\w+?\\.EOF\\.zip';

// ── Swarm: TU Delft reduced-dynamic and kinematic orbits (files run 23:59:42 the day before to the day's end) ──
export const SWARM = { A: { norad: 39452, objectId: '2013-067B', name: 'SWARM A' }, B: { norad: 39451, objectId: '2013-067A', name: 'SWARM B' },
  C: { norad: 39453, objectId: '2013-067C', name: 'SWARM C' } };
export const SWARM_SERVER = 'https://swarm-diss.eo.esa.int/';
export const swarmDirs = (sat) => ({ rd: `swarm/Level2daily/Latest_baselines/POD/RD/Sat_${sat}`, kin: `swarm/Level2daily/Latest_baselines/POD/KIN/Sat_${sat}` });
export const swarmListUrl = (dir) => `${SWARM_SERVER}?do=list&maxfiles=10000&pos=0&file=${encodeURIComponent(dir)}`;
export const swarmDownloadUrl = (dir, name) => `${SWARM_SERVER}?do=download&file=${encodeURIComponent(`${dir}/${name}`)}`;
export const swarmDay = (day) => iso(day - DAY).replaceAll('-', '');
export const swarmRdPattern = (sat, day) => new RegExp(`^SW_OPER_SP3${sat}(COM|RD_)_2__${swarmDay(day)}T235942_`);
export const swarmKinPattern = (sat, day) => new RegExp(`^SW_OPER_SP3${sat}KIN_2__${swarmDay(day)}T235942_`);

// ── DORIS (IDS, CNES SSALTO), local copies: ssa<sat><version>.b<yyddd>.e<yyddd>.<type>.sp3.<nnn>.Z ──
export const DORIS = { cs2: { norad: 36508, objectId: '2010-013A', name: 'CRYOSAT 2' }, srl: { norad: 39086, objectId: '2013-009A', name: 'SARAL' },
  s3a: { norad: 41335, objectId: '2016-011A', name: 'SENTINEL 3A' }, s3b: { norad: 43437, objectId: '2018-039A', name: 'SENTINEL 3B' },
  swo: { norad: 54754, objectId: '2022-173A', name: 'SWOT' } };
export const yyddd = (s) => Date.UTC(2000 + Number(s.slice(0, 2)), 0, Number(s.slice(2)));
export const dorisDir = (localArchive) => path.join(localArchive, 'ids-doris', 'ssa');
export function dorisArcs(localArchive) {  // per satellite, one arc per first day (the latest version), in time order
  const dir = dorisDir(localArchive);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^ssa\w{5}\.b\d{5}\.e\d{5}\.\w{3}\.sp3\.\d{3}\.Z$/.test(n)).sort() : [];
  return Object.fromEntries(Object.keys(DORIS).map((sat) => [sat,
    [...new Map(names.filter((n) => n.slice(3, 6) === sat).map((n) => [n.slice(10, 15), n]))].sort()
      .map(([b, file]) => ({ name: file.replace(/\.sp3\.\d{3}\.Z$/, ''), file, start: yyddd(b), stop: yyddd(file.slice(17, 22)) + DAY }))]));
}

// ── GFZ rapid science orbits (ISDC), local copies: GFZOP_RSO_<code>_G_<start>_<stop>_v<nn>.sp3.gz ──
export const GFZ_RSO = { L64: { norad: 43476, objectId: '2018-047A', name: 'GRACE-FO 1' }, L65: { norad: 43477, objectId: '2018-047B', name: 'GRACE-FO 2' },
  L13: { norad: 31698, objectId: '2007-026A', name: 'TerraSAR-X' } };
export const stamp = (s) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
export const gfzRsoDir = (localArchive, code) => path.join(localArchive, 'gfz-isdc-rso', 'RSO', code);
export function gfzRsoArcs(localArchive, code) {  // the latest version of each start, in time order
  const dir = gfzRsoDir(localArchive, code);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^GFZOP_RSO_L\d\d_G_\d{8}_\d{6}_\d{8}_\d{6}_v\d\d\.sp3\.gz$/.test(n)).sort() : [];
  return [...new Map(names.map((n) => [n.slice(16, 31), n]))].sort()
    .map(([start, file]) => ({ name: file.replace('.sp3.gz', ''), file, start: stamp(start), stop: stamp(file.slice(32, 47)) }));
}

// ── COSMIC-2 (CDAAC near-real-time), local tarballs ──
export const cosmic2Tarball = (day) => `leoOrb_nrt_${new Date(day).getUTCFullYear()}_${String(dayOfYear(day)).padStart(3, '0')}.tar.gz`;
export const cosmic2Dir = (localArchive) => path.join(localArchive, 'ucar-cosmic2', 'nrt-leoOrb');

// ── WAAS (SBAS) message type 9, archived CDDIS records: <local archive>/cddis-sbas/<yyyy>/<doy>.json ──
export const sbasFile = (day, localArchive) => path.join(localArchive, 'cddis-sbas', String(new Date(day).getUTCFullYear()), `${dayOfYear(day)}.json`);

// ── GFZ Kp: the nowcast file the space-weather collector fetches daily (data-source/space-weather); not converted here ──
export const KP = { series: 'Kp_ap_Ap_SN_F107_nowcast.txt', url: 'https://kp.gfz.de/fileadmin/files_for_gfz_cms/Kp_ap_Ap_SN_F107_nowcast.txt' };

export const PRODUCTS = ['gps', 'mgex', 'slr', 'slr-daily', 'sentinel1', 'swarm', 'doris', 'gfz-rso', 'cosmic2', 'sbas', 'kp'];

// The plan of a run: what it would request or read, in the order it would, without touching the network. Entries:
//   role 'download'  a file fetched by name (cached under <out>/products by its URL's basename; `cached` says whether it is there);
//   role 'fallback'  fetched only where the primary is not published;
//   role 'listing'   a directory listing the run reads first; `pattern` is the file name it then takes;
//   role 'local'     a copy already under the local archive (`present` says whether it is);
//   role 'collector' fetched by another module's collector, not by this script.
export function plan({ from, to, products, out, localArchive, eop = 'c04', mgexProduct = 'GFZ0MGXRAP_' }) {
  const entries = [];
  const cachedIn = (name) => fs.existsSync(path.join(out, 'products', name));
  const add = (e) => entries.push(e);
  const download = (product, day, name, url, role = 'download') => add({ product, day: day === null ? null : iso(day), role, name, url, cached: cachedIn(name) });
  const wants = new Set(products);
  if (wants.has('gps') || wants.has('mgex') || wants.has('slr') || wants.has('slr-daily') || wants.has('sentinel1') || wants.has('swarm') || wants.has('doris') || wants.has('gfz-rso') || wants.has('cosmic2') || wants.has('sbas'))
    download('eop', null, basename(EOP_URLS[eop]), EOP_URLS[eop]);
  if (wants.has('gps') || wants.has('mgex')) download('igs-metadata', null, basename(SINEX_URL), SINEX_URL);
  const years = [...new Set([new Date(from).getUTCFullYear(), new Date(to).getUTCFullYear()])];
  for (let day = from; day <= to; day += DAY) {
    if (wants.has('swarm')) for (const sat of Object.keys(SWARM)) {
      const dirs = swarmDirs(sat);
      add({ product: 'swarm', day: iso(day), role: 'listing', sat, url: swarmListUrl(dirs.rd), pattern: swarmRdPattern(sat, day).source });
      add({ product: 'swarm', day: iso(day), role: 'listing', sat, url: swarmListUrl(dirs.kin), pattern: swarmKinPattern(sat, day).source });
    }
    if (wants.has('slr-daily') && (day - from) % (4 * DAY) === 0) for (const sat of Object.keys(SLR_DAILY)) {
      for (const ms of [day + 4 * DAY, day + 5 * DAY]) download('slr-daily', day, basename(slrDailyFile(sat, ms)), slrDailyFile(sat, ms));
    }
    if (wants.has('gps')) {
      const f = gpsFiles(day);
      download('gps', day, f.primary.name, f.primary.url);
      download('gps', day, f.fallback.name, f.fallback.url, 'fallback');
    }
    if (wants.has('mgex')) {
      const m = mgexFile(day, mgexProduct, localArchive);
      add({ product: 'mgex', day: iso(day), role: 'local', name: m.name, path: m.file, present: fs.existsSync(m.file) });
    }
    if (wants.has('sentinel1')) for (const unit of Object.keys(S1))
      add({ product: 'sentinel1', day: iso(day), role: 'listing', unit, url: sentinel1Base(unit, day), pattern: S1_NAME_PATTERN, validFrom: iso(day - DAY) });
    if (wants.has('slr')) {
      // ILRS arcs are named by their last day, one each week: the run lists the years, then takes the arcs whose last day is in range.
      if (day === from) for (const y of years) add({ product: 'slr', day: null, role: 'listing', url: slrYearListing(y), pattern: 'lageos1/\\d{4}/(\\d{6})' });
      for (const sat of Object.keys(SLR))
        add({ product: 'slr', day: iso(day), role: 'listing', sat, url: slrArcBase(sat, day), pattern: slrNamePattern(sat, day), condition: 'an arc of that last day is in the year listing' });
    }
  }
  if (wants.has('doris')) for (const [sat, arcs] of Object.entries(dorisArcs(localArchive)))
    for (const a of arcs.filter((x) => x.stop > from && x.start < to + DAY))
      add({ product: 'doris', day: iso(a.start), role: 'local', sat, name: a.file, path: path.join(dorisDir(localArchive), a.file), present: true });
  if (wants.has('gfz-rso')) for (const code of Object.keys(GFZ_RSO))
    for (const a of gfzRsoArcs(localArchive, code).filter((x) => x.stop > from && x.start < to + DAY))
      add({ product: 'gfz-rso', day: iso(a.start), role: 'local', sat: code, name: a.file, path: path.join(gfzRsoDir(localArchive, code), a.file), present: true });
  if (wants.has('cosmic2')) for (let day = from - DAY; day <= to + DAY; day += DAY) {
    const name = cosmic2Tarball(day), file = path.join(cosmic2Dir(localArchive), name);
    add({ product: 'cosmic2', day: iso(day), role: 'local', name, path: file, present: fs.existsSync(file) });
  }
  if (wants.has('sbas')) for (let day = from; day <= to; day += DAY) {
    const file = sbasFile(day, localArchive);
    add({ product: 'sbas', day: iso(day), role: 'local', name: path.basename(file), path: file, present: fs.existsSync(file) });
  }
  if (wants.has('kp')) add({ product: 'kp', day: null, role: 'collector', name: KP.series, url: KP.url, fetchedBy: 'data-source/space-weather (gfz-kp collector, daily snapshots)' });
  return entries;
}
