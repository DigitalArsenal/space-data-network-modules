import * as flatbuffers from "flatbuffers";
import { ACW, ACWT } from "spacedatastandards.org/lib/js/ACW/ACW.js";
import { ACWRequestT } from "spacedatastandards.org/lib/js/ACW/ACWRequest.js";
import { ACWGroundStationT } from "spacedatastandards.org/lib/js/ACW/ACWGroundStation.js";
import { ACWStateSampleT } from "spacedatastandards.org/lib/js/ACW/ACWStateSample.js";
import { ACWConstraintT } from "spacedatastandards.org/lib/js/ACW/ACWConstraint.js";
import { ACWConstraintSetT } from "spacedatastandards.org/lib/js/ACW/ACWConstraintSet.js";
import { ACWObserverTrajectoryT } from "spacedatastandards.org/lib/js/ACW/ACWObserverTrajectory.js";
import { ACWBlackoutWindowT } from "spacedatastandards.org/lib/js/ACW/ACWBlackoutWindow.js";
import { ACWElevationMaskPointT } from "spacedatastandards.org/lib/js/ACW/ACWElevationMaskPoint.js";
import { acwConstraintKind as K } from "spacedatastandards.org/lib/js/ACW/acwConstraintKind.js";
import { acwConstraintOperator as OP } from "spacedatastandards.org/lib/js/ACW/acwConstraintOperator.js";
import { acwEvaluationMode as MODE } from "spacedatastandards.org/lib/js/ACW/acwEvaluationMode.js";
import { acwLightingCondition as LIGHT } from "spacedatastandards.org/lib/js/ACW/acwLightingCondition.js";

export { K, OP, MODE, LIGHT };
export const EPOCH_TT = 2460400.5;
export const ROOT_TOLERANCE_S = 0.01;
export const EDGE_TOLERANCE_S = 0.0101;
export const EARTH_A_M = 6378137;
export const EARTH_B_M = EARTH_A_M * (1 - 1 / 298.257223563);
export const AU_M = 149597870700;
export const typeRef = { schemaName: "ACW.fbs", fileIdentifier: "$ACW", rootTypeName: "ACW", wireFormat: "flatbuffer" };

// Authoritative fixture contract (applies to every numerical case below):
// Frame: geocentric Earth-fixed Cartesian; positions/ranges metres, angles
// radians. Epoch EPOCH_TT is Julian Date TT, offsets and edge errors seconds.
// These are geometric interpolation cases, with no dynamics or frame rotation.
// The expectations below follow exact line, cone and ellipsoid intersections,
// independently of the production code; none is a recorded module output.
// WGS84 a/f authority: https://earth-info.nga.mil/?action=wgs84&dir=wgs84
// The exact AU is IAU2012 resolution B2:
// https://www.iau.org/static/resolutions/IAU2012_English.pdf
// The requested root tolerance is 0.01 s; the 0.0101 s assertion tolerance adds
// 0.0001 s for JD double quantisation (one ULP here is about 40 microseconds).
// Range assertions allow 1 m at refined endpoints: at these fixtures' maximum
// relative speed of 40 m/s, 0.0101 s corresponds to less than 0.405 m. Interior
// analytic range minima allow 1e-6 m for double arithmetic only.
export const metadata = {
  frame: "Earth-fixed Cartesian, WGS84 ellipsoid", epoch: `${EPOCH_TT} JD TT`,
  units: "metres, radians, seconds", source: "independent closed-form Euclidean geometry; NGA WGS84 ellipsoid",
  edgeToleranceSeconds: EDGE_TOLERANCE_S, rootToleranceSeconds: ROOT_TOLERANCE_S,
};

