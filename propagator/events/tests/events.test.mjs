// The SHIPPED event-locator artifact, measured on the wire.
//
// The native harness (event_locator_conformance.test.mjs) measures the physics:
// step-independence, forward-backward closure, root convergence, and one
// located epoch per locator against an independent solver. This suite measures
// the WIRE: that the module decodes an $EVL request and an $OEM ephemeris,
// returns the events at epochs a closed form predicts, and refuses — by name —
// every input it cannot honour.
//
// THE TEST TRAJECTORY IS A CURVE, NOT AN ORBIT, AND THAT IS DELIBERATE.
//
//     x = A cos(wt)   y = B sin(wt)   z = C sin(wt)
//
// is a closed ellipse about the origin whose event epochs are exact:
//   * z = 0 (the node crossing) at wt = k*pi;
//   * r . v = w sin(wt) cos(wt) (B^2 + C^2 - A^2), so the apsis epochs are
//     wt = k*pi/2;
//   * the radius is extremal at exactly those same epochs.
// No gravitational parameter appears anywhere in this file. The module's job is
// to find roots of an event function on a trajectory the CALLER supplies, so
// the trajectory's provenance is the caller's business — and stating it as a
// curve means the expected epochs are arithmetic rather than a second orbit
// propagation that would itself need validating.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const wasmPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");

const { EVL, EVLT, EVLEventLocationRequestT, EVLApsidesConfigurationT,
  EVLNodeCrossingConfigurationT, EVLEclipseConfigurationT, EVLContactConfigurationT,
  EVLIntrusionConfigurationT } = await import("spacedatastandards.org/lib/js/EVL/main.js");
const { PCE, PCET, PCEEvaluationContextT, PCEStopRequestT, PCEParameterConditionT,
  PCEParameterRefT } = await import("spacedatastandards.org/lib/js/PCE/main.js");
const { FRMStateVectorT, FRMVector3T } = await import(
  "spacedatastandards.org/lib/js/FRM/main.js"
);
const { RFMOriginT } = await import("spacedatastandards.org/lib/js/RFM/main.js");
const { OEM, OEMT, ephemerisDataBlockT, ephemerisDataLineT } = await import(
  "spacedatastandards.org/lib/js/OEM/main.js"
);
const { EOP, EOPT } = await import("spacedatastandards.org/lib/js/EOP/main.js");

const START = Date.UTC(2026, 7, 29, 0, 0, 0);
const PERIOD_SECONDS = 5400.0;
const OMEGA = (2 * Math.PI) / PERIOD_SECONDS;
// A phase, so the scan does not START on a root. z and r . v both vanish at
// wt = 0, and a scan that begins exactly on a condition correctly reports the
// condition it is standing on — which is right behaviour and the wrong thing to
// measure here.
const PHASE = Math.PI / 8;
const A = 7100000.0;
const B = 6900000.0;
const C = 900000.0;
const ARCSEC = Math.PI / (180 * 3600);

function isoAt(seconds) {
  return new Date(START + seconds * 1000).toISOString().replace("Z", "");
}

/// The curve, and its exact derivative.
function curveAt(seconds) {
  const angle = OMEGA * seconds + PHASE;
  return {
    position: [A * Math.cos(angle), B * Math.sin(angle), C * Math.sin(angle)],
    velocity: [
      -A * OMEGA * Math.sin(angle),
      B * OMEGA * Math.cos(angle),
      C * OMEGA * Math.cos(angle),
    ],
  };
}

