// Build files/geotiff through the SDK compiler lane as one translation unit:
// the $NCD and $GDI headers generated (object API) from the pinned
// spacedatastandards.org package, the vendored miniz 3.1.2 inflate and
// stb_image 2.30 JPEG decoder (both checked against their SHA-256), and this
// module's sources in dependency order.
import { createHash } from "node:crypto";
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

const VENDOR = {
  "vendor/miniz-3.1.2/miniz.h": "b53b62ed122e559b8f679e3cb787a0b0035fe87a58f909da0e44931678f4e85f",
  "vendor/miniz-3.1.2/miniz.c": "e2c1aeb66eef9191d8c3feb164db2def2335a61d039bf04ed849f6b042433b30",
  // nothings/stb 013ac3beddff3dbffafd5177e7972067cd2b5083 (2024-05-31), stb_image v2.30
  "vendor/stb_image-2.30/stb_image.h": "594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3",
};

function vendored(file) {
  const bytes = fsSync.readFileSync(path.join(root, file));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== VENDOR[file]) throw new Error(`${file} SHA-256 ${sha} does not match ${VENDOR[file]}`);
  return bytes.toString("utf8");
}

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

const local = (name) => fsSync.readFileSync(path.join(root, "src", name), "utf8").replace(/^#pragma once\n/m, "");
const minizC = vendored("vendor/miniz-3.1.2/miniz.c");
const include = '#include "miniz.h"';
if (!minizC.startsWith(`${include}\n`)) throw new Error("vendored miniz.c no longer opens with its header include");
const sourceCode = [
  await sdsHeader("NCD"),
  await sdsHeader("GDI"),
  ["#define MINIZ_NO_ARCHIVE_APIS 1", "#define MINIZ_NO_STDIO 1", "#define MINIZ_NO_TIME 1", "#define MINIZ_NO_ZLIB_APIS 1", "#define MINIZ_NO_ZLIB_COMPATIBLE_NAMES 1", "#define MINIZ_NO_DEFLATE_APIS 1", vendored("vendor/miniz-3.1.2/miniz.h")].join("\n"),
  minizC.slice(include.length + 1),
  ["#define STBI_ONLY_JPEG", "#define STBI_NO_STDIO", "#define STBI_NO_LINEAR", "#define STBI_NO_HDR", "#define STBI_NO_SIMD", "#define STBI_NO_THREAD_LOCALS", "#define STBI_ASSERT(x) ((void)0)", "#define STB_IMAGE_IMPLEMENTATION", vendored("vendor/stb_image-2.30/stb_image.h")].join("\n"),
  ...["tiff.hpp", "codecs.hpp", "project.hpp", "image.hpp", "geotiff.cpp"].map(local),
].join("\n");

const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin-manifest.json"), "utf8"));
const outputPath = path.join(root, "dist/isomorphic/module.wasm");
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({ manifest, sourceCode, language: "c++", outputPath, threadModel: "wasi-sequential" });
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
await fs.copyFile(path.join(root, "plugin-manifest.json"), path.join(root, "dist/plugin-manifest.json"));
await fs.writeFile(path.join(root, "dist/build-provenance.json"), `${JSON.stringify({ spacedatastandards: version, schemas: ["NCD", "GDI"], vendored: VENDOR, threadModel: "wasi-sequential" }, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
