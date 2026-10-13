// The astorb host adapter: generic host configuration, the retrieval receipt,
// and ingest_astorb, which streams the validated records into the node's
// store in parts through the storage_ingest capability. It is built with the
// same parsing core as the portable module (../src/astorb_core.hpp): miniz for
// the inflate, the generated $SBD header, nlohmann json and the shared sha256.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../sds-header.mjs";
import { minizSourceFragments } from "../../geonames-source/miniz-source.mjs";
const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin-manifest.json"), "utf8"));
const { header } = await generateSdsHeader("SBD", new URL("../build.mjs", import.meta.url).href);
const json = await fs.readFile(path.resolve(root, "../../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp"), "utf8");
const sha = await fs.readFile(path.resolve(root, "../../../files/orbit-products/src/sha256.hpp"), "utf8");
const [minizHeader, minizImplementation] = await minizSourceFragments();
const core = await fs.readFile(path.resolve(root, "../src/astorb_core.hpp"), "utf8");
const source = await fs.readFile(path.join(root, "src/adapter.cpp"), "utf8");
const outputPath = path.join(root, "dist/isomorphic/module.wasm");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({ manifest, sourceCode: [minizHeader, minizImplementation, header, json, sha, core, source].join("\n"), language: "c++", outputPath, threadModel: "wasi-sequential", allowUndefinedImports: true });
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues));
const guest = path.join(root, "dist/guest-link");
await fs.mkdir(guest, { recursive: true });
await fs.writeFile(path.join(guest, "module-link.o"), result.guestLink.objectBytes);
const { format, language, threadModel, symbolPrefix, methodSymbols } = result.guestLink;
await fs.writeFile(path.join(guest, "metadata.json"), JSON.stringify({ version: 1, format, language, threadModel, symbolPrefix, methodSymbols }, null, 2) + "\n");
console.log(`Built ${outputPath}`);
