// Build files/vcm-text through the SDK compiler lane: the $OCM, $OEM and $NCD
// headers generated (object API) from the pinned spacedatastandards.org
// package, the shared sha256, the reader's VCM layout (files/orbit-products
// src/vcm.hpp, read, never changed), and this module's sources, as one
// translation unit in dependency order.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeaders } from "./generate-sds-headers.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const { version, families, headers } = await generateSdsHeaders();
process.env.SPACE_DATA_STANDARDS_ROOT = path.join(root, "node_modules", "spacedatastandards.org");

const read = (file) => fsSync.readFileSync(file, "utf8");
const stripSds = (source) => source.replace(/^#include "[A-Z0-9_]+_generated\.h"\n/gm, "");
const stripLocal = (source) => source.replace(/^#include "(vcm|vcm_write|vcm_draft|sha256)\.hpp"\n/gm, "");
const orbitProducts = path.resolve(root, "../orbit-products/src");
const sourceCode = [
  "#undef DOMAIN\n#undef SING\n#undef OVERFLOW\n#undef UNDERFLOW\n#undef TLOSS\n#undef PLOSS\n",
  ...families.map((family) => stripSds(headers[family])),
  stripLocal(read(path.join(orbitProducts, "sha256.hpp"))),
  stripLocal(read(path.join(orbitProducts, "vcm.hpp"))),
  stripLocal(read(path.join(root, "src", "vcm_write.hpp"))),
  stripLocal(read(path.join(root, "src", "vcm_draft.hpp"))),
  read(path.join(root, "src", "vcm_text_module.cpp")),
].join("\n\n");

const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin-manifest.json"), "utf8"));
const outputPath = path.join(root, "dist/isomorphic/module.wasm");
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({ manifest, sourceCode, language: "c++", outputPath, threadModel: "wasi-sequential" });
if (result.threadModel !== "wasi-sequential") throw new Error(`Compiler resolved threadModel "${result.threadModel}", not wasi-sequential.`);
if (!result.report?.ok) throw new Error(`Compiled artifact failed SDK validation: ${(result.report?.issues ?? []).map((i) => i.message ?? i.code ?? String(i)).join("; ")}`);
await fs.copyFile(path.join(root, "plugin-manifest.json"), path.join(root, "dist/plugin-manifest.json"));
// Signed in the build, as every module here is: loaders verify before they instantiate.
if (process.argv.includes("--unsigned")) console.log("Unsigned local validation build (--unsigned); no signing key read.");
else execFileSync(process.execPath, [path.join(root, "..", "..", "scripts", "sign-module-artifact.mjs"), outputPath], { stdio: "inherit" });
console.log(`Built ${path.relative(root, outputPath)} against spacedatastandards.org@${version} (exports: ${(result.report?.exportNames ?? []).join(", ")})`);
