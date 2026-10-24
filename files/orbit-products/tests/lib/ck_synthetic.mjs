// The synthetic attitude the CK writer is held to, as an $AEM built with the SDS FlatBuffers.
import * as flatbuffers from "flatbuffers";
import { AEM } from "spacedatastandards.org/lib/js/AEM/AEM.js";
import { AEMSegment } from "spacedatastandards.org/lib/js/AEM/AEMSegment.js";
import { attitudeDataLine } from "spacedatastandards.org/lib/js/AEM/attitudeDataLine.js";

export const toDegrees = 180 / Math.PI;

// An ISO 8601 stamp on a uniform scale to seconds past J2000, from the whole second and the fraction apart.
export function secondsPastJ2000(stamp) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d+)?$/.exec(stamp);
  if (!m) throw new Error(`stamp ${stamp}`);
  const whole = (Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - Date.UTC(2000, 0, 1, 12, 0, 0)) / 1000;
  return whole + (m[7] ? Number(`0${m[7]}`) : 0);
}

// The synthetic attitude the writer is held to: a rotation of the instrument frame at constant rate about a fixed
// tilted axis, as 260 records (so the tick directory exists) on the MSL clock's TT, plus a short second segment
// without rates. The quaternion is the CCSDS one, from J2000 to the instrument.
export function syntheticAem() {
  const axis = (() => { const v = [0.3, -0.5, 0.8]; const n = Math.hypot(...v); return v.map((x) => x / n); })();
  const rate = 0.004; // rad/s
  const t0 = 413337434.0; // seconds past J2000, TT, inside the clock's first span
  const stamp = (t) => {
    const whole = Math.floor(t);
    const base = new Date(Date.UTC(2000, 0, 1, 12, 0, 0) + whole * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}T${pad(base.getUTCHours())}:${pad(base.getUTCMinutes())}:${pad(base.getUTCSeconds())}.${pad(Math.round((t - whole) * 1e9), 9)}`;
  };
  const lines = (count, start, step, withAv) => Array.from({ length: count }, (_, i) => {
    const t = start + i * step;
    const half = (rate * (t - t0)) / 2;
    const s = Math.sin(half);
    // Q = (sin(a/2) e, cos(a/2)): CCSDS, from frame A to frame B.
    const q = [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
    return { epoch: stamp(t), q, av: withAv ? axis.map((x) => x * rate * toDegrees) : null };
  });
  return [
    { name: "SYNTHETIC CONSTANT RATE", id: "-76999", frameA: "J2000", frameB: "-76999", av: true, lines: lines(260, t0, 1.25, true) },
    { name: "SYNTHETIC NO RATES", id: "-76998", frameA: "ECLIPJ2000", frameB: "-76998", av: false, lines: lines(5, t0 + 600, 7.5, false) },
  ];
}

export function buildAem(segments, patch = {}) {
  const b = new flatbuffers.Builder(65536);
  const segOffsets = segments.map((s) => {
    const lineOffsets = s.lines.map((l) => {
      const epoch = b.createString(l.epoch);
      attitudeDataLine.startattitudeDataLine(b);
      attitudeDataLine.addEpoch(b, epoch);
      attitudeDataLine.addQ1(b, l.q[0]); attitudeDataLine.addQ2(b, l.q[1]); attitudeDataLine.addQ3(b, l.q[2]); attitudeDataLine.addQc(b, l.q[3]);
      if (l.av) { attitudeDataLine.addAngvelX(b, l.av[0]); attitudeDataLine.addAngvelY(b, l.av[1]); attitudeDataLine.addAngvelZ(b, l.av[2]); }
      return attitudeDataLine.endattitudeDataLine(b);
    });
    const lines = AEMSegment.createAttitudeDataLinesVector(b, lineOffsets);
    const str = (v) => b.createString(v);
    const name = str(s.name), id = str(s.id), a = str(patch.frameA ?? s.frameA), bb = str(patch.frameB ?? s.frameB);
    const dir = str(patch.dir ?? "A2B"), time = str(patch.time ?? "TT"), type = str(patch.type ?? (s.av ? "QUATERNION/ANGVEL" : "QUATERNION"));
    const frameName = s.av ? str(patch.angvelFrame ?? "REF_FRAME_A") : null;
    AEMSegment.startAEMSegment(b);
    AEMSegment.addObjectName(b, name); AEMSegment.addObjectId(b, id); AEMSegment.addRefFrameA(b, a); AEMSegment.addRefFrameB(b, bb);
    AEMSegment.addAttitudeDir(b, dir); AEMSegment.addTimeSystem(b, time); AEMSegment.addAttitudeType(b, type);
    if (frameName) AEMSegment.addAngvelFrame(b, frameName);
    AEMSegment.addAttitudeDataLines(b, lines);
    return AEMSegment.endAEMSegment(b);
  });
  const segs = AEM.createSegmentsVector(b, segOffsets);
  const version = b.createString("2.0");
  AEM.startAEM(b);
  AEM.addCcsdsAemVers(b, version);
  AEM.addSegments(b, segs);
  AEM.finishSizePrefixedAEMBuffer(b, AEM.endAEM(b));
  return b.asUint8Array();
}

