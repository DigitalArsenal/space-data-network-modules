import * as flatbuffers from "flatbuffers";
import { ACW, ACWT } from "spacedatastandards.org/lib/js/ACW/ACW.js";
import { ACWRequestT } from "spacedatastandards.org/lib/js/ACW/ACWRequest.js";
import { ACWGroundStationT } from "spacedatastandards.org/lib/js/ACW/ACWGroundStation.js";
import { ACWStateSampleT } from "spacedatastandards.org/lib/js/ACW/ACWStateSample.js";

// Orekit 13.1.2 TopocentricFrameTest.testGetTopocentricCoordinatesValues /
// testInverseGetTopocentricCoordinates; inverse ENU formulas at lines 846-848.
// https://www.orekit.org/site-orekit-13.1.2/xref-test/org/orekit/frames/TopocentricFrameTest.html
// Angles radians, range/metres, geocentric ECEF on WGS84 equator at lon=0.
// Epoch JD 2460400.5 TT, two fixed-frame samples 60 seconds apart; no frame
// transformation or dynamics. 1e-10 rad allows cancellation in Earth-radius +
// metre-range coordinates and libm rounding, not a fitted output tolerance.
export const vectors = [
  [0, 0, 1], [0, Math.PI / 2, 1], [Math.PI, Math.PI / 3, 10],
  [3 * Math.PI / 2, Math.PI / 4, 1000], [Math.PI / 2, -Math.PI / 6, 500],
  [Math.PI / 7, -Math.PI / 5, 100],
];
export const toleranceRad = 1e-10;
export const typeRef = { schemaName: "ACW.fbs", fileIdentifier: "$ACW", rootTypeName: "ACW", wireFormat: "flatbuffer" };
export function requestFor([azimuth, elevation, range]) {
  const east = Math.sin(azimuth) * Math.cos(elevation) * range;
  const north = Math.cos(azimuth) * Math.cos(elevation) * range;
  const up = Math.sin(elevation) * range;
  const station = new ACWGroundStationT("origin", "Origin", 0, 0, 0, -Math.PI / 2, 1, []);
  const states = [0, 60].map((seconds) => new ACWStateSampleT(2460400.5 + seconds / 86400, 6378137 + up, east, north));
  const envelope = new ACWT(new ACWRequestT(1, [station], states, "origin", -Math.PI / 2, "orekit-lane10"), null);
  const builder = new flatbuffers.Builder(1024);
  ACW.finishACWBuffer(builder, envelope.pack(builder));
  return { methodId: "compute_access_windows", inputs: [{ portId: "request", typeRef, payload: builder.asUint8Array() }] };
}
export function elevationFrom(response) {
  const result = ACW.getRootAsACW(new flatbuffers.ByteBuffer(response.outputs[0].payload)).RESULT();
  if (result.STATUS() !== 0 || result.windowsLength() !== 1) throw new Error("Expected one successful ACW interval");
  return result.WINDOWS(0).MAX_ELEVATION_RAD();
}
