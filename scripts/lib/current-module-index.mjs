import fs from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".build",
  ".emcache",
  ".git",
  "CMakeFiles",
  "build",
  "build-browser",
  "build-isomorphic",
  "build-native",
  "build-wasm",
  "deps",
  "dist",
  "node_modules",
]);

const PARITY_UPDATE_MODULES = new Set([
  "analysis/access",
  "analysis/conjunction-assessment",
  "analysis/covariance",
  "analysis/lambert-izzo",
  "analysis/maneuver",
  "analysis/od",
  "basilisk/runtime",
  "foundation/attitude-math",
  "foundation/math-bspline",
  "foundation/orbits",
  "foundation/time",
  "propagator/atmosphere",
  "propagator/cislunar",
  "propagator/hpop",
  "propagator/sgp4",
]);

const OUT_OF_PARITY_SCOPE_PREFIXES = [
  "comms/",
  "delivery/",
  "licensing/",
];

export function createCurrentModuleIndex(repoRoot) {
  const manifestPaths = walk(repoRoot, (file) => path.basename(file) === "plugin-manifest.json")
    .filter((file) => !path.relative(repoRoot, file).split(path.sep).some((part) => IGNORED_DIRS.has(part)))
    .sort();

  const modules = manifestPaths.map((manifestPath) => {
    const moduleRoot = path.dirname(manifestPath);
    const modulePath = path.relative(repoRoot, moduleRoot);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const sourceFiles = walk(moduleRoot, isSourceFile)
      .filter((file) => !path.relative(moduleRoot, file).split(path.sep).some((part) => IGNORED_DIRS.has(part)))
      .map((file) => path.relative(moduleRoot, file))
      .sort();
    const testFiles = walk(moduleRoot, isTestFile)
      .filter((file) => !path.relative(moduleRoot, file).split(path.sep).some((part) => IGNORED_DIRS.has(part)))
      .map((file) => path.relative(moduleRoot, file))
      .sort();
    const hasIsomorphicWasm = fs.existsSync(path.join(moduleRoot, "dist", "isomorphic", "module.wasm"));
    const runtimeTargets = manifest.runtimeTargets ?? [];
    const packageConfig = readPackageConfig(moduleRoot);
    const isSharedBrowserDirectModule =
      runtimeTargets.length === 1 &&
      runtimeTargets.includes("browser") &&
      Array.isArray(manifest.invokeSurfaces) &&
      manifest.invokeSurfaces.length === 1 &&
      manifest.invokeSurfaces.includes("direct") &&
      packageConfig?.sdnModuleCompile?.sharedMemory === true &&
      packageConfig?.sdnModuleCompile?.importedMemory === true;
    const hasBrowserWasmEdgeTargets =
      runtimeTargets.includes("browser") && runtimeTargets.includes("wasmedge");
    const sourceLanguages = [...new Set(sourceFiles.map(sourceLanguage).filter(Boolean))].sort();
    const parityScope = isParityScope(modulePath);
    return {
      modulePath,
      pluginId: manifest.pluginId ?? null,
      name: manifest.name ?? null,
      pluginFamily: manifest.pluginFamily ?? modulePath.split("/")[0],
      version: manifest.version ?? null,
      methodIds: (manifest.methods ?? []).map((method) => method.methodId).sort(),
      runtimeTargets,
      hasBrowserWasmEdgeTargets,
      isSharedBrowserDirectModule,
      hasIsomorphicWasm,
      sourceLanguages,
      cxxSourceFileCount: sourceFiles.filter(isCxxSourceFile).length,
      cSourceFileCount: sourceFiles.filter((file) => path.extname(file) === ".c").length,
      testFileCount: testFiles.length,
      parityScope,
      action: classifyAction(modulePath, parityScope, hasIsomorphicWasm, sourceFiles),
      sourceFiles,
      testFiles,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    moduleCount: modules.length,
    parityScopeModuleCount: modules.filter((entry) => entry.parityScope).length,
    isomorphicWasmCount: modules.filter((entry) => entry.hasIsomorphicWasm).length,
    missingIsomorphicWasm: modules.filter((entry) => !entry.hasIsomorphicWasm).map((entry) => entry.modulePath),
    browserWasmEdgeTargetCount: modules.filter((entry) => entry.hasBrowserWasmEdgeTargets).length,
    parityScopeMissingCxx: modules
      .filter((entry) => entry.parityScope && entry.cxxSourceFileCount === 0 && entry.cSourceFileCount === 0)
      .map((entry) => entry.modulePath),
    parityScopeTargetGaps: modules
      .filter((entry) => entry.parityScope && !entry.hasBrowserWasmEdgeTargets)
      .map((entry) => entry.modulePath),
    parityScopeUpdateModules: modules
      .filter((entry) => entry.parityScope && entry.action !== "create-new")
      .map((entry) => entry.modulePath),
    modules,
  };
}

function readPackageConfig(moduleRoot) {
  const packagePath = path.join(moduleRoot, "package.json");
  if (!fs.existsSync(packagePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(packagePath, "utf8"));
}

function classifyAction(modulePath, parityScope, hasIsomorphicWasm, sourceFiles) {
  if (!parityScope) {
    return "outside-orekit-basilisk-parity";
  }
  if (PARITY_UPDATE_MODULES.has(modulePath)) {
    if (!hasIsomorphicWasm || sourceFiles.length === 0) {
      return "replace-or-update-for-parity";
    }
    return "update-for-parity";
  }
  return "review-before-parity-use";
}

function isParityScope(modulePath) {
  if (OUT_OF_PARITY_SCOPE_PREFIXES.some((prefix) => modulePath.startsWith(prefix))) {
    return false;
  }
  return [
    "analysis/",
    "attitude/",
    "basilisk/",
    "data/",
    "files/",
    "foundation/",
    "gnss/",
    "models/",
    "propagator/",
  ].some((prefix) => modulePath.startsWith(prefix));
}

function walk(dir, predicate) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        return [];
      }
      return walk(full, predicate);
    }
    return entry.isFile() && predicate(full) ? [full] : [];
  });
}

function isSourceFile(file) {
  return [".c", ".cc", ".cpp", ".cxx"].includes(path.extname(file)) || file.endsWith(".cpp.inc");
}

function isCxxSourceFile(file) {
  return [".cc", ".cpp", ".cxx"].includes(path.extname(file)) || file.endsWith(".cpp.inc");
}

function isTestFile(file) {
  const base = path.basename(file);
  return base.endsWith(".test.mjs") || base.startsWith("test_") || file.includes(`${path.sep}test${path.sep}`) || file.includes(`${path.sep}tests${path.sep}`);
}

function sourceLanguage(file) {
  const extension = path.extname(file);
  if (extension === ".c") {
    return "c";
  }
  if ([".cc", ".cpp", ".cxx"].includes(extension) || file.endsWith(".cpp.inc")) {
    return "c++";
  }
  return null;
}
