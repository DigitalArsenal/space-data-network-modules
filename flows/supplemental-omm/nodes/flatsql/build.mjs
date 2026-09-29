import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compileUniversalAot } from "../universal-aot.mjs";
import {
  describeEmsdkRoot,
  loadEmsdkPin,
  recordLaneToolchain,
} from "../../../../scripts/lib/emsdk-toolchain.mjs";
import {
  assertArtifactThreadModel,
} from "../../../../scripts/lib/thread-model.mjs";

// THREAD MODEL — declared, never inferred (full rationale in
// scripts/lib/thread-model.mjs; graph task modules-undeclared-threadmodel-artifacts).
//
// This node compiles through CMake + a vendored Emscripten, not through
// `compileModuleFromSource`, so the SDK's `resolveThreadModel` never runs and
// there is no compiler argument to carry a declaration. It read as "undeclared"
// in the artifact-reproducibility census with no way to answer.
//
// Truth of the SHIPPED artifact d0a2ca25c083… (14,560,816 B): unshared linear
// memory, no `wasi.thread-spawn` import, no `wasi_thread_start` export. The
// FlatSQL engine runs its btree on the calling thread; it spawns nothing.
const THREAD_MODEL = "single-thread";

const nodeDirectory = path.dirname(fileURLToPath(import.meta.url));
const modulesDirectory = path.resolve(nodeDirectory, "../../../..");
const mainPackagesDirectory = path.resolve(modulesDirectory, "..");
const flatsqlDirectory = path.join(mainPackagesDirectory, "flatsql");
// The installed, published SDK (published-deps law), never a sibling checkout.
// It exports no "./package.json", so its root is found by walking up from the
// resolved package entry to the manifest that names it.
function installedSdkDirectory() {
  let directory = path.dirname(
    createRequire(import.meta.url).resolve("space-data-module-sdk"),
  );
  for (;;) {
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(directory, "package.json"), "utf8"),
      );
      if (manifest.name === "space-data-module-sdk") return directory;
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("space-data-module-sdk is not installed for this node");
    }
    directory = parent;
  }
}
const sdkDirectory = process.env.SPACE_DATA_MODULE_SDK_ROOT
  ? path.resolve(process.env.SPACE_DATA_MODULE_SDK_ROOT)
  : installedSdkDirectory();
const standardsDirectory = path.join(
  mainPackagesDirectory,
  "spacedatastandards.org",
);
const flatbuffersDirectory = path.join(mainPackagesDirectory, "flatbuffers");
const flatcPath = path.join(flatbuffersDirectory, "build/flatc");
const buildDirectory = path.join(nodeDirectory, ".build");
const upstreamCppDirectory = path.join(flatsqlDirectory, "cpp");
const cppDirectory = path.join(buildDirectory, "cpp");
const generatedDirectory = path.join(buildDirectory, "generated");
const cmakeBuildDirectory = path.join(buildDirectory, "cmake");
const distDirectory = path.join(nodeDirectory, "dist/isomorphic");
const manifestPath = path.join(nodeDirectory, "plugin-manifest.json");
const defaultEmsdkDirectory = path.join(
  modulesDirectory,
  "analysis/od/deps/emsdk",
);

const developmentSigningSeed = "41".repeat(32);
const buildMode = process.env.FLATSQL_NODE_BUILD_MODE;