export const state = (seconds, position) => new ACWStateSampleT(EPOCH_TT + seconds / 86400, ...position);
export const station = (id = "ground", fields = {}) => Object.assign(new ACWGroundStationT(id, id, 0, 0, 0, 0, 1, []), fields);
export const constraint = (kind, label, fields = {}) => Object.assign(new ACWConstraintT(), { KIND: kind, LABEL: label }, fields);
export const set = (operator, constraints = [], nested = []) => new ACWConstraintSetT(operator, constraints, nested);
export const observer = (id, states, blackouts = []) => new ACWObserverTrajectoryT(id, id, states, blackouts);
export const blackout = (start, end) => new ACWBlackoutWindowT(EPOCH_TT + start / 86400, EPOCH_TT + end / 86400);
export const maskPoint = (azimuth, elevation) => new ACWElevationMaskPointT(azimuth, elevation);
export const relative = (seconds, [x, y, z]) => state(seconds, [EARTH_A_M + x, y, z]);
export function requestFor(fields) {
  const request = Object.assign(new ACWRequestT(), {
    OPERATION: 1, EVALUATION_MODE: MODE.CONTINUOUS,
    ROOT_TOLERANCE_S, TRACE_ID: "lane06-constraints",
  }, fields);
  const builder = new flatbuffers.Builder(2048);
  ACW.finishACWBuffer(builder, new ACWT(request, null).pack(builder));
  return { methodId: "compute_access_windows", inputs: [{ portId: "request", typeRef, payload: builder.asUint8Array() }] };
}
export function resultFrom(response) {
  if (!response.outputs?.[0]?.payload) throw new Error(`Missing ACW output: ${response.statusCode} ${response.errorMessage}`);
  return ACW.getRootAsACW(new flatbuffers.ByteBuffer(response.outputs[0].payload)).RESULT().unpack();
}

const ground = () => [station()];
const rangeBand = () => set(OP.ALL_OF, [
  constraint(K.MIN_RANGE, "near-bound", { MIN_RANGE_M: 400 }),
  constraint(K.MAX_RANGE, "far-bound", { MAX_RANGE_M: 800 }),
]);
const rangeStates = (times) => times.map((t) => relative(t, [200 + 10 * t, 0, 0]));
export const cases = [
  {
    id: "range-band-between-samples", formula: "400 <= 200+10t <= 800 gives 20 <= t <= 60",
    fields: { GROUND_STATIONS: ground(), STATES: rangeStates([0, 100]), CONSTRAINTS: rangeBand() },
    labels: ["near-bound", "far-bound"],
    windows: [{ start: 20, end: 60, startIndex: 0, endIndex: 1, sampleCount: 0, minRange: 400, maxRange: 800 }],
  },
  {
    id: "range-band-discrete", formula: "Only samples t=25,50 satisfy 400 <= 200+10t <= 800",
    fields: { GROUND_STATIONS: ground(), STATES: rangeStates([0, 25, 50, 75, 100]), CONSTRAINTS: rangeBand(), EVALUATION_MODE: MODE.DISCRETE },
    labels: ["near-bound", "far-bound"], windows: [{ start: 25, end: 50, sampleCount: 2, minRange: 450, maxRange: 700 }],
  },
  {
    id: "nested-and-or-attribution", formula: "r=100+10t; r<=1000 AND (r<=300 OR r>=700) gives [0,20] union [60,90]",
    fields: {
      GROUND_STATIONS: ground(), STATES: [0, 100].map((t) => relative(t, [100 + 10 * t, 0, 0])),
      CONSTRAINTS: set(OP.ALL_OF, [constraint(K.MAX_RANGE, "cap", { MAX_RANGE_M: 1000 })], [set(OP.ANY_OF, [
        constraint(K.MAX_RANGE, "near", { MAX_RANGE_M: 300 }), constraint(K.MIN_RANGE, "far", { MIN_RANGE_M: 700 }),
      ])]),
    },
    labels: ["cap", "near", "far"],
    windows: [{ start: 0, end: 20, startIndex: -1, endIndex: 1, sampleCount: 1 }, { start: 60, end: 90, startIndex: 2, endIndex: 0, sampleCount: 0 }],
  },
  {
    id: "discrete-causal-attribution", formula: "(A:r<=500 AND B:r<=0) OR C:r>=700; r=200+10t. B is always false, so only C can open access at sample100",
    fields: {
      GROUND_STATIONS: ground(), STATES: rangeStates([0, 100]), EVALUATION_MODE: MODE.DISCRETE,
      CONSTRAINTS: set(OP.ANY_OF, [], [set(OP.ALL_OF, [
        constraint(K.MAX_RANGE, "irrelevant-A", { MAX_RANGE_M: 500 }), constraint(K.MAX_RANGE, "always-false-B", { MAX_RANGE_M: 0 }),
      ]), set(OP.ALL_OF, [constraint(K.MIN_RANGE, "causal-C", { MIN_RANGE_M: 700 })])]),
    },
    labels: ["irrelevant-A", "always-false-B", "causal-C"],
    windows: [{ start: 100, end: 100, startIndex: 2, endIndex: -1, sampleCount: 1, minRange: 1200, maxRange: 1200 }],
  },
  {
    id: "range-interior-extremum", formula: "r(t)=sqrt(1000^2+(-2000+40t)^2), min at t=50, maxima at endpoints",
    fields: { GROUND_STATIONS: ground(), STATES: [0, 100].map((t) => relative(t, [1000, -2000 + 40 * t, 0])), CONSTRAINTS: set(OP.ALL_OF, [constraint(K.MAX_RANGE, "range", { MAX_RANGE_M: 3000 })]) },
    labels: ["range"], windows: [{ start: 0, end: 100, startIndex: -1, endIndex: -1, sampleCount: 2, minRange: 1000, maxRange: Math.sqrt(5) * 1000, rangeTolerance: 1e-6 }],
  },
  {
    id: "elevation-horizon", formula: "equatorial station up=-1000+20t, east=1000; elevation>=0 iff t>=50",
    fields: { GROUND_STATIONS: ground(), STATES: [0, 100].map((t) => relative(t, [-1000 + 20 * t, 1000, 0])), CONSTRAINTS: set(OP.ALL_OF, [constraint(K.MIN_ELEVATION, "horizon", { THRESHOLD_RAD: 0 })]) },
    labels: ["horizon"], windows: [{ start: 50, end: 100, startIndex: 0, endIndex: -1, sampleCount: 1 }],
  },
  {
    id: "elevation-mask", formula: "constant 45-degree mask; up=500+10t, east=1000; elevation>=pi/4 iff t>=50",
    fields: { GROUND_STATIONS: ground(), STATES: [0, 100].map((t) => relative(t, [500 + 10 * t, 1000, 0])), CONSTRAINTS: set(OP.ALL_OF, [constraint(K.ELEVATION_MASK, "mask", { MASK: [maskPoint(0, Math.PI / 4), maskPoint(Math.PI, Math.PI / 4)] })]) },
    labels: ["mask"], windows: [{ start: 50, end: 100, startIndex: 0, endIndex: -1, sampleCount: 1 }],
  },
];

