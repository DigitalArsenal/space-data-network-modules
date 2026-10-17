// The module's $ERM records (SDS Orbit Error Model) for the tests and scripts of analysis/gp-error-model: the readable
// form the methods were documented in (README, docs/*.json) encoded into one $ERM record per port, and the module's
// $ERM outputs decoded back into it. The wire is the $ERM record; this form is only how a client renders it. The
// mapping mirrors the module's own boundary, src/erm_bridge.cpp: numbers pass through as the same doubles.
//
// The ERM bindings are the standards' TypeScript object API (lib/ts/ERM), bundled once with the standards' esbuild.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));

async function bindings() {
  const dir = path.join(standardsRoot, 'lib', 'ts', 'ERM');
  const stamp = crypto.createHash('sha256');
  for (const f of fs.readdirSync(dir).sort()) stamp.update(f).update(fs.readFileSync(path.join(dir, f)));
  const out = path.join(os.tmpdir(), `sds-erm-${stamp.digest('hex').slice(0, 16)}.mjs`);
  if (!fs.existsSync(out)) {
    const esbuild = createRequire(path.join(standardsRoot, 'package.json'))('esbuild');
    const tmp = `${out}.${process.pid}.tmp`;
    await esbuild.build({
      stdin: { contents: "export * from './main.ts';\nexport * as flatbuffers from 'flatbuffers';\n", resolveDir: dir, loader: 'ts', sourcefile: 'erm-entry.ts' },
      bundle: true, format: 'esm', platform: 'node', outfile: tmp, logLevel: 'silent',
    });
    fs.renameSync(tmp, out);
  }
  return import(pathToFileURL(out));
}
export const E = await bindings();
const fb = E.flatbuffers;

export const ERM_TYPE = { schemaName: 'ERM.fbs', fileIdentifier: '$ERM', rootTypeName: 'ERM', wireFormat: 'flatbuffer' };

// ── helpers ──
const has = (o, k) => o != null && typeof o === 'object' && o[k] !== undefined && o[k] !== null;
const num = (o, k, d) => (has(o, k) && typeof o[k] === 'number' ? o[k] : d);
const str = (o, k) => (has(o, k) && typeof o[k] === 'string' ? o[k] : null);
const nz = (s) => (s ? s : null);
const arr = (o, k) => (has(o, k) && Array.isArray(o[k]) ? o[k].map((x) => (typeof x === 'number' ? x : NaN)) : []);
const big = (v) => BigInt(Math.max(0, Math.trunc(Number(v) || 0)));
const N = (v) => (typeof v === 'bigint' ? Number(v) : v);
// A T object with fields set; numbers go to bigint where the field is a 64-bit integer.
function make(Cls, props = {}) {
  const t = new Cls();
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    t[k] = typeof t[k] === 'bigint' && typeof v === 'number' ? big(v) : v;
  }
  return t;
}
const id = (v) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));

// ── counts ──
const COUNTS = {
  elementSets: 'ELEMENT_SETS', refused: 'REFUSED', duplicateEpochs: 'DUPLICATE_EPOCHS', unclassified: 'UNCLASSIFIED', objects: 'OBJECTS',
  samples: 'SAMPLES', propagationFailures: 'PROPAGATION_FAILURES', referenceEpochs: 'REFERENCE_EPOCHS',
  referenceObjectsWithoutElements: 'REFERENCE_OBJECTS_WITHOUT_ELEMENTS', arcs: 'ARCS', targets: 'TARGETS', setsWithoutReference: 'SETS_WITHOUT_REFERENCE',
  setsWithoutTargets: 'SETS_WITHOUT_TARGETS', arcsWithoutModelRegime: 'ARCS_WITHOUT_MODEL_REGIME', targetsOutsideWindow: 'TARGETS_OUTSIDE_WINDOW',
  targetsWithoutPrediction: 'TARGETS_WITHOUT_PREDICTION', outsideAgeBins: 'OUTSIDE_AGE_BINS', withoutCovariance: 'WITHOUT_COVARIANCE',
  notPositiveDefinite: 'NOT_POSITIVE_DEFINITE', missingTargets: 'MISSING_TARGETS', missingSets: 'MISSING_SETS', differences: 'DIFFERENCES',
  mapped: 'MAPPED', failed: 'FAILED', pairs: 'PAIRS', withoutTruthCovariance: 'WITHOUT_TRUTH_COVARIANCE', outsideRegimes: 'OUTSIDE_REGIMES',
  states: 'STATES', streams: 'STREAMS', blocks: 'BLOCKS', covariances: 'COVARIANCES', aprioriSets: 'APRIORI_SETS', fitted: 'FITTED',
  calibratedRows: 'CALIBRATED_ROWS', uncalibratedRows: 'UNCALIBRATED_ROWS', statesOfOlderSets: 'STATES_OF_OLDER_SETS', maneuvers: 'MANEUVERS',
};
const BASE = ['elementSets', 'refused', 'duplicateEpochs', 'unclassified', 'objects', 'samples', 'propagationFailures', 'referenceEpochs', 'referenceObjectsWithoutElements'];
function countsIn(j = {}) {
  const c = new E.ERMCountsT();
  for (const [k, f] of Object.entries(COUNTS)) c[f] = num(j, k, 0);
  if (has(j, 'frames')) c.FRAME_COUNTS = Object.entries(j.frames).map(([NAME, COUNT]) => make(E.ERMNamedCountT, { NAME, COUNT }));
  if (['rule1', 'rule2', 'rule3', 'rule4'].some((k) => has(j, k))) c.RULE_COUNTS = ['rule1', 'rule2', 'rule3', 'rule4'].map((k) => num(j, k, 0));
  return c;
}
// The counts of an output as the method named them: `keys` always, the rest when set.
function countsOut(c, keys = BASE) {
  const out = {};
  c ??= new E.ERMCountsT();
  for (const k of keys) {
    if (k === 'frames') out.frames = Object.fromEntries((c.FRAME_COUNTS ?? []).map((n) => [n.NAME, n.COUNT]));
    else if (/^rule[1-4]$/.test(k)) out[k] = c.RULE_COUNTS?.[Number(k[4]) - 1] ?? 0;
    else out[k] = c[COUNTS[k]];
  }
  for (const [k, f] of Object.entries(COUNTS)) if (c[f] && !(k in out)) out[k] = c[f];
  return out;
}

// ── strata ──
function strataIn(j, stepAndClip) {
  const s = new E.ERMStrataSettingsT();
  if (has(j, 'regimes')) s.REGIMES = j.regimes.map((r) => make(E.ERMRegimeT, { ID: r.id, ALTITUDE_MIN_KM: r.altitudeKm?.[0] ?? 0, ALTITUDE_MAX_KM: r.altitudeKm?.[1] ?? 0,
    ECCENTRICITY_MIN: r.eccentricity?.[0] ?? 0, ECCENTRICITY_MAX: r.eccentricity?.[1] ?? 0 }));
  if (has(j, 'ageBinsDays')) s.AGE_BINS = j.ageBinsDays.map((a) => make(E.ERMAgeBinT, { MIN_DAYS: a[0], MAX_DAYS: a[1] }));
  if (stepAndClip) {
    s.REFERENCE_STEP_S = num(j, 'referenceStepSeconds', 300);
    if (has(j, 'clip')) s.CLIP = make(E.ERMClipSettingsT, { K: num(j.clip, 'k', 0), STRATA: (j.clip.strata ?? []).map((x) => make(E.ERMClipCentreT, {
      REGIME_INDEX: x.regime, AGE_INDEX: x.age, CENTRE_KM: x.centre ?? [], SCALE_KM: x.scale ?? [] })) });
  }
  return s;
}
function strataOut(s, into) {
  if (!s) return into;
  if (s.REGIMES?.length) into.regimes = s.REGIMES.map((r) => ({ id: r.ID, altitudeKm: [r.ALTITUDE_MIN_KM, r.ALTITUDE_MAX_KM], eccentricity: [r.ECCENTRICITY_MIN, r.ECCENTRICITY_MAX] }));
  if (s.AGE_BINS?.length) into.ageBinsDays = s.AGE_BINS.map((a) => [a.MIN_DAYS, a.MAX_DAYS]);
  return into;
}

// ── gate, coverage ──
const gateIn = (g = {}) => make(E.ERMGateT, { TOLERANCE: num(g, 'tolerance', 0.05), TAIL_LIMIT: num(g, 'tailLimit', 0.01), MINIMUM_SAMPLES: num(g, 'minimumSamples', 30),
  MINIMUM_OBJECTS: num(g, 'minimumObjects', 3), RULE: str(g, 'rule'), NOMINAL: arr(g, 'nominal') });
const gateOut = (g) => ({ ...(g.RULE ? { rule: g.RULE } : {}), tolerance: g.TOLERANCE, tailLimit: g.TAIL_LIMIT, minimumSamples: g.MINIMUM_SAMPLES,
  minimumObjects: g.MINIMUM_OBJECTS, ...(g.NOMINAL?.length ? { nominal: g.NOMINAL } : {}) });
