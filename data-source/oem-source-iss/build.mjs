import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "oem_source_iss_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
// The checked-in NASA ISS OEM fixture (the SAME fixture the OD RMS-parity gate
// uses). The $OEM the node emits is built FROM this, so the fixture stays the
// single source of truth.
const fixturePath = fileURLToPath(
  new URL("../../analysis/od/tests/data/supgp-reference/iss/ISS.OEM_J2K_EPH.trimmed.txt", import.meta.url),
);

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

// flatc emits every SDS header with the same include guard
// (FLATBUFFERS_GENERATED_MAIN_H_) and schema includes as a self-named `#include
// "main_generated.h"`. Inlining several standards into one translation unit
// requires stripping both (same pattern as data-source/celestrak-parser).
function inlineGeneratedHeader(source) {
  return source
    .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, "")
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
}

// Topological order over the OEM flatc include graph:
//   OEM -> RFM, TIM, CAT, PPE ;  PPE -> RFM, TIM, CAT ;  CAT -> PLD, LCC ;
//   PLD -> IDM.  So leaves first, then CAT, then PPE, then OEM.
const inlineStandards = ["RFM", "TIM", "IDM", "PLD", "LCC", "CAT", "PPE", "OEM"];

// ── Parse the CCSDS KVN OEM fixture into META + raw EME2000 states ─────────────
// This is the inverse of analysis/od's oem_parser: we recover the exact tokens
// so the emitted $OEM carries byte-identical numbers (verbatim decimal literals
// -> identical IEEE-754 doubles -> bit-for-bit parity with the KVN fit path).
function parseOemFixture(text) {
  const meta = {};
  const states = [];
  let inMeta = false;
  let inData = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t === "" || t.startsWith("COMMENT")) continue;
    if (t === "META_START") { inMeta = true; inData = false; continue; }
    if (t === "META_STOP") { inMeta = false; inData = true; continue; }
    if (inMeta) {
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      meta[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
      continue;
    }
    if (inData) {
      if (t.includes("=")) continue; // header keyword lines before META
      const toks = t.split(/\s+/);
      if (toks.length < 7) continue; // not a full 7-token state line
      states.push({
        epoch: toks[0],
        x: toks[1], y: toks[2], z: toks[3],
        vx: toks[4], vy: toks[5], vz: toks[6],
      });
    }
  }
  return { meta, states };
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const fixtureText = await fs.readFile(fixturePath, "utf8");
const { meta, states } = parseOemFixture(fixtureText);

if (states.length === 0) throw new Error(`ISS OEM fixture had no state lines: ${fixturePath}`);
// Fail-closed for this ISS slice: the module hardcodes EME2000/UTC/Earth to
// match the sacred parity path. Reject a fixture that drifts from that.
if ((meta.REF_FRAME || "").toUpperCase() !== "EME2000")
  throw new Error(`ISS OEM fixture REF_FRAME=${meta.REF_FRAME} != EME2000`);
if ((meta.TIME_SYSTEM || "").toUpperCase() !== "UTC")
  throw new Error(`ISS OEM fixture TIME_SYSTEM=${meta.TIME_SYSTEM} != UTC`);
if ((meta.CENTER_NAME || "").toUpperCase() !== "EARTH")
  throw new Error(`ISS OEM fixture CENTER_NAME=${meta.CENTER_NAME} != Earth`);

// Derive the uniform step (seconds) from the fixture epochs and verify it IS
// uniform — the compact-form $OEM (EPHEMERIS_DATA + START_TIME + STEP_SIZE) only
// round-trips bit-for-bit against the OD reader's epoch[i]=START+i*STEP when the
// cadence is uniform. Fail-closed if the fixture ever drifts to non-uniform.
const epochMs = states.map((s) => Date.parse(s.epoch));
if (epochMs.length >= 2) {
  const step0 = epochMs[1] - epochMs[0];
  for (let i = 2; i < epochMs.length; i++) {
    if (Math.abs(epochMs[i] - epochMs[i - 1] - step0) > 1) {
      throw new Error(
        `ISS OEM fixture is non-uniform at row ${i}: step ${epochMs[i] - epochMs[i - 1]}ms != ${step0}ms (compact-form $OEM requires uniform cadence)`,
      );
    }
  }
}
const stepSeconds = epochMs.length >= 2 ? (epochMs[1] - epochMs[0]) / 1000 : 0;
const startIso = states[0].epoch;
const stopIso = states[states.length - 1].epoch;

