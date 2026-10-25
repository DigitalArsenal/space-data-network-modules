#!/usr/bin/env node
// Builds dist/isomorphic/module.wasm through the module SDK's compiler lane:
// clang --target=wasm32-wasip1-threads over a shared imported memory (the
// SDK's "emscripten-pthreads" thread model is the wasi-threads contract, never
// emcc -pthread), -fno-exceptions (WasmEdge 0.16.4 AOT rejects WebAssembly
// exception handling). One translation unit: src/*.inc parts are inlined where
// they are included, the propagator ABI header comes from the pinned SDK, and
// the $OMM vtable slots are derived from the pinned SDS catalog.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
// NRLMSISE-00, ERFA and the gravity coefficients are read from this repository (propagator/sdn-ap sits two levels
// below its root); SPACE_DATA_NETWORK_MODULES_ROOT names another checkout
const modulesRoot = path.resolve(packageRoot, "..", "..");
// a source inside this checkout as a repository path in dist/build-provenance.txt; others as given
const shownPath = (p) => {
  const r = path.relative(modulesRoot, p);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : p;
};
const require = createRequire(path.join(packageRoot, "package.json"));
const { compileModuleFromSource, ModuleThreadModel, protectModuleArtifact } =
  await import("space-data-module-sdk/compiler");
const standards = await import("space-data-module-sdk/standards");
const { FlatcRunner } = await import("flatc-wasm");
const sdsRoot = path.dirname(require.resolve("spacedatastandards.org/package.json"));