for (const [kind, field, name, distance] of [
  [K.SUN_EXCLUSION, "SUN_STATES", "sun", AU_M],
  [K.MOON_EXCLUSION, "MOON_STATES", "moon", 384400000],
]) {
  cases.push({
    id: `${name}-exclusion-two-edges`, formula: "angle((1000,-2000+40t,0),+X)>=pi/4 iff |t-50|>=25",
    fields: {
      GROUND_STATIONS: ground(), STATES: [0, 100].map((t) => relative(t, [1000, -2000 + 40 * t, 0])),
      [field]: [0, 100].map((t) => relative(t, [distance, 0, 0])),
      CONSTRAINTS: set(OP.ALL_OF, [constraint(kind, `${name}-keepout`, { THRESHOLD_RAD: Math.PI / 4 })]),
    },
    labels: [`${name}-keepout`], windows: [
      { start: 0, end: 25, startIndex: -1, endIndex: 0, sampleCount: 1, minRange: Math.SQRT2 * 1000, maxRange: Math.sqrt(5) * 1000 },
      { start: 75, end: 100, startIndex: 0, endIndex: -1, sampleCount: 1, minRange: Math.SQRT2 * 1000, maxRange: Math.sqrt(5) * 1000 },
    ],
  });
}
cases.push({
  id: "sun-ephemeris-interpolation", formula: "target +X; linearly interpolated Sun direction (D,D*(-2+0.04t),0); separation>=pi/4 iff t<=25 or t>=75",
  fields: {
    GROUND_STATIONS: ground(), STATES: [0, 50, 100].map((t) => relative(t, [1000, 0, 0])),
    SUN_STATES: [-10, 110].map((t) => relative(t, [AU_M, AU_M * (-2 + 0.04 * t), 0])),
    CONSTRAINTS: set(OP.ALL_OF, [constraint(K.SUN_EXCLUSION, "sun-interpolated", { THRESHOLD_RAD: Math.PI / 4 })]),
  },
  labels: ["sun-interpolated"], windows: [{ start: 0, end: 25, startIndex: -1, endIndex: 0, sampleCount: 1 }, { start: 75, end: 100, startIndex: 0, endIndex: -1, sampleCount: 1 }],
});
cases.push({
  id: "sun-exclusion-narrow-interior-gap", formula: "target +X; interpolated Sun (D,D*(t-20),0); angle=atan(|t-20|), threshold atan(0.1) gives [0,19.9] union [20.1,100]",
  // Exact synthetic geometry, deliberately placing the angular minimum away
  // from uniform search subdivisions and away from any target-range minimum.
  // A search that only checks endpoint signs or a fixed grid loses both edges.
  fields: {
    GROUND_STATIONS: ground(), STATES: [0, 100].map((t) => relative(t, [1000, 0, 0])),
    SUN_STATES: [0, 100].map((t) => relative(t, [AU_M, AU_M * (t - 20), 0])),
    CONSTRAINTS: set(OP.ALL_OF, [constraint(K.SUN_EXCLUSION, "narrow-sun", { THRESHOLD_RAD: Math.atan(0.1) })]),
  },
  labels: ["narrow-sun"], windows: [{ start: 0, end: 19.9, startIndex: -1, endIndex: 0, sampleCount: 1 }, { start: 20.1, end: 100, startIndex: 0, endIndex: -1, sampleCount: 1 }],
});

