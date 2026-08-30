#!/usr/bin/env node
/**
 * Emit the external reference vectors as a C++ header so the native parity
 * harness and the WASM suite measure the SAME numbers.
 *
 * The vectors live in `fixtures/orekit-vectors.json` with their provenance —
 * repository, file, retrieval date, and the note that every value appears
 * verbatim as an asserted expectation in the cited test. Generating the header
 * from that file means a vector cannot be quietly retyped into the harness with
 * a digit changed, which is the failure mode a hand-copied expectation has.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(packageRoot, "fixtures", "orekit-vectors.json");
const generatedDir = path.join(packageRoot, "src", "generated");

const literal = (value) => {
  if (!Number.isFinite(value)) throw new Error(`non-finite vector value: ${value}`);
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
};

const vector3 = (values) => `{${values.map(literal).join(", ")}}`;

export function generateReferenceVectors() {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const lines = [];
  lines.push("// GENERATED FILE — DO NOT EDIT.");
  lines.push("//");
  lines.push("// Source of truth : fixtures/orekit-vectors.json");
  lines.push("// Generator       : generate-reference-vectors.mjs");
  lines.push(`// Authority       : ${fixture.source.repository} @ ${fixture.source.ref}`);
  lines.push("//");
  for (const file of fixture.source.files) lines.push(`//   ${file}`);
  lines.push("");
  lines.push("#ifndef SDN_ANALYSIS_PARAMETERS_REFERENCE_VECTORS_HPP");
  lines.push("#define SDN_ANALYSIS_PARAMETERS_REFERENCE_VECTORS_HPP");
  lines.push("");
  lines.push("namespace sdn {");
  lines.push("namespace parameters {");
  lines.push("namespace reference {");
  lines.push("");

  const k2c = fixture.keplerianToCartesian;
  lines.push("// KeplerianOrbitTest.testKeplerianToCartesian");
  lines.push(`constexpr double kKeplerianMu = ${literal(k2c.gravitationalParameter)};`);
  lines.push(`constexpr double kKeplerianSemiMajorAxis = ${literal(k2c.elements.semiMajorAxis)};`);
  lines.push(`constexpr double kKeplerianEccentricity = ${literal(k2c.elements.eccentricity)};`);
  lines.push(`constexpr double kKeplerianInclination = ${literal(k2c.elements.inclination)};`);
  lines.push(`constexpr double kKeplerianRaan = ${literal(k2c.elements.raan)};`);
  lines.push(`constexpr double kKeplerianArgumentOfPeriapsis = ${literal(k2c.elements.argumentOfPeriapsis)};`);
  lines.push(`constexpr double kKeplerianMeanAnomaly = ${literal(k2c.elements.meanAnomaly)};`);
  lines.push(`constexpr double kKeplerianPosition[3] = ${vector3(k2c.position)};`);
  lines.push(`constexpr double kKeplerianVelocity[3] = ${vector3(k2c.velocity)};`);
  lines.push("");

  const k2e = fixture.keplerianToEquinoctial;
  lines.push("// KeplerianOrbitTest.testKeplerianToEquinoctial (the same orbit)");
  lines.push(`constexpr double kEquinoctialEx = ${literal(k2e.equinoctialEx)};`);
  lines.push(`constexpr double kEquinoctialEy = ${literal(k2e.equinoctialEy)};`);
  lines.push(`constexpr double kEquinoctialMeanLongitude = ${literal(k2e.meanLongitude)};`);
  lines.push(`constexpr double kEquinoctialInclinationIx = ${literal(k2e.inclinationFrom.ix)};`);
  lines.push(`constexpr double kEquinoctialInclinationIy = ${literal(k2e.inclinationFrom.iy)};`);
  lines.push("");

  const e2c = fixture.equinoctialToCartesian;
  lines.push("// EquinoctialOrbitTest.testEquinoctialToCartesian");
  lines.push(`constexpr double kGeoMu = ${literal(e2c.gravitationalParameter)};`);
  lines.push(`constexpr double kGeoSemiMajorAxis = ${literal(e2c.semiMajorAxis)};`);
  lines.push(`constexpr double kGeoEx = ${literal(e2c.equinoctialEx)};`);
  lines.push(`constexpr double kGeoEy = ${literal(e2c.equinoctialEy)};`);
  lines.push(`constexpr double kGeoIx = ${literal(e2c.inclinationVectorFrom.ix)};`);
  lines.push(`constexpr double kGeoIy = ${literal(e2c.inclinationVectorFrom.iy)};`);
  lines.push(`constexpr double kGeoMeanLongitude = ${literal(e2c.meanLongitude)};`);
  lines.push(`constexpr double kGeoPosition[3] = ${vector3(e2c.position)};`);
  lines.push(`constexpr double kGeoVelocity[3] = ${vector3(e2c.velocity)};`);
  lines.push("");

  lines.push("// OneAxisEllipsoidTest — body-fixed position to geodetic longitude,");
  lines.push("// latitude and altitude.");
  lines.push("struct GeodeticCase {");
  lines.push("  const char* name;");
  lines.push("  double equatorialRadius;");
  lines.push("  double flatteningDenominator;");
  lines.push("  double position[3];");
  lines.push("  double longitude;");
  lines.push("  double latitude;");
  lines.push("  double altitude;");
  lines.push("  // One unit in the last place the source test PRINTS for each");
  lines.push("  // expectation. Agreement is never asserted finer than this.");
  lines.push("  double longitudePrinted;");
  lines.push("  double latitudePrinted;");
  lines.push("  double altitudePrinted;");
  lines.push("};");
  lines.push(`constexpr int kGeodeticCaseCount = ${fixture.geodetic.cases.length};`);
  lines.push("constexpr GeodeticCase kGeodeticCases[kGeodeticCaseCount] = {");
  for (const testCase of fixture.geodetic.cases) {
    lines.push(
      `    {"${testCase.name}", ${literal(testCase.equatorialRadius)}, ` +
      `${literal(testCase.flatteningDenominator)}, ${vector3(testCase.position)}, ` +
      `${literal(testCase.longitude)}, ${literal(testCase.latitude)}, ${literal(testCase.altitude)}, ` +
      `${literal(Math.pow(10, -testCase.printedDecimals.longitude))}, ` +
      `${literal(Math.pow(10, -testCase.printedDecimals.latitude))}, ` +
      `${literal(Math.pow(10, -testCase.printedDecimals.altitude))}},`,
    );
  }
  lines.push("};");
  lines.push("");

  const sidereal = fixture.siderealTime;
  lines.push(`// ${sidereal.from}`);
  lines.push(`constexpr double kSiderealJulianDateUt1 = ${literal(sidereal.julianDateUT1)};`);
  lines.push(
    `constexpr double kSiderealGreenwichMeanDegrees = ${literal(sidereal.greenwichMeanSiderealTimeDegrees)};`,
  );
  lines.push("");
  lines.push("}  // namespace reference");
  lines.push("}  // namespace parameters");
  lines.push("}  // namespace sdn");
  lines.push("");
  lines.push("#endif  // SDN_ANALYSIS_PARAMETERS_REFERENCE_VECTORS_HPP");

  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(
    path.join(generatedDir, "reference_vectors.hpp"),
    `${lines.join("\n")}\n`,
  );
  return { cases: fixture.geodetic.cases.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = generateReferenceVectors();
  console.log(`Generated reference vectors (${result.cases} geodetic cases)`);
}
