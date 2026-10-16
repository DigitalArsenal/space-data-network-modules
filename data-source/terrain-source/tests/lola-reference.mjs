// AN INDEPENDENT READING OF THE PDS LOLA GRIDDED PRODUCTS (test oracle only; never imported by shipped code), written
// from the PDS documents rather than from the module:
//   SIMPLE CYLINDRICAL (the product label): pixel-registered, line = (90 - lat) * ppd - 0.5, sample = lon_E * ppd - 0.5;
//   POLAR STEREOGRAPHIC (catalog/dsmap_polar.cat): r = 2 R tan((90 - |lat|)/2), sample = c + r sin(lon)/s, line =
//   c - r cos(lon)/s in the south (c = N/2 - 0.5, s = MAP_SCALE), "longitude 0 straight up, 90 E to the right".
// Shared by tests/pds-img.test.mjs and tests/moon-rdr-residual.test.mjs. Heights in metres above 1737.4 km.

import fs from "node:fs";

import { MOON_RADIUS_M } from "../lola-frames.mjs";

const R = MOON_RADIUS_M;
const LOLA_DIR = process.env.LOLA_DIR;

// A product read in place: float32 km per post, row-major.
export function product(name, n, lines) {
  const fd = fs.openSync(`${LOLA_DIR}/${name}.img`, "r");
  const cache = new Map();
  const line = (j) => {
    if (!cache.has(j)) {
      const buf = Buffer.alloc(n * 4);
      fs.readSync(fd, buf, 0, buf.length, j * n * 4);
      cache.set(j, buf);
    }
    return cache.get(j);
  };
  const at = (j, i) => line(j).readFloatLE(i * 4) * 1000;
  return { n, lines, at, close: () => fs.closeSync(fd) };
}
export const bilinear = (p, s, l, wrap = false) => {
  const i0 = Math.floor(s), j0 = Math.floor(l), fx = s - i0, fy = l - j0;
  const col = (i) => (wrap ? ((i % p.n) + p.n) % p.n : i);
  const g = (j, i) => p.at(j, col(i));
  return (1 - fy) * ((1 - fx) * g(j0, i0) + fx * g(j0, i0 + 1)) + fy * ((1 - fx) * g(j0 + 1, i0) + fx * g(j0 + 1, i0 + 1));
};
export const cylindrical = (p, ppd) => (lat, lon) => bilinear(p, (((lon % 360) + 360) % 360) * ppd - 0.5, (90 - lat) * ppd - 0.5, true);
export function polar(p, scale, south) {
  const c = p.n / 2 - 0.5;
  return (lat, lon) => {
    const r = (2 * R * Math.tan(((90 - Math.abs(lat)) * Math.PI) / 360)) / scale;
    const a = (lon * Math.PI) / 180;
    return bilinear(p, c + r * Math.sin(a), south ? c - r * Math.cos(a) : c + r * Math.cos(a));
  };
}