for (const axis of ["equatorial", "polar"]) {
  for (const atmosphere of [0, 500]) {
    const position = (t, sign) => axis === "equatorial"
      ? [EARTH_A_M - 1000 + 20 * t, sign * 1e6, 0]
      : [0, sign * 1e6, EARTH_B_M - 1000 + 20 * t];
    cases.push({
      id: `limb-${axis}-${atmosphere}m`, formula: "symmetric line has minimum ellipsoid radius at y=0; h=-1000+20t >= atmosphere",
      fields: {
        STATES: [0, 100].map((t) => state(t, position(t, 1))),
        OBSERVERS: [observer("relay", [0, 100].map((t) => state(t, position(t, -1))))],
        CONSTRAINTS: set(OP.ALL_OF, [constraint(K.LINE_OF_SIGHT, "limb", { OCCULTATION_ATMOSPHERE_HEIGHT_M: atmosphere })]),
      },
      labels: ["limb"], windows: [{ start: (1000 + atmosphere) / 20, end: 100, startIndex: 0, endIndex: -1, observerId: "relay", sampleCount: 1, minRange: 2e6, maxRange: 2e6, rangeTolerance: 1e-6 }],
    });
  }
}
{
  const lineY = EARTH_A_M - 0.001;
  const halfDuration = EARTH_B_M * Math.sqrt(1 - (lineY / EARTH_A_M) ** 2) / 1000;
  const position = (t, sign) => [sign * 3e6, lineY, 1000 * (t - 20)];
  cases.push({
    id: "limb-narrow-interior-occultation", formula: "line x=+-3e6, y=a-0.001, z=1000(t-20); limb at (y/a)^2+(z/b)^2=1, roots20+-b*sqrt(1-(y/a)^2)/1000",
    fields: {
      STATES: [0, 100].map((t) => state(t, position(t, 1))),
      OBSERVERS: [observer("relay", [0, 100].map((t) => state(t, position(t, -1))))],
      CONSTRAINTS: set(OP.ALL_OF, [constraint(K.LINE_OF_SIGHT, "narrow-limb")]),
    },
    labels: ["narrow-limb"], windows: [
      { start: 0, end: 20 - halfDuration, startIndex: -1, endIndex: 0, observerId: "relay", sampleCount: 1 },
      { start: 20 + halfDuration, end: 100, startIndex: 0, endIndex: -1, observerId: "relay", sampleCount: 1 },
    ],
  });
}

