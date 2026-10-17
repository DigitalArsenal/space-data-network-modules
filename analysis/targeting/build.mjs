import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { composeErfaTranslationUnit } from "../../foundation/frames/erfa-amalgamation.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const modulesRoot = path.resolve(root, "../..");
const sdkRoot = process.env.SPACE_DATA_MODULE_SDK_ROOT ??
  await fs.realpath(path.join(root, "node_modules/space-data-module-sdk"));
const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin-manifest.json"), "utf8"));
const erfa = await composeErfaTranslationUnit();
const [abi, target, sqp, coordsTypes, coordsHeader, coordsImplementation, implementation] = await Promise.all([
  fs.readFile(path.join(sdkRoot, "include/orbpro/orbpro_solver_abi.h"), "utf8"),
  fs.readFile(path.join(modulesRoot, "higherpop/include/higherpop/target.hpp"), "utf8"),
  fs.readFile(path.join(modulesRoot, "analysis/optimal-control/include/optimal_control/sqp.hpp"), "utf8"),
  fs.readFile(path.join(modulesRoot, "propagator/ffm/lib/coords_types.h"), "utf8"),
  fs.readFile(path.join(modulesRoot, "propagator/ffm/lib/coords.h"), "utf8"),
  fs.readFile(path.join(modulesRoot, "propagator/ffm/lib/coords.cpp"), "utf8"),
  fs.readFile(path.join(root, "src/targeting_module.cpp"), "utf8"),
]);
const stripLocalIncludes = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#\s*include\s+"(?:orbpro_solver_abi|higherpop\/target|optimal_control\/sqp|coords|coords_types|erfa|erfam)\.h(?:pp)?"\s*$/.test(line))
    .join("\n");
const sourceCode = [
  abi,
  target,
  sqp,
  erfa.source,
  stripLocalIncludes(coordsTypes),
  stripLocalIncludes(coordsHeader),
  stripLocalIncludes(coordsImplementation),
  stripLocalIncludes(implementation),
].join("\n\n");
const outputPath = path.join(root, "dist/isomorphic/module.wasm");
const buildRoot = path.join(root, ".sdk-build");
await fs.mkdir(buildRoot, { recursive: true });
const staging = await fs.mkdtemp(path.join(buildRoot, "targeting-"));
try {
  const stagedArtifact = path.join(staging, "module.wasm");
  const clangCommand = process.env.SDN_WASI_CLANGXX ?? "wasm32-wasi-clang++";
  const clangVersion = execFileSync(clangCommand, ["--version"], {
    cwd: staging, encoding: "utf8",
  }).split(/\r?\n/, 1)[0];
  const compilation = await compileModuleFromSource({
    manifest,
    sourceCode,
    language: "c++",
    outputPath: stagedArtifact,
    threadModel: "wasi-sequential",
    standardsRoot: process.env.SPACE_DATA_STANDARDS_ROOT,
  });
  if (!compilation.report?.ok) {
    throw new Error(JSON.stringify(compilation.report?.issues ?? [], null, 2));
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(stagedArtifact, outputPath);
  await fs.copyFile(path.join(root, "plugin-manifest.json"), path.join(root, "dist/plugin-manifest.json"));
  const artifact = await fs.readFile(stagedArtifact);
  await fs.writeFile(path.join(root, "dist/build-provenance.json"), `${JSON.stringify({
    pluginId: manifest.pluginId,
    version: manifest.version,
    moduleSdk: JSON.parse(await fs.readFile(path.join(sdkRoot, "package.json"), "utf8")).version,
    compiler: compilation.compiler,
    clangCommand,
    clangVersion,
    threadModel: compilation.threadModel,
    erfaSourceFiles: erfa.fileCount,
    coordinateSource: "propagator/ffm/lib/coords.cpp",
    sourceSha256: createHash("sha256").update(sourceCode).digest("hex"),
    sha256: createHash("sha256").update(artifact).digest("hex"),
    bytes: artifact.length,
  }, null, 2)}\n`);
  console.log(`Built ${path.relative(root, outputPath)} with ${compilation.threadModel}; ${erfa.fileCount} vendored ERFA sources`);
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
