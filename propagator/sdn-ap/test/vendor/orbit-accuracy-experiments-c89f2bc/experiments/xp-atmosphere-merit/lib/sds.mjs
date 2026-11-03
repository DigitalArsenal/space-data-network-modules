// The SDS records XM sends to the modules, encoded with the bindings of the SDS release propagator/sdn-ap is built with
// (1.272.0, its own dependency): $OEM blocks and grids, $OMM, $PCF (with the 1.0.6 prior forms), $SPW rows, $DCL.
// Bytes only; every orbit computation is a module's.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { modulesRoot } from '../common.mjs';

const modules = modulesRoot();
const req = createRequire(path.join(modules, 'propagator/sdn-ap/package.json'));
const standards = path.dirname(req.resolve('spacedatastandards.org/package.json'));
const load = (code) => import(pathToFileURL(path.join(standards, `lib/js/${code}/main.js`)).href);
export const flatbuffers = await import(pathToFileURL(req.resolve('flatbuffers')).href);
export const [OEM, OMM, PCF, SPW, DCL, RFM, OBD] = await Promise.all(['OEM', 'OMM', 'PCF', 'SPW', 'DCL', 'RFM', 'OBD'].map(load));
export const sdsVersion = (await import(pathToFileURL(path.join(standards, 'package.json')).href, { with: { type: 'json' } })).default.version;
export const TYPE = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name, wireFormat: 'flatbuffer' });

// G1's frame declaration (lib/baselines.mjs FIT_FRAME and lib/sds.mjs rfm): the enumeration and the NAME, which agree.
const ENUM = { EME2000: 'EME2000', GCRF: 'GCRF', ICRF: 'GCRF', TEME: 'TEMEOFDATE' };
const NAME = { EME2000: 'EME2000', GCRF: 'GCRF', ICRF: 'GCRF', TEME: 'TEME' };
const rfm = (frame) => Object.assign(new RFM.RFMT(RFM.RFMUnion.CelestialFrameWrapper, new RFM.CelestialFrameWrapperT(RFM.CelestialFrame[ENUM[frame]])), { NAME: NAME[frame] });

/** A plain $OEM of one block: lines [{epoch, r, v}] (km, km/s) in `frame`, UTC; useable [start, stop] declared when given. */
export function oemBytes({ frame, object, lines, useableStart, useableStop, originator = 'XM' }) {
  const t = new OEM.OEMT();
  Object.assign(t, { CCSDS_OEM_VERS: 2.0, CREATION_DATE: '', ORIGINATOR: originator });
  const b = new OEM.ephemerisDataBlockT();
  b.OBJECT = Object.assign(new OEM.CATT(), { OBJECT_NAME: object?.name ?? '', OBJECT_ID: object?.id ?? '', NORAD_CAT_ID: object?.norad ?? 0 });
  b.CENTER_NAME = 'EARTH';
  b.REFERENCE_FRAME = rfm(frame);
  b.TIME_SYSTEM = OEM.timingStandard.UTC;
  b.START_TIME = lines[0].epoch;
  b.STOP_TIME = lines.at(-1).epoch;
  b.USEABLE_START_TIME = useableStart ?? null;
  b.USEABLE_STOP_TIME = useableStop ?? null;
  b.EPHEMERIS_DATA_LINES = lines.map((l) => Object.assign(new OEM.ephemerisDataLineT(), { EPOCH: l.epoch, X: l.r[0], Y: l.r[1], Z: l.r[2], X_DOT: l.v?.[0] ?? 0, Y_DOT: l.v?.[1] ?? 0, Z_DOT: l.v?.[2] ?? 0 }));
  t.EPHEMERIS_DATA_BLOCK = [b];
  const builder = new flatbuffers.Builder(1 << 16);
  OEM.OEM.finishOEMBuffer(builder, t.pack(builder));
  return builder.asUint8Array().slice();
}

/** A grid template: explicit epochs (ISO UTC), TEME. */
export const gridBytes = (epochs) => oemBytes({ frame: 'TEME', lines: epochs.map((epoch) => ({ epoch, r: [0, 0, 0] })) });