const VERDICT = { CALIBRATED: E.ermCoverageVerdict.Calibrated, FAILED: E.ermCoverageVerdict.Failed, INSUFFICIENT: E.ermCoverageVerdict.Insufficient, NO_MODEL: E.ermCoverageVerdict.NoModel };
const VERDICT_NAME = Object.fromEntries(Object.entries(VERDICT).map(([k, v]) => [v, k]));
function coverageOut(c, missingModel) {
  const g = { n: N(c.N), objects: c.OBJECTS, status: VERDICT_NAME[c.VERDICT] ?? '' };
  if (!Number.isNaN(c.MEAN_D2)) g.meanD2 = c.MEAN_D2;
  if (c.INSIDE?.length) g.inside = c.INSIDE;
  if (c.PIT?.length) g.pit = c.PIT;
  if (!Number.isNaN(c.PIT_MAX_CDF_GAP)) g.pitMaxCdfGap = c.PIT_MAX_CDF_GAP;
  if (missingModel) g.missingModel = N(c.MISSING_MODEL);
  return g;
}
const MODE = { reference: E.ermErrorBasis.ReferenceStates, 'gp-differences': E.ermErrorBasis.SetDifferences };
const modeOut = (b) => (b === E.ermErrorBasis.ReferenceStates ? 'reference' : b === E.ermErrorBasis.SetDifferences ? 'gp-differences' : '');
const CALIBRATION = { CALIBRATED: E.covarianceCalibration.Calibrated, UNCALIBRATED: E.covarianceCalibration.Uncalibrated };
const calibrationOut = (c) => (c === E.covarianceCalibration.Calibrated ? 'CALIBRATED' : c === E.covarianceCalibration.Uncalibrated ? 'UNCALIBRATED' : '');
const noiseIn = (n) => make(E.ERMProcessNoiseT, { MODEL: str(n, 'model'), AXES: str(n, 'axes'), SPECTRAL_DENSITY_M2_S3: arr(n, 'spectralDensityM2S3'),
  DISCRETIZATION_S: num(n, 'discretizationSeconds', 0) });
const noiseOut = (n) => ({ ...(n.MODEL ? { model: n.MODEL } : {}), ...(n.AXES ? { axes: n.AXES } : {}), spectralDensityM2S3: n.SPECTRAL_DENSITY_M2_S3,
  discretizationSeconds: n.DISCRETIZATION_S });
const STRATIFIED_UNITS = { position: 'km', velocity: 'km/s', components: ['R', 'T', 'N', 'dR', 'dT', 'dN'], covariance: 'lower triangle, row-major: RR, TR, TT, NR, NT, NN, dR R, ...' };
const FFM_UNITS = { p0: 'km, km/s; lower triangle, row-major, RTN: RR, TR, TT, NR, NT, NN, dR R, ...', spectralDensityM2S3: 'm^2/s^3 per R, T, N axis' };

