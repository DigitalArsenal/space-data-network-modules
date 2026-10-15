// Build data-source/body-imagery through the SDK compiler lane: the $PNM
// header generated from the pinned spacedatastandards.org package, nlohmann
// json, the shared sha256 and the module's baseline JPEG encoder. One
// translation unit.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../lowell-astorb/sds-header.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const { header, version } = await generateSdsHeader("PNM", import.meta.url);
const json = await fs.readFile(path.resolve(root, "../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp"), "utf8");
const sha = await fs.readFile(path.resolve(root, "../../files/orbit-products/src/sha256.hpp"), "utf8");
const jpeg = await fs.readFile(path.join(root, "src/jpeg_encoder.hpp"), "utf8");
// stb_image 2.30 (public domain / MIT, github.com/nothings/stb at
// 013ac3beddff3dbffafd5177e7972067cd2b5083), JPEG only, SHA-256 pinned: the
// decoder for the giant planets' JPEG cloud maps.
const stbPath = path.join(root, "vendor/stb_image-2.30/stb_image.h");
const stbBytes = await fs.readFile(stbPath);
const stbSha = (await import("node:crypto")).createHash("sha256").update(stbBytes).digest("hex");
if (stbSha !== "594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3") throw new Error(`vendored stb_image.h SHA-256 ${stbSha} does not match the pin`);
const stb = ["#define STB_IMAGE_IMPLEMENTATION", "#define STBI_ONLY_JPEG", "#define STBI_NO_STDIO", "#define STBI_NO_LINEAR", "#define STBI_NO_HDR",
  "#define STBI_NO_SIMD", "#define STBI_NO_THREAD_LOCALS", "#define STBI_MAX_DIMENSIONS 16384", stbBytes.toString("utf8")].join("\n");
const source = await fs.readFile(path.join(root, "src/body_imagery.cpp"), "utf8");
const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin-manifest.json"), "utf8"));
const outputPath = path.join(root, "dist/isomorphic/module.wasm");
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: [header, json, sha, jpeg, stb, source].join("\n"),
  language: "c++",
  outputPath,
  threadModel: "wasi-sequential",
});
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
const guest = path.join(root, "dist/guest-link");
await fs.mkdir(guest, { recursive: true });
await fs.writeFile(path.join(guest, "module-link.o"), result.guestLink.objectBytes);
const { format, language, threadModel, symbolPrefix, methodSymbols } = result.guestLink;
await fs.writeFile(path.join(guest, "metadata.json"), JSON.stringify({ version: 1, format, language, threadModel, symbolPrefix, methodSymbols }, null, 2) + "\n");
await fs.copyFile(path.join(root, "plugin-manifest.json"), path.join(root, "dist/plugin-manifest.json"));
await fs.writeFile(path.join(root, "dist/build-provenance.json"), `${JSON.stringify({ spacedatastandards: version, schema: "PNM", threadModel: "wasi-sequential" }, null, 2)}\n`);
console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
