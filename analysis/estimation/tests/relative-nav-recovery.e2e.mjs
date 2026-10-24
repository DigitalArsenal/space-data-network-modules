// End to end: relative-navigation EKFs (HCW, Schweighart-Sedwick J2,
// Tschauner-Hempel, Yamanaka-Ankersen) and opt-in innovation recovery for them
// and for the absolute EKF, scored against two-object FFM truth.
//
//   node analysis/estimation/tests/relative-nav-recovery.e2e.mjs   (any cwd)
//
// Truth: chief and deputy are each one propagator/ffm run (full force:
// EGM2008 70 x 70, Sun and Moon, radiation pressure, NRLMSISE-00 drag,
// solid tides, relativity; relnav-truth.mjs) over 72 h from 2026-08-02
// 00:00 UTC at 60 s; planted maneuvers are FFM's own impulses and finite burn.
// The filters' dynamics never generate it. FFM's space-weather and Earth
// orientation inputs are extended past the committed fixtures to cover 72 h
// (test inputs for FFM only; no filter sees them).
//
// Chief reference: the references of the chief's own ephemeris, straight from the module's
// relative_state (osculating a, e, i, true anomaly and argument of perigee of the chief's inertial
// state; never the deputy). The models advance the chief by the swept argument of latitude
// (omega + nu) between two references. (The osculating perigee of a J2 chief wanders, so the osculating
// anomaly alone is a noisy clock at e = 0.1; the sum with the argument of perigee is not.)
//
// Options: every filter and recovery option travels in the typed $EST request
// built with the generated object API (enum constants, no JSON, no name
// strings); diagnostics come back in the typed RelativeNavEpoch / RecoveryEpoch
// records. Parallel leaf worker processes (FFM arcs; absolute-filter rounds)
// receive the packed $EST request bytes and return packed result bytes.
//
// Process noise (white acceleration PSD q, from the same grid for every case), chosen on the first
// 24 h only: the smallest q whose recovery-off average NEES is at most 1.25 x 6, whose
// recovery-on runs (predictive_consistency and persistence, NIS probability 0.999, confirmation
// count 2) reinitialize nowhere and hold at most about 3 x the 0.1 % expectation; the filter then
// operates one half-decade above that q (a stated safety margin: a filter tuned on the edge of
// consistency has none against unmodeled non-stationarity). NEES and every count below are scored
// on the unseen 24-72 h segment. (Choosing the NEES closest to 6 would pick a huge q: a filter
// that ignores its model is trivially consistent and hides every maneuver.)
//
// Measured and printed here: false reinitializations per object-day, NEES, recovery latency and the
// error after recovery for planted burns (FFM impulses of 1 cm/s, 10 cm/s and 1 m/s along-track
// and one 10-minute finite burn), the maximum observation gap, resets from single and double
// injected outliers, recovery-off byte identity (options absent vs enabled = false; the absolute
// EKF also against the committed module of the base commit), the RTN conversion against an
// independent reference, a curvilinear-RTN run against the rectilinear run mapped to curvilinear,
// and the four models against point-mass FFM truth. Acceptance asserts are listed in summarize().
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { moduleUnderTest } from './build-under-test.mjs';
import { api, pack, typeRef, unpack } from './wire.mjs';
import { CADENCE_S, EPOCH_JD, FIELD_RADIUS_M, J2, MU, answerQueries, deputyInitialState, ffmArc, keplerState, openFfm } from './relnav-truth.mjs';
import { chiefRadial, curvilinearBelief, nodalElements, relativeStateReference } from './relnav-reference.mjs';
import { cholesky, draw, makeRng, mean, neesSegment, neesSeries, norm3, secondsSince } from './relnav-scoring.mjs';

const SELF = fileURLToPath(import.meta.url);
const A = api();
const harness = async (wasm, manifest) => createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasm), manifest: JSON.parse(fs.readFileSync(manifest, 'utf8')), surface: 'direct' });
const epochOf = (seconds) => new A.EstimationEpochT(EPOCH_JD, seconds);
const EMPTY_LEGACY_PORT = () => pack(Object.assign(new A.EstimationEnvelopeT(), { propagatorSamples: [] }));

// =========================================================================
// Leaf worker process: FFM arcs and absolute-filter rounds. It receives job
// messages, never spawns, and exits on request.
// =========================================================================
async function workerMain() {
  const [wasm, manifest] = process.argv.slice(3);
  let estimator = null, ffm = null;
  const getEstimator = async () => (estimator ??= await harness(wasm, manifest));
  const getFfm = async () => (ffm ??= await openFfm());
  process.on('message', async (job) => {
    if (job.kind === 'exit') process.exit(0);
    try {
      if (job.kind === 'arc') {
        const states = await ffmArc(await getFfm(), job.state, job.times, { maneuver: job.maneuver ?? null, ...(job.forces ? { forces: job.forces } : {}) });
        process.send({ id: job.id, states: Float64Array.from(states.flat()) });
      } else if (job.kind === 'absolute') {
        const [e, f] = [await getEstimator(), await getFfm()];
        const started = Date.now(), envelope = unpack(job.request);
        let rounds = 0;
        for (;;) {
          const response = await e.invoke({ methodId: 'run_estimation', inputs: [{ portId: 'request', typeRef, payload: pack(envelope) }, { portId: 'propagator_samples', typeRef, payload: EMPTY_LEGACY_PORT() }] });
          if (response.statusCode !== 0) throw new Error(`run_estimation: ${response.errorCode}: ${response.errorMessage}`);
          const payload = response.outputs.find((o) => o.portId === 'result').payload, result = unpack(payload).result;
          if (result.status !== A.EstimationStatus.NEEDS_PROPAGATION) { process.send({ id: job.id, result: payload, rounds, ms: Date.now() - started }); break; }
          envelope.propagationAnswers.push(...await answerQueries(f, result.propagationRequests, { stm: true, forces: job.forces }));
          if (++rounds > 5000) throw new Error('the continuation does not finish');
        }
      } else throw new Error(`unknown job ${job.kind}`);
    } catch (error) { process.send({ id: job.id, error: String(error?.stack ?? error) }); }
  });
}

class Pool {
  constructor(size, wasm, manifest) {
    this.queue = []; this.next = 0; this.idle = [];
    this.workers = Array.from({ length: size }, () => {
      const child = fork(SELF, ['--worker', wasm, manifest], { serialization: 'advanced' }), worker = { child, current: null };
      child.on('message', (message) => {
        const item = worker.current; worker.current = null;
        if (message.error) item.reject(new Error(message.error)); else item.resolve(message);
        this.idle.push(worker); this.pump();
      });
      child.on('exit', (code) => { if (worker.current) worker.current.reject(new Error(`worker exited (${code}) with a job running`)); });
      this.idle.push(worker);
      return worker;
    });
    process.on('exit', () => this.workers.forEach((w) => w.child.kill()));
  }
  submit(job) { return new Promise((resolve, reject) => { this.queue.push({ job: { ...job, id: ++this.next }, resolve, reject }); this.pump(); }); }
  pump() { while (this.idle.length && this.queue.length) { const worker = this.idle.pop(), item = this.queue.shift(); worker.current = item; worker.child.send(item.job); } }
  close() { this.workers.forEach((w) => w.child.send({ kind: 'exit' })); }
}

// =========================================================================
// Scenario constants
// =========================================================================
const SEED = 20261024;                       // seeds every noise draw below
const ARC_S = 72 * 3600, N = ARC_S / CADENCE_S;              // 72 h, 4320 observations
const CAL_N = 24 * 3600 / CADENCE_S;                          // calibration: first 24 h
const BURN_S = 24 * 3600 + 30;                                // planted maneuvers at 24 h + 30 s
const BURN_WINDOW_N = (BURN_S + 6 * 3600) / CADENCE_S;        // burn arcs are scored to 6 h after the burn
const SIGMA_POS = 1, SIGMA_VEL = 1e-3, CORRELATION = 0.3;     // full-state measurement noise (m, m/s)
const P0_POS = 10, P0_VEL = 0.01;                             // initial uncertainty
const SEPARATIONS_M = [100, 1000, 10000];
const BURN_SEPARATION_M = 1000;
const IMPULSES = [{ id: 'imp1cm', dv: 0.01 }, { id: 'imp10cm', dv: 0.1 }, { id: 'imp1m', dv: 1 }];
const FINITE = { startSeconds: BURN_S, stopSeconds: BURN_S + 600, thrustNewtons: 0.15, ispSeconds: 300, direction: [0, 1, 0] };  // ~1.5e-4 m/s^2 on 1000 kg for 10 min
const GRID_RELATIVE = Array.from({ length: 23 }, (_, i) => 10 ** (-14 + 0.5 * i));   // acceleration PSD, m^2/s^3
const GRID_ABSOLUTE = Array.from({ length: 15 }, (_, i) => 10 ** (-14 + 0.5 * i));
// Process-noise selection: the smallest grid value whose calibration-segment mean NEES is at most
// 1.25 x 6, the most informative filter that is not overconfident. (Choosing the NEES closest to 6
// would select a huge process noise, a filter that ignores its model and is trivially consistent.)
const NEES_LIMIT = 6 * 1.25;
const NIS_THRESHOLD_TABLE = 22.4577;         // chi-square(6) 0.999 quantile (Abramowitz and Stegun, Table 26.8)
const CHIEFS = [
  { id: 'circ', elements: { a: 6878137, e: 1e-4, incDeg: 51.6, raanDeg: 40 }, models: [A.RelativeModel.HILL_CLOHESSY_WILTSHIRE, A.RelativeModel.SCHWEIGHART_SEDWICK_J2, A.RelativeModel.TSCHAUNER_HEMPEL, A.RelativeModel.YAMANAKA_ANKERSEN] },
  { id: 'e0.1', elements: { a: 6878137 / 0.9, e: 0.1, incDeg: 51.6, raanDeg: 40 }, models: [A.RelativeModel.TSCHAUNER_HEMPEL, A.RelativeModel.YAMANAKA_ANKERSEN] },
  { id: 'e0.6', elements: { a: 6878137 / 0.4, e: 0.6, incDeg: 51.6, raanDeg: 40 }, models: [A.RelativeModel.TSCHAUNER_HEMPEL, A.RelativeModel.YAMANAKA_ANKERSEN] },
];
const MODEL_NAME = (model) => A.RelativeModel[model];
const STRATEGY_NAME = { [A.RecoveryStrategy.PREDICTIVE_CONSISTENCY]: 'predictive', [A.RecoveryStrategy.PERSISTENCE]: 'persistence' };
const STRATEGIES = [A.RecoveryStrategy.PREDICTIVE_CONSISTENCY, A.RecoveryStrategy.PERSISTENCE];