// ── models ──
export function modelIn(j) {
  const m = make(E.ERMModelT, { ID: str(j, 'id'), CANDIDATE: str(j, 'candidate'), BASIS_TEXT: str(j, 'basis'), LABEL: str(j, 'label') });
  if (has(j, 'counts')) m.COUNTS = countsIn(j.counts);
  const kind = j.kind;
  if (kind === 'gp-error-model') {
    Object.assign(m, { FORM: E.ermModelForm.StratifiedStatistics, BASIS: MODE[j.mode] ?? 0, PROPAGATOR: str(j, 'propagator'), STRATA_SETTINGS: strataIn(j, false),
      QUANTILE_PROBABILITIES: arr(j, 'quantileProbabilities'), COVERAGE_MODEL: str(j, 'coverageModel'), GATE: has(j, 'gate') ? gateIn(j.gate) : null });
    m.STRATA = (j.strata ?? []).map((s) => make(E.ERMModelStratumT, {
      REGIME: str(s, 'regime'), REGIME_INDEX: num(s, 'regimeIndex', 0), AGE_INDEX: num(s, 'ageIndex', 0), AGE_MIN_DAYS: s.ageDays?.[0] ?? 0, AGE_MAX_DAYS: s.ageDays?.[1] ?? 0,
      N: num(s, 'n', 0), MEAN: arr(s, 'mean'), COVARIANCE: arr(s, 'covariance'), QUANTILES: (s.quantiles ?? []).flat(), MEDIAN: arr(s, 'median'), ROBUST_SIGMA: arr(s, 'robustSigma'),
      CLIPPED: has(s, 'clipped') ? make(E.ERMClippedStatisticsT, { K: num(s.clipped, 'k', 0), N: num(s.clipped, 'n', 0), FRACTION_REMOVED: num(s.clipped, 'fractionRemoved', 0),
        MEAN: arr(s.clipped, 'mean'), COVARIANCE: arr(s.clipped, 'covariance') }) : null,
      COVERAGE: has(s, 'coverage') ? make(E.ERMCoverageT, { N: num(s.coverage, 'n', 0), OBJECTS: num(s.coverage, 'objects', 0), VERDICT: VERDICT[s.coverage.status] ?? 0,
        MEAN_D2: num(s.coverage, 'meanD2', NaN), INSIDE: arr(s.coverage, 'inside'), PIT: arr(s.coverage, 'pit'), PIT_MAX_CDF_GAP: num(s.coverage, 'pitMaxCdfGap', NaN),
        MISSING_MODEL: num(s.coverage, 'missingModel', 0) }) : null,
      SCALE: has(s, 'scale') ? make(E.ERMStratumScaleT, { FACTORS: arr(s.scale, 'factors'), TRUTH_N: num(s.scale, 'truthN', 0) }) : null,
    }));
    if (has(j, 'scale')) m.SCALE = make(E.ERMModelScaleT, { BASIS: str(j.scale, 'basis'), TRUTH_COUNTS: has(j.scale, 'truthCounts') ? countsIn(j.scale.truthCounts) : null,
      TRUTH_WINDOW: str(j.scale, 'truthWindow'), MINIMUM_SAMPLES: num(j.scale, 'minimumSamples', 0) });
  } else if (kind === 'ffm-covariance-model') {
    Object.assign(m, { FORM: E.ermModelForm.PropagatorCovariance, EPOCH_WINDOW_START: j.epochWindow?.[0] ?? null, EPOCH_WINDOW_STOP: j.epochWindow?.[1] ?? null });
    m.PROPAGATOR_REGIMES = (j.regimes ?? []).map((r) => {
      const n = r.processNoise;
      const f = n?.fit;
      return make(E.ERMPropagatorRegimeT, { REGIME_INDEX: num(r, 'regimeIndex', 0), REGIME: str(r, 'regime'), N: num(r, 'n', 0), KEPT: num(r, 'kept', 0),
        OBJECTS: num(r, 'objects', 0), CLIP_K: num(r, 'clipK', 0), P0: arr(r, 'p0'), PROCESS_NOISE: n ? noiseIn(n) : null,
        FIT: f ? make(E.ERMNoiseFitT, { SAMPLES: num(f, 'samples', 0), OBJECTS: num(f, 'objects', 0), WINDOW_START: f.window?.[0] ?? null, WINDOW_STOP: f.window?.[1] ?? null,
          NEGATIVE_LOG_LIKELIHOOD_Q0: num(f, 'negativeLogLikelihoodQ0', 0), NEGATIVE_LOG_LIKELIHOOD: num(f, 'negativeLogLikelihood', 0),
          MAXIMUM_LIKELIHOOD_M2_S3: arr(f, 'maximumLikelihoodM2S3'), CALIBRATED_STRATA_MAXIMUM_LIKELIHOOD: num(f.fitStrataCalibrated, 'maximumLikelihood', 0),
          CALIBRATED_STRATA_P0_ALONE: num(f.fitStrataCalibrated, 'p0Alone', 0), SELECTED: str(f, 'selected'), RULE: str(f, 'rule') }) : null });
    });
  } else if (kind === 'e14-factors') {
    Object.assign(m, { FORM: E.ermModelForm.HorizonFactors, CALIBRATION_VERSION: str(j, 'calibrationVersion') ?? str(j, 'version'), STRATA_SETTINGS: strataIn(j, false) });
    m.HORIZON_FACTORS = (j.strata ?? []).map((s) => make(E.ERMHorizonFactorT, { REGIME: s.regime && s.regime !== '*' ? s.regime : null,
      HORIZON_MIN_DAYS: s.horizonDays?.[0] ?? 0, HORIZON_MAX_DAYS: s.horizonDays?.[1] ?? 0, AXES_FACTORS: arr(s, 'axesFactors'),
      FACTOR: has(s, 'axesFactors') ? NaN : num(s, 'factor', NaN), STATUS: str(s, 'status') }));
  } else {  // e14-element-set-model and E14's e14-s3-kc
    Object.assign(m, { FORM: E.ermModelForm.ElementSetModel, CALIBRATION_VERSION: str(j, 'calibrationVersion') ?? str(j, 'version'), STRATA_SETTINGS: strataIn(j, false),
      HORIZONS_DAYS: arr(j, 'horizonsDays'), MINIMUM_BIN_SAMPLES: big(num(j, 'minimumBinSamples', 0)), SOURCES: j.sources ?? [], POOLED: j.pooled === true });
    m.STRATA = (j.strata ?? []).map((s) => make(E.ERMModelStratumT, { REGIME: str(s, 'regime'), REGIME_INDEX: num(s, 'regimeIndex', 0), AGE_INDEX: num(s, 'ageIndex', 0),
      N: num(s, 'n', 0), COVARIANCE: arr(s, 'covariance') }));
    const cells = new Map();
    const cell = (s) => {
      const key = `${s.regimeIndex}/${s.ageIndex}`;
      if (!cells.has(key)) cells.set(key, make(E.ERMStratumFactorT, { REGIME_INDEX: s.regimeIndex, AGE_INDEX: s.ageIndex }));
      return cells.get(key);
    };
    for (const f of j.factors ?? []) cell(f).FACTOR = num(f, 'factor', NaN);
    for (const s of j.status ?? []) cell(s).STATUS = str(s, 'status');
    m.STRATUM_FACTORS = [...cells.values()];
    m.CELLS = (j.cells ?? []).map((c) => make(E.ERMRealismCellT, { REGIME_INDEX: c.regimeIndex, AGE_INDEX: c.ageIndex, DECISION: str(c, 'decision'),
      REALISM: make(E.CVRT, { REGIME: str(c, 'regime'), HORIZON_DAYS: num(c, 'horizonDays', NaN), MEAN_D2_OVER_3: num(c, 'meanD2Over3', NaN),
        COVERAGE_95: num(c, 'coverage95', NaN), SAMPLES: num(c, 'samples', 0), OBJECTS: num(c, 'objects', 0), CALIBRATION: CALIBRATION[c.calibration] ?? 0 }) }));
    if (has(j, 'measuredOn')) m.MEASURED_ON = make(E.ERMMeasuredOnT, { LINEAGES: j.measuredOn.lineages ?? [], WINDOW: str(j.measuredOn, 'window'),
      RULE: str(j.measuredOn, 'rule'), EVIDENCE: str(j.measuredOn, 'evidence') });
    if (has(j, 'provenance')) Object.assign(m, { PROVENANCE_REPOSITORY: str(j.provenance, 'repository'), PROVENANCE_COMMIT: str(j.provenance, 'commit'),
      PROVENANCE_FILES: Object.entries(j.provenance.files ?? {}).map(([NAME, SHA256]) => make(E.ERMProvenanceFileT, { NAME, SHA256 })) });
  }
  return m;
}
export function modelOut(m) {
  const j = {};
  if (m.ID) j.id = m.ID;
  if (m.CANDIDATE) j.candidate = m.CANDIDATE;
  if (m.LABEL) j.label = m.LABEL;
  switch (m.FORM) {
    case E.ermModelForm.StratifiedStatistics: {
      strataOut(m.STRATA_SETTINGS, j);
      Object.assign(j, { kind: 'gp-error-model', version: 1, mode: modeOut(m.BASIS), basis: m.BASIS_TEXT ?? '', propagator: m.PROPAGATOR ?? '', units: STRATIFIED_UNITS,
        counts: countsOut(m.COUNTS), quantileProbabilities: m.QUANTILE_PROBABILITIES });
      if (m.COVERAGE_MODEL) j.coverageModel = m.COVERAGE_MODEL;
      if (m.GATE) j.gate = gateOut(m.GATE);
      j.strata = m.STRATA.map((s) => {
        const x = { regime: s.REGIME ?? '', regimeIndex: s.REGIME_INDEX, ageIndex: s.AGE_INDEX, ageDays: [s.AGE_MIN_DAYS, s.AGE_MAX_DAYS], n: N(s.N), mean: s.MEAN };
        if (s.COVARIANCE.length) x.covariance = s.COVARIANCE;
        if (s.QUANTILES.length) { const w = s.QUANTILES.length / 6; x.quantiles = [0, 1, 2, 3, 4, 5].map((c) => s.QUANTILES.slice(c * w, (c + 1) * w)); }
        if (s.MEDIAN.length) x.median = s.MEDIAN;
        if (s.ROBUST_SIGMA.length) x.robustSigma = s.ROBUST_SIGMA;
        if (s.CLIPPED) {
          x.clipped = { k: s.CLIPPED.K, n: N(s.CLIPPED.N), fractionRemoved: s.CLIPPED.FRACTION_REMOVED };
          if (s.CLIPPED.MEAN.length) x.clipped.mean = s.CLIPPED.MEAN;
          if (s.CLIPPED.COVARIANCE.length) x.clipped.covariance = s.CLIPPED.COVARIANCE;
        }
        if (s.COVERAGE) x.coverage = coverageOut(s.COVERAGE, true);
        if (s.SCALE) x.scale = { factors: s.SCALE.FACTORS, truthN: N(s.SCALE.TRUTH_N) };
        else if (m.SCALE) x.scale = null;  // a scaled model's unscaled strata
        return x;
      });
      if (m.SCALE) j.scale = { basis: m.SCALE.BASIS ?? '', truthCounts: m.SCALE.TRUTH_COUNTS ? countsOut(m.SCALE.TRUTH_COUNTS) : null,
        truthWindow: m.SCALE.TRUTH_WINDOW || null, minimumSamples: m.SCALE.MINIMUM_SAMPLES };
      return j;
    }
    case E.ermModelForm.PropagatorCovariance: {
      Object.assign(j, { kind: 'ffm-covariance-model', version: 1, basis: m.BASIS_TEXT ?? '', units: FFM_UNITS });
      if (m.EPOCH_WINDOW_START || m.EPOCH_WINDOW_STOP) j.epochWindow = [m.EPOCH_WINDOW_START ?? '', m.EPOCH_WINDOW_STOP ?? ''];
      if (m.COUNTS) j.counts = countsOut(m.COUNTS, ['samples', 'targetsOutsideWindow', 'targetsWithoutPrediction']);
      j.regimes = m.PROPAGATOR_REGIMES.map((r) => {
        const x = { regimeIndex: r.REGIME_INDEX, regime: r.REGIME ?? '' };
        if (N(r.N)) x.n = N(r.N);
        if (N(r.KEPT)) x.kept = N(r.KEPT);
        if (r.OBJECTS) x.objects = r.OBJECTS;
        if (r.CLIP_K) x.clipK = r.CLIP_K;
        if (r.P0.length) x.p0 = r.P0;
        if (r.PROCESS_NOISE) {
          x.processNoise = noiseOut(r.PROCESS_NOISE);
          const f = r.FIT;
          if (f) x.processNoise.fit = { samples: N(f.SAMPLES), objects: f.OBJECTS, window: [f.WINDOW_START ?? '', f.WINDOW_STOP ?? ''],
            negativeLogLikelihoodQ0: f.NEGATIVE_LOG_LIKELIHOOD_Q0, negativeLogLikelihood: f.NEGATIVE_LOG_LIKELIHOOD, maximumLikelihoodM2S3: f.MAXIMUM_LIKELIHOOD_M2_S3,
            fitStrataCalibrated: { maximumLikelihood: f.CALIBRATED_STRATA_MAXIMUM_LIKELIHOOD, p0Alone: f.CALIBRATED_STRATA_P0_ALONE }, selected: f.SELECTED ?? '', rule: f.RULE ?? '' };
        }
        return x;
      });
      return j;
    }
    case E.ermModelForm.HorizonFactors: {
      Object.assign(j, { kind: 'e14-factors', version: m.CALIBRATION_VERSION ?? '' });
      strataOut(m.STRATA_SETTINGS, j);
      j.strata = m.HORIZON_FACTORS.map((f) => ({ horizonDays: [f.HORIZON_MIN_DAYS, f.HORIZON_MAX_DAYS], ...(f.REGIME ? { regime: f.REGIME } : {}),
        ...(f.AXES_FACTORS.length ? { axesFactors: f.AXES_FACTORS } : Number.isNaN(f.FACTOR) ? {} : { factor: f.FACTOR }), ...(f.STATUS ? { status: f.STATUS } : {}) }));
      return j;
    }
    default: {
      Object.assign(j, { kind: 'e14-element-set-model', version: m.CALIBRATION_VERSION ?? '' });
      if (m.CALIBRATION_VERSION) j.calibrationVersion = m.CALIBRATION_VERSION;
      if (m.BASIS_TEXT) j.basis = m.BASIS_TEXT;
      strataOut(m.STRATA_SETTINGS, j);
      if (m.HORIZONS_DAYS.length) j.horizonsDays = m.HORIZONS_DAYS;
      if (N(m.MINIMUM_BIN_SAMPLES)) j.minimumBinSamples = N(m.MINIMUM_BIN_SAMPLES);
      j.strata = m.STRATA.map((s) => ({ regimeIndex: s.REGIME_INDEX, ageIndex: s.AGE_INDEX, covariance: s.COVARIANCE, ...(s.REGIME ? { regime: s.REGIME } : {}),
        ...(N(s.N) ? { n: N(s.N) } : {}) }));
      const factors = m.STRATUM_FACTORS.filter((f) => !Number.isNaN(f.FACTOR)).map((f) => ({ regimeIndex: f.REGIME_INDEX, ageIndex: f.AGE_INDEX, factor: f.FACTOR }));
      const status = m.STRATUM_FACTORS.filter((f) => f.STATUS).map((f) => ({ regimeIndex: f.REGIME_INDEX, ageIndex: f.AGE_INDEX, status: f.STATUS }));
      if (factors.length) j.factors = factors;
      if (status.length) j.status = status;
      if (m.CELLS.length) j.cells = m.CELLS.map((c) => {
        const x = { regimeIndex: c.REGIME_INDEX, ageIndex: c.AGE_INDEX, decision: c.DECISION ?? '' };
        const v = c.REALISM;
        if (v) {
          if (v.REGIME) x.regime = v.REGIME;
          if (!Number.isNaN(v.HORIZON_DAYS)) x.horizonDays = v.HORIZON_DAYS;
          if (!Number.isNaN(v.MEAN_D2_OVER_3)) x.meanD2Over3 = v.MEAN_D2_OVER_3;
          if (!Number.isNaN(v.COVERAGE_95)) x.coverage95 = v.COVERAGE_95;
          x.samples = v.SAMPLES;
          x.objects = v.OBJECTS;
          if (v.CALIBRATION) x.calibration = calibrationOut(v.CALIBRATION);
        }
        return x;
      });
      if (m.MEASURED_ON) j.measuredOn = { lineages: m.MEASURED_ON.LINEAGES, window: m.MEASURED_ON.WINDOW ?? '', rule: m.MEASURED_ON.RULE ?? '', evidence: m.MEASURED_ON.EVIDENCE ?? '' };
      if (m.SOURCES.length) j.sources = m.SOURCES;
      if (m.POOLED) j.pooled = true;
      if (m.PROVENANCE_REPOSITORY || m.PROVENANCE_COMMIT || m.PROVENANCE_FILES.length)
        j.provenance = { repository: m.PROVENANCE_REPOSITORY ?? '', commit: m.PROVENANCE_COMMIT ?? '', files: Object.fromEntries(m.PROVENANCE_FILES.map((f) => [f.NAME, f.SHA256])) };
      return j;
    }
  }
}

