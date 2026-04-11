#!/usr/bin/env node
import * as fs from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encodePluginManifest } from "space-data-module-sdk/manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(__dirname, "plugin-manifest.json");
const outputPath = resolve(
  __dirname,
  "src/cpp/generated/sensor_shaders_plugin_manifest_bytes.h",
);

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const bytes = encodePluginManifest(manifest);

await fs.mkdir(dirname(outputPath), { recursive: true });

const guard = "SENSOR_SHADERS_PLUGIN_MANIFEST_BYTES_H";
const symbol = "sensor_shaders_plugin_manifest_bytes";
const lines = [
  `#ifndef ${guard}`,
  `#define ${guard}`,
  "",
  "#include <cstddef>",
  "#include <cstdint>",
  "",
  `static const unsigned char ${symbol}_data[] = {`,
];

for (let index = 0; index < bytes.length; index += 12) {
  const slice = Array.from(bytes.slice(index, index + 12), (byte) =>
    `0x${byte.toString(16).padStart(2, "0")}`,
  );
  lines.push(`  ${slice.join(", ")}${index + 12 < bytes.length ? "," : ""}`);
}

lines.push("};");
lines.push(
  `static const uint8_t *${symbol} = reinterpret_cast<const uint8_t *>(${symbol}_data);`,
);
lines.push(`static const std::size_t ${symbol}_size = sizeof(${symbol}_data);`);
lines.push("");
lines.push(`#endif  // ${guard}`);
lines.push("");

await fs.writeFile(outputPath, lines.join("\n"));
console.log(`Generated ${outputPath} (${bytes.length} bytes)`);