const ORBITS = [
  { id: 'ISS-like', elements: { a: 6780000, e: 5e-4, incDeg: 51.6, raanDeg: 40, argpDeg: 30 } },
  { id: 'Starlink-like', elements: { a: 6928000, e: 1e-4, incDeg: 53.0, raanDeg: 70, argpDeg: 90 } },
];
const ABS_ARC_S = 6 * 3600, ABS_N = ABS_ARC_S / CADENCE_S;   // 360 observations
const ABS_SEGMENTS = 4;                                       // four 6 h burn-free segments = one object-day per orbit
const ABS_BURN_S = 3 * 3600 + 30;
const ABS_FINITE = { ...FINITE, startSeconds: ABS_BURN_S, stopSeconds: ABS_BURN_S + 600 };
const ABS_SIGMA_POS = 5, ABS_SIGMA_VEL = 5e-3, ABS_P0_POS = 20, ABS_P0_VEL = 0.02;
// The filter's propagator through the inverted port: the same FFM module with a smaller
// force model (gravity 20 x 20, no solid tides, no relativity) than the truth carries.
const ABS_FILTER_FORCES = { degree: 20, order: 20, thirdBodies: true, srp: true, drag: true, solidTides: false, relativity: 0, spaceWeather: 'cssi' };

// =========================================================================
// Request builders (typed $EST objects only)
// =========================================================================
const recoveryOptions = (strategy) => Object.assign(new A.InnovationRecoveryOptionsT(), { enabled: true, strategy, nisProbability: 0.999, confirmationCount: 2, covarianceInflation: 4, maxGapSeconds: 120 });
const recoveryDisabled = () => Object.assign(new A.InnovationRecoveryOptionsT(), { enabled: false, strategy: A.RecoveryStrategy.PREDICTIVE_CONSISTENCY, nisProbability: 0.999, confirmationCount: 2, covarianceInflation: 4, maxGapSeconds: 120 });
const diag6 = (a, b) => Array.from({ length: 36 }, (_, i) => (i % 7 ? 0 : i < 21 ? a * a : b * b));
const measurementCovariance = (sp, sv, rho) => Array.from({ length: 36 }, (_, i) => { const [r, c] = [Math.floor(i / 6), i % 6]; return r === c ? (r < 3 ? sp * sp : sv * sv) : Math.abs(r - c) === 3 ? rho * sp * sv : 0; });
const RELATIVE_R = measurementCovariance(SIGMA_POS, SIGMA_VEL, CORRELATION);
const RELATIVE_R_LOWER = cholesky(RELATIVE_R);

const invoke = async (host, methodId, envelope, extraInputs = []) => {
  const response = await host.invoke({ methodId, inputs: [{ portId: 'request', typeRef, payload: pack(envelope) }, ...extraInputs] });
  if (response.statusCode !== 0) throw new Error(`${methodId}: ${response.errorCode}: ${response.errorMessage}`);
  return response.outputs.find((o) => o.portId === 'result').payload;
};

// RTN relative states and the chief's osculating references from inertial FFM states.
async function relativeStates(estimator, chiefStates, deputyStates) {
  const request = Object.assign(new A.RelativeStateRequestT(), { gravitationalParameterM3S2: MU, chiefStates: Array.from(chiefStates), deputyStates: Array.from(deputyStates) });
  const result = unpack(await invoke(estimator, 'relative_state', Object.assign(new A.EstimationEnvelopeT(), { relativeStateRequest: request }))).relativeStateResult;
  return { states: Float64Array.from(result.states), chiefs: result.chiefs };
}

function relativeRequest({ model, chief0, x0, q, recovery, observations }) {
  const config = Object.assign(new A.RelativeNavConfigT(), {
    model, measurementModel: A.RelativeMeasurementModel.FULL_STATE, epoch: epochOf(0), state: x0, covariance: diag6(P0_POS, P0_VEL), chief: chief0,
    gravitationalParameterM3S2: MU, j2: J2, equatorialRadiusM: FIELD_RADIUS_M,
    processNoise: A.ProcessNoiseKind.STATE_NOISE_COMPENSATION, accelerationPsd: [q, q, q], recovery, curvilinear: false,
  });
  return Object.assign(new A.RelativeNavRequestT(), { config, observations });
}
async function runRelative(estimator, request) {
  const bytes = await invoke(estimator, 'run_relative_navigation', Object.assign(new A.EstimationEnvelopeT(), { relativeRequest: request }));
  const result = unpack(bytes).relativeResult;
  return { bytes, history: result.history };
}

// ---- recovery summaries ----
function recoveryCounts(rows, from = 0, to = rows.length) {
  const c = { holds: 0, transients: 0, reinits: 0, maxNis: 0 };
  for (let k = from; k < to; ++k) {
    const r = rows[k];
    if (!r) continue;
    if (r.action === A.RecoveryAction.HELD) c.holds += 1;
    if (r.classification === A.RecoveryClassification.TRANSIENT_DISCREPANCY) c.transients += 1;
    if (r.action === A.RecoveryAction.REINITIALIZED) c.reinits += 1;
    c.maxNis = Math.max(c.maxNis, r.nis);
  }
  return c;
}
const firstReinit = (rows, from) => { for (let k = from; k < rows.length; ++k) if (rows[k]?.action === A.RecoveryAction.REINITIALIZED) return k; return -1; };
const fq = (x) => (Number.isFinite(x) ? x.toExponential(1) : String(x));
const fmt = (x, d = 3) => (Number.isFinite(x) ? (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(d - 1) : x.toFixed(d)) : String(x));

// =========================================================================
// Main
// =========================================================================
const report = { lines: [], failures: [] };
const say = (line) => { report.lines.push(line); console.log(line); };
const check = (condition, message) => { if (!condition) { report.failures.push(message); console.log(`FAIL ${message}`); } };
const t0 = Date.now(), elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

