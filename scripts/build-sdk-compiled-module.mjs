import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = process.cwd();
const repoRoot = path.resolve(packageDir, "../..");
const packageJsonPath = path.join(packageDir, "package.json");
const packageRequire = createRequire(path.join(packageDir, "package.json"));
const sdk = await import(pathToFileURL(packageRequire.resolve("space-data-module-sdk")).href);
const bundle = await import(pathToFileURL(packageRequire.resolve("space-data-module-sdk/bundle")).href);
const manifestPath = path.join(packageDir, "plugin-manifest.json");
const sourcePath = path.join(packageDir, "src/cpp/module.cpp");
const commonPath = path.join(repoRoot, "common/hypersonic_module_common.cpp.inc");
const localSharedSourceCandidates = [
  path.join(packageDir, "src/cpp/sensor_shape_model.h"),
  path.join(packageDir, "src/cpp/sensor_shape_model.cpp.inc"),
];
const outputDir = path.join(packageDir, "dist/isomorphic");
const outputPath = path.join(outputDir, "module.wasm");
const moduleSigningKeypairCandidates = [
  process.env.SDM_MODULE_SIGNING_KEYPAIR_PATH,
  path.resolve(
    repoRoot,
    "../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json",
  ),
  path.resolve(
    repoRoot,
    "../../../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json",
  ),
  path.resolve(
    repoRoot,
    "../space-data-module-sdk/test/support/dev-module-signing-keypair.json",
  ),
].filter(Boolean);

