import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE_REVISION = "551f6e178c3332cad46171fd1a0002345271144c";
const TOOLCHAIN_IMAGE_ID =
  "sha256:6ff1234684d0353e914106f698216a16646c64c208f46b3021676b76435cdc50";
const TOOLCHAIN_LINUX_AMD64_MANIFEST =
  "ghcr.io/webassembly/wasi-sdk@sha256:59df2a99139fad8ce3814d725c85a7a1b444ea97519186c4aa0be87cda8e6b1d";
const FLATBUFFERS_REVISION = "5ab8e415ad13f1e9a75c1cdb1e990f37b1c79d75";
const EIGEN_VERSION = "5.0.1";
const EIGEN_ARCHIVE_URL =
  "https://gitlab.com/libeigen/eigen/-/archive/5.0.1/eigen-5.0.1.tar.gz";
const EIGEN_ARCHIVE_SHA256 =
  "e9c326dc8c05cd1e044c71f30f1b2e34a6161a3b6ecf445d56b53ff1669e3dec";
const EXPECTED_EIGEN_TREE_SHA256 =
  "b04f3dad6c88b1a90e7276c115eaabf3ba7b6c94059269209d0120a83b5989a2";
const EXPECTED_EIGEN_FILE_COUNT = 600;
const EXPECTED_EIGEN_BYTE_LENGTH = 9_947_142;
const EXPECTED_OBJECT_SHA256 =
  "e1f1baa093cb52ef6fc880e4aa4de958c2bb074b8dac4d7826c50fa540e94ea8";
const EXPECTED_HEADER_SHA256 =
  "0cc0ffaad93fa089e274e3d24d6db1aa66c01c801a73392805d8b4d15955817a";
const EXPECTED_PATCH_SHA256 =
  "c9e6042809c4ec8ce38a878fb0fd6bd1969e2f9bd4f307c924e571a090b17882";

const TRANSLATION_UNITS = [
  "src/sgp4_fitter.cpp",
  "src/meme_parser.cpp",
  "src/frame_transform.cpp",
  "src/oem_parser.cpp",
  "src/oem_fb_reader.cpp",
  "src/omm_fb_builder.cpp",
  "src/ocm_fb_builder.cpp",
  "src/plugin_runtime.cpp",
  "deps/vallado-sgp4/SGP4.cpp",
  "src/od_batch_fit.cpp",
  "src/noexcept_stubs.cpp",
];