for (const moving of [false, true]) {
  cases.push({
    id: moving ? "observer-blackout" : "station-blackout", formula: "complement of the explicit blackout [25,75] in [0,100]",
    fields: {
      STATES: [0, 100].map((t) => relative(t, [1000, 0, 0])),
      ...(moving ? { OBSERVERS: [observer("relay", [0, 100].map((t) => relative(t, [0, 0, 0])), [blackout(25, 75)])] }
        : { GROUND_STATIONS: [station("ground", { BLACKOUT_WINDOWS: [blackout(25, 75)] })] }),
      CONSTRAINTS: set(OP.ALL_OF, [constraint(K.BLACKOUT, "unavailable")]),
    },
    labels: ["unavailable"], windows: [
      { start: 0, end: 25, startIndex: -1, endIndex: 0, sampleCount: 1, ...(moving ? { observerId: "relay" } : {}) },
      { start: 75, end: 100, startIndex: 0, endIndex: -1, sampleCount: 1, ...(moving ? { observerId: "relay" } : {}) },
    ],
  });
}
cases.push({
  id: "ground-and-moving-observers", formula: "target x=a+1000; station x=a and relay x=a+500 are both within 1000 metres",
  fields: { GROUND_STATIONS: ground(), STATES: [0, 100].map((t) => relative(t, [1000, 0, 0])), OBSERVERS: [observer("relay", [0, 100].map((t) => relative(t, [500, 0, 0])))], CONSTRAINTS: set(OP.ALL_OF, [constraint(K.MAX_RANGE, "range", { MAX_RANGE_M: 1500 })]) },
  labels: ["range"], windows: [{ start: 0, end: 100, stationId: "ground", minRange: 1000, maxRange: 1000 }, { start: 0, end: 100, observerId: "relay", minRange: 500, maxRange: 500 }],
});

// Orekit EclipseDetector's documented umbra/penumbra apparent-disk definition:
// https://www.orekit.org/site-orekit-13.1.2/apidocs/org/orekit/propagation/events/EclipseDetector.html
// At x=+7e6 the Earth and Sun directions are opposite (sunlit); at x=-7e6
// they coincide with the Earth disk larger (umbra). For the limb fixture,
// y=a and x=-sqrt(r^2-a^2) put the Sun centre on the spherical Earth limb
// for a Sun at infinity; finite AU parallax is <5e-5 rad, much less than the
// Sun's ~0.00465 rad half-angle, so it is unambiguously in penumbra only.
const illuminationPositions = {
  sunlit: [7e6, 0, 0], umbra: [-7e6, 0, 0],
  penumbra: [-Math.sqrt(7e6 ** 2 - EARTH_A_M ** 2), EARTH_A_M, 0],
};
for (const [name, position] of Object.entries(illuminationPositions)) {
  for (const lighting of [LIGHT.SUNLIT, LIGHT.PENUMBRA, LIGHT.UMBRA, LIGHT.NOT_UMBRA, LIGHT.ANY]) {
    const visible = lighting === LIGHT.ANY || lighting === LIGHT[name.toUpperCase()] || (lighting === LIGHT.NOT_UMBRA && name !== "umbra");
    cases.push({
      id: `lighting-${name}-${lighting}`, formula: `apparent-disk classification ${name}; required lighting enum ${lighting}`,
      fields: {
        GROUND_STATIONS: ground(), STATES: [0, 100].map((t) => state(t, position)), SUN_STATES: [0, 100].map((t) => state(t, [AU_M, 0, 0])),
        CONSTRAINTS: set(OP.ALL_OF, [constraint(K.TARGET_LIGHTING, "lighting", { LIGHTING: lighting })]),
      },
      labels: ["lighting"], windows: visible ? [{ start: 0, end: 100, startIndex: -1, endIndex: -1, sampleCount: 2 }] : [],
    });
  }
}
{
  // Independent finite-disk tangent construction, with target T=(-r,0,0),
  // Sun=(D,10D(t-20),0), Earth at zero. Set A=D+r, sin(alpha)=R/r.
  // Umbra boundary theta+beta=alpha implies A*sin(alpha)-|y|*cos(alpha)=S;
  // outer penumbra theta-beta=alpha implies |y|*cos(alpha)-A*sin(alpha)=S.
  // Thus the exact two half-durations are (A*sin(alpha) +/- S)/(10D*cos(alpha)).
  // Solar nominal radius S=6.957e8 m: IAU2015 Resolution B3,
  // https://www.iau.org/static/resolutions/IAU2015_English.pdf
  // 0.0001 s root request and 0.0002 s edge tolerance resolve the roughly
  // 2 ms penumbra bands while allowing JD quantisation. This is a synthetic
  // ephemeris designed to exercise between-sample transitions, not an orbit.
  const r = 7e6, sinAlpha = EARTH_A_M / r, cosAlpha = Math.sqrt(1 - sinAlpha ** 2), solarRadius = 6.957e8;
  const umbraHalf = ((AU_M + r) * sinAlpha - solarRadius) / (10 * AU_M * cosAlpha);
  const penumbraHalf = ((AU_M + r) * sinAlpha + solarRadius) / (10 * AU_M * cosAlpha);
  for (const [name, lighting, bounds] of [
    ["umbra", LIGHT.UMBRA, [[20 - umbraHalf, 20 + umbraHalf]]],
    ["penumbra", LIGHT.PENUMBRA, [[20 - penumbraHalf, 20 - umbraHalf], [20 + umbraHalf, 20 + penumbraHalf]]],
    ["sunlit", LIGHT.SUNLIT, [[0, 20 - penumbraHalf], [20 + penumbraHalf, 100]]],
  ]) {
    cases.push({
      id: `lighting-narrow-${name}`, formula: `finite disk tangent case: umbra half-duration=${umbraHalf}s, outer penumbra half-duration=${penumbraHalf}s; select ${name}`,
      edgeTolerance: 0.0002,
      fields: {
        GROUND_STATIONS: ground(), STATES: [0, 100].map((t) => state(t, [-r, 0, 0])),
        SUN_STATES: [0, 100].map((t) => state(t, [AU_M, 10 * AU_M * (t - 20), 0])),
        CONSTRAINTS: set(OP.ALL_OF, [constraint(K.TARGET_LIGHTING, `narrow-${name}`, { LIGHTING: lighting })]), ROOT_TOLERANCE_S: 0.0001,
      },
      labels: [`narrow-${name}`], windows: bounds.map(([start, end]) => ({ start, end, startIndex: start === 0 ? -1 : 0, endIndex: end === 100 ? -1 : 0, sampleCount: (start === 0 ? 1 : 0) + (end === 100 ? 1 : 0) })),
    });
  }
}

