import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { signModuleArtifact } from "space-data-module-sdk";

import { resolveSupplementalSigning } from "../signing.mjs";
import { compileUniversalAot } from "../universal-aot.mjs";

const timerRoot = path.dirname(fileURLToPath(import.meta.url));
const standardsRoot = path.resolve(timerRoot, "../../../../../spacedatastandards.org");
const flatcPath = path.resolve(timerRoot, "../../../../../flatbuffers/build/flatc");
const buildRoot = path.join(timerRoot, ".build");
const unsignedRoot = path.join(timerRoot, "dist/.unsigned");
const distRoot = path.join(timerRoot, "dist/isomorphic");
const manifestPath = path.join(timerRoot, "plugin-manifest.json");
const sourcePath = path.join(timerRoot, "src/timer_node.cpp");
const developmentSigningSeed = "43".repeat(32);
const { signingSeed, signingKeyId, developmentOnly, productionMode } =
  resolveSupplementalSigning({
    environment: process.env,
    environmentPrefix: "SUPPLEMENTAL_TIMER",
    developmentSigningSeed,
    defaultSigningKeyId: "supplemental-omm-timer-development",
  });

async function loadBoundaryCatalog() {
  return Promise.all(
    ["FSO", "FSB"].map(async (schemaCode) => {
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
    }),
  );
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: timerRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

await rm(buildRoot, { recursive: true, force: true });
await rm(unsignedRoot, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });
await mkdir(unsignedRoot, { recursive: true });
await mkdir(distRoot, { recursive: true });

await run(flatcPath, [
  "--no-warnings",
  "--cpp",
  "--aligned",
  "-o",
  buildRoot,
  path.join(standardsRoot, "schema/FSB/main.fbs"),
]);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const catalog = await loadBoundaryCatalog();
const sourceCode = (
  await Promise.all([
    readFile(path.join(standardsRoot, "lib/cpp/FSB/main_generated.h"), "utf8"),
    readFile(path.join(buildRoot, "main_aligned.h"), "utf8"),
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
  // DECLARE the thread model; never let it be inferred. runtimeTargets
  // ["browser","wasmedge"] makes the SDK infer wasi-threads, and this guest
  // provably never spawns one, so the inferred build fails the isomorphic
  // artifact guard. manifest.sequentialJustification carries the reason.
  threadModel: "wasi-sequential",
});
if (!compilation.report?.ok) {
  throw new Error(
    `compiled timer failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`,
  );
}

const executableBytes = await compileUniversalAot({
  wasmBytes: compilation.wasmBytes,
  stagingDirectory: unsignedRoot,
  mode: "child",
  productionMode: productionMode || !developmentOnly,
});
const signed = await signModuleArtifact(executableBytes, {
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
  path.join(timerRoot, "publisher.json"),
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
  `Built signed Supplemental OMM timer ${exactSha256} (${signed.wasmBytes.byteLength} bytes)\n`,
);