async function directoryExists(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveStandardsRoot() {
  const candidates = [
    process.env.SPACE_DATA_STANDARDS_ROOT,
    path.resolve(repoRoot, "../spacedatastandards.org"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await directoryExists(path.join(candidate, "lib", "cpp"))) {
      return candidate;
    }
  }
  return null;
}

async function fileExists(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function boolOption(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function numberOption(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return undefined;
  }
  return Math.trunc(number);
}

async function resolveEmscriptenRoot(compileConfig) {
  const candidates = [
    compileConfig.emscriptenRoot
      ? path.resolve(packageDir, compileConfig.emscriptenRoot)
      : null,
    process.env.SDN_LOCAL_EMSDK_DIR,
    process.env.EMSDK,
    path.join(packageDir, "deps", "emsdk"),
    path.join(repoRoot, "deps", "emsdk"),
    path.join(repoRoot, "analysis", "conjunction-assessment", "deps", "emsdk"),
    path.join(repoRoot, "analysis", "od", "deps", "emsdk"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await fileExists(path.join(candidate, "upstream", "emscripten", "em++"))) {
      return candidate;
    }
  }
  return null;
}

function threadModelOption(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (
    normalized === "single-thread" ||
    normalized === "emscripten-pthreads" ||
    normalized === "wasi-sequential"
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid sdnModuleCompile.threadModel "${value}". Expected ` +
      '"single-thread", "emscripten-pthreads" or "wasi-sequential".',
  );
}

async function resolveCompileOptions(packageJson) {
  const compileConfig = packageJson.sdnModuleCompile ?? {};
  const compileOptions = {
    importedMemory: boolOption(
      process.env.SDM_MODULE_IMPORTED_MEMORY ?? compileConfig.importedMemory,
    ),
    sharedMemory: boolOption(
      process.env.SDM_MODULE_SHARED_MEMORY ?? compileConfig.sharedMemory,
    ),
    initialMemoryBytes: numberOption(
      process.env.SDM_MODULE_INITIAL_MEMORY_BYTES ??
        compileConfig.initialMemoryBytes,
    ),
    maximumMemoryBytes: numberOption(
      process.env.SDM_MODULE_MAXIMUM_MEMORY_BYTES ??
        compileConfig.maximumMemoryBytes,
    ),
  };
  // The thread model decides the toolchain lane and therefore the bytes, so it
  // is DECLARED, never inferred (scripts/lib/thread-model.mjs). Without a
  // declaration the SDK infers one from runtimeTargets, and that inference is a
  // property of the SDK version: [browser, wasmedge] now selects the
  // wasi-threads model, whose artifact guard refuses a guest that never
  // threads. "emscripten-pthreads" builds real wasi-threads
  // (assertPthreadArtifact); "wasi-sequential" builds the same clang target
  // for a guest that provably never spawns and requires
  // manifest.sequentialJustification (assertSequentialArtifact);
  // "single-thread" is the Emscripten STANDALONE_WASM lane.
  // SDM_MODULE_THREAD_MODEL overrides the declaration for spikes only.
  const threadModel = threadModelOption(
    process.env.SDM_MODULE_THREAD_MODEL ?? compileConfig.threadModel,
  );
  if (!threadModel) {
    throw new Error(
      `${path.relative(repoRoot, packageJsonPath)} must declare ` +
        "sdnModuleCompile.threadModel explicitly " +
        '("single-thread", "wasi-sequential" or "emscripten-pthreads"); ' +
        "the build never infers a thread model.",
    );
  }
  compileOptions.threadModel = threadModel;
  const emscriptenRoot = await resolveEmscriptenRoot(compileConfig);
  if (emscriptenRoot) {
    compileOptions.emscriptenRoot = emscriptenRoot;
  } else if (compileOptions.sharedMemory) {
    throw new Error(
      "Shared-memory module builds require a repo-local emsdk. Set " +
        "SDN_LOCAL_EMSDK_DIR or provide package sdnModuleCompile.emscriptenRoot.",
    );
  }
  return compileOptions;
}

async function resolveModuleSigningKeypairPath() {
  for (const candidate of moduleSigningKeypairCandidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Module signing keypair not found. Set SDM_MODULE_SIGNING_KEYPAIR_PATH " +
      `or provide one of: ${moduleSigningKeypairCandidates.join(", ")}`,
  );
}

async function signCompiledArtifact(wasmBytes) {
  const keypairPath = await resolveModuleSigningKeypairPath();
  const keypair = JSON.parse(await readFile(keypairPath, "utf8"));
  const signed = await bundle.signModuleArtifact(wasmBytes, {
    privateKeySeedHex: keypair.privateKeySeedHex,
    keyId: keypair.keyId ?? null,
  });
  await bundle.verifyModuleArtifact(signed.wasmBytes, {
    trustedPublicKeys: [keypair.publicKeyHex],
    requireSignature: true,
  });
  return signed.wasmBytes;
}

async function readSdsCppHeaders(manifest) {
  const standardsRoot = await resolveStandardsRoot();
  if (!standardsRoot) {
    return "";
  }
  const schemaRefs = new Set();
  for (const schema of manifest.schemasUsed ?? []) {
    const schemaName = String(schema?.schemaName ?? "");
    const match = schemaName.match(/^([A-Z][A-Z0-9]{2})(?:\/main)?\.fbs$/i);
    if (match) {
      schemaRefs.add(match[1].toUpperCase());
    }
  }
  const headers = [];
  for (const schemaRef of [...schemaRefs].sort()) {
    const headerPath = path.join(
      standardsRoot,
      "lib",
      "cpp",
      schemaRef,
      "main_generated.h",
    );
    headers.push(await readFile(headerPath, "utf8"));
  }
  return headers.join("\n\n");
}

async function readLocalSharedCppSources() {
  const sources = [];
  for (const candidate of localSharedSourceCandidates) {
    if (await fileExists(candidate)) {
      sources.push(await readFile(candidate, "utf8"));
    }
  }
  return sources.join("\n\n");
}

async function resolveSharedCppSources(compileConfig = {}) {
  const configuredSources = Array.isArray(compileConfig.sharedCppSources)
    ? compileConfig.sharedCppSources
    : [];
  const sources = [];
  for (const configuredSource of configuredSources) {
    const relativePath = String(configuredSource ?? "").trim();
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error(`Invalid shared C++ source path: ${relativePath}`);
    }
    const sourcePath = path.resolve(repoRoot, relativePath);
    const relativeToRoot = path.relative(repoRoot, sourcePath);
    if (
      relativeToRoot.startsWith(`..${path.sep}`) ||
      relativeToRoot === ".." ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw new Error(`Shared C++ source escapes the modules repository: ${relativePath}`);
    }
    if (!(await fileExists(sourcePath))) {
      throw new Error(`Shared C++ source does not exist: ${relativePath}`);
    }
    sources.push(await readFile(sourcePath, "utf8"));
  }
  return sources.join("\n\n");
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const commonSource = await readFile(commonPath, "utf8");
const localSharedSource = await readLocalSharedCppSources();
const configuredSharedSource = await resolveSharedCppSources(
  packageJson.sdnModuleCompile,
);
const moduleSource = await readFile(sourcePath, "utf8");
const sdsCppHeaders = await readSdsCppHeaders(manifest);
const bundledSdsCppHeaders = sdsCppHeaders
  ? `#define SDN_BUNDLED_SDS_CPP_HEADERS 1\n${sdsCppHeaders}`
  : "";
const sourceCode = `${bundledSdsCppHeaders}\n${commonSource}\n${localSharedSource}\n${configuredSharedSource}\n${moduleSource}`;

await mkdir(outputDir, { recursive: true });

const compilation = await sdk.compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  ...(await resolveCompileOptions(packageJson)),
});

const signedWasmBytes = await signCompiledArtifact(compilation.wasmBytes);
await writeFile(outputPath, signedWasmBytes);

console.log(
  JSON.stringify(
    {
      artifactPath: outputPath,
      runtimeTargets: manifest.runtimeTargets,
      exports: compilation.report.exportNames,
    },
    null,
    2,
  ),
);

await sdk.cleanupCompilation(compilation);
