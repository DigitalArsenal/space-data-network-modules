/**
 * THE TEST CLIENT FOR THE $MPL WIRE.
 *
 * Since 0.7.0 the module's only surface is `plan`: one $MPL (maneuver plan)
 * request in, the same $MPL answered out, in the standard's units (km, km/s,
 * deg, km^3/s^2). The suites below were written against the 0.6.x command
 * surface, `{operation, params}` in SI units, and their expectations (the
 * vectors' frozen references, the transcripts, the invariants) are SI. This
 * client is the translation, and nothing else:
 *
 *   encodeRequest(operation, params)  -> an MPLT request, plus `effective`:
 *       the SI parameters the module actually computes on, i.e. every value
 *       after its trip through the standard's unit (km * 1000 is not always the
 *       metre value it came from). Running the legacy artifact on `effective`
 *       is what makes an exact old-versus-new comparison possible.
 *   decodeAnswer(operation, plan)     -> the 0.6.x answer object, rebuilt in SI
 *       from the plan, for the suites' existing assertions.
 *
 * The $MPL bindings are the standard's own TypeScript, bundled here with
 * esbuild (the dev standards ship no JS for MPL yet).
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const standardsRoot =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? path.join(packageRoot, "node_modules", "spacedatastandards.org");
const mplDir = path.join(standardsRoot, "lib", "ts", "MPL");

async function loadBindings() {
  const esbuild = require("esbuild");
  const files = fs.readdirSync(mplDir).filter((f) => /^(mpl|MPL|ephemerisDataLine)[A-Za-z]*\.ts$/.test(f) && f !== "main.ts");
  const contents = files.map((f) => `export * from ${JSON.stringify(path.join(mplDir, f))};`).join("\n") +
    `\nexport * as flatbuffers from "flatbuffers";\n`;
  const out = await esbuild.build({
    stdin: { contents, resolveDir: mplDir, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
    // The standard's TypeScript imports "flatbuffers" by bare name from a
    // directory with no node_modules: resolve it to this package's copy.
    plugins: [{
      name: "flatbuffers",
      setup(build) {
        build.onResolve({ filter: /^flatbuffers$/ }, () => ({ path: require.resolve("flatbuffers") }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}

export const M = await loadBindings();
const { flatbuffers } = M;

export const MPL_TYPE = Object.freeze({ schemaName: "MPL.fbs", fileIdentifier: "$MPL", rootTypeName: "MPL", wireFormat: "flatbuffer" });
export const MU_EARTH = 398600441800000.0;
const KM = 1000;
const KM3 = 1e9;
const KM2 = 1e6;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// Encoding (SI request -> MPLT), recording the effective SI values
// ---------------------------------------------------------------------------

const isNum = (v) => typeof v === "number";

/** km from metres, writing the round-tripped metre value back into `obj`. */
function km(obj, key) {
  if (!isNum(obj?.[key])) return 0;
  const v = obj[key] / KM;
  obj[key] = v * KM;
  return v;
}
function deg(obj, key) {
  if (!isNum(obj?.[key])) return 0;
  const v = obj[key] * RAD_TO_DEG;
  obj[key] = v * DEG_TO_RAD;
  return v;
}
function vecKm(obj, key) {
  const a = obj?.[key];
  if (!Array.isArray(a)) return [];
  const v = a.map((x) => (isNum(x) ? x / KM : NaN));
  obj[key] = v.map((x) => x * KM);
  return v;
}
function plain(obj, key, fallback = 0) {
  return isNum(obj?.[key]) ? obj[key] : fallback;
}
function mu(obj, key = "mu") {
  if (!isNum(obj?.[key])) return 0;
  if (obj[key] === MU_EARTH) return 0; // the planner's own default, exactly
  const v = obj[key] / KM3;
  obj[key] = v * KM3;
  return v;
}
function line(position, velocity) {
  const l = new M.ephemerisDataLineT();
  if (position.length) [l.X, l.Y, l.Z] = position;
  if (velocity.length) [l.X_DOT, l.Y_DOT, l.Z_DOT] = velocity;
  return l;
}
function stateLine(state) {
  return line(vecKm(state, "position"), vecKm(state, "velocity"));
}
function chiefElements(c) {
  const e = new M.mplElementsT();
  e.SEMI_MAJOR_AXIS_KM = km(c, "semiMajorAxis");
  e.ECCENTRICITY = plain(c, "eccentricity");
  e.INCLINATION_DEG = deg(c, "inclination");
  e.RAAN_DEG = deg(c, "raan");
  e.ARG_OF_PERIAPSIS_DEG = deg(c, "argumentOfPerigee");
  if (isNum(c.meanAnomaly)) e.MEAN_ANOMALY_DEG = deg(c, "meanAnomaly");
  e.MU_KM3_S2 = mu(c);
  if (isNum(c.angularMomentum)) {
    e.ANGULAR_MOMENTUM_KM2_S = c.angularMomentum / KM2;
    c.angularMomentum = e.ANGULAR_MOMENTUM_KM2_S * KM2;
  }
  return e;
}
function geometryOrbit(p) {
  const o = new M.mplOrbitT();
  if (p.state) o.STATE = stateLine(p.state);
  if (p.elements) {
    const s = p.elements;
    const e = new M.mplElementsT();
    e.SEMI_MAJOR_AXIS_KM = km(s, "semiMajorAxis");
    e.ECCENTRICITY = plain(s, "eccentricity");
    e.INCLINATION_DEG = deg(s, "inclination");
    e.RAAN_DEG = deg(s, "raan");
    e.ARG_OF_PERIAPSIS_DEG = deg(s, "argumentOfPeriapsis");
    if (isNum(s.trueAnomaly)) e.TRUE_ANOMALY_DEG = deg(s, "trueAnomaly");
    if (isNum(s.meanAnomaly)) e.MEAN_ANOMALY_DEG = deg(s, "meanAnomaly");
    o.ELEMENTS = e;
  }
  return o;
}
const AXES = { RIC: M.mplAxes.RIC, ECI: M.mplAxes.Inertial, VNC: M.mplAxes.VNC };
const DYNAMICS = {
  keplerian: M.mplRelativeDynamics.Keplerian,
  j2: M.mplRelativeDynamics.J2,
  "j2-drag-eccentric": M.mplRelativeDynamics.J2DragEccentric,
  "j2-drag-arbitrary": M.mplRelativeDynamics.J2DragArbitrary,
};
function drag(d) {
  const x = new M.mplDifferentialDragT();
  x.MODEL = d?.type === "arbitrary" ? M.mplRelativeDynamics.J2DragArbitrary : M.mplRelativeDynamics.J2DragEccentric;
  x.DA_DOT_PER_S = plain(d, "daDotDrag");
  x.DEX_DOT_PER_S = plain(d, "dexDotDrag");
  x.DEY_DOT_PER_S = plain(d, "deyDotDrag");
  return x;
}

