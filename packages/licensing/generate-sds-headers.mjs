#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const standardsRoot = path.join(repoRoot, "packages", "spacedatastandards.org");
const flatcWasmPath = path.join(
  repoRoot,
  "node_modules",
  "flatc-wasm",
  "dist",
  "flatc-wasm.js",
);
const outDir = path.join(__dirname, "src", "cpp", "generated", "sds");

const schemaFamilies = [
  "PLG",
  "ENC",
  "REC",
  "LCH",
  "LPF",
  "LGR",
  "LMR",
  "LCF",
  "KRF",
  "KMF",
];

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
        `generated header for ${family} includes more main_generated.h entries than schema parser found`,
      );
    }
    return `#include "${includeFamily}_generated.h"`;
  });
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
}

async function main() {
  ensureFileExists(flatcWasmPath, "flatc-wasm");
  ensureFileExists(standardsRoot, "spacedatastandards.org");

  const { default: createFlatc } = await import(pathToFileURL(flatcWasmPath).href);
  const flatc = await createFlatc();

  fs.mkdirSync(outDir, { recursive: true });

  const ensureDir = (dirPath) => {
    try {
      flatc.FS.mkdir(dirPath);
    } catch {}
  };

  ensureDir("/schemas");
  ensureDir("/out_cpp");

  const allSchemaFamilies = fs
    .readdirSync(path.join(standardsRoot, "schema"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const family of allSchemaFamilies) {
    ensureDir(`/schemas/${family}`);
    const schemaPath = path.join(standardsRoot, "schema", family, "main.fbs");
    ensureFileExists(schemaPath, `${family} schema`);
    flatc.FS.writeFile(`/schemas/${family}/main.fbs`, fs.readFileSync(schemaPath, "utf8"));
  }

  const generatedFamilies = schemaFamilies.includes("REC")
    ? allSchemaFamilies
    : schemaFamilies;

  for (const family of generatedFamilies) {
    const schemaPath = path.join(standardsRoot, "schema", family, "main.fbs");
    const includeFamilies = schemaIncludeFamilies(schemaPath);
    const rc = flatc.callMain([
      "--cpp",
      "--cpp-std",
      "c++17",
      "--gen-object-api",
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
    fs.writeFileSync(
      path.join(outDir, `${family}_generated.h`),
      rewriteGeneratedHeader(generated, family, includeFamilies),
    );
  }

  console.log(`Generated SDS headers: ${generatedFamilies.join(", ")}`);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
