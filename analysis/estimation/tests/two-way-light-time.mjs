// One end-to-end test, not a node:test unit suite. Run after build.mjs:
//   node tests/build-provider.mjs && node tests/two-way-light-time.mjs
// Authority: Orekit 13.1 Range / ShapiroRangeModifier and the negative station
// clock-offset derivative of unmodified Range. SI, GCRF, elapsed TAI seconds from
// 2026-10-11T00:00:00 UTC. Java generates truth; C++/WASM computes our physics.
// The 0.1 mm range tolerance resolves both station curvature and Shapiro;
// the rate tolerance is 0.01 mm/s, 30x below DORIS Doppler noise 0.3–0.5 mm/s.
// Predicted EOP velocity lacking LOD gives an expected few 1e-6 m/s difference.
// Noise-free fit limits
// are 1 mm / 1 um/s (LEO), 1 cm (MEO), with weighted RMS <= 1e-3.
// Simulator reference: independent zero-EOP ITRF, same UTC epoch, six hours;
// a=7000000 m, e=0, i=97.8 deg, RAAN=130 deg, argument of perigee=0 deg,
// mean anomaly=270 deg. Java supplies 1 s PV, sampled by the module every 10 s.
// This 622 km orbit bounds every >10 deg slant range below 2048 km, where
// float32 kilometre rounding is at most 0.0611 m; no observations are filtered
// for favourable rounding. Its phase supplies at least eight minutes per site.
// Double radar ranges are gated at 1 mm and rates at 0.01 mm/s; the EOO laser
// range is float32 km, so its representation tolerance is 0.1 m. The simulator
// fit allows 5 mm and 1e-5 m/s: a half-microsecond tag at LEO speed alone allows
// about 3.75 mm, plus the independently transformed station/target PV budget.
// Measured: radar 1.28e-8 m / 4.10e-7 m/s, laser 0.05995 m, epoch recovery
// 1.53e-7 m / 2.21e-10 m/s; the UTC wire tags match the oracle exactly.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing/browser';
import { api, encode, pack, typeRef, unpack } from './wire.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const generated = path.join(here, '.generated');

function chooseDirectory(variable, candidates, required) {
  if (process.env[variable]) candidates = [process.env[variable]];
  const selected = candidates.find((directory) => required(directory));
  assert.ok(selected, `${variable}: no provisioned directory among ${candidates.join(', ')}; the E2E never skips Orekit`);
  return selected;
}

function orekitFixture() {
  const javaCandidates = process.env.JAVA ? [process.env.JAVA] : ['java', '/opt/homebrew/opt/openjdk/bin/java'];
  const java = javaCandidates.find((candidate) => spawnSync(candidate, ['-version'], { encoding: 'utf8' }).status === 0);
  assert.ok(java, `no working Java launcher among ${javaCandidates.join(', ')}; the E2E never skips Orekit`);
  const jars = chooseDirectory('OREKIT_JARS', ['/Users/tj/software/gmat09-authority/jars', path.join(generated, 'orekit/jars')],
    (dir) => fs.existsSync(dir) && fs.readdirSync(dir).some((name) => /^orekit-13\.1\.jar$/.test(name)));
  const data = chooseDirectory('OREKIT_DATA', ['/Users/tj/software/gmat09-authority/orekit-data/orekit-data-main', path.join(generated, 'orekit/data')],
    (dir) => fs.existsSync(path.join(dir, 'tai-utc.dat')) && fs.existsSync(path.join(dir, 'Earth-Orientation-Parameters/IAU-2000/finals2000A.all')));
  const output = path.join(generated, 'orekit-two-way-light-time.json');
  const stdout = execFileSync(java, ['-cp', path.join(jars, '*'), path.join(here, 'fixtures/OrekitBatchReference.java'), '--light-time', data, output],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 << 20 });
  if (stdout.trim()) console.log(stdout.trim());
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