// ── accumulator ──
const momentsIn = (j) => make(E.ERMMomentsT, { N: num(j, 'n', 0), SUM: arr(j, 'sum'), SQUARES: arr(j, 'sq') });
function accumulatorIn(j) {
  return make(E.ERMAccumulatorT, {
    STRATA_SETTINGS: strataIn(j, false), BASIS: MODE[j.mode] ?? 0, CLIP_K: num(j, 'clipK', 0), COUNTS: countsIn(j.counts), COVERAGE_MODEL: str(j, 'coverageModel'),
    STRATA: (j.strata ?? []).map((x) => make(E.ERMAccumulatorStratumT, {
      REGIME_INDEX: x.regime, AGE_INDEX: x.age, MOMENTS: momentsIn(x),
      HISTOGRAMS: (x.hist ?? []).map((h) => make(E.ERMHistogramT, { BINS: Object.entries(h).map(([b, c]) => new E.ERMHistogramBinT(Number(b), big(c))).sort((a, b) => a.BIN - b.BIN) })),
      CLIPPED: has(x, 'clip') ? momentsIn(x.clip) : null,
      COVERAGE: has(x, 'coverage') ? make(E.ERMCoverageTallyT, { N: x.coverage.n, MISSING: x.coverage.missing, SUM_D2: x.coverage.sumD2,
        INSIDE: (x.coverage.inside ?? []).map(big), PIT: (x.coverage.pit ?? []).map(big), OBJECTS: x.coverage.objects ?? [] }) : null,
    })),
  });
}
function accumulatorOut(a) {
  const j = strataOut(a.STRATA_SETTINGS, {});
  Object.assign(j, { kind: 'gp-error-accumulator', version: 1, mode: modeOut(a.BASIS), clipK: a.CLIP_K, counts: countsOut(a.COUNTS) });
  if (a.COVERAGE_MODEL) j.coverageModel = a.COVERAGE_MODEL;
  j.strata = a.STRATA.map((s) => {
    const x = { regime: s.REGIME_INDEX, age: s.AGE_INDEX, n: N(s.MOMENTS.N), sum: s.MOMENTS.SUM, sq: s.MOMENTS.SQUARES,
      hist: s.HISTOGRAMS.map((h) => Object.fromEntries(h.BINS.map((b) => [String(b.BIN), N(b.COUNT)]))) };
    if (s.CLIPPED) x.clip = { n: N(s.CLIPPED.N), sum: s.CLIPPED.SUM, sq: s.CLIPPED.SQUARES };
    if (s.COVERAGE) x.coverage = { n: N(s.COVERAGE.N), missing: N(s.COVERAGE.MISSING), sumD2: s.COVERAGE.SUM_D2, inside: s.COVERAGE.INSIDE.map(N),
      pit: s.COVERAGE.PIT.map(N), objects: s.COVERAGE.OBJECTS };
    return x;
  });
  return j;
}

// ── screening ──
const screeningSettingsIn = (j = {}) => make(E.ERMScreeningSettingsT, {
  STRATA_SETTINGS: ['regimes', 'ageBinsDays', 'referenceStepSeconds', 'clip'].some((k) => has(j, k)) ? strataIn(j, true) : null,
  HARD_BODY_RADIUS_M: num(j, 'hardBodyRadiusM', 20), PC_THRESHOLD: num(j, 'pcThreshold', 1e-4), NECESSITY_LEVEL: num(j, 'necessityLevel', 0.9973),
  BOUND_COVERAGE: num(j, 'boundCoverage', 0.9973), DIRECTIONS: num(j, 'directions', 4), MISS_DISTANCES_M: arr(j, 'missDistancesM'),
  PAIRS_PER_STRATUM: num(j, 'pairsPerStratum', 500), SEED: num(j, 'seed', 1) });
const rowsOut = (rows) => rows.map((r) => ({ missM: r.MISS_M, collision: r.COLLISION, cases: r.CASES, pcAlertRate: r.PC_ALERT_RATE, meanPc: r.MEAN_PC,
  brier: r.BRIER, boundedSetAlertRate: r.BOUNDED_SET_ALERT_RATE, possibilityAlertRate: r.POSSIBILITY_ALERT_RATE, meanPossibilityOfCollision: r.MEAN_POSSIBILITY_OF_COLLISION }));
function screeningReportOut(r) {
  const d = r.DEFINITIONS;
  const cases = (d?.CASES ?? '').startsWith('caller-supplied');
  const s = r.SETTINGS;
  const settings = { hardBodyRadiusM: s.HARD_BODY_RADIUS_M, pcThreshold: s.PC_THRESHOLD, necessityLevel: s.NECESSITY_LEVEL, boundCoverage: s.BOUND_COVERAGE,
    directions: s.DIRECTIONS, missDistancesM: s.MISS_DISTANCES_M, ...(cases ? {} : { pairsPerStratum: s.PAIRS_PER_STRATUM }) };
  const definitions = d ? { cases: d.CASES, collision: d.COLLISION, probabilistic: d.PROBABILISTIC, boundedSet: d.BOUNDED_SET, possibility: d.POSSIBILITY,
    missedCollision: d.MISSED_COLLISION, falseAlert: d.FALSE_ALERT } : null;
  const summary = Object.fromEntries(r.SUMMARY.map((g) => [g.GEOMETRY, rowsOut(g.ROWS)]));
  if (cases) return { kind: 'screening-cases', version: 1, pairs: r.COUNTS?.PAIRS ?? 0, definitions, settings, summary };
  return { kind: 'screening-evaluation', version: 1, counts: countsOut(r.COUNTS), definitions, settings, summary,
    strata: r.STRATA.map((x) => ({ regime: x.REGIME ?? '', regimeIndex: x.REGIME_INDEX, ageIndex: x.AGE_INDEX, ageDays: [x.AGE_MIN_DAYS, x.AGE_MAX_DAYS],
      objects: x.OBJECTS, samples: N(x.SAMPLES), pairs: x.PAIRS, sigmaRtnKm: x.SIGMA_RTN_KM, geometries: x.GEOMETRIES.map((g) => ({ geometry: g.GEOMETRY, rows: rowsOut(g.ROWS) })) })) };
}

// ── FFM ──
const planIn = (j) => make(E.ERMArcPlanT, {
  TARGET_AGES_DAYS: arr(j, 'targetAgesDays'), EPOCH_TOLERANCE_S: num(j, 'epochToleranceSeconds', 0), TARGET_TOLERANCE_S: num(j, 'targetToleranceSeconds', 0),
  COVARIANCE_NOTE: str(j, 'covariance'), TRUTH_NOTE: str(j, 'truth'), COUNTS: has(j, 'counts') ? countsIn(j.counts) : null,
  ARCS: (j.arcs ?? []).map((a) => make(E.ERMArcT, { ARC: num(a, 'arc', 0), NORAD_CAT_ID: num(a, 'norad', 0), EPOCH: str(a, 'epoch'), REGIME_INDEX: num(a, 'regimeIndex', 0),
    REGIME: str(a, 'regime'), COVARIANCE: arr(a, 'covariance'), PROCESS_NOISE: has(a, 'processNoise') ? noiseIn(a.processNoise) : null,
    TARGETS: (a.targets ?? []).map((t) => make(E.ERMArcTargetT, { NOMINAL_DAYS: num(t, 'nominalDays', 0), AGE_DAYS: num(t, 'ageDays', 0), EPOCH: str(t, 'epoch'), TRUTH: arr(t, 'truth') })) })) });
const planOut = (p) => ({ kind: 'ffm-arc-plan', version: 1, targetAgesDays: p.TARGET_AGES_DAYS, epochToleranceSeconds: p.EPOCH_TOLERANCE_S, targetToleranceSeconds: p.TARGET_TOLERANCE_S,
  covariance: p.COVARIANCE_NOTE ?? '', truth: p.TRUTH_NOTE ?? '',
  counts: countsOut(p.COUNTS, [...BASE, 'arcs', 'targets', 'setsWithoutReference', 'setsWithoutTargets', 'arcsWithoutModelRegime']),
  arcs: p.ARCS.map((a) => ({ arc: a.ARC, norad: a.NORAD_CAT_ID, epoch: a.EPOCH ?? '', regimeIndex: a.REGIME_INDEX, regime: a.REGIME ?? '',
    targets: a.TARGETS.map((t) => ({ nominalDays: t.NOMINAL_DAYS, ageDays: t.AGE_DAYS, epoch: t.EPOCH ?? '', truth: t.TRUTH })),
    ...(a.COVARIANCE.length ? { covariance: a.COVARIANCE } : {}), ...(a.PROCESS_NOISE ? { processNoise: noiseOut(a.PROCESS_NOISE) } : {}) })) });
