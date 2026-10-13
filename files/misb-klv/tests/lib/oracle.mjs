// Test-only reference for a frame's ground footprint, written independently
// of src/ground.hpp: rotations as unit quaternions (Hamilton product), the ray
// expressed in local ENU, and ECEF -> geodetic by Heikkinen's closed form
// (Zhu 1993) instead of an iteration. WGS84 throughout.
const A = 6378137.0;
const F = 1 / 298.257223563;
const B = A * (1 - F);
const E2 = F * (2 - F);
const D = Math.PI / 180;

const qmul = ([w1, x1, y1, z1], [w2, x2, y2, z2]) => [
  w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
  w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
  w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
];
const axis = ([x, y, z], deg) => {
  const h = (deg * D) / 2;
  return [Math.cos(h), x * Math.sin(h), y * Math.sin(h), z * Math.sin(h)];
};
const rotate = (q, [x, y, z]) => {
  const [, rx, ry, rz] = qmul(qmul(q, [0, x, y, z]), [q[0], -q[1], -q[2], -q[3]]);
  return [rx, ry, rz];
};
// Yaw about NED down (z), then pitch about the new right (y), then roll about forward (x).
const ypr = (yaw, pitch, roll) => qmul(qmul(axis([0, 0, 1], yaw), axis([0, 1, 0], pitch)), axis([1, 0, 0], roll));

function ecef(lat, lon, h) {
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat * D) ** 2);
  return [(n + h) * Math.cos(lat * D) * Math.cos(lon * D), (n + h) * Math.cos(lat * D) * Math.sin(lon * D), (n * (1 - E2) + h) * Math.sin(lat * D)];
}

function geodetic([x, y, z]) {
  const ep2 = (A * A - B * B) / (B * B);
  const p = Math.hypot(x, y);
  const Fv = 54 * B * B * z * z;
  const G = p * p + (1 - E2) * z * z - E2 * (A * A - B * B);
  const c = (E2 * E2 * Fv * p * p) / G ** 3;
  const s = Math.cbrt(1 + c + Math.sqrt(c * c + 2 * c));
  const P = Fv / (3 * (s + 1 / s + 1) ** 2 * G * G);
  const Q = Math.sqrt(1 + 2 * E2 * E2 * P);
  const r0 = (-(P * E2 * p) / (1 + Q)) + Math.sqrt((A * A / 2) * (1 + 1 / Q) - (P * (1 - E2) * z * z) / (Q * (1 + Q)) - (P * p * p) / 2);
  const V = Math.sqrt((p - E2 * r0) ** 2 + (1 - E2) * z * z);
  const z0 = (B * B * z) / (A * V);
  return [Math.atan((z + ep2 * z0) / p) / D, Math.atan2(y, x) / D];
}

/** Corners [lon, lat] x4 (lower left, lower right, upper right, upper left), or null when a ray misses. */
export function footprint({ lat, lon, h, heading, pitch = 0, roll = 0, az, el, sroll = 0, hfov, vfov, elevation = 0 }) {
  const q = qmul(ypr(heading, pitch, roll), ypr(az, el, sroll));
  const o = ecef(lat, lon, h);
  // ENU at the platform; NED is (north, east, down).
  const north = [-Math.sin(lat * D) * Math.cos(lon * D), -Math.sin(lat * D) * Math.sin(lon * D), Math.cos(lat * D)];
  const east = [-Math.sin(lon * D), Math.cos(lon * D), 0];
  const up = [Math.cos(lat * D) * Math.cos(lon * D), Math.cos(lat * D) * Math.sin(lon * D), Math.sin(lat * D)];
  const th = Math.tan((hfov * D) / 2);
  const tv = Math.tan((vfov * D) / 2);
  const out = [];
  // Image lower left, lower right, upper right, upper left (sensor y right, z down).
  for (const [y, z] of [[-th, tv], [th, tv], [th, -tv], [-th, -tv]]) {
    const [n, e, d] = rotate(q, [1, y, z]);
    const dir = [0, 1, 2].map((i) => n * north[i] + e * east[i] - d * up[i]);
    const a = A + elevation;
    const b = B + elevation;
    const qa = (dir[0] ** 2 + dir[1] ** 2) / a ** 2 + dir[2] ** 2 / b ** 2;
    const qb = 2 * ((o[0] * dir[0] + o[1] * dir[1]) / a ** 2 + (o[2] * dir[2]) / b ** 2);
    const qc = (o[0] ** 2 + o[1] ** 2) / a ** 2 + o[2] ** 2 / b ** 2 - 1;
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return null;
    const t = (-qb - Math.sqrt(disc)) / (2 * qa);
    if (t <= 0) return null;
    const [hl, ho] = geodetic([0, 1, 2].map((i) => o[i] + t * dir[i]));
    out.push(ho, hl);
  }
  return out;
}
