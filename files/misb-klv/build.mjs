// Build files/misb-klv through the SDK compiler lane: the $NCD and $GDI
// headers generated (object API) from the pinned spacedatastandards.org
// package, the shared sha256, and this module's sources, as one translation
// unit (sibling #includes are concatenated in dependency order).
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const root = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const standards = path.dirname(require.resolve("spacedatastandards.org/package.json"));
const version = JSON.parse(fsSync.readFileSync(path.join(standards, "package.json"), "utf8")).version;

async function sdsHeader(code) {
  const { default: createFlatc } = await import(pathToFileURL(require.resolve("flatc-wasm/module")).href);
  const flatc = await createFlatc();
  for (const dir of ["/schemas", "/out"]) try { flatc.FS.mkdir(dir); } catch { /* present */ }
  for (const entry of fsSync.readdirSync(path.join(standards, "schema"), { withFileTypes: true })) {
    const file = path.join(standards, "schema", entry.name, "main.fbs");
    if (!entry.isDirectory() || !fsSync.existsSync(file)) continue;
    try { flatc.FS.mkdir(`/schemas/${entry.name}`); } catch { /* present */ }
    flatc.FS.writeFile(`/schemas/${entry.name}/main.fbs`, fsSync.readFileSync(file, "utf8"));
  }
  const rc = flatc.callMain(["--cpp", "--cpp-std", "c++17", "--gen-all", "--gen-object-api", "--preserve-case", "--no-warnings", "-I", "/schemas", "-o", "/out", `/schemas/${code}/main.fbs`]);
  if (rc !== 0) throw new Error(`flatc failed for ${code}`);
  return flatc.FS.readFile("/out/main_generated.h", { encoding: "utf8" }).replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_${code}_MAIN_H_`);
}

const local = (name) => fsSync.readFileSync(path.join(root, "src", name), "utf8").replace(/^#pragma once\n/m, "").replace(/^#include "(ts|h264|mp4|klv|ground)\.hpp"\n/gm, "");
const sha = fsSync.readFileSync(path.resolve(root, "../orbit-products/src/sha256.hpp"), "utf8");
const sourceCode = [
  await sdsHeader("NCD"),
  await sdsHeader("GDI"),
  sha,
  ...["ts.hpp", "h264.hpp", "mp4.hpp", "klv.hpp", "ground.hpp", "misb_klv.cpp"].map(local),
].join("\n");

const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin-manifest.json"), "utf8"));
const outputPath = path.join(root, "dist/isomorphic/module.wasm");
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({ manifest, sourceCode, language: "c++", outputPath, threadModel: "wasi-sequential" });
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, "plugin-manifest.json"), path.join(root, "dist/plugin-manifest.json"));
await fs.writeFile(path.join(root, "dist/build-provenance.json"), `${JSON.stringify({ spacedatastandards: version, schemas: ["NCD", "GDI"], threadModel: "wasi-sequential" }, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
