#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = __dirname;
const standardsRoot = path.join(
  packageRoot,
  "node_modules",
  "spacedatastandards.org",
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

// flatc always appends an auto MIN/MAX convenience pair to every enum. When a
// schema declares a real member literally named MIN or MAX (SDS $CES
// cesPoolingKind::MAX), the sentinel's generated name collides byte-for-byte
// with the real member's and C++ rejects the duplicate enumerator — which makes
// EVERY header in the tree that transitively includes it uncompilable.
//
// spacedatastandards.org fixes this in its own generator
// (scripts/generateSource.mjs :: dedupeCppEnumConstants, commit 995c82809e).
// This generator calls flatc directly and therefore bypasses that step, so it
// must apply the identical post-process or the two generators disagree and this
// vendored tree silently becomes uncompilable. Keep them in lockstep.
//
// Only flatc's own redundant, always-recomputable sentinel is dropped; the
// declared member keeps its name and ordinal, so nothing on the wire moves.
function dedupeCppEnumConstants(source) {
  const enumRe = /^enum (?:class )?(\w+) : (\w+) \{\n([\s\S]*?)\n\};\n/gm;
  return source.replace(enumRe, (whole, enumName, underlying, body) => {
    const seen = new Set();
    const kept = [];
    for (const line of body.split("\n")) {
      const match = line.match(/^(\s*)(\w+)\s*=\s*(.+?),?\s*$/);
      if (!match) {
        kept.push(line);
        continue;
      }
      const [, indent, ident, value] = match;
      if (seen.has(ident)) {
        continue;
      }
      seen.add(ident);
      kept.push({ indent, ident, value });
    }
    const lastEntryIndex = kept.map((entry) => typeof entry).lastIndexOf("object");
    const rebuilt = kept
      .map((entry, index) => {
        if (typeof entry === "string") {
          return entry;
        }
        const comma = index < lastEntryIndex ? "," : "";
        return `${entry.indent}${entry.ident} = ${entry.value}${comma}`;
      })
      .join("\n");
    const keyword = whole.startsWith("enum class ") ? "enum class" : "enum";
    return `${keyword} ${enumName} : ${underlying} {\n${rebuilt}\n};\n`;
  });
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
}

async function main() {
  ensureFileExists(standardsRoot, "spacedatastandards.org");

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
    fs.writeFileSync(
      path.join(outDir, `${family}_generated.h`),
      dedupeCppEnumConstants(
        rewriteGeneratedHeader(generated, family, includeFamilies),
      ),
    );
  }

  console.log(`Generated SDS headers: ${generatedFamilies.join(", ")}`);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