const predictionsIn = (j) => make(E.ERMArcPredictionsT, { ARCS: (j.arcs ?? []).map((a) => make(E.ERMArcPredictionT, { ARC: num(a, 'arc', 0),
  SAMPLES: (a.samples ?? []).map((s) => (s == null ? new E.ERMPredictionSampleT() : make(E.ERMPredictionSampleT, { STATE: arr(s, 'state'), P0_POSITION: arr(s, 'a'),
    NOISE_RESPONSES: (s.u ?? []).flat() }))) })) });
const COVERAGE_MODE = { epoch: E.ermCoverageMode.EpochCovariance, fit: E.ermCoverageMode.ProcessNoise, test: E.ermCoverageMode.CoverageTest };
const coverageOptionsIn = (j) => make(E.ERMCoverageOptionsT, { MODE: COVERAGE_MODE[j.mode] ?? E.ermCoverageMode.CoverageTest, WINDOW_START: j.window?.[0] ?? null,
  WINDOW_STOP: j.window?.[1] ?? null, STRATA_SETTINGS: strataIn(j, true), GATE: has(j, 'gate') ? gateIn(j.gate) : null, CLIP_K: num(j, 'clipK', 5),
  DISCRETIZATION_S: num(j, 'discretizationSeconds', 600) });
const propagatorCoverageOut = (r) => ({ kind: 'ffm-covariance-coverage', version: 1, window: [r.WINDOW_START ?? '', r.WINDOW_STOP ?? ''], gate: r.GATE ? gateOut(r.GATE) : null,
  counts: countsOut(r.COUNTS, ['samples', 'targetsOutsideWindow', 'targetsWithoutPrediction', 'outsideAgeBins', 'withoutCovariance', 'notPositiveDefinite']),
  strata: r.STRATA.map((s) => ({ regime: s.REGIME ?? '', regimeIndex: s.REGIME_INDEX, ageIndex: s.AGE_INDEX, ageDays: [s.AGE_MIN_DAYS, s.AGE_MAX_DAYS],
    rmsErrorRtnKm: s.RMS_ERROR_RTN_KM, rmsSigmaRtnKm: s.RMS_SIGMA_RTN_KM, rmsSigmaP0OnlyRtnKm: s.RMS_SIGMA_P0_ONLY_RTN_KM, spectralDensityM2S3: s.SPECTRAL_DENSITY_M2_S3,
    coverage: coverageOut(s.COVERAGE, false), coverageP0Only: coverageOut(s.COVERAGE_P0_ONLY, false) })) });

// ── common epoch, covariance maps ──
const ORIGIN = { reference: E.ermDifferenceOrigin.ReferenceState, mean: E.ermDifferenceOrigin.SetMean, set: E.ermDifferenceOrigin.OneSet };
const ORIGIN_NAME = Object.fromEntries(Object.entries(ORIGIN).map(([k, v]) => [v, k]));
const commonEpochIn = (j) => make(E.ERMCommonEpochT, { REQUESTS: (j.targets ?? []).map((t) => make(E.ERMCommonEpochTargetT, { NORAD_CAT_ID: num(t, 'norad', 0),
  EPOCH: str(t, 'epoch'), SETS: t.sets ?? [], ORIGIN: ORIGIN[t.origin ?? 'reference'] ?? 0, AFTER_S: num(t, 'afterSeconds', 0), ORIGIN_SET: str(t, 'originSet') })) });
const commonEpochOut = (c) => ({ kind: 'common-epoch', version: 1, units: c.UNITS ?? '',
  counts: countsOut(c.COUNTS, ['elementSets', 'refused', 'duplicateEpochs', 'targets', 'missingTargets', 'missingSets', 'differences']),
  targets: c.RESULTS.map((r) => {
    const x = { norad: r.NORAD_CAT_ID, origin: ORIGIN_NAME[r.ORIGIN], epoch: r.EPOCH ?? '' };
    if (r.MISSING) {
      x.missing = r.MISSING;
      if (r.MISSING !== 'no reference state') x.missingSets = r.MISSING_SETS;
      return x;
    }
    if (r.ORIGIN_SET) x.originSet = r.ORIGIN_SET;
    x.state = r.STATE;
    x.sets = r.SETS.map((s) => ({ epoch: s.EPOCH ?? '', ageDays: s.AGE_DAYS, rtn: s.RTN }));
    if (r.MISSING_SETS.length) x.missingSets = r.MISSING_SETS;
    return x;
  }) });
const METHOD = { sgp4: E.ermMapMethod.Sgp4, 'two-body': E.ermMapMethod.TwoBody, lambert: E.ermMapMethod.Lambert };
const METHOD_NAME = Object.fromEntries(Object.entries(METHOD).map(([k, v]) => [v, k]));
const covarianceMapIn = (j) => make(E.ERMCovarianceMapT, { REQUESTS: (j.requests ?? []).map((r) => make(E.ERMMapRequestT, { NORAD_CAT_ID: num(r, 'norad', 0),
  SET_EPOCH: str(r, 'set'), COVARIANCE: arr(r, 'covariance'), TO_EPOCHS: r.to ?? [], FROM_EPOCH: str(r, 'from'), METHOD: METHOD[r.method ?? 'sgp4'] ?? 0,
  INCLUDE_STM: r.stm === true, AXES_SET: str(r, 'axesSet') })) });
const covarianceMapOut = (c) => ({ kind: 'covariance-map', version: 1, units: c.UNITS ?? '',
  counts: countsOut(c.COUNTS, ['elementSets', 'refused', 'duplicateEpochs', 'mapped', 'failed']),
  results: c.RESULTS.map((r) => {
    const x = { norad: r.NORAD_CAT_ID, set: r.SET_EPOCH ?? '', method: METHOD_NAME[r.METHOD] };
    if (r.FROM_EPOCH) x.from = r.FROM_EPOCH;
    if (r.AXES_SET) x.axesSet = r.AXES_SET;
    if (r.ERROR) { x.error = r.ERROR; return x; }
    x.targets = r.TARGETS.map((t) => {
      const y = { epoch: t.EPOCH ?? '' };
      if (t.LAMBERT) y.lambert = { revolutions: t.LAMBERT.REVOLUTIONS, branch: t.LAMBERT.BRANCH ?? '', v1: t.LAMBERT.V1_KM_S, energy: t.LAMBERT.ENERGY,
        sgp4Energy: t.LAMBERT.SGP4_ENERGY, perigeeRadiusKm: t.LAMBERT.PERIGEE_RADIUS_KM };
      if (t.ERROR) { y.error = t.ERROR; return y; }
      y.covariance = t.COVARIANCE;
      if (t.STM.length) y.stm = t.STM;
      return y;
    });
    return x;
  }) });

// ── covariance realism ──
const AXES = { RTN: E.ermCovarianceAxes.Rtn, UVW: E.ermCovarianceAxes.Uvw, INERTIAL: E.ermCovarianceAxes.Inertial };
const sideIn = (s) => (s == null ? null : make(E.ERMPairSideT, { EPOCH: str(s, 'epoch'), POSITION_M: arr(s, 'position'), VELOCITY_M_S: arr(s, 'velocity'),
  COVARIANCE: (s.covariance ?? []).flat(), COVARIANCE_TERMS: (s.covarianceTerms ?? []).map((t) => make(E.ERMWeightedCovarianceT, { WEIGHT: num(t, 'weight', 1),
    COVARIANCE: (t.covariance ?? []).flat() })), COVARIANCE_AXES: AXES[s.covarianceAxes ?? 'RTN'] ?? 0,
  SAMPLES: (s.samples ?? []).map((x) => make(E.ERMStateSampleT, { EPOCH: str(x, 'epoch'), POSITION_M: arr(x, 'position'), VELOCITY_M_S: arr(x, 'velocity'),
    COVARIANCE: (x.covariance ?? []).flat() })), INTERPOLATION_DEGREE: num(s, 'interpolationDegree', 5) }));
const pairsIn = (j) => make(E.ERMPairStatisticsT, { AXES_FROM: j.axesFrom === 'truth' ? E.ermAxesSource.Truth : E.ermAxesSource.Predicted,
  PAIRS: (j.pairs ?? []).map((p) => make(E.ERMStatePairT, { ID: id(p.id), PREDICTED: sideIn(p.predicted), TRUTH: sideIn(p.truth) })) });
