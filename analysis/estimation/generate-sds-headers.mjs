import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const standardsRoot = path.join(packageRoot, "node_modules", "spacedatastandards.org");
const outDir = path.join(packageRoot, "src", "generated", "sds");
const ROOT_FAMILIES = ["ODR", "OCM", "TDM", "CRD", "MEM", "TRH"];

function includesFor(family) {
  const schemaPath = path.join(standardsRoot, "schema", family, "main.fbs");
  const result = [];
  for (const line of fs.readFileSync(schemaPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*include\s+"(?:\.\.\/)?([A-Z0-9_]+)\/main\.fbs";/);
    if (match) result.push(match[1]);
  }
  return result;
}

function familyOrder() {
  const ordered = [];
  const visited = new Set();
  const visit = (family) => {
    if (visited.has(family)) return;
    visited.add(family);
    for (const dependency of includesFor(family)) visit(dependency);
    ordered.push(family);
  };
  for (const family of ROOT_FAMILIES) visit(family);
  return ordered;
}

function rewriteHeader(source, family, includes) {
  let includeIndex = 0;
  return source
    .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_${family}_MAIN_H_`)
    .replace(/#include "main_generated\.h"/g, () => {
      const dependency = includes[includeIndex++];
      if (!dependency) throw new Error(`${family}: generated include count drift`);
      return `#include "${dependency}_generated.h"`;
    })
    .replace(/[ \t]+$/gm, "");
}

export async function generateSdsHeaders() {
  if (!fs.existsSync(standardsRoot)) {
    throw new Error(`spacedatastandards.org is not installed at ${standardsRoot}; run npm ci`);
  }
  const version = JSON.parse(fs.readFileSync(path.join(standardsRoot, "package.json"), "utf8")).version;
  const families = familyOrder();
  const flatc = await createFlatc();
  fs.mkdirSync(outDir, { recursive: true });
  const mkdir = (value) => { try { flatc.FS.mkdir(value); } catch { /* exists */ } };
  mkdir("/schemas");
  mkdir("/out_cpp");
  for (const entry of fs.readdirSync(path.join(standardsRoot, "schema"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    mkdir(`/schemas/${entry.name}`);
    flatc.FS.writeFile(`/schemas/${entry.name}/main.fbs`,
      fs.readFileSync(path.join(standardsRoot, "schema", entry.name, "main.fbs"), "utf8"));
  }
  const headers = {};
  for (const family of families) {
    const rc = flatc.callMain(["--cpp", "--cpp-std", "c++17", "--gen-object-api",
      "--preserve-case", "--no-warnings", "-I", "/schemas", "-o", "/out_cpp",
      `/schemas/${family}/main.fbs`]);
    if (rc !== 0) throw new Error(`flatc failed for ${family}`);
    const header = rewriteHeader(flatc.FS.readFile("/out_cpp/main_generated.h", { encoding: "utf8" }),
      family, includesFor(family));
    fs.writeFileSync(path.join(outDir, `${family}_generated.h`), header);
    headers[family] = header;
  }
  return { families, headers, version };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateSdsHeaders().then(({ families, version }) => {
    console.log(`Generated ${families.join(", ")} from spacedatastandards.org@${version}`);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