// C++ bindings of $OEM (propagate's output, fit's input), $OMM (fit's output)
// and the schemas they include, generated from the pinned SDS package in
// dependency order.
async function oemBindings() {
  const files = {};
  const deps = new Map();
  const pending = ["OEM", "OMM", "SPW", "DCL", "PRW", "OBD", "MNV", "RDM", "LAM", "BOV"];
  while (pending.length) {
    const code = pending.pop();
    if (deps.has(code)) continue;
    const text = await fs.readFile(path.join(sdsRoot, "schema", code, "main.fbs"), "utf8");
    files[`/sds/${code}/main.fbs`] = text;
    const includes = [...text.matchAll(/include "\.\.\/([A-Z0-9]+)\/main\.fbs"/g)].map((m) => m[1]);
    deps.set(code, includes);
    pending.push(...includes);
  }
  const order = [];
  const visit = (code) => {
    if (order.includes(code)) return;
    for (const dep of deps.get(code)) visit(dep);
    order.push(code);
  };
  for (const code of ["OEM", "OMM", "SPW", "DCL", "PRW", "OBD", "MNV", "RDM", "LAM", "BOV"]) visit(code);
  const flatc = await FlatcRunner.init();
  return order
    .map((code) => {
      const generated = flatc.generateCode({ entry: `/sds/${code}/main.fbs`, files }, "cpp", { genObjectApi: false })["main_generated.h"];
      if (!generated) throw new Error(`flatc produced no ${code} C++ header`);
      return generated
        .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_SDS_${code}_MAIN_H_`)
        .replace(/^#include "main_generated\.h"\s*$/gm, "");
    })
    .join("\n");
}

const abiHeader = await fs.readFile(
  require.resolve("space-data-module-sdk/include/orbpro/orbpro_propagator_abi.h"),
  "utf8",
);

// $OMM vtable slots (4 + 2 * declaration index) from the pinned catalog: a
// field missing from the schema fails the build instead of reading garbage.
const OMM_FIELDS = [
  "MEAN_ELEMENT_THEORY", "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION",
  "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "NORAD_CAT_ID",
  "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT",
];
async function ommSlots() {
  const loader = standards.loadStandardsCatalog ?? standards.resolveStandardsCatalog ?? standards.getStandardsCatalog;
  const loaded = await loader();
  const catalog = Array.isArray(loaded) ? loaded : loaded.catalog;
  const entry = catalog.find((candidate) => candidate.fileIdentifier === "$OMM");
  if (!entry) throw new Error("the pinned SDS catalog has no $OMM entry");
  const text = entry.idl.replace(/\/\/.*$/gm, "");
  const unions = new Set([...text.matchAll(/union\s+(\w+)/g)].map((m) => m[1]));
  const body = /table\s+OMM\s*\{([\s\S]*?)\}/.exec(text);
  if (!body) throw new Error("table OMM is not in the pinned $OMM IDL");
  const declared = [];
  for (const match of body[1].matchAll(/([A-Za-z_]\w*)\s*:\s*\[?\s*([A-Za-z_][\w.]*)/g)) {
    if (unions.has(match[2])) declared.push(`${match[1]}_type`);
    declared.push(match[1]);
  }
  const lines = [`// GENERATED from the pinned SDS $OMM ${entry.version}`];
  for (const name of OMM_FIELDS) {
    const index = declared.indexOf(name);
    if (index < 0) throw new Error(`$OMM ${entry.version} declares no ${name}; refusing to build`);
    lines.push(`#define SDNAP_OMM_VT_${name} ${4 + 2 * index}`);
  }
  return lines.join("\n");
}

// NRLMSISE-00 (SDN-AP drag, DESIGN 2a): the public-domain Brodowski C port the FFM truth uses, read from the open
// modules repository's vendored copy (the stack submodule path; this repository vendors nothing) and PINNED: every file
// must match the SHA-256 recorded here (the copy at modules commit 75fd4d9d), or the build fails. The path and the
// hashes are written to dist/build-provenance.txt.
const NRLMSISE_PIN = Object.freeze({
  modulesCommit: "75fd4d9d29c8332e43c5daa443fd6cd77f9ecd17",
  files: Object.freeze({
    "nrlmsise-00.h": "22eb2ced40595717ef0b73044995e5613aabc8755ed6c43642bfd74335b55535",
    "nrlmsise-00_data.c": "d0b3022f3c3e7ffdf703cc0e0d02339dfee01c0bf1520b29c68d5f4afd8784d5",
    "nrlmsise-00.c": "606dcbd1f31a712c31fdbfaa25d992b03a560eda296b1f5b18ba0479f6ca3b1a",
  }),
});
const provenance = { nrlmsise00: null, erfa: null, table6: null, gravity: null, lunar: null };
async function nrlmsise() {
  const modules = process.env.SPACE_DATA_NETWORK_MODULES_ROOT ?? modulesRoot;
  const dir = process.env.SDNAP_NRLMSISE_DIR ?? path.join(modules, "third_party", "nrlmsise00");
  const text = {};
  const hashes = {};
  for (const [name, want] of Object.entries(NRLMSISE_PIN.files)) {
    const bytes = await fs.readFile(path.join(dir, name));
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want) throw new Error(`NRLMSISE-00 pin: ${path.join(dir, name)} has sha256 ${got}, expected ${want} (modules ${NRLMSISE_PIN.modulesCommit})`);
    hashes[name] = got;
    text[name] = bytes.toString("utf8");
  }
  let checkoutHead = null;
  try {
    checkoutHead = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    checkoutHead = null;
  }
  provenance.nrlmsise00 = { source: shownPath(dir), pinnedModulesCommit: NRLMSISE_PIN.modulesCommit, checkoutHead, sha256: hashes };
  const strip = (t) => t.replace(/^#include "nrlmsise-00\.h".*$/gm, "");
  // One translation unit: the model's extern declarations of the data tables are redundant after the data file
  // (and ptm is declared shorter than it is defined); C++ needs the cast on malloc.
  const modelText = strip(text["nrlmsise-00.c"])
    .replace(/^extern double [a-z]+(\[\d+\])+;.*$/gm, "")
    .replace(/u=malloc\(/g, "u=(double *)malloc(");
  return `extern "C" {\n${text["nrlmsise-00.h"]}\n${strip(text["nrlmsise-00_data.c"])}\n${modelText}\n}\n`;
}

// ERFA (BSD-3-Clause, derived with permission from IAU SOFA; fit's GCRF input frame, IAU 2006/2000A), read from the
// open modules repository's vendored copy (higherpop/third_party/erfa, the copy foundation/frames amalgamates) and
// PINNED like NRLMSISE-00: every file used must match the SHA-256 recorded here (the copy at modules commit 7d59ae21),
// or the build fails. Compiled: the closure of eraPnm06a, eraGst06, eraUtctai and eraTaitt, numerics unmodified (the
// per-file erfa*.h includes are dropped and the headers emitted once, as foundation/frames does). The license is
// carried: LICENSES/ERFA.txt in the package and dist/LICENSES/ERFA.txt beside the module must equal the pinned
// LICENSE.txt, and dist/build-provenance.txt records it.
const ERFA_PIN = Object.freeze({
  modulesCommit: "7d59ae2171b5b57fd3b3587ff012de75b8aabb0c",
  license: Object.freeze({ spdx: "BSD-3-Clause", file: "LICENSE.txt", sha256: "556abafd66857342b5f760bc42d323d1cfea310569267d3ae316d438b075424d" }),
  headers: Object.freeze({
    "erfa.h": "9549553b95ca2fbbcdcabcc69d82fb3cdd376c28b03c2793200138ff55727088",
    "erfam.h": "0da6313033aacf9c64533a7e74be49ecda97b4aaa87e134f98287e4ff279886f",
    "erfaextra.h": "e7271743062333df52f188a6d28c29295a8cb54d5540385f3238127c4139a8e2",
    "erfadatextra.h": "8b96327cb3bd1d08b541fc0e468f5c07d9c9a1b09156e90b6756d67d5ef66361",
  }),
  sources: Object.freeze({
    "anp.c": "41f132914547ce4137edf024bc809fd7dfed3e0f5ff5b38f22313c884e8978e3",
    "bpn2xy.c": "8771bc7db7aeb18f8d9d6fc258d5a28db55e05f3345df0564b4c71a20cc01dfb",
    "cal2jd.c": "95d13243cfa6ed019cd4e1737388d97cc6be3a5e9bd99a35ea9938934d439a0f",
    "dat.c": "09e3377ff0c770372c759dc16af12aadc70975d3c549d9524e5c3dd44e24fa88",
    "eors.c": "37fbff7a76cbd22a5062205511a6c12eeef950239a0d21e81ecb420b593dabb0",
    "era00.c": "91c092c322d070305ba02873005bcb03110d7c26674fbdc7105477c50543ffb5",
    "erfadatextra.c": "7d790c3979b0e3c2102f70c3b734691434982968cffa2e13f79a415ec78021fa",
    "fad03.c": "e4f280ff76de95e9a71e19ef9aef3732fa7b04012ca23e3d43691173c66dc2dd",
    "fae03.c": "087d3cc3f175ba33db2c47b9d4ed448ca1986554449cbae0a68daa2bd91f106d",
    "faf03.c": "f58a0dc1fc1595af02e906c7d08da3e8e941a66b3ac6df9047a1718db314b3b6",
    "faju03.c": "f52443bc80596d3aa03811c54a8ea90aad4e25dea1a361aa9ea885f311815a28",
    "fal03.c": "0bc94f25a7722de16379f9311da74e9b132e9db52db4e597f7d24e9060529779",
    "falp03.c": "8ceb012c045ec672bc63cd85260c8e45d0eebf67ae09bce68d520bde625879c1",
    "fama03.c": "2e76a446a5136526778d63aa05f840538560bfc11318b71ff78716f042ed2b3a",
    "fame03.c": "661c2cbdd428cc1bd392b5d089832183a4158037f2418f1f752f702cc3d1dbfd",
    "faom03.c": "d101f54bc44c92786cc91daa9700625f17d7e83226adc9787e0fe100e148aa49",
    "fapa03.c": "26fcc8d0b26d349e0a827ea315759c92660b55baa954d4aa2f931e213173f6a0",
    "fasa03.c": "70b6c589dc1a81226d813b4db738e4409083083b4eed2b659f3e3c913ea9dc35",
    "faur03.c": "6374bdcf987b20ca2103965a05a1ecb3b5e2502b6065459d834170495fab02e3",
    "fave03.c": "8652237b8d7b6558ed911edfc55f714b519e9491a90c9f0f739f884e1693c505",
    "fw2m.c": "480d1ae7780566980b8f80f4c6daa2be330a80e99861d892dc5a9f7b11da47c0",
    "gst06.c": "29c1b62c0406485b709c71804a490bb9a821ddccc290e48b3be9512120a5589d",
    "ir.c": "55e3325cd77770315f20dfdee5e7028f56b7bfb97be966db922abcc8885091f1",
    "jd2cal.c": "f1f15f0295348efc51c3f0a43608b46cbe514d65846935b3f609406f731b1961",
    "nut00a.c": "a1538ec0277745db974ab76ca4b678a7602249bccecf9474e2b0268f9c2032ef",
    "nut06a.c": "819c36a689c28e50aaf71ec6d9774da5130df09657a07ab07520ae3712414d07",
    "obl06.c": "550260874d5e5fa3be77296b85b92c54c726fee6fbb1bb44748d04c17ffb37c2",
    "pfw06.c": "085f49861026fab98633d8479795090b3278a0d246a938ebdf10fde326ef1987",
    "pnm06a.c": "ea1814a86aad0895b6f1d5a48ef0308474df1f8fcf27abe6c0293165d8367b99",
    "rx.c": "b740bba3cce0502620662f6e667369734f6adf56064919394ae1ae3ae3e70c64",
    "rz.c": "d4ef2eb4a9744617b510c2370ba5ff5f3c0acaafb07a0eb6138c6f2128005bcc",
    "s06.c": "6ad19dd59c3150d9f065b3f76d254c1cf3adb0cb6bacd6422c1dc6b6f14122ea",
    "taitt.c": "2e235092b443057893b8cbb27cbf1bd88ab1a5f43ad42cec0ff4ae656ea3ae9a",
    "utctai.c": "6c35d07f2db4ca305270205087d41c454a211fbb2c954bf8bf10c0e99f5601d8",
  }),
});
async function erfa() {
  const modules = process.env.SPACE_DATA_NETWORK_MODULES_ROOT ?? modulesRoot;
  const dir = process.env.SDNAP_ERFA_DIR ?? path.join(modules, "higherpop", "third_party", "erfa");
  const read = async (name, want) => {
    const bytes = await fs.readFile(path.join(dir, name));
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want) throw new Error(`ERFA pin: ${path.join(dir, name)} has sha256 ${got}, expected ${want} (modules ${ERFA_PIN.modulesCommit})`);
    return bytes;
  };
  const license = await read(ERFA_PIN.license.file, ERFA_PIN.license.sha256);
  const carried = await fs.readFile(path.join(packageRoot, "LICENSES", "ERFA.txt"));
  if (!carried.equals(license)) throw new Error("LICENSES/ERFA.txt differs from the pinned ERFA LICENSE.txt");
  const local = /^#include\s+"erfa[a-z]*\.h"\s*$/gm;
  const headers = [];
  for (const [name, want] of Object.entries(ERFA_PIN.headers)) headers.push((await read(name, want)).toString("utf8").replace(local, ""));
  const bodies = [];
  for (const [name, want] of Object.entries(ERFA_PIN.sources)) bodies.push(`/* ERFA ${name} */\n${(await read(name, want)).toString("utf8").replace(local, "")}`);
  let checkoutHead = null;
  try {
    checkoutHead = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    checkoutHead = null;
  }
  provenance.erfa = {
    source: shownPath(dir),
    pinnedModulesCommit: ERFA_PIN.modulesCommit,
    checkoutHead,
    license: { spdx: ERFA_PIN.license.spdx, carried: "LICENSES/ERFA.txt", sha256: ERFA_PIN.license.sha256 },
    sha256: { ...ERFA_PIN.headers, ...ERFA_PIN.sources },
  };
  erfaLicense = license;
  return `extern "C" {\n${headers.join("\n")}\n${bodies.join("\n")}\n}\n`;
}
let erfaLicense = null;

// SR 313 Table 6 (SPEC 3.3), transcribed in src/j70_table6.inc: the canonical text rebuilt from the array must have
// this SHA-256 (one line per height, "h,v600,...,v2000\n", values as printed), or the build fails.
const TABLE6_SHA256 = "e79af1942bde529df8fcaa7f786ae073193659b7c15bda341956ffab46d46496";
async function checkTable6() {
  const text = await fs.readFile(path.join(packageRoot, "src", "j70_table6.inc"), "utf8");
  const heights = /kTable6Height\[kTable6Heights\] = \{([^}]*)\}/.exec(text)[1].split(",").map((v) => Number(v.trim()));
  const body = /kTable6\[kTable6Heights\]\[kTable6Temps\] = \{([\s\S]*?)\n\};/.exec(text)[1];
  const rows = [...body.matchAll(/\{([^}]*)\}/g)].map((m) => m[1].split(",").map((v) => Number(v.trim())));
  const grid = [90];
  for (let h = 92; h <= 110; h += 2) grid.push(h);
  for (let h = 115; h <= 160; h += 5) grid.push(h);
  for (let h = 170; h <= 400; h += 10) grid.push(h);
  for (let h = 420; h <= 1000; h += 20) grid.push(h);
  for (let h = 1050; h <= 1500; h += 50) grid.push(h);
  for (let h = 1600; h <= 2500; h += 100) grid.push(h);
  if (heights.length !== grid.length || heights.some((h, i) => h !== grid[i]) || rows.length !== 95 || rows.some((r) => r.length !== 29)) {
    throw new Error("src/j70_table6.inc: not the SPEC 3.3 grid of 95 heights x 29 temperatures");
  }
  const canonical = rows.map((r, i) => `${heights[i]},${r.map((v) => (v / 1000).toFixed(3)).join(",")}\n`).join("");
  const got = createHash("sha256").update(canonical).digest("hex");
  if (got !== TABLE6_SHA256 || !text.includes(TABLE6_SHA256)) throw new Error(`src/j70_table6.inc: SR 313 Table 6 checksum ${got}, expected ${TABLE6_SHA256}`);
  // The SGP4XP-only library overrides must name printed values this table holds.
  const overrides = await fs.readFile(path.join(packageRoot, "src", "j70_library_overrides.inc"), "utf8");
  let count = 0;
  for (const m of overrides.matchAll(/\{(\d+), (\d+), (-?\d+), (-?\d+), "/g)) {
    const [h, T, printed, library] = m.slice(1).map(Number);
    const row = heights.indexOf(h), col = (T - 600) / 50;
    if (row < 0 || !Number.isInteger(col) || col < 0 || col > 28 || rows[row][col] !== printed || Math.abs(library - printed) !== 1) {
      throw new Error(`src/j70_library_overrides.inc: ${h} km ${T} K does not override a printed ${printed} by one unit`);
    }
    count += 1;
  }
  provenance.table6 = { source: "SAO Special Report 313 (Jacchia 1970), Table 6, pp. 82-87", sha256: got, sgp4xpLibraryOverrides: count };
}
await checkTable6();

// Gravity (SDN-AP 2d, tesseral m-daily and shallow-resonance terms): the fully normalized EGM-96 (default) or EGM2008
// coefficients to degree and order 70 that this repository's FFM carries (propagator/ffm/lib), read from this
// checkout and PINNED by SHA-256 (the copies at modules commit 0e84a2c8); SDNAP_GRAVITY=egm2008
// selects EGM2008. Recorded in dist/build-provenance.txt.
const GRAVITY_PIN = Object.freeze({
  modulesCommit: "0e84a2c8fb6258d5e37b3c59839ea0e5794ffae1",
  files: Object.freeze({
    egm96: { file: "egm96_data.h", sha256: "4d5c80b3d673696affffe9d2d17df94ecca730b1f61e0483b1bb9d6606e6a6f4" },
    egm2008: { file: "egm2008_data.h", sha256: "f4f49756761e4e391131a2ce12a25290948670bf889d467a13869a4c4c661250" },
  }),
});
async function gravity() {
  const model = process.env.SDNAP_GRAVITY ?? "egm96";
  const pin = GRAVITY_PIN.files[model];
  if (!pin) throw new Error(`SDNAP_GRAVITY=${model}: egm96 or egm2008`);
  const modules = process.env.SPACE_DATA_NETWORK_MODULES_ROOT ?? modulesRoot;
  const dir = process.env.SDNAP_GRAVITY_DIR ?? path.join(modules, "propagator", "ffm", "lib");
  const bytes = await fs.readFile(path.join(dir, pin.file));
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== pin.sha256) throw new Error(`gravity pin: ${path.join(dir, pin.file)} has sha256 ${got}, expected ${pin.sha256} (modules ${GRAVITY_PIN.modulesCommit})`);
  const C = Array.from({ length: 71 }, () => new Array(71).fill("0.0"));
  const S = Array.from({ length: 71 }, () => new Array(71).fill("0.0"));
  let count = 0;
  for (const m of bytes.toString("utf8").matchAll(/\{\s*(\d+),\s*(\d+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\}/g)) {
    const n = Number(m[1]), k = Number(m[2]);
    if (n > 70 || k > n) continue;
    C[n][k] = m[3];
    S[n][k] = m[4];
    count += 1;
  }
  if (count < 2550) throw new Error(`gravity: ${count} coefficient records in ${pin.file}`);
  let checkoutHead = null;
  try { checkoutHead = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { checkoutHead = null; }
  provenance.gravity = { model, source: shownPath(path.join(dir, pin.file)), pinnedModulesCommit: GRAVITY_PIN.modulesCommit, checkoutHead, sha256: got, records: count };
  const rows = (A) => A.map((r) => `    {${r.join(", ")}},`).join("\n");
  return `// ${model.toUpperCase()} fully normalized Stokes coefficients, degree and order <= 70 (pinned; build.mjs)\n` +
    `constexpr const char* kEgmModel = "${model}";\n` +
    `inline constexpr double kEgmC[71][71] = {\n${rows(C)}\n};\ninline constexpr double kEgmS[71][71] = {\n${rows(S)}\n};\n`;
}

// --- Lunar data (SDN-AP 2h.1), read from the local archive (never the repository) and PINNED by SHA-256:
// the GRAIL field GRGM660PRIM (NASA GSFC, PDS: fully normalized, reference radius 1738.0 km, DE421 principal axes),
// truncated to degree LUNAR_PIN.degree, and the DE440 lunar principal-axis orientation (NAIF moon_pa_de440_200625.bpc:
// 3-1-3 Euler angles of MOON_PA_DE440 from J2000, Chebyshev records of 8 days), refitted over LUNAR_PIN.span to
// records of spanDays days and degree spanDegree; the refit's error against the kernel is measured here and recorded
// in dist/build-provenance.txt. SDNAP_HAC_ROOT moves the archive root.
const LUNAR_PIN = Object.freeze({
  field: { file: "pds-grail-gravity/gggrx_0660pm_sha.tab", sha256: "a77ee9996aff7341ef89f69aa401f39ba0c2949ed80411505fb4826b771dd63e" },
  orientation: { file: "naif-kernels/pck/moon_pa_de440_200625.bpc", sha256: "60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f" },
  ephemeris: { file: "naif-kernels/spk/planets/de440s.bsp", sha256: "c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2" },
  degree: 100,
  span: ["2022-01-01T00:00:00Z", "2029-01-01T00:00:00Z"],
  // the geocentric Moon and Sun (J2000 = the DE440 ICRF axes, km), refitted from DE440 (Moon wrt EMB - Earth wrt EMB;
  // Sun wrt SSB - EMB wrt SSB - Earth wrt EMB) to records of moonDays / sunDays days of degree moonDegree / sunDegree
  moonDays: 16,
  moonDegree: 18,
  sunDays: 32,
  sunDegree: 12,
  // the heliocentric planets for cruise segments (2h.3: system barycentres - the Sun, DE440, J2000 = ICRF axes, km)
  // over planetSpan, records of days / degree per body; GM the DE440 system values (km^3/s^2)
  planetSpan: ["2012-01-01T00:00:00Z", "2029-01-01T00:00:00Z"],
  planets: [
    { name: "VENUS", naif: 2, gm: 324858.592, days: 64, degree: 14 },
    { name: "EARTH-MOON", naif: 3, gm: 403503.235502, days: 64, degree: 12 },
    { name: "MARS", naif: 4, gm: 42828.375816, days: 128, degree: 14 },
    { name: "JUPITER", naif: 5, gm: 126712764.1, days: 128, degree: 12 },
    { name: "SATURN", naif: 6, gm: 37940584.8418, days: 128, degree: 12 },
  ],
  spanDays: 16,   // measured: 16 d / degree 13 max 5.0e-9 rad (9 mm at the surface); the kernel's own 8-day records
  spanDegree: 13, // (degree 9) leave a ~1e-9 floor that longer or higher refits do not go under
});
async function lunar() {
  const root = process.env.SDNAP_HAC_ROOT ?? "/opt/data/sdn-archive/hac";
  const read = async (pin) => {
    const bytes = await fs.readFile(path.join(root, pin.file));
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== pin.sha256) throw new Error(`lunar pin: ${path.join(root, pin.file)} has sha256 ${got}, expected ${pin.sha256}`);
    return bytes;
  };
  // the field
  const tab = (await read(LUNAR_PIN.field)).toString("utf8").split("\n");
  const head = tab[0].split(",").map((x) => x.trim());
  const radius = Number(head[0]), gm = Number(head[1]), normalized = Number(head[5]);
  if (!(radius === 1738.0) || normalized !== 1) throw new Error(`lunar field header: ${tab[0]}`);
  const L = LUNAR_PIN.degree, size = ((L + 1) * (L + 2)) / 2;
  const C = new Array(size).fill(0), S = new Array(size).fill(0);
  let count = 0;
  for (let k = 1; k < tab.length; ++k) {
    const f = tab[k].split(",");
    if (f.length < 4) continue;
    const l = Number(f[0]), m = Number(f[1]);
    if (l > L) break;
    C[(l * (l + 1)) / 2 + m] = Number(f[2]);
    S[(l * (l + 1)) / 2 + m] = Number(f[3]);
    count += 1;
  }
  if (count !== size - 1) throw new Error(`lunar field: ${count} records to degree ${L}`);
  // the orientation: DAF/PCK type 2 segments of MOON_PA_DE440 (frame 31008)
  const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
  const etOf = (iso) => (Date.parse(iso) - J2000) / 1000 + 69.184;  // TDB ~ UTC + 37 s + 32.184 s (2017- leap seconds)
  const e0 = etOf(LUNAR_PIN.span[0]), e1 = etOf(LUNAR_PIN.span[1]);
  const paSegs = dafType2(await read(LUNAR_PIN.orientation), "DAF/PCK ", (ints) => ints[0] === 31008);
  const angles = (et) => chebAt(paSegs, et, "lunar orientation");
  const days = Number(process.env.SDNAP_PA_DAYS ?? LUNAR_PIN.spanDays), N = Number(process.env.SDNAP_PA_DEGREE ?? LUNAR_PIN.spanDegree);
  const pa = refitCheb(angles, e0, e1, days, N, true);
  const { coef, records, maxErr } = pa, D = days * 86400;
  if (process.env.SDNAP_PA_PROBE) console.log(`PA refit ${days} d, degree ${N}: max error ${maxErr.map((x) => x.toExponential(2))} rad, ${coef.length} doubles`);
  if (Math.max(...maxErr) > 1e-8) throw new Error(`lunar orientation refit error ${maxErr} rad`);
  // the geocentric Moon and Sun from DE440 (DAF/SPK type 2; ints: target, center, frame, type, start, end)
  const spk = dafType2(await read(LUNAR_PIN.ephemeris), "DAF/SPK ", (ints) => ints[2] === 1);
  const body = (target, center) => spk.filter((g) => g.ints[0] === target && g.ints[1] === center);
  const moonEmb = body(301, 3), earthEmb = body(399, 3), embSsb = body(3, 0), sunSsb = body(10, 0);
  const sub = (a, b) => a.map((v, c) => v - b[c]);
  const moonGeo = (et) => sub(chebAt(moonEmb, et, "DE440 Moon"), chebAt(earthEmb, et, "DE440 Earth"));
  const sunGeo = (et) => sub(sub(chebAt(sunSsb, et, "DE440 Sun"), chebAt(embSsb, et, "DE440 EMB")), chebAt(earthEmb, et, "DE440 Earth"));
  const moonFit = refitCheb(moonGeo, e0, e1, LUNAR_PIN.moonDays, LUNAR_PIN.moonDegree, false);
  const sunFit = refitCheb(sunGeo, e0, e1, LUNAR_PIN.sunDays, LUNAR_PIN.sunDegree, false);
  const p0 = etOf(LUNAR_PIN.planetSpan[0]), p1 = etOf(LUNAR_PIN.planetSpan[1]);
  const planetFits = LUNAR_PIN.planets.map((pl) => {
    const bary = body(pl.naif, 0);
    const fit = refitCheb((et) => sub(chebAt(bary, et, `DE440 ${pl.name}`), chebAt(sunSsb, et, "DE440 Sun")), p0, p1, pl.days, pl.degree, false);
    if (process.env.SDNAP_PA_PROBE) console.log(`DE440 ${pl.name}: max error ${fit.maxErr.map((x) => x.toExponential(2))} km, ${fit.coef.length} doubles`);
    if (Math.max(...fit.maxErr) > 1.0) throw new Error(`DE440 ${pl.name} refit error ${fit.maxErr} km`);
    return { ...pl, ...fit };
  });
  if (process.env.SDNAP_PA_PROBE) console.log(`DE440 refits: Moon max error ${moonFit.maxErr.map((x) => x.toExponential(2))} km, Sun ${sunFit.maxErr.map((x) => x.toExponential(2))} km`);
  // measured: Moon 1.6 m, Sun 3.3 km (the Earth's monthly wobble about the EMB): third-body forces move by < 1e-8
  if (Math.max(...moonFit.maxErr) > 1e-2 || Math.max(...sunFit.maxErr) > 10.0) throw new Error(`DE440 refit error: Moon ${moonFit.maxErr}, Sun ${sunFit.maxErr} km`);
  provenance.lunar = {
    field: { source: path.join(root, LUNAR_PIN.field.file), sha256: LUNAR_PIN.field.sha256, model: "GRGM660PRIM", degree: L, gmKm3s2: gm, radiusKm: radius },
    orientation: { source: path.join(root, LUNAR_PIN.orientation.file), sha256: LUNAR_PIN.orientation.sha256, frame: "MOON_PA_DE440 (3-1-3 Euler angles from J2000)",
      span: LUNAR_PIN.span, recordDays: days, degree: N, records, maxRefitErrorRad: maxErr },
    ephemeris: { source: path.join(root, LUNAR_PIN.ephemeris.file), sha256: LUNAR_PIN.ephemeris.sha256, model: "DE440 (de440s)", span: LUNAR_PIN.span,
      moon: { recordDays: LUNAR_PIN.moonDays, degree: LUNAR_PIN.moonDegree, records: moonFit.records, maxRefitErrorKm: moonFit.maxErr },
      sun: { recordDays: LUNAR_PIN.sunDays, degree: LUNAR_PIN.sunDegree, records: sunFit.records, maxRefitErrorKm: sunFit.maxErr },
      planets: { span: LUNAR_PIN.planetSpan, bodies: planetFits.map((f) => ({ name: f.name, gmKm3s2: f.gm, recordDays: f.days, degree: f.degree, records: f.records, maxRefitErrorKm: f.maxErr })) } },
  };
  const list = (a) => a.map((v) => (v === 0 ? "0.0" : v.toExponential(17))).join(",\n  ");
  return `// GRGM660PRIM to degree ${L} (fully normalized; triangular index l (l + 1) / 2 + m) and the DE440 lunar PA\n` +
    `// orientation refitted over ${LUNAR_PIN.span[0]} .. ${LUNAR_PIN.span[1]} (pinned; build.mjs)\n` +
    `constexpr int kLunarDegree = ${L};\nconstexpr double kLunarRadiusKm = ${radius.toFixed(1)};\nconstexpr double kLunarGmKm3s2 = ${gm.toPrecision(17)};\n` +
    `inline constexpr double kLunarC[${size}] = {\n  ${list(C)}};\ninline constexpr double kLunarS[${size}] = {\n  ${list(S)}};\n` +
    `constexpr double kLunarPaStartEt = ${e0.toFixed(3)};\nconstexpr double kLunarPaRecordSeconds = ${D.toFixed(1)};\n` +
    `constexpr int kLunarPaRecords = ${records};\nconstexpr int kLunarPaDegree = ${N};\n` +
    `inline constexpr double kLunarPa[${coef.length}] = {\n  ${list(coef)}};\n` +
    `// DE440 geocentric Moon and Sun (km, J2000 = ICRF axes) over the same span\n` +
    `constexpr double kDeStartEt = ${e0.toFixed(3)};\n` +
    `constexpr double kDeMoonRecordSeconds = ${(LUNAR_PIN.moonDays * 86400).toFixed(1)};\nconstexpr int kDeMoonRecords = ${moonFit.records};\nconstexpr int kDeMoonDegree = ${LUNAR_PIN.moonDegree};\n` +
    `inline constexpr double kDeMoon[${moonFit.coef.length}] = {\n  ${list(moonFit.coef)}};\n` +
    `constexpr double kDeSunRecordSeconds = ${(LUNAR_PIN.sunDays * 86400).toFixed(1)};\nconstexpr int kDeSunRecords = ${sunFit.records};\nconstexpr int kDeSunDegree = ${LUNAR_PIN.sunDegree};\n` +
    `inline constexpr double kDeSun[${sunFit.coef.length}] = {\n  ${list(sunFit.coef)}};\n` +
    `// DE440 heliocentric planets (system barycentres - the Sun; km, ICRF axes) over ${LUNAR_PIN.planetSpan[0]} .. ${LUNAR_PIN.planetSpan[1]}\n` +
    `constexpr double kDePlanetStartEt = ${p0.toFixed(3)};\nconstexpr int kDePlanets = ${planetFits.length};\n` +
    planetFits.map((f, k) => `inline constexpr double kDePlanet${k}[${f.coef.length}] = {\n  ${list(f.coef)}};\n`).join("") +
    `struct DePlanet { const char* name; double gm; const double* coef; double record_s; int records, degree; };\n` +
    `inline constexpr DePlanet kDePlanet[${planetFits.length}] = {\n` +
    planetFits.map((f, k) => `  {"${f.name}", ${f.gm.toPrecision(17)}, kDePlanet${k}, ${(f.days * 86400).toFixed(1)}, ${f.records}, ${f.degree}},\n`).join("") + `};\n`;
}

/// DAF type-2 Chebyshev segments (SPK positions or PCK Euler angles) of a little-endian kernel whose summary ints pass `keep`.
function dafType2(bytes, magic, keep) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.toString("latin1", 0, 8) !== magic || bytes.toString("latin1", 88, 96) !== "LTL-IEEE") throw new Error(`not a little-endian ${magic.trim()}`);
  const nd = dv.getInt32(8, true), ni = dv.getInt32(12, true), fward = dv.getInt32(76, true);
  const word = (w) => dv.getFloat64((w - 1) * 8, true);
  const segs = [];
  for (let rec = fward; rec; ) {
    const base = (rec - 1) * 1024;
    const next = dv.getFloat64(base, true), nsum = dv.getFloat64(base + 16, true);
    const ss = nd + Math.floor((ni + 1) / 2);
    for (let k = 0; k < nsum; ++k) {
      const o = base + 24 + k * ss * 8;
      const ints = Array.from({ length: ni }, (_, j) => dv.getInt32(o + 8 * nd + 4 * j, true));
      const [type, start, end] = ints.slice(ni - 3);
      if (type !== 2 || !keep(ints)) continue;
      segs.push({ ints, init: word(end - 3), intlen: word(end - 2), rsize: word(end - 1), n: word(end), start, word });
    }
    rec = next;
  }
  return segs;
}