const nan = (x) => (Number.isNaN(x) ? null : x);
const pairStatisticsOut = (p) => ({ kind: 'e14-pair-statistics', version: 1, axes: p.AXES_FROM === E.ermAxesSource.Truth ? 'RTN of the truth state' : 'RTN of the predicted state',
  units: p.UNITS ?? '', counts: countsOut(p.COUNTS, ['pairs', 'notPositiveDefinite', 'withoutTruthCovariance']),
  pairs: p.STATISTICS.map((s) => (s.MISSING ? { id: s.ID ?? null, missing: s.MISSING } : {
    id: s.ID ?? null, errorRtn: s.ERROR_RTN_M, velocityErrorRtn: s.VELOCITY_ERROR_RTN_M_S,
    predictedInterpolated: s.INTERPOLATION_SAMPLES ? { degree: s.INTERPOLATION_DEGREE, from: s.INTERPOLATION_FROM, samples: s.INTERPOLATION_SAMPLES } : null,
    predictedRtn: s.PREDICTED_RTN, truthRtn: s.TRUTH_RTN.length ? s.TRUTH_RTN : null, d2Combined: nan(s.D2_COMBINED), logDetCombined: nan(s.LOG_DET_COMBINED),
    d2Predicted: nan(s.D2_PREDICTED), zCombined: s.Z_COMBINED, zPredicted: s.Z_PREDICTED })) });
const FIT = { 'scalar-mle': E.ermCalibrationFit.ScalarMle, 'axes-mle': E.ermCalibrationFit.AxesMle, coverage: E.ermCalibrationFit.CoverageTarget };
const FIT_NAME = Object.fromEntries(Object.entries(FIT).map(([k, v]) => [v, k]));
const calibrationIn = (j = {}) => make(E.ERMCalibrationT, { METHOD: FIT[j.method ?? 'scalar-mle'] ?? 0, COVERAGE: num(j, 'coverage', 0.95),
  MINIMUM_SAMPLES: num(j, 'minimumSamples', 1), MINIMUM_OBJECTS: num(j, 'minimumObjects', 1),
  SAMPLES: (j.samples ?? []).map((s) => make(E.ERMCalibrationSampleT, { STRATUM: str(s, 'stratum'), OBJECT: id(s.object), ERROR: arr(s, 'error'), COVARIANCE: (s.covariance ?? []).flat() })) });
const summary = (m, c) => (Number.isNaN(m) && Number.isNaN(c) ? undefined : { meanD2Over3: m, coverage95: c });
const calibrationOutJ = (c) => ({ kind: 'e14-calibration', version: 1, method: FIT_NAME[c.METHOD], coverage: c.COVERAGE, rule: c.RULE ?? '',
  strata: c.STRATA.map((s) => {
    const x = { stratum: s.STRATUM ?? '', n: N(s.N), objects: s.OBJECTS, notPositiveDefinite: s.NOT_POSITIVE_DEFINITE,
      status: s.STATUS === E.ermFitStatus.Fitted ? 'FITTED' : s.STATUS === E.ermFitStatus.Insufficient ? 'INSUFFICIENT' : '' };
    const before = summary(s.BEFORE_MEAN_D2_OVER_3, s.BEFORE_COVERAGE_95);
    if (before) x.before = before;
    if (!Number.isNaN(s.FACTOR)) x.factor = s.FACTOR;
    if (s.AXES_FACTORS.length) x.axesFactors = s.AXES_FACTORS;
    const after = summary(s.AFTER_MEAN_D2_OVER_3, s.AFTER_COVERAGE_95);
    if (after) x.after = after;
    return x;
  }) });
const objectsIn = (j) => make(E.ERMCalibratedCovariancesT, { OBJECTS: (j.objects ?? []).map((o) => make(E.ERMCalibrationObjectT, { ID: id(o.id), REGIME: str(o, 'regime'),
  SET_NORAD_CAT_ID: num(o.set, 'norad', 0), SET_EPOCH: str(o.set, 'epoch'), POSITION_M: arr(o.state, 'position'), VELOCITY_M_S: arr(o.state, 'velocity'),
  OBJECT_FACTOR: num(o, 'objectFactor', 1), AGE_DAYS: num(o, 'ageDays', NaN), HORIZON_DAYS: num(o, 'horizonDays', NaN), COVARIANCE: (o.covariance ?? []).flat(),
  COVARIANCE_AXES: AXES[o.covarianceAxes ?? 'RTN'] ?? 0 })) });
const calibratedOut = (c) => ({ kind: 'e14-calibrated-covariance', version: 1, calibrationVersion: c.CALIBRATION_VERSION ?? '',
  model: c.MODEL_FORM === E.ermModelForm.ElementSetModel ? 'e14-element-set-model' : 'e14-factors', units: c.UNITS ?? '', rule: c.RULE ?? '',
  counts: countsOut(c.COUNTS, ['objects', 'outsideRegimes']),
  objects: c.RESULTS.map((r) => {
    const x = { id: r.ID ?? null, regime: r.REGIME || null, status: r.STATUS ?? '' };
    if (r.AGE_INDEX >= 0 || !Number.isNaN(r.AGE_DAYS)) x.cell = { ageIndex: r.AGE_INDEX, ageDays: r.AGE_DAYS };
    else if (!Number.isNaN(r.HORIZON_MIN_DAYS)) x.cell = { horizonDays: [r.HORIZON_MIN_DAYS, r.HORIZON_MAX_DAYS] };
    if (!Number.isNaN(r.FACTOR)) x.factor = r.FACTOR;
    if (r.AXES_FACTORS.length) x.axesFactors = r.AXES_FACTORS;
    if (r.COVARIANCE_RTN.length) x.covarianceRtn = r.COVARIANCE_RTN;
    if (r.COVARIANCE_INERTIAL.length) x.covarianceInertial = r.COVARIANCE_INERTIAL;
    return x;
  }) });
const dcpIn = (j) => make(E.ERMConsiderCovariancesT, { LEAD_DAYS: (j.leadCovariance ?? []).length, LEAD_COVARIANCE: (j.leadCovariance ?? []).flat(), START: str(j, 'start'),
  SEGMENTS: (j.segments ?? []).map((s) => make(E.ERMDensitySegmentT, { FROM_EPOCH: str(s, 'from'), TO_EPOCH: str(s, 'to'), LEAD: num(s, 'lead', 0) })),
  BALLISTIC_COEFFICIENT: num(j, 'ballisticCoefficient', 0), START_STM: arr(j.startSample, 'stm'), START_S: arr(j.startSample, 's'),
  EPOCHS: (j.epochs ?? []).map((e) => make(E.ERMConsiderEpochT, { EPOCH: str(e, 'epoch'), SENSITIVITY: arr(e, 'sensitivity'), STM: arr(e, 'stm'), S: arr(e, 's'), BASE: arr(e, 'base') })) });
const dcpOut = (c) => ({ kind: 'e14-dcp', version: 1, start: c.START ?? '', leadDays: c.LEAD_DAYS, rule: c.RULE ?? '',
  epochs: c.RESULTS.map((r) => ({ epoch: r.EPOCH ?? '', secondsFromStart: r.SECONDS_FROM_START, sigmaEff: r.SIGMA_EFFECTIVE, weights: r.WEIGHTS, weightCovered: r.WEIGHT_COVERED,
    sensitivity: r.SENSITIVITY, covariance: r.COVARIANCE, ...(r.TOTAL.length ? { total: r.TOTAL } : {}) })) });
const noiseRequestIn = (j) => make(E.ERMNoiseResponsesT, { START: str(j, 'start'), DISCRETIZATION_S: num(j, 'discretizationSeconds', 600),
  SAMPLES: (j.samples ?? []).map((s) => make(E.ERMStmSampleT, { EPOCH: str(s, 'epoch'), STATE: arr(s, 'state'), STM: arr(s, 'stm') })), TARGET_EPOCHS: j.targets ?? [] });
const noiseResponsesOut = (n) => ({ kind: 'e14-noise-responses', version: 1, discretizationSeconds: n.DISCRETIZATION_S, start: n.START ?? '', units: n.UNITS ?? '',
  targets: n.RESULTS.map((r) => {
    const w = r.RESPONSES.length / 3;
    return { epoch: r.EPOCH ?? '', steps: r.STEPS, ...(Number.isNaN(r.STEP_S) ? {} : { stepSeconds: r.STEP_S }), u: [0, 1, 2].map((k) => r.RESPONSES.slice(k * w, (k + 1) * w)) };
  }) });

