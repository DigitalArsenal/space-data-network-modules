// SDS FlatBuffers for the tests: $SBC (a draft without generated JS bindings) is written from and read back to JSON by
// flatc (flatc-wasm, the same compiler the build uses) against the schema files of SPACE_DATA_STANDARDS_ROOT; $OCM is
// read with the standard's own generated JS bindings, so its doubles are compared bit for bit.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import createFlatc from "flatc-wasm/module";

export const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT
  ?? path.dirname(createRequire(import.meta.url).resolve("spacedatastandards.org/package.json"));

const flatc = await createFlatc({ print: () => {}, printErr: () => {} });
const mkdir = (dir) => { try { flatc.FS.mkdir(dir); } catch { /* present */ } };
mkdir("/schemas"); mkdir("/work");
const mounted = new Set();
function mount(family) {
  if (mounted.has(family)) return;
  mounted.add(family);
  const text = fs.readFileSync(path.join(STANDARDS_ROOT, "schema", family, "main.fbs"), "utf8");
  mkdir(`/schemas/${family}`);
  flatc.FS.writeFile(`/schemas/${family}/main.fbs`, text);
  for (const m of text.matchAll(/^\s*include\s+"\.\.\/([A-Z0-9_]+)\/main\.fbs";/gm)) mount(m[1]);
}

/** JSON (flatc's text form) -> FlatBuffer bytes of `family`. */
export function encode(family, object) {
  mount(family);
  flatc.FS.writeFile("/work/in.json", JSON.stringify(object));
  const rc = flatc.callMain(["-b", "-I", "/schemas", "-o", "/work", `/schemas/${family}/main.fbs`, "/work/in.json"]);
  if (rc !== 0) throw new Error(`flatc could not encode ${family}`);
  return new Uint8Array(flatc.FS.readFile("/work/in.bin"));
}

/** FlatBuffer bytes of `family` -> its JSON text form (flatc prints doubles to 12 significant digits, the legacy JSON's). */
export function decode(family, bytes) {
  mount(family);
  flatc.FS.writeFile("/work/out.bin", bytes);
  const rc = flatc.callMain(["--json", "--strict-json", "--raw-binary", "--defaults-json", "-I", "/schemas", "-o", "/work",
    `/schemas/${family}/main.fbs`, "--", "/work/out.bin"]);
  if (rc !== 0) throw new Error(`flatc could not decode ${family}`);
  return JSON.parse(flatc.FS.readFile("/work/out.json", { encoding: "utf8" }));
}

export const loadBindings = async (family) => import(pathToFileURL(path.join(STANDARDS_ROOT, "lib", "js", family, "main.js")).href);
export const flatbuffers = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js")).href);

// flatc's JSON prints doubles in fixed notation (values under 1e-12 read as 0), so $SBC diagnostics are read in place
// with the flatbuffers runtime by the schema's field slots (SBC/main.fbs field order), every double bit for bit.
const slot = (bb, table, index) => bb.__offset(table, 4 + 2 * index);
const str = (bb, t, i) => { const o = slot(bb, t, i); return o ? bb.__string(t + o) : null; };
const f64 = (bb, t, i, def = 0) => { const o = slot(bb, t, i); return o ? bb.readFloat64(t + o) : def; };
const u32 = (bb, t, i) => { const o = slot(bb, t, i); return o ? bb.readUint32(t + o) : 0; };
const u8 = (bb, t, i) => { const o = slot(bb, t, i); return o ? bb.readUint8(t + o) : 0; };
const vec = (bb, t, i, read) => {
  const o = slot(bb, t, i);
  if (!o) return [];
  const start = bb.__vector(t + o);
  return Array.from({ length: bb.__vector_len(t + o) }, (_, k) => read(start, k));
};
export const SBC_CONTRIBUTOR = Object.freeze({ Unspecified: 0, DirectCovariance: 1, ElementSetSeries: 2, SensorBias: 3, ModelTerm: 4 });

export function readSbcDiagnostics(bytes) {
  const bb = new flatbuffers.ByteBuffer(bytes);
  if (!bb.__has_identifier("$SBC")) throw new Error("not an $SBC");
  const root = bb.readInt32(bb.position()) + bb.position();
  const so = slot(bb, root, 1);
  if (!so) return null;
  const d = bb.__indirect(root + so);
  return {
    OBJECT_ID: str(bb, d, 0),
    EPOCH: str(bb, d, 1),
    REFERENCE_FRAME: str(bb, d, 2),
    PROVIDER: str(bb, d, 3),
    STATUS: str(bb, d, 4),
    CONTRIBUTORS: vec(bb, d, 5, (s, k) => bb.readUint8(s + k)),
    CONTRIBUTIONS: vec(bb, d, 6, (s, k) => {
      const c = bb.__indirect(s + 4 * k);
      return { KIND: u8(bb, c, 0), SENSOR_ID: str(bb, c, 1) ?? "", COUNT: u32(bb, c, 2), RADIAL_VARIANCE_M2: f64(bb, c, 3),
        IN_TRACK_VARIANCE_M2: f64(bb, c, 4), CROSS_TRACK_VARIANCE_M2: f64(bb, c, 5), VELOCITY_VARIANCE_M2_S2: f64(bb, c, 6) };
    }),
    POSITION_SIGMA_RTN_M: vec(bb, d, 7, (s, k) => bb.readFloat64(s + 8 * k)),
    VELOCITY_SIGMA_RTN_M_S: vec(bb, d, 8, (s, k) => bb.readFloat64(s + 8 * k)),
    COVARIANCE_LOWER_TRIANGLE: vec(bb, d, 9, (s, k) => bb.readFloat64(s + 8 * k)),
    POSITION_COVARIANCE_KM2: vec(bb, d, 10, (s, k) => bb.readFloat64(s + 8 * k)),
    ELLIPSOID_SIGMA_LEVEL: f64(bb, d, 11, 1),
    ELLIPSOID_SEMI_AXES_M: vec(bb, d, 12, (s, k) => bb.readFloat64(s + 8 * k)),
    ASSUMPTIONS: vec(bb, d, 13, (s, k) => bb.__string(s + 4 * k)),
  };
}