/// The three Chebyshev components of the segment covering et.
function chebAt(segs, et, what) {
  const s = segs.find((g) => et >= g.init && et < g.init + g.n * g.intlen);
  if (!s) throw new Error(`${what}: no record at ${et}`);
  const r = Math.min(s.n - 1, Math.floor((et - s.init) / s.intlen));
  const at = s.start + r * s.rsize;
  const mid = s.word(at), rad = s.word(at + 1), x = (et - mid) / rad, deg = (s.rsize - 2) / 3 - 1;
  const out = [];
  for (let c = 0; c < 3; ++c) {
    let t0 = 1, t1 = x, sum = s.word(at + 2 + c * (deg + 1)) + (deg >= 1 ? s.word(at + 3 + c * (deg + 1)) * x : 0);
    for (let j = 2; j <= deg; ++j) { const t2 = 2 * x * t1 - t0; sum += s.word(at + 2 + c * (deg + 1) + j) * t2; t0 = t1; t1 = t2; }
    out.push(sum);
  }
  return out;
}

/// Refit fn (three components) over [e0, e1) to records of `days` days and degree N at Chebyshev nodes; the error
/// against fn is measured every 30 minutes (angles: unwrapped before the transform, compared modulo 2 pi).
function refitCheb(fn, e0, e1, days, N, angles) {
  const D = days * 86400, records = Math.ceil((e1 - e0) / D), coef = [];
  for (let r = 0; r < records; ++r) {
    const mid = e0 + (r + 0.5) * D, vals = [];
    for (let k = 0; k <= N; ++k) vals.push(fn(mid + (D / 2) * Math.cos((Math.PI * (k + 0.5)) / (N + 1))));
    for (let c = 0; c < 3; ++c) {
      const seq = vals.map((v) => v[c]);
      if (angles) for (let k = 1; k < seq.length; ++k) while (Math.abs(seq[k] - seq[k - 1]) > Math.PI) seq[k] -= Math.sign(seq[k] - seq[k - 1]) * 2 * Math.PI;
      for (let j = 0; j <= N; ++j) {
        let sum = 0;
        for (let k = 0; k <= N; ++k) sum += seq[k] * Math.cos((Math.PI * j * (k + 0.5)) / (N + 1));
        coef.push(((j === 0 ? 1 : 2) / (N + 1)) * sum);
      }
    }
  }
  const maxErr = [0, 0, 0];
  for (let et = e0; et < e1; et += 1800) {
    const r = Math.min(records - 1, Math.floor((et - e0) / D)), x = (et - (e0 + (r + 0.5) * D)) / (D / 2), ref = fn(et);
    for (let c = 0; c < 3; ++c) {
      let t0 = 1, t1 = x, base = (r * 3 + c) * (N + 1), sum = coef[base] + coef[base + 1] * x;
      for (let j = 2; j <= N; ++j) { const t2 = 2 * x * t1 - t0; sum += coef[base + j] * t2; t0 = t1; t1 = t2; }
      let d = sum - ref[c];
      if (angles) d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      maxErr[c] = Math.max(maxErr[c], Math.abs(d));
    }
  }
  return { coef, records, maxErr };
}

