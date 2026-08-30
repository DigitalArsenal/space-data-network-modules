#!/usr/bin/env node
/**
 * Crosswalk the published `pceParameter` vocabulary to this module's roster.
 *
 * Two vocabularies exist and both are right. The standard names parameters in
 * capability language (`RADIAL_VELOCITY`, `RIGHT_ASCENSION_OF_ASCENDING_NODE`)
 * because a record must read the same to every implementer; the reference
 * mission-analysis tool names them in the domain's shorthand (`RAAN`, `BdotT`)
 * because that is what an analyst types. A module that consumes the record and
 * claims parity with the tool has to hold both, and the ONE place it holds them
 * is here.
 *
 * TOTALITY IS THE POINT. This script reads `pceParameter` out of the PUBLISHED
 * package's schema and requires that every member is either mapped to a roster
 * entry or listed as deliberately unmapped WITH A REASON. A member that is
 * neither is a build failure naming it, so a later SDS release cannot add a
 * parameter this module silently ignores.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = path.join(packageRoot, "src", "generated");
const schemaPath = path.join(
  packageRoot,
  "node_modules",
  "spacedatastandards.org",
  "schema",
  "PCE",
  "main.fbs",
);

/// SDS member -> roster parameter name.
const MAPPED = {
  POSITION_X: "X",
  POSITION_Y: "Y",
  POSITION_Z: "Z",
  VELOCITY_X: "VX",
  VELOCITY_Y: "VY",
  VELOCITY_Z: "VZ",
  POSITION_MAGNITUDE: "RMAG",
  VELOCITY_MAGNITUDE: "VMAG",
  RIGHT_ASCENSION: "RA",
  DECLINATION: "DEC",
  VELOCITY_RIGHT_ASCENSION: "RAV",
  VELOCITY_DECLINATION: "DECV",
  FLIGHT_PATH_ANGLE: "FPA",
  AZIMUTH_ANGLE: "AZI",
  HORIZONTAL_FLIGHT_PATH_ANGLE: "HorizontalFlightPathAngle",
  RADIAL_VELOCITY: "RadialVelocity",
  ANGULAR_MOMENTUM_MAGNITUDE: "HMAG",
  ANGULAR_MOMENTUM_X: "HX",
  ANGULAR_MOMENTUM_Y: "HY",
  ANGULAR_MOMENTUM_Z: "HZ",

  SEMI_MAJOR_AXIS: "SMA",
  ECCENTRICITY: "ECC",
  INCLINATION: "INC",
  RIGHT_ASCENSION_OF_ASCENDING_NODE: "RAAN",
  ARGUMENT_OF_PERIAPSIS: "AOP",
  TRUE_ANOMALY: "TA",
  MEAN_ANOMALY: "MA",
  ECCENTRIC_ANOMALY: "EA",
  HYPERBOLIC_ANOMALY: "HA",
  RADIUS_OF_PERIAPSIS: "RadPer",
  RADIUS_OF_APOAPSIS: "RadApo",
  ALTITUDE_OF_PERIAPSIS: "AltitudeOfPeriapsis",
  ALTITUDE_OF_APOAPSIS: "AltitudeOfApoapsis",
  SEMILATUS_RECTUM: "SemilatusRectum",
  ORBIT_PERIOD: "OrbitPeriod",
  MEAN_MOTION: "MM",
  SPECIFIC_ORBITAL_ENERGY: "Energy",
  CHARACTERISTIC_ENERGY: "C3Energy",
  VELOCITY_AT_PERIAPSIS: "VelPeriapsis",
  VELOCITY_AT_APOAPSIS: "VelApoapsis",
  ARGUMENT_OF_LATITUDE: "ArgumentOfLatitude",
  TRUE_LONGITUDE: "TLONG",
  MEAN_LONGITUDE: "MLONG",
  BETA_ANGLE: "BetaAngle",
  ECCENTRICITY_VECTOR_X: "EccentricityVectorX",
  ECCENTRICITY_VECTOR_Y: "EccentricityVectorY",
  ECCENTRICITY_VECTOR_Z: "EccentricityVectorZ",
  SEMI_MINOR_AXIS: "SemiMinorAxis",

  EQUINOCTIAL_H: "EquinoctialH",
  EQUINOCTIAL_K: "EquinoctialK",
  EQUINOCTIAL_P: "EquinoctialP",
  EQUINOCTIAL_Q: "EquinoctialQ",
  EQUINOCTIAL_MEAN_LONGITUDE: "MLONG",
  MODIFIED_EQUINOCTIAL_F: "ModEquinoctialF",
  MODIFIED_EQUINOCTIAL_G: "ModEquinoctialG",
  MODIFIED_EQUINOCTIAL_H: "ModEquinoctialH",
  MODIFIED_EQUINOCTIAL_K: "ModEquinoctialK",
  MODIFIED_EQUINOCTIAL_TRUE_LONGITUDE: "TLONG",
  MODIFIED_EQUINOCTIAL_SEMILATUS_RECTUM: "SemilatusRectum",
  ALTERNATE_EQUINOCTIAL_P: "AltEquinoctialP",
  ALTERNATE_EQUINOCTIAL_Q: "AltEquinoctialQ",
  ALTERNATE_EQUINOCTIAL_MEAN_MOTION: "MM",

  DELAUNAY_MEAN_ANOMALY: "Delaunayl",
  DELAUNAY_ARGUMENT_OF_PERIAPSIS: "Delaunayg",
  DELAUNAY_ASCENDING_NODE: "Delaunayh",
  DELAUNAY_ACTION_TOTAL: "DelaunayL",
  DELAUNAY_ACTION_ANGULAR_MOMENTUM: "DelaunayG",
  DELAUNAY_ACTION_POLAR_ANGULAR_MOMENTUM: "DelaunayH",

  GEODETIC_LATITUDE: "Latitude",
  GEODETIC_LONGITUDE: "Longitude",
  GEODETIC_ALTITUDE: "Altitude",
  GEOCENTRIC_LATITUDE: "GeocentricLatitude",
  PLANETODETIC_RADIUS_MAGNITUDE: "PlanetodeticRMAG",
  PLANETODETIC_VELOCITY_MAGNITUDE: "PlanetodeticVMAG",
  PLANETODETIC_AZIMUTH: "PlanetodeticAZI",
  PLANETODETIC_HORIZONTAL_FLIGHT_PATH_ANGLE: "PlanetodeticHFPA",
  LOCAL_SIDEREAL_TIME: "LST",
  PRIME_MERIDIAN_HOUR_ANGLE: "MHA",

  B_DOT_T: "BdotT",
  B_DOT_R: "BdotR",
  B_VECTOR_MAGNITUDE: "BVectorMag",
  B_VECTOR_ANGLE: "BVectorAngle",
  DECLINATION_OF_DEPARTURE_ASYMPTOTE: "DLA",
  RIGHT_ASCENSION_OF_DEPARTURE_ASYMPTOTE: "RLA",
  INCOMING_RADIUS_OF_PERIAPSIS: "IncomingRadPer",
  INCOMING_CHARACTERISTIC_ENERGY: "IncomingC3Energy",
  INCOMING_ASYMPTOTE_RIGHT_ASCENSION: "IncomingRHA",
  INCOMING_ASYMPTOTE_DECLINATION: "IncomingDHA",
  INCOMING_B_VECTOR_AZIMUTH: "IncomingBVAZI",
  OUTGOING_RADIUS_OF_PERIAPSIS: "OutgoingRadPer",
  OUTGOING_CHARACTERISTIC_ENERGY: "OutgoingC3Energy",
  OUTGOING_ASYMPTOTE_RIGHT_ASCENSION: "OutgoingRHA",
  OUTGOING_ASYMPTOTE_DECLINATION: "OutgoingDHA",
  OUTGOING_B_VECTOR_AZIMUTH: "OutgoingBVAZI",
  HYPERBOLIC_EXCESS_VELOCITY: "HyperbolicExcessVelocity",

  BROUWER_SHORT_SEMI_MAJOR_AXIS: "BrouwerShortSMA",
  BROUWER_SHORT_ECCENTRICITY: "BrouwerShortECC",
  BROUWER_SHORT_INCLINATION: "BrouwerShortINC",
  BROUWER_SHORT_RIGHT_ASCENSION_OF_ASCENDING_NODE: "BrouwerShortRAAN",
  BROUWER_SHORT_ARGUMENT_OF_PERIAPSIS: "BrouwerShortAOP",
  BROUWER_SHORT_MEAN_ANOMALY: "BrouwerShortMA",
  BROUWER_LONG_SEMI_MAJOR_AXIS: "BrouwerLongSMA",
  BROUWER_LONG_ECCENTRICITY: "BrouwerLongECC",
  BROUWER_LONG_INCLINATION: "BrouwerLongINC",
  BROUWER_LONG_RIGHT_ASCENSION_OF_ASCENDING_NODE: "BrouwerLongRAAN",
  BROUWER_LONG_ARGUMENT_OF_PERIAPSIS: "BrouwerLongAOP",
  BROUWER_LONG_MEAN_ANOMALY: "BrouwerLongMA",

  ORBIT_STATE_TRANSITION_MATRIX: "OrbitSTM",
  ORBIT_STATE_TRANSITION_MATRIX_A: "OrbitSTMA",
  ORBIT_STATE_TRANSITION_MATRIX_B: "OrbitSTMB",
  ORBIT_STATE_TRANSITION_MATRIX_C: "OrbitSTMC",
  ORBIT_STATE_TRANSITION_MATRIX_D: "OrbitSTMD",
  ORBIT_ERROR_COVARIANCE_MATRIX: "OrbitErrorCovariance",

  EPOCH_A1_GREGORIAN: "A1Gregorian",
  EPOCH_A1_MODIFIED_JULIAN: "A1ModJulian",
  EPOCH_TAI_GREGORIAN: "TAIGregorian",
  EPOCH_TAI_MODIFIED_JULIAN: "TAIModJulian",
  EPOCH_TT_GREGORIAN: "TTGregorian",
  EPOCH_TT_MODIFIED_JULIAN: "TTModJulian",
  EPOCH_TDB_GREGORIAN: "TDBGregorian",
  EPOCH_TDB_MODIFIED_JULIAN: "TDBModJulian",
  EPOCH_UTC_GREGORIAN: "UTCGregorian",
  EPOCH_UTC_MODIFIED_JULIAN: "UTCModJulian",
  EPOCH_UT1_GREGORIAN: "UT1Gregorian",
  EPOCH_UT1_MODIFIED_JULIAN: "UT1ModJulian",
  ELAPSED_DAYS: "ElapsedDays",
  ELAPSED_SECONDS: "ElapsedSecs",

  DRY_MASS: "DryMass",
  TOTAL_MASS: "TotalMass",
  DRAG_COEFFICIENT: "Cd",
  DRAG_AREA: "DragArea",
  REFLECTIVITY_COEFFICIENT: "Cr",
  SOLAR_RADIATION_PRESSURE_AREA: "SRPArea",
  ATMOSPHERIC_DENSITY_SCALE_FACTOR: "AtmosDensityScaleFactor",
  DRAG_SCALE_FACTOR: "SPADDragScaleFactor",
  SOLAR_RADIATION_PRESSURE_SCALE_FACTOR: "SPADSRPScaleFactor",
  BALLISTIC_COEFFICIENT: "BallisticCoefficient",
  AREA_TO_MASS_RATIO: "AreaToMassRatio",

  CENTER_OF_MASS_X: "SystemCenterOfMassX",
  CENTER_OF_MASS_Y: "SystemCenterOfMassY",
  CENTER_OF_MASS_Z: "SystemCenterOfMassZ",

  ATTITUDE_QUATERNION_1: "Q1",
  ATTITUDE_QUATERNION_2: "Q2",
  ATTITUDE_QUATERNION_3: "Q3",
  ATTITUDE_QUATERNION_4: "Q4",
  ATTITUDE_DIRECTION_COSINE_MATRIX: "DirectionCosineMatrix",
  EULER_ANGLE_1: "EulerAngle1",
  EULER_ANGLE_2: "EulerAngle2",
  EULER_ANGLE_3: "EulerAngle3",
  EULER_ANGLE_RATE_1: "EulerAngleRate1",
  EULER_ANGLE_RATE_2: "EulerAngleRate2",
  EULER_ANGLE_RATE_3: "EulerAngleRate3",
  MODIFIED_RODRIGUES_PARAMETER_1: "MRP1",
  MODIFIED_RODRIGUES_PARAMETER_2: "MRP2",
  MODIFIED_RODRIGUES_PARAMETER_3: "MRP3",
  ANGULAR_VELOCITY_X: "AngularVelocityX",
  ANGULAR_VELOCITY_Y: "AngularVelocityY",
  ANGULAR_VELOCITY_Z: "AngularVelocityZ",

  TANK_FUEL_MASS: "FuelMass",
  TANK_PRESSURE: "Pressure",
  TANK_TEMPERATURE: "Temperature",
  TANK_REFERENCE_TEMPERATURE: "RefTemperature",
  TANK_VOLUME: "Volume",
  TANK_FUEL_DENSITY: "FuelDensity",

  THRUSTER_DUTY_CYCLE: "DutyCycle",
  THRUSTER_THRUST_SCALE_FACTOR: "ThrustScaleFactor",
  THRUSTER_GRAVITATIONAL_ACCELERATION: "GravitationalAccel",
  THRUSTER_SPECIFIC_IMPULSE: "Isp",
  THRUSTER_THRUST_MAGNITUDE: "ThrustMagnitude",
  THRUSTER_MASS_FLOW_RATE: "MassFlowRate",
  THRUSTER_DIRECTION_X: "ThrustDirection1",
  THRUSTER_DIRECTION_Y: "ThrustDirection2",
  THRUSTER_DIRECTION_Z: "ThrustDirection3",

  IMPULSIVE_BURN_ELEMENT_1: "Element1",
  IMPULSIVE_BURN_ELEMENT_2: "Element2",
  IMPULSIVE_BURN_ELEMENT_3: "Element3",

  FINITE_BURN_MASS_FLOW_RATE: "TotalMassFlowRate",
  FINITE_BURN_THRUST_X: "TotalThrust1",
  FINITE_BURN_THRUST_Y: "TotalThrust2",
  FINITE_BURN_THRUST_Z: "TotalThrust3",

  TOTAL_POWER_AVAILABLE: "TotalPowerAvailable",
  REQUIRED_BUS_POWER: "RequiredBusPower",
  THRUST_POWER_AVAILABLE: "ThrustPowerAvailable",
};

/// SDS members this module deliberately does not answer, each with the reason a
/// consumer will read back in `UNAVAILABLE_REASON`.
const UNMAPPED = {
  UNSPECIFIED: "not a parameter",
  PROVIDER_DEFINED: "resolved by name against the publisher's own catalog, not the roster",

  MOMENT_OF_INERTIA_MATRIX: "mass-property provider",
  EULER_AXIS_X: "attitude provider",
  EULER_AXIS_Y: "attitude provider",
  EULER_AXIS_Z: "attitude provider",
  PRINCIPAL_ROTATION_ANGLE: "attitude provider",

  THRUSTER_MIXTURE_RATIO: "hardware provider",
  THRUSTER_THRUST_COEFFICIENTS: "hardware provider",
  THRUSTER_IMPULSE_COEFFICIENTS: "hardware provider",

  IMPULSIVE_BURN_DELTA_V_MAGNITUDE: "maneuver provider",
  IMPULSIVE_BURN_MASS_CONSUMED: "maneuver provider",
  FINITE_BURN_THRUST_MAGNITUDE: "maneuver provider",
  FINITE_BURN_ACCELERATION_MAGNITUDE: "maneuver provider",
  FINITE_BURN_MASS_CONSUMED: "maneuver provider",

  GENERATED_POWER: "power provider",
  TOTAL_TORQUE_X: "torque provider",
  TOTAL_TORQUE_Y: "torque provider",
  TOTAL_TORQUE_Z: "torque provider",
  TOTAL_TORQUE_MAGNITUDE: "torque provider",

  SOLVER_STATUS: "solver provider",
  SOLVER_ITERATION_COUNT: "solver provider",
  SOLVER_OBJECTIVE_VALUE: "solver provider",
  SOLVER_MAXIMUM_CONSTRAINT_VIOLATION: "solver provider",

  EPOCH_GPS_GREGORIAN: "time-scale provider: the GPS scale is the time module's, not this one's",
  EPOCH_GPS_MODIFIED_JULIAN:
    "time-scale provider: the GPS scale is the time module's, not this one's",

  RELATIVE_RANGE: "second-object state",
  RELATIVE_RANGE_RATE: "second-object state",
  RELATIVE_POSITION_X: "second-object state",
  RELATIVE_POSITION_Y: "second-object state",
  RELATIVE_POSITION_Z: "second-object state",
  RELATIVE_VELOCITY_X: "second-object state",
  RELATIVE_VELOCITY_Y: "second-object state",
  RELATIVE_VELOCITY_Z: "second-object state",
  TOPOCENTRIC_AZIMUTH: "surface-site position",
  TOPOCENTRIC_ELEVATION: "surface-site position",
  ANGULAR_SEPARATION: "second-object state",
  SOLAR_PHASE_ANGLE: "second-object state",
  LOCAL_SOLAR_ELEVATION_ANGLE: "surface-site position",
  ILLUMINATION_FRACTION: "the event-locator module answers illumination, not this one",
  LIGHT_TIME_DELAY: "second-object state",
};

function parseEnum(source, name) {
  const start = source.indexOf(`enum ${name} `);
  if (start < 0) throw new Error(`enum ${name} not found in the published schema`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  const body = source.slice(open + 1, close);
  const members = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(\d+)\s*,?\s*$/);
    if (match) members.push({ name: match[1], value: Number(match[2]) });
  }
  return members;
}

export function generatePceCrosswalk(rosterNames) {
  if (!fs.existsSync(schemaPath)) {
    throw new Error(
      `spacedatastandards.org is not installed at ${schemaPath}; run npm ci in this package`,
    );
  }
  const source = fs.readFileSync(schemaPath, "utf8");
  const members = parseEnum(source, "pceParameter");
  const version = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, "node_modules", "spacedatastandards.org", "package.json"),
      "utf8",
    ),
  ).version;

  const unclassified = [];
  const unknownTargets = [];
  const rows = [];
  for (const member of members) {
    const target = MAPPED[member.name];
    if (target) {
      if (!rosterNames.has(target)) unknownTargets.push(`${member.name} -> ${target}`);
      rows.push({ ...member, target });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(UNMAPPED, member.name)) {
      rows.push({ ...member, target: null, reason: UNMAPPED[member.name] });
      continue;
    }
    unclassified.push(member.name);
  }
  if (unclassified.length > 0) {
    throw new Error(
      `pceParameter crosswalk: ${unclassified.length} published member(s) are neither mapped nor declared unmapped: ${unclassified.join(", ")}`,
    );
  }
  if (unknownTargets.length > 0) {
    throw new Error(
      `pceParameter crosswalk: mapping targets absent from the roster: ${unknownTargets.join(", ")}`,
    );
  }

  const identifier = (name) => name.replace(/[^A-Za-z0-9]/g, "_");
  const lines = [];
  lines.push("// GENERATED FILE — DO NOT EDIT.");
  lines.push("//");
  lines.push("// Generator : generate-pce-crosswalk.mjs");
  lines.push(`// Vocabulary: pceParameter from spacedatastandards.org@${version}`);
  lines.push("//");
  lines.push("// Every published member is either mapped to a roster parameter or listed");
  lines.push("// here as deliberately unmapped with its reason. A member that is neither");
  lines.push("// fails the generator by name, so a later release cannot add a parameter");
  lines.push("// this module silently ignores.");
  lines.push("");
  lines.push("#ifndef SDN_ANALYSIS_PARAMETERS_PCE_CROSSWALK_HPP");
  lines.push("#define SDN_ANALYSIS_PARAMETERS_PCE_CROSSWALK_HPP");
  lines.push("");
  lines.push("#include <cstdint>");
  lines.push("");
  lines.push("namespace sdn {");
  lines.push("namespace parameters {");
  lines.push("");
  lines.push("struct PceCrosswalkEntry {");
  lines.push("  uint16_t pceParameterValue;");
  lines.push("  const char* pceParameterName;");
  lines.push("  /// UNSPECIFIED when this module does not answer the parameter.");
  lines.push("  ParameterId id;");
  lines.push("  /// Why not, in capability language. Null when it is answered.");
  lines.push("  const char* unavailableReason;");
  lines.push("};");
  lines.push("");
  lines.push(`constexpr int kPceCrosswalkSize = ${rows.length};`);
  lines.push("inline const PceCrosswalkEntry kPceCrosswalk[kPceCrosswalkSize] = {");
  for (const row of rows) {
    const id = row.target ? `ParameterId::${identifier(row.target)}` : "ParameterId::UNSPECIFIED";
    const reason = row.target ? "nullptr" : `"${row.reason}"`;
    lines.push(`    {${row.value}, "${row.name}", ${id}, ${reason}},`);
  }
  lines.push("};");
  lines.push("");
  lines.push("/// Roster parameter for a published parameter code, or nullptr when the");
  lines.push("/// code is outside the vocabulary this build was generated against.");
  lines.push("inline const PceCrosswalkEntry* crosswalkFromPce(uint16_t value) {");
  lines.push("  for (int i = 0; i < kPceCrosswalkSize; ++i) {");
  lines.push("    if (kPceCrosswalk[i].pceParameterValue == value) return &kPceCrosswalk[i];");
  lines.push("  }");
  lines.push("  return nullptr;");
  lines.push("}");
  lines.push("");
  lines.push("/// Published parameter code for a roster parameter, or 0 when the roster");
  lines.push("/// entry has no published name (it is one of the reference tool's own");
  lines.push("/// shorthands, reachable by name but not by code).");
  lines.push("inline uint16_t crosswalkToPce(ParameterId id) {");
  lines.push("  for (int i = 0; i < kPceCrosswalkSize; ++i) {");
  lines.push("    if (kPceCrosswalk[i].id == id) return kPceCrosswalk[i].pceParameterValue;");
  lines.push("  }");
  lines.push("  return 0;");
  lines.push("}");
  lines.push("");
  lines.push("}  // namespace parameters");
  lines.push("}  // namespace sdn");
  lines.push("");
  lines.push("#endif  // SDN_ANALYSIS_PARAMETERS_PCE_CROSSWALK_HPP");

  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(path.join(generatedDir, "pce_crosswalk.hpp"), `${lines.join("\n")}\n`);
  const mapped = rows.filter((row) => row.target !== null).length;
  fs.writeFileSync(
    path.join(generatedDir, "pce-crosswalk.json"),
    `${JSON.stringify({ sdsVersion: version, total: rows.length, mapped, rows }, null, 2)}\n`,
  );
  return { version, total: rows.length, mapped, unmapped: rows.length - mapped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const roster = JSON.parse(
    fs.readFileSync(path.join(generatedDir, "roster.json"), "utf8"),
  );
  const names = new Set(roster.parameters.map((row) => row.name));
  const result = generatePceCrosswalk(names);
  console.log(
    `Generated pceParameter crosswalk against spacedatastandards.org@${result.version}: ` +
    `${result.total} published members, ${result.mapped} answered, ${result.unmapped} declared unavailable`,
  );
}
