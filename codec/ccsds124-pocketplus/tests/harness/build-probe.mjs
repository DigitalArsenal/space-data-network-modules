/*
 * Compile the codec parity probe with the SDK's ENFORCED wasi-threads toolchain
 * and the SDK's exact pthreads final-link flag set.
 *
 * The flags are imported from the SDK (PTHREAD_FINAL_LINK_FLAGS,
 * resolveWasiThreadsToolchain) rather than copied, so the probe cannot silently
 * drift from the contract the real module is built under. If the SDK's flag set
 * changes, this probe changes with it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PTHREAD_FINAL_LINK_FLAGS,
  resolveWasiThreadsToolchain,
} from "space-data-module-sdk/compiler";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const vendorRoot = path.join(packageRoot, "vendor", "ccsds124");
const outDir = path.join(here, "build");
const outWasm = path.join(outDir, "codec-probe.wasm");

// 4 MiB: ~6.5x the measured 631 KB worst-case call chain. See the link step.
export const STACK_SIZE_BYTES = 4 * 1024 * 1024;

const EXPORTS = [
  "p124_reset",
  "p124_alloc",
  "p124_arena_capacity",
  "p124_compress",
  "p124_decompress",
  "p124_discover",
];

const VENDOR_SOURCES = [
  "src/bitvector.c",
  "src/bitbuffer.c",
  "src/mask.c",
  "src/encode.c",
  "src/compress.c",
  "src/decompress.c",
];

export async function buildProbe({ quiet = true } = {}) {
  const toolchain = resolveWasiThreadsToolchain();
  await fs.mkdir(outDir, { recursive: true });

  const objects = [];
  const sources = [
    ...VENDOR_SOURCES.map((relative) => ({
      file: path.join(vendorRoot, relative),
      name: path.basename(relative, ".c"),
    })),
    { file: path.join(here, "codec_abi.c"), name: "codec_abi" },
  ];

  for (const { file, name } of sources) {
    const object = path.join(outDir, `${name}.o`);
    execFileSync(
      toolchain.clang,
      [
        ...toolchain.toolchainArgs,
        "-c",
        file,
        `-I${path.join(vendorRoot, "include")}`,
        "-std=c99",
        // Mirrors the SDK's buildSourceCompilerArgs for the pthreads model.
        "-O3",
        "-mbulk-memory",
        "-DNDEBUG",
        "-matomics",
        "-pthread",
        "-o",
        object,
      ],
      { stdio: quiet ? "pipe" : "inherit" },
    );
    objects.push(object);
  }

  execFileSync(
    toolchain.clang,
    [
      ...toolchain.toolchainArgs,
      ...objects,
      "-mexec-model=reactor",
      ...PTHREAD_FINAL_LINK_FLAGS,
      // MEASURED REQUIREMENT, not a guess. The vendored reference library uses
      // large caller-allocated stack arrays sized by CCSDS124_MAX_PACKET_LENGTH:
      // worst-case decode chain is ccsds124_decompress -> _packet_internal
      // (335,888 B) -> ccsds124_bit_insert (262,144 B) ~= 631 KB on wasm32, and
      // ccsds124_compress alone is 204,832 B. wasm-ld's default 64 KB stack
      // traps with "memory access out of bounds" on the very first vector.
      // This MUST be explicit rather than defaulted: the stack size is a
      // link-time constant baked into the single artifact, so pinning it here
      // is what makes the trap boundary identical in every runtime.
      `-Wl,-z,stack-size=${STACK_SIZE_BYTES}`,
      ...EXPORTS.map((symbol) => `-Wl,--export=${symbol}`),
      "-o",
      outWasm,
    ],
    { stdio: quiet ? "pipe" : "inherit" },
  );

  return outWasm;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const wasm = await buildProbe({ quiet: false });
  const { size } = await fs.stat(wasm);
  console.log(`built ${path.relative(packageRoot, wasm)} (${size} bytes)`);
}
