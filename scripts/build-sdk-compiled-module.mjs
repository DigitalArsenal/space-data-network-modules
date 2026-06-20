import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = process.cwd();
const repoRoot = path.resolve(packageDir, "../..");
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

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const commonSource = await readFile(commonPath, "utf8");
const localSharedSource = await readLocalSharedCppSources();
const moduleSource = await readFile(sourcePath, "utf8");
const sdsCppHeaders = await readSdsCppHeaders(manifest);
const sourceCode = `${sdsCppHeaders}\n${commonSource}\n${localSharedSource}\n${moduleSource}`;

await mkdir(outputDir, { recursive: true });

const compilation = await sdk.compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
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
