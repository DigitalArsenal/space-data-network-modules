import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Directories whose files are never a module's manifest or source, tracked or
// not: dist/ holds the committed artifacts and the manifest copies beside them,
// deps/ holds vendored sources, the rest are build products.
const IGNORED_DIRS = new Set([
  ".build",
  ".sdk-build",
  ".emcache",
  ".ffm-rename-work",
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
  "propagator/ffm",
  "propagator/sgp4",
]);

const OUT_OF_PARITY_SCOPE_PREFIXES = [
  "comms/",
  "delivery/",
  "licensing/",
];

// The isomorphic artifact of a module is a committed file, so the index is a function of the commit and not of what a checkout
// has built: a module's own `sdn-module` target, else dist/isomorphic/module.wasm, else the flow layout's dist/runtime/isomorphic.
// A module whose dist is git-ignored builds on demand (build.mjs); it has no committed artifact and is listed apart, never as missing.
const ARTIFACT_LAYOUTS = [["dist", "isomorphic", "module.wasm"], ["dist", "runtime", "isomorphic", "module.wasm"]];

// The index is a function of the commit: the module list, the source and test files and the committed artifacts all come from this
// list (repository-relative, "/" separators, git's order) and never from walking the file system. A leftover that git ignores or
// has never seen (a build directory holding a plugin manifest or C++ sources) is not in it and cannot be counted.
export function trackedFiles(repoRoot) {
  return execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
}

function isGitIgnored(repoRoot, relativePath) {
  try {
    execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", "--no-index", relativePath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function createCurrentModuleIndex(repoRoot) {
  const tracked = new Set(trackedFiles(repoRoot));
  const indexed = [...tracked].filter((file) => !file.split("/").some((part) => IGNORED_DIRS.has(part)));
  const manifestPaths = indexed.filter((file) => path.posix.basename(file) === "plugin-manifest.json").sort();

  const modules = manifestPaths.map((manifestPath) => {
    const manifestDir = path.posix.dirname(manifestPath);
    const modulePath = manifestDir === "." ? "" : manifestDir;
    const prefix = modulePath ? `${modulePath}/` : "";
    const moduleFiles = indexed.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, manifestPath), "utf8"));
    const sourceFiles = moduleFiles.filter(isSourceFile).sort();
    const testFiles = moduleFiles.filter((file) => isTestFile(`${prefix}${file}`)).sort();
    const packageConfig = readPackageConfig(repoRoot, tracked, modulePath);
    const declaredTarget = packageConfig?.["sdn-module"];
    const artifactPaths = [
      ...(declaredTarget ? [path.join(modulePath, declaredTarget)] : []),
      ...ARTIFACT_LAYOUTS.map((layout) => path.join(modulePath, ...layout)),
    ].map((file) => path.normalize(file));
    const hasIsomorphicWasm = artifactPaths.some((file) => tracked.has(file.split(path.sep).join("/")));
    const buildsOnDemand = !hasIsomorphicWasm && artifactPaths.every((file) => isGitIgnored(repoRoot, file.split(path.sep).join("/")));
    const runtimeTargets = manifest.runtimeTargets ?? [];
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
      buildsOnDemand,
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
    missingIsomorphicWasm: modules.filter((entry) => !entry.hasIsomorphicWasm && !entry.buildsOnDemand).map((entry) => entry.modulePath),
    buildsOnDemand: modules.filter((entry) => entry.buildsOnDemand).map((entry) => entry.modulePath),
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

function readPackageConfig(repoRoot, tracked, modulePath) {
  const packagePath = path.posix.join(modulePath, "package.json");
  if (!tracked.has(packagePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(path.join(repoRoot, packagePath), "utf8"));
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

function isSourceFile(file) {
  return [".c", ".cc", ".cpp", ".cxx"].includes(path.extname(file)) || file.endsWith(".cpp.inc");
}

function isCxxSourceFile(file) {
  return [".cc", ".cpp", ".cxx"].includes(path.extname(file)) || file.endsWith(".cpp.inc");
}

// `file` is repository-relative: a test directory anywhere above the file marks it, a checkout's own location never does.
function isTestFile(file) {
  const base = path.posix.basename(file);
  return base.endsWith(".test.mjs") || base.startsWith("test_") || `/${file}`.includes("/test/") || `/${file}`.includes("/tests/");
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