export const PROBLEMS = {
  hohmannTransfer: "Hohmann",
  biEllipticTransfer: "BiElliptic",
  planeChange: "PlaneChange",
  combinedManeuver: "CombinedTransfer",
  solveLambert: "Lambert",
  solveLambertMinDV: "LambertMinimumDeltaV",
  phasingManeuver: "Phasing",
  phasingFromTargetState: "PhasingToTarget",
  computeRoeStateTransition: "RelativeStateTransition",
  planRelativeWaypointMission: "RelativeWaypoints",
  computeCAM: "CollisionAvoidance",
  computeApproach: "ApproachCorridor",
  simulateRendezvous: "RendezvousSimulation",
  evaluateOrbitGeometry: "OrbitGeometry",
  convertOrbitAnomaly: "AnomalyConversion",
  orbitTimeOfFlight: "TimeOfFlight",
  sampleOrbitGeometry: "OrbitSampling",
  transformDeltaV: "DeltaVTransform",
};

/**
 * One SI command -> { plan: MPLT, effective: SI params as computed on }.
 * Throws for an operation $MPL has no problem for (only `version`, which the
 * plan answers on every request as PLANNER).
 */
export function encodeRequest(operation, params = {}) {
  const p = structuredClone(params ?? {});
  const plan = new M.MPLT();
  const problem = PROBLEMS[operation];
  if (!problem) throw new Error(`no $MPL problem for operation ${operation}`);
  plan.PROBLEM = M.mplProblem[problem];
  const q = new M.mplRequestT();
  plan.REQUEST = q;
  q.MU_KM3_S2 = mu(p);

  switch (operation) {
    case "hohmannTransfer":
    case "biEllipticTransfer":
    case "combinedManeuver":
    case "planeChange": {
      const t = new M.mplTransferRequestT();
      if (operation === "planeChange") {
        t.INITIAL_RADIUS_KM = km(p, "orbitalRadius");
        t.SPEED_KM_S = km(p, "velocity");
        t.INCLINATION_CHANGE_DEG = deg(p, "deltaInclination");
      } else {
        t.INITIAL_RADIUS_KM = km(p, "r1");
        t.FINAL_RADIUS_KM = km(p, "r2");
        t.INTERMEDIATE_RADIUS_KM = km(p, "rIntermediate");
        t.INCLINATION_CHANGE_DEG = deg(p, "deltaInclination");
      }
      q.TRANSFER = t;
      break;
    }
    case "solveLambert":
    case "solveLambertMinDV": {
      const l = new M.mplLambertRequestT();
      const v = isNum(p.departureVelocity?.[0]) || Array.isArray(p.departureVelocity);
      l.DEPARTURE = line(vecKm(p, "r1"), vecKm(p, "departureVelocity"));
      l.ARRIVAL = line(vecKm(p, "r2"), vecKm(p, "arrivalVelocity"));
      l.ENDPOINT_VELOCITIES = v || Array.isArray(p.arrivalVelocity);
      l.TIME_OF_FLIGHT_S = plain(p, "tof");
      l.PROGRADE = p.prograde ?? true;
      l.REVOLUTIONS = operation === "solveLambert" ? plain(p, "nRevs", 0) : plain(p, "maxRevs", 5);
      if (operation === "solveLambertMinDV" && !isNum(p.maxRevs)) p.maxRevs = 5;
      l.BRANCH = p.branch === "low" ? M.mplLambertBranch.Low : p.branch === "high" ? M.mplLambertBranch.High : M.mplLambertBranch.Unspecified;
      q.LAMBERT = l;
      break;
    }
    case "phasingManeuver": {
      const ph = new M.mplPhasingRequestT();
      ph.ORBIT_RADIUS_KM = km(p, "currentRadius");
      ph.PHASE_ANGLE_DEG = deg(p, "phaseAngle");
      ph.REVOLUTIONS = plain(p, "numRevs", 0);
      ph.HAS_REVOLUTIONS = isNum(p.numRevs);
      q.PHASING = ph;
      break;
    }
    case "phasingFromTargetState": {
      const ph = new M.mplPhasingRequestT();
      for (const [name, key, field] of [["chaser", "chaserState", "CHASER"], ["target", "targetState", "TARGET"]]) {
        if (!p[name] && !p[key]) continue;
        const o = new M.mplOrbitT();
        if (p[name]) o.ELEMENTS = chiefElements(p[name]);
        if (p[key]) o.STATE = stateLine(p[key]);
        ph[field] = o;
      }
      ph.DIRECTION = p.direction === "catchUp" ? M.mplPhasingDirection.CatchUp
        : p.direction === "fallBehind" ? M.mplPhasingDirection.FallBehind : M.mplPhasingDirection.Shortest;
      ph.REVOLUTIONS = plain(p, "numRevs", 0);
      ph.HAS_REVOLUTIONS = isNum(p.numRevs);
      ph.MAX_REVOLUTIONS = plain(p, "maxRevs", 0);
      ph.DELTA_V_BUDGET_KM_S = km(p, "deltaVBudget");
      ph.DELTA_V_BUDGET_FRACTION = plain(p, "deltaVBudgetFraction");
      ph.HAS_COPLANAR_TOLERANCE = isNum(p.coplanarTolerance);
      ph.COPLANAR_TOLERANCE_DEG = deg(p, "coplanarTolerance");
      ph.HAS_ECCENTRICITY_TOLERANCE = isNum(p.eccentricityTolerance);
      ph.ECCENTRICITY_TOLERANCE = plain(p, "eccentricityTolerance");
      if (isNum(p.coOrbitalTolerance)) {
        ph.HAS_CO_ORBITAL_TOLERANCE = true;
        ph.CO_ORBITAL_TOLERANCE_BASIS = M.mplToleranceBasis.RelativeToChaserSemiMajorAxis;
        ph.CO_ORBITAL_TOLERANCE = plain(p, "coOrbitalTolerance");
      }
      q.PHASING = ph;
      break;
    }
    case "computeRoeStateTransition":
    case "planRelativeWaypointMission":
    case "computeCAM":
    case "computeApproach": {
      const r = new M.mplRelativeRequestT();
      if (p.chief) r.REFERENCE = chiefElements(p.chief);
      if (p.initialState) r.RELATIVE_STATE = stateLine(p.initialState);
      if (operation === "computeRoeStateTransition") {
        r.DURATION_S = plain(p, "deltaTime");
        r.STM_DYNAMICS = DYNAMICS[p.model ?? "j2"] ?? M.mplRelativeDynamics.Unspecified;
        r.DYNAMICS = p.includeJ2 === false ? M.mplRelativeDynamics.Keplerian : M.mplRelativeDynamics.J2;
        if (Array.isArray(p.initialRoe)) r.INITIAL_ROE = p.initialRoe.slice();
        if (p.includeDrag) r.DRAG = drag(p.dragConfig ?? {});
      } else if (operation === "planRelativeWaypointMission") {
        const o = p.options ?? {};
        r.DYNAMICS = o.includeJ2 === false ? M.mplRelativeDynamics.Keplerian : M.mplRelativeDynamics.J2;
        if (o.includeDrag) r.DRAG = drag(o.dragConfig ?? {});
        r.MAX_ITERATIONS = plain(o, "maxIterations");
        r.POSITION_TOLERANCE_KM = km(o, "positionTolerance");
        r.VELOCITY_TOLERANCE_KM_S = km(o, "velocityTolerance");
        r.LEG_TIME_LOWER_ORBITS = plain(o, "tofMinOrbits");
        r.LEG_TIME_UPPER_ORBITS = plain(o, "tofMaxOrbits");
        r.TARGET_VELOCITY_KM_S = vecKm(o, "targetVelocity");
        r.SAMPLES_PER_LEG = plain(o, "pointsPerLeg");
        r.WAYPOINTS = (p.waypoints ?? []).map((w) => {
          const x = new M.mplWaypointT();
          x.POSITION_KM = vecKm(w, "position");
          x.VELOCITY_KM_S = vecKm(w, "velocity");
          x.TIME_OF_FLIGHT_S = plain(w, "tof");
          return x;
        });
      } else if (operation === "computeCAM") {
        const c = p.config ?? {};
        r.MISS_DISTANCE_KM = km(c, "minMissDistance");
        r.TIME_TO_CLOSEST_APPROACH_S = plain(c, "timeToTCA");
        r.HAS_MAX_DELTA_V = isNum(c.maxDeltaV);
        r.MAX_DELTA_V_KM_S = km(c, "maxDeltaV");
        r.PREFER_RADIAL = Boolean(c.preferRadial);
      } else {
        const c = p.config ?? {};
        r.APPROACH_AXIS = plain(c, "axis");
        r.APPROACH_TARGET_KM = vecKm(c, "targetPosition");
        r.APPROACH_SPEED_KM_S = km(c, "approachSpeed");
        r.CORRIDOR_HALF_WIDTH_KM = km(c, "safetyCorridorWidth");
      }
      q.RELATIVE = r;
      break;
    }
    case "simulateRendezvous": {
      const r = new M.mplRendezvousRequestT();
      if (p.chief) r.REFERENCE = chiefElements(p.chief);
      r.INITIAL_POSITION_KM = vecKm(p, "initialPosition");
      if (p.solveInitialVelocity !== true) r.INITIAL_VELOCITY_KM_S = vecKm(p, "initialVelocity");
      r.BRAKE_POINT_KM = vecKm(p, "brakePoint");
      r.HOLD_POINT_KM = vecKm(p, "holdPoint");
      r.DRIFT_DURATION_S = plain(p, "driftDuration");
      r.BRAKE_DURATION_S = plain(p, "brakeDuration");
      r.HOLD_DURATION_S = plain(p, "holdDuration");
      const c = p.control ?? {};
      r.BANDWIDTH_RAD_S = plain(c, "bandwidth");
      r.HAS_DAMPING_RATIO = isNum(c.dampingRatio);
      r.DAMPING_RATIO = plain(c, "dampingRatio");
      r.HAS_KP = isNum(c.kp);
      r.KP_PER_S2 = plain(c, "kp");
      r.HAS_KD = isNum(c.kd);
      r.KD_PER_S = plain(c, "kd");
      r.FEEDFORWARD = c.useFeedforward ?? true;
      r.COMPENSATE_CORIOLIS = c.compensateCoriolis ?? true;
      r.COMPENSATE_GRAVITY_GRADIENT = c.compensateGravityGradient ?? true;
      r.MAX_ACCELERATION_KM_S2 = km(c, "maxAccel");
      const i = p.integration ?? {};
      r.TIME_STEP_S = plain(i, "timeStep");
      r.OUTPUT_EVERY = plain(i, "outputEvery");
      r.INCLUDE_J2 = Boolean(i.includeJ2);
      q.RENDEZVOUS = r;
      break;
    }
    default: {
      const g = new M.mplGeometryRequestT();
      if (operation === "convertOrbitAnomaly") {
        g.ECCENTRICITY = plain(p, "eccentricity");
        g.ANOMALY_DEG = deg(p, "anomaly");
        g.ANOMALY_KIND = { true: M.mplAnomalyKind.TrueAnomaly, mean: M.mplAnomalyKind.MeanAnomaly, eccentric: M.mplAnomalyKind.EccentricAnomaly }[p.from] ?? M.mplAnomalyKind.Unspecified;
      } else if (operation === "transformDeltaV") {
        const o = new M.mplOrbitT();
        o.STATE = line(vecKm(p, "position"), vecKm(p, "velocity"));
        g.ORBIT = o;
        const b = new M.mplBurnT();
        b.DELTA_V = vecKm(p, "deltaV");
        b.AXES = AXES[p.from ?? "RIC"] ?? M.mplAxes.Unspecified;
        g.BURN = b;
      } else {
        g.ORBIT = geometryOrbit(p);
        if (operation === "evaluateOrbitGeometry") {
          if (isNum(p.atTrueAnomaly)) g.AT_TRUE_ANOMALY_DEG = deg(p, "atTrueAnomaly");
          g.HAS_ELAPSED = isNum(p.elapsedSeconds);
          g.ELAPSED_S = plain(p, "elapsedSeconds");
          if (p.deltaV) {
            const b = new M.mplBurnT();
            b.DELTA_V = vecKm(p, "deltaV");
            b.AXES = AXES[p.deltaVFrame] ?? M.mplAxes.Unspecified;
            g.BURN = b;
          }
        } else if (operation === "orbitTimeOfFlight") {
          g.FROM_TRUE_ANOMALY_DEG = deg(p, "fromTrueAnomaly");
          g.TO_TRUE_ANOMALY_DEG = deg(p, "toTrueAnomaly");
          g.REVOLUTIONS = plain(p, "revolutions");
        } else {
          g.SAMPLE_COUNT = plain(p, "count");
          g.FROM_TRUE_ANOMALY_DEG = deg(p, "fromTrueAnomaly");
          g.HAS_SWEEP = isNum(p.sweep);
          g.SWEEP_DEG = deg(p, "sweep");
        }
      }
      q.GEOMETRY = g;
    }
  }
  return { plan, effective: p };
}