/** The states of a propagate answer: [{epoch, r, v}] of its first block. */
export function oemLines(bytes) {
  const u = new Uint8Array(bytes);
  const prefixed = String.fromCharCode(...u.slice(8, 12)) === '$OEM';
  const o = (prefixed ? OEM.OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(u)) : OEM.OEM.getRootAsOEM(new flatbuffers.ByteBuffer(u))).unpack();
  return o.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.map((l) => ({ epoch: l.EPOCH, r: [l.X, l.Y, l.Z], v: [l.X_DOT, l.Y_DOT, l.Z_DOT] }));
}

/** A fitted $OMM, decoded: the record, its COMMENT statistics and its covariance rows. */
export function readFitOmm(bytes) {
  const u = OMM.OMM.getRootAsOMM(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack();
  const comment = u.COMMENT ?? '';
  const num = (re) => { const m = re.exec(comment); return m ? Number(m[1]) : null; };
  const params = Object.fromEntries((u.USER_DEFINED_PARAMETERS ?? []).map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));
  return { u, epoch: u.EPOCH, bterm: u.BSTAR, agom: u.MEAN_MOTION_DDOT, fitRmsKm: num(/fit RMS ([\d.]+) km/), iterations: num(/(\d+) iterations/), states: num(/(\d+) states fitted/), params };
}

/** The $OBD of a fit, decoded: the model texts (the prior forms, posterior sigma of the log) and the iteration count. */
export function readObd(bytes) {
  const d = OBD.OBD.getRootAsOBD(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack();
  const posterior = (text) => { const m = /posterior sigma of the log ([0-9.eE+-]+)/.exec(text ?? ''); return m ? Number(m[1]) : null; };
  return { bModel: d.BALLISTIC_COEFF_MODEL, aModel: d.AGOM_MODEL, iterations: d.NUM_ITERATIONS, wrmsKm: d.WRMS, sigmaLnB: posterior(d.BALLISTIC_COEFF_MODEL), priorLimited: /prior-limited/.test(d.BALLISTIC_COEFF_MODEL ?? '') };
}

/** A $PCF: THEORY SGP4XP, the arm's FORCES fields (with the required empty EPHEMERIS_SOURCE), the FIT priors with their forms. */
export function pcfBytes({ theory = 'SGP4XP', forces = null, fit = null } = {}) {
  const t = new PCF.PCFT();
  t.THEORY = PCF.pcfTheory[theory];
  if (forces) {
    const enumOf = { WEATHER_SOURCE: PCF.pcfWeatherSource, WEATHER_EXTENSION: PCF.pcfWeatherExtension, ATMOSPHERE_MODEL: PCF.pcfAtmosphereFamily, DENSITY_CORRECTION: PCF.pcfDensityCorrection };
    const f = Object.assign(new PCF.PCFForceModelT(), { EPHEMERIS_SOURCE: '' });
    for (const [k, v] of Object.entries(forces)) f[k] = enumOf[k] ? enumOf[k][v] : v;
    t.FORCES = f;
  }
  if (fit) {
    const prior = (p) => (p ? Object.assign(new PCF.PCFGaussianPriorT(), { MEAN: p.mean, SIGMA: p.sigma, HAS_SIGMA: true }) : null);
    t.FIT = Object.assign(new PCF.PCFFitPolicyT(), {
      DRAG_PRIOR: prior(fit.dragPrior), SRP_PRIOR: prior(fit.srpPrior),
      DRAG_PRIOR_FORM: PCF.pcfPriorForm[fit.dragPrior?.form ?? 'GAUSSIAN_SIGNED'], SRP_PRIOR_FORM: PCF.pcfPriorForm[fit.srpPrior?.form ?? 'GAUSSIAN_SIGNED'],
    });
  }
  const b = new flatbuffers.Builder(512);
  PCF.PCF.finishPCFBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}

/** $SPW rows [{date, f107, c81, ap}] as size-prefixed records end to end. */
export function spwBytes(rows) {
  const parts = rows.map((r) => {
    const b = new flatbuffers.Builder(256);
    SPW.SPW.finishSizePrefixedSPWBuffer(b, Object.assign(new SPW.SPWT(), { DATE: r.date, F107_OBS: r.f107, F107_OBS_CENTER81: r.c81, AP_AVG: r.ap }).pack(b));
    return b.asUint8Array().slice();
  });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
