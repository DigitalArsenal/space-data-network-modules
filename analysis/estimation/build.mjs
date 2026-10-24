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
// `--out <dir>` builds the same module into <dir> (generated headers in
// <dir>/generated, artifact in <dir>/dist) and leaves the tracked generated
// headers and dist untouched: how the E2E builds the module under test from
// a schema the standards release has not published yet.
const outFlag = process.argv.indexOf("--out");
const outRoot = outFlag > 0 ? path.resolve(process.argv[outFlag + 1]) : null;
const distRoot = path.join(outRoot ?? packageRoot, "dist");
const generatedRoot = outRoot ? path.join(outRoot, "generated") : path.join(packageRoot, "src", "generated");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
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
  await fs.mkdir(path.join(generatedRoot, "invoke"), { recursive: true });
  const headers = [];
  for (const name of ["BaseTypes", "Propagator", "Estimation"]) {
    const rc = flatc.callMain([
      "--cpp", "--cpp-std", "c++17", "--gen-object-api", "-I", "/sdk",
      "-o", "/out", `/sdk/${name}.fbs`,
    ]);
    if (rc !== 0) throw new Error(`flatc failed for SDK ${name}.fbs`);
    const header = flatc.FS.readFile(`/out/${name}_generated.h`, { encoding: "utf8" });
    await fs.writeFile(path.join(generatedRoot, "invoke", `${name}_generated.h`), header);
    headers.push(header);
  }
  return headers;
}

const stripGeneratedIncludes = (source) => source
  .replace(/^#include "[A-Za-z0-9_]+_generated\.h"\n/gm, "")
  .replace(/^#include "estimation\.hpp"\n/gm, "")
  .replace(/^#include "teag\.hpp"\n/gm, "")
  .replace(/^#include "tdm_decode\.hpp"\n/gm, "")
  .replace(/^#include "recovery\.hpp"\n/gm, "")
  .replace(/^#include "relative_nav\.hpp"\n/gm, "");

const { families, headers: sdsHeaders, version: sdsVersion } = await generateSdsHeaders(path.join(generatedRoot, "sds"));
const sdkHeaders = await generateSdkHeaders();
const recoveryHeader = await fs.readFile(path.join(packageRoot, "src", "recovery.hpp"), "utf8");
const relativeHeader = await fs.readFile(path.join(packageRoot, "src", "relative_nav.hpp"), "utf8");
const relativeSource = await fs.readFile(path.join(packageRoot, "src", "relative_nav.cpp"), "utf8");
const estimationHeader = await fs.readFile(path.join(packageRoot, "src", "estimation.hpp"), "utf8");
const estimationSource = await fs.readFile(path.join(packageRoot, "src", "estimation.cpp"), "utf8");
const batchFitSource = await fs.readFile(path.join(packageRoot, "src", "batch_fit.cpp"), "utf8");
const teagHeader = await fs.readFile(path.join(packageRoot, "src", "teag.hpp"), "utf8");
const tdmDecodeHeader = await fs.readFile(path.join(packageRoot, "src", "tdm_decode.hpp"), "utf8");
const espfSource = await fs.readFile(path.join(packageRoot, "src", "espf.cpp"), "utf8");
const moduleSource = await fs.readFile(path.join(packageRoot, "src", "module.cpp"), "utf8");

const sourceCode = [
  ...families.map((family, index) => index === 0
    ? sdsHeaders[family]
    : stripGeneratedIncludes(sdsHeaders[family])),
  ...sdkHeaders.map((header, index) => index === 0 ? header : stripGeneratedIncludes(header)),
  stripGeneratedIncludes(recoveryHeader),
  stripGeneratedIncludes(estimationHeader),
  stripGeneratedIncludes(relativeHeader),
  teagHeader,
  stripGeneratedIncludes(tdmDecodeHeader),
  stripGeneratedIncludes(estimationSource),
  stripGeneratedIncludes(batchFitSource),
  stripGeneratedIncludes(espfSource),
  stripGeneratedIncludes(relativeSource),
  stripGeneratedIncludes(moduleSource),
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
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

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
fsSync.writeFileSync(path.join(distRoot, "build-provenance.json"), `${JSON.stringify({
  spacedatastandards: sdsVersion,
  moduleSdk: JSON.parse(await fs.readFile(path.join(sdkRoot, "package.json"), "utf8")).version,
  family: "estimation",
  invokeContract: {path: "schemas/Estimation.fbs", extension: 2, sha256: crypto.createHash("sha256").update(await fs.readFile(path.join(packageRoot, "schemas", "Estimation.fbs"))).digest("hex")},
  propagatorContract: ["plugin_propagate", "plugin_compute_stm"],
  threadModel: manifest.threadModel,
}, null, 2)}\n`);

console.log(`Built ${path.relative(packageRoot, outputPath)} against spacedatastandards.org@${sdsVersion}`);