const COMPILE_FLAGS = [
  "--target=wasm32-wasip1-threads",
  "-std=c++17",
  "-O3",
  "-matomics",
  "-mbulk-memory",
  "-fignore-exceptions",
  "-pthread",
  "-DNDEBUG",
  "-DEIGEN_DONT_PARALLELIZE",
  "-ffast-math",
];

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(scriptRoot);
const modulesRoot = path.resolve(packageRoot, "../..");
const mainPackagesRoot = path.dirname(modulesRoot);
const flatbuffersRoot = path.join(mainPackagesRoot, "flatbuffers");
const nodeRoot = path.join(packageRoot, "nodes/od");
const sourcePatch = path.join(nodeRoot, "vendor/od-fit-core-source.patch");
const vendoredObject = path.join(nodeRoot, "vendor/od-fit-core.o");
const vendoredHeader = path.join(nodeRoot, "vendor/od_batch_fit.hpp");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function treeFingerprint(root) {
  const files = [];
  function visit(directory, relativeDirectory = "") {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      );
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (stats.isFile()) {
        files.push(relativePath);
      }
    }
  }
  visit(root);

  const digest = createHash("sha256");
  let byteLength = 0;
  for (const relativePath of files) {
    const bytes = readFileSync(path.join(root, relativePath));
    digest.update(relativePath);
    digest.update("\0");
    digest.update(String(bytes.length));
    digest.update("\0");
    digest.update(bytes);
    byteLength += bytes.length;
  }
  return {
    fileCount: files.length,
    byteLength,
    sha256: digest.digest("hex"),
  };
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout?.length > 0) {
    process.stderr.write(result.stdout);
  }
  if (result.status !== 0 || result.error) {
    const detail =
      result.error?.message ??
      result.stderr?.toString() ??
      `${command} exited with status ${result.status}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  if (result.stderr?.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result;
}

function requireFile(filePath, description) {
  if (!existsSync(filePath)) {
    throw new Error(`missing ${description}: ${filePath}`);
  }
}

requireFile(sourcePatch, "OD fit-core source patch");
requireFile(vendoredObject, "vendored OD fit-core object");
requireFile(vendoredHeader, "vendored OD fit-core ABI header");

const patchBytes = readFileSync(sourcePatch);
const actualPatchSha256 = sha256(patchBytes);
if (actualPatchSha256 !== EXPECTED_PATCH_SHA256) {
  throw new Error(
    `OD fit-core source patch hash ${actualPatchSha256} does not match ${EXPECTED_PATCH_SHA256}`,
  );
}

const temporaryRoot = mkdtempSync(
  path.join(os.tmpdir(), "supplemental-od-core-reproduction-"),
);
const archivePath = path.join(temporaryRoot, "base.tar");
const flatbuffersArchivePath = path.join(temporaryRoot, "flatbuffers.tar");
const sourceRoot = path.join(temporaryRoot, "source");
const flatbuffersSourceRoot = path.join(temporaryRoot, "flatbuffers-source");
const buildRoot = path.join(temporaryRoot, "build");
const eigenRoot = path.join(buildRoot, "eigen3");

try {
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(flatbuffersSourceRoot, { recursive: true });
  mkdirSync(buildRoot, { recursive: true });
  runChecked(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      BASE_REVISION,
      "analysis/od",
      "common",
      "licensing/core/src/cpp/generated/sds",
    ],
    { cwd: modulesRoot },
  );
  runChecked("tar", ["-xf", archivePath, "-C", sourceRoot]);
  runChecked(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${flatbuffersArchivePath}`,
      FLATBUFFERS_REVISION,
      "include/flatbuffers",
    ],
    { cwd: flatbuffersRoot },
  );
  runChecked(
    "tar",
    ["-xf", flatbuffersArchivePath, "-C", flatbuffersSourceRoot],
  );
  runChecked(
    "git",
    [
      "apply",
      "--check",
      "--unsafe-paths",
      "--whitespace=error-all",
      sourcePatch,
    ],
    { cwd: sourceRoot },
  );
  runChecked(
    "git",
    [
      "apply",
      "--unsafe-paths",
      "--whitespace=error-all",
      sourcePatch,
    ],
    { cwd: sourceRoot },
  );
  runChecked(
    "git",
    ["apply", "--check", "--reverse", "--unsafe-paths", sourcePatch],
    { cwd: sourceRoot },
  );

  const reconstructedHeaderBytes = readFileSync(
    path.join(sourceRoot, "analysis/od/src/cpp/src/od_batch_fit.hpp"),
  );
  const vendoredHeaderBytes = readFileSync(vendoredHeader);
  const headerSha256 = sha256(reconstructedHeaderBytes);
  if (headerSha256 !== EXPECTED_HEADER_SHA256) {
    throw new Error(
      `reconstructed OD fit-core ABI header hash ${headerSha256} ` +
        `does not match ${EXPECTED_HEADER_SHA256}`,
    );
  }
  const headerMatchesReconstructedBytes =
    reconstructedHeaderBytes.length === vendoredHeaderBytes.length &&
    timingSafeEqual(reconstructedHeaderBytes, vendoredHeaderBytes);
  if (!headerMatchesReconstructedBytes) {
    throw new Error(
      "vendored OD fit-core ABI header is not byte-identical to reconstructed source",
    );
  }

  const eigenSource = path.resolve(
    process.env.SDN_OD_EIGEN_DIR ?? "/opt/homebrew/include/eigen3",
  );
  requireFile(path.join(eigenSource, "Eigen/Dense"), "Eigen headers");
  const eigenFingerprint = treeFingerprint(eigenSource);
  if (
    eigenFingerprint.sha256 !== EXPECTED_EIGEN_TREE_SHA256 ||
    eigenFingerprint.fileCount !== EXPECTED_EIGEN_FILE_COUNT ||
    eigenFingerprint.byteLength !== EXPECTED_EIGEN_BYTE_LENGTH
  ) {
    throw new Error(
      `Eigen ${EIGEN_VERSION} tree fingerprint ${JSON.stringify(eigenFingerprint)} ` +
        `does not match ${EXPECTED_EIGEN_TREE_SHA256}/${EXPECTED_EIGEN_FILE_COUNT}/` +
        `${EXPECTED_EIGEN_BYTE_LENGTH}`,
    );
  }
  runChecked("cp", ["-RL", `${eigenSource}/.`, eigenRoot]);

  const includeFlags = [
    "-I/src/analysis/od/src/cpp/include",
    "-I/src/analysis/od/src/cpp/src",
    "-I/src/analysis/od/src/cpp/deps/vallado-sgp4",
    "-I/src/common",
    "-I/work/eigen3",
    "-I/flatbuffers/include",
    "-I/src/licensing/core/src/cpp/generated/sds",
  ];
  const objectPaths = TRANSLATION_UNITS.map((translationUnit) => {
    const objectName = `${path.posix.basename(translationUnit, ".cpp")}.o`;
    return `/work/objects/${objectName}`;
  });
  const compileCommands = TRANSLATION_UNITS.map(
    (translationUnit, index) =>
      [
        "/opt/wasi-sdk/bin/clang++",
        ...COMPILE_FLAGS,
        ...includeFlags,
        "-c",
        `/src/analysis/od/src/cpp/${translationUnit}`,
        "-o",
        objectPaths[index],
      ].join(" "),
  );
  const containerScript = [
    "set -euo pipefail",
    "mkdir -p /work/objects",
    ...compileCommands,
    [
      "/opt/wasi-sdk/bin/wasm-ld",
      "-r",
      ...objectPaths,
      "-o",
      "/work/od-fit-core.o",
    ].join(" "),
  ].join("\n");

  runChecked("docker", [
    "run",
    "--rm",
    "--platform=linux/amd64",
    "--network=none",
    "--pull=never",
    "--volume",
    `${sourceRoot}:/src:ro`,
    "--volume",
    `${buildRoot}:/work`,
    "--volume",
    `${flatbuffersSourceRoot}:/flatbuffers:ro`,
    TOOLCHAIN_IMAGE_ID,
    "bash",
    "-lc",
    containerScript,
  ]);

  const rebuiltBytes = readFileSync(path.join(buildRoot, "od-fit-core.o"));
  const vendoredBytes = readFileSync(vendoredObject);
  const rebuiltSha256 = sha256(rebuiltBytes);
  if (rebuiltSha256 !== EXPECTED_OBJECT_SHA256) {
    throw new Error(
      `rebuilt OD fit-core hash ${rebuiltSha256} does not match ${EXPECTED_OBJECT_SHA256}`,
    );
  }
  const objectMatchesVendoredBytes =
    rebuiltBytes.length === vendoredBytes.length &&
    timingSafeEqual(rebuiltBytes, vendoredBytes);
  if (!objectMatchesVendoredBytes) {
    throw new Error("rebuilt OD fit-core is not byte-identical to the vendored object");
  }

  process.stdout.write(
    `${JSON.stringify({
      baseRevision: BASE_REVISION,
      toolchainImageId: TOOLCHAIN_IMAGE_ID,
      toolchainLinuxAmd64Manifest: TOOLCHAIN_LINUX_AMD64_MANIFEST,
      flatbuffersRevision: FLATBUFFERS_REVISION,
      eigenVersion: EIGEN_VERSION,
      eigenArchiveUrl: EIGEN_ARCHIVE_URL,
      eigenArchiveSha256: EIGEN_ARCHIVE_SHA256,
      eigenTreeSha256: eigenFingerprint.sha256,
      reconstructedSourceMatchesPatch: true,
      headerMatchesReconstructedBytes,
      headerSha256,
      objectMatchesVendoredBytes,
      objectSha256: rebuiltSha256,
      translationUnits: TRANSLATION_UNITS.length,
    })}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