async function main() {
  const built = moduleUnderTest();
  say(`module under test ${built.hash} (built from the working-tree sources and Estimation.fbs; ${elapsed()})`);
  const estimator = await harness(built.wasm, built.manifest);
  const pool = new Pool(Math.min(8, Math.max(2, os.cpus().length >> 1)), built.wasm, built.manifest);
  const times = (n) => Array.from({ length: n }, (_, k) => (k + 1) * CADENCE_S);
  const arc = async (state, n, maneuver = null, forces = null) => {
    const message = await pool.submit({ kind: 'arc', state, times: times(n), maneuver, ...(forces ? { forces } : {}) });
    return Array.from({ length: n }, (_, k) => Array.from(message.states.subarray(6 * k, 6 * k + 6)));
  };

  // ---- truth: every arc is an FFM run, submitted at once ----
  say(`truth: FFM full force, ${N} samples at ${CADENCE_S} s from 2026-08-02T00:00Z; space weather and Earth orientation extended for 72 h (FFM test inputs only)`);
  const relTruth = {};
  const relArcs = CHIEFS.map(async (chief) => {
    const c0 = keplerState(chief.elements);
    const jobs = { chief: arc(c0, N) };
    for (const sep of SEPARATIONS_M) jobs[`sep${sep}`] = arc(deputyInitialState(c0, sep), N);
    const d1 = deputyInitialState(c0, BURN_SEPARATION_M);
    for (const { id, dv } of IMPULSES) jobs[id] = arc(d1, N, { impulse: { seconds: BURN_S, deltaVRtn: [0, dv, 0] } });
    jobs.finite = arc(d1, N, { finiteBurn: FINITE });
    const out = { c0, d1, deputy0: Object.fromEntries(SEPARATIONS_M.map((s) => [s, deputyInitialState(c0, s)])) };
    for (const [name, promise] of Object.entries(jobs)) out[name] = await promise;
    relTruth[chief.id] = out;
  });
  const absTruth = {};
  const absArcs = ORBITS.map(async (orbit) => {
    const s0 = keplerState(orbit.elements);
    const jobs = { free: arc(s0, ABS_SEGMENTS * ABS_N) };
    for (const { id, dv } of IMPULSES) jobs[id] = arc(s0, ABS_N, { impulse: { seconds: ABS_BURN_S, deltaVRtn: [0, dv, 0] } });
    jobs.finite = arc(s0, ABS_N, { finiteBurn: ABS_FINITE });
    const out = { s0 };
    for (const [name, promise] of Object.entries(jobs)) out[name] = await promise;
    absTruth[orbit.id] = out;
  });

  // The absolute pipeline starts as soon as its truth is in, in the workers, while the relative
  // pipeline runs in this process.
  const absolutePromise = Promise.all(absArcs).then(() => absolutePipeline(pool, absTruth, built));
  await Promise.all(relArcs);
  say(`truth ready (${elapsed()})`);

  const rel = await relativePipeline(estimator, relTruth);
  const models = await modelCheck(estimator);
  for (const r of models) say(r.agreement
    ? `MODEL ${r.chief.padEnd(5)} TH vs YA +${r.dt} s: predictions agree to ${r.agreement.position.toExponential(2)} (position) and ${r.agreement.rate.toExponential(2)} (rate) relative`
    : `MODEL ${r.chief.padEnd(5)} ${MODEL_NAME(r.model).padEnd(23)} +${String(r.dt).padStart(5)} s vs point-mass FFM truth: position error ${r.error.position.toExponential(2)} m (bound ${r.bound.position.toExponential(2)}), rate error ${r.error.rate.toExponential(2)} m/s (bound ${r.bound.rate.toExponential(2)})`);
  const abs = await absolutePromise;
  pool.close();
  const baseline = await baselineIdentity(estimator, absTruth);

  summarize(rel, abs, baseline, models);
  say(`elapsed ${elapsed()}`);
  if (report.failures.length) { console.log(`\nFAILED ${report.failures.length} acceptance check(s):\n${report.failures.map((f) => ` - ${f}`).join('\n')}`); process.exitCode = 1; } else console.log('\nPASS relative-nav-recovery E2E');
}

// =========================================================================
// Relative pipeline
// =========================================================================
function observationsFrom(rel, rng, count, shifts = {}) {
  // Observation k (1-based) at k * 60 s: truth + N(0, R); `shifts[k]` adds a vector (outliers).
  const out = [];
  for (let k = 1; k <= count; ++k) {
    let z = draw(rng, Array.from(rel.states.subarray(6 * k, 6 * k + 6)), RELATIVE_R_LOWER);
    if (shifts[k]) z = z.map((v, i) => v + shifts[k][i]);
    out.push(Object.assign(new A.RelativeObservationT(), { epoch: epochOf(k * CADENCE_S), state: z, covariance: RELATIVE_R, chief: rel.chiefs[k] }));
  }
  return out;
}
const SIGMAS = [SIGMA_POS, SIGMA_POS, SIGMA_POS, SIGMA_VEL, SIGMA_VEL, SIGMA_VEL];
const outlierShift = (sign) => SIGMAS.map((s) => sign * 30 * s);   // 30 sigma in every component
const truthRows = (rel, count) => Array.from({ length: count }, (_, k) => Array.from(rel.states.subarray(6 * (k + 1), 6 * (k + 2))));
const seedOf = (...parts) => (SEED + parts.join('|').split('').reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7)) >>> 0;

async function relativePipeline(estimator, truth) {
  const cases = [], burns = [];
  let curvilinear = null;
  // Floating-point bound of the conversion: 64 machine epsilons of the largest chief radius and speed
  // of the arc (a difference of two inertial states of that size, and the rotating-frame term).
  const conversion = { positionWorst: 0, rateWorst: 0, chiefWorst: 0, positionRatio: 0, rateRatio: 0, samples: 0 };
  let checkedThreshold = false;
  for (const chief of CHIEFS) {
    const t = truth[chief.id];
    const converted = {};
    const convert = async (name, deputyStates, deputy0) => { converted[name] = await relativeStates(estimator, [t.c0, ...t.chief].flat(), [deputy0, ...deputyStates].flat()); };
    for (const sep of SEPARATIONS_M) await convert(`sep${sep}`, t[`sep${sep}`], t.deputy0[sep]);
    for (const { id } of IMPULSES) await convert(id, t[id], t.d1);
    await convert('finite', t.finite, t.d1);
    // The conversion against the independent reference (every 6th pair, both objects).
    const chiefAll = [t.c0, ...t.chief], depAll = [t.d1, ...t.sep1000];
    const rMax = Math.max(...chiefAll.map((c) => Math.hypot(c[0], c[1], c[2]))), vMax = Math.max(...chiefAll.map((c) => Math.hypot(c[3], c[4], c[5])));
    const positionBound = 64 * Number.EPSILON * rMax, rateBound = 64 * Number.EPSILON * vMax;
    for (let k = 0; k < chiefAll.length; k += 6) {
      const ref = relativeStateReference(MU, chiefAll[k], depAll[k]);
      for (let i = 0; i < 3; ++i) { const d = Math.abs(ref.state[i] - converted.sep1000.states[6 * k + i]); conversion.positionWorst = Math.max(conversion.positionWorst, d); conversion.positionRatio = Math.max(conversion.positionRatio, d / positionBound); }
      for (let i = 3; i < 6; ++i) { const d = Math.abs(ref.state[i] - converted.sep1000.states[6 * k + i]); conversion.rateWorst = Math.max(conversion.rateWorst, d); conversion.rateRatio = Math.max(conversion.rateRatio, d / rateBound); }
      const c = converted.sep1000.chiefs[k], wrap = (x) => Math.abs(Math.atan2(Math.sin(x), Math.cos(x))), nodal = nodalElements(MU, chiefAll[k]);
      // a, e, i; omega + nu against the argument of latitude u of the independent reference (well conditioned at any
      // eccentricity); nu and omega themselves where the perigee is defined (e > 0.05).
      conversion.chiefWorst = Math.max(conversion.chiefWorst, Math.abs(ref.chief.a - c.semiMajorAxisM) / ref.chief.a, Math.abs(ref.chief.e - c.eccentricity), Math.abs(ref.chief.i - c.inclinationRad),
        wrap(c.argumentOfPerigeeRad + c.trueAnomalyRad - nodal.u), chief.elements.e > 0.05 ? Math.max(wrap(ref.chief.nu - c.trueAnomalyRad), wrap(Math.atan2(nodal.ey, nodal.ex) - c.argumentOfPerigeeRad)) : 0);
      conversion.samples += 1;
    }
    // The chief's references (osculating a, e, i, nu, omega from the chief's inertial state) are shared by every deputy.
    const chiefs = converted.sep1000.chiefs;
    const swing = (pick) => Math.max(...chiefs.map(pick)) - Math.min(...chiefs.map(pick));
    say(`chief ${chief.id}: references from relative_state over the arc: a ${(chiefs[0].semiMajorAxisM / 1e3).toFixed(1)} km (swing ${(swing((c) => c.semiMajorAxisM) / 1e3).toFixed(2)} km), e ${chiefs[0].eccentricity.toFixed(4)} (swing ${swing((c) => c.eccentricity).toExponential(1)}), i ${(chiefs[0].inclinationRad * 180 / Math.PI).toFixed(2)} deg`);
    for (const name of Object.keys(converted)) converted[name].chiefs = chiefs;

    for (const model of chief.models) {
      for (const sep of SEPARATIONS_M) {
        const c = await relativeCase(estimator, chief, model, sep, converted[`sep${sep}`], t.deputy0[sep], chiefs[0]);
        cases.push(c);
        say(c.line);
        if (chief.id === 'e0.6' && model === A.RelativeModel.YAMANAKA_ANKERSEN && sep === BURN_SEPARATION_M) {
          curvilinear = await curvilinearCheck(estimator, converted.sep1000, c.q);
          say(`CURVILINEAR e0.6 YAMANAKA_ANKERSEN 1 km, ${curvilinear.observations} observations: curvilinear run vs rectilinear run mapped to curvilinear: max |state| ${curvilinear.position.toExponential(2)} m (${(curvilinear.position / 1000).toExponential(2)} of the 1 km separation), rates ${curvilinear.rate.toExponential(2)} m/s (${(curvilinear.rate / curvilinear.rateScale).toExponential(2)} of the largest rate ${curvilinear.rateScale.toFixed(3)} m/s), covariance ${(curvilinear.covariance / curvilinear.covarianceScale).toExponential(2)} of its largest entry`);
        }
        if (!checkedThreshold && c.threshold !== undefined) {
          checkedThreshold = true;
          check(Math.abs(c.threshold - NIS_THRESHOLD_TABLE) < 5e-4, `NIS gate threshold ${c.threshold} is not the chi-square(6) 0.999 quantile ${NIS_THRESHOLD_TABLE}`);
        }
      }
      // Planted burns at 1 km: the same noise seed as the burn-free 1 km case.
      const baseCase = cases.find((c) => c.chief === chief.id && c.model === model && c.sep === BURN_SEPARATION_M);
      for (const burn of [...IMPULSES.map((i) => i.id), 'finite']) {
        const b = await burnCase(estimator, chief, model, burn, converted[burn], t.d1, chiefs[0], baseCase.q);
        burns.push(b);
        say(b.line);
      }
    }
  }
  say(`conversion vs independent JS reference (${conversion.samples} pairs): max |position| ${conversion.positionWorst.toExponential(2)} m (${conversion.positionRatio.toFixed(3)} of the 64-epsilon bound), max |rate| ${conversion.rateWorst.toExponential(2)} m/s (${conversion.rateRatio.toFixed(3)} of its bound), osculating references (a relative, e, i, omega + nu = u, and nu and omega for e > 0.05) max ${conversion.chiefWorst.toExponential(2)}`);
  return { cases, burns, conversion, curvilinear };
}