const zero3 = [0, 0, 0];
const zero6 = [0, 0, 0, 0, 0, 0];
const zero36 = Array(36).fill(0);
const identity = zero36.map((_, i) => i % 7 === 0 ? 1 : 0);
const perturbation = [150, -100, 80, 0.15, -0.1, 0.08];
const scientific = (value) => Number.isFinite(value) ? value.toExponential(6) : '—';
const failures = [];
const check = (condition, message) => { if (!condition) { failures.push(message); console.log(`FAIL ${message}`); } };

function observation(epochJdDay, pair, kind, flags) {
  return {
    epoch: { jd_day: epochJdDay, seconds: pair.seconds }, value: [0, 0, 0, 0], sigma: [1, 1, 1, 1],
    station_position_m: zero3, station_velocity_mps: zero3, station_east: zero3, station_north: zero3, station_up: zero3,
    remote_position_m: zero3, remote_velocity_mps: zero3, frequency_hz: 0, transmitter_delay_seconds: 0,
    receiver_delay_seconds: 0, transponder_delay_seconds: 0, elevation_rad: 0, station_latitude_rad: 0, station_height_m: 0,
    pressure_hpa: 0, temperature_k: 0, relative_humidity: 0, wavelength_m: 0, total_electron_content: 0,
    total_electron_content_rate_per_second: 0, turnaround_numerator: 1, turnaround_denominator: 1,
    kind, value_count: 1, flags, transmitter_index: 0, receiver_index: 0,
  };
}

function requestEnvelope(fixture, regime, kind = 'LASER_RANGE', flags = 0x04) {
  const envelope = unpack(encode({ request: {
    config: { initial_epoch: { jd_day: fixture.epochJdDay, seconds: 0 }, initial_state: zero6,
      initial_covariance: zero36, process_noise_spectral_density: zero6, state_convergence_tolerance: 0,
      rms_convergence_tolerance: 0, sigma_edit_threshold: 0, dynamic_model_correlation_time_seconds: 0,
      maximum_iterations: 0, reference_frame: 'ICRF', estimator: 'BATCH_WEIGHTED_LEAST_SQUARES', process_noise: 'NONE', flags: 0 },
    observations: regime.pairs.map((pair) => observation(fixture.epochJdDay, pair, kind, flags)),
    error_models: [{ measurement_kind: kind, noise_sigma: 0, bias: 0, bias_sigma: 0, correlation_time_seconds: 0,
      minimum_value: 0, maximum_value: 0, sigma_edit_threshold: 0, random_seed: 1, troposphere: 'NONE', ionosphere: 'NONE', flags: 0 }],
    propagator_port_id: 'test-provider', propagator_capability: 'plugin_propagate plugin_compute_stm', trace_id: 'two-way-light-time',
    batch_options: { parameter_kinds: [], parameter_values: [], maximum_iterations: 25, correction_tolerance: 1e-3, sigma_edit_threshold: 0 },
  }, propagator_samples: regime.pairs.map((pair) => ({ epoch: { jd_day: fixture.epochJdDay, seconds: pair.seconds }, state: zero6, stm: zero36 })) }));
  // The generated object API preserves all double bits; flatc's JSON printer
  // rounds decimals, so actual PV, observations and state bypass that printer.
  // The generated object packer emits even empty table vectors. Preserve the
  // absent extended-observation field using its generated builder API, since
  // simulate_tracking only accepts the ordinary observation wire path.
  envelope.request.pack = function (builder) {
    const A = api().EstimationRequest;
    const observations = builder.createStructOffsetList(this.observations, A.startObservationsVector);
    const errorModels = builder.createStructOffsetList(this.errorModels, A.startErrorModelsVector);
    const port = builder.createString(this.propagatorPortId);
    const capability = builder.createString(this.propagatorCapability);
    const trace = builder.createString(this.traceId);
    const batchOptions = this.batchOptions.pack(builder);
    A.startEstimationRequest(builder);
    A.addConfig(builder, this.config.pack(builder));
    A.addObservations(builder, observations);
    A.addErrorModels(builder, errorModels);
    A.addPropagatorPortId(builder, port);
    A.addPropagatorCapability(builder, capability);
    A.addTraceId(builder, trace);
    A.addBatchOptions(builder, batchOptions);
    return A.endEstimationRequest(builder);
  };
  envelope.request.config.initialState = [...regime.truth];
  regime.pairs.forEach((pair, i) => {
    const record = envelope.request.observations[i];
    record.epoch.seconds = pair.seconds;
    record.stationPositionM = pair.stationPV.slice(0, 3);
    record.stationVelocityMps = pair.stationPV.slice(3);
    record.value = [pair.rangeM, 0, 0, 0];
    record.sigma = [0.01, 1, 1, 1];
    const sample = envelope.propagatorSamples[i];
    sample.epoch.seconds = pair.seconds;
    sample.state = [...pair.satellite];
    sample.stm = [...identity];
  });
  return envelope;
}

