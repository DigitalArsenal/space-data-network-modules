#!/usr/bin/env node
/**
 * Generate the C++ FlatBuffer headers this module consumes from the SDS tree named by SPACE_DATA_STANDARDS_ROOT
 * (else node_modules/spacedatastandards.org): schema/<FAMILY>/main.fbs, compiled here with flatc-wasm, so every
 * family comes from one SDS release (the $PRW window arms are newer than any published C++ binding).
 *
 * SCHEMA_FAMILIES is in dependency order: $MPE needs MET; $OEM needs RFM, TIM, CAT (PLD -> IDM, LCC) and PPE; $OMM
 * needs RFM, TIM, MET, CVR and PVN; $PRW needs FRM, TIM, PCE, PPE, NCD, EOP and SPW. build.mjs concatenates the
 * headers in this order into one translation unit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : path.join(packageRoot, "node_modules", "spacedatastandards.org");
const outDir = path.join(packageRoot, "src", "generated", "sds");

export const SCHEMA_FAMILIES = [
  "MET", "MPE", "RFM", "TIM", "IDM", "PLD", "LCC", "CAT", "PPE", "OEM", "CVR", "PVN", "OMM",
  "FRM", "PCE", "NCD", "EOP", "SPW", "PRW",
];

function schemaIncludeFamilies(schemaPath) {
  const includes = [];
  for (const line of fs.readFileSync(schemaPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*include\s+"(?:\.\.\/)?([A-Z0-9_]+)\/main\.fbs";(?:\s*\/\/.*)?\s*$/);
    if (match) includes.push(match[1]);
  }
  return includes;
}

function rewriteGeneratedHeader(generated, family, includeFamilies) {
  const rewritten = generated.replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_${family}_MAIN_H_`);
  let includeIndex = 0;
  return rewritten.replace(/#include "main_generated\.h"/g, () => {
    const includeFamily = includeFamilies[includeIndex++];
    if (!includeFamily) {
      throw new Error(`generated header for ${family} includes more main_generated.h entries than the schema lists`);
    }
    return `#include "${includeFamily}_generated.h"`;
  });
}

export async function generateSdsHeaders() {
  if (!fs.existsSync(standardsRoot)) {
    throw new Error(`spacedatastandards.org not installed at ${standardsRoot}; set SPACE_DATA_STANDARDS_ROOT`);
  }
  const version = JSON.parse(fs.readFileSync(path.join(standardsRoot, "package.json"), "utf8")).version;

  const flatc = await createFlatc();
  fs.mkdirSync(outDir, { recursive: true });
  const ensureDir = (dirPath) => {
    try {
      flatc.FS.mkdir(dirPath);
    } catch {
      /* already present */
    }
  };
  ensureDir("/schemas");
  ensureDir("/out_cpp");

  const allFamilies = fs
    .readdirSync(path.join(standardsRoot, "schema"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const family of allFamilies) {
    ensureDir(`/schemas/${family}`);
    flatc.FS.writeFile(
      `/schemas/${family}/main.fbs`,
      fs.readFileSync(path.join(standardsRoot, "schema", family, "main.fbs"), "utf8"),
    );
  }

  const emitted = {};
  for (const family of SCHEMA_FAMILIES) {
    const schemaPath = path.join(standardsRoot, "schema", family, "main.fbs");
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`${family} schema not found in spacedatastandards.org@${version}`);
    }
    const rc = flatc.callMain([
      "--cpp", "--cpp-std", "c++17", "--gen-object-api", "--preserve-case", "--no-warnings",
      "-I", "/schemas", "-o", "/out_cpp", `/schemas/${family}/main.fbs`,
    ]);
    if (rc !== 0) throw new Error(`flatc failed for ${family}`);
    if (family === "PRW" && !flatc.FS.readFile("/out_cpp/main_generated.h", { encoding: "utf8" }).includes("PRWWindowQuery")) {
      throw new Error(`${standardsRoot} predates the $PRW WINDOW_REQUEST / WINDOW_REPORT arms: set SPACE_DATA_STANDARDS_ROOT`);
    }
    const generated = flatc.FS.readFile("/out_cpp/main_generated.h", { encoding: "utf8" });
    const header = rewriteGeneratedHeader(generated, family, schemaIncludeFamilies(schemaPath));
    fs.writeFileSync(path.join(outDir, `${family}_generated.h`), header);
    emitted[family] = header;
  }
  return { version, headers: emitted, outDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateSdsHeaders()
    .then(({ version }) => {
      console.log(`Generated SDS headers ${SCHEMA_FAMILIES.join(", ")} from spacedatastandards.org@${version}`);
    })
    .catch((error) => {
      console.error(error?.stack ?? String(error));
      process.exitCode = 1;
    });
}