const MODEL_SHORT = { [A.RelativeModel.HILL_CLOHESSY_WILTSHIRE]: 'HCW', [A.RelativeModel.SCHWEIGHART_SEDWICK_J2]: 'SS-J2', [A.RelativeModel.TSCHAUNER_HEMPEL]: 'TH', [A.RelativeModel.YAMANAKA_ANKERSEN]: 'YA' };
// The NIS gate at 0.999 holds one observation in a thousand: 1.44 in the 24 h calibration segment.
const MAX_CALIBRATION_HOLDS = Math.ceil(3 * 0.001 * CAL_N);

// Process-noise protocol, on the first 24 h only: the smallest grid value q whose recovery-off average NEES is at most
// 1.25 x 6, whose recovery-on runs (predictive and persistence, 0.999 / count 2) reinitialize nowhere and hold at most
// ~3 x the 0.1 % expectation; the filter then OPERATES one half-decade above (a filter tuned on the edge of
// consistency has no margin against unmodeled non-stationarity). The 24-72 h segment never enters.
async function calibrate(grid, run, truthRows_, limit, maxHolds) {
  for (let i = 0; i < grid.length; ++i) {
    let nees;
    try { nees = mean(neesSeries((await run(grid[i], null)).history, truthRows_)); } catch { continue; }   // a degenerate covariance is not consistent
    if (!(nees <= limit)) continue;
    let ok = true;
    for (const strategy of STRATEGIES) { const c = recoveryCounts((await run(grid[i], recoveryOptions(strategy))).history.map((h) => h.recovery)); if (c.reinits > 0 || c.holds > maxHolds) ok = false; }
    if (ok) return { qCal: grid[i], q: grid[Math.min(i + 1, grid.length - 1)], nees };
  }
  return null;
}

async function relativeCase(estimator, chief, model, sep, rel, deputy0, chief0) {
  const rng = makeRng(seedOf(chief.id, sep, 'base'));
  const observations = observationsFrom(rel, rng, N);
  const x0 = draw(rng, Array.from(rel.states.subarray(0, 6)), cholesky(diag6(P0_POS, P0_VEL)));
  const truthR = truthRows(rel, N);
  const run = (q, recovery, obs = observations, count = obs.length) => runRelative(estimator, relativeRequest({ model, chief0, x0, q, recovery, observations: obs.slice(0, count) }));
  const calibration = await calibrate(GRID_RELATIVE, (q, recovery) => run(q, recovery, observations, CAL_N), truthR, NEES_LIMIT, MAX_CALIBRATION_HOLDS);
  const uncalibrated = calibration === null;
  if (uncalibrated) report.failures.push(`${chief.id} ${MODEL_NAME(model)} ${sep} m: no grid value passed the calibration (consistent NEES, no reinitialization, few holds)`);
  const { qCal, q, nees: calibrationNees } = calibration ?? { qCal: NaN, q: GRID_RELATIVE.at(-1), nees: NaN };
  const off = await run(q, null), offExplicit = await run(q, recoveryDisabled());
  const identical = Buffer.compare(Buffer.from(off.bytes), Buffer.from(offExplicit.bytes)) === 0;
  const evalOf = (history) => neesSegment(neesSeries(history, truthR), CAL_N, N);
  const offEval = evalOf(off.history);
  // One-step prediction and filter errors against the truth (recovery off, 24 h to 72 h): what the model
  // and the filter achieve, in position (m) and velocity (mm/s) RMS.
  const rms = (pick) => Math.sqrt(mean(off.history.slice(CAL_N).map((h, i) => pick(h, truthR[CAL_N + i]) ** 2)));
  const errs = { predPos: rms((h, t) => norm3(h.predictedState.map((x, j) => x - t[j]))), predVel: rms((h, t) => norm3(h.predictedState.map((x, j) => x - t[j]), 3)) * 1e3,
    filtPos: rms((h, t) => norm3(h.filteredState.map((x, j) => x - t[j]))), filtVel: rms((h, t) => norm3(h.filteredState.map((x, j) => x - t[j]), 3)) * 1e3 };
  const out = { chief: chief.id, model, sep, q, qCal, calibrationNees, uncalibrated, offNees: offEval, errs, identical, strategies: {}, reinitDetails: {} };
  for (const strategy of STRATEGIES) {
    const free = await run(q, recoveryOptions(strategy));
    const rows = free.history.map((h) => h.recovery);
    out.threshold ??= rows[0]?.threshold;
    const counts = recoveryCounts(rows);
    // Where a false reinitialization happens (time, and the chief's true anomaly: perigee passes are at 0 deg).
    out.reinitDetails[strategy] = rows.flatMap((r, k) => (r.action === A.RecoveryAction.REINITIALIZED ? [{ hours: ((k + 1) * CADENCE_S) / 3600, nuDeg: (rel.chiefs[k + 1].trueAnomalyRad * 180 / Math.PI + 360) % 360 }] : []));
    // A single injected outlier (30 sigma in every component) at three epochs, and two consecutive
    // incompatible outliers (+30 / -30 sigma), burn-free arc.
    const single = await run(q, recoveryOptions(strategy), observationsFrom(rel, makeRng(seedOf(chief.id, sep, 'base')), N, { 1000: outlierShift(1), 2500: outlierShift(1), 3600: outlierShift(-1) }));
    const double = await run(q, recoveryOptions(strategy), observationsFrom(rel, makeRng(seedOf(chief.id, sep, 'base')), N, { 2000: outlierShift(1), 2001: outlierShift(-1) }));
    const resets = (r) => recoveryCounts(r.history.map((h) => h.recovery)).reinits - counts.reinits;
    out.strategies[strategy] = {
      counts, nees: evalOf(free.history), singleResets: resets(single),
      singleHolds: recoveryCounts(single.history.map((h) => h.recovery)).holds - counts.holds, doubleResets: resets(double),
    };
  }
  const days = N / (24 * 3600 / CADENCE_S);
  const p = out.strategies[A.RecoveryStrategy.PREDICTIVE_CONSISTENCY], s = out.strategies[A.RecoveryStrategy.PERSISTENCE];
  out.falsePerDay = { predictive: p.counts.reinits / days, persistence: s.counts.reinits / days };
  const where = (strategy) => out.reinitDetails[strategy].map((d) => `${d.hours.toFixed(1)}h@nu${d.nuDeg.toFixed(0)}`).join(',');
  out.line = `REL ${chief.id.padEnd(5)} ${MODEL_SHORT[model].padEnd(5)} ${String(sep).padStart(5)} m  q ${fq(qCal)}->${fq(q)}  NEES cal ${fmt(calibrationNees, 2)} eval ${fmt(offEval.mean, 2)} (pred ${fmt(p.nees.mean, 2)}, pers ${fmt(s.nees.mean, 2)}; 1-h windows in 99% ${fmt(offEval.fraction, 2)})  `
    + `1-step ${fmt(errs.predPos, 2)} m/${fmt(errs.predVel, 2)} mm/s, filter ${fmt(errs.filtPos, 2)} m/${fmt(errs.filtVel, 2)} mm/s  hold/trans/reinit pred ${p.counts.holds}/${p.counts.transients}/${p.counts.reinits} pers ${s.counts.holds}/${s.counts.transients}/${s.counts.reinits}`
    + `${p.counts.reinits || s.counts.reinits ? ` [reinit at pred ${where(A.RecoveryStrategy.PREDICTIVE_CONSISTENCY) || '-'} pers ${where(A.RecoveryStrategy.PERSISTENCE) || '-'}]` : ''}  `
    + `single-outlier resets ${p.singleResets}|${s.singleResets} (holds ${p.singleHolds}|${s.singleHolds}) double ${p.doubleResets}|${s.doubleResets}  off-identical ${identical}`;
  return out;
}

