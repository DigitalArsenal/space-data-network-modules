#!/usr/bin/env node
/**
 * Generate plugin_manifest_bytes.h from plugin-manifest.json
 * using the space-data-module-sdk manifest encoder.
 */
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

const identifier = new TextDecoder().decode(manifestBytes.slice(4, 8));
if (identifier !== "$PLG") {
  throw new Error(
    `Embedded manifest is not a PLG buffer; identifier at offset 4-7 was ${JSON.stringify(
      identifier,
    )}.`,
  );
}

const varName = "protection_key_server_plugin_manifest_bytes";
const guardName = "PROTECTION_KEY_SERVER_PLUGIN_MANIFEST_BYTES_H";

let lines = [];
lines.push(`#ifndef ${guardName}`);
lines.push(`#define ${guardName}`);
lines.push("");
lines.push("#include <cstdint>");
lines.push("");
lines.push(`static const unsigned char ${varName}_data[] = {`);

const bytesPerLine = 12;
for (let i = 0; i < manifestBytes.length; i += bytesPerLine) {
  const chunk = [];
  for (let j = i; j < Math.min(i + bytesPerLine, manifestBytes.length); j++) {
    chunk.push(`0x${manifestBytes[j].toString(16).padStart(2, "0")}`);
  }
  const comma = i + bytesPerLine < manifestBytes.length ? "," : "";
  lines.push(`  ${chunk.join(", ")}${comma}`);
}

lines.push("};");
lines.push("");
lines.push(
  `static const uint8_t *${varName} = reinterpret_cast<const uint8_t *>(${varName}_data);`,
);
lines.push(
  `static const uint32_t ${varName}_len = sizeof(${varName}_data);`,
);
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