function signingConfiguration() {
  if (buildMode !== "development" && buildMode !== "production") {
    throw new Error(
      "FLATSQL_NODE_BUILD_MODE must explicitly be development or production",
    );
  }
  if (buildMode === "development") {
    return {
      signingSeed: developmentSigningSeed,
      signingKeyId: "flatsql-node-development",
      developmentOnly: true,
    };
  }
  const signingSeed = process.env.FLATSQL_NODE_SIGNING_SEED_HEX;
  const signingKeyId = process.env.FLATSQL_NODE_SIGNING_KEY_ID;
  if (!signingSeed || !signingKeyId) {
    throw new Error(
      "production build requires FLATSQL_NODE_SIGNING_SEED_HEX and FLATSQL_NODE_SIGNING_KEY_ID",
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(signingSeed)) {
    throw new Error("FLATSQL_NODE_SIGNING_SEED_HEX must be exactly 32 bytes");
  }
  if (
    signingSeed.toLowerCase() === developmentSigningSeed ||
    signingKeyId === "flatsql-node-development"
  ) {
    throw new Error("production build refuses the embedded development signer");
  }
  return {
    signingSeed: signingSeed.toLowerCase(),
    signingKeyId,
    developmentOnly: false,
  };
}

function sdkUrl(relativePath) {
  return pathToFileURL(path.join(sdkDirectory, relativePath)).href;
}

async function resolveLocalEmsdk() {
  const configured = process.env.SDN_LOCAL_EMSDK_DIR;
  const configuredDirectory = path.resolve(configured || defaultEmsdkDirectory);
  let emsdkDirectory;
  let canonicalModulesDirectory;
  try {
    [emsdkDirectory, canonicalModulesDirectory] = await Promise.all([
      realpath(configuredDirectory),
      realpath(modulesDirectory),
    ]);
  } catch {
    throw new Error(
      `repo-local Emscripten is unavailable at ${configuredDirectory}; ` +
        "set SDN_LOCAL_EMSDK_DIR to a populated in-repository deps/emsdk checkout",
    );
  }
  const relative = path.relative(canonicalModulesDirectory, emsdkDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `SDN_LOCAL_EMSDK_DIR must resolve inside ${canonicalModulesDirectory}`,
    );
  }
  const configuredEmscriptenDirectory = path.join(
    emsdkDirectory,
    "upstream/emscripten",
  );
  const configuredEmcmake = path.join(
    configuredEmscriptenDirectory,
    "emcmake",
  );
  const configuredEmxx = path.join(configuredEmscriptenDirectory, "em++");
  const configuredEmConfig = path.join(emsdkDirectory, ".emscripten");
  let emcmake;
  let emxx;
  let emConfig;
  try {
    await Promise.all([
      access(configuredEmcmake),
      access(configuredEmxx),
      access(configuredEmConfig),
    ]);
    [emcmake, emxx, emConfig] = await Promise.all([
      realpath(configuredEmcmake),
      realpath(configuredEmxx),
      realpath(configuredEmConfig),
    ]);
  } catch {
    throw new Error(
      `repo-local Emscripten is unavailable at ${emsdkDirectory}; ` +
        "set SDN_LOCAL_EMSDK_DIR to a populated in-repository deps/emsdk checkout",
    );
  }
  for (const resolvedPath of [emcmake, emxx, emConfig]) {
    const toolRelative = path.relative(canonicalModulesDirectory, resolvedPath);
    if (toolRelative.startsWith("..") || path.isAbsolute(toolRelative)) {
      throw new Error(
        `SDN_LOCAL_EMSDK_DIR must resolve inside ${canonicalModulesDirectory}`,
      );
    }
  }
  const emscriptenDirectory = path.dirname(emcmake);

  // VERIFY THE PIN. This node already refused to CLONE a missing emsdk — it was
  // the only member of the raw-em++ lane that did — but it accepted whatever
  // version happened to be in the directory it found. That is the half of the
  // defect that never showed: analysis/od/deps/emsdk carries emscripten 5.0.5,
  // while the lane pin (and every other build.mjs in the lane) says 6.0.1, so the
  // committed artifact was compiled by a toolchain no file named.
  // Graph task: modules-raw-emcc-lane-unpinned-toolchain.
  const pin = loadEmsdkPin();
  const eraId = process.env.SDN_EMSDK_ERA || null;
  const expected = eraId ? pin.knownToolchains?.[eraId] : pin.pin;
  if (!expected) {
    throw new Error(
      `SDN_EMSDK_ERA=${eraId} is not a toolchain this repo knows; ` +
        `valid ids: ${Object.keys(pin.knownToolchains ?? {}).join(", ")}`,
    );
  }
  const identity = describeEmsdkRoot(emsdkDirectory);
  if (identity.emscriptenVersion !== expected.emscriptenVersion) {
    throw new Error(
      `WRONG EMSCRIPTEN at ${emsdkDirectory}: found ${identity.emscriptenVersion ?? "?"}, ` +
        `pin ${eraId ?? pin.pin.id} requires ${expected.emscriptenVersion}. ` +
        `Provision it with \`node scripts/provision-emsdk.mjs\` and point SDN_LOCAL_EMSDK_DIR at it, ` +
        `or name an era toolchain with SDN_EMSDK_ERA to rebuild historical bytes deliberately.`,
    );
  }

  return {
    emcmake,
    laneToolchain: { pinId: eraId ?? pin.pin.id, era: Boolean(eraId), identity },
    environment: {
      EMSDK: emsdkDirectory,
      EM_CONFIG: emConfig,
      PATH: `${emscriptenDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? flatsqlDirectory,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
        ),
      );
    });
  });
}

function rewriteHeaderGuard(source, schemaCode) {
  return source.replaceAll(
    "FLATBUFFERS_GENERATED_MAIN_H_",
    `FLATBUFFERS_GENERATED_SDS_${schemaCode}_MAIN_H_`,
  );
}

function guardAlignedRuntime(source) {
  const startToken = "namespace flatbuffers {\nnamespace aligned_runtime {";
  const endToken = "}  // namespace aligned_runtime\n}  // namespace flatbuffers";
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start);
  if (start < 0 || end < 0) {
    throw new Error("generated aligned header is missing the shared runtime block");
  }
  const blockEnd = end + endToken.length;
  return `${source.slice(0, start)}#ifndef FLATSQL_SDS_ALIGNED_RUNTIME_DEFINED\n#define FLATSQL_SDS_ALIGNED_RUNTIME_DEFINED\n${source.slice(start, blockEnd)}\n#endif\n${source.slice(blockEnd)}`;
}

async function generateBoundaryHeaders(schemaCode) {
  const outputDirectory = path.join(generatedDirectory, `sds/${schemaCode}`);
  const schemaPath = path.join(
    standardsDirectory,
    `schema/${schemaCode}/main.fbs`,
  );
  await mkdir(outputDirectory, { recursive: true });
  await run(flatcPath, [
    "--no-warnings",
    "--cpp",
    "--gen-object-api",
    "-o",
    outputDirectory,
    schemaPath,
  ]);
  const generatedPath = path.join(outputDirectory, "main_generated.h");
  await writeFile(
    generatedPath,
    rewriteHeaderGuard(await readFile(generatedPath, "utf8"), schemaCode),
  );
  await run(flatcPath, [
    "--no-warnings",
    "--cpp",
    "--aligned",
    "-o",
    outputDirectory,
    schemaPath,
  ]);
  const alignedPath = path.join(outputDirectory, "main_aligned.h");
  await writeFile(
    alignedPath,
    guardAlignedRuntime(await readFile(alignedPath, "utf8")),
  );
}

async function main() {
  const { signingSeed, signingKeyId, developmentOnly } =
    signingConfiguration();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const toolchain = await resolveLocalEmsdk();
  const [{ generateEmbeddedManifestSource }, invokeGlue, flatcSupport, bundle] =
    await Promise.all([
      import(sdkUrl("src/embeddedManifest.js")),
      import(sdkUrl("src/compiler/invokeGlue.js")),
      import(sdkUrl("src/compiler/flatcSupport.js")),
      import(sdkUrl("src/bundle/index.js")),
    ]);
  const { encodePluginManifest } = await import(
    sdkUrl("src/manifest/index.js")
  );

  await rm(buildDirectory, { recursive: true, force: true });
  await cp(upstreamCppDirectory, cppDirectory, {
    recursive: true,
    filter(source) {
      const relative = path.relative(upstreamCppDirectory, source);
      return !relative.split(path.sep).some(
        (part) => part === "build" || part.startsWith("build-"),
      );
    },
  });
  await cp(
    path.join(flatsqlDirectory, "sdm"),
    path.join(buildDirectory, "sdm"),
    { recursive: true },
  );
  await writeFile(
    path.join(cppDirectory, "src/sdn_node.cpp"),
    await readFile(path.join(nodeDirectory, "src/sdn_node.cpp")),
  );
  const cmakePath = path.join(cppDirectory, "CMakeLists.txt");
  const cmakeSource = await readFile(cmakePath, "utf8");
  const upstreamFlatbuffersReference =
    "${CMAKE_CURRENT_SOURCE_DIR}/../../flatbuffers";
  if (!cmakeSource.includes(upstreamFlatbuffersReference)) {
    throw new Error("FlatSQL CMake overlay lost its canonical FlatBuffers anchor");
  }
  await writeFile(
    cmakePath,
    cmakeSource.replaceAll(
      upstreamFlatbuffersReference,
      flatbuffersDirectory,
    ),
  );
  await mkdir(generatedDirectory, { recursive: true });
  await mkdir(distDirectory, { recursive: true });

  const invokeHeaders = await flatcSupport.getInvokeCppSchemaHeaders();
  for (const [relativePath, source] of Object.entries(invokeHeaders)) {
    const destination = path.join(generatedDirectory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source);
  }
  await writeFile(
    path.join(generatedDirectory, "space_data_module_invoke.h"),
    invokeGlue.generateInvokeSupportHeader(),
  );
  await writeFile(
    path.join(generatedDirectory, "invoke_support.cpp"),
    invokeGlue.generateInvokeSupportSource({
      manifest,
      includeCommandMain: false,
    }),
  );
  await writeFile(
    path.join(generatedDirectory, "plugin_manifest_exports.c"),
    generateEmbeddedManifestSource({ manifest, format: "plg" }),
  );
  await writeFile(
    path.join(generatedDirectory, "private_capi_exports.h"),
    [
      "#include <emscripten.h>",
      "#undef EMSCRIPTEN_KEEPALIVE",
      "#define EMSCRIPTEN_KEEPALIVE",
      "",
    ].join("\n"),
  );
  await Promise.all([
    generateBoundaryHeaders("FSO"),
    generateBoundaryHeaders("FSB"),
  ]);

  await run(toolchain.emcmake, [
    "cmake",
    "-S",
    cppDirectory,
    "-B",
    cmakeBuildDirectory,
    `-DFLATSQL_SDN_NODE_GENERATED_DIR=${generatedDirectory}`,
    "-DCMAKE_BUILD_TYPE=Release",
  ], { env: toolchain.environment });
  await run("cmake", [
    "--build",
    cmakeBuildDirectory,
    "--target",
    "flatsql_sdn_node",
    "--parallel",
  ], { env: toolchain.environment });

  const rawWasmPath = path.join(
    cmakeBuildDirectory,
    "flatsql-sdn-node.wasm",
  );
  const rawWasm = new Uint8Array(await readFile(rawWasmPath));
  // Refuse a declaration the emitted bytes contradict. Checked on the RAW guest,
  // before the manifest section and the WasmEdge AOT wrapper are attached — the
  // threading contract is a property of the compile, not of the packaging.
  assertArtifactThreadModel(rawWasm, THREAD_MODEL, "flows/supplemental-omm/nodes/flatsql");
  // dist/build-toolchain.json, where check-artifact-reproducibility.mjs reads
  // every lane module's record (not dist/isomorphic/).
  recordLaneToolchain(path.dirname(distDirectory), toolchain.laneToolchain);
  const manifestBytes = encodePluginManifest(manifest);
  const withManifest = bundle.appendWasmCustomSection(
    rawWasm,
    bundle.SDS_MANIFEST_SECTION_NAME,
    manifestBytes,
  );
  const executableBytes = await compileUniversalAot({
    wasmBytes: withManifest,
    stagingDirectory: buildDirectory,
    mode: "child",
    productionMode: buildMode === "production",
  });
  const signed = await bundle.signModuleArtifact(executableBytes, {
    privateKeySeedHex: signingSeed,
    keyId: signingKeyId,
    signatureScope: "bundle",
  });

  const artifactPath = path.join(distDirectory, "module.wasm");
  await writeFile(artifactPath, signed.wasmBytes);
  const exactSha256 = createHash("sha256")
    .update(signed.wasmBytes)
    .digest("hex");
  await writeFile(
    path.join(distDirectory, "artifact.json"),
    `${JSON.stringify(
      {
        sha256: exactSha256,
        canonicalModuleHash: signed.canonicalModuleHashHex,
        signedHash: signed.signedHashHex,
        signatureScope: "bundle",
        keyId: signingKeyId,
        buildMode,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(nodeDirectory, "publisher.json"),
    `${JSON.stringify(
      {
        algorithm: "ed25519",
        keyId: signingKeyId,
        publicKeyHex: signed.signature.publicKeyHex,
        developmentOnly,
        buildMode,
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(
    `Built signed incremental FlatSQL node ${exactSha256} (${signed.wasmBytes.byteLength} bytes)\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