async function burnCase(estimator, chief, model, burn, rel, deputy0, chief0, q) {
  const rng = makeRng(seedOf(chief.id, BURN_SEPARATION_M, 'base'));
  const observations = observationsFrom(rel, rng, BURN_WINDOW_N);
  const x0 = draw(rng, Array.from(rel.states.subarray(0, 6)), cholesky(diag6(P0_POS, P0_VEL)));
  const truthR = truthRows(rel, BURN_WINDOW_N);
  const kBurn = Math.ceil(BURN_S / CADENCE_S) - 1;          // index of the first observation after the burn start
  const run = (recovery, obs = observations) => runRelative(estimator, relativeRequest({ model, chief0, x0, q, recovery, observations: obs }));
  const err = (history, k) => k < history.length ? [norm3(history[k].filteredState.map((x, i) => x - truthR[k][i])), norm3(history[k].filteredState.map((x, i) => x - truthR[k][i]), 3)] : [NaN, NaN];
  const at = (seconds) => Math.ceil((BURN_S + seconds) / CADENCE_S) - 1;     // the first observation at or after burn + seconds
  const latencyOf = (history) => { const rows = history.map((h) => h.recovery), kr = firstReinit(rows, kBurn); return kr < 0 ? null : secondsSince(rows[kr].decisionEpoch, EPOCH_JD) - BURN_S; };
  const out = { chief: chief.id, model, burn, runs: {}, dropout: {} };
  const parts = [], e2 = (e) => `${fmt(e[0], 2)}m/${fmt(e[1] * 1000, 2)}mm/s`;
  for (const [name, recovery] of [['off', null], ['pred', recoveryOptions(A.RecoveryStrategy.PREDICTIVE_CONSISTENCY)], ['pers', recoveryOptions(A.RecoveryStrategy.PERSISTENCE)]]) {
    const { history } = await run(recovery);
    const rows = history.map((h) => h.recovery);
    const kr = recovery ? firstReinit(rows, kBurn) : -1;
    const nisAfter = Math.max(...history.slice(kBurn, kBurn + 10).map((h) => h.normalizedInnovationSquared));
    const latency = kr >= 0 ? latencyOf(history) : null;
    const errors = [600, 1800, 3600].map((sec) => err(history, at(sec)));
    const atReinit = kr >= 0 ? err(history, kr) : null;
    out.runs[name] = { kr, latency, nisAfter, errors, atReinit, reinits: recovery ? recoveryCounts(rows, 0, kBurn).reinits : 0 };
    parts.push(`${name}${recovery ? ` ${latency === null ? 'no reinit' : `lat ${latency}s/${kr - kBurn + 1}obs, at reinit ${e2(atReinit)}`}` : ''} maxNIS ${fmt(nisAfter, 1)}; +10/30/60min ${errors.map(e2).join(' ')}`);
  }
  // Observations dropped right after the burn: a 120 s gap is within the 120 s maximum, a 180 s gap expires the
  // pending discrepancy (two fresh observations are needed again).
  if (burn === 'imp1m') {
    const parts2 = [];
    for (const [name, strategy] of [['pred', A.RecoveryStrategy.PREDICTIVE_CONSISTENCY], ['pers', A.RecoveryStrategy.PERSISTENCE]]) {
      const lat = {};
      for (const [gap, drop] of [[120, [1]], [180, [1, 2]]]) lat[gap] = latencyOf((await run(recoveryOptions(strategy), observations.filter((o, i) => !drop.map((d) => kBurn + d).includes(i)))).history);
      out.dropout[name] = lat;
      parts2.push(`${name} ${lat[120]}s/${lat[180]}s`);
    }
    parts.push(`latency with a 120 s / 180 s gap after the burn: ${parts2.join(', ')}`);
  }
  out.line = `BURN ${chief.id.padEnd(5)} ${MODEL_SHORT[model].padEnd(5)} ${burn.padEnd(7)} | ${parts.join(' | ')}`;
  return out;
}

// =========================================================================
// Curvilinear RTN: the same e = 0.6 measurements at 1 km, mapped to curvilinear by an independent
// implementation of the definition (relnav-reference.mjs), through run_relative_navigation with
// config.curvilinear = true, against the rectilinear run mapped the same way.
// =========================================================================
async function curvilinearCheck(estimator, rel, q) {
  const model = A.RelativeModel.YAMANAKA_ANKERSEN, rng = makeRng(seedOf('e0.6', 1000, 'curvilinear'));
  const observations = observationsFrom(rel, rng, N);
  const x0 = draw(rng, Array.from(rel.states.subarray(0, 6)), cholesky(diag6(P0_POS, P0_VEL)));
  const radialOf = (c) => chiefRadial(MU, c.semiMajorAxisM, c.eccentricity, c.trueAnomalyRad);
  const rect = await runRelative(estimator, relativeRequest({ model, chief0: rel.chiefs[0], x0, q, recovery: null, observations }));
  const mapped = observations.map((o) => curvilinearBelief(radialOf(o.chief), o.state, o.covariance));
  const curvObservations = observations.map((o, i) => Object.assign(new A.RelativeObservationT(), { epoch: o.epoch, state: mapped[i].state, covariance: mapped[i].covariance, chief: o.chief }));
  const start = curvilinearBelief(radialOf(rel.chiefs[0]), x0, diag6(P0_POS, P0_VEL));
  const request = relativeRequest({ model, chief0: rel.chiefs[0], x0: start.state, q, recovery: null, observations: curvObservations });
  request.config.covariance = start.covariance;
  request.config.curvilinear = true;
  const curv = await runRelative(estimator, request);
  let position = 0, rate = 0, rateScale = 0, covariance = 0, covarianceScale = 0;
  curv.history.forEach((h, k) => {
    const expected = curvilinearBelief(radialOf(observations[k].chief), rect.history[k].filteredState, rect.history[k].filteredCovariance);
    for (let i = 0; i < 6; ++i) {
      const d = Math.abs(h.filteredState[i] - expected.state[i]);
      if (i < 3) position = Math.max(position, d); else { rate = Math.max(rate, d); rateScale = Math.max(rateScale, Math.abs(expected.state[i])); }
    }
    for (let i = 0; i < 36; ++i) { covariance = Math.max(covariance, Math.abs(h.filteredCovariance[i] - expected.covariance[i])); covarianceScale = Math.max(covarianceScale, Math.abs(expected.covariance[i])); }
  });
  return { observations: N, position, rate, rateScale, covariance, covarianceScale };
}

// =========================================================================
// Model check against independent two-body truth: FFM with point-mass forces only (exact to ~1e-3 m/day,
// orekit_reference.test.mjs) for chief and deputy 100 m apart; the module's relative_state gives both
// relative states with the chief's osculating reference (exact in two-body); run_relative_navigation with a
// tiny initial covariance, no process noise and one observation of enormous covariance returns the model
// prediction Phi x0 as predictedState, which is compared with the FFM truth. Neglected by the linear models:
// the second order of the relative gravity (scale n^2 rho^2/r) and, for HCW, the chief's eccentricity (n^2 e rho).
// The bound is 10 times half that acceleration times t^2 (rates: 10 times it times t). SS-J2 has no two-body truth.
// =========================================================================
const POINT_MASS = { degree: 0, order: 0, thirdBodies: false, srp: false, drag: false, solidTides: false, relativity: 0 };
async function modelCheck(estimator) {
  const ffm = await openFfm(), rows = [], M = A.RelativeModel;
  const suites = [
    { chief: CHIEFS[0], models: [M.HILL_CLOHESSY_WILTSHIRE, M.TSCHAUNER_HEMPEL, M.YAMANAKA_ANKERSEN], intervals: [60, 3600] },
    { chief: CHIEFS[1], models: [M.TSCHAUNER_HEMPEL, M.YAMANAKA_ANKERSEN], intervals: [60, 3600] },
    { chief: CHIEFS[2], models: [M.TSCHAUNER_HEMPEL, M.YAMANAKA_ANKERSEN], intervals: [60, 3600, 36000] },
  ];
  for (const { chief, models, intervals } of suites) {
    const c0 = keplerState(chief.elements), d0 = deputyInitialState(c0, 100);
    const [cs, ds] = [await ffmArc(ffm, c0, intervals, { forces: POINT_MASS }), await ffmArc(ffm, d0, intervals, { forces: POINT_MASS })];
    for (const [i, dt] of intervals.entries()) {
      const pair = await relativeStates(estimator, [...c0, ...cs[i]], [...d0, ...ds[i]]);
      const x0 = Array.from(pair.states.subarray(0, 6)), truth = Array.from(pair.states.subarray(6, 12));
      const predictions = {};
      for (const model of models) {
        const request = relativeRequest({ model, chief0: pair.chiefs[0], x0, q: 0, recovery: null,
          observations: [Object.assign(new A.RelativeObservationT(), { epoch: epochOf(dt), state: truth, covariance: diag6(1e6, 1e6), chief: pair.chiefs[1] })] });
        request.config.covariance = diag6(Math.sqrt(1e-9), Math.sqrt(1e-9));
        request.config.processNoise = A.ProcessNoiseKind.NONE;
        request.config.accelerationPsd = [0, 0, 0];
        predictions[model] = (await runRelative(estimator, request)).history[0].predictedState;
        // The neglected terms act as an acceleration a = n_p^2 s (n_p^2 = mu / r_min^3), displacing the position by a t^2 / 2 until
        // about 1 / n and from then on as a shift of the relative mean motion, a drift s (n t) with n the chief's mean motion.
        // s = rho^2 / r_min (second order of the relative gravity), plus e rho for HCW (the chief is not circular);
        // rho is twice the larger separation at the ends. Bound: 10 x the smaller of the two scalings.
        const rho = 2 * Math.max(norm3(x0), norm3(truth)), rMin = pair.chiefs[0].semiMajorAxisM * (1 - pair.chiefs[0].eccentricity);
        const s = model === M.HILL_CLOHESSY_WILTSHIRE ? Math.max(rho * rho / rMin, pair.chiefs[0].eccentricity * rho) : rho * rho / rMin;
        const n = Math.sqrt(MU / pair.chiefs[0].semiMajorAxisM ** 3), a = (MU / rMin ** 3) * s;
        const bound = { position: 10 * Math.min(0.5 * a * dt * dt, s * (1 + n * dt)), rate: 10 * Math.min(a * dt, s * n * (1 + n * dt)) };
        const error = { position: norm3(predictions[model].map((x, j) => x - truth[j])), rate: norm3(predictions[model].map((x, j) => x - truth[j]), 3) };
        rows.push({ chief: chief.id, model, dt, error, bound });
      }
      if (models.includes(M.TSCHAUNER_HEMPEL) && models.includes(M.YAMANAKA_ANKERSEN)) {
        const [a, b] = [predictions[M.TSCHAUNER_HEMPEL], predictions[M.YAMANAKA_ANKERSEN]];
        rows.push({ chief: chief.id, dt, agreement: { position: norm3(a.map((x, j) => x - b[j])) / norm3(b), rate: norm3(a.map((x, j) => x - b[j]), 3) / norm3(b, 3) } });
      }
    }
  }
  ffm.destroy?.();
  return rows;
}

