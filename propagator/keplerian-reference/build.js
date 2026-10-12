/**
 * Build the reference propagator through the SDK compiler lane.
 *
 * `compileModuleFromSource` takes ONE translation unit, so the generated ABI
 * header is INLINED into the source before compiling. That inlining is
 * mechanical and one-directional: the header is read from the pinned
 * space-data-module-sdk package, never edited, never committed here. If the
 * SDK's ABI changes, this build picks it up on the next run — which is the
 * whole point of the W1.1 generation lane. A copy of the header checked in
 * beside this file would be the sixth hand-vendored mirror.
 *
 * Thread model: the manifest declares `emscripten-pthreads`, which in this SDK
 * means the clang `wasm32-wasip1-threads` contract (guest imports
 * `wasi.thread-spawn`, exports `wasi_thread_start`) — never `emcc -pthread`,
 * which is browser-only and cannot thread under WasmEdge. The SDK's
 * post-link artifact guard fails the build if the emitted wasm does not
 * actually carry shared memory + atomics.
 */

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "keplerian_reference_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

const standardsRoot = path.dirname(
  require.resolve("spacedatastandards.org/package.json"),
);
process.env.SPACE_DATA_STANDARDS_ROOT ??= `${standardsRoot}${path.sep}`;

/** The ONE source of the ABI, resolved from the pinned SDK package. */
const abiHeaderPath = require.resolve(
  "space-data-module-sdk/include/orbpro/orbpro_propagator_abi.h",
);

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const abiHeader = await fs.readFile(abiHeaderPath, "utf8");
const rawSource = await fs.readFile(sourcePath, "utf8");

/**
 * Derive the $OMM FlatBuffers vtable slots from the PINNED, RELEASED SDS
 * catalog and inject them as #defines.
 *
 * A FlatBuffers table field's vtable slot is `4 + 2 * <declaration index>`.
 * Those indices are a property of the schema, so hand-typing them into C++
 * would be one more hand-vendored mirror of a contract that lives somewhere
 * else — the exact defect the W1.1 generation lane exists to end. They are
 * derived here instead, and a field that is not in the pinned schema FAILS
 * THE BUILD rather than silently reading offset garbage.
 *
 * The catalog is the released package, not a sibling checkout: the local
 * spacedatastandards.org working tree and the released OMM schema already
 * disagree by one field, and building against the un-released one is the
 * hazard `check-generated-bindings.mjs` exists to refuse.
 */
async function resolveOmmVtableSlots(fieldNames) {
  const standards = await import("space-data-module-sdk/standards");
  const loader =
    standards.loadStandardsCatalog ??
    standards.resolveStandardsCatalog ??
    standards.getStandardsCatalog;
  const loaded = await loader();
  const catalog = Array.isArray(loaded) ? loaded : loaded.catalog;
  const entry = catalog.find((candidate) => candidate.fileIdentifier === "$OMM");
  if (!entry) {
    throw new Error(
      "The pinned spacedatastandards.org catalog has no $OMM entry. The reference " +
        "propagator declares a typed $OMM port and cannot be built without it.",
    );
  }

  // Field declaration order inside `table OMM { ... }`.
  const body = /table\s+OMM\s*\{([\s\S]*?)\n\}/.exec(entry.idl);
  if (!body) {
    throw new Error("Could not locate `table OMM` in the pinned $OMM IDL.");
  }
  const declared = [];
  for (const line of body[1].split("\n")) {
    const match = /^\s*([A-Za-z_][\w]*)\s*:/.exec(line.replace(/\/\/.*$/, ""));
    if (match) declared.push(match[1]);
  }

  const slots = new Map();
  for (const fieldName of fieldNames) {
    const index = declared.indexOf(fieldName);
    if (index < 0) {
      throw new Error(
        `$OMM ${entry.version} does not declare a field named ${fieldName}. ` +
          `The reference propagator reads it; refusing to build against a schema that lacks it.`,
      );
    }
    slots.set(fieldName, 4 + 2 * index);
  }
  return { version: entry.version, hash: entry.hash, slots };
}

const OMM_FIELDS = [
  "EPOCH",
  "MEAN_MOTION",
  "ECCENTRICITY",
  "INCLINATION",
  "RA_OF_ASC_NODE",
  "ARG_OF_PERICENTER",
  "MEAN_ANOMALY",
  "BSTAR",
  "MEAN_MOTION_DOT",
  "MEAN_MOTION_DDOT",
  "NORAD_CAT_ID",
  // Small bodies (heliocentric osculating elements): kepler_small_*.
  "SEMI_MAJOR_AXIS",
  "GM",
  "CENTER_NAME",
  "REFERENCE_FRAME",
  "TIME_SYSTEM",
];

