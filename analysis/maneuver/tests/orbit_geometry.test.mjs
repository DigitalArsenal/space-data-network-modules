import assert from "node:assert/strict";
import test from "node:test";
import {
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "space-data-module-sdk/testing/isomorphic";

const wasm = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const circle = {
  mu: 1,
  elements: { semiMajorAxis: 1, eccentricity: 0, inclination: 0,
    raan: 0, argumentOfPeriapsis: 0, trueAnomaly: 0 },
};
const near = (actual, expected, tolerance, label = "value") =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected} within ${tolerance}`);
const vectorNear = (actual, expected, tolerance) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => near(v, expected[i], tolerance, `component ${i}`));
};

// The same published Orekit reference and analytic dimensionless circle run on
// all surfaces of ONE artifact. Frame: fixed inertial axes. Units: SI/radians.
// Epoch: Orekit 2000-04-01T00:00:00Z; circular tests use elapsed SI seconds from
// an arbitrary epoch, as the two-body problem is time-translation invariant.
for (const [runtime, surface] of [["browser", "command"], ["browser", "direct"], ["wasmedge", "command"]]) {
  test(`native orbit geometry references and recovery: ${runtime}/${surface}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtime, wasm, t, {surface, enableThreads: true});
    if (!harness) return;
    t.after(() => harness.destroy());
    const invoke = (operation, params) => invokeJsonRequest(harness, {operation, params});

    // Orekit KeplerianOrbitTest.testJacobianReferenceEllipse, also consumed by
    // foundation/orbits. 10 micrometres / 10 nanometres/s allow the published
    // decimal precision and independent conversion paths.
    const reference = await invoke("evaluateOrbitGeometry", {
      mu: 398600441500000,
      elements: {semiMajorAxis: 7000000, eccentricity: 0.01,
        inclination: 80 * Math.PI / 180, raan: 20 * Math.PI / 180,
        argumentOfPeriapsis: 80 * Math.PI / 180, meanAnomaly: 40 * Math.PI / 180},
    });
    vectorNear(reference.state.position, [-3691555.5698748335, -240330.25399271487, 5879700.285850423], 1e-5);
    vectorNear(reference.state.velocity, [-5936.229884450408, -2871.067660163344, -3786.2095491927267], 1e-8);
    near(reference.elements.meanAnomaly, 40 * Math.PI / 180, 1e-14);

    // Analytic circle: r=v=mu=1, angular speed 1 rad/s, period 2pi s.
    // 1e-12 covers transcendental rounding; no generated golden is used.
    const before = await invoke("evaluateOrbitGeometry", circle);
    vectorNear(before.state.position, [1, 0, 0], 1e-12);
    vectorNear(before.state.velocity, [0, 1, 0], 1e-12);
    near(before.elements.period, 2 * Math.PI, 1e-12);
    const quarter = await invoke("evaluateOrbitGeometry", {...circle, elapsedSeconds: Math.PI / 2});
    vectorNear(quarter.state.position, [0, 1, 0], 1e-12);
    vectorNear(quarter.state.velocity, [-1, 0, 0], 1e-12);

    const time = await invoke("orbitTimeOfFlight", {...circle,
      fromTrueAnomaly: 0, toTrueAnomaly: Math.PI, revolutions: 2});
    near(time.seconds, 5 * Math.PI, 1e-12);
    const now = await invoke("orbitTimeOfFlight", {...circle,
      fromTrueAnomaly: 0, toTrueAnomaly: -1e-12});
    assert.equal(now.seconds, 0, "the same burn point cannot move a revolution later");
    const ring = await invoke("sampleOrbitGeometry", {...circle, count: 5});
    vectorNear(ring.positions, [1,0,0, 0,1,0, -1,0,0, 0,-1,0, 1,0,0], 1e-12);

    vectorNear(ring.offsets, [0, Math.PI/2, Math.PI, 3*Math.PI/2, 2*Math.PI], 1e-12);
    const reverse = await invoke("sampleOrbitGeometry", {...circle, count: 5, fromTrueAnomaly: 0.7, sweep: -2*Math.PI});
    vectorNear(reverse.offsets, [0, -Math.PI/2, -Math.PI, -3*Math.PI/2, -2*Math.PI], 1e-12);
    const eccentricRing = await invoke("sampleOrbitGeometry", {...circle,
      elements: {...circle.elements, eccentricity: 0.98}, count: 257, fromTrueAnomaly: 2.8});
    assert.equal(eccentricRing.offsets[0], 0);
    near(eccentricRing.offsets.at(-1), 2*Math.PI, 1e-12);
    assert.ok(eccentricRing.offsets.every((v, i, a) => i === 0 || v > a[i-1]), "eccentric sample times strictly increase across the anomaly wrap");

    // RIC and VNC differ away from apsides. At r=(7e6,0,0), v=(1000,7000,0),
    // RIC radial=(1,0,0), VNC velocity=(1,7,0)/sqrt(50). 1e-12 is a unit-vector
    // roundoff allowance, not an orbital modelling tolerance.
    const frameState = {position: [7000000,0,0], velocity: [1000,7000,0]};
    const frames = await invoke("evaluateOrbitGeometry", {state: frameState});
    vectorNear(frames.departureRicBasis.radial, [1,0,0], 1e-12);
    vectorNear(frames.departureVncBasis.velocity, [Math.SQRT1_2 / 5, 7 * Math.SQRT1_2 / 5, 0], 1e-12);
    const vncBurn = await invoke("evaluateOrbitGeometry", {state: frameState, deltaV: [10,0,0], deltaVFrame: "VNC"});
    vectorNear(vncBurn.state.velocity, [1000 + Math.SQRT2, 7000 + 7 * Math.SQRT2, 0], 1e-8);
    const ricBurn = await invoke("evaluateOrbitGeometry", {state: frameState, deltaV: [10,0,0], deltaVFrame: "RIC"});
    vectorNear(ricBurn.state.velocity, [1010,7000,0], 1e-8);

    // Elliptic anomaly residual from Kepler's equation, independently checked.
    for (const eccentricity of [0, 0.9, 0.98, 0.999999]) {
      const anomaly = await invoke("convertOrbitAnomaly", {eccentricity, anomaly: 0.001, from: "mean"});
      near(anomaly.eccentricAnomaly - eccentricity * Math.sin(anomaly.eccentricAnomaly), 0.001, 2e-14);
    }

    // Refusals must leave a persistent direct instance usable (A/B/A). No
    // zero, NaN, fabricated ellipse or silently omitted sample is accepted.
    for (const params of [
      {...circle, deltaV: [0, 2, 0], deltaVFrame: "ECI"},
      {...circle, deltaV: [0, 0, 0]},
      {...circle, elapsedSeconds: 1, atTrueAnomaly: 0},
      {...circle, state: frameState},
      {state: {position: [0,0,0], velocity: [0,0,0]}},
    ]) {
      const response = await harness.invoke({methodId: "invoke", inputs: [{portId: "request",
        payload: new TextEncoder().encode(JSON.stringify({operation: "evaluateOrbitGeometry", params}))}]});
      assert.notEqual(response.statusCode, 0);
      const body = JSON.parse(new TextDecoder().decode(response.outputs[0].payload));
      assert.match(body.error, /orbit|Orbit|deltaVFrame|exactly one|never both/);
      assert.deepEqual(await invoke("evaluateOrbitGeometry", circle), before);
    }
    await assert.rejects(invoke("sampleOrbitGeometry", {...circle, count: 4097}));
  });
}
