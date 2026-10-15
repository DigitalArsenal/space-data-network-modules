/**
 * The C++ FlatBuffer header for $MPL (maneuver plan) and the families it
 * includes, generated with flatc-wasm from the standards' own schemas, WITH the
 * object API (--gen-object-api): the module unpacks the request into MPLT,
 * fills the answer's fields and packs it back, so the answer echoes the request
 * exactly as the standard asks without a hand-written deep copy.
 *
 * Families come back in dependency order with their cross-family includes and
 * flatc version asserts dropped and their include guards renamed per family
 * (they are all "main_generated.h"), so build.js can concatenate them into the
 * single translation unit it compiles.
 *
 * SPACE_DATA_STANDARDS_ROOT wins (a per-task standards worktree); otherwise the
 * package's own spacedatastandards.org.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
export const standardsRoot =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? path.join(packageRoot, "node_modules", "spacedatastandards.org");
export const ROOTS = ["MPL"];

export async function generateSdsHeaders() {
  const schemaRoot = path.join(standardsRoot, "schema");
  if (!fs.existsSync(path.join(schemaRoot, "MPL", "main.fbs"))) {
    throw new Error(`No $MPL schema under ${schemaRoot}; set SPACE_DATA_STANDARDS_ROOT.`);
  }
  const flatc = await createFlatc();
  const mkdir = (p) => {
    try {
      flatc.FS.mkdir(p);
    } catch {}
  };
  for (const p of ["/schemas", "/out"]) mkdir(p);
  const dependencies = new Map();
  for (const family of fs.readdirSync(schemaRoot)) {
    const input = path.join(schemaRoot, family, "main.fbs");
    if (!fs.existsSync(input)) continue;
    const schema = fs.readFileSync(input, "utf8");
    dependencies.set(family, [...schema.matchAll(/^\s*include\s+"\.\.\/([^/]+)\/main\.fbs"/gm)].map((m) => m[1]));
    mkdir(`/schemas/${family}`);
    flatc.FS.writeFile(`/schemas/${family}/main.fbs`, schema);
  }
  const families = [];
  const visit = (family) => {
    if (families.includes(family)) return;
    for (const d of dependencies.get(family) ?? []) visit(d);
    families.push(family);
  };
  ROOTS.forEach(visit);
  const headers = {};
  for (const family of families) {
    const rc = flatc.callMain([
      "--cpp", "--cpp-std", "c++17", "--gen-object-api", "--preserve-case", "--no-warnings",
      "-I", "/schemas", "-o", "/out", `/schemas/${family}/main.fbs`,
    ]);
    if (rc !== 0) throw new Error(`flatc C++ failed: ${family}`);
    headers[family] = flatc.FS.readFile("/out/main_generated.h", { encoding: "utf8" })
      .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_SDS_${family}_MAIN_H_`)
      .replace(/^#include "main_generated\.h"\n/gm, "")
      .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "");
  }
  return { families, headers };
}