function encodeEphemeris({ spacing = 10.0, span = 2 * PERIOD_SECONDS } = {}) {
  const builder = new flatbuffers.Builder(1 << 20);
  const lines = [];
  for (let seconds = 0; seconds <= span; seconds += spacing) {
    const { position, velocity } = curveAt(seconds);
    const line = new ephemerisDataLineT();
    line.EPOCH = isoAt(seconds);
    // $OEM is kilometres; the module converts once, at the wire.
    line.X = position[0] / 1000;
    line.Y = position[1] / 1000;
    line.Z = position[2] / 1000;
    line.X_DOT = velocity[0] / 1000;
    line.Y_DOT = velocity[1] / 1000;
    line.Z_DOT = velocity[2] / 1000;
    lines.push(line);
  }
  const block = new ephemerisDataBlockT();
  block.EPHEMERIS_DATA_LINES = lines;
  const message = new OEMT();
  message.EPHEMERIS_DATA_BLOCK = [block];
  const root = message.pack(builder);
  OEM.finishOEMBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeEarthOrientation() {
  const builder = new flatbuffers.Builder(1024);
  const row = new EOPT();
  row.DATE = "2026-08-29T00:00:00Z";
  row.TAI_MINUS_UTC_SECONDS = 37;
  row.UT1_MINUS_UTC_SECONDS_HP = 0.0177655;
  row.X_POLE_WANDER_RADIANS_HP = 0.182065 * ARCSEC;
  row.Y_POLE_WANDER_RADIANS_HP = 0.407705 * ARCSEC;
  row.DATA_SET_CID = "bafkreie2jfwy5jvc564e2wqqx3t76xoqg26tu3k7eplobeqxbzbqg6elyi";
  const root = row.pack(builder);
  EOP.finishEOPBuffer(builder, root);
  return builder.asUint8Array();
}

function baseContext() {
  const context = new PCEEvaluationContextT();
  context.CENTRAL_BODY_ID = 399;
  context.GRAVITATIONAL_PARAMETER = 3.986004418e14;
  context.EQUATORIAL_RADIUS_M = 6378137.0;
  context.FLATTENING = 1.0 / 298.257223563;
  return context;
}

function encodeLocationRequest(locatorClass, configure, { step = 30.0, span = PERIOD_SECONDS, startOffset = 0 } = {}) {
  const builder = new flatbuffers.Builder(1 << 16);
  const request = new EVLEventLocationRequestT();
  request.LOCATOR_CLASS = locatorClass;
  request.CONTEXT = baseContext();
  request.SCAN_START_EPOCH = isoAt(startOffset);
  request.SCAN_STOP_EPOCH = isoAt(startOffset + span);
  request.EPOCH_TIME_SYSTEM = "UTC";
  request.SCAN_STEP_SECONDS = step;
  request.REFINEMENT_TOLERANCE_SECONDS = 1e-9;
  request.TRACE_ID = "events-wire-test";
  configure(request);
  const envelope = new EVLT();
  envelope.LOCATION_REQUEST = request;
  const root = envelope.pack(builder);
  EVL.finishEVLBuffer(builder, root);
  return builder.asUint8Array();
}

const evlTypeRef = { schemaName: "EVL.fbs", fileIdentifier: "$EVL", rootTypeName: "EVL" };
const oemTypeRef = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
const eopTypeRef = { schemaName: "EOP.fbs", fileIdentifier: "$EOP", rootTypeName: "EOP" };
const pceTypeRef = { schemaName: "PCE.fbs", fileIdentifier: "$PCE", rootTypeName: "PCE" };

/// Seconds from the scan epoch, parsing the FULL fractional second.
///
/// `Date.parse` truncates at milliseconds, and the module reports nanoseconds
/// because a root refined to 1e-9 s has them. Reading the epoch through
/// `Date.parse` alone would put a 1 ms floor under every assertion here and
/// call it the module's error.
function secondsOf(iso) {
  const match = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?$/.exec(iso);
  assert.ok(match, `unparsable epoch ${iso}`);
  const whole = (Date.parse(`${match[1]}Z`) - START) / 1000;
  const fraction = match[2] ? Number(`0.${match[2]}`) : 0;
  return whole + fraction;
}

test("the event locator answers on the wire", { concurrency: false }, async (t) => {
  if (!fs.existsSync(wasmPath)) {
    t.skip(`the artifact is not built at ${wasmPath}; run npm run build`);
    return;
  }
  const bytes = fs.readFileSync(wasmPath);
  const harness = await createBrowserModuleHarness({ wasmSource: bytes, surface: "direct" });
  const ephemeris = encodeEphemeris();
  const earthOrientation = encodeEarthOrientation();

  const locate = async (payload, { withEop = true } = {}) => {
    const inputs = [
      { portId: "request", typeRef: evlTypeRef, payload },
      { portId: "ephemeris", typeRef: oemTypeRef, payload: ephemeris },
    ];
    if (withEop) {
      inputs.push({ portId: "earth_orientation", typeRef: eopTypeRef, payload: earthOrientation });
    }
    const response = await harness.invoke({ methodId: "locate_events", inputs });
    assert.equal(response.statusCode, 0, response.errorMessage ?? "module refused");
    const frame = response.outputs?.find((entry) => entry.portId === "report");
    assert.ok(frame, "no report frame");
    const report = EVL.getRootAsEVL(new flatbuffers.ByteBuffer(frame.payload)).EVENT_REPORT();
    assert.ok(report, "no event report");
    const events = [];
    for (let i = 0; i < report.eventsLength(); i += 1) {
      const event = report.EVENTS(i);
      events.push({
        type: event.EVENT_TYPE(),
        start: event.START_EPOCH(),
        stop: event.STOP_EPOCH(),
        duration: event.DURATION_SECONDS(),
        extremum: event.EXTREMUM_VALUE(),
      });
    }
    return { status: report.STATUS(), message: report.ERROR_MESSAGE(), events };
  };

  await t.test("node crossings land on the curve's own zeros", async () => {
    const payload = encodeLocationRequest(5, () => {}, { span: 2 * PERIOD_SECONDS });
    const { status, events, message } = await locate(payload);
    assert.equal(status, 1, message ?? "");
    // z = C sin(wt + phase) vanishes at wt + phase = k*pi.
    const first = (Math.PI - PHASE) / OMEGA;
    const expected = [0, 1, 2, 3].map((k) => first + (k * PERIOD_SECONDS) / 2);
    assert.equal(events.length, expected.length, "one node crossing every half period");
    events.forEach((event, index) => {
      const measured = secondsOf(event.start);
      assert.ok(
        Math.abs(measured - expected[index]) < 1e-3,
        `node ${index}: ${measured} vs ${expected[index]}`,
      );
    });
    // The ascending node is the one where z is INCREASING. On this curve that
    // is wt = 2k*pi, so the crossings alternate.
    assert.notEqual(events[0].type, events[1].type, "the crossings alternate in kind");
  });

  await t.test("apsides land where r . v vanishes", async () => {
    const payload = encodeLocationRequest(4, () => {}, { span: PERIOD_SECONDS });
    const { status, events, message } = await locate(payload);
    assert.equal(status, 1, message ?? "");
    // r . v = w sin(wt + phase) cos(wt + phase) (B^2 + C^2 - A^2) vanishes at
    // wt + phase = k*pi/2.
    const first = (Math.PI / 2 - PHASE) / OMEGA;
    const expected = [0, 1, 2, 3].map((k) => first + (k * PERIOD_SECONDS) / 4);
    assert.equal(events.length, expected.length, "one apsis every quarter period");
    events.forEach((event, index) => {
      const measured = secondsOf(event.start);
      assert.ok(
        Math.abs(measured - expected[index]) < 1e-3,
        `apsis ${index}: ${measured} vs ${expected[index]}`,
      );
      // The residual the module reports IS r . v at the epoch it reports, and
      // it is the number a consumer gates on rather than an assumed zero.
      const scale = A * A * OMEGA;
      assert.ok(Math.abs(event.extremum) / scale < 1e-9, "the reported residual is a root");
    });
  });

  await t.test("the located epoch does not move with the scan step", async () => {
    const epochs = [];
    for (const step of [15.0, 45.0, 135.0]) {
      const payload = encodeLocationRequest(4, () => {}, { step, span: PERIOD_SECONDS });
      const { events } = await locate(payload);
      epochs.push(secondsOf(events[0].start));
    }
    // THE invariant: the scan step decides only whether a root is bracketed.
    assert.ok(Math.abs(epochs[0] - epochs[1]) < 1e-6, `15 s vs 45 s: ${epochs[0]} ${epochs[1]}`);
    assert.ok(Math.abs(epochs[1] - epochs[2]) < 1e-6, `45 s vs 135 s: ${epochs[1]} ${epochs[2]}`);
    console.log(`  stop epoch across three scan steps: ${epochs.map((e) => e.toFixed(9)).join(", ")}`);
  });

  await t.test("eclipse reports an interval with an entry, an exit and a duration", async () => {
    const payload = encodeLocationRequest(
      1,
      (request) => {
        const configuration = new EVLEclipseConfigurationT();
        configuration.OCCULTING_BODY_IDS = [399];
        configuration.ILLUMINATING_BODY_ID = 10;
        configuration.REPORT_UMBRA = true;
        configuration.REPORT_PENUMBRA = false;
        configuration.REPORT_ANTUMBRA = false;
        request.ECLIPSE_CONFIGURATION = configuration;
      },
      { span: 2 * PERIOD_SECONDS, step: 20.0 },
    );
    const { status, events, message } = await locate(payload);
    assert.equal(status, 1, message ?? "");
    assert.ok(events.length >= 1, "the curve passes behind the Earth once per revolution");
    // An interval whose exit falls outside the scan is reported with an entry
    // and no exit, which is the honest answer; the ones with both are what the
    // duration is asserted on.
    const closed = events.filter((event) => event.stop);
    assert.ok(closed.length >= 1, "at least one interval closes inside the scan");
    for (const event of closed) {
      assert.equal(event.type, 1, "umbra");
      assert.ok(event.duration > 0, "a positive duration");
      assert.ok(
        Math.abs(secondsOf(event.stop) - secondsOf(event.start) - event.duration) < 1e-6,
        "the duration is the difference of the two epochs",
      );
    }
  });

  await t.test("contact needs a ground site and an Earth-orientation row", async () => {
    const build = (configure) =>
      encodeLocationRequest(2, (request) => {
        const configuration = new EVLContactConfigurationT();
        const observer = new RFMOriginT();
        observer.KIND = 5; // GROUND_SITE
        observer.SITE_ID = "wire-test-site";
        observer.SITE_BODY_ID = 399;
        observer.SITE_LATITUDE = 0.05;
        observer.SITE_LONGITUDE = 0.1;
        observer.SITE_ALTITUDE = 120.0;
        configuration.OBSERVER = observer;
        configuration.MINIMUM_ELEVATION_RAD = 5.0 * (Math.PI / 180);
        configure(configuration);
        request.CONTACT_CONFIGURATION = configuration;
        // The scan starts a second INSIDE the ephemeris. With the light-time
        // correction on, the locator evaluates the trajectory one light time
        // before each epoch, so a scan that began exactly at the first sample
        // would ask for a state the ephemeris does not have — and the module
        // refuses that rather than reporting an uncorrected epoch as corrected.
      }, { span: PERIOD_SECONDS, step: 20.0, startOffset: 1.0 });

    const withRow = await locate(build(() => {}));
    assert.equal(withRow.status, 1, withRow.message ?? "");

    // Without the row the site cannot be placed, and the module says so rather
    // than putting it against assumed zeros.
    const withoutRow = await locate(build(() => {}), { withEop: false });
    assert.equal(withoutRow.status, 6, "MISSING_EOP_DATA");
    assert.ok(withoutRow.message.length > 0, "the refusal says what is missing");

    // Light time is a stated option, and turning it on must not change the
    // SHAPE of the answer.
    const lit = await locate(build((configuration) => {
      configuration.ABERRATION_CORRECTION = 2; // LIGHT_TIME
    }));
    assert.equal(lit.status, 1, lit.message ?? "");
    assert.equal(lit.events.length, withRow.events.length, "the same passes are found");
    for (let i = 0; i < lit.events.length; i += 1) {
      const shift = Math.abs(secondsOf(lit.events[i].start) - secondsOf(withRow.events[i].start));
      // The shift is small and non-zero: a signal crossing this range takes
      // about 20 ms, and the epoch moves by that divided by the elevation rate.
      assert.ok(shift > 0, "the correction moves the epoch");
      assert.ok(shift < 10, "and moves it by a physically small amount");
    }
  });

  await t.test("intrusion refuses a field of view it does not implement", async () => {
    const payload = encodeLocationRequest(3, (request) => {
      const configuration = new EVLIntrusionConfigurationT();
      configuration.FIELD_OF_VIEW_SHAPE = 2; // RECTANGULAR
      configuration.CONE_HALF_ANGLE_RAD = 0.2;
      configuration.BORESIGHT = new FRMVector3T(1, 0, 0);
      configuration.INTRUDING_BODY_IDS = [399];
      request.INTRUSION_CONFIGURATION = configuration;
    });
    const { status, message } = await locate(payload);
    assert.equal(status, 3, "UNSUPPORTED_LOCATOR_CLASS");
    assert.ok(message.includes("CONIC"), "the refusal names what it does support");
  });

  await t.test("intrusion finds the central body entering a conic field of view", async () => {
    const payload = encodeLocationRequest(3, (request) => {
      const configuration = new EVLIntrusionConfigurationT();
      configuration.FIELD_OF_VIEW_SHAPE = 1; // CONIC
      configuration.CONE_HALF_ANGLE_RAD = 0.4;
      configuration.BORESIGHT = new FRMVector3T(1, 0, 0);
      configuration.INTRUDING_BODY_IDS = [399];
      request.INTRUSION_CONFIGURATION = configuration;
    }, { span: 2 * PERIOD_SECONDS, step: 20.0 });
    const { status, events, message } = await locate(payload);
    assert.equal(status, 1, message ?? "");
    assert.ok(events.length >= 1, "the central body sweeps through the cone once per revolution");
    const closed = events.filter((event) => event.stop);
    assert.ok(closed.length >= 1, "at least one intrusion closes inside the scan");
    assert.ok(closed[0].duration > 0, "a positive duration");
    // Independent closed form: the central-body direction is -r. It enters
    // the +X cone at phase pi-alpha and exits at pi+alpha, where
    // alpha=atan(A*tan(halfAngle)/hypot(B,C)). Metres/radians, inertial axes,
    // UTC seconds from START. 1 ms admits the 10 s Hermite interpolation error
    // and ISO epoch rendering, and rejects reporting the outside interval.
    const alpha = Math.atan(A * Math.tan(0.4) / Math.hypot(B, C));
    const expectedEntry = (Math.PI - alpha - PHASE) / OMEGA;
    const expectedExit = (Math.PI + alpha - PHASE) / OMEGA;
    const entryError = Math.abs(secondsOf(closed[0].start) - expectedEntry);
    const exitError = Math.abs(secondsOf(closed[0].stop) - expectedExit);
    assert.ok(entryError < 1e-3, `conic entry error ${entryError} s`);
    assert.ok(exitError < 1e-3, `conic exit error ${exitError} s`);
    console.log(`  conic closed-form entry/exit errors: ${entryError}, ${exitError} s`);

  });

  await t.test("a missing ephemeris is refused, not guessed at", async () => {
    // The trajectory port is REQUIRED in the manifest, so the refusal happens
    // before the guest is entered at all — the strongest form of it. Asserting
    // the invocation itself fails, rather than a status inside a report, is
    // what pins that.
    const response = await harness.invoke({
      methodId: "locate_events",
      inputs: [
        { portId: "request", typeRef: evlTypeRef, payload: encodeLocationRequest(4, () => {}) },
      ],
    });
    assert.notEqual(response.statusCode, 0, "an invocation with no trajectory must fail");

    // And an ephemeris that does not COVER the scan is refused by the module
    // itself, by name, rather than extrapolated.
    const short = encodeEphemeris({ span: 600.0 });
    const covered = await harness.invoke({
      methodId: "locate_events",
      inputs: [
        {
          portId: "request",
          typeRef: evlTypeRef,
          payload: encodeLocationRequest(4, () => {}, { span: PERIOD_SECONDS }),
        },
        { portId: "ephemeris", typeRef: oemTypeRef, payload: short },
      ],
    });
    const frame = covered.outputs?.find((entry) => entry.portId === "report");
    assert.ok(frame, "a report frame");
    const report = EVL.getRootAsEVL(new flatbuffers.ByteBuffer(frame.payload)).EVENT_REPORT();
    assert.equal(report.STATUS(), 5, "MISSING_EPHEMERIS");
    assert.ok(
      report.ERROR_MESSAGE().includes("extrapolat"),
      "the refusal says it will not extrapolate",
    );
  });

  await t.test("propagate-to-condition lands on the requested value", async () => {
    const builder = new flatbuffers.Builder(1 << 16);
    const initial = new FRMStateVectorT();
    const { position, velocity } = curveAt(0);
    initial.POSITION = new FRMVector3T(...position);
    initial.VELOCITY = new FRMVector3T(...velocity);
    initial.EPOCH = isoAt(0);
    initial.EPOCH_TIME_SYSTEM = "UTC";
    initial.COORDINATE_SYSTEM_NAME = "ICRF";

    const condition = new PCEParameterConditionT();
    const ref = new PCEParameterRefT();
    ref.PARAMETER = 7; // POSITION_MAGNITUDE
    condition.PARAMETER = ref;
    // A radius the curve certainly attains: between the minor and major axes.
    condition.GOAL_VALUE = 7000000.0;
    condition.OCCURRENCE = 1;

    const request = new PCEStopRequestT();
    request.CONTEXT = baseContext();
    request.INITIAL_STATE = initial;
    request.CONDITIONS = [condition];
    request.DIRECTION = 1; // FORWARD
    request.MAXIMUM_ELAPSED_SECONDS = PERIOD_SECONDS;
    request.EPOCH_TOLERANCE_SECONDS = 1e-9;
    request.TRACE_ID = "stop-wire-test";

    const envelope = new PCET();
    envelope.STOP_REQUEST = request;
    const root = envelope.pack(builder);
    PCE.finishPCEBuffer(builder, root);

    const response = await harness.invoke({
      methodId: "propagate_to_condition",
      inputs: [
        { portId: "request", typeRef: pceTypeRef, payload: builder.asUint8Array() },
        { portId: "ephemeris", typeRef: oemTypeRef, payload: ephemeris },
        { portId: "earth_orientation", typeRef: eopTypeRef, payload: earthOrientation },
      ],
    });
    assert.equal(response.statusCode, 0, response.errorMessage ?? "");
    const frame = response.outputs?.find((entry) => entry.portId === "report");
    const report = PCE.getRootAsPCE(new flatbuffers.ByteBuffer(frame.payload)).STOP_REPORT();
    assert.ok(report, "no stop report");
    assert.equal(report.STATUS(), 1, report.ERROR_MESSAGE() ?? "");
    // The stop LANDS on the condition: the residual is the number gated on.
    assert.ok(
      Math.abs(report.GOAL_RESIDUAL()) < 1e-6,
      `residual ${report.GOAL_RESIDUAL()} m`,
    );
    const state = report.STATE();
    const radius = Math.hypot(state.POSITION().X(), state.POSITION().Y(), state.POSITION().Z());
    assert.ok(Math.abs(radius - 7000000.0) < 1e-6, `the reported state is at the goal radius`);
    console.log(
      `  stop: ${report.EPOCH()} elapsed ${report.ELAPSED_SECONDS().toFixed(9)} s, ` +
      `residual ${report.GOAL_RESIDUAL().toExponential(3)} m`,
    );
  });

  await t.test("a goal that is never attained is reported as such", async () => {
    const builder = new flatbuffers.Builder(1 << 16);
    const initial = new FRMStateVectorT();
    const { position, velocity } = curveAt(0);
    initial.POSITION = new FRMVector3T(...position);
    initial.VELOCITY = new FRMVector3T(...velocity);
    initial.EPOCH = isoAt(0);
    initial.EPOCH_TIME_SYSTEM = "UTC";

    const condition = new PCEParameterConditionT();
    const ref = new PCEParameterRefT();
    ref.PARAMETER = 7;
    condition.PARAMETER = ref;
    condition.GOAL_VALUE = 5.0e8;

    const request = new PCEStopRequestT();
    request.CONTEXT = baseContext();
    request.INITIAL_STATE = initial;
    request.CONDITIONS = [condition];
    request.MAXIMUM_ELAPSED_SECONDS = PERIOD_SECONDS;

    const envelope = new PCET();
    envelope.STOP_REQUEST = request;
    const root = envelope.pack(builder);
    PCE.finishPCEBuffer(builder, root);

    const response = await harness.invoke({
      methodId: "propagate_to_condition",
      inputs: [
        { portId: "request", typeRef: pceTypeRef, payload: builder.asUint8Array() },
        { portId: "ephemeris", typeRef: oemTypeRef, payload: ephemeris },
      ],
    });
    const frame = response.outputs?.find((entry) => entry.portId === "report");
    const report = PCE.getRootAsPCE(new flatbuffers.ByteBuffer(frame.payload)).STOP_REPORT();
    assert.equal(report.STATUS(), 10, "GOAL_NOT_ATTAINED");
  });
});