export function packPlan(plan) {
  const builder = new flatbuffers.Builder(1024);
  M.MPL.finishMPLBuffer(builder, plan.pack(builder));
  return builder.asUint8Array();
}

export function unpackPlan(bytes) {
  return M.MPL.getRootAsMPL(new flatbuffers.ByteBuffer(bytes)).unpack();
}

// ---------------------------------------------------------------------------
// Decoding (MPLT answer -> the 0.6.x SI answer object)
// ---------------------------------------------------------------------------

const m3 = (v) => (v ?? []).map((x) => x * KM);
const r3 = (v) => (v ?? []).map((x) => x);
const rad = (v) => v * DEG_TO_RAD;
/** A burn's signed scalar: the in-axis component's sign when the burn lies on one axis. */
function signed(burn) {
  const nonzero = (burn.DELTA_V ?? []).filter((x) => x !== 0);
  const magnitude = burn.MAGNITUDE_KM_S * KM;
  return nonzero.length === 1 && nonzero[0] < 0 ? -magnitude : magnitude;
}
const pos = (l) => [l.X * KM, l.Y * KM, l.Z * KM];
const vel = (l) => [l.X_DOT * KM, l.Y_DOT * KM, l.Z_DOT * KM];
const BRANCH = { 1: "low", 2: "high" };
const CONIC = { 1: "elliptic", 2: "parabolic", 3: "hyperbolic" };
const DIRECTION = { 0: "short", 1: "catchUp", 2: "fallBehind" };
const PHASE = { 1: "drift", 2: "brake", 3: "hold" };
const MODEL = { 1: "keplerian", 2: "j2", 3: "j2-drag-eccentric", 4: "j2-drag-arbitrary" };
function chunk(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function phasingPlan(plan) {
  const [b1, b2] = plan.BURNS;
  const a = plan.ARCS[0];
  const p = plan.PHASING;
  return {
    dv1: signed(b1),
    dv2: signed(b2),
    totalDeltaV: plan.TOTAL_DELTA_V_KM_S * KM,
    phasingPeriod: a.PERIOD_S,
    phasingSMA: a.SEMI_MAJOR_AXIS_KM * KM,
    totalTime: plan.TOTAL_TIME_S,
    numRevs: a.REVOLUTIONS,
    phaseAngle: rad(p.PHASE_ANGLE_DEG),
    dv1_ric: m3(b1.DELTA_V),
    dv2_ric: m3(b2.DELTA_V),
    frame: "RIC",
    farApse: p.FAR_APSE_RADIUS_KM * KM,
    earthFloorRadius: p.FLOOR_RADIUS_KM * KM,
    clampedToEarthFloor: p.CLAMPED_TO_FLOOR,
    achievedPhaseAngle: rad(p.ACHIEVED_PHASE_ANGLE_DEG),
    requestedPhasingSMA: p.REQUESTED_SEMI_MAJOR_AXIS_KM * KM,
    requestedPhasingPeriod: p.REQUESTED_PERIOD_S,
  };
}

function chiefBack(e) {
  return {
    semiMajorAxis: e.SEMI_MAJOR_AXIS_KM * KM,
    eccentricity: e.ECCENTRICITY,
    inclination: rad(e.INCLINATION_DEG),
    raan: rad(e.RAAN_DEG),
    argumentOfPerigee: rad(e.ARG_OF_PERIAPSIS_DEG),
    meanAnomaly: rad(e.MEAN_ANOMALY_DEG),
    mu: e.MU_KM3_S2 * KM3,
  };
}

export function decodeAnswer(operation, plan) {
  const B = plan.BURNS ?? [];
  switch (operation) {
    case "hohmannTransfer":
    case "combinedManeuver":
      return {
        dv1: signed(B[0]), dv2: signed(B[1]), totalDeltaV: plan.TOTAL_DELTA_V_KM_S * KM,
        tof: plan.TOTAL_TIME_S, aTransfer: plan.ARCS[0].SEMI_MAJOR_AXIS_KM * KM,
        dv1_ric: m3(B[0].DELTA_V), dv2_ric: m3(B[1].DELTA_V), frame: "RIC",
      };
    case "biEllipticTransfer":
      return {
        dv1: signed(B[0]), dv2: signed(B[1]), dv3: signed(B[2]), totalDeltaV: plan.TOTAL_DELTA_V_KM_S * KM,
        tof: plan.TOTAL_TIME_S, aTransfer1: plan.ARCS[0].SEMI_MAJOR_AXIS_KM * KM, aTransfer2: plan.ARCS[1].SEMI_MAJOR_AXIS_KM * KM,
        tof1: plan.ARCS[0].DURATION_S, tof2: plan.ARCS[1].DURATION_S,
        dv1_ric: m3(B[0].DELTA_V), dv2_ric: m3(B[1].DELTA_V), dv3_ric: m3(B[2].DELTA_V), frame: "RIC",
      };
    case "planeChange":
      return { dv: signed(B[0]), optimalTrueAnomaly: rad(B[0].TRUE_ANOMALY_DEG), dv_ric: m3(B[0].DELTA_V), frame: "RIC" };
    case "solveLambert":
    case "solveLambertMinDV": {
      const a = plan.ARCS[0];
      const v1 = vel(a.START_STATE);
      const v2 = vel(a.END_STATE);
      const out = {
        v1, v2,
        v1Magnitude: Math.sqrt(v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]),
        v2Magnitude: Math.sqrt(v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2]),
        tof: a.DURATION_S, converged: a.SOLVER.CONVERGED, status: a.SOLVER.STATUS_TEXT,
        residual: a.SOLVER.RESIDUAL, residualBudget: a.SOLVER.RESIDUAL_TOLERANCE, z: a.LAMBERT_Z,
        iterations: a.SOLVER.ITERATIONS, revolutions: a.REVOLUTIONS,
      };
      if (B.length) {
        Object.assign(out, {
          dv1: B[0].MAGNITUDE_KM_S * KM, dv2: B[1].MAGNITUDE_KM_S * KM, totalDeltaV: plan.TOTAL_DELTA_V_KM_S * KM,
          dv1_vec: m3(B[0].DELTA_V), dv2_vec: m3(B[1].DELTA_V), frame: "ECI",
        });
      }
      if (a.REVOLUTIONS >= 1) out.branch = BRANCH[a.BRANCH];
      if (a.CONIC) {
        out.transferConic = CONIC[a.CONIC];
        out.perigeeRadius = a.PERIAPSIS_RADIUS_KM * KM;
        out.transferEccentricity = a.ECCENTRICITY;
        if (a.APOAPSIS_RADIUS_KM !== 0) out.apogeeRadius = a.APOAPSIS_RADIUS_KM * KM;
        if (a.SEMI_MAJOR_AXIS_KM !== 0) out.transferSemiMajorAxis = a.SEMI_MAJOR_AXIS_KM * KM;
      }
      if (plan.OPTIONS?.length) {
        out.branches = plan.OPTIONS.map((o) => {
          const c = { revolutions: o.REVOLUTIONS };
          if (o.REVOLUTIONS >= 1) c.branch = BRANCH[o.BRANCH];
          c.dv1 = o.BURN_DELTA_V_KM_S[0] * KM;
          c.dv2 = o.BURN_DELTA_V_KM_S[1] * KM;
          c.totalDeltaV = o.TOTAL_DELTA_V_KM_S * KM;
          return c;
        });
      }
      return out;
    }
    case "phasingManeuver":
      return phasingPlan(plan);
    case "phasingFromTargetState": {
      const p = plan.PHASING;
      const summary = (o) => ({
        phaseAngle: rad(o.PHASE_ANGLE_DEG), numRevs: o.REVOLUTIONS, totalDeltaV: o.TOTAL_DELTA_V_KM_S * KM,
        totalTime: o.TOTAL_TIME_S, phasingSMA: o.SEMI_MAJOR_AXIS_KM * KM, clampedToEarthFloor: o.CLAMPED_TO_FLOOR,
        metDeltaVBudget: o.WITHIN_BUDGET,
      });
      return {
        relativePhaseAngle: rad(p.RELATIVE_PHASE_ANGLE_DEG), catchUpAngle: rad(p.CATCH_UP_ANGLE_DEG),
        fallBehindAngle: rad(p.FALL_BEHIND_ANGLE_DEG), direction: DIRECTION[p.DIRECTION],
        chaserMeanArgumentOfLatitude: rad(p.CHASER.MEAN_ARGUMENT_OF_LATITUDE_DEG),
        targetMeanArgumentOfLatitude: rad(p.TARGET.MEAN_ARGUMENT_OF_LATITUDE_DEG),
        chaserMeanAnomaly: rad(p.CHASER.MEAN_ANOMALY_DEG), targetMeanAnomaly: rad(p.TARGET.MEAN_ANOMALY_DEG),
        raanDifference: rad(p.RAAN_DIFFERENCE_DEG), inclinationDifference: rad(p.INCLINATION_DIFFERENCE_DEG),
        planeAngle: rad(p.PLANE_ANGLE_DEG), chaserSemiMajorAxis: p.CHASER.SEMI_MAJOR_AXIS_KM * KM,
        targetSemiMajorAxis: p.TARGET.SEMI_MAJOR_AXIS_KM * KM, semiMajorAxisDifference: p.SEMI_MAJOR_AXIS_DIFFERENCE_KM * KM,
        chaserEccentricity: p.CHASER.ECCENTRICITY, targetEccentricity: p.TARGET.ECCENTRICITY,
        coplanar: p.COPLANAR, coplanarTolerance: rad(p.COPLANAR_TOLERANCE_DEG), nearCircular: p.NEAR_CIRCULAR,
        eccentricityTolerance: p.ECCENTRICITY_TOLERANCE, coOrbital: p.CO_ORBITAL, coOrbitalTolerance: p.CO_ORBITAL_TOLERANCE_KM * KM,
        recommendedRevs: p.RECOMMENDED_REVOLUTIONS, revsFromCaller: p.REVOLUTIONS_FROM_CALLER,
        metDeltaVBudget: p.WITHIN_BUDGET, deltaVBudget: p.DELTA_V_BUDGET_KM_S * KM, maxRevs: p.MAX_REVOLUTIONS,
        phasingRadius: p.PHASING_RADIUS_KM * KM,
        ...phasingPlan(plan),
        catchUp: summary(plan.OPTIONS[0]), fallBehind: summary(plan.OPTIONS[1]),
      };
    }
    case "computeRoeStateTransition": {
      const r = plan.RELATIVE;
      const out = {
        reference: r.MODEL_REFERENCE, model: MODEL[r.STM_DYNAMICS], deltaTime: plan.TOTAL_TIME_S,
        stm: chunk(r.STATE_TRANSITION, 6),
      };
      if (r.INITIAL_ROE?.length) {
        out.initialRoe = r3(r.INITIAL_ROE);
        out.propagatedRoe = r3(r.PROPAGATED_ROE);
      }
      if (r.DRAG_COLUMN_COUNT === 1) out.dragColumn = r3(r.DRAG_COLUMNS);
      if (r.DRAG_COLUMN_COUNT === 3) out.dragColumns = chunk(r.DRAG_COLUMNS, 3);
      return out;
    }
    case "planRelativeWaypointMission": {
      const r = plan.RELATIVE;
      const legs = plan.ARCS.map((a, index) => {
        const burns = B.filter((b) => b.NAME.startsWith(`${a.NAME} `));
        const burnOut = (b) => ({ deltaV: m3(b.DELTA_V), magnitude: b.MAGNITUDE_KM_S * KM, frame: "RIC", chief: chiefBack(b.REFERENCE_ORBIT) });
        return {
          index, from: pos(a.START_STATE), to: pos(a.END_STATE), targetVelocity: vel(a.END_STATE), tof: a.DURATION_S,
          burn1: burnOut(burns[0]), burn2: burnOut(burns[1]), totalDeltaV: a.DELTA_V_KM_S * KM,
          converged: a.SOLVER.CONVERGED, iterations: a.SOLVER.ITERATIONS, positionError: a.SOLVER.RESIDUAL * KM,
        };
      });
      const t = plan.TRAJECTORY;
      const trajectory = (t?.OFFSETS_S ?? []).map((time, i) => ({
        time, position: m3(t.STATES.slice(i * 6, i * 6 + 3)), velocity: m3(t.STATES.slice(i * 6 + 3, i * 6 + 6)),
      }));
      return {
        reference: r.MODEL_REFERENCE, model: MODEL[r.DYNAMICS], includeDrag: Boolean(plan.REQUEST?.RELATIVE?.DRAG),
        converged: plan.SOLVER.CONVERGED, totalDeltaV: plan.TOTAL_DELTA_V_KM_S * KM, totalTime: plan.TOTAL_TIME_S,
        legs, trajectory,
      };
    }
    case "computeCAM":
      return {
        deltaV: m3(B[0].DELTA_V), frame: "RIC", magnitude: B[0].MAGNITUDE_KM_S * KM,
        achievedMiss: plan.RELATIVE.ACHIEVED_MISS_KM * KM, feasible: plan.RELATIVE.FEASIBLE, optimalBurnTime: B[0].OFFSET_S,
      };
    case "computeApproach":
      return {
        corridorDeviation: plan.RELATIVE.CORRIDOR_DEVIATION_KM * KM, withinCorridor: plan.RELATIVE.WITHIN_CORRIDOR,
        axis: plan.REQUEST.RELATIVE.APPROACH_AXIS, leg: { totalDeltaV: plan.TOTAL_DELTA_V_KM_S * KM },
      };
    case "simulateRendezvous": {
      const r = plan.RENDEZVOUS;
      const v3 = (a, i) => m3(a.slice(i * 3, i * 3 + 3));
      return {
        reference: r.MODEL_REFERENCE, meanMotion: r.MEAN_MOTION_RAD_S, solvedInitialVelocity: m3(r.INITIAL_VELOCITY_KM_S),
        gains: { kp: r3(r.KP_PER_S2), kd: r3(r.KD_PER_S) },
        phases: { driftEnd: r.DRIFT_END_S, brakeEnd: r.BRAKE_END_S, totalTime: r.TOTAL_TIME_S },
        metrics: {
          totalDeltaV: plan.TOTAL_DELTA_V_KM_S * KM, maxControlAccel: r.MAX_CONTROL_ACCELERATION_KM_S2 * KM,
          saturatedSteps: r.SATURATED_STEPS, maxPositionError: r.MAX_POSITION_ERROR_KM * KM,
          rmsPositionError: r.RMS_POSITION_ERROR_KM * KM, maxPositionErrorDrift: r.MAX_POSITION_ERROR_DRIFT_KM * KM,
          maxPositionErrorBrake: r.MAX_POSITION_ERROR_BRAKE_KM * KM, maxPositionErrorHold: r.MAX_POSITION_ERROR_HOLD_KM * KM,
          finalPositionError: r.FINAL_POSITION_ERROR_KM * KM, finalVelocityError: r.FINAL_VELOCITY_ERROR_KM_S * KM,
        },
        trajectory: r.SAMPLE_TIME_S.map((time, i) => ({
          time, phase: PHASE[r.SAMPLE_PHASE[i]] ?? "unknown",
          position: v3(r.POSITION_KM, i), velocity: v3(r.VELOCITY_KM_S, i),
          referencePosition: v3(r.REFERENCE_POSITION_KM, i), referenceVelocity: v3(r.REFERENCE_VELOCITY_KM_S, i),
          referenceAcceleration: v3(r.REFERENCE_ACCELERATION_KM_S2, i), controlAccel: v3(r.CONTROL_ACCELERATION_KM_S2, i),
          positionError: r.POSITION_ERROR_KM[i] * KM, velocityError: r.VELOCITY_ERROR_KM_S[i] * KM,
        })),
      };
    }
    case "evaluateOrbitGeometry": {
      const g = plan.GEOMETRY;
      const e = g.ELEMENTS;
      const basis = (b, names) => Object.fromEntries(names.map((n, i) => [n, r3(b.slice(i * 3, i * 3 + 3))]));
      return {
        elements: {
          semiMajorAxis: e.SEMI_MAJOR_AXIS_KM * KM, eccentricity: e.ECCENTRICITY, inclination: rad(e.INCLINATION_DEG),
          raan: rad(e.RAAN_DEG), argumentOfPeriapsis: rad(e.ARG_OF_PERIAPSIS_DEG), trueAnomaly: rad(e.TRUE_ANOMALY_DEG),
          meanAnomaly: rad(e.MEAN_ANOMALY_DEG), ascendingNodeTrueAnomaly: rad(e.ASCENDING_NODE_TRUE_ANOMALY_DEG),
          meanMotion: rad(e.MEAN_MOTION_DEG_S), period: e.PERIOD_S,
          periapsisRadius: e.PERIAPSIS_RADIUS_KM * KM, apoapsisRadius: e.APOAPSIS_RADIUS_KM * KM,
        },
        state: { position: pos(g.STATE), velocity: vel(g.STATE) },
        departureRicBasis: basis(g.RIC_BASIS, ["radial", "inTrack", "crossTrack"]),
        departureVncBasis: basis(g.VNC_BASIS, ["velocity", "normal", "conormal"]),
        radius: g.RADIUS_KM * KM, positionFrame: "INERTIAL", units: "SI",
      };
    }
    case "convertOrbitAnomaly": {
      const e = plan.GEOMETRY.ELEMENTS;
      return { trueAnomaly: rad(e.TRUE_ANOMALY_DEG), meanAnomaly: rad(e.MEAN_ANOMALY_DEG), eccentricAnomaly: rad(e.ECCENTRIC_ANOMALY_DEG) };
    }
    case "orbitTimeOfFlight":
      return { seconds: plan.GEOMETRY.TIME_OF_FLIGHT_S };
    case "sampleOrbitGeometry":
      return { positions: m3(plan.TRAJECTORY.STATES), offsets: r3(plan.TRAJECTORY.OFFSETS_S), count: plan.TRAJECTORY.OFFSETS_S.length };
    case "transformDeltaV": {
      const g = plan.GEOMETRY;
      const b = g.RIC_BASIS;
      return {
        deltaV: m3(g.BURN.DELTA_V), frame: g.BURN.AXES === M.mplAxes.Inertial ? "ECI" : "RIC",
        magnitude: g.BURN.MAGNITUDE_KM_S * KM, basis: { R: b.slice(0, 3), I: b.slice(3, 6), C: b.slice(6, 9) },
      };
    }
    default:
      throw new Error(`no decoder for ${operation}`);
  }
}

