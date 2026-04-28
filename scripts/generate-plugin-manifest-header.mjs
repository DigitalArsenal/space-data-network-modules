#!/usr/bin/env node

import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const options = {
    packageDir: process.cwd(),
    manifest: "plugin-manifest.json",
    out: "src/cpp/generated/plugin_manifest_bytes.h",
    varName: null,
    sizeVar: null,
    guard: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--package-dir":
        options.packageDir = path.resolve(requireValue(argv, ++index, value));
        break;
      case "--manifest":
        options.manifest = requireValue(argv, ++index, value);
        break;
      case "--out":
        options.out = requireValue(argv, ++index, value);
        break;
      case "--var":
        options.varName = requireValue(argv, ++index, value);
        break;
      case "--size-var":
        options.sizeVar = requireValue(argv, ++index, value);
        break;
      case "--guard":
        options.guard = requireValue(argv, ++index, value);
        break;
      default:
        throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!options.varName) {
    throw new Error("--var is required.");
  }

  options.manifestPath = path.resolve(options.packageDir, options.manifest);
  options.outputPath = path.resolve(options.packageDir, options.out);
  options.sizeVar ??= `${options.varName}_len`;
  options.guard ??= `${options.varName.toUpperCase()}_H`;
  return options;
}

function requireValue(argv, index, flagName) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flagName} requires a value.`);
  }
  return value;
}

function renderByteRows(bytes) {
  const rows = [];
  for (let index = 0; index < bytes.length; index += 12) {
    const chunk = [];
    for (
      let chunkIndex = index;
      chunkIndex < Math.min(index + 12, bytes.length);
      chunkIndex += 1
    ) {
      chunk.push(`0x${bytes[chunkIndex].toString(16).padStart(2, "0")}`);
    }
    const suffix = index + 12 < bytes.length ? "," : "";
    rows.push(`  ${chunk.join(", ")}${suffix}`);
  }
  return rows;
}

async function loadManifestCodec(packageDir) {
  const requireFromPackage = createRequire(path.join(packageDir, "package.json"));
  const manifestModulePath = requireFromPackage.resolve(
    "space-data-module-sdk/manifest",
  );
  return import(pathToFileURL(manifestModulePath).href);
}

const options = parseArgs(process.argv.slice(2));
const { encodePlgManifest, legacyManifestToPlg } = await loadManifestCodec(
  options.packageDir,
);

const manifestJson = JSON.parse(await readFile(options.manifestPath, "utf8"));
const manifestBytes = encodePlgManifest(legacyManifestToPlg(manifestJson));

const identifier = new TextDecoder().decode(manifestBytes.slice(4, 8));
if (identifier !== "$PLG") {
  throw new Error(
    `Embedded manifest is not a PLG buffer; identifier at offset 4-7 was ${JSON.stringify(
      identifier,
    )}.`,
  );
}

const lines = [];
lines.push(`#ifndef ${options.guard}`);
lines.push(`#define ${options.guard}`);
lines.push("");
lines.push("#include <cstdint>");
lines.push("");
lines.push(`static const unsigned char ${options.varName}_data[] = {`);
lines.push(...renderByteRows(manifestBytes));
lines.push("};");
lines.push("");
lines.push(
  `static const uint8_t *${options.varName} = reinterpret_cast<const uint8_t *>(${options.varName}_data);`,
);
lines.push(
  `static const uint32_t ${options.sizeVar} = sizeof(${options.varName}_data);`,
);
lines.push("");
lines.push(`#endif  // ${options.guard}`);
lines.push("");

await writeFile(options.outputPath, lines.join("\n"));
console.log(
  `Generated ${path.relative(options.packageDir, options.outputPath)} (${manifestBytes.length} bytes, $PLG)`,
);