async function invoke(harness, methodId, inputs) {
  const response = await harness.invoke({ methodId, inputs });
  assert.equal(response.statusCode, 0, `${methodId}: ${response.errorCode}: ${response.errorMessage}`);
  return response;
}

async function simulate(estimator, envelope) {
  const response = await invoke(estimator, 'simulate_tracking', [
    { portId: 'request', typeRef, payload: pack(envelope) },
    { portId: 'propagator_samples', typeRef, payload: pack(envelope) },
  ]);
  const observations = unpack(response.outputs.find((output) => output.portId === 'observations').payload).simulatedObservations;
  assert.equal(observations.length, envelope.request.observations.length);
  return observations.map((record) => record.value[0]);
}

async function fit(estimator, provider, fixture, regime, options = {}) {
  const envelope = requestEnvelope(fixture, regime, options.kind ?? 'LASER_RANGE');
  // This fit has no error model overriding the observations' 1 cm sigmas.
  envelope.request.errorModels = [];
  envelope.request.config.initialState = regime.truth.map((value, i) => value + perturbation[i]);
  for (let round = 0; round < 60; ++round) {
    const response = await invoke(estimator, 'fit_batch', [{ portId: 'request', typeRef, payload: pack(envelope) }]);
    const bytes = response.outputs.find((output) => output.portId === 'result').payload;
    const result = unpack(bytes).result;
    if (result.status !== 1) {
      check(result.status === 0, `${regime.name} fit status ${result.status}`);
      const batch = result.batchFit;
      check(batch?.converged, `${regime.name} fit did not converge`);
      if (!batch) return null;
      const positionError = Math.hypot(...batch.estimate.slice(0, 3).map((value, i) => value - regime.truth[i]));
      const velocityError = Math.hypot(...batch.estimate.slice(3, 6).map((value, i) => value - regime.truth[i + 3]));
      const positionTolerance = options.positionTolerance ?? (regime.name === 'LEO' ? 1e-3 : 1e-2);
      const velocityTolerance = options.velocityTolerance ?? (regime.name === 'LEO' ? 1e-6 : Infinity);
      const before = failures.length;
      check(positionError <= positionTolerance, `${regime.name} fit position ${positionError} m > ${positionTolerance} m`);
      check(velocityError <= velocityTolerance, `${regime.name} fit velocity ${velocityError} m/s > ${velocityTolerance} m/s`);
      if (options.checkWeightedRms !== false) check(batch.weightedRms <= 1e-3, `${regime.name} weighted RMS ${batch.weightedRms} > 1e-3`);
      console.log(`${failures.length === before && batch.converged ? 'PASS' : 'FAIL'} ${regime.name} fit_batch: position ${scientific(positionError)} m, velocity ${scientific(velocityError)} m/s, weighted RMS ${scientific(batch.weightedRms)}, ${round} provider rounds`);
      return { positionError, velocityError, weightedRms: batch.weightedRms };
    }
    const answers = await invoke(provider, 'test_propagate', [{ portId: 'request', typeRef, payload: bytes }]);
    envelope.propagationAnswers.push(...unpack(answers.outputs.find((output) => output.portId === 'result').payload).propagationAnswers);
  }
  assert.fail(`${regime.name}: fit_batch did not complete in 60 provider rounds`);
}

