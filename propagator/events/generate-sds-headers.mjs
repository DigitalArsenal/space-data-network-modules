#!/usr/bin/env node
/**
 * Generate the C++ FlatBuffer headers this module consumes from the PUBLISHED
 * `spacedatastandards.org` npm package (published-deps law, owner 2026-08-21).
 *
 * Before this script the build read `lib/cpp/FRM/main_generated.h` out of a
 * sibling spacedatastandards.org GIT CHECKOUT. That is exactly the local-copy
 * lane the law forbids: the bytes a module compiled against were whatever the
 * neighbouring working tree happened to hold, reproducible nowhere else, and
 * unresolvable from a private task worktree at all. The published package ships
 * `schema/<FAMILY>/main.fbs` and no generated C++, so the headers are generated
 * here with the pinned `flatc-wasm`, from the pinned package version.
 *
 * $FRM includes ../RFM/main.fbs, so RFM is generated alongside it and the
 * cross-family `#include "main_generated.h"` is rewritten to the family name,
 * matching propagator/sgp4's generator.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const standardsRoot = path.join(
  packageRoot,
  "node_modules",
  "spacedatastandards.org",
);
const outDir = path.join(packageRoot, "src", "generated", "sds");

// Families this module references directly, plus their transitive includes.
export const SCHEMA_FAMILIES = ["RFM", "FRM", "PCE", "EVL", "EOP", "TIM", "IDM", "PLD", "LCC", "CAT", "PPE", "OEM", "NCD", "ACW"];

function schemaIncludeFamilies(schemaPath) {
  const includes = [];
  for (const line of fs.readFileSync(schemaPath, "utf8").split(/\r?\n/)) {
    const match = line.match(
      /^\s*include\s+"(?:\.\.\/)?([A-Z0-9_]+)\/main\.fbs";(?:\s*\/\/.*)?\s*$/,
    );
    if (match) {
      includes.push(match[1]);
    }
  }
  return includes;
}

function rewriteGeneratedHeader(generated, family, includeFamilies) {
  const rewritten = generated.replaceAll(
    "FLATBUFFERS_GENERATED_MAIN_H_",
    `FLATBUFFERS_GENERATED_${family}_MAIN_H_`,
  );
  let includeIndex = 0;
  return rewritten.replace(/#include "main_generated\.h"/g, () => {
    const includeFamily = includeFamilies[includeIndex++];
    if (!includeFamily) {
      throw new Error(
        `generated header for ${family} includes more main_generated.h entries than the schema parser found`,
      );
    }
    return `#include "${includeFamily}_generated.h"`;
  });
}

export async function generateSdsHeaders() {
  if (!fs.existsSync(standardsRoot)) {
    throw new Error(
      `spacedatastandards.org not installed at ${standardsRoot}; run npm ci in this package`,
    );
  }
  const version = JSON.parse(
    fs.readFileSync(path.join(standardsRoot, "package.json"), "utf8"),
  ).version;

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
    const includeFamilies = schemaIncludeFamilies(schemaPath);
    const rc = flatc.callMain([
      "--cpp",
      // ACW is consumed by the shared access evaluator, whose canonical
      // bindings use flatc's unscoped enums. The other families use C++17.
      ...(family === "ACW" ? [] : ["--cpp-std", "c++17"]),
      "--gen-object-api",
      "--preserve-case",
      "--no-warnings",
      "-I",
      "/schemas",
      "-o",
      "/out_cpp",
      `/schemas/${family}/main.fbs`,
    ]);
    if (rc !== 0) {
      throw new Error(`flatc failed for ${family}`);
    }
    const generated = flatc.FS.readFile("/out_cpp/main_generated.h", {
      encoding: "utf8",
    });
    const header = rewriteGeneratedHeader(generated, family, includeFamilies);
    fs.writeFileSync(path.join(outDir, `${family}_generated.h`), header);
    emitted[family] = header;
  }
  return { version, headers: emitted, outDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateSdsHeaders()
    .then(({ version }) => {
      console.log(
        `Generated SDS headers ${SCHEMA_FAMILIES.join(", ")} from spacedatastandards.org@${version}`,
      );
    })
    .catch((error) => {
      console.error(error?.stack ?? String(error));
      process.exitCode = 1;
    });
}