// ---------------------------------------------------------------------------
// Invoking
// ---------------------------------------------------------------------------

/** Send one $MPL request; return the outcome without throwing. */
export async function probePlan(harness, planOrBytes) {
  const payload = planOrBytes instanceof Uint8Array ? planOrBytes : packPlan(planOrBytes);
  try {
    const response = await harness.invoke({ methodId: "plan", inputs: [{ portId: "request", payload, typeRef: MPL_TYPE }] });
    const frame = response.outputs?.find((entry) => entry.portId === "plan");
    let plan = null;
    let planError = null;
    if (frame) {
      try {
        plan = unpackPlan(frame.payload);
      } catch (error) {
        planError = String(error);
      }
    }
    return { trapped: false, statusCode: response.statusCode, errorCode: response.errorCode, plan, planError, frame };
  } catch (error) {
    return { trapped: true, error: String(error) };
  }
}

/**
 * The 0.6.x command, over the $MPL wire. Returns the outcome with `body`: the
 * 0.6.x answer object on success, `{error, errorCode}` on a refusal.
 */
export async function probeOperation(harness, request) {
  if (process.env.MPL_RECORD) {
    // Old-versus-new comparison support: every command a suite sends is logged.
    fs.appendFileSync(process.env.MPL_RECORD, `${JSON.stringify(request)}\n`);
  }
  if (request.operation === "version") {
    const { plan } = encodeRequest("hohmannTransfer", { r1: 7e6, r2: 8e6 });
    const outcome = await probePlan(harness, plan);
    if (outcome.trapped) return outcome;
    return { ...outcome, body: { version: String(outcome.plan?.PLANNER ?? "").replace(/^maneuver-planner /, "") } };
  }
  const { plan } = encodeRequest(request.operation, request.params);
  const outcome = await probePlan(harness, plan);
  if (outcome.trapped || !outcome.plan) return { ...outcome, body: null, bodyError: outcome.planError };
  const answer = outcome.plan;
  const body = answer.STATUS === M.mplStatus.Solved
    ? decodeAnswer(request.operation, answer)
    : { error: String(answer.ERROR_MESSAGE ?? ""), errorCode: String(answer.ERROR_CODE ?? "") };
  return { ...outcome, body, bodyError: null };
}

/** As `invokeJsonRequest` was: the answer object, asserting success. */
export async function invokeOperation(harness, request) {
  const outcome = await probeOperation(harness, request);
  if (outcome.trapped) throw new Error(`plan trapped: ${outcome.error}`);
  if (outcome.statusCode !== 0) {
    throw new Error(`plan refused ${request.operation}: ${outcome.errorCode} ${outcome.body?.error ?? ""}`);
  }
  return outcome.body;
}