// UTC wire timestamps have microsecond precision. This parses their encoding;
// the satellite trajectory, frame transforms and light time remain in WASM/Java.
function utcMicroseconds(utc) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z?$/.exec(utc);
  assert.ok(match, `invalid UTC timestamp ${utc}`);
  return BigInt(Date.parse(`${match[1]}Z`)) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

async function simulatorLeg(estimator, provider, fixture) {
  const truth = fixture.simulator;
  assert.ok(truth, 'Orekit fixture must include the observation-simulator reference');
  assert.equal(truth.frame, 'GCRF');
  assert.equal(truth.terrestrialFrame, 'ITRF');
  assert.equal(truth.stepSeconds, 1);
  assert.ok(truth.spanSeconds <= 21600, 'simulator fixture must span at most six hours');
  assert.deepEqual(truth.orbit, { aM: 7000000, e: 0, iDeg: 97.8, raanDeg: 130, argpDeg: 0, mDeg: 270 });
  assert.deepEqual(truth.stations.map((site) => site.name), ['Graz', 'Yarragadee', 'Greenbelt']);
  const { ACW, RDO, EOO, flatbuffers, manifest, wasm, sample, station, target, model, sensor, access, request } =
    await import('../../observation-simulator/tests/lib.mjs');
  const targetId = 'two-way-satellite';
  const sampleBySecond = new Map(truth.samples.map((record) => [record.seconds, record]));
  const pairByTimeStation = new Map(truth.pairs.map((pair) => [`${pair.station}|${pair.seconds}`, pair]));
  const stationBySensor = new Map();
  const sensors = [], accesses = [];
  let expectedRadar = 0, expectedLaser = 0;
  for (const site of truth.stations) {
    const windows = truth.intervals.filter((interval) => interval.station === site.name);
    const visibleSeconds = windows.reduce((total, interval) => total + interval.endSeconds - interval.startSeconds, 0);
    check(visibleSeconds >= 480, `simulator: ${site.name} has only ${visibleSeconds} seconds of visibility, expected at least 480`);
    const count = windows.reduce((total, interval) => total + Math.floor((interval.endSeconds - interval.startSeconds) / 10) + 1, 0);
    check(count > 0, `simulator: ${site.name} has no scheduled visible observations`);
    const jdWindows = windows.map((interval) => [sampleBySecond.get(interval.startSeconds).jdTt, sampleBySecond.get(interval.endSeconds).jdTt]);
    const radarId = `${site.name}-radar`;
    stationBySensor.set(radarId, site.name);
    const models = ['RANGE', 'RANGE_RATE', ...(site.name === 'Graz' ? ['DOPPLER'] : [])]
      .map((kind) => model(kind, 0, { APPLY_LIGHT_TIME: true }));
    sensors.push(sensor(radarId, site.name, 'RADAR', models, {
      OBSERVATION_INTERVAL_S: 10, FALSE_ALARM_RATE_PER_HOUR: 0, TRANSMIT_FREQUENCY_HZ: 5.8e9,
    }));
    accesses.push(access(radarId, targetId, jdWindows));
    expectedRadar += count;
    if (site.name === 'Graz') {
      const laserId = `${site.name}-laser`;
      stationBySensor.set(laserId, site.name);
      sensors.push(sensor(laserId, site.name, 'OPTICAL', [model('LASER_RANGE', 0, { APPLY_LIGHT_TIME: true })], {
        OBSERVATION_INTERVAL_S: 10, FALSE_ALARM_RATE_PER_HOUR: 0,
        MAX_HOST_SUN_ELEVATION_RAD: Math.PI / 2, LIMITING_MAGNITUDE: 0,
      }));
      accesses.push(access(laserId, targetId, jdWindows));
      expectedLaser += count;
    }
  }
  const firstJd = truth.samples[0].jdTt, lastJd = truth.samples.at(-1).jdTt;
  const bytes = request({
    GROUND_STATIONS: truth.stations.map((site) => station(site.name, site.latitudeDeg, site.longitudeDeg, site.heightM)),
    TARGETS: [target(targetId, truth.samples.map((record) => sample(record.jdTt, record.itrf.slice(0, 3), record.itrf.slice(3))))],
    // Synthetic illumination makes detection deterministic; it does not enter
    // range or rate. Visible Graz targets lie on the positive-X Earth hemisphere.
    SUN_STATES: [sample(firstJd, [149597870700, 0, 0]), sample(lastJd, [149597870700, 0, 0])],
    SENSORS: sensors, ACCESS: accesses,
  });
  const simulator = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  let response;
  try {
    response = await invoke(simulator, 'simulate_observations', [{ portId: 'request', payload: bytes,
      typeRef: { schemaName: 'ACW.fbs', fileIdentifier: '$ACW', rootTypeName: 'ACW', wireFormat: 'flatbuffer' } }]);
  } finally {
    simulator.destroy?.();
  }
  const read = (port, module, code) => response.outputs.filter((output) => output.portId === port)
    .map((output) => module[code][`getRootAs${code}`](new flatbuffers.ByteBuffer(new Uint8Array(output.payload))).unpack());
  const radar = read('radar', RDO, 'RDO'), laser = read('optical', EOO, 'EOO');
  const result = read('result', ACW, 'ACW')[0].RESULT;
  const before = failures.length;
  check(radar.length === expectedRadar, `simulator: ${radar.length} radar observations, expected ${expectedRadar}`);
  check(laser.length === expectedLaser && laser.length > 0, `simulator: ${laser.length} laser observations, expected ${expectedLaser}`);
  check(result.TRACKS.every((track) => track.SCHEDULED_COUNT === track.DETECTED_COUNT), 'simulator: unexpected detection losses');
  const epochMicroseconds = utcMicroseconds(fixture.epochUtc);
  let rangeDifference = 0, rateDifference = 0, laserDifference = 0, oneWayDifference = 0, timeDifferenceUs = 0, dopplerCount = 0;
  const fitPairs = [], seen = new Set();
  for (const record of [...radar, ...laser]) {
    const sensorId = record.ID_SENSOR ?? record.SENSOR_ID;
    const stationName = stationBySensor.get(sensorId);
    const elapsedUs = utcMicroseconds(record.OB_TIME) - epochMicroseconds;
    const seconds = Number((elapsedUs + 500000n) / 1000000n);
    const pair = pairByTimeStation.get(`${stationName}|${seconds}`);
    assert.ok(pair, `simulator: no Orekit reference for ${sensorId} at ${record.OB_TIME}`);
    const key = `${sensorId}|${seconds}`;
    assert.ok(!seen.has(key), `simulator: duplicate observation ${key}`);
    seen.add(key);
    timeDifferenceUs = Math.max(timeDifferenceUs, Math.abs(Number(utcMicroseconds(record.OB_TIME) - utcMicroseconds(pair.utc))));
    const rangeM = record.RANGE * 1000;
    if (sensorId.endsWith('-laser')) {
      laserDifference = Math.max(laserDifference, Math.abs(rangeM - pair.rangeM));
    } else {
      rangeDifference = Math.max(rangeDifference, Math.abs(rangeM - pair.rangeM));
      rateDifference = Math.max(rateDifference, Math.abs(record.RANGE_RATE * 1000 - pair.rangeDerivativeAutomaticMps));
      oneWayDifference = Math.max(oneWayDifference, Math.abs(rangeM - pair.oneWayRangeM));
      fitPairs.push({ ...pair, rangeM });
      if (sensorId === 'Graz-radar') {
        // The requested wire-unit/factor check: the same RDO rate and carrier
        // must encode the monostatic echo's double Doppler shift.
        const expectedDoppler = -2 * 5.8e9 * (record.RANGE_RATE * 1000) / 299792458;
        const rounding = 16 * Number.EPSILON * Math.max(1, Math.abs(expectedDoppler));
        check(record.DOPPLER_FREQUENCY === 5.8e9 && Math.abs(record.DOPPLER - expectedDoppler) <= rounding,
          `simulator: Doppler factor or carrier mismatch at ${record.OB_TIME}`);
        ++dopplerCount;
      }
    }
  }
  check(timeDifferenceUs <= 1, `simulator: UTC timestamps differ by ${timeDifferenceUs} us > 1 us`);
  check(rangeDifference <= 1e-3, `simulator: radar range error ${rangeDifference} m > 1e-3 m`);
  check(rateDifference <= 1e-5, `simulator: radar rate error ${rateDifference} m/s > 1e-5 m/s`);
  check(laserDifference <= 0.1, `simulator: float laser range error ${laserDifference} m > 0.1 m`);
  check(oneWayDifference > 0.5, `simulator: one-way sensitivity is only ${oneWayDifference} m`);
  check(dopplerCount > 0, 'simulator: no Doppler observations compared');
  console.log(`${failures.length === before ? 'PASS' : 'FAIL'} simulator: ${radar.length} radar, ${laser.length} laser, ${dopplerCount} Doppler records; UTC ${timeDifferenceUs} us, range ${scientific(rangeDifference)} m, rate ${scientific(rateDifference)} m/s, float laser ${scientific(laserDifference)} m, one-way control ${scientific(oneWayDifference)} m`);
  fitPairs.sort((left, right) => left.seconds - right.seconds);
  const recovery = await fit(estimator, provider, fixture, { name: 'simulator LEO', truth: truth.truth, pairs: fitPairs },
    { kind: 'RANGE', positionTolerance: 0.005, velocityTolerance: 1e-5, checkWeightedRms: false });
  return { observations: radar.length + laser.length, rangeDifference, rateDifference, laserDifference, oneWayDifference, fit: recovery };
}

