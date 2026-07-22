import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { signModuleArtifact } from "space-data-module-sdk";

const providersRoot = path.dirname(fileURLToPath(import.meta.url));
const standardsRoot = path.resolve(
  providersRoot,
  "../../../../../spacedatastandards.org",
);
const flatcPath = path.resolve(
  providersRoot,
  "../../../../../flatbuffers/build/flatc",
);

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function fsbCatalogEntry() {
  const idl = await readFile(
    path.join(standardsRoot, "schema/FSB/main.fbs"),
    "utf8",
  );
  return {
    schemaCode: "FSB",
    schemaName: "FSB.fbs",
    fileIdentifier: idl.match(/file_identifier\s+"([^"]+)"/)?.[1],
    rootTypeName: idl.match(/root_type\s+([A-Za-z0-9_]+)/)?.[1],
    version: idl.match(/\/\/ Version:\s*([^\n]+)/)?.[1]?.trim(),
    hash: idl.match(/\/\/ Hash:\s*([a-f0-9]+)/)?.[1],
    idl,
    files: [],
  };
}

export async function buildProviderNode({
  nodeRoot,
  defaultSigningByte,
  defaultSigningKeyId,
}) {
  const buildRoot = path.join(nodeRoot, ".build");
  const unsignedRoot = path.join(nodeRoot, "dist/.unsigned");
  const distRoot = path.join(nodeRoot, "dist/isomorphic");
  const developmentSigningSeed = defaultSigningByte.repeat(32);
  const { signingSeed, signingKeyId, developmentOnly } =
    resolveProviderSigning({
      environment: process.env,
      developmentSigningSeed,
      defaultSigningKeyId,
    });

  await rm(buildRoot, { recursive: true, force: true });
  await rm(unsignedRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await mkdir(unsignedRoot, { recursive: true });
  await mkdir(distRoot, { recursive: true });
  await run(
    flatcPath,
    [
      "--no-warnings",
      "--cpp",
      "--aligned",
      "-o",
      buildRoot,
      path.join(standardsRoot, "schema/FSB/main.fbs"),
    ],
    nodeRoot,
  );

  const manifest = JSON.parse(
    await readFile(path.join(nodeRoot, "plugin-manifest.json"), "utf8"),
  );
  const sourceCode = (
    await Promise.all([
      readFile(path.join(standardsRoot, "lib/cpp/FSB/main_generated.h"), "utf8"),
      readFile(path.join(buildRoot, "main_aligned.h"), "utf8"),
      readFile(path.join(providersRoot, "common/provider_runtime.hpp"), "utf8"),
      readFile(path.join(nodeRoot, "src/node.cpp"), "utf8"),
    ])
  ).join("\n\n");

  process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;
  const unsignedPath = path.join(unsignedRoot, "module.wasm");
  const compilation = await compileModuleFromSource({
    manifest,
    catalog: [await fsbCatalogEntry()],
    sourceCode,
    language: "c++",
    outputPath: unsignedPath,
    allowUndefinedImports: true,
    threadModel: "emscripten-pthreads",
  });
  if (!compilation.report?.ok) {
    throw new Error(
      `compiled provider failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`,
    );
  }

  const signed = await signModuleArtifact(compilation.wasmBytes, {
    privateKeySeedHex: signingSeed,
    keyId: signingKeyId,
    signatureScope: "bundle",
  });
  const artifactPath = path.join(distRoot, "module.wasm");
  await writeFile(artifactPath, signed.wasmBytes);
  const exactSha256 = createHash("sha256")
    .update(signed.wasmBytes)
    .digest("hex");
  await writeFile(
    path.join(distRoot, "artifact.json"),
    `${JSON.stringify(
      {
        sha256: exactSha256,
        canonicalModuleHash: signed.canonicalModuleHashHex,
        signedHash: signed.signedHashHex,
        signatureScope: "bundle",
        keyId: signingKeyId,
        threadModel: "wasi-threads",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(nodeRoot, "publisher.json"),
    `${JSON.stringify(
      {
        algorithm: "ed25519",
        keyId: signingKeyId,
        publicKeyHex: signed.signature.publicKeyHex,
        developmentOnly,
      },
      null,
      2,
    )}\n`,
  );
  await rm(unsignedRoot, { recursive: true, force: true });
  await rm(buildRoot, { recursive: true, force: true });
  process.stdout.write(
    `Built signed ${manifest.pluginId} ${exactSha256} (${signed.wasmBytes.byteLength} bytes)\n`,
  );
  return { exactSha256, artifactPath };
}

const providerDevelopmentSigningSeeds = new Set(
  ["51", "52", "53", "54", "55"].map((byte) => byte.repeat(32)),
);

export function resolveProviderSigning({
  environment,
  developmentSigningSeed,
  defaultSigningKeyId,
}) {
  const productionMode =
    environment.NODE_ENV === "production" ||
    environment.SUPPLEMENTAL_OMM_PROVIDER_BUILD_MODE === "production";
  const providerSeed = String(
    environment.SUPPLEMENTAL_OMM_PROVIDER_SIGNING_SEED_HEX ?? "",
  ).trim();
  const providerKeyId = String(
    environment.SUPPLEMENTAL_OMM_PROVIDER_SIGNING_KEY_ID ?? "",
  ).trim();
  const sharedSeed = String(
    environment.SUPPLEMENTAL_OMM_SIGNING_SEED_HEX ?? "",
  ).trim();
  const sharedKeyId = String(
    environment.SUPPLEMENTAL_OMM_SIGNING_KEY_ID ?? "",
  ).trim();
  const hasProviderOverride = Boolean(providerSeed || providerKeyId);
  const configuredSeed = hasProviderOverride ? providerSeed : sharedSeed;
  const configuredKeyId = hasProviderOverride ? providerKeyId : sharedKeyId;
  const signingEnvironmentPrefix = hasProviderOverride
    ? "SUPPLEMENTAL_OMM_PROVIDER"
    : "SUPPLEMENTAL_OMM";

  if ((configuredSeed && !configuredKeyId) || (!configuredSeed && configuredKeyId)) {
    throw new Error(
      `${signingEnvironmentPrefix}_SIGNING_SEED_HEX and ` +
        `${signingEnvironmentPrefix}_SIGNING_KEY_ID must be supplied together`,
    );
  }
  if (productionMode && !configuredSeed) {
    throw new Error(
      "production provider builds require " +
        "SUPPLEMENTAL_OMM_SIGNING_SEED_HEX and " +
        "SUPPLEMENTAL_OMM_SIGNING_KEY_ID (or the provider-specific override pair)",
    );
  }

  const signingSeed = configuredSeed || developmentSigningSeed;
  const signingKeyId = configuredKeyId || defaultSigningKeyId;
  if (!/^[0-9a-fA-F]{64}$/.test(signingSeed)) {
    throw new Error(
      `${signingEnvironmentPrefix}_SIGNING_SEED_HEX must be a 32-byte Ed25519 seed`,
    );
  }
  const developmentOnly = providerDevelopmentSigningSeeds.has(
    signingSeed.toLowerCase(),
  );
  if (productionMode && developmentOnly) {
    throw new Error(
      "production provider builds reject every embedded development signing seed",
    );
  }
  return { signingSeed, signingKeyId, developmentOnly };
}