// =========================================================================
// Absolute EKF pipeline (run_estimation, nonlinear propagation through FFM, workers)
// =========================================================================
function pvObservation(seconds, values) {
  const observation = Object.assign(new A.EstimationObservationT(), {
    epoch: epochOf(seconds), value: [0, 0, 0, 0], sigma: [0, 0, 0, 0], stationPositionM: [0, 0, 0], stationVelocityMps: [0, 0, 0], stationEast: [0, 0, 0], stationNorth: [0, 0, 0], stationUp: [0, 0, 0],
    remotePositionM: [0, 0, 0], remoteVelocityMps: [0, 0, 0], frequencyHz: 0, transmitterDelaySeconds: 0, receiverDelaySeconds: 0, transponderDelaySeconds: 0, elevationRad: 0, stationLatitudeRad: 0, stationHeightM: 0,
    pressureHpa: 0, temperatureK: 0, relativeHumidity: 0, wavelengthM: 0, totalElectronContent: 0, totalElectronContentRatePerSecond: 0, turnaroundNumerator: 1, turnaroundDenominator: 1,
    kind: A.MeasurementKind.POSITION_VELOCITY, valueCount: 6, flags: 3, transmitterIndex: 0, receiverIndex: 0,
  });
  return Object.assign(new A.ExtendedObservationT(), { observation, values, sigmas: [ABS_SIGMA_POS, ABS_SIGMA_POS, ABS_SIGMA_POS, ABS_SIGMA_VEL, ABS_SIGMA_VEL, ABS_SIGMA_VEL] });
}
const ABS_R_LOWER = cholesky(diag6(ABS_SIGMA_POS, ABS_SIGMA_VEL));
const ABS_P0_LOWER = cholesky(diag6(ABS_P0_POS, ABS_P0_VEL));

// One absolute-filter request: truth states `truth[0..count)` at epochs start + 60 s ... , initial state from
// `initial` (truth at `start`) plus a draw from P0, observations with noise and optional outlier shifts.
function absoluteRequest({ start, initial, truth, count, q, recovery, rng, shifts = {} }) {
  const x0 = draw(rng, initial, ABS_P0_LOWER);
  const extended = [];
  for (let j = 1; j <= count; ++j) {
    let z = draw(rng, truth[j - 1], ABS_R_LOWER);
    if (shifts[j]) z = z.map((v, i) => v + shifts[j][i] * (i < 3 ? ABS_SIGMA_POS : ABS_SIGMA_VEL));   // shifts are in sigmas
    extended.push(pvObservation(start + j * CADENCE_S, z));
  }
  const config = Object.assign(new A.EstimationConfigT(), {
    initialEpoch: epochOf(start), initialState: x0, initialCovariance: diag6(ABS_P0_POS, ABS_P0_VEL), processNoiseSpectralDensity: [q, q, q, 0, 0, 0],
    stateConvergenceTolerance: 0, rmsConvergenceTolerance: 0, sigmaEditThreshold: 1e9, dynamicModelCorrelationTimeSeconds: 0, maximumIterations: 0,
    referenceFrame: 2, estimator: A.EstimatorKind.EXTENDED_KALMAN_FILTER, processNoise: A.ProcessNoiseKind.STATE_NOISE_COMPENSATION, flags: 0,
  });
  const options = Object.assign(new A.SequentialOptionsT(), { nonlinearPropagation: true, innovationRecovery: recovery });
  const request = Object.assign(new A.EstimationRequestT(), {
    config, observations: [], errorModels: [], sourceRecordIds: [], propagatorPortId: 'propagator/ffm', propagatorCapability: 'plugin_propagate plugin_compute_stm', options, extendedObservations: extended,
  });
  return pack(Object.assign(new A.EstimationEnvelopeT(), { request }));
}
const outlierAbsolute = (sign) => Array.from({ length: 6 }, () => sign * 30);   // 30 sigma in every component

async function absolutePipeline(pool, truth, built) {
  const results = [];
  for (const orbit of ORBITS) {
    const t = truth[orbit.id];
    const free = t.free;                                   // 4 x 360 samples, t = 60 s ... 24 h
    const segmentInitial = (s) => (s === 0 ? t.s0 : free[s * ABS_N - 1]);
    const segmentTruth = (s) => free.slice(s * ABS_N, (s + 1) * ABS_N);
    const submit = (spec) => pool.submit({ kind: 'absolute', request: absoluteRequest(spec), forces: ABS_FILTER_FORCES }).then((m) => ({ ...m, history: unpack(m.result).result }));
    // Process-noise protocol on segment 0 (the first 6 h): the smallest grid value whose recovery-off average NEES is at most
    // 1.25 x 6 and whose recovery-on runs (predictive and persistence) reinitialize nowhere and hold at most ~3 x the 0.1 %
    // expectation; the filter operates one half-decade above. Segments 1-3 (18 h) never enter the selection.
    const calibrationRun = (q, recovery) => submit({ start: 0, initial: t.s0, truth: segmentTruth(0), count: ABS_N, q, recovery, rng: makeRng(seedOf(orbit.id, 'cal')) }).catch(() => null);
    const off = await Promise.all(GRID_ABSOLUTE.map(async (q) => { const r = await calibrationRun(q, null); return { q, m: r ? mean(neesSeries(r.history.filterHistory, segmentTruth(0))) : Infinity }; }));
    const maxHolds = Math.ceil(3 * 0.001 * ABS_N);
    const candidates = off.map((c, index) => ({ ...c, index })).filter((c) => c.m <= NEES_LIMIT).slice(0, 6);
    const screened = await Promise.all(candidates.map(async (c) => {
      const counts = await Promise.all(STRATEGIES.map(async (strategy) => { const r = await calibrationRun(c.q, recoveryOptions(strategy)); return r ? recoveryCounts(r.history.recoveryHistory) : { reinits: Infinity, holds: Infinity }; }));
      return { ...c, ok: counts.every((n) => n.reinits === 0 && n.holds <= maxHolds) };
    }));
    const chosen = screened.find((c) => c.ok);
    if (!chosen) report.failures.push(`ABS ${orbit.id}: no grid value passed the calibration (consistent NEES, no reinitialization, few holds)`);
    const qCal = chosen ? chosen.q : NaN, q = GRID_ABSOLUTE[Math.min((chosen ? chosen.index : GRID_ABSOLUTE.length - 2) + 1, GRID_ABSOLUTE.length - 1)];
    say(`ABS ${orbit.id}: q ${fq(qCal)}->${fq(q)} (calibration NEES ${fmt(chosen?.m ?? NaN, 2)} over ${ABS_N} observations; recovery-off NEES by q ${off.map((c) => `${c.q.toExponential(0)}:${fmt(c.m, 1)}`).join(' ')})`);
    const jobs = [];
    // Burn-free segments: off / predictive / persistence, plus the off run with the options present but disabled.
    for (let s = 0; s < ABS_SEGMENTS; ++s) {
      const spec = (recovery) => ({ start: s * ABS_ARC_S, initial: segmentInitial(s), truth: segmentTruth(s), count: ABS_N, q, recovery, rng: makeRng(seedOf(orbit.id, 'free', s)) });
      jobs.push({ tag: 'free', s, name: 'off', run: submit(spec(null)) });
      for (const strategy of STRATEGIES) jobs.push({ tag: 'free', s, name: STRATEGY_NAME[strategy], run: submit(spec(recoveryOptions(strategy))) });
      if (s === 0) jobs.push({ tag: 'free', s, name: 'off-explicit', run: submit(spec(recoveryDisabled())) });
    }
    // Outliers on segment 0.
    const shifts = { single: { 60: outlierAbsolute(1), 150: outlierAbsolute(1), 240: outlierAbsolute(-1) }, double: { 300: outlierAbsolute(1), 301: outlierAbsolute(-1) } };
    for (const kind of ['single', 'double']) for (const strategy of STRATEGIES)
      jobs.push({ tag: kind, name: STRATEGY_NAME[strategy], run: submit({ start: 0, initial: t.s0, truth: segmentTruth(0), count: ABS_N, q, recovery: recoveryOptions(strategy), rng: makeRng(seedOf(orbit.id, 'free', 0)), shifts: shifts[kind] }) });
    // Planted burns.
    for (const burn of [...IMPULSES.map((i) => i.id), 'finite']) {
      for (const [name, recovery] of [['off', null], ['predictive', recoveryOptions(A.RecoveryStrategy.PREDICTIVE_CONSISTENCY)], ['persistence', recoveryOptions(A.RecoveryStrategy.PERSISTENCE)]])
        jobs.push({ tag: 'burn', burn, name, run: submit({ start: 0, initial: t.s0, truth: t[burn], count: ABS_N, q, recovery, rng: makeRng(seedOf(orbit.id, 'free', 0)) }) });
    }
    for (const job of jobs) job.result = await job.run;
    results.push({ orbit, q, qCal, jobs, truth: t, segmentTruth });
    say(`ABS ${orbit.id}: ${jobs.length} filter arcs done (${jobs.reduce((s, j) => s + j.result.rounds, 0)} propagation rounds, ${Math.max(...jobs.map((j) => j.result.ms)) / 1000} s longest)`);
  }
  return results;
}