async function main() {
  const fixture = orekitFixture();
  assert.match(fixture.source, /Orekit 13\.1/);
  assert.equal(fixture.frame, 'GCRF');
  assert.equal(fixture.epochUtc, '2026-10-11T00:00:00.000');
  assert.equal(fixture.rangeToleranceM, 1e-4);
  assert.equal(fixture.rateToleranceMps, 1e-5);
  assert.deepEqual(fixture.regimes.map((regime) => regime.name), ['LEO', 'MEO', 'GEO']);
  const providerPath = path.join(generated, 'provider/dist/isomorphic/module.wasm');
  assert.ok(fs.existsSync(providerPath), 'run node tests/build-provider.mjs first');
  const estimator = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(root, 'dist/isomorphic/module.wasm')),
    manifest: JSON.parse(fs.readFileSync(path.join(root, 'plugin-manifest.json'), 'utf8')), surface: 'direct' });
  const provider = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(providerPath), surface: 'direct' });
  const rows = [];
  let simulatorRow;
  try {
    for (const regime of fixture.regimes) {
      assert.ok(regime.pairs.length >= 30, `${regime.name}: only ${regime.pairs.length} visible pairs`);
      const envelope = requestEnvelope(fixture, regime);
      const ranges = await simulate(estimator, envelope);
      const rates = await simulate(estimator, requestEnvelope(fixture, regime, 'RANGE_RATE'));
      const legacy = await simulate(estimator, requestEnvelope(fixture, regime, 'LASER_RANGE', 0x00));
      const correctionsDisabled = regime.name === 'LEO'
        ? await simulate(estimator, requestEnvelope(fixture, regime, 'LASER_RANGE', 0x03)) : null;
      const errorModelEnvelope = requestEnvelope(fixture, regime, 'LASER_RANGE', 0x00);
      errorModelEnvelope.request.errorModels[0].flags = 0x04;
      assert.deepEqual(await simulate(estimator, errorModelEnvelope), ranges, `${regime.name}: error-model bit 0x04 differs from observation bit 0x04`);
      let rangeDifference = 0, rateDifference = 0, legacyDifference = 0, correctionsDisabledDifference = 0;
      regime.pairs.forEach((pair, i) => {
        const rangeError = Math.abs(ranges[i] - pair.rangeM);
        const rateError = Math.abs(rates[i] - pair.rangeDerivativeAutomaticMps);
        rangeDifference = Math.max(rangeDifference, rangeError);
        rateDifference = Math.max(rateDifference, rateError);
        legacyDifference = Math.max(legacyDifference, Math.abs(legacy[i] - pair.rangeM));
        if (correctionsDisabled) correctionsDisabledDifference = Math.max(correctionsDisabledDifference, Math.abs(correctionsDisabled[i] - pair.rangeM));
      });
      const before = failures.length;
      check(rangeDifference <= fixture.rangeToleranceM, `${regime.name}: max range error ${rangeDifference} m > ${fixture.rangeToleranceM} m`);
      check(rateDifference <= fixture.rateToleranceMps, `${regime.name}: max range derivative error ${rateDifference} m/s > ${fixture.rateToleranceMps} m/s`);
      if (regime.name === 'LEO') {
        // Legacy already includes first-order light time and Sagnac, so its
        // missing effects are millimetres; disabling all corrections is the
        // independent metre-scale negative control.
        check(legacyDifference > fixture.rangeToleranceM, `legacy sensitivity: LEO disagreement ${legacyDifference} m does not exceed range tolerance`);
        check(correctionsDisabledDifference > 1, `corrections-disabled sensitivity: LEO disagreement is only ${correctionsDisabledDifference} m`);
      }
      console.log(`${failures.length === before ? 'PASS' : 'FAIL'} ${regime.name}: ${regime.pairs.length} pairs, max range ${scientific(rangeDifference)} m, rate derivative ${scientific(rateDifference)} m/s, legacy ${scientific(legacyDifference)} m${correctionsDisabled ? `, corrections disabled ${scientific(correctionsDisabledDifference)} m` : ''}`);
      rows.push({ regime: regime.name, pairs: regime.pairs.length, rangeDifference, rateDifference, legacyDifference,
        fit: regime.name === 'GEO' ? null : await fit(estimator, provider, fixture, regime) });
    }
    simulatorRow = await simulatorLeg(estimator, provider, fixture);
  } finally {
    estimator.destroy?.();
    provider.destroy?.();
  }
  console.log('\nregime | pairs | max |ours - Orekit| (m) | rate difference (m/s) | legacy disagreement (m) | fit recovery (m, m/s)');
  for (const row of rows) console.log(`${row.regime} | ${row.pairs} | ${scientific(row.rangeDifference)} | ${scientific(row.rateDifference)} | ${scientific(row.legacyDifference)} | ${row.fit ? `${scientific(row.fit.positionError)}, ${scientific(row.fit.velocityError)}` : 'not requested'}`);
  console.log('\nsimulator | observations compared | max range (m) | max rate (m/s) | float laser (m) | one-way control (m) | fit recovery (m, m/s)');
  console.log(`LEO | ${simulatorRow.observations} | ${scientific(simulatorRow.rangeDifference)} | ${scientific(simulatorRow.rateDifference)} | ${scientific(simulatorRow.laserDifference)} | ${scientific(simulatorRow.oneWayDifference)} | ${simulatorRow.fit ? `${scientific(simulatorRow.fit.positionError)}, ${scientific(simulatorRow.fit.velocityError)}` : 'failed'}`);
  if (failures.length) {
    console.error(`FAIL two-way light time E2E: ${failures.length} acceptance checks failed (reported above)`);
    process.exitCode = 1;
    return;
  }
  console.log('PASS two-way light time E2E: Orekit ranges with Shapiro, receive-time range derivatives, legacy sensitivity, LEO and MEO fit_batch recovery, observation-simulator radar/laser/Doppler and fit round trip');
}

try { await main(); } catch (error) { console.error(`FAIL two-way light time E2E: ${error.message}`); process.exitCode = 1; }
