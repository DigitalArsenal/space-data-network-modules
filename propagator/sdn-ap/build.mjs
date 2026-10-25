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
// ERFA is read from this repository (propagator/sdn-ap sits two levels below its root);
// SPACE_DATA_NETWORK_MODULES_ROOT names another checkout
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
  const pending = ["OEM", "OMM", "PCF", "OBD", "MNV"];
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
  for (const code of ["OEM", "OMM", "PCF", "OBD", "MNV"]) visit(code);
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

const provenance = { erfa: null, table6: null };

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

const source = await fs.readFile(path.join(packageRoot, "src", "sdn_ap_module.cpp"), "utf8");
const partPattern = /^#include "([a-z0-9_]+\.inc)"\n/gm;
// The SGP4/SDP4 base is the shared library foundation/sgp4-str3 of this checkout (analysis/od compiles it too);
// every other part is this package's src/.
const sharedParts = new Map(["sgp4_core.inc", "model.inc"].map((name) => [name, path.join(modulesRoot, "foundation", "sgp4-str3", "src", name)]));
const parts = new Map();
let inlined = source;
for (let depth = 0; partPattern.test(inlined); ++depth) {
  partPattern.lastIndex = 0;
  if (depth > 4) throw new Error("src/*.inc includes nest too deep");
  for (const [, name] of inlined.matchAll(partPattern)) {
    if (!parts.has(name)) parts.set(name, await fs.readFile(sharedParts.get(name) ?? path.join(packageRoot, "src", name), "utf8"));
  }
  inlined = inlined.replace(partPattern, (_, name) => parts.get(name));
}
const sourceCode = inlined
  .replace('#include "orbpro/orbpro_propagator_abi.h"', abiHeader)
  .replace('#include "omm_slots.h"', await ommSlots())
  .replace('#include "oem_generated.h"', await oemBindings())
  .replace('#include "erfa_pinned.h"', await erfa());

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