// ── element fits ──
const EPOCH_CHOICE = { first: E.ermFitEpochChoice.First, last: E.ermFitEpochChoice.Last, middle: E.ermFitEpochChoice.Middle };
const WEIGHTING = { uniform: E.ermFitWeighting.Uniform, rtn: E.ermFitWeighting.RtnSigmas, covariance: E.ermFitWeighting.EphemerisCovariance };
function fitSettingsIn(j = {}, norad = 0) {
  const s = make(E.ERMFitSettingsT, { NORAD_CAT_ID: norad, FROM_EPOCH: str(j, 'from'), TO_EPOCH: str(j, 'to'), STEP_S: num(j, 'stepSeconds', 0),
    FIT_BSTAR: j.fitBstar ?? true, WEIGHTING: WEIGHTING[j.weighting ?? 'uniform'] ?? 0, SIGMA_RTN_KM: arr(j, 'sigmaRtnKm'), VELOCITY: j.velocity === true,
    SIGMA_VELOCITY_KM_S: num(j, 'sigmaVelocityKmS', 0.001), HALF_LIFE_HOURS: num(j, 'halfLifeHours', 0), TOWARDS: j.towards === 'start' ? E.ermFitFavour.SpanStart : E.ermFitFavour.SpanEnd,
    MAX_ITERATIONS: num(j, 'maxIterations', 100), TOLERANCE: num(j, 'tolerance', 1e-10), FLOOR_KM: num(j, 'floorKm', 1e-6),
    INITIAL: j.initial === 'apriori' ? E.ermFitStart.FromApriori : E.ermFitStart.FromEphemeris, REJECT_SIGMA: num(j, 'rejectSigma', 0),
    SCALE_COVARIANCE: j.scaleCovariance === true, HAS_SCALE_COVARIANCE: typeof j.scaleCovariance === 'boolean', RESIDUALS: j.residuals === true, CLOSURE: j.closure ?? true,
    EPHEMERIS_STREAM: num(j, 'ephemerisStream', -1), ORIGINATOR: str(j, 'originator'), CREATION_DATE: str(j, 'creationDate'), CLASSIFICATION: str(j, 'classification'),
    COMMENT: str(j, 'comment'), OBJECT_NAME: str(j, 'objectName'), OBJECT_ID: str(j, 'objectId'), ELEMENT_SET_NO: num(j, 'elementSetNo', 0) });
  if (has(j, 'epoch')) {
    if (j.epoch in EPOCH_CHOICE) s.EPOCH_CHOICE = EPOCH_CHOICE[j.epoch];
    else { s.EPOCH_CHOICE = E.ermFitEpochChoice.GivenEpoch; s.EPOCH = j.epoch; }
  }
  if (j.bstar === 'apriori') s.BSTAR_FROM_APRIORI = true;
  else if (typeof j.bstar === 'number') s.BSTAR = j.bstar;
  return s;
}
// Fit options: the shared settings, and per object the shared settings with that object's overrides.
const fitOptionsIn = (j = {}) => {
  const { fits, ...shared } = j;
  return make(E.ERMElementFitsT, { OPTIONS: make(E.ERMFitOptionsT, { SHARED: fitSettingsIn(shared),
    FITS: (fits ?? []).map(({ norad, ...own }) => fitSettingsIn({ ...shared, ...own }, norad)) }) });
};
const residualRequestsIn = (j) => make(E.ERMElementFitsT, { INCLUDE_SAMPLES: j.samples === true,
  RESIDUAL_REQUESTS: (j.requests ?? []).map((r) => make(E.ERMResidualRequestT, { NORAD_CAT_ID: num(r, 'norad', 0), SET_EPOCH: str(r, 'set'), STEP_S: num(r, 'stepSeconds', 0),
    EPHEMERIS_STREAM: num(r, 'ephemerisStream', -1), LABEL: str(r, 'label'),
    WINDOWS: (r.windows ?? []).map((w) => make(E.ERMResidualStatisticsT, { FROM_EPOCH: str(w, 'from'), TO_EPOCH: str(w, 'to'), LABEL: str(w, 'label') })) })) });
function statsOut(s, window) {
  const j = {};
  if (window) { j.from = s.FROM_EPOCH ?? ''; j.to = s.TO_EPOCH ?? ''; if (s.LABEL) j.label = s.LABEL; }
  j.n = s.N;
  if (s.N) {
    Object.assign(j, { span: [s.SPAN_START ?? '', s.SPAN_STOP ?? ''], rms3dKm: s.RMS_3D_KM, rmsPerCoordinateKm: s.RMS_PER_COORDINATE_KM, rmsRtnKm: s.RMS_RTN_KM,
      meanRtnKm: s.MEAN_RTN_KM, max3dKm: s.MAX_3D_KM, maxAt: s.MAX_AT ?? '', maxRtnKm: s.MAX_RTN_KM });
    if (!Number.isNaN(s.RMS_VELOCITY_KM_S)) j.rmsVelocityKmS = s.RMS_VELOCITY_KM_S;
  }
  j.failures = s.FAILURES;
  if (s.SAMPLES.length) j.samples = s.SAMPLES.map((x) => [x.EPOCH, x.R_KM, x.T_KM, x.N_KM]);
  return j;
}
function elementFitsOut(f) {
  if ((f.RESIDUAL_SIGN ?? '').startsWith('prediction')) {
    return { kind: 'element-residuals', version: 1, model: f.MODEL ?? '', residualSign: f.RESIDUAL_SIGN, units: f.UNITS ?? '',
      counts: countsOut(f.COUNTS, ['elementSets', 'refused', 'states', 'duplicateEpochs']),
      results: f.RESIDUAL_RESULTS.map((r) => ({ norad: r.NORAD_CAT_ID, set: r.SET_EPOCH ?? '', ...(r.LABEL ? { label: r.LABEL } : {}),
        ...(r.ERROR ? { error: r.ERROR } : { windows: r.WINDOWS.map((w) => statsOut(w, true)) }) })) };
  }
  return { kind: 'element-fit', version: 1, model: f.MODEL ?? '', residualSign: f.RESIDUAL_SIGN ?? '', units: f.UNITS ?? '',
    counts: countsOut(f.COUNTS, ['streams', 'blocks', 'states', 'duplicateEpochs', 'covariances', 'frames', 'aprioriSets', 'fitted', 'failed']),
    fits: f.FITS.map((r) => {
      const x = { norad: r.NORAD_CAT_ID };
      if (r.OBJECT_NAME) x.objectName = r.OBJECT_NAME;
      if (!r.STAGES.length && r.ERROR && !r.CRITERION) { x.error = r.ERROR; return x; }
      Object.assign(x, { states: { inSpan: r.STATES_IN_SPAN, fitted: r.STATES_FITTED, withoutWeights: r.STATES_WITHOUT_WEIGHTS, rejected: r.STATES_REJECTED },
        stages: r.STAGES.map((s) => ({ start: s.START ?? '', halfWidthSeconds: nan(s.HALF_WIDTH_S), states: s.STATES, iterations: s.ITERATIONS, stop: s.STOP ?? '' })),
        iterations: r.ITERATIONS, converged: r.CONVERGED, stop: r.STOP ?? '', criterion: r.CRITERION ?? '' });
      if (r.ERROR) { x.error = r.ERROR; return x; }
      if (r.RMS) x.rms = statsOut(r.RMS, false);
      if (r.RESIDUALS.length) x.residuals = r.RESIDUALS.map((s) => [s.EPOCH, s.R_KM, s.T_KM, s.N_KM]);
      if (r.CLOSURE) {
        const c = r.CLOSURE;
        x.closure = { definition: c.DEFINITION ?? '' };
        if (c.SPLIT_EPOCH) Object.assign(x.closure, { splitEpoch: c.SPLIT_EPOCH, fitStates: c.FIT_STATES, iterations: c.ITERATIONS });
        if (c.ERROR) x.closure.error = c.ERROR;
        else if (c.RMS) x.closure.rms = statsOut(c.RMS, false);
      }
      x.weightedRms = r.WEIGHTED_RMS;
      if (!Number.isNaN(r.CONDITION_NUMBER)) x.conditionNumber = r.CONDITION_NUMBER;
      if (r.COVARIANCE) {
        const c = r.COVARIANCE;
        x.covariance = { parameters: c.PARAMETERS };
        if (c.EQUINOCTIAL.length) Object.assign(x.covariance, { equinoctial: c.EQUINOCTIAL, scale: c.SCALE, classical: c.CLASSICAL.length ? c.CLASSICAL : null });
        if (c.CLASSICAL_UNITS) x.covariance.classicalUnits = c.CLASSICAL_UNITS;
        if (c.CARTESIAN_RSW.length) Object.assign(x.covariance, { cartesianRsw: c.CARTESIAN_RSW, cartesianUnits: c.CARTESIAN_UNITS ?? '' });
      }
      Object.assign(x, { epoch: r.EPOCH ?? '', equinoctial: r.EQUINOCTIAL, bstar: { fitted: r.BSTAR_FITTED, initial: r.BSTAR_INITIAL } });
      return x;
    }) };
}

// ── attach report ──
const KIND_NAME = { 1: 'element-set', 2: 'ephemeris', 3: 'observation' };
const LICENCE_NAME = { 1: 'reproducible', 2: 'cite-only', 3: 'share-alike', 4: 'non-commercial' };
const sourceOut = (p) => ({ id: p.SOURCE_ID ?? '', kind: KIND_NAME[p.SOURCE_KIND] ?? '', lineage: p.LINEAGE ?? '', originator: p.ORIGINATOR ?? '', provider: p.PROVIDER_ID ?? '',
  licence: { class: LICENCE_NAME[p.LICENSE_CLASS] ?? '', id: p.LICENSE_ID ?? '' } });
