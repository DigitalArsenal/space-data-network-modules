// How far one $OEM is from another, block by block: the largest position (m) and velocity (mm/s) difference at the same
// epoch, and of the covariance lines the largest difference of an entry against its line's largest entry. Byte equality
// beside it. JS only reads the numbers the module wrote.
import * as flatbuffers from "flatbuffers";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";

export function oemDistance(got, want) {
  const a = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(got))).unpack();
  const b = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(want))).unpack();
  const out = { bytesEqual: Buffer.from(got).equals(Buffer.from(want)), states: 0, epochsDiffer: 0, posM: 0, velMmS: 0, covLines: 0, covOfLargest: 0 };
  if (a.EPHEMERIS_DATA_BLOCK.length !== b.EPHEMERIS_DATA_BLOCK.length) out.blocksDiffer = true;
  for (let k = 0; k < Math.min(a.EPHEMERIS_DATA_BLOCK.length, b.EPHEMERIS_DATA_BLOCK.length); k += 1) {
    const la = a.EPHEMERIS_DATA_BLOCK[k].EPHEMERIS_DATA_LINES ?? [], lb = b.EPHEMERIS_DATA_BLOCK[k].EPHEMERIS_DATA_LINES ?? [];
    if (la.length !== lb.length) out.linesDiffer = true;
    for (let i = 0; i < Math.min(la.length, lb.length); i += 1) {
      out.states += 1;
      if (la[i].EPOCH !== lb[i].EPOCH) out.epochsDiffer += 1;
      out.posM = Math.max(out.posM, 1000 * Math.hypot(la[i].X - lb[i].X, la[i].Y - lb[i].Y, la[i].Z - lb[i].Z));
      out.velMmS = Math.max(out.velMmS, 1e6 * Math.hypot(la[i].X_DOT - lb[i].X_DOT, la[i].Y_DOT - lb[i].Y_DOT, la[i].Z_DOT - lb[i].Z_DOT));
    }
    const ca = a.EPHEMERIS_DATA_BLOCK[k].COVARIANCE_MATRIX_LINES ?? [], cb = b.EPHEMERIS_DATA_BLOCK[k].COVARIANCE_MATRIX_LINES ?? [];
    if (ca.length !== cb.length) out.covLinesDiffer = true;
    for (let i = 0; i < Math.min(ca.length, cb.length); i += 1) {
      out.covLines += 1;
      const keys = Object.keys(ca[i]).filter((key) => typeof ca[i][key] === "number");
      const largest = Math.max(...keys.map((key) => Math.abs(ca[i][key])));
      if (largest > 0) out.covOfLargest = Math.max(out.covOfLargest, Math.max(...keys.map((key) => Math.abs(ca[i][key] - cb[i][key]))) / largest);
    }
  }
  return out;
}
