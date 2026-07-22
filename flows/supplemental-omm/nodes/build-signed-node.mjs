import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { signModuleArtifact } from "space-data-module-sdk";

import { resolveSupplementalSigning } from "./signing.mjs";

const nodesRoot = path.dirname(fileURLToPath(import.meta.url));
const standardsRoot = path.resolve(nodesRoot, "../../../../spacedatastandards.org");
const flatcPath = path.resolve(nodesRoot, "../../../../flatbuffers/build/flatc");

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

async function catalogEntry(schemaCode) {
  const idl = await readFile(
    path.join(standardsRoot, `schema/${schemaCode}/main.fbs`),
    "utf8",
  );
  return {
    schemaCode,
    schemaName: `${schemaCode}.fbs`,
    fileIdentifier: idl.match(/file_identifier\s+"([^"]+)"/)?.[1],
    rootTypeName: idl.match(/root_type\s+([A-Za-z0-9_]+)/)?.[1],
    version: idl.match(/\/\/ Version:\s*([^\n]+)/)?.[1]?.trim(),
    hash: idl.match(/\/\/ Hash:\s*([a-f0-9]+)/)?.[1],
    idl,
    files: [],
  };
}

function scopeGeneratedHeaderGuard(source, schemaCode) {
  return source.replaceAll(
    "FLATBUFFERS_GENERATED_MAIN_H_",
    `FLATBUFFERS_GENERATED_${schemaCode.toUpperCase()}_MAIN_H_`,
  );
}

function shareAlignedRuntime(source) {
  const namespaceStart = "namespace flatbuffers {\nnamespace aligned_runtime {";
  const namespaceEnd =
    "}  // namespace aligned_runtime\n}  // namespace flatbuffers";
  if (!source.includes(namespaceStart) || !source.includes(namespaceEnd)) {
    throw new Error("generated aligned header is missing its shared runtime");
  }
  return source
    .replace(
      namespaceStart,
      "#ifndef SDN_SUPPLEMENTAL_ALIGNED_RUNTIME_DEFINED\n" +
        "#define SDN_SUPPLEMENTAL_ALIGNED_RUNTIME_DEFINED\n" +
        namespaceStart,
    )
    .replace(namespaceEnd, `${namespaceEnd}\n#endif`);
}

export async function buildSignedNode({
  nodeRoot,
  catalogSchemas,
  headerSchemas = [],
  alignedSchemas = [],
  signingEnvironmentPrefix,
  defaultSigningByte,
  defaultSigningKeyId,
}) {
  const buildRoot = path.join(nodeRoot, ".build");
  const unsignedRoot = path.join(nodeRoot, "dist/.unsigned");
  const distRoot = path.join(nodeRoot, "dist/isomorphic");
  const manifestPath = path.join(nodeRoot, "plugin-manifest.json");
  const sourcePath = path.join(nodeRoot, "src/node.cpp");
  const defaultSigningSeed = defaultSigningByte.repeat(32);
  const { signingSeed, signingKeyId, developmentOnly } =
    resolveSupplementalSigning({
      environment: process.env,
      environmentPrefix: signingEnvironmentPrefix,
      developmentSigningSeed: defaultSigningSeed,
      defaultSigningKeyId,
    });

  await rm(buildRoot, { recursive: true, force: true });
  await rm(unsignedRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await mkdir(unsignedRoot, { recursive: true });
  await mkdir(distRoot, { recursive: true });

  for (const schemaCode of alignedSchemas) {
    const outputRoot = path.join(buildRoot, schemaCode);
    await mkdir(outputRoot, { recursive: true });
    await run(
      flatcPath,
      [
        "--no-warnings",
        "--cpp",
        "--aligned",
        "-o",
        outputRoot,
        path.join(standardsRoot, `schema/${schemaCode}/main.fbs`),
      ],
      nodeRoot,
    );
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const catalog = await Promise.all(catalogSchemas.map(catalogEntry));
  const sourceCode = (
    await Promise.all([
      ...headerSchemas.map((schemaCode) =>
        readFile(
          path.join(standardsRoot, `lib/cpp/${schemaCode}/main_generated.h`),
          "utf8",
        ).then((source) => scopeGeneratedHeaderGuard(source, schemaCode)),
      ),
      ...alignedSchemas.map((schemaCode) =>
        readFile(path.join(buildRoot, schemaCode, "main_aligned.h"), "utf8").then(
          shareAlignedRuntime,
        ),
      ),
      readFile(sourcePath, "utf8"),
    ])
  ).join("\n\n");

  process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;
  const unsignedPath = path.join(unsignedRoot, "module.wasm");
  const compilation = await compileModuleFromSource({
    manifest,
    catalog,
    sourceCode,
    language: "c++",
    outputPath: unsignedPath,
    allowUndefinedImports: true,
  });
  if (!compilation.report?.ok) {
    throw new Error(
      `compiled node failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`,
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
  process.stdout.write(
    `Built signed ${manifest.pluginId} ${exactSha256} (${signed.wasmBytes.byteLength} bytes)\n`,
  );
  return { exactSha256, artifactPath };
}
