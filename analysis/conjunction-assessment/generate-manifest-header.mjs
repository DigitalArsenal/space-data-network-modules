#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { encodePlgManifest, legacyManifestToPlg } = await import(
  "space-data-module-sdk/manifest"
);

const manifestJson = JSON.parse(
  await readFile(resolve(__dirname, "plugin-manifest.json"), "utf8"),
);
const manifestBytes = encodePlgManifest(legacyManifestToPlg(manifestJson));

// Sanity-check the identifier so build breaks early if the pipeline regresses.
const identifier = new TextDecoder().decode(manifestBytes.slice(4, 8));
if (identifier !== "$PLG") {
  throw new Error(
    `Embedded manifest is not a PLG buffer — identifier at offset 4-7 was ${JSON.stringify(
      identifier,
    )}.`,
  );
}

const varName = "conjunction_assessment_plugin_manifest_bytes";
const guardName = "CONJUNCTION_ASSESSMENT_PLUGIN_MANIFEST_BYTES_H";

const lines = [];
lines.push(`#ifndef ${guardName}`);
lines.push(`#define ${guardName}`);
lines.push("");
lines.push("#include <cstdint>");
lines.push("");
lines.push(`static const unsigned char ${varName}_data[] = {`);

const bytesPerLine = 12;
for (let index = 0; index < manifestBytes.length; index += bytesPerLine) {
  const chunk = [];
  for (
    let chunkIndex = index;
    chunkIndex < Math.min(index + bytesPerLine, manifestBytes.length);
    chunkIndex += 1
  ) {
    chunk.push(`0x${manifestBytes[chunkIndex].toString(16).padStart(2, "0")}`);
  }
  const suffix = index + bytesPerLine < manifestBytes.length ? "," : "";
  lines.push(`  ${chunk.join(", ")}${suffix}`);
}

lines.push("};");
lines.push("");
lines.push(
  `static const uint8_t *${varName} = reinterpret_cast<const uint8_t *>(${varName}_data);`,
);
lines.push(`static const uint32_t ${varName}_len = sizeof(${varName}_data);`);
lines.push("");
lines.push(`#endif  // ${guardName}`);
lines.push("");

await writeFile(
  resolve(__dirname, "src/cpp/generated/plugin_manifest_bytes.h"),
  lines.join("\n"),
);

console.log(
  `Generated plugin_manifest_bytes.h (${manifestBytes.length} bytes)`,
);
