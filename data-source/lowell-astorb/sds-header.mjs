// One self-contained C++ header for a Space Data Standards root type and every
// standard it includes, generated with the pinned flatc-wasm from the schema
// files of the spacedatastandards.org package this package resolves
// (published-deps law). Same recipe as analysis/launch-cola/sds-header.mjs,
// resolved from this package so a worktree build needs only this package's
// node_modules. SPACE_DATA_STANDARDS_ROOT overrides the standards root.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export function standardsRoot(from) {
  const override = process.env.SPACE_DATA_STANDARDS_ROOT;
  if (override) {
    console.log(`[sds] SPACE_DATA_STANDARDS_ROOT override -> ${path.resolve(override)}`);
    return path.resolve(override);
  }
  const require = createRequire(from);
  const root = path.dirname(require.resolve("spacedatastandards.org/package.json"));
  process.env.SPACE_DATA_STANDARDS_ROOT = root;
  return root;
}

export async function generateSdsHeader(code, from) {
  const root = standardsRoot(from);
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const require = createRequire(from);
  const flatcEntry = require.resolve("flatc-wasm/module");
  const { default: createFlatc } = await import(pathToFileURL(flatcEntry).href);
  const flatc = await createFlatc();
  const mkdir = (dir) => {
    try {
      flatc.FS.mkdir(dir);
    } catch {
      /* already present */
    }
  };
  mkdir("/schemas");
  mkdir("/out");
  for (const entry of fs.readdirSync(path.join(root, "schema"), { withFileTypes: true })) {
    const file = path.join(root, "schema", entry.name, "main.fbs");
    if (!entry.isDirectory() || !fs.existsSync(file)) continue;
    mkdir(`/schemas/${entry.name}`);
    flatc.FS.writeFile(`/schemas/${entry.name}/main.fbs`, fs.readFileSync(file, "utf8"));
  }
  const rc = flatc.callMain([
    "--cpp", "--cpp-std", "c++17", "--gen-all", "--preserve-case", "--no-warnings",
    "-I", "/schemas", "-o", "/out", `/schemas/${code}/main.fbs`,
  ]);
  if (rc !== 0) throw new Error(`flatc failed for ${code} from spacedatastandards.org@${version}`);
  const header = flatc.FS.readFile("/out/main_generated.h", { encoding: "utf8" });
  if (/#include "main_generated\.h"/.test(header)) {
    throw new Error(`flatc --gen-all left an include in the ${code} header`);
  }
  return { header, version };
}
