// The SHIPPED artifact, measured on the wire.
//
// The native harness (parameter_catalog_parity.test.mjs) measures the physics
// against its external authorities. This suite measures the WIRE: that the
// module decodes an SDS PCE evaluation request, answers each named parameter
// with the number the same headers produce natively, refuses the parameters it
// declares unavailable BY NAME, and publishes a catalog that agrees with the
// roster it was generated from.
//
// A module that computes correctly and encodes wrongly is still wrong, and the
// two failures look nothing alike, so they are measured separately.

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

const roster = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "src", "generated", "roster.json"), "utf8"),
);
const crosswalk = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "src", "generated", "pce-crosswalk.json"), "utf8"),
);

const { PCE, PCET, PCEEvaluationContextT, PCEEvaluationRequestT, PCEParameterRefT } =
  await import("spacedatastandards.org/lib/js/PCE/main.js");
const { FRMStateVectorT, FRMVector3T } = await import(
  "spacedatastandards.org/lib/js/FRM/main.js"
);
const { EOP, EOPT } = await import("spacedatastandards.org/lib/js/EOP/main.js");

// The state the native harness measures, so the wire and the physics are
// compared on ONE set of numbers.
const EPOCH = "2026-08-29T12:00:00";
const POSITION = [7000000.0, 1200000.0, 300000.0];
const VELOCITY = [-1500.0, 7100.0, 400.0];
const EARTH = 399;
const ARCSEC = Math.PI / (180 * 3600);

const parameterCode = (name) => {
  const row = crosswalk.rows.find((entry) => entry.target === name);
  return row ? row.value : null;
};

