// THE PUBLISHED SURFACE AGAINST THE LASER SHOTS THEMSELVES (moon-terrain-lane-20261013 acceptance: "gridding residual
// vs LOLA RDR shots: global RMS <= 25 m, >= 85 deg RMS <= 6 m").
//
// Every valid spot of a set of LOLA RDR orbit files (the geolocated shots the gridded products were made from, so
// the check is NOT independent of them, as the acceptance says) is compared with:
//   * the MESH the lane publishes there - the tile of the deepest level the walk builds at the shot (L7 globally, L10
//     south of -85.08, L9 north of 85), encoded by the real lane (terrain-ingest:lola_plan -> terrain-source:tile on
//     the local PDS products) and interpolated on its own triangles;
//   * the GRIDDED PRODUCT that level reads (LDEM_64, LDEM_75S_60M, LDEM_75N_120M), bilinear, through the independent
//     reading in lola-reference.mjs.
// The mesh figure is the one judged: it is the gridding residual plus the mesh's own departure from the grid, i.e.
// what a user sees. The decoding and interpolation here are a test oracle written from the quantized-mesh spec; no
// shipped code imports them.
//
// THE SHOTS (LOLARDR_*.DAT, PDS3 fixed 256-byte records, per the product's PDS4 label): spot k = 1..5 at byte
// 40 (k-1) + 40: longitude and latitude int32 1e-7 deg (planetocentric, missing -2^31), radius int32 mm (missing -1),
// and at +36 a uint32 shot flag whose low byte must be 0 for a valid range. Height = radius - 1737.4 km.
// Every valid spot at |lat| >= 85 is used; elsewhere every tenth record (the files are 28 Hz along track).
//
// Needs LOLA_DIR (the gridded products) and LOLA_RDR_DIR (lolardr_*.dat from
// https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_rdr/); skipped without. Measured
// 2026-10-16 on the tenth file of each of lro_no_01/03/05/07/09/11/13, lro_sm_05/15/25 and lro_es_10/40/80 (13 orbits,
// 2009-2019): mesh RMS 24.53 m global (L7), 2.33 m >= 85 S (L9-10), 3.95 m >= 85 N (L9); the gridded products alone
// 20.50, 1.75 and 2.32 m.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { decodeQuantizedMesh } from "./helpers.mjs";
import { cylindrical, polar, product } from "./lola-reference.mjs";
import { MOON_RADIUS_M } from "../lola-frames.mjs";
import { createMoonLane, dttOf } from "../tools/moon-lane.mjs";

const LOLA_DIR = process.env.LOLA_DIR;
const RDR_DIR = process.env.LOLA_RDR_DIR;
const rdrFiles = RDR_DIR && fs.existsSync(RDR_DIR) ? fs.readdirSync(RDR_DIR).filter((f) => /^lolardr_\d+\.dat$/i.test(f)).sort() : [];
const skip = !(LOLA_DIR && fs.existsSync(`${LOLA_DIR}/ldem_64_float.img`) && rdrFiles.length) && "LOLA_DIR / LOLA_RDR_DIR unset";

// ── the shots ───────────────────────────────────────────────────────────────
function readShots(file) {
  const buf = fs.readFileSync(file);
  const lat = [], lon = [], h = [], sampled = [];
  for (let r = 0; r + 256 <= buf.length; r += 256) {
    const record = r / 256;
    for (let k = 0; k < 5; k++) {
      const at = r + 40 + 40 * k;
      const lonE7 = buf.readInt32LE(at), latE7 = buf.readInt32LE(at + 4), mm = buf.readInt32LE(at + 8);
      if (lonE7 === -2147483648 || latE7 === -2147483648 || mm === -1) continue;
      if ((buf.readUInt32LE(at + 36) & 0xff) !== 0) continue;
      const la = latE7 / 1e7;
      if (Math.abs(la) < 85 && record % 10 !== 0) continue;
      let lo = lonE7 / 1e7;
      if (lo >= 180) lo -= 360;
      lat.push(la);
      lon.push(lo);
      h.push(mm / 1000 - MOON_RADIUS_M);
      sampled.push(record % 10 === 0);
    }
  }
  return { lat, lon, h, sampled };
}

// ── a decoded tile as a surface ─────────────────────────────────────────────
function surfaceOf(sized) {
  const t = dttOf(sized.subarray(4)).unpack();
  const mesh = decodeQuantizedMesh(zlib.gunzipSync(Buffer.from(t.PAYLOAD.BYTES)));
  const q = (mesh.header.maxHeight - mesh.header.minHeight) / 32767;
  const H = mesh.h.map((x) => mesh.header.minHeight + x * q);
  const B = 64, cell = 32768 / B, buckets = Array.from({ length: B * B }, () => []);
  for (let k = 0; k < mesh.indices.length; k += 3) {
    const tri = [mesh.indices[k], mesh.indices[k + 1], mesh.indices[k + 2]];
    const us = tri.map((i) => mesh.u[i]), vs = tri.map((i) => mesh.v[i]);
    for (let r = Math.floor(Math.min(...vs) / cell); r <= Math.floor(Math.max(...vs) / cell); r++) {
      for (let c = Math.floor(Math.min(...us) / cell); c <= Math.floor(Math.max(...us) / cell); c++) buckets[r * B + c].push(tri);
    }
  }
  return (lat, lon) => {
    const u = Math.min(32767, Math.max(0, ((lon - t.WEST_DEG) / (t.EAST_DEG - t.WEST_DEG)) * 32767));
    const v = Math.min(32767, Math.max(0, ((lat - t.SOUTH_DEG) / (t.NORTH_DEG - t.SOUTH_DEG)) * 32767));
    let best = -Infinity, value = NaN;
    for (const [a, b, c] of buckets[Math.floor(v / cell) * B + Math.floor(u / cell)]) {
      const det = (mesh.v[b] - mesh.v[c]) * (mesh.u[a] - mesh.u[c]) + (mesh.u[c] - mesh.u[b]) * (mesh.v[a] - mesh.v[c]);
      const wa = ((mesh.v[b] - mesh.v[c]) * (u - mesh.u[c]) + (mesh.u[c] - mesh.u[b]) * (v - mesh.v[c])) / det;
      const wb = ((mesh.v[c] - mesh.v[a]) * (u - mesh.u[c]) + (mesh.u[a] - mesh.u[c]) * (v - mesh.v[c])) / det;
      const wc = 1 - wa - wb, inside = Math.min(wa, wb, wc);
      if (inside > best) { best = inside; value = wa * H[a] + wb * H[b] + wc * H[c]; }
      if (inside >= 0) break;
    }
    return value;
  };
}

