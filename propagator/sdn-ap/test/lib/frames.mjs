// $OEM bytes in another frame, the states rotated by the module (sdnap_frame_probe: the fit's own rotations).
// JS only moves bytes: the rotations run in the module.
import * as flatbuffers from "flatbuffers";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { RFMT } from "spacedatastandards.org/lib/js/RFM/RFM.js";
import { RFMUnion } from "spacedatastandards.org/lib/js/RFM/RFMUnion.js";
import { CelestialFrameWrapperT } from "spacedatastandards.org/lib/js/RFM/CelestialFrameWrapper.js";
import { CelestialFrame } from "spacedatastandards.org/lib/js/RFM/CelestialFrame.js";

/** An RFM object declaring `name` by NAME only (`by: "name"`), by the enumeration only (`by: "enum"`), or both. */
export function rfm(name, by = "name") {
  const value = { TEME: CelestialFrame.TEMEOFDATE, GCRF: CelestialFrame.GCRF, EME2000: CelestialFrame.EME2000, ITRF: CelestialFrame.ITRF2000 }[name];
  const useEnum = by !== "name" && value !== undefined;
  return new RFMT(useEnum ? RFMUnion.CelestialFrameWrapper : RFMUnion.NONE, useEnum ? new CelestialFrameWrapperT(value) : null, 0, by === "enum" ? null : name);
}

export const FRAME_PROBE = Object.freeze({ GCRF_TO_TEME: 0, TEME_TO_GCRF: 1, TEME_TO_EARTH_FIXED: 2, EARTH_FIXED_TO_TEME: 3 });

/** UTC Julian date (whole at 0 h, fraction of day) of an SDS epoch text. */
export function jdOf(text) {
  const [, y, mo, d, h, mi, s] = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):([\d.]+)/.exec(text);
  return { whole: Date.UTC(+y, +mo - 1, +d) / 86400000 + 2440587.5, frac: (+h * 3600 + +mi * 60 + +s) / 86400 };
}

/** One state (km, km/s) through sdnap_frame_probe of an openModule() handle. */
export function rotate(module, whole, frac, state, mode) {
  const x = module.x;
  const pin = x.sdnap_alloc(48), pout = x.sdnap_alloc(48);
  new Float64Array(module.harness.memory.buffer, pin, 6).set(state);
  const status = x.sdnap_frame_probe(whole, frac, pin, pout, mode);
  const out = Array.from(new Float64Array(module.harness.memory.buffer, pout, 6));
  x.sdnap_free(pin);
  x.sdnap_free(pout);
  return { status, out };
}

export function packOem(t) {
  const b = new flatbuffers.Builder(1 << 20);
  OEM.finishOEMBuffer(b, t.pack(b));
  return b.asUint8Array();
}

/** A TEME $OEM's first block in `name` (declared as `by`: "name", "enum" or "both"; null: no REFERENCE_FRAME at all),
 * states rotated by `mode` (null: unrotated), with a test OBJECT. */
export function oemInFrame(module, temeOem, name, mode, object = { norad: 90001, id: "2026-901A", name: "SDN-AP FIT E2E" }, by = "name") {
  const copy = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(temeOem)).unpack();
  const block = copy.EPHEMERIS_DATA_BLOCK[0];
  const cat = new CATT();
  cat.NORAD_CAT_ID = object.norad;
  cat.OBJECT_ID = object.id;
  cat.OBJECT_NAME = object.name;
  block.OBJECT = cat;
  block.REFERENCE_FRAME = name === null ? null : rfm(name, by);
  if (mode !== null) {
    for (const line of block.EPHEMERIS_DATA_LINES) {
      const t = jdOf(line.EPOCH);
      const { status, out } = rotate(module, t.whole, t.frac, [line.X, line.Y, line.Z, line.X_DOT, line.Y_DOT, line.Z_DOT], mode);
      if (status < 0) throw new Error(`frame probe refused ${line.EPOCH}`);
      [line.X, line.Y, line.Z, line.X_DOT, line.Y_DOT, line.Z_DOT] = out;
    }
  }
  copy.EPHEMERIS_DATA_BLOCK = [block];
  return packOem(copy);
}
