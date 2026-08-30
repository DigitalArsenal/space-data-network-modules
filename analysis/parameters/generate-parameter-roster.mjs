#!/usr/bin/env node
/**
 * Generate the parameter roster header from the VENDORED reference roster.
 *
 * The roster is not typed by hand. `fixtures/reference-parameter-roster.json`
 * carries every named calculation parameter of the reference mission-analysis
 * tool R2026a, extracted from its Apache-2.0 source
 * (`src/base/factory/ParameterFactory.cpp`) at the exact commit the parity
 * program names, with the file's SHA-256 recorded beside it. This script
 * classifies each of those names — owner class, unit, value kind, element
 * count, frame dependency, availability — and emits
 * `src/generated/parameter_roster.hpp` plus `src/generated/roster.json` for the
 * tests.
 *
 * WHY IT IS GENERATED. A hand-typed roster is a second vocabulary that drifts
 * from the source it claims parity with, and the drift is invisible: a
 * misspelled name simply never matches. Here an unclassified name is a BUILD
 * FAILURE naming the parameter, so refreshing the fixture to a later release
 * cannot silently drop or rename anything.
 *
 * The classification is the only judgement in this file, and every judgement is
 * one of the enums below — never free text.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  packageRoot,
  "fixtures",
  "reference-parameter-roster.json",
);
const generatedDir = path.join(packageRoot, "src", "generated");

// ---------------------------------------------------------------------------
// Vocabularies. These mirror the SDS record's enums exactly; the C++ enum and
// the JSON both come from here so the module and the wire cannot disagree.
// ---------------------------------------------------------------------------

const OWNER = {
  SPACE_OBJECT: 1,
  SPACE_POINT: 2,
  THRUSTER: 3,
  PROPELLANT_TANK: 4,
  IMPULSIVE_MANEUVER: 5,
  FINITE_MANEUVER: 6,
  POWER_SYSTEM: 7,
  SURFACE_PLATE: 8,
  HARDWARE_MOUNT: 9,
  USER_DEFINED: 10,
};

const KIND = {
  REAL: 1,
  REAL_ARRAY: 2,
  MATRIX: 3,
  EPOCH_TEXT: 4,
  IDENTIFIER_TEXT: 5,
  CONTAINER: 6,
};

const FRAME = {
  /// Frame-invariant: the same number in every coordinate system.
  NONE: 0,
  /// Needs the full coordinate system (axes AND origin).
  COORDINATE_SYSTEM: 1,
  /// Needs the central body only (its gravitational parameter).
  CENTRAL_BODY: 2,
  /// Needs the central body's body-fixed axes.
  BODY_FIXED: 3,
  /// Needs the Sun direction as well as the orbit plane.
  SUN_DIRECTION: 4,
  /// Needs the spacecraft body frame.
  BODY_FRAME: 5,
};

const AVAILABILITY = {
  IMPLEMENTED: 0,
  /// Value is a property the caller states; the module echoes what it is given
  /// and refuses when it is not given.
  CALLER_SUPPLIED: 1,
  REQUIRES_ATTITUDE_PROVIDER: 2,
  REQUIRES_HARDWARE_PROVIDER: 3,
  REQUIRES_POWER_PROVIDER: 4,
  REQUIRES_MASS_PROPERTY_PROVIDER: 5,
  REQUIRES_MANEUVER_PROVIDER: 6,
  REQUIRES_MEAN_ELEMENT_THEORY: 7,
  REQUIRES_ATMOSPHERE_PROVIDER: 8,
  REQUIRES_COVARIANCE_PROVIDER: 9,
  REQUIRES_STATE_TRANSITION_PROVIDER: 10,
  REQUIRES_ESTIMATION_PROVIDER: 11,
  NOT_A_CALCULATION_PARAMETER: 12,
};

const M = "m";
const MS = "m/s";
const RAD = "rad";
const NONE = "";

function entry(owner, unit, kind, elementCount, frame, availability) {
  return { owner, unit, kind, elementCount, frame, availability };
}

const real = (unit, frame, availability = AVAILABILITY.IMPLEMENTED, owner = OWNER.SPACE_OBJECT) =>
  entry(owner, unit, KIND.REAL, 1, frame, availability);

// ---------------------------------------------------------------------------
// The classification, by exact name. Groups first, exceptions after.
// ---------------------------------------------------------------------------

const CLASSIFICATION = new Map();

function put(names, value) {
  for (const name of names) {
    CLASSIFICATION.set(name, value);
  }
}

// -- containers -------------------------------------------------------------
put(["Variable", "String", "Array"],
  entry(OWNER.USER_DEFINED, NONE, KIND.CONTAINER, 0, FRAME.NONE,
    AVAILABILITY.NOT_A_CALCULATION_PARAMETER));

// Element-set aggregates: one name that returns the whole six-element set.
put([
  "Cartesian", "Keplerian", "ModKeplerian", "SphericalRADEC", "SphericalAZFPA",
  "Equinoctial", "ModEquinoctial", "Delaunay", "Planetodetic",
  "IncomingAsymptote", "OutgoingAsymptote", "BrouwerMeanShort", "BrouwerMeanLong",
], entry(OWNER.SPACE_OBJECT, NONE, KIND.REAL_ARRAY, 6, FRAME.COORDINATE_SYSTEM,
  AVAILABILITY.IMPLEMENTED));
// The two mean-element aggregates need the mean-element theory, like their members.
put(["BrouwerMeanShort", "BrouwerMeanLong"],
  entry(OWNER.SPACE_OBJECT, NONE, KIND.REAL_ARRAY, 6, FRAME.COORDINATE_SYSTEM,
    AVAILABILITY.REQUIRES_MEAN_ELEMENT_THEORY));

// -- time -------------------------------------------------------------------
put(["A1ModJulian", "TAIModJulian", "TTModJulian", "TDBModJulian", "UTCModJulian"],
  real("d", FRAME.NONE));
put(["A1Gregorian", "TAIGregorian", "TTGregorian", "TDBGregorian", "UTCGregorian"],
  entry(OWNER.SPACE_OBJECT, NONE, KIND.EPOCH_TEXT, 1, FRAME.NONE, AVAILABILITY.IMPLEMENTED));
put(["ElapsedDays"], real("d", FRAME.NONE));
put(["ElapsedSecs"], real("s", FRAME.NONE));
put(["CurrA1MJD"], real("d", FRAME.NONE));

// -- Cartesian --------------------------------------------------------------
put(["X", "Y", "Z"], real(M, FRAME.COORDINATE_SYSTEM));
put(["VX", "VY", "VZ"], real(MS, FRAME.COORDINATE_SYSTEM));

// -- Keplerian --------------------------------------------------------------
put(["SMA", "RadApo", "RadPer"], real(M, FRAME.COORDINATE_SYSTEM));
put(["ECC"], real(NONE, FRAME.COORDINATE_SYSTEM));
put(["INC", "RAAN", "RADN", "AOP", "TA", "MA", "EA", "HA"],
  real(RAD, FRAME.COORDINATE_SYSTEM));
put(["MM"], real("rad/s", FRAME.CENTRAL_BODY));

// -- spherical --------------------------------------------------------------
put(["RMAG"], real(M, FRAME.COORDINATE_SYSTEM));
put(["VMAG"], real(MS, FRAME.COORDINATE_SYSTEM));
put(["RA", "DEC", "RAV", "DECV", "AZI", "FPA"], real(RAD, FRAME.COORDINATE_SYSTEM));
put(["Altitude"], real(M, FRAME.BODY_FIXED));

// -- equinoctial families ---------------------------------------------------
put(["EquinoctialH", "EquinoctialK", "EquinoctialP", "EquinoctialQ",
  "ModEquinoctialF", "ModEquinoctialG", "ModEquinoctialH", "ModEquinoctialK",
  "AltEquinoctialP", "AltEquinoctialQ"],
  real(NONE, FRAME.COORDINATE_SYSTEM));
put(["MLONG", "TLONG"], real(RAD, FRAME.COORDINATE_SYSTEM));
put(["SemilatusRectum"], real(M, FRAME.COORDINATE_SYSTEM));

// Equinoctial RATES. These are time derivatives of the element set under the
// osculating dynamics, which is the force model's business, not this module's.
put(["SMADot"], real("m/s", FRAME.COORDINATE_SYSTEM, AVAILABILITY.REQUIRES_STATE_TRANSITION_PROVIDER));
put(["EquinoctialHDot", "EquinoctialKDot", "EquinoctialPDot", "EquinoctialQDot"],
  real("1/s", FRAME.COORDINATE_SYSTEM, AVAILABILITY.REQUIRES_STATE_TRANSITION_PROVIDER));
put(["TLONGDot"], real("rad/s", FRAME.COORDINATE_SYSTEM, AVAILABILITY.REQUIRES_STATE_TRANSITION_PROVIDER));

// -- Delaunay ---------------------------------------------------------------
put(["Delaunayl", "Delaunayg", "Delaunayh"], real(RAD, FRAME.COORDINATE_SYSTEM));
put(["DelaunayL", "DelaunayG", "DelaunayH"], real("m^2/s", FRAME.COORDINATE_SYSTEM));

// -- planetodetic -----------------------------------------------------------
put(["PlanetodeticRMAG"], real(M, FRAME.BODY_FIXED));
put(["PlanetodeticVMAG"], real(MS, FRAME.BODY_FIXED));
put(["PlanetodeticLON", "PlanetodeticLAT", "PlanetodeticAZI", "PlanetodeticHFPA"],
  real(RAD, FRAME.BODY_FIXED));

// -- asymptote (B-plane) sets ----------------------------------------------
put(["IncomingRadPer", "OutgoingRadPer"], real(M, FRAME.COORDINATE_SYSTEM));
put(["IncomingC3Energy", "OutgoingC3Energy"], real("m^2/s^2", FRAME.COORDINATE_SYSTEM));
put(["IncomingRHA", "IncomingDHA", "IncomingBVAZI",
  "OutgoingRHA", "OutgoingDHA", "OutgoingBVAZI"],
  real(RAD, FRAME.COORDINATE_SYSTEM));

// -- Brouwer mean elements --------------------------------------------------
put(["BrouwerShortSMA", "BrouwerLongSMA"],
  real(M, FRAME.COORDINATE_SYSTEM, AVAILABILITY.REQUIRES_MEAN_ELEMENT_THEORY));
put(["BrouwerShortECC", "BrouwerLongECC"],
  real(NONE, FRAME.COORDINATE_SYSTEM, AVAILABILITY.REQUIRES_MEAN_ELEMENT_THEORY));
put(["BrouwerShortINC", "BrouwerShortRAAN", "BrouwerShortAOP", "BrouwerShortMA",
  "BrouwerLongINC", "BrouwerLongRAAN", "BrouwerLongAOP", "BrouwerLongMA"],
  real(RAD, FRAME.COORDINATE_SYSTEM, AVAILABILITY.REQUIRES_MEAN_ELEMENT_THEORY));

// -- orbital scalars --------------------------------------------------------
put(["VelApoapsis", "VelPeriapsis"], real(MS, FRAME.CENTRAL_BODY));
put(["OrbitPeriod"], real("s", FRAME.CENTRAL_BODY));
put(["C3Energy", "Energy"], real("m^2/s^2", FRAME.CENTRAL_BODY));
// Apoapsis and Periapsis are the STOPPING-CONDITION functions: r . v, whose
// zero with the right slope IS the apsis. They are dimensionless-signed
// quantities in metres squared per second, and the event locator refines them.
put(["Apoapsis", "Periapsis"], real("m^2/s", FRAME.COORDINATE_SYSTEM));

// -- angular momentum -------------------------------------------------------
put(["HMAG", "HX", "HY", "HZ"], real("m^2/s", FRAME.COORDINATE_SYSTEM));

// -- asymptote declination / right ascension --------------------------------
put(["DLA", "RLA"], real(RAD, FRAME.COORDINATE_SYSTEM));

// -- environment ------------------------------------------------------------
put(["AtmosDensity"],
  real("kg/m^3", FRAME.BODY_FIXED, AVAILABILITY.REQUIRES_ATMOSPHERE_PROVIDER));

// -- planet-relative --------------------------------------------------------
put(["MHA", "Longitude", "Latitude", "LST"], real(RAD, FRAME.BODY_FIXED));
put(["BetaAngle"], real(RAD, FRAME.SUN_DIRECTION));

// -- B-plane ----------------------------------------------------------------
put(["BdotT", "BdotR", "BVectorMag"], real(M, FRAME.COORDINATE_SYSTEM));
put(["BVectorAngle"], real(RAD, FRAME.COORDINATE_SYSTEM));

// -- burns ------------------------------------------------------------------
put(["Element1", "Element2", "Element3", "V", "N", "B"],
  real(MS, FRAME.COORDINATE_SYSTEM, AVAILABILITY.REQUIRES_MANEUVER_PROVIDER,
    OWNER.IMPULSIVE_MANEUVER));
put(["TotalMassFlowRate"],
  real("kg/s", FRAME.NONE, AVAILABILITY.REQUIRES_MANEUVER_PROVIDER, OWNER.FINITE_MANEUVER));
put(["TotalAcceleration1", "TotalAcceleration2", "TotalAcceleration3"],
  real("m/s^2", FRAME.COORDINATE_SYSTEM, AVAILABILITY.REQUIRES_MANEUVER_PROVIDER,
    OWNER.FINITE_MANEUVER));
put(["TotalThrust1", "TotalThrust2", "TotalThrust3"],
  real("N", FRAME.COORDINATE_SYSTEM, AVAILABILITY.REQUIRES_MANEUVER_PROVIDER,
    OWNER.FINITE_MANEUVER));

// -- attitude ---------------------------------------------------------------
const ATTITUDE = (unit, kind = KIND.REAL, count = 1) =>
  entry(OWNER.SPACE_OBJECT, unit, kind, count, FRAME.BODY_FRAME,
    AVAILABILITY.REQUIRES_ATTITUDE_PROVIDER);
put(["DCM11", "DCM12", "DCM13", "DCM21", "DCM22", "DCM23", "DCM31", "DCM32", "DCM33"],
  ATTITUDE(NONE));
put(["DirectionCosineMatrix"], ATTITUDE(NONE, KIND.MATRIX, 9));
put(["EulerAngle1", "EulerAngle2", "EulerAngle3"], ATTITUDE(RAD));
put(["EulerAngleRate1", "EulerAngleRate2", "EulerAngleRate3"], ATTITUDE("rad/s"));
put(["MRP1", "MRP2", "MRP3"], ATTITUDE(NONE));
put(["Q1", "Q2", "Q3", "Q4"], ATTITUDE(NONE));
put(["Quaternion"], ATTITUDE(NONE, KIND.REAL_ARRAY, 4));
put(["AngularVelocityX", "AngularVelocityY", "AngularVelocityZ"], ATTITUDE("rad/s"));
put(["BodyAlignmentVectorX", "BodyAlignmentVectorY", "BodyAlignmentVectorZ",
  "BodyConstraintVectorX", "BodyConstraintVectorY", "BodyConstraintVectorZ"],
  ATTITUDE(NONE));
put(["Attitude"], ATTITUDE(NONE, KIND.REAL_ARRAY, 6));
put(["AttitudeReferenceBody", "AttitudeConstraintType"],
  entry(OWNER.SPACE_OBJECT, NONE, KIND.IDENTIFIER_TEXT, 1, FRAME.BODY_FRAME,
    AVAILABILITY.REQUIRES_ATTITUDE_PROVIDER));

// -- ballistic and mass properties -----------------------------------------
put(["DryMass", "TotalMass"], real("kg", FRAME.NONE, AVAILABILITY.CALLER_SUPPLIED));
put(["Cd", "Cr"], real(NONE, FRAME.NONE, AVAILABILITY.CALLER_SUPPLIED));
put(["DragArea", "SRPArea"], real("m^2", FRAME.NONE, AVAILABILITY.CALLER_SUPPLIED));
put(["SPADDragScaleFactor", "SPADSRPScaleFactor", "AtmosDensityScaleFactor"],
  real(NONE, FRAME.NONE, AVAILABILITY.CALLER_SUPPLIED));
put(["CdSigma", "CrSigma", "SPADDragScaleFactorSigma", "SPADSRPScaleFactorSigma",
  "AtmosDensityScaleFactorSigma"],
  real(NONE, FRAME.NONE, AVAILABILITY.REQUIRES_ESTIMATION_PROVIDER));

const MASS_PROPERTY = (unit) =>
  real(unit, FRAME.BODY_FRAME, AVAILABILITY.REQUIRES_MASS_PROPERTY_PROVIDER);
put(["DryCenterOfMassX", "DryCenterOfMassY", "DryCenterOfMassZ",
  "SystemCenterOfMassX", "SystemCenterOfMassY", "SystemCenterOfMassZ"],
  MASS_PROPERTY(M));
put(["DryMomentOfInertiaXX", "DryMomentOfInertiaXY", "DryMomentOfInertiaXZ",
  "DryMomentOfInertiaYY", "DryMomentOfInertiaYZ", "DryMomentOfInertiaZZ",
  "SystemMomentOfInertiaXX", "SystemMomentOfInertiaXY", "SystemMomentOfInertiaXZ",
  "SystemMomentOfInertiaYY", "SystemMomentOfInertiaYZ", "SystemMomentOfInertiaZZ"],
  MASS_PROPERTY("kg m^2"));

// -- state transition matrix ------------------------------------------------
put(["OrbitSTM"],
  entry(OWNER.SPACE_OBJECT, NONE, KIND.MATRIX, 36, FRAME.COORDINATE_SYSTEM,
    AVAILABILITY.IMPLEMENTED));
put(["OrbitSTMA", "OrbitSTMB", "OrbitSTMC", "OrbitSTMD"],
  entry(OWNER.SPACE_OBJECT, NONE, KIND.MATRIX, 9, FRAME.COORDINATE_SYSTEM,
    AVAILABILITY.IMPLEMENTED));
put(["OrbitErrorCovariance"],
  entry(OWNER.SPACE_OBJECT, NONE, KIND.MATRIX, 36, FRAME.COORDINATE_SYSTEM,
    AVAILABILITY.REQUIRES_COVARIANCE_PROVIDER));

// -- propellant tank --------------------------------------------------------
const TANK = (unit, availability = AVAILABILITY.REQUIRES_HARDWARE_PROVIDER) =>
  entry(OWNER.PROPELLANT_TANK, unit, KIND.REAL, 1, FRAME.NONE, availability);
put(["FuelMass"], TANK("kg"));
put(["Pressure"], TANK("Pa"));
put(["Temperature", "RefTemperature"], TANK("K"));
put(["Volume"], TANK("m^3"));
put(["FuelDensity"], TANK("kg/m^3"));
put(["FuelCenterOfMassX", "FuelCenterOfMassY", "FuelCenterOfMassZ",
  "FuelCenterOfMassX_BCS", "FuelCenterOfMassY_BCS", "FuelCenterOfMassZ_BCS"],
  entry(OWNER.PROPELLANT_TANK, M, KIND.REAL, 1, FRAME.BODY_FRAME,
    AVAILABILITY.REQUIRES_MASS_PROPERTY_PROVIDER));
put(["FuelMomentOfInertiaXX", "FuelMomentOfInertiaXY", "FuelMomentOfInertiaXZ",
  "FuelMomentOfInertiaYY", "FuelMomentOfInertiaYZ", "FuelMomentOfInertiaZZ",
  "FuelMomentOfInertiaXX_BCS", "FuelMomentOfInertiaXY_BCS", "FuelMomentOfInertiaXZ_BCS",
  "FuelMomentOfInertiaYY_BCS", "FuelMomentOfInertiaYZ_BCS", "FuelMomentOfInertiaZZ_BCS"],
  entry(OWNER.PROPELLANT_TANK, "kg m^2", KIND.REAL, 1, FRAME.BODY_FRAME,
    AVAILABILITY.REQUIRES_MASS_PROPERTY_PROVIDER));

// -- hardware mount ---------------------------------------------------------
put(["R_SB11", "R_SB12", "R_SB13", "R_SB21", "R_SB22", "R_SB23",
  "R_SB31", "R_SB32", "R_SB33"],
  entry(OWNER.HARDWARE_MOUNT, NONE, KIND.REAL, 1, FRAME.BODY_FRAME,
    AVAILABILITY.REQUIRES_HARDWARE_PROVIDER));

// -- thruster ---------------------------------------------------------------
const THRUSTER = (unit) =>
  entry(OWNER.THRUSTER, unit, KIND.REAL, 1, FRAME.NONE,
    AVAILABILITY.REQUIRES_HARDWARE_PROVIDER);
put(["DutyCycle", "ThrustScaleFactor"], THRUSTER(NONE));
put(["GravitationalAccel"], THRUSTER("m/s^2"));
put(["ThrustMagnitude"], THRUSTER("N"));
put(["Isp"], THRUSTER("s"));
put(["MassFlowRate"], THRUSTER("kg/s"));
put(Array.from({ length: 16 }, (_, i) => `C${i + 1}`), THRUSTER(NONE));
put(Array.from({ length: 16 }, (_, i) => `K${i + 1}`), THRUSTER(NONE));
put(["ThrustDirection1", "ThrustDirection2", "ThrustDirection3"],
  entry(OWNER.THRUSTER, NONE, KIND.REAL, 1, FRAME.BODY_FRAME,
    AVAILABILITY.REQUIRES_HARDWARE_PROVIDER));
put(["OrbitTime"], THRUSTER("s"));

// -- power system -----------------------------------------------------------
put(["TotalPowerAvailable", "RequiredBusPower", "ThrustPowerAvailable"],
  entry(OWNER.POWER_SYSTEM, "W", KIND.REAL, 1, FRAME.NONE,
    AVAILABILITY.REQUIRES_POWER_PROVIDER));

// -- surface plates ---------------------------------------------------------
const PLATE = (unit, kind = KIND.REAL, count = 1, frame = FRAME.BODY_FRAME) =>
  entry(OWNER.SURFACE_PLATE, unit, kind, count, frame,
    AVAILABILITY.REQUIRES_HARDWARE_PROVIDER);
put(["AreaCoefficient", "SpecularFraction", "DiffuseFraction", "LitFraction",
  "AreaCoefficientSigma", "SpecularFractionSigma", "DiffuseFractionSigma"],
  PLATE(NONE, KIND.REAL, 1, FRAME.NONE));
put(["Area"], PLATE("m^2", KIND.REAL, 1, FRAME.NONE));
put(["PlateNormal"], PLATE(NONE, KIND.REAL_ARRAY, 3));
put(["PlateX", "PlateY", "PlateZ"], PLATE(NONE));
put(["PlateNormalHistoryFile"],
  entry(OWNER.SURFACE_PLATE, NONE, KIND.IDENTIFIER_TEXT, 1, FRAME.NONE,
    AVAILABILITY.REQUIRES_HARDWARE_PROVIDER));

// ---------------------------------------------------------------------------
// Our own additions. Every one of these is a parameter the reference tool does
// not name, and each carries the reason it exists. They are appended AFTER the
// reference roster so the reference numbering is stable.
// ---------------------------------------------------------------------------

export const LOCAL_ADDITIONS = [
  {
    name: "MHA_IAU1982",
    ...real(RAD, FRAME.BODY_FIXED),
    rationale:
      "Greenwich hour angle over the explicitly named legacy IAU-1982 sidereal series, kept as its own name so the legacy route has vectors of its own instead of being a silent second answer (the same rule that named MOD_FK5/TOD_FK5).",
  },
  {
    name: "LST_IAU1982",
    ...real(RAD, FRAME.BODY_FIXED),
    rationale: "Local sidereal time over the same explicitly named legacy series.",
  },
  {
    name: "BdotTOutgoing",
    ...real(M, FRAME.COORDINATE_SYSTEM),
    rationale:
      "The B-plane T component taken on the OUTGOING asymptote. BdotT/BdotR are defined on the incoming asymptote (arrival geometry); a departure analysis needs the same two numbers on the departure asymptote and must not silently reuse the arrival ones.",
  },
  {
    name: "BdotROutgoing",
    ...real(M, FRAME.COORDINATE_SYSTEM),
    rationale: "The B-plane R component on the outgoing asymptote.",
  },
  {
    name: "BVectorMagOutgoing",
    ...real(M, FRAME.COORDINATE_SYSTEM),
    rationale: "The B vector magnitude on the outgoing asymptote.",
  },
  {
    name: "BVectorAngleOutgoing",
    ...real(RAD, FRAME.COORDINATE_SYSTEM),
    rationale: "The B vector angle on the outgoing asymptote.",
  },
  {
    name: "RLAIncoming",
    ...real(RAD, FRAME.COORDINATE_SYSTEM),
    rationale:
      "Right ascension of the INCOMING asymptote. DLA/RLA are the departure (outgoing) asymptote's declination and right ascension; an arrival analysis needs the incoming pair by name.",
  },
  {
    name: "DLAIncoming",
    ...real(RAD, FRAME.COORDINATE_SYSTEM),
    rationale: "Declination of the incoming asymptote.",
  },
  {
    name: "GeocentricLatitude",
    ...real(RAD, FRAME.BODY_FIXED),
    rationale:
      "Latitude measured from the body centre rather than from the ellipsoid normal. Latitude is geodetic; the two differ by up to 0.19 deg on Earth and a consumer that wants one must be able to ask for it by name.",
  },
  {
    name: "RadialVelocity",
    ...real(MS, FRAME.COORDINATE_SYSTEM),
    rationale:
      "Component of velocity along the position unit vector. Its zero IS the apsis condition, and a stopping condition needs it as a NAMED parameter with a goal of zero rather than as a locator with a hidden formula.",
  },
  {
    name: "HorizontalFlightPathAngle",
    ...real(RAD, FRAME.COORDINATE_SYSTEM),
    rationale:
      "Flight path angle measured from the local HORIZONTAL rather than from the radius vector. The two differ by a right angle and both are in use; a consumer must be able to ask for the one it means.",
  },
  {
    name: "AltitudeOfPeriapsis",
    ...real(M, FRAME.BODY_FIXED),
    rationale:
      "Periapsis radius minus the body's equatorial radius. Distinguished from RadPer so a mission constraint stated as an altitude is not silently compared against a radius.",
  },
  {
    name: "AltitudeOfApoapsis",
    ...real(M, FRAME.BODY_FIXED),
    rationale: "Apoapsis radius minus the body's equatorial radius.",
  },
  {
    name: "ArgumentOfLatitude",
    ...real(RAD, FRAME.COORDINATE_SYSTEM),
    rationale:
      "Argument of periapsis plus true anomaly: the angle from the ascending node, which stays well defined as the eccentricity goes to zero and the argument of periapsis does not.",
  },
  {
    name: "EccentricityVectorX",
    ...real(NONE, FRAME.COORDINATE_SYSTEM),
    rationale:
      "Component of the eccentricity vector. The magnitude alone loses the periapsis direction, which is what a targeting goal on the apsidal line needs.",
  },
  {
    name: "EccentricityVectorY",
    ...real(NONE, FRAME.COORDINATE_SYSTEM),
    rationale: "Component of the eccentricity vector.",
  },
  {
    name: "EccentricityVectorZ",
    ...real(NONE, FRAME.COORDINATE_SYSTEM),
    rationale: "Component of the eccentricity vector.",
  },
  {
    name: "SemiMinorAxis",
    ...real(M, FRAME.COORDINATE_SYSTEM),
    rationale:
      "Semi-minor axis; for a hyperbolic orbit it is the impact parameter that the B-vector magnitude equals, so the two can be cross-checked against each other.",
  },
  {
    name: "HyperbolicExcessVelocity",
    ...real(MS, FRAME.CENTRAL_BODY),
    rationale:
      "Speed at infinity on an escape trajectory, the square root of the characteristic energy. Named because a launch or arrival requirement is stated in speed, not in energy.",
  },
  {
    name: "BallisticCoefficient",
    ...real("kg/m^2", FRAME.NONE, AVAILABILITY.CALLER_SUPPLIED),
    rationale:
      "Mass divided by the product of drag coefficient and drag area. Derived from stated properties rather than stated itself, so it cannot disagree with them.",
  },
  {
    name: "AreaToMassRatio",
    ...real("m^2/kg", FRAME.NONE, AVAILABILITY.CALLER_SUPPLIED),
    rationale:
      "Solar-radiation-pressure area divided by mass, the quantity a radiation-pressure model is parameterised by.",
  },
  {
    name: "UT1ModJulian",
    ...real("d", FRAME.NONE),
    rationale:
      "Universal time as a Modified Julian Date. UT1 is the scale the Earth's rotation is measured in, so an analysis that reasons about hour angles needs the epoch in it.",
  },
  {
    name: "UT1Gregorian",
    ...entry(OWNER.SPACE_OBJECT, NONE, KIND.EPOCH_TEXT, 1, FRAME.NONE, AVAILABILITY.IMPLEMENTED),
    rationale: "Universal time as a calendar instant.",
  },
  {
    name: "GeocentricAltitude",
    ...real(M, FRAME.COORDINATE_SYSTEM),
    rationale:
      "Radius minus the body's equatorial radius. This is the quantity apsis detection is defined on: geodetic height over an oblate body varies about 21 km with latitude, which swamps the radial signal of a near-circular orbit and puts apoapsis and periapsis about 90 deg apart in true anomaly.",
  },
];

// ---------------------------------------------------------------------------

const REVERSE = (object) =>
  Object.fromEntries(Object.entries(object).map(([name, value]) => [value, name]));

/// The C++ enum member IS the parameter name, character for character, with
/// anything that cannot appear in an identifier replaced. Deliberately NOT
/// upper-cased: the roster carries `Delaunayl` and `DelaunayL` as different
/// parameters (the angle and its conjugate momentum), and upper-casing collides
/// them into one member — a silent aliasing of two different quantities. Keeping
/// the exact name also means the module and the wire never grow a second
/// spelling of the same parameter.
function identifier(name) {
  return name.replace(/[^A-Za-z0-9]/g, "_");
}

export function buildRoster() {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const unclassified = [];
  const rows = [];
  let id = 1;
  for (const { name, section } of fixture.parameters) {
    const classification = CLASSIFICATION.get(name);
    if (!classification) {
      unclassified.push(name);
      continue;
    }
    rows.push({ id: id++, name, section, origin: "reference", ...classification });
  }
  if (unclassified.length > 0) {
    throw new Error(
      `parameter roster: ${unclassified.length} name(s) in the vendored reference roster are not classified: ${unclassified.join(", ")}`,
    );
  }
  const known = new Set(rows.map((row) => row.name));
  for (const addition of LOCAL_ADDITIONS) {
    if (known.has(addition.name)) {
      throw new Error(`local addition ${addition.name} collides with the reference roster`);
    }
    rows.push({ id: id++, section: "Local addition", origin: "local", ...addition });
  }
  return { fixture, rows };
}

function emitHeader(fixture, rows) {
  const ownerName = REVERSE(OWNER);
  const kindName = REVERSE(KIND);
  const frameName = REVERSE(FRAME);
  const availabilityName = REVERSE(AVAILABILITY);

  const lines = [];
  lines.push("// GENERATED FILE — DO NOT EDIT.");
  lines.push("//");
  lines.push("// Source of truth : fixtures/reference-parameter-roster.json");
  lines.push("// Generator       : generate-parameter-roster.mjs");
  lines.push(`// Reference roster: ${fixture.source.file} @ ${fixture.source.commit}`);
  lines.push(`// Reference sha256: ${fixture.source.sha256}`);
  lines.push("//");
  lines.push("// Edit the classification in the generator and regenerate. A hand edit here");
  lines.push("// is erased by the next run and failed by the drift gate in between.");
  lines.push("");
  lines.push("#ifndef SDN_ANALYSIS_PARAMETERS_ROSTER_HPP");
  lines.push("#define SDN_ANALYSIS_PARAMETERS_ROSTER_HPP");
  lines.push("");
  lines.push("#include <cstdint>");
  lines.push("");
  lines.push("namespace sdn {");
  lines.push("namespace parameters {");
  lines.push("");

  const emitEnum = (name, table, doc, zeroMember = "UNSPECIFIED") => {
    lines.push(`/// ${doc}`);
    lines.push(`enum class ${name} : uint8_t {`);
    lines.push(`  ${zeroMember} = 0,`);
    for (const [member, value] of Object.entries(table)) {
      if (value === 0) continue;
      lines.push(`  ${member} = ${value},`);
    }
    lines.push("};");
    lines.push("");
  };
  emitEnum("OwnerClass", OWNER, "What kind of object owns the parameter.");
  emitEnum("ValueKind", KIND, "The shape of the value the parameter evaluates to.");
  // IMPLEMENTED is the ZERO of this vocabulary, not a member beside an
  // UNSPECIFIED: a descriptor that says nothing about availability is one this
  // module answers, and there is no third "we do not know" state.
  emitEnum("Availability", AVAILABILITY,
    "Whether this module evaluates the parameter, and if not, which provider family it waits on.",
    "IMPLEMENTED");

  lines.push("/// What the parameter needs to be resolvable.");
  lines.push("enum class FrameDependency : uint8_t {");
  for (const [member, value] of Object.entries(FRAME)) {
    lines.push(`  ${member} = ${value},`);
  }
  lines.push("};");
  lines.push("");

  lines.push("/// Every named parameter, in roster order. The value IS the wire id.");
  lines.push("enum class ParameterId : uint16_t {");
  lines.push("  UNSPECIFIED = 0,");
  for (const row of rows) {
    lines.push(`  ${identifier(row.name)} = ${row.id},`);
  }
  lines.push("};");
  lines.push("");
  lines.push("struct Descriptor {");
  lines.push("  ParameterId id;");
  lines.push("  const char* name;");
  lines.push("  OwnerClass owner;");
  lines.push("  const char* unit;");
  lines.push("  ValueKind kind;");
  lines.push("  uint8_t elementCount;");
  lines.push("  FrameDependency frame;");
  lines.push("  Availability availability;");
  lines.push("};");
  lines.push("");
  lines.push(`constexpr int kCatalogSize = ${rows.length};`);
  lines.push("");
  lines.push("inline const Descriptor kCatalog[kCatalogSize] = {");
  for (const row of rows) {
    lines.push(
      `    {ParameterId::${identifier(row.name)}, "${row.name}", OwnerClass::${ownerName[row.owner]}, ` +
      `"${row.unit}", ValueKind::${kindName[row.kind]}, ${row.elementCount}, ` +
      `FrameDependency::${frameName[row.frame]}, Availability::${row.availability === 0 ? "IMPLEMENTED" : availabilityName[row.availability]}},`,
    );
  }
  lines.push("};");
  lines.push("");
  lines.push("/// Look a parameter up by its exact name. Returns nullptr when the name is");
  lines.push("/// not in the roster — an unknown name is refused, never guessed at.");
  lines.push("inline const Descriptor* findByName(const char* name) {");
  lines.push("  if (name == nullptr) return nullptr;");
  lines.push("  for (int i = 0; i < kCatalogSize; ++i) {");
  lines.push("    const char* a = kCatalog[i].name;");
  lines.push("    const char* b = name;");
  lines.push("    while (*a != '\\0' && *a == *b) { ++a; ++b; }");
  lines.push("    if (*a == '\\0' && *b == '\\0') return &kCatalog[i];");
  lines.push("  }");
  lines.push("  return nullptr;");
  lines.push("}");
  lines.push("");
  lines.push("inline const Descriptor* findById(ParameterId id) {");
  lines.push("  for (int i = 0; i < kCatalogSize; ++i) {");
  lines.push("    if (kCatalog[i].id == id) return &kCatalog[i];");
  lines.push("  }");
  lines.push("  return nullptr;");
  lines.push("}");
  lines.push("");
  lines.push("}  // namespace parameters");
  lines.push("}  // namespace sdn");
  lines.push("");
  lines.push("#endif  // SDN_ANALYSIS_PARAMETERS_ROSTER_HPP");
  return `${lines.join("\n")}\n`;
}

export function generateParameterRoster() {
  const { fixture, rows } = buildRoster();
  fs.mkdirSync(generatedDir, { recursive: true });
  const header = emitHeader(fixture, rows);
  fs.writeFileSync(path.join(generatedDir, "parameter_roster.hpp"), header);
  const json = {
    generatedFrom: {
      file: fixture.source.file,
      commit: fixture.source.commit,
      sha256: fixture.source.sha256,
    },
    vocabularies: { OWNER, KIND, FRAME, AVAILABILITY },
    count: rows.length,
    referenceCount: rows.filter((row) => row.origin === "reference").length,
    localCount: rows.filter((row) => row.origin === "local").length,
    parameters: rows,
  };
  fs.writeFileSync(
    path.join(generatedDir, "roster.json"),
    `${JSON.stringify(json, null, 2)}\n`,
  );
  return json;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = generateParameterRoster();
  console.log(
    `Generated parameter roster: ${result.count} parameters ` +
    `(${result.referenceCount} from the reference source, ${result.localCount} local additions)`,
  );
}
