#!/usr/bin/env node
/**
 * Generate JavaScript FlatBuffer bindings for the aligned-binary schemas that
 * the contract tests exchange with the SGP4 plugin (PropagatorBatchRequest,
 * PropagatorState, CatalogQueryRequest, CatalogQueryResult, and dependencies).
 *
 * flatc-wasm emits TypeScript. esbuild strips the type annotations and emits
 * ES modules that load cleanly in Node >= 22 with no experimental flags. The
 * resulting JS files land under tests/lib/generated/orbpro/* so the contract
 * tests can import them directly.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = __dirname;
const schemasDir = path.join(packageRoot, "schemas");
const outDir = path.join(packageRoot, "tests", "lib", "generated");

// Schemas whose root tables live on the contract-test wire. flatc-wasm
// transitively pulls in the included schemas (CatalogQueryBase, EntityMetadata,
// BaseTypes, StandardsRecordIndex) via --gen-all, so we only list roots.
const rootSchemas = [
  "PropagatorState.fbs",
  "StateVector.fbs", // Contains PropagatorBatchRequest + StateVector struct
  "CatalogQueryRequest.fbs",
  "CatalogQueryResult.fbs",
];

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
}

function walkWasmFs(flatc, root, visitor) {
  const stat = flatc.FS.stat(root);
  if (flatc.FS.isDir(stat.mode)) {
    for (const entry of flatc.FS.readdir(root)) {
      if (entry === "." || entry === "..") continue;
      walkWasmFs(flatc, `${root}/${entry}`, visitor);
    }
  } else {
    visitor(root);
  }
}

async function main() {
  ensureFileExists(schemasDir, "schemas directory");

  const { transform } = await import("esbuild");
  const flatc = await createFlatc();

  const ensureWasmDir = (dirPath) => {
    try {
      flatc.FS.mkdir(dirPath);
    } catch {
      /* already exists */
    }
  };

  ensureWasmDir("/schemas");
  ensureWasmDir("/out_ts");

  for (const schemaFile of fs.readdirSync(schemasDir)) {
    if (!schemaFile.endsWith(".fbs")) continue;
    flatc.FS.writeFile(
      `/schemas/${schemaFile}`,
      fs.readFileSync(path.join(schemasDir, schemaFile), "utf8"),
    );
  }

  for (const root of rootSchemas) {
    const rc = flatc.callMain([
      "--ts",
      "--gen-object-api",
      "--gen-all",
      "--no-warnings",
      "-I",
      "/schemas",
      "-o",
      "/out_ts",
      `/schemas/${root}`,
    ]);
    if (rc !== 0) {
      throw new Error(`flatc failed generating TypeScript for ${root}`);
    }
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const writes = [];
  walkWasmFs(flatc, "/out_ts", (wasmPath) => {
    const relative = wasmPath.replace(/^\/out_ts\//, "");
    if (!relative.endsWith(".ts")) {
      return;
    }
    const source = flatc.FS.readFile(wasmPath, { encoding: "utf8" });
    writes.push({ relative, source });
  });

  for (const { relative, source } of writes) {
    const jsRelative = relative.replace(/\.ts$/, ".js");
    const jsOutPath = path.join(outDir, jsRelative);
    fs.mkdirSync(path.dirname(jsOutPath), { recursive: true });

    // Rewrite the bare `flatbuffers` import so node can resolve it from the
    // generated tree (which sits outside the package's root node_modules).
    const rewritten = source.replace(
      /from\s+['"]flatbuffers['"]/g,
      'from "flatbuffers"',
    );

    const { code } = await transform(rewritten, {
      loader: "ts",
      format: "esm",
      target: "es2022",
    });

    fs.writeFileSync(jsOutPath, code);
  }

  console.log(
    `Generated ${writes.length} JS bindings in ${path.relative(packageRoot, outDir)}/`,
  );
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
