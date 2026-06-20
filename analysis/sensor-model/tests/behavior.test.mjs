import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const HEADER_PATH = new URL("../src/cpp/sensor_shape_model.h", import.meta.url);
const SOURCE_PATH = new URL("../src/cpp/sensor_shape_model.cpp.inc", import.meta.url);

function readSharedModelSource() {
  return {
    header: fs.readFileSync(HEADER_PATH, "utf8"),
    source: fs.readFileSync(SOURCE_PATH, "utf8"),
  };
}

test("shared C++ model declares the canonical sensor shape contract surface", () => {
  const { header } = readSharedModelSource();

  assert.match(header, /enum class SensorShapeKind/);
  for (const kind of [
    "Conic",
    "Rectangular",
    "SarAnnularSector",
    "CustomPolygon",
  ]) {
    assert.match(header, new RegExp(`\\b${kind}\\b`));
  }

  assert.match(header, /struct SensorShapeContract/);
  assert.match(header, /parse_sensor_shape_contract/);
});

test("shared C++ model exposes clock helpers and local-look classification", () => {
  const { header, source } = readSharedModelSource();
  const combined = `${header}\n${source}`;

  for (const symbol of [
    "normalize_clock_range_rad",
    "clock_angle_in_range",
    "classify_local_look",
    "generate_sensor_boundary_directions",
  ]) {
    assert.match(combined, new RegExp(`\\b${symbol}\\b`));
  }

  assert.match(source, /wrapped/);
  assert.match(source, /unsupported shape/i);
});

test("shared C++ model names required sensor-shape conformance labels", () => {
  const { source } = readSharedModelSource();

  for (const label of [
    "solid-conic",
    "rectangular",
    "sar-annular-sector",
    "inner-cutout",
    "partial-clock-sector",
    "wrapped-clock-sector",
    "custom-polygon-unsupported",
  ]) {
    assert.match(source, new RegExp(`"${label}"`));
  }
});