export const invalidCases = [
  ["missing-sun", { CONSTRAINTS: set(OP.ALL_OF, [constraint(K.SUN_EXCLUSION, "sun", { THRESHOLD_RAD: 0.1 })]) }],
  ["missing-moon", { CONSTRAINTS: set(OP.ALL_OF, [constraint(K.MOON_EXCLUSION, "moon", { THRESHOLD_RAD: 0.1 })]) }],
  ["missing-lighting-sun", { CONSTRAINTS: set(OP.ALL_OF, [constraint(K.TARGET_LIGHTING, "light", { LIGHTING: LIGHT.UMBRA })]) }],
  ["unknown-kind", { CONSTRAINTS: set(OP.ALL_OF, [constraint(127, "invalid")]) }],
  ["unknown-operator", { CONSTRAINTS: set(127, [constraint(K.MAX_RANGE, "range", { MAX_RANGE_M: 1000 })]) }],
  ["negative-range", { CONSTRAINTS: set(OP.ALL_OF, [constraint(K.MAX_RANGE, "range", { MAX_RANGE_M: -1 })]) }],
  ["invalid-root-tolerance", { ROOT_TOLERANCE_S: -1 }],
  ["unsorted-states", { STATES: rangeStates([100, 0]) }],
  ["nonfinite-state", { STATES: [state(0, [NaN, 0, 0]), relative(100, [1000, 0, 0])] }],
  ["short-observer-coverage", { GROUND_STATIONS: [], OBSERVERS: [observer("relay", [relative(25, [0, 0, 0]), relative(75, [0, 0, 0])])] }],
].map(([id, overrides]) => ({ id, fields: { GROUND_STATIONS: ground(), STATES: rangeStates([0, 100]), CONSTRAINTS: rangeBand(), ...overrides } }));

export const legacyCase = {
  id: "legacy-absent-constraints",
  // Original elevation-value interpolation: -pi/4,pi/4,-pi/4 at t=0,60,120.
  // Independent linear threshold crossings are t=30,90, even though the old
  // request's newly appended mode defaults to DISCRETE. This is intentional
  // absent-CONSTRAINTS compatibility, not the new discrete semantics.
  // Its 0.001 s edge tolerance covers JD quantisation; the 1e-12 rad maximum
  // elevation tolerance covers double-precision atan2 arithmetic at pi/4.
  fields: { GROUND_STATIONS: ground(), STATES: [relative(0, [-1000, 1000, 0]), relative(60, [1000, 1000, 0]), relative(120, [-1000, 1000, 0])], EVALUATION_MODE: MODE.DISCRETE },
  windows: [{ start: 30, end: 90 }],
};
