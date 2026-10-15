// C++ headers for the Space Data Standards this module reads and writes, from
// the schema files of the spacedatastandards.org package it pins
// (published-deps law), generated with the pinned flatc-wasm. Each family is
// generated on its own, its include guard renamed and its includes dropped,
// and the families are concatenated in dependency order into one source.
// SPACE_DATA_STANDARDS_ROOT overrides the package root for building against
// an unpublished standards change, and says so.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import createFlatc from "flatc-wasm/module";

export function standardsRoot(from) {
  const override = process.env.SPACE_DATA_STANDARDS_ROOT;
  if (override) {
    console.log(`[sds] SPACE_DATA_STANDARDS_ROOT override -> ${path.resolve(override)}`);
    return path.resolve(override);
  }
  const root = path.dirname(createRequire(from).resolve("spacedatastandards.org/package.json"));
  process.env.SPACE_DATA_STANDARDS_ROOT = root;
  return root;
}

const includesOf = (text) => [...text.matchAll(/^\s*include\s+"\.\.\/([A-Z0-9_]+)\/main\.fbs";/gm)].map((m) => m[1]);

export async function generateSdsHeaders(roots, from) {
  const root = standardsRoot(from);
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const read = (family) => fs.readFileSync(path.join(root, "schema", family, "main.fbs"), "utf8");
  // Dependency order: every family after the families it includes.
  const order = [];
  const visiting = new Set();
  const visit = (family) => {
    if (order.includes(family)) return;
    if (visiting.has(family)) throw new Error(`include cycle through ${family}`);
    visiting.add(family);
    for (const dep of includesOf(read(family))) visit(dep);
    visiting.delete(family);
    order.push(family);
  };
  roots.forEach(visit);

  const flatc = await createFlatc();
  const mkdir = (dir) => { try { flatc.FS.mkdir(dir); } catch { /* present */ } };
  mkdir("/schemas");
  mkdir("/out");
  for (const family of order) {
    mkdir(`/schemas/${family}`);
    flatc.FS.writeFile(`/schemas/${family}/main.fbs`, read(family));
  }
  const headers = [];
  for (const family of order) {
    const rc = flatc.callMain(["--cpp", "--cpp-std", "c++17", "--preserve-case", "--no-warnings",
      "-I", "/schemas", "-o", "/out", `/schemas/${family}/main.fbs`]);
    if (rc !== 0) throw new Error(`flatc failed for ${family} from spacedatastandards.org@${version}`);
    headers.push(flatc.FS.readFile("/out/main_generated.h", { encoding: "utf8" })
      .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_${family}_MAIN_H_`)
      .replace(/^#include "main_generated\.h"\n/gm, ""));
  }
  return { header: headers.join("\n"), version, families: order };
}
