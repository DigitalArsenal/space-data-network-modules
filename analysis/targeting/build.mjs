import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const root = fileURLToPath(new URL(".", import.meta.url));
const modulesRoot = path.resolve(root, "../..");
const sdkRoot = process.env.SPACE_DATA_MODULE_SDK_ROOT ??
  await fs.realpath(path.join(root, "node_modules/space-data-module-sdk"));
const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin-manifest.json"), "utf8"));
const [abi, target, sqp, coordsTypes, coordsHeader, coordsImplementation, implementation] = await Promise.all([
  fs.readFile(path.join(sdkRoot, "include/orbpro/orbpro_solver_abi.h"), "utf8"),
  fs.readFile(path.join(modulesRoot, "higherpop/include/higherpop/target.hpp"), "utf8"),
  fs.readFile(path.join(modulesRoot, "analysis/optimal-control/include/optimal_control/sqp.hpp"), "utf8"),
  fs.readFile(path.join(modulesRoot, "propagator/hpop/lib/coords_types.h"), "utf8"),
  fs.readFile(path.join(modulesRoot, "propagator/hpop/lib/coords.h"), "utf8"),
  fs.readFile(path.join(modulesRoot, "propagator/hpop/lib/coords.cpp"), "utf8"),
  fs.readFile(path.join(root, "src/targeting_module.cpp"), "utf8"),
]);
const stripLocalIncludes = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#\s*include\s+"(?:orbpro_solver_abi|higherpop\/target|optimal_control\/sqp|coords|coords_types)\.h(?:pp)?"\s*$/.test(line))
    .join("\n");
const sourceCode = [
  abi,
  target,
  sqp,
  stripLocalIncludes(coordsTypes),
  stripLocalIncludes(coordsHeader),
  stripLocalIncludes(coordsImplementation),
  stripLocalIncludes(implementation),
].join("\n\n");
const outputPath = path.join(root, "dist/isomorphic/module.wasm");
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  threadModel: "wasi-sequential",
  standardsRoot: process.env.SPACE_DATA_STANDARDS_ROOT,
});
if (!compilation.report?.ok) {
  throw new Error(JSON.stringify(compilation.report?.issues ?? [], null, 2));
}
await fs.copyFile(path.join(root, "plugin-manifest.json"), path.join(root, "dist/plugin-manifest.json"));
console.log(`Built ${path.relative(root, outputPath)} with ${compilation.threadModel}`);