function labelOut(l) {
  const v = l.REALISM ?? new E.CVRT();
  const j = { rule: v.RULE, method: l.METHOD ?? '', calibration: calibrationOut(v.CALIBRATION), basis: l.BASIS ?? '' };
  if (v.MODEL_ID) j.model = v.MODEL_ID;
  if (v.REGIME) j.regime = v.REGIME;
  if (!Number.isNaN(v.AGE_DAYS)) j.ageDays = v.AGE_DAYS;
  if (l.AGE_INDEX >= 0) j.cell = { ageIndex: l.AGE_INDEX, horizonDays: nan(v.HORIZON_DAYS) };
  if (l.VERDICT) j.verdict = l.VERDICT;
  if (!Number.isNaN(v.MEAN_D2_OVER_3)) j.meanD2Over3 = v.MEAN_D2_OVER_3;
  if (!Number.isNaN(v.COVERAGE_95)) j.coverage95 = v.COVERAGE_95;
  if (v.SAMPLES) j.samples = v.SAMPLES;
  if (v.OBJECTS) j.objects = v.OBJECTS;
  if (!Number.isNaN(v.SCALE_FACTOR)) j.scaleFactor = v.SCALE_FACTOR;
  if (v.TEST_WINDOW) j.window = v.TEST_WINDOW;
  if (v.EVIDENCE) j.evidence = v.EVIDENCE;
  if (v.MEASURED_LINEAGE) j.measuredLineage = v.MEASURED_LINEAGE;
  j.epoch = l.EPOCH ?? '';
  return j;
}
function attachReportOut(r) {
  const source = sourceOut(r.SOURCE ?? new E.PVNT());
  if (r.SOURCE?.PRODUCER) return { version: 1, maneuvers: r.COUNTS?.MANEUVERS ?? 0, source, producer: r.SOURCE.PRODUCER };
  const refused = (x) => ({ ...(x.OBJECT_KEY ? { object: x.OBJECT_KEY } : {}), record: x.RECORD, reason: x.REASON ?? '' });
  return { version: 1, source,
    counts: countsOut(r.COUNTS, ['elementSets', 'objects', 'rule1', 'rule2', 'rule3', 'rule4', 'withoutCovariance', 'calibratedRows', 'uncalibratedRows', 'statesOfOlderSets']),
    refusedElementSets: r.REFUSED_ELEMENT_SETS.map(refused),
    unmatched: { states: r.UNMATCHED_STATES.map((x) => ({ object: x.OBJECT_KEY ?? '', first: x.FIRST ?? '' })), operator: r.UNMATCHED_OPERATOR.map((x) => ({ object: x.OBJECT_KEY ?? '' })) },
    objects: r.OBJECTS.map((o) => {
      const x = { object: o.OBJECT_KEY ?? '', epoch: o.EPOCH ?? '', theory: o.THEORY ?? '', ommSha256: o.OMM_SHA256 ?? '' };
      if (o.OCM_SHA256) x.ocmSha256 = o.OCM_SHA256;
      if (o.RULE) Object.assign(x, { rule: o.RULE, method: o.METHOD ?? '', product: o.PRODUCT ?? '', calibrated: o.CALIBRATED, ommCovariance: o.OMM_COVARIANCE ?? '',
        rows: o.ROWS.map(labelOut) });
      else x.rule = null;
      x.notes = o.NOTES.map((n) => ({ rule: n.RULE, reason: n.REASON ?? '', ...(n.ROW ? { row: n.ROW } : {}), ...(Number.isNaN(n.AGE_DAYS) ? {} : { ageDays: n.AGE_DAYS }) }));
      x.licence = source.licence;
      return x;
    }) };
}

// ── records and frames ──
// The arm of each method's $ERM input ports.
export const ARM_OF = {
  accumulate: { options: 'strata', model: 'model', prior: 'accumulator' },
  finalize: { accumulator: 'accumulator', options: 'gate' },
  scale_model: { model: 'model', truth: 'model', options: 'scale' },
  screening_evaluation: { model: 'model', options: 'screeningSettings' },
  screening_cases: { cases: 'screeningCases', options: 'screeningSettings' },
  ffm_arcs: { model: 'model', options: 'arcOptions' },
  ffm_coverage: { plan: 'plan', predictions: 'predictions', model: 'model', options: 'coverageOptions' },
  common_epoch: { options: 'commonEpoch' },
  map_covariance: { options: 'covarianceMap' },
  pair_statistics: { pairs: 'pairs' },
  fit_calibration: { samples: 'calibration', options: 'calibration' },
  calibrate_covariance: { model: 'model', objects: 'objects' },
  dcp_covariance: { request: 'dcp' },
  noise_responses: { request: 'noise' },
  fit_elements: { options: 'fitOptions' },
  element_residuals: { options: 'residualRequests' },
};

const ARMS = {
  model: (j) => ({ MODEL: modelIn(j) }), accumulator: (j) => ({ ACCUMULATOR: accumulatorIn(j) }), strata: (j) => ({ STRATA_SETTINGS: strataIn(j, true) }),
  gate: (j) => ({ GATE: gateIn(j.gate ?? j) }), scale: (j) => ({ SCALE_OPTIONS: make(E.ERMScaleOptionsT, { MINIMUM_SAMPLES: num(j, 'minimumSamples', 30) }) }),
  screeningSettings: (j) => ({ SCREENING_SETTINGS: screeningSettingsIn(j) }),
  screeningCases: (j) => ({ SCREENING_CASES: make(E.ERMScreeningCasesT, { CASES: (j.pairs ?? []).map((p) => make(E.ERMScreeningCaseT, { ERROR1_KM: arr(p, 'e1'),
    COVARIANCE1_KM2: arr(p, 'c1'), ERROR2_KM: arr(p, 'e2'), COVARIANCE2_KM2: arr(p, 'c2') })) }) }),
  arcOptions: (j) => ({ ARC_OPTIONS: make(E.ERMArcOptionsT, { STRATA_SETTINGS: strataIn(j, true), TARGET_AGES_DAYS: arr(j, 'targetAgesDays'),
    EPOCH_TOLERANCE_S: num(j, 'epochToleranceSeconds', 1800), TARGET_TOLERANCE_S: num(j, 'targetToleranceSeconds', 900) }) }),
  plan: (j) => ({ ARC_PLAN: planIn(j) }), predictions: (j) => ({ ARC_PREDICTIONS: predictionsIn(j) }), coverageOptions: (j) => ({ COVERAGE_OPTIONS: coverageOptionsIn(j) }),
  commonEpoch: (j) => ({ COMMON_EPOCH: commonEpochIn(j) }), covarianceMap: (j) => ({ COVARIANCE_MAP: covarianceMapIn(j) }), pairs: (j) => ({ PAIR_STATISTICS: pairsIn(j) }),
  calibration: (j) => ({ CALIBRATION: calibrationIn(j) }), objects: (j) => ({ CALIBRATED_COVARIANCES: objectsIn(j) }), dcp: (j) => ({ CONSIDER_COVARIANCES: dcpIn(j) }),
  noise: (j) => ({ NOISE_RESPONSES: noiseRequestIn(j) }), fitOptions: (j) => ({ ELEMENT_FITS: fitOptionsIn(j) }), residualRequests: (j) => ({ ELEMENT_FITS: residualRequestsIn(j) }),
};
/** One size-prefixed $ERM record of `arm` from its readable form. */
export function encode(arm, value) {
  const t = make(E.ERMT, ARMS[arm](value));
  const b = new fb.Builder(1 << 12);
  E.ERM.finishSizePrefixedERMBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
}
/** An input frame carrying one $ERM record. */
export const frame = (portId, arm, value) => ({ portId, payload: encode(arm, value), typeRef: { ...ERM_TYPE } });
export const ermFrame = (portId, payload) => ({ portId, payload, typeRef: { ...ERM_TYPE } });
/** The $ERM record (size-prefixed or plain), unpacked. */
export function unpack(bytes) {
  const b = new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  const bb = new fb.ByteBuffer(b);
  const prefixed = b.length >= 8 && String.fromCharCode(...b.subarray(8, 12)) === '$ERM';
  return (prefixed ? E.ERM.getSizePrefixedRootAsERM(bb) : E.ERM.getRootAsERM(bb)).unpack();
}
/** A $ERM output of the module in its readable form. */
export function decode(bytes) {
  const e = unpack(bytes);
  if (e.MODEL) return modelOut(e.MODEL);
  if (e.ACCUMULATOR) return accumulatorOut(e.ACCUMULATOR);
  if (e.SCREENING_REPORT) return screeningReportOut(e.SCREENING_REPORT);
  if (e.ARC_PLAN) return planOut(e.ARC_PLAN);
  if (e.PROPAGATOR_COVERAGE) return propagatorCoverageOut(e.PROPAGATOR_COVERAGE);
  if (e.COMMON_EPOCH) return commonEpochOut(e.COMMON_EPOCH);
  if (e.COVARIANCE_MAP) return covarianceMapOut(e.COVARIANCE_MAP);
  if (e.PAIR_STATISTICS) return pairStatisticsOut(e.PAIR_STATISTICS);
  if (e.CALIBRATION) return calibrationOutJ(e.CALIBRATION);
  if (e.CALIBRATED_COVARIANCES) return calibratedOut(e.CALIBRATED_COVARIANCES);
  if (e.CONSIDER_COVARIANCES) return dcpOut(e.CONSIDER_COVARIANCES);
  if (e.NOISE_RESPONSES) return noiseResponsesOut(e.NOISE_RESPONSES);
  if (e.ELEMENT_FITS) return elementFitsOut(e.ELEMENT_FITS);
  if (e.ATTACH_REPORT) return attachReportOut(e.ATTACH_REPORT);
  throw new Error('the $ERM record carries no arm this module emits');
}

// ── recipes: node config ──
/** The node config of attach_covariance / attribute_maneuvers for a recipe: its keys (without models) under `prefix`. */
export function recipeConfig(recipe, prefix = 'attach') {
  const { models, ...rest } = recipe;
  return prefix ? { [prefix]: rest } : rest;
}
/** The models of a recipe as $ERM MODEL records, size-prefixed and concatenated (the models port). */
export const modelsFrame = (models, portId = 'models') => ermFrame(portId, Buffer.concat(models.map((m) => encode('model', m))));
