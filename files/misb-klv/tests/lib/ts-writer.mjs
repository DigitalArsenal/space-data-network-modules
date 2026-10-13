// Test-only writers: MPEG-2 transport streams (ISO/IEC 13818-1) around an
// H.264 elementary stream, and MISB ST 0601 UAS Local Set packets from stated
// values (the standard's linear mappings, quantized the way an encoder must).

const UAS_KEY = [0x06, 0x0e, 0x2b, 0x34, 0x02, 0x0b, 0x01, 0x01, 0x0e, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00];

function ber(n) {
  if (n < 128) return [n];
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function beBytes(value, n) {
  const out = [];
  let v = BigInt.asUintN(8 * n, BigInt(value));
  for (let i = 0; i < n; i++) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}

const unsignedInt = (value, n, range, offset = 0) => Math.round(((value - offset) * (2 ** (8 * n) - 1)) / range);
const signedInt = (value, n, range) => Math.round((value * (2 ** (8 * n) - 2)) / range);

/** The value an ST 0601 decoder reads back from the quantized integer (the test's expectation). */
export const quantized = {
  unsigned: (value, n, range, offset = 0) => (unsignedInt(value, n, range, offset) * range) / (2 ** (8 * n) - 1) + offset,
  signed: (value, n, range) => (signedInt(value, n, range) * range) / (2 ** (8 * n) - 2),
};

const FIELDS = {
  heading: [5, (v) => beBytes(unsignedInt(v, 2, 360), 2)],
  pitch: [6, (v) => beBytes(signedInt(v, 2, 40), 2)],
  roll: [7, (v) => beBytes(signedInt(v, 2, 100), 2)],
  sensorLat: [13, (v) => beBytes(signedInt(v, 4, 180), 4)],
  sensorLon: [14, (v) => beBytes(signedInt(v, 4, 360), 4)],
  sensorAltMsl: [15, (v) => beBytes(unsignedInt(v, 2, 19900, -900), 2)],
  hfov: [16, (v) => beBytes(unsignedInt(v, 2, 180), 2)],
  vfov: [17, (v) => beBytes(unsignedInt(v, 2, 180), 2)],
  sensorAz: [18, (v) => beBytes(unsignedInt(v, 4, 360), 4)],
  sensorEl: [19, (v) => beBytes(signedInt(v, 4, 360), 4)],
  sensorRoll: [20, (v) => beBytes(unsignedInt(v, 4, 360), 4)],
  centerLat: [23, (v) => beBytes(signedInt(v, 4, 180), 4)],
  centerLon: [24, (v) => beBytes(signedInt(v, 4, 360), 4)],
  centerElev: [25, (v) => beBytes(unsignedInt(v, 2, 19900, -900), 2)],
  sensorAltHae: [75, (v) => beBytes(unsignedInt(v, 2, 19900, -900), 2)],
  pitchFull: [90, (v) => beBytes(signedInt(v, 4, 180), 4)],
  rollFull: [91, (v) => beBytes(signedInt(v, 4, 180), 4)],
};

/**
 * One ST 0601 packet. `values` names fields above, plus `timestampUs`
 * (BigInt or number), `platform`, `sensor`, `offsets` ([[dLat, dLon] x4,
 * points 1-4]), `corners` ([[lat, lon] x4, points 1-4]) and `rawError`
 * (tag -> true, to send the field's error value). `badChecksum` corrupts tag 1.
 */
export function st0601(values, { badChecksum = false } = {}) {
  const items = [];
  const item = (tag, bytes) => items.push(tag, ...ber(bytes.length), ...bytes);
  if (values.timestampUs !== undefined) item(2, beBytes(values.timestampUs, 8));
  if (values.platform) item(10, [...Buffer.from(values.platform, "utf8")]);
  if (values.sensor) item(11, [...Buffer.from(values.sensor, "utf8")]);
  for (const [name, [tag, encode]] of Object.entries(FIELDS)) {
    if (values.rawError?.[tag]) item(tag, tag === 26 ? [0x80, 0x00] : [0x80, 0x00, 0x00, 0x00].slice(0, encode(0).length));
    else if (values[name] !== undefined) item(tag, encode(values[name]));
  }
  values.offsets?.forEach(([dLat, dLon], k) => {
    item(26 + 2 * k, values.rawError?.[26 + 2 * k] ? [0x80, 0x00] : beBytes(signedInt(dLat, 2, 0.15), 2));
    item(27 + 2 * k, beBytes(signedInt(dLon, 2, 0.15), 2));
  });
  values.corners?.forEach(([lat, lon], k) => {
    item(82 + 2 * k, beBytes(signedInt(lat, 4, 180), 4));
    item(83 + 2 * k, beBytes(signedInt(lon, 4, 360), 4));
  });
  if (values.version !== undefined) item(65, [values.version]);
  const body = [...items, 1, 2];
  const head = [...UAS_KEY, ...ber(body.length + 2)];
  const covered = [...head, ...body];
  let bcc = 0;
  covered.forEach((b, i) => (bcc = (bcc + (b << (8 * ((i + 1) % 2)))) & 0xffff));
  if (badChecksum) bcc ^= 0x5a5a;
  return Uint8Array.from([...covered, bcc >> 8, bcc & 0xff]);
}

// ── transport stream ──────────────────────────────────────────────────────
function crc32mpeg(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

function section(tableId, idExt, body) {
  const length = 5 + body.length + 4;
  const s = [tableId, 0xb0 | ((length >> 8) & 0x0f), length & 0xff, idExt >> 8, idExt & 0xff, 0xc1, 0, 0, ...body];
  const crc = crc32mpeg(s);
  return [0, ...s, crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
}

function timestamp(prefix, t) {
  const v = BigInt.asUintN(33, BigInt(t));
  return [
    (prefix << 4) | Number((v >> 29n) & 0x0en) | 1,
    Number((v >> 22n) & 0xffn),
    Number((v >> 14n) & 0xfen) | 1,
    Number((v >> 7n) & 0xffn),
    Number((v << 1n) & 0xfen) | 1,
  ];
}

function pes(streamId, payload, pts, dts) {
  const header = [];
  let flags = 0;
  if (pts !== undefined && dts !== undefined && dts !== pts) {
    flags = 0xc0;
    header.push(...timestamp(3, pts), ...timestamp(1, dts));
  } else if (pts !== undefined) {
    flags = 0x80;
    header.push(...timestamp(2, pts));
  }
  const length = 3 + header.length + payload.length;
  return Uint8Array.from([0, 0, 1, streamId, length > 0xffff ? 0 : length >> 8, length > 0xffff ? 0 : length & 0xff, 0x80, flags, header.length, ...header, ...payload]);
}

/** H.264 access units, split at each access unit delimiter (NAL type 9). */
export function accessUnits(annexB) {
  const starts = [];
  for (let i = 0; i + 4 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1 && (annexB[i + 3] & 0x1f) === 9) starts.push(i > 0 && annexB[i - 1] === 0 ? i - 1 : i);
  }
  return starts.map((s, k) => annexB.subarray(s, k + 1 < starts.length ? starts[k + 1] : annexB.length));
}

/**
 * A transport stream: `units` [{ bytes, pts, dts }] of H.264, `klv`
 * [{ bytes, pts }] (pts undefined for an asynchronous stream), packets of 188
 * bytes or 192 (M2TS), PIDs 0x100 video and 0x101 metadata.
 */
export function transportStream({ units, klv = [], asyncKlv = false, m2ts = false }) {
  const packets = [];
  const cc = new Map();
  const emit = (pid, bytes, start) => {
    for (let at = 0, first = true; at < bytes.length || first; first = false) {
      const counter = cc.get(pid) ?? 0;
      cc.set(pid, (counter + 1) & 0x0f);
      const room = 184;
      const chunk = bytes.subarray(at, at + room);
      at += chunk.length;
      const head = [0x47, ((first && start) ? 0x40 : 0) | (pid >> 8), pid & 0xff];
      let packet;
      if (chunk.length === room) packet = [...head, 0x10 | counter, ...chunk];
      else {
        const stuffing = room - chunk.length - 1;
        const adaptation = stuffing > 0 ? [stuffing, 0x00, ...new Array(stuffing - 1).fill(0xff)] : [0];
        packet = [...head, 0x30 | counter, ...adaptation, ...chunk];
      }
      if (m2ts) packet = [0, 0, 0, 0, ...packet];
      packets.push(...packet);
      if (at >= bytes.length) break;
    }
  };
  emit(0, Uint8Array.from(section(0x00, 1, [0, 1, 0xe0 | 0x10, 0x00])), true);
  const klvEs = asyncKlv ? [0x06, 0xe1, 0x01, 0xf0, 0x06, 0x05, 0x04, 0x4b, 0x4c, 0x56, 0x41] : [0x15, 0xe1, 0x01, 0xf0, 0x00];
  emit(0x1000, Uint8Array.from(section(0x02, 1, [0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, ...klvEs])), true);
  let k = 0;
  units.forEach((unit, i) => {
    emit(0x100, pes(0xe0, unit.bytes, unit.pts, unit.dts), true);
    // Metadata follows its frame (asynchronous metadata has no time of its own).
    while (k < klv.length && (klv[k].after ?? k) <= i) {
      const cell = asyncKlv ? klv[k].bytes : Uint8Array.from([0, k & 0xff, 0xdf, klv[k].bytes.length >> 8, klv[k].bytes.length & 0xff, ...klv[k].bytes]);
      emit(0x101, pes(asyncKlv ? 0xbd : 0xfc, cell, asyncKlv ? undefined : klv[k].pts), true);
      k += 1;
    }
  });
  return Uint8Array.from(packets);
}