function summarizeAbsolute(abs) {
  const lines = [], falseReinits = [], singleResets = [];
  for (const { orbit, q, qCal, jobs, truth, segmentTruth } of abs) {
    const free = jobs.filter((j) => j.tag === 'free');
    const days = free.filter((j) => j.name === 'predictive').length * ABS_ARC_S / 86400;
    const by = (name) => free.filter((j) => j.name === name);
    const neesOf = (job, s) => neesSegment(neesSeries(job.result.history.filterHistory, segmentTruth(s)), 0, ABS_N, 30);
    const row = { orbit: orbit.id, q, qCal };
    for (const name of ['off', 'predictive', 'persistence']) {
      const jobsOf = by(name), nees = jobsOf.filter((j) => j.s > 0).map((j) => neesOf(j, j.s)).map((n) => n.mean);   // segments 1-3 (the calibration segment 0 is excluded)
      const counts = jobsOf.map((j) => recoveryCounts(j.result.history.recoveryHistory));
      row[name] = { nees: mean(nees), holds: counts.reduce((s, c) => s + c.holds, 0), transients: counts.reduce((s, c) => s + c.transients, 0), reinits: counts.reduce((s, c) => s + c.reinits, 0) };
    }
    const identical = Buffer.compare(Buffer.from(by('off').find((j) => j.s === 0).result.result), Buffer.from(by('off-explicit')[0].result.result)) === 0;
    const single = Object.fromEntries(['predictive', 'persistence'].map((n) => [n, recoveryCounts(jobs.find((j) => j.tag === 'single' && j.name === n).result.history.recoveryHistory)]));
    const double = Object.fromEntries(['predictive', 'persistence'].map((n) => [n, recoveryCounts(jobs.find((j) => j.tag === 'double' && j.name === n).result.history.recoveryHistory)]));
    falseReinits.push({ orbit: orbit.id, name: 'predictive', perDay: row.predictive.reinits / days }, { orbit: orbit.id, name: 'persistence', perDay: row.persistence.reinits / days });
    singleResets.push({ orbit: orbit.id, predictive: single.predictive.reinits, persistence: single.persistence.reinits });
    lines.push(`ABS ${orbit.id.padEnd(13)} q ${fq(qCal)}->${fq(q)}  object-days ${days}  NEES(segments 1-3) off ${fmt(row.off.nees, 2)} pred ${fmt(row.predictive.nees, 2)} pers ${fmt(row.persistence.nees, 2)}  pred hold/trans/reinit ${row.predictive.holds}/${row.predictive.transients}/${row.predictive.reinits} pers ${row.persistence.holds}/${row.persistence.transients}/${row.persistence.reinits}  false reinit/day ${fmt(row.predictive.reinits / days, 2)}|${fmt(row.persistence.reinits / days, 2)}  single-outlier resets ${single.predictive.reinits}|${single.persistence.reinits} (holds ${single.predictive.holds}|${single.persistence.holds})  double-outlier resets ${double.predictive.reinits}|${double.persistence.reinits}  off-identical ${identical}`);
    row.identical = identical;
    abs.rows = [...(abs.rows ?? []), row];
    // Burns.
    const kBurn = Math.ceil(ABS_BURN_S / CADENCE_S) - 1;
    for (const burn of [...IMPULSES.map((i) => i.id), 'finite']) {
      const parts = [];
      for (const name of ['off', 'predictive', 'persistence']) {
        const r = jobs.find((j) => j.tag === 'burn' && j.burn === burn && j.name === name).result.history;
        const rows = r.recoveryHistory, hist = r.filterHistory, truthRows_ = truth[burn];
        const err = (k) => (k < hist.length ? [norm3(hist[k].filteredState.map((x, i) => x - truthRows_[k][i])), norm3(hist[k].filteredState.map((x, i) => x - truthRows_[k][i]), 3)] : [NaN, NaN]);
        const kr = name === 'off' ? -1 : firstReinit(rows, kBurn);
        const at = (s) => Math.ceil((ABS_BURN_S + s) / CADENCE_S) - 1;
        const nis = Math.max(...hist.slice(kBurn, kBurn + 10).map((h) => h.normalizedInnovationSquared));
        parts.push(`${name}: ${name === 'off' ? 'tracks' : kr < 0 ? 'no reinit' : `latency ${secondsSince(rows[kr].decisionEpoch, EPOCH_JD) - ABS_BURN_S} s (${kr - kBurn + 1} obs)`} maxNIS10 ${fmt(nis, 1)} err pos/vel at reinit ${kr >= 0 ? `${fmt(err(kr)[0], 2)} m/${fmt(err(kr)[1] * 1000, 2)} mm/s` : 'n/a'} +10/+30/+60 min ${[600, 1800, 3600].map((s) => `${fmt(err(at(s))[0], 2)} m/${fmt(err(at(s))[1] * 1000, 2)} mm/s`).join(' ; ')}`);
        (abs.burns ??= []).push({ orbit: orbit.id, burn, name, kr, latency: kr >= 0 ? secondsSince(rows[kr].decisionEpoch, EPOCH_JD) - ABS_BURN_S : null, obs: kr >= 0 ? kr - kBurn + 1 : null });
      }
      lines.push(`ABS-BURN ${orbit.id.padEnd(13)} ${burn.padEnd(7)} | ${parts.join(' | ')}`);
    }
  }
  return { lines, falseReinits, singleResets };
}

// =========================================================================
// Recovery off leaves the numerics unchanged: the absolute EKF (nonlinear propagation through FFM, 120
// observations) on this module and on the committed module of the base commit, round by round, byte for byte.
// =========================================================================
async function baselineIdentity(estimator, truth) {
  const root = fileURLToPath(new URL('..', import.meta.url)), wasm = path.join(root, 'dist/isomorphic/module.wasm'), manifest = path.join(root, 'dist/plugin-manifest.json');
  if (!fs.existsSync(wasm) || !fs.existsSync(manifest)) return { skipped: true };
  const old = await harness(wasm, manifest), ffm = await openFfm();
  const t = truth['ISS-like'], count = 120;
  const envelope = unpack(absoluteRequest({ start: 0, initial: t.s0, truth: t.free.slice(0, count), count, q: 1e-8, recovery: null, rng: makeRng(seedOf('baseline')) }));
  const call = (host) => host.invoke({ methodId: 'run_estimation', inputs: [{ portId: 'request', typeRef, payload: pack(envelope) }, { portId: 'propagator_samples', typeRef, payload: EMPTY_LEGACY_PORT() }] });
  let rounds = 0, finalBytes = 0;
  for (;;) {
    const [a, b] = [await call(estimator), await call(old)];
    assert.equal(a.statusCode, b.statusCode, 'the two modules disagree on the status');
    assert.equal(a.statusCode, 0, `${a.errorCode}: ${a.errorMessage}`);
    // The committed artifact predates the SDS pin of this build, so the SDS ODR and OCM records it embeds
    // (the `odr` and `ocm` ports and the record bytes inside the result) differ; every estimator field is
    // compared: the decoded results with those record bytes emptied, repacked, byte for byte.
    const [pa, pb] = [a.outputs.find((o) => o.portId === 'result'), b.outputs.find((o) => o.portId === 'result')];
    const cleaned = (payload) => { const env = unpack(payload); env.result.odrRecord = []; env.result.ocmRecord = []; return Buffer.from(pack(env)); };
    assert.equal(Buffer.compare(cleaned(pa.payload), cleaned(pb.payload)), 0, `the result differs at round ${rounds}`);
    finalBytes += pa.payload.length;
    const result = unpack(a.outputs.find((o) => o.portId === 'result').payload).result;
    if (result.status !== A.EstimationStatus.NEEDS_PROPAGATION) break;
    envelope.propagationAnswers.push(...await answerQueries(ffm, result.propagationRequests, { stm: true, forces: ABS_FILTER_FORCES }));
    rounds += 1;
  }
  old.destroy?.(); ffm.destroy?.();
  return { skipped: false, rounds, count };
}

