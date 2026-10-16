// The ONE place the adapter's translation unit is composed: build.mjs (the shipped wasmedge artifact) and the adapter
// test (the same source, compiled once with the browser leg admitted so the SDK harness can drive it) both call this.
// nlohmann/json is for the host-call ABI; the $PNM header (from the pinned spacedatastandards.org) for the add results.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { publishedStandardsRoot, readSdsHeader } from "../../terrain-source/sds-headers.mjs";

export const adapterRoot = fileURLToPath(new URL(".", import.meta.url));

export async function composeAdapter() {
  process.env.SPACE_DATA_STANDARDS_ROOT ??= publishedStandardsRoot(import.meta.url);
  const manifest = JSON.parse(await fs.readFile(path.join(adapterRoot, "plugin-manifest.json"), "utf8"));
  const json = await fs.readFile(path.resolve(adapterRoot, "../../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp"), "utf8");
  const pnm = (await readSdsHeader("PNM", import.meta.url))
    .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
  const source = await fs.readFile(path.join(adapterRoot, "src/adapter.cpp"), "utf8");
  return { manifest, sourceCode: `${json}\n${pnm}\n${source}` };
}