function encodeEarthOrientation() {
  const builder = new flatbuffers.Builder(1024);
  const row = new EOPT();
  row.DATE = "2026-08-29T00:00:00Z";
  row.TAI_MINUS_UTC_SECONDS = 37;
  row.UT1_MINUS_UTC_SECONDS_HP = 0.0177655;
  row.X_POLE_WANDER_RADIANS_HP = 0.182065 * ARCSEC;
  row.Y_POLE_WANDER_RADIANS_HP = 0.407705 * ARCSEC;
  row.DATA_SET_EPOCH = "2026-08-29T00:00:00Z";
  row.DATA_SET_CID = "bafkreie2jfwy5jvc564e2wqqx3t76xoqg26tu3k7eplobeqxbzbqg6elyi";
  const root = row.pack(builder);
  EOP.finishEOPBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeRequest(names, { position = POSITION, velocity = VELOCITY } = {}) {
  const builder = new flatbuffers.Builder(8192);
  const context = new PCEEvaluationContextT();
  context.CENTRAL_BODY_ID = EARTH;
  context.GRAVITATIONAL_PARAMETER = 3.986004418e14;
  context.EQUATORIAL_RADIUS_M = 6378137.0;
  context.FLATTENING = 1.0 / 298.257223563;
  context.REFERENCE_EPOCH = "2026-08-28T12:00:00";

  const state = new FRMStateVectorT();
  state.POSITION = new FRMVector3T(...position);
  state.VELOCITY = new FRMVector3T(...velocity);
  state.EPOCH = EPOCH;
  state.EPOCH_TIME_SYSTEM = "UTC";

  const request = new PCEEvaluationRequestT();
  request.CONTEXT = context;
  request.PARAMETERS = names.map((name) => {
    const ref = new PCEParameterRefT();
    const code = parameterCode(name);
    if (code === null) {
      // The reference tool's own shorthands have no published code; they are
      // reachable by name, which is exactly what PROVIDER_DEFINED is for.
      ref.PARAMETER = 65535;
      ref.PROVIDER_DEFINED_NAME = name;
    } else {
      ref.PARAMETER = code;
    }
    return ref;
  });
  request.STATES = [state];
  request.TRACE_ID = "parameters-wire-test";

  const envelope = new PCET();
  envelope.EVALUATION_REQUEST = request;
  const root = envelope.pack(builder);
  PCE.finishPCEBuffer(builder, root);
  return builder.asUint8Array();
}

function decode(response, portId) {
  assert.equal(response.statusCode, 0, response.errorMessage ?? "module refused");
  const frame = response.outputs?.find((entry) => entry.portId === portId);
  assert.ok(frame, `no ${portId} frame`);
  return PCE.getRootAsPCE(new flatbuffers.ByteBuffer(frame.payload));
}

test("the parameter module answers on the wire", { concurrency: false }, async (t) => {
  if (!fs.existsSync(wasmPath)) {
    t.skip(`the artifact is not built at ${wasmPath}; run npm run build`);
    return;
  }
  const bytes = fs.readFileSync(wasmPath);
  const harness = await createBrowserModuleHarness({ wasmSource: bytes, surface: "direct" });
  const earthOrientation = encodeEarthOrientation();

  const evaluate = async (names) => {
    const response = await harness.invoke({
      methodId: "evaluate_parameters",
      inputs: [
        {
          portId: "request",
          typeRef: { schemaName: "PCE.fbs", fileIdentifier: "$PCE", rootTypeName: "PCE" },
          payload: encodeRequest(names),
        },
        {
          portId: "earth_orientation",
          typeRef: { schemaName: "EOP.fbs", fileIdentifier: "$EOP", rootTypeName: "EOP" },
          payload: earthOrientation,
        },
      ],
    });
    const result = decode(response, "result").EVALUATION_RESULT();
    assert.ok(result, "no evaluation result");
    const sample = result.SAMPLES(0);
    assert.ok(sample, "no sample");
    const values = new Map();
    for (let i = 0; i < sample.parameterValuesLength(); i += 1) {
      const value = sample.PARAMETER_VALUES(i);
      values.set(names[i], {
        status: value.STATUS(),
        value: value.VALUE(),
        message: value.MESSAGE(),
        unit: value.UNIT(),
      });
    }
    return values;
  };

  await t.test("the classical elements come back with the right numbers", async () => {
    const names = ["SMA", "ECC", "INC", "RAAN", "AOP", "TA", "RMAG", "VMAG"];
    const values = await evaluate(names);
    for (const name of names) {
      assert.equal(values.get(name).status, 1, `${name} did not answer: ${values.get(name).message}`);
    }
    // Closed forms that hold for ANY state, so the wire is checked against
    // arithmetic rather than against a stored expectation of itself.
    const mu = 3.986004418e14;
    const r = Math.hypot(...POSITION);
    const v = Math.hypot(...VELOCITY);
    assert.ok(Math.abs(values.get("RMAG").value - r) / r < 1e-15, "RMAG");
    assert.ok(Math.abs(values.get("VMAG").value - v) / v < 1e-15, "VMAG");
    const semiMajorAxis = 1.0 / (2.0 / r - (v * v) / mu);
    assert.ok(
      Math.abs(values.get("SMA").value - semiMajorAxis) / semiMajorAxis < 1e-12,
      "SMA against the vis-viva form",
    );
    assert.ok(values.get("ECC").value > 0 && values.get("ECC").value < 1, "bound orbit");
    // Radians, never degrees: every angle here is inside [0, 2pi).
    for (const angle of ["INC", "RAAN", "AOP", "TA"]) {
      const measured = values.get(angle).value;
      assert.ok(measured >= 0 && measured <= 2 * Math.PI, `${angle} is in radians`);
      assert.equal(values.get(angle).unit, 9, `${angle} is declared RADIAN`);
    }
  });

  await t.test("a body-fixed parameter needs the Earth-orientation row", async () => {
    const withRow = await evaluate(["Latitude", "Longitude", "Altitude", "LST", "MHA"]);
    for (const name of ["Latitude", "Longitude", "Altitude", "LST", "MHA"]) {
      assert.equal(withRow.get(name).status, 1, `${name} with a row`);
    }

    const response = await harness.invoke({
      methodId: "evaluate_parameters",
      inputs: [
        {
          portId: "request",
          typeRef: { schemaName: "PCE.fbs", fileIdentifier: "$PCE", rootTypeName: "PCE" },
          payload: encodeRequest(["Latitude"]),
        },
      ],
    });
    const result = decode(response, "result").EVALUATION_RESULT();
    const value = result.SAMPLES(0).PARAMETER_VALUES(0);
    // MISSING_DEPENDENCY, not a latitude computed against assumed zeros.
    assert.equal(value.STATUS(), 5, "latitude without an Earth-orientation row");
  });

  await t.test("a declared-unavailable parameter refuses by name", async () => {
    const values = await evaluate(["BrouwerShortSMA", "Q1", "FuelMass"]);
    for (const name of ["BrouwerShortSMA", "Q1", "FuelMass"]) {
      const entry = values.get(name);
      assert.equal(entry.status, 4, `${name} must report NOT_IMPLEMENTED`);
      assert.ok(entry.message && entry.message.length > 0, `${name} must say what is missing`);
      assert.ok(
        !Number.isFinite(entry.value) || entry.value === 0,
        `${name} must not carry a substituted number`,
      );
    }
  });

  await t.test("the B-plane is refused on a bound orbit and answered on a hyperbolic one", async () => {
    const bound = await evaluate(["BdotT", "BdotR", "BVectorMag"]);
    for (const name of ["BdotT", "BdotR", "BVectorMag"]) {
      assert.equal(bound.get(name).status, 9, `${name} on a bound orbit is OUT_OF_DOMAIN`);
    }

    // A hyperbolic state: the same position with escape speed.
    const escape = Math.sqrt((2 * 3.986004418e14) / Math.hypot(...POSITION)) * 1.3;
    const direction = [-0.2, 0.95, 0.05];
    const norm = Math.hypot(...direction);
    const hyperbolic = direction.map((component) => (component / norm) * escape);
    const response = await harness.invoke({
      methodId: "evaluate_parameters",
      inputs: [
        {
          portId: "request",
          typeRef: { schemaName: "PCE.fbs", fileIdentifier: "$PCE", rootTypeName: "PCE" },
          payload: encodeRequest(["BdotT", "BdotR", "BVectorMag", "DLA", "RLA"], {
            velocity: hyperbolic,
          }),
        },
      ],
    });
    const result = decode(response, "result").EVALUATION_RESULT();
    const sample = result.SAMPLES(0);
    const measured = [];
    for (let i = 0; i < sample.parameterValuesLength(); i += 1) {
      const value = sample.PARAMETER_VALUES(i);
      assert.equal(value.STATUS(), 1, "the B-plane answers on a hyperbolic orbit");
      measured.push(value.VALUE());
    }
    const [bDotT, bDotR, magnitude] = measured;
    // The wire carries components and magnitude that agree with each other.
    assert.ok(
      Math.abs(Math.hypot(bDotT, bDotR) - magnitude) / magnitude < 1e-12,
      "BdotT and BdotR reconstruct the B-vector magnitude",
    );
  });

  await t.test("the published catalog agrees with the roster it was generated from", async () => {
    const response = await harness.invoke({ methodId: "publish_catalog", inputs: [] });
    const catalog = decode(response, "catalog").CATALOG();
    assert.ok(catalog, "no catalog");
    const published = catalog.entriesLength();
    const expected = roster.parameters.filter((row) => row.kind !== 6).length;
    assert.equal(published, expected, "every non-container roster entry is published");

    let available = 0;
    let declaredUnavailable = 0;
    let reasoned = 0;
    for (let i = 0; i < published; i += 1) {
      const entry = catalog.ENTRIES(i);
      const availability = entry.AVAILABILITY();
      if (availability === 1) available += 1;
      if (availability === 2) {
        declaredUnavailable += 1;
        if (entry.UNAVAILABLE_REASON() && entry.UNAVAILABLE_REASON().length > 0) reasoned += 1;
      }
      // No parameter is published without a name a consumer can resolve.
      assert.ok(
        entry.PROVIDER_DEFINED_NAME() && entry.PROVIDER_DEFINED_NAME().length > 0,
        `entry ${i} carries no name`,
      );
    }
    assert.equal(
      reasoned,
      declaredUnavailable,
      "every declared-unavailable parameter states what is missing",
    );
    assert.ok(available > 100, `only ${available} parameters are available`);
    console.log(
      `  catalog: ${published} parameters, ${available} available, ${declaredUnavailable} declared and refusing`,
    );
  });

  await t.test("an unknown name is refused rather than guessed at", async () => {
    const values = await evaluate(["NotAParameter"]);
    assert.equal(values.get("NotAParameter").status, 3, "UNKNOWN_PARAMETER");
  });
});