// =========================================================================
// Acceptance
// =========================================================================
function summarize(rel, abs, baseline, models) {
  const absSummary = summarizeAbsolute(abs);
  for (const line of absSummary.lines) say(line);
  say('\nACCEPTANCE');
  // 1. False reinitializations per object-day (burn-free).
  const worstRel = Math.max(...rel.cases.flatMap((c) => [c.falsePerDay.predictive, c.falsePerDay.persistence]));
  const worstAbs = Math.max(...absSummary.falseReinits.map((f) => f.perDay));
  const pairDays = rel.cases.length * N / (24 * 3600 / CADENCE_S);   // filter-days
  say(`false reinitializations per object-day, recovery on (NIS probability 0.999, confirmation count 2): relative ${rel.cases.length} filter runs x 3 days = ${pairDays} filter-days (the models of a chief share its truth), worst case ${fmt(worstRel, 3)} per day (predictive and persistence); absolute ${fmt(worstAbs, 3)} per day over ${ORBITS.length} orbits x ${ABS_SEGMENTS * ABS_ARC_S / 86400} object-day`);
  for (const c of rel.cases) for (const strategy of STRATEGIES) {
    const d = c.reinitDetails[strategy];
    check(d.length === 0, `false reinitializations per object-day, ${STRATEGY_NAME[strategy]}, ${c.chief} ${MODEL_SHORT[c.model]} ${c.sep} m (q ${c.q.toExponential(1)}): ${d.length} in 3 days = ${fmt(d.length / 3, 2)} per day, at ${d.map((x) => `${x.hours.toFixed(2)} h (chief true anomaly ${x.nuDeg.toFixed(0)} deg)`).join(', ')} (target 0)`);
  }
  for (const f of absSummary.falseReinits) check(f.perDay === 0, `absolute false reinitializations per object-day, ${f.name}, ${f.orbit}: ${f.perDay} (target 0)`);
  // 2. NEES.
  const nees = rel.cases.map((c) => c.offNees.mean).sort((a, b) => a - b);
  const [lo, hi] = [nees[0], nees.at(-1)];
  say(`NEES (evaluation 24-72 h, recovery off, expected 6): relative min ${fmt(lo, 2)} median ${fmt(nees[nees.length >> 1], 2)} max ${fmt(hi, 2)}; absolute ${abs.rows.map((r) => `${r.orbit} ${fmt(r.off.nees, 2)}`).join(', ')}`);
  for (const c of rel.cases) check(c.offNees.mean >= 3 && c.offNees.mean <= 12, `NEES ${c.offNees.mean} outside the factor-of-two band [3, 12] for ${c.chief} ${MODEL_NAME(c.model)} ${c.sep} m (q ${c.q})`);
  for (const r of abs.rows) check(r.off.nees >= 3 && r.off.nees <= 12, `absolute NEES ${r.off.nees} outside [3, 12] for ${r.orbit}`);
  // 3. Single outliers.
  const relSingle = rel.cases.map((c) => c.strategies[A.RecoveryStrategy.PREDICTIVE_CONSISTENCY].singleResets);
  say(`resets caused by a single injected outlier, predictive_consistency: relative max ${Math.max(...relSingle)} over ${relSingle.length} cases x 3 outliers; absolute ${absSummary.singleResets.map((s) => `${s.orbit} ${s.predictive}`).join(', ')}`);
  check(Math.max(...relSingle) === 0, 'a single injected outlier reset a relative predictive_consistency filter');
  for (const s of absSummary.singleResets) check(s.predictive === 0, `a single injected outlier reset the absolute predictive_consistency filter (${s.orbit})`);
  // 4. Recovery off byte identity.
  check(rel.cases.every((c) => c.identical), 'recovery off with the options present is not byte-identical to the options absent (relative)');
  for (const r of abs.rows) check(r.identical, `recovery off with the options present is not byte-identical to the options absent (absolute ${r.orbit})`);
  say(`recovery off byte-identical (options absent vs enabled=false): relative ${rel.cases.filter((c) => c.identical).length}/${rel.cases.length}, absolute ${abs.rows.filter((r) => r.identical).length}/${abs.rows.length}`);
  say(baseline.skipped ? 'absolute recovery off vs the committed base module: skipped (no committed artifact)' : `absolute recovery off vs the committed base-commit module: every estimator field byte-identical in all ${baseline.rounds + 1} rounds of a ${baseline.count}-observation EKF arc (the SDS ODR and OCM records are excluded: the committed artifact predates this build's SDS pin)`);
  // 5. Conversion.
  check(rel.conversion.positionRatio <= 1 && rel.conversion.rateRatio <= 1 && rel.conversion.chiefWorst < 1e-9, `conversion differs from the reference by ${rel.conversion.positionWorst} m (${rel.conversion.positionRatio} of its bound) / ${rel.conversion.rateWorst} m/s (${rel.conversion.rateRatio}), elements ${rel.conversion.chiefWorst}`);
  // 5b. Curvilinear RTN and the two-body model check.
  const cv = rel.curvilinear;
  check(cv.position <= 1e-6 * 1000 && cv.rate <= 1e-6 * cv.rateScale, `curvilinear run differs from the mapped rectilinear run by ${cv.position} m / ${cv.rate} m/s`);
  for (const r of models.filter((m) => m.error)) {
    check(r.error.position <= r.bound.position, `${r.chief} ${MODEL_NAME(r.model)} +${r.dt} s: prediction position error ${r.error.position} m exceeds its bound ${r.bound.position}`);
    check(r.error.rate <= r.bound.rate, `${r.chief} ${MODEL_NAME(r.model)} +${r.dt} s: prediction rate error ${r.error.rate} m/s exceeds its bound ${r.bound.rate}`);
  }
  for (const r of models.filter((m) => m.agreement)) check(r.agreement.position < 1e-6 && r.agreement.rate < 1e-6, `${r.chief} +${r.dt} s: TH and YA predictions differ by ${r.agreement.position} / ${r.agreement.rate}`);
  say(`two-body model check: ${models.filter((m) => m.error).length} model-interval predictions within their bounds (worst error/bound ${Math.max(...models.filter((m) => m.error).flatMap((m) => [m.error.position / m.bound.position, m.error.rate / m.bound.rate])).toFixed(3)}); TH vs YA worst relative difference ${Math.max(...models.filter((m) => m.agreement).flatMap((m) => [m.agreement.position, m.agreement.rate])).toExponential(2)}`);
  const qs = rel.cases.map((c) => c.q);
  say(`operating process-noise PSD (m^2/s^3): relative min ${Math.min(...qs).toExponential(1)} max ${Math.max(...qs).toExponential(1)}; absolute ${abs.rows.map((r) => `${r.orbit} ${r.q.toExponential(1)}`).join(', ')}`);
  const latencies = (burn, key) => rel.burns.filter((b) => b.burn === burn).map((b) => b.runs[key].latency);
  const range = (list) => (list.every((v) => v === null) ? 'none' : `${list.filter((v) => v !== null).length}/${list.length} reinitialized, ${Math.min(...list.filter((v) => v !== null))}-${Math.max(...list.filter((v) => v !== null))} s`);
  for (const burn of ['imp1cm', 'imp10cm', 'imp1m', 'finite']) say(`recovery latency after ${burn} (relative, ${rel.burns.filter((b) => b.burn === burn).length} chief/model cases): predictive ${range(latencies(burn, 'pred'))}; persistence ${range(latencies(burn, 'pers'))}`);
  // 6. Burns >= 10 cm/s recovered.
  const MAX_OBS = 3;
  for (const b of rel.burns.filter((x) => x.burn === 'imp10cm' || x.burn === 'imp1m'))
    for (const name of ['pred', 'pers']) {
      const r = b.runs[name];
      check(r.kr >= 0 && r.latency !== null && r.latency <= MAX_OBS * CADENCE_S + 30, `${b.chief} ${MODEL_SHORT[b.model]} ${b.burn}: ${name} did not reinitialize within ${MAX_OBS} observations (latency ${r.latency}, max NIS in the next 10 observations ${r.nisAfter})`);
    }
  // The maximum observation gap: with one observation dropped after the burn (a 120 s gap, within the maximum) the
  // reinitialization takes one observation longer (150 s after the burn); with two dropped (180 s, beyond it) the pending
  // discrepancy has expired and two fresh observations are needed (270 s).
  for (const b of rel.burns.filter((x) => x.burn === 'imp1m'))
    for (const name of ['pred', 'pers']) check(b.dropout[name][120] === 150 && b.dropout[name][180] === 270, `${b.chief} ${MODEL_SHORT[b.model]} imp1m: ${name} reinitialized ${b.dropout[name][120]} s / ${b.dropout[name][180]} s after the burn with a 120 s / 180 s gap (expected 150 / 270)`);
  for (const b of abs.burns.filter((x) => (x.burn === 'imp10cm' || x.burn === 'imp1m') && x.name !== 'off'))
    check(b.latency !== null && b.latency <= MAX_OBS * CADENCE_S + 30, `${b.orbit} absolute ${b.burn}: ${b.name} did not reinitialize within ${MAX_OBS} observations (latency ${b.latency})`);
}

if (process.argv.includes('--worker')) await workerMain();
else if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(SELF)).href) {
  main().then(() => process.exit(process.exitCode ?? 0), (error) => { console.error(error); process.exit(1); });
}

