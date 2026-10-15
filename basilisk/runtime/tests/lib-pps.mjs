// The SDS $PPS bindings (spacedatastandards.org lib/ts/PPS, bundled in memory by the standards repo's own esbuild
// with its flatbuffers runtime) and request helpers for the pointing and power tests.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
export const PPS_TYPE = { schemaName: "PPS.fbs", fileIdentifier: "$PPS", rootTypeName: "PPS", wireFormat: "flatbuffer" };

// The dev bindings' lib/ts/PPS/main.ts does not re-export every type yet, so every file of the directory is
// re-exported (each file exports only its own names).
const esbuild = createRequire(path.join(STANDARDS_ROOT, "package.json"))("esbuild");
const files = fs.readdirSync(path.join(STANDARDS_ROOT, "lib", "ts", "PPS")).filter((f) => f.endsWith(".ts") && f !== "main.ts");
const bundle = await esbuild.build({
  stdin: {
    contents: `${files.map((f) => `export * from "./lib/ts/PPS/${f}";`).join("\n")}\nexport * as flatbuffers from "flatbuffers";`,
    resolveDir: STANDARDS_ROOT,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
export const sds = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const make = (Cls, fields) => Object.assign(new Cls(), fields);
export const scenario = (fields) => make(sds.ppsScenarioT, fields);
export const solarArray = (fields) => make(sds.ppsSolarArrayT, fields);
export const battery = (fields) => make(sds.ppsBatteryT, fields);

export function encodePPS(fields) {
  const builder = new sds.flatbuffers.Builder(1024);
  builder.finish(make(sds.PPST, fields).pack(builder), "$PPS");
  return builder.asUint8Array().slice();
}
export const scenarioFrame = (fields) => ({ portId: "scenario", typeRef: PPS_TYPE, payload: encodePPS(fields) });
export function decodePPS(payload) {
  const bb = new sds.flatbuffers.ByteBuffer(Uint8Array.from(payload));
  if (!sds.PPS.bufferHasIdentifier(bb)) throw new Error("the frame is not a $PPS");
  return sds.PPS.getRootAsPPS(bb).unpack();
}

// The JSON-era request ({scenarioId, durationSeconds, ...}) as a $PPS scenario with the same values.
export function scenarioFromLegacy(legacy) {
  return scenario({
    SCENARIO_ID: legacy.scenarioId ?? null,
    DURATION_S: legacy.durationSeconds ?? 0,
    STEP_S: legacy.stepSeconds ?? 0,
    INITIAL_POINTING_ERROR_DEG: legacy.initialAttitudeErrorDeg ?? 5,
    INITIAL_BODY_RATE_DEG_S: legacy.bodyRateDegSec ?? 0.05,
    INITIAL_WHEEL_MOMENTUM_NMS: legacy.wheelMomentumNms ?? 8,
    SENSOR_NOISE_ARCSEC: legacy.sensorNoiseArcsec ?? 20,
    SOLAR_ARRAY: legacy.solarArrayAreaM2 === undefined ? null : solarArray({ AREA_M2: legacy.solarArrayAreaM2 }),
    BATTERY: battery({ INITIAL_STATE_OF_CHARGE: legacy.batteryStateOfCharge ?? Number.NaN }),
  });
}
