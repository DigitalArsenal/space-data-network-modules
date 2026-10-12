/**
 * Build propagator/solar-system-bodies as one translation unit through the SDK
 * compiler lane. The SPK and DAF readers are files/orbit-products' and the
 * rotation evaluator is foundation/frames', amalgamated read-only: one reader,
 * one evaluator, used by whoever needs them.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const root = fileURLToPath(new URL(".", import.meta.url));
const modules = path.resolve(root, "..", "..");
const read = (p) => fs.readFile(p, "utf8");
const stripIncludes = (text) => text.replace(/^#include "[^"]+"\n/gm, "");

const manifest = JSON.parse(await read(path.join(root, "plugin-manifest.json")));
const orbitProducts = path.join(modules, "files", "orbit-products", "src");
const parts = [
  '#include "space_data_module_invoke.h"',
  "#define JSON_NOEXCEPTION 1",
  await read(path.join(modules, "propagator", "sgp4", "src", "cpp", "include", "nlohmann", "json.hpp")),
  stripIncludes(await read(path.join(orbitProducts, "ephemeris_series.hpp"))),
  stripIncludes(await read(path.join(orbitProducts, "daf.hpp"))),
  stripIncludes(await read(path.join(orbitProducts, "spk_read.hpp"))),
  await read(path.join(modules, "foundation", "frames", "src", "iau_body_models.hpp")),
  await read(path.join(root, "src", "text_kernel.hpp")),
  await read(path.join(root, "src", "bodies.hpp")),
  await read(path.join(root, "src", "solar_system_bodies_module.cpp")),
];
const outputPath = path.join(root, "dist", "isomorphic", "module.wasm");
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: parts.join("\n\n"),
  language: "c++",
  outputPath,
  threadModel: manifest.threadModel,
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues, null, 2));
await fs.copyFile(path.join(root, "plugin-manifest.json"), path.join(root, "dist", "plugin-manifest.json"));
const bytes = await fs.readFile(outputPath);
console.log(`Built ${path.relative(root, outputPath)} (${bytes.length} bytes, ${result.compiler}, ${result.threadModel})`);