const omm = await resolveOmmVtableSlots(OMM_FIELDS);

/**
 * The $RFM and $TIM pieces the small-body path reads (REFERENCE_FRAME's
 * union and axes, TIME_SYSTEM's enum), derived from the same pinned catalog.
 * A union field takes two slots (NAME_type, then NAME); enum values follow
 * their declaration (explicit `= n` honoured).
 */
async function resolveCatalogEntry(fileIdentifier) {
  const standards = await import("space-data-module-sdk/standards");
  const loader =
    standards.loadStandardsCatalog ??
    standards.resolveStandardsCatalog ??
    standards.getStandardsCatalog;
  const loaded = await loader();
  const catalog = Array.isArray(loaded) ? loaded : loaded.catalog;
  const entry = catalog.find((candidate) => candidate.fileIdentifier === fileIdentifier);
  if (!entry) {
    throw new Error(`The pinned spacedatastandards.org catalog has no ${fileIdentifier} entry.`);
  }
  return entry;
}

function stripComments(idl) {
  return idl.replace(/\/\/.*$/gm, "");
}

function tableSlots(idl, tableName, fieldNames) {
  const text = stripComments(idl);
  const unions = new Set([...text.matchAll(/union\s+(\w+)/g)].map((m) => m[1]));
  const body = new RegExp(`table\\s+${tableName}\\s*\\{([\\s\\S]*?)\\}`).exec(text);
  if (!body) throw new Error(`table ${tableName} is not in the pinned IDL.`);
  const declared = [];
  for (const match of body[1].matchAll(/([A-Za-z_]\w*)\s*:\s*\[?\s*([A-Za-z_][\w.]*)/g)) {
    if (unions.has(match[2])) declared.push(`${match[1]}_type`);
    declared.push(match[1]);
  }
  const slots = new Map();
  for (const name of fieldNames) {
    const index = declared.indexOf(name);
    if (index < 0) throw new Error(`table ${tableName} declares no field ${name}; refusing to build.`);
    slots.set(name, 4 + 2 * index);
  }
  return slots;
}

function enumValues(idl, enumName, names) {
  const text = stripComments(idl);
  const body = new RegExp(`(?:enum|union)\\s+${enumName}\\b[^{]*\\{([\\s\\S]*?)\\}`).exec(text);
  if (!body) throw new Error(`enum ${enumName} is not in the pinned IDL.`);
  const isUnion = new RegExp(`union\\s+${enumName}\\b`).test(text);
  const values = new Map();
  let next = isUnion ? 1 : 0; // a union's member n has type value n (0 is NONE)
  for (const raw of body[1].split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const m = /^(\w+)\s*(?:=\s*(-?\d+))?$/.exec(item);
    if (!m) continue;
    const value = m[2] !== undefined ? Number(m[2]) : next;
    values.set(m[1], value);
    next = value + 1;
  }
  const out = new Map();
  for (const name of names) {
    if (!values.has(name)) throw new Error(`${enumName} has no ${name}; refusing to build.`);
    out.set(name, values.get(name));
  }
  return out;
}

const rfm = await resolveCatalogEntry("$RFM");
const tim = await resolveCatalogEntry("$TIM");
const rfmSlots = tableSlots(rfm.idl, "RFM", ["REFERENCE_FRAME_type", "REFERENCE_FRAME"]);
const cfwSlots = tableSlots(rfm.idl, "CelestialFrameWrapper", ["frame"]);
const cswSlots = tableSlots(rfm.idl, "RFMCoordinateSystemWrapper", ["COORDINATE_SYSTEM"]);
const csSlots = tableSlots(rfm.idl, "RFMCoordinateSystem", ["AXIS_TYPE"]);
const unionValues = enumValues(rfm.idl, "RFMUnion", ["CelestialFrameWrapper", "RFMCoordinateSystemWrapper"]);
const celestialValues = enumValues(rfm.idl, "CelestialFrame", ["ICRF", "J2000", "EME2000"]);
const axisValues = enumValues(rfm.idl, "rfmAxisType", ["MEAN_EQUATOR_EQUINOX_J2000", "MEAN_ECLIPTIC_EQUINOX_J2000", "ICRF"]);
const timeValues = enumValues(tim.idl, "timingStandard", ["UTC", "TT", "TDB"]);
const smallBodyDefines = [
  `// --- GENERATED from the pinned SDS $RFM ${rfm.version} and $TIM ${tim.version} schemas ---`,
  `#define ORBPRO_RFM_VT_REFERENCE_FRAME_TYPE ${rfmSlots.get("REFERENCE_FRAME_type")}`,
  `#define ORBPRO_RFM_VT_REFERENCE_FRAME ${rfmSlots.get("REFERENCE_FRAME")}`,
  `#define ORBPRO_RFM_CFW_VT_FRAME ${cfwSlots.get("frame")}`,
  `#define ORBPRO_RFM_CSW_VT_COORDINATE_SYSTEM ${cswSlots.get("COORDINATE_SYSTEM")}`,
  `#define ORBPRO_RFM_CS_VT_AXIS_TYPE ${csSlots.get("AXIS_TYPE")}`,
  `#define ORBPRO_RFM_UNION_CELESTIAL_FRAME ${unionValues.get("CelestialFrameWrapper")}`,
  `#define ORBPRO_RFM_UNION_COORDINATE_SYSTEM ${unionValues.get("RFMCoordinateSystemWrapper")}`,
  `#define ORBPRO_RFM_CELESTIAL_ICRF ${celestialValues.get("ICRF")}`,
  `#define ORBPRO_RFM_CELESTIAL_J2000 ${celestialValues.get("J2000")}`,
  `#define ORBPRO_RFM_CELESTIAL_EME2000 ${celestialValues.get("EME2000")}`,
  `#define ORBPRO_RFM_AXIS_MEAN_EQUATOR_J2000 ${axisValues.get("MEAN_EQUATOR_EQUINOX_J2000")}`,
  `#define ORBPRO_RFM_AXIS_MEAN_ECLIPTIC_J2000 ${axisValues.get("MEAN_ECLIPTIC_EQUINOX_J2000")}`,
  `#define ORBPRO_RFM_AXIS_ICRF ${axisValues.get("ICRF")}`,
  `#define ORBPRO_TIM_UTC ${timeValues.get("UTC")}`,
  `#define ORBPRO_TIM_TT ${timeValues.get("TT")}`,
  `#define ORBPRO_TIM_TDB ${timeValues.get("TDB")}`,
  `// --- END GENERATED ---`,
].join("\n");
const ommSlotDefines = [
  `// --- GENERATED from the pinned SDS $OMM schema, version ${omm.version} ---`,
  `// hash ${omm.hash}`,
  `// A FlatBuffers table field lives at vtable slot 4 + 2*<declaration index>.`,
  `#define ORBPRO_OMM_SCHEMA_VERSION "${omm.version}"`,
  ...[...omm.slots].map(([name, slot]) => `#define ORBPRO_OMM_VT_${name} ${slot}`),
  `// --- END GENERATED ---`,
].join("\n") + "\n" + smallBodyDefines;

const INCLUDE_LINE = '#include "orbpro/orbpro_propagator_abi.h"';
if (!rawSource.includes(INCLUDE_LINE)) {
  throw new Error(
    `${path.relative(packageRoot, sourcePath)} no longer includes the generated ABI header. ` +
      `The reference module must build against the ONE generated ABI, not a local copy.`,
  );
}

const SLOTS_MARKER = "// __ORBPRO_OMM_VTABLE_SLOTS__";
if (!rawSource.includes(SLOTS_MARKER)) {
  throw new Error(
    `${path.relative(packageRoot, sourcePath)} no longer carries ${SLOTS_MARKER}. ` +
      `The $OMM vtable slots are derived from the pinned schema, never hand-typed.`,
  );
}

const sourceCode = rawSource
  .replace(
    INCLUDE_LINE,
    [
      `// --- BEGIN INLINED ${path.basename(abiHeaderPath)} (from ${manifest.pluginId}'s pinned SDK) ---`,
      abiHeader,
      `// --- END INLINED ${path.basename(abiHeaderPath)} ---`,
    ].join("\n"),
  )
  .replace(SLOTS_MARKER, ommSlotDefines);

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // PASSED EXPLICITLY ON PURPOSE. `resolveThreadModel` reads the compile
  // OPTION, not `manifest.threadModel`, and falls back to inferring the model
  // from `runtimeTargets` — where "wasmedge" infers pthreads. A manifest that
  // declares `wasi-sequential` and does not pass it here is silently compiled
  // under the other model and then rejected by the post-link artifact guard.
  // Filed as `sdk-manifest-threadmodel-silently-ignored`.
  threadModel: manifest.threadModel,
});

if (compilation.threadModel !== manifest.threadModel) {
  throw new Error(
    `threadModel drift: the manifest declares ${manifest.threadModel} but the ` +
      `compiler resolved ${compilation.threadModel}.`,
  );
}

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled reference propagator failed SDK validation:\n${issues}`);
}

console.log(
  `Built ${path.relative(packageRoot, outputPath)} ` +
    `(${compilation.compiler}, threadModel=${compilation.threadModel})`,
);
