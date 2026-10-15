// C++ headers for the Space Data Standards a module reads and writes, from the schema files of the
// spacedatastandards.org package it pins (published-deps law), generated with the flatc-wasm it pins, with the
// object API ("T" types, Pack/UnPack). The published package's C++ (dist/<CODE>/<CODE>.cpp.tar.gz, and lib/cpp in
// a checkout of the standards repo) is generated without it, so a module that uses the object API generates its
// headers here, at build time.
//
// Two shapes:
//   generateSdsHeaders  every family the module names, each generated on its own, its include guard renamed and
//                       its includes dropped, concatenated in dependency order into one source with internal
//                       linkage (below).
//   generateSdsHeader   one family, laid out as lib/cpp/<CODE>/main_generated.h is (the families it includes left
//                       as `#include "main_generated.h"`): a drop-in for a build that inlines lib/cpp headers.
//
// The generated code of generateSdsHeaders has internal linkage. The flow compiler links the guest objects of
// several modules into one artifact, and the linker keeps one copy of each equal external C++ symbol. Generated
// code from different releases of a schema (an OMM with and without USER_DEFINED_PARAMETERS) is equal in name and
// different in layout, so the copy the linker kept would be another module's. Each module keeps its own.
//
// SPACE_DATA_STANDARDS_ROOT overrides the package root for building against an unpublished standards
// change, and says so. createFlatc is the module's own flatc-wasm factory (`import createFlatc from
// "flatc-wasm/module"`); without one, the flatc-wasm the module's package resolves is used.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

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

// The standards package, its version, and the families named with every family they include, in dependency
// order (every family after the families it includes).
function schemaClosure(roots, from) {
  const root = standardsRoot(from);
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const read = (family) => fs.readFileSync(path.join(root, "schema", family, "main.fbs"), "utf8");
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
  return { read, version, order };
}

// A flatc with the families' schemas at /schemas/<CODE>/main.fbs; gen(family, flags) returns the generated header.
async function flatcWith({ read, version, order }, from, createFlatc) {
  const flatc = await (createFlatc ?? createRequire(from)("flatc-wasm/module"))();
  const mkdir = (dir) => { try { flatc.FS.mkdir(dir); } catch { /* present */ } };
  mkdir("/schemas");
  mkdir("/out");
  for (const family of order) {
    mkdir(`/schemas/${family}`);
    flatc.FS.writeFile(`/schemas/${family}/main.fbs`, read(family));
  }
  return (family, flags) => {
    const rc = flatc.callMain([...flags, "-I", "/schemas", "-o", "/out", `/schemas/${family}/main.fbs`]);
    if (rc !== 0) throw new Error(`flatc failed for ${family} from spacedatastandards.org@${version}`);
    return flatc.FS.readFile("/out/main_generated.h", { encoding: "utf8" });
  };
}

// roots: the families the module uses; from: the module's own URL (where its package is found).
export async function generateSdsHeaders(roots, from, createFlatc) {
  const closure = schemaClosure(roots, from);
  const gen = await flatcWith(closure, from, createFlatc);
  const headers = closure.order.map((family) =>
    gen(family, ["--cpp", "--cpp-std", "c++17", "--gen-object-api", "--preserve-case", "--no-warnings"])
      .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_${family}_MAIN_H_`)
      .replace(/^#include "main_generated\.h"\n/gm, ""));
  const body = headers.join("\n").replaceAll('#include "flatbuffers/flatbuffers.h"\n', "");
  return {
    header: `#include "flatbuffers/flatbuffers.h"\nnamespace {\n${body}\n}  // namespace\n`,
    version: closure.version,
    families: closure.order,
  };
}

// One family's header with the object API, generated as the standards repo generates lib/cpp/<CODE>/main_generated.h
// (`flatc --preserve-case --cpp`), so a build that post-processes lib/cpp headers takes it unchanged.
export async function generateSdsHeader(family, from, createFlatc) {
  const closure = schemaClosure([family], from);
  const gen = await flatcWith(closure, from, createFlatc);
  return gen(family, ["--preserve-case", "--cpp", "--gen-object-api", "--no-warnings"]);
}
