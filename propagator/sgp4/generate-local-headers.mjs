#!/usr/bin/env node
/**
 * Regenerate the C++ header of the module-local request schema
 * (schemas/StateVector.fbs: PropagatorBatchRequest and the StateVector
 * struct) with the pinned flatc-wasm. `--cpp --gen-mutable` is how the
 * committed header was produced (flatc 25.12.19 headers); the other
 * module-local headers do not change and stay committed as they are.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(packageRoot, "schemas");
const outPath = path.join(packageRoot, "src", "cpp", "generated", "StateVector_generated.h");

const flatc = await createFlatc();
flatc.FS.mkdir("/schemas");
flatc.FS.mkdir("/out");
for (const name of ["StateVector.fbs", "BaseTypes.fbs"]) {
  flatc.FS.writeFile(`/schemas/${name}`, fs.readFileSync(path.join(schemaDir, name)));
}
const rc = flatc.callMain(["--cpp", "--gen-mutable", "-I", "/schemas", "-o", "/out", "/schemas/StateVector.fbs"]);
if (rc !== 0) throw new Error(`flatc failed generating StateVector_generated.h (exit ${rc})`);
fs.writeFileSync(outPath, flatc.FS.readFile("/out/StateVector_generated.h", { encoding: "utf8" }));
console.log(`wrote ${path.relative(packageRoot, outPath)}`);
