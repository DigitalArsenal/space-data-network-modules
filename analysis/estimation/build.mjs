import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { loadKnownTypeCatalog } from "space-data-module-sdk/standards";

import { generateSdsHeaders } from "./generate-sds-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const outputPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const sdkRoot = path.join(packageRoot, "node_modules", "space-data-module-sdk");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

process.env.SPACE_DATA_STANDARDS_ROOT = path.join(
  packageRoot,
  "node_modules",
  "spacedatastandards.org",
);

async function generateSdkHeaders() {
  const schemasRoot = path.join(sdkRoot, "schemas", "orbpro");
  const flatc = await createFlatc();
  flatc.FS.mkdir("/sdk");
  flatc.FS.mkdir("/out");
  for (const name of await fs.readdir(schemasRoot)) {
    if (!name.endsWith(".fbs")) continue;
    flatc.FS.writeFile(`/sdk/${name}`, await fs.readFile(path.join(schemasRoot, name)));
  }
  flatc.FS.writeFile("/sdk/Estimation.fbs", await fs.readFile(path.join(packageRoot, "schemas", "Estimation.fbs")));
  await fs.mkdir(path.join(packageRoot, "src", "generated", "invoke"), { recursive: true });
  const headers = [];
  for (const name of ["BaseTypes", "Propagator", "Estimation"]) {
    const rc = flatc.callMain([
      "--cpp", "--cpp-std", "c++17", "--gen-object-api", "-I", "/sdk",
      "-o", "/out", `/sdk/${name}.fbs`,
    ]);
    if (rc !== 0) throw new Error(`flatc failed for SDK ${name}.fbs`);
    const header = flatc.FS.readFile(`/out/${name}_generated.h`, { encoding: "utf8" });
    await fs.writeFile(path.join(packageRoot, "src", "generated", "invoke", `${name}_generated.h`), header);
    headers.push(header);
  }
  return headers;
}

const stripGeneratedIncludes = (source) => source
  .replace(/^#include "[A-Za-z0-9_]+_generated\.h"\n/gm, "")
  .replace(/^#include "estimation\.hpp"\n/gm, "");

const { families, headers: sdsHeaders, version: sdsVersion } = await generateSdsHeaders();
const sdkHeaders = await generateSdkHeaders();
const estimationHeader = await fs.readFile(path.join(packageRoot, "src", "estimation.hpp"), "utf8");
const estimationSource = await fs.readFile(path.join(packageRoot, "src", "estimation.cpp"), "utf8");
const batchFitSource = await fs.readFile(path.join(packageRoot, "src", "batch_fit.cpp"), "utf8");
const moduleSource = await fs.readFile(path.join(packageRoot, "src", "module.cpp"), "utf8");

const sourceCode = [
  ...families.map((family, index) => index === 0
    ? sdsHeaders[family]
    : stripGeneratedIncludes(sdsHeaders[family])),
  ...sdkHeaders.map((header, index) => index === 0 ? header : stripGeneratedIncludes(header)),
  estimationHeader,
  stripGeneratedIncludes(estimationSource),
  stripGeneratedIncludes(batchFitSource),
  stripGeneratedIncludes(moduleSource),
].join("\n\n");

await fs.rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  threadModel: manifest.threadModel,
  standardsRoot: process.env.SPACE_DATA_STANDARDS_ROOT,
  catalog: await (async () => {
    const catalog = [...await loadKnownTypeCatalog({ standardsRoot: process.env.SPACE_DATA_STANDARDS_ROOT })];
    // A source release is built before its generated dist/manifest.json is
    // refreshed. Register only identities present in the exact pinned schema
    // trees, and only when the published catalogs have not learned them yet.
    for (const entry of [
      { schemaCode: "ESTIMATION", schemaName: "Estimation.fbs", fileIdentifier: "$EST", rootTypeName: "EstimationEnvelope", source: "module-local-append-only-schema" },
      { schemaCode: "MEM", schemaName: "MEM.fbs", fileIdentifier: "$MEM", rootTypeName: "MEM", source: "sds-pinned-schema" },
      { schemaCode: "ODR", schemaName: "ODR.fbs", fileIdentifier: "$ODR", rootTypeName: "ODR", source: "sds-pinned-schema" },
      { schemaCode: "TRH", schemaName: "TRH.fbs", fileIdentifier: "$TRH", rootTypeName: "TRH", source: "sds-pinned-schema" },
    ]) {
      if (!catalog.some((known) => known.schemaName === entry.schemaName && known.fileIdentifier === entry.fileIdentifier)) catalog.push(entry);
    }
    return catalog;
  })(),
});

if (!compilation.report?.ok) {
  throw new Error(`compiled artifact failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`);
}

await fs.copyFile(manifestPath, path.join(packageRoot, "dist", "plugin-manifest.json"));
fsSync.writeFileSync(path.join(packageRoot, "dist", "build-provenance.json"), `${JSON.stringify({
  spacedatastandards: sdsVersion,
  moduleSdk: JSON.parse(await fs.readFile(path.join(sdkRoot, "package.json"), "utf8")).version,
  family: "estimation",
  invokeContract: {path: "schemas/Estimation.fbs", extension: 2, sha256: crypto.createHash("sha256").update(await fs.readFile(path.join(packageRoot, "schemas", "Estimation.fbs"))).digest("hex")},
  propagatorContract: ["plugin_propagate", "plugin_compute_stm"],
  threadModel: manifest.threadModel,
}, null, 2)}\n`);

console.log(`Built ${path.relative(packageRoot, outputPath)} against spacedatastandards.org@${sdsVersion}`);