// ── the zones, the deepest level built at a shot, the product that level reads ──
const tileAt = (level, lat, lon) => {
  const size = 180 / 2 ** level;
  return `${level}/${Math.min(2 ** (level + 1) - 1, Math.floor((lon + 180) / size))}/${Math.min(2 ** level - 1, Math.floor((lat + 90) / size))}`;
};
function stats(residuals) {
  const n = residuals.length, abs = residuals.map(Math.abs).sort((a, b) => a - b);
  const rms = Math.sqrt(residuals.reduce((s, x) => s + x * x, 0) / n), mean = residuals.reduce((s, x) => s + x, 0) / n;
  return { shots: n, rmsM: +rms.toFixed(2), meanM: +mean.toFixed(2), p99AbsM: +abs[Math.floor(0.99 * (n - 1))].toFixed(1) };
}

test("the published Moon mesh meets the LOLA shots: global RMS <= 25 m, poleward of 85 degrees RMS <= 6 m", { skip, timeout: 3_600_000 }, async (t) => {
  const lane = await createMoonLane({ lolaDir: LOLA_DIR });
  t.after(() => lane.destroy());
  // Which unit of the walk builds each tile.
  const unitOf = new Map();
  for (let i = 0; ; i++) {
    const unit = await lane.planUnit(i);
    if (!unit) break;
    for (const hd of unit.headers) unitOf.set(`${hd.level}/${hd.x}/${hd.y}`, i);
  }
  const zones = ["global", "south85", "north85"];
  const shots = [];  // {zone, key, lat, lon, h}
  for (const f of rdrFiles) {
    const s = readShots(path.join(RDR_DIR, f));
    for (let i = 0; i < s.h.length; i++) {
      const [lat, lon, h] = [s.lat[i], s.lon[i], s.h[i]];
      // Global: L7 at every tenth record, whatever the latitude.
      if (s.sampled[i]) shots.push({ zone: "global", key: tileAt(7, lat, lon), lat, lon, h });
      // Poleward of 85: every shot, on the deepest level the walk builds there.
      if (Math.abs(lat) >= 85) {
        for (let level = 10; level > 7; level--) {
          const key = tileAt(level, lat, lon);
          if (unitOf.has(key)) { shots.push({ zone: lat < 0 ? "south85" : "north85", key, lat, lon, h }); break; }
        }
      }
    }
  }
  // Encode every tile a shot falls in, unit by unit, and evaluate.
  const byUnit = new Map();
  for (const s of shots) {
    const u = unitOf.get(s.key);
    if (!byUnit.has(u)) byUnit.set(u, new Map());
    if (!byUnit.get(u).has(s.key)) byUnit.get(u).set(s.key, []);
    byUnit.get(u).get(s.key).push(s);
  }
  for (const [index, tiles] of byUnit) {
    const unit = await lane.planUnit(index);
    const { response, byKey } = await lane.encode(unit, (k) => tiles.has(k));
    assert.equal(response.statusCode, 0, response.errorMessage);
    for (const [key, list] of tiles) {
      const at = surfaceOf(byKey.get(key));
      for (const s of list) s.mesh = at(s.lat, s.lon);
    }
  }
  // The gridded products those levels read.
  const ldem64 = product("ldem_64_float", 23040, 11520), south60 = product("ldem_75s_60m_float", 15248, 15248);
  const north120 = product("ldem_75n_120m_float", 7624, 7624);
  const grid = { global: cylindrical(ldem64, 64), south85: polar(south60, 60, true), north85: polar(north120, 120, false) };
  const report = {};
  for (const zone of zones) {
    const z = shots.filter((s) => s.zone === zone);
    report[zone] = {
      levels: [...new Set(z.map((s) => s.key.split("/")[0]))].join(","),
      mesh: stats(z.map((s) => s.h - s.mesh)),
      grid: stats(z.map((s) => s.h - grid[zone](s.lat, s.lon))),
    };
  }
  [ldem64, south60, north120].forEach((p) => p.close());
  t.diagnostic(`${rdrFiles.length} RDR orbit files: ${JSON.stringify(report)}`);
  for (const zone of zones) assert.ok(report[zone].mesh.shots > 1000, `${zone}: ${report[zone].mesh.shots} shots`);
  assert.ok(report.global.mesh.rmsM <= 25, `global RMS ${report.global.mesh.rmsM} m`);
  assert.ok(report.south85.mesh.rmsM <= 6, `>= 85 S RMS ${report.south85.mesh.rmsM} m`);
  assert.ok(report.north85.mesh.rmsM <= 6, `>= 85 N RMS ${report.north85.mesh.rmsM} m`);
});
