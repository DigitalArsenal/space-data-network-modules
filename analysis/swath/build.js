import { mkdir, writeFile } from "node:fs/promises";

import { createLegacyBuildManifest } from "./manifest.js";

const OUTPUT_DIR = new URL("./dist/", import.meta.url);
const OUTPUT_FILE = new URL("./manifest.json", import.meta.url);
const DIST_OUTPUT_FILE = new URL("./dist/manifest.json", import.meta.url);

async function main() {
  const manifest = createLegacyBuildManifest();
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_FILE, json, "utf8");
  await writeFile(DIST_OUTPUT_FILE, json, "utf8");
}

await main();