const source = await fs.readFile(path.join(packageRoot, "src", "sdn_ap_module.cpp"), "utf8");
const partPattern = /^#include "([a-z0-9_]+\.inc)"\n/gm;
const parts = new Map();
let inlined = source;
for (let depth = 0; partPattern.test(inlined); ++depth) {
  partPattern.lastIndex = 0;
  if (depth > 4) throw new Error("src/*.inc includes nest too deep");
  for (const [, name] of inlined.matchAll(partPattern)) {
    if (!parts.has(name)) parts.set(name, await fs.readFile(path.join(packageRoot, "src", name), "utf8"));
  }
  inlined = inlined.replace(partPattern, (_, name) => parts.get(name));
}
const sourceCode = inlined
  .replace('#include "orbpro/orbpro_propagator_abi.h"', abiHeader)
  .replace('#include "omm_slots.h"', await ommSlots())
  .replace('#include "oem_generated.h"', await oemBindings())
  .replace('#include "nrlmsise00.h"', await nrlmsise())
  .replace('#include "erfa_pinned.h"', await erfa())
  .replace('#include "gravity_egm.h"', await gravity())
  .replace('#include "lunar_data.h"', await lunar());

const buildRoot = path.join(packageRoot, ".build");
// SDNAP_DIST_DIR builds elsewhere (experiments), leaving dist/ as the last pushed build
const distRoot = process.env.SDNAP_DIST_DIR ? path.resolve(process.env.SDNAP_DIST_DIR) : path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
await fs.mkdir(buildRoot, { recursive: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(path.join(buildRoot, "module.cpp"), sourceCode);

const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "plugin-manifest.json"), "utf8"));
const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  threadModel: ModuleThreadModel.EMSCRIPTEN_PTHREADS,
});
if (!compilation.report?.ok) {
  const issues = (compilation.report?.issues ?? []).map((i) => [i.severity, i.code, i.message].filter(Boolean).join(" ") || String(i));
  throw new Error(`sdn-ap-propagator validation failed: ${issues.join("; ")}`);
}
await fs.copyFile(path.join(packageRoot, "plugin-manifest.json"), path.join(distRoot, "plugin-manifest.json"));
await fs.mkdir(path.join(distRoot, "LICENSES"), { recursive: true });
await fs.writeFile(path.join(distRoot, "LICENSES", "ERFA.txt"), erfaLicense);
// the provenance as "key value" lines (nested keys joined by dots, lists by spaces): no JSON in the module's tooling
const provenanceLines = [];
const flatten = (prefix, value) => {
  if (value === null || value === undefined) provenanceLines.push(`${prefix} -`);
  else if (Array.isArray(value)) provenanceLines.push(`${prefix} ${value.map(String).join(" ")}`);
  else if (typeof value === "object") for (const [k, v] of Object.entries(value)) flatten(prefix ? `${prefix}.${k}` : k, v);
  else provenanceLines.push(`${prefix} ${String(value)}`);
};
flatten("", { module: manifest.pluginId, version: manifest.version, sha256: createHash("sha256").update(compilation.wasmBytes).digest("hex"), ...provenance });
await fs.writeFile(path.join(distRoot, "build-provenance.txt"), `${provenanceLines.join("\n")}\n`);
console.log(`built ${path.relative(packageRoot, outputPath)} (${compilation.wasmBytes.length} bytes)`);

if (process.argv.includes("--protect")) {
  const mnemonic = process.env.SDN_MODULE_SIGNING_MNEMONIC;
  const recipientPublicKeyHex = process.env.SDN_MODULE_RECIPIENT_PUBLIC_KEY_HEX;
  if (!mnemonic || !recipientPublicKeyHex) {
    throw new Error("Protected builds require SDN_MODULE_SIGNING_MNEMONIC and SDN_MODULE_RECIPIENT_PUBLIC_KEY_HEX.");
  }
  const protectedArtifact = await protectModuleArtifact({
    manifest,
    wasmBytes: compilation.wasmBytes,
    mnemonic,
    recipientPublicKeyHex,
  });
  const protectedRoot = path.join(distRoot, "protected");
  await fs.mkdir(protectedRoot, { recursive: true });
  await fs.writeFile(path.join(protectedRoot, "module.wasm.protected"), protectedArtifact.protectedArtifactBytes);
  console.log(`protected ${path.relative(packageRoot, path.join(protectedRoot, "module.wasm.protected"))}`);
}
