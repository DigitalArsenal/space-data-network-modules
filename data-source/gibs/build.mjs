// Build data-source/gibs through the SDK compiler lane: the $PNM header
// generated from the pinned spacedatastandards.org package, nlohmann json and
// the shared sha256. One translation unit.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "./sds-header.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const { header, version } = await generateSdsHeader("PNM", import.meta.url);
const json = await fs.readFile(path.resolve(root, "../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp"), "utf8");
const sha = await fs.readFile(path.resolve(root, "../../files/orbit-products/src/sha256.hpp"), "utf8");
const source = await fs.readFile(path.join(root, "src/gibs.cpp"), "utf8");
const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin-manifest.json"), "utf8"));
const outputPath = path.join(root, "dist/isomorphic/module.wasm");
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await compileModuleFromSource({
  manifest,
  sourceCode: [header, json, sha, source].join("\n"),
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