const cstr = (s) => `"${String(s).replace(/[\\"]/g, "\\$&")}"`;
// Emit the RAW decimal tokens verbatim as C++ double literals (no JS float
// round-trip): C++ parses the same decimal to the same nearest double the
// native fixture parser does -> bit-identical states.
const stateRows = states
  .map((s) => `  { ${cstr(s.epoch)}, ${s.x}, ${s.y}, ${s.z}, ${s.vx}, ${s.vy}, ${s.vz} },`)
  .join("\n");

const fixtureInc = `// GENERATED by build.mjs from ${path.basename(fixturePath)} — do not edit.
namespace {
struct OemFixtureState { const char* epoch; double x, y, z, vx, vy, vz; };
static const char* const kOemObjectName = ${cstr(meta.OBJECT_NAME || "ISS")};
static const char* const kOemObjectId   = ${cstr(meta.OBJECT_ID || "1998-067-A")};
static const char* const kOemCenterName = ${cstr(meta.CENTER_NAME || "Earth")};
// Uniform-cadence bounds for the COMPACT-form $OEM (START_TIME + STEP_SIZE).
static const char* const kOemStartIso = ${cstr(startIso)};
static const char* const kOemStopIso  = ${cstr(stopIso)};
static const double kOemStepSeconds = ${stepSeconds};
// NORAD is absent from the CCSDS OEM META; the ISS catalog id is well-known.
static const uint32_t kOemNoradCatId = 25544u;
static const OemFixtureState kIssStates[] = {
${stateRows}
};
static const int kIssStateCount = ${states.length};
}  // namespace
`;

const headers = await Promise.all(
  inlineStandards.map((standard) =>
    fs.readFile(path.join(standardsRoot, "lib", "cpp", standard, "main_generated.h"), "utf8"),
  ),
);
const implementationSource = await fs.readFile(sourcePath, "utf8");
// The shared $OEM FlatBuffer builder (common/oem_fb_builder.hpp) — inlined AFTER
// the SDS headers (it references OEM/CAT/RFM/… types) and BEFORE the fixture +
// implementation. This is the reusable builder every OD-flow provider source uses.
const sharedOemBuilder = (
  await fs.readFile(
    fileURLToPath(new URL("../../common/oem_fb_builder.hpp", import.meta.url)),
    "utf8",
  )
).replace(/^#pragma once\s*\n/, ""); // strip: inlined into the main TU, not #included
// One translation unit: inlined SDS headers, the shared $OEM builder, the fixture
// data, then the module implementation that references all three.
const sourceCode = [
  ...headers.map(inlineGeneratedHeader),
  sharedOemBuilder,
  fixtureInc,
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
});

// Persist the prefixed guest-link object + metadata for the flow compiler.
const guestLinkDir = path.join(distRoot, "guest-link");
await fs.mkdir(guestLinkDir, { recursive: true });
await fs.writeFile(path.join(guestLinkDir, "module-link.o"), compilation.guestLink.objectBytes);
await fs.writeFile(
  path.join(guestLinkDir, "metadata.json"),
  `${JSON.stringify(
    {
      version: 1,
      format: compilation.guestLink.format,
      language: compilation.guestLink.language,
      threadModel: compilation.guestLink.threadModel,
      symbolPrefix: compilation.guestLink.symbolPrefix,
      methodSymbols: compilation.guestLink.methodSymbols,
    },
    null,
    2,
  )}\n`,
);

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(
  `oem-source-iss compiled -> ${path.relative(packageRoot, outputPath)} ` +
    `(${states.length} ISS states, NORAD 25544, EME2000/UTC)`,
);
