// $OCM element sets for the tests: the 0.4.0 fixtures' fits made by the module (AP under gravity caps 31 and 20 and
// NRLMSISE-00 on the fixture rows, stock SGP4XP), a record edited through the bindings to trigger a refusal, and the
// frames of a flight. JS only moves bytes: every element set comes out of the module.
import * as flatbuffers from "flatbuffers";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { configuration, MSIS_FORCES, XP_FORCES } from "./pcf.mjs";
import { inputs, GRID } from "./fixture-inputs.mjs";

export const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });

/// fit's FORCES of the AP fixture: gravity caps 31 and 20, NRLMSISE-00 on the daily rows.
export const AP_FORCES = Object.freeze({ ...MSIS_FORCES, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true,
  MAXIMUM_DEGREE: 20, WEATHER_SOURCE: pcfWeatherSource.RECORDS });

export const ocmOf = (bytes) => OCM.getRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();

/// The record `bytes` with `edit(t)` applied to its object form, packed again.
export function repackOcm(bytes, edit) {
  const t = ocmOf(bytes);
  edit(t);
  const b = new flatbuffers.Builder(8192);
  OCM.finishOCMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}

/// The AP and XP $OCM of the fixture inputs, fitted by the module behind `h` (a standalone harness).
export async function fixtureSets(h) {
  const { arc, rows } = inputs();
  const fit = async (config, spw) => {
    const r = await h.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: T("OEM"), payload: arc }, config,
      ...(spw ? [{ portId: "space_weather", typeRef: T("SPW"), payload: spw }] : [])] });
    if (r.statusCode !== 0) throw new Error(`fit: ${r.errorCode} ${r.errorMessage}`);
    return new Uint8Array(r.outputs[0].payload);
  };
  return {
    ap: await fit(configuration({ theory: "AP", forces: AP_FORCES }), rows.bytes),
    xp: await fit(configuration({ theory: "SGP4XP", forces: XP_FORCES })),
    rows,
  };
}

/// The fixture grid as the $PCF OUTPUT of a flight.
export const GRID_OUTPUT = Object.freeze({ START_TIME: GRID.start, STOP_TIME: GRID.stop, STEP_SECONDS: GRID.step });

/// The frames of a flight: 'ocm' records and, when `pcf` is given, its 'configuration'.
export const flight = (records, pcf = null) => [
  ...records.map((payload) => ({ portId: "ocm", typeRef: T("OCM"), payload })),
  ...(pcf ? [configuration(pcf)] : []),
];
