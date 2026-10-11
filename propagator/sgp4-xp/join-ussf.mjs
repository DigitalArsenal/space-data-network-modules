// Joins the US Space Force Sgp4Prop build to a WebAssembly module that calls it, with binaryen's wasm-merge.
//
//   adapter  a linked module whose code imports the Space Force functions from the module "ussf" and the copies between
//            memories from the module "a" (src/ussf.hpp declares them), and which exports its memory as "memory"
//   ussf     third_party/ussf-sgp4/Sgp4Prop.xp.wasm, as released; it keeps its own linear memory
//   a        src/shim.wat, the library's nine Emscripten imports answered in WebAssembly, and the copies
//
// The merge resolves every import between the three. What is left imports only what the adapter imported from the
// host (WASI and, for a threaded adapter, its memory and the thread-spawn call), has the adapter's memory as memory 0
// and the library's as memory 1, and exports whatever `keepExports` names. This module is used by this module's own
// build (build.mjs) and by the signed OD node of flows/supplemental-omm.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { exportNames, filterExports } from "./wasm-sections.mjs";

const run = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const ussfDir = path.join(root, "third_party/ussf-sgp4");

// The library this program is written around. Its exports have minified names that src/ussf.hpp lists; a different
// build has different names, so the join refuses one.
export const USSF_SHA256 = "9f061110f12ac85a76ad80dc76cdb8a33ddad64e54d8dab3b6778602e16cbeb7";
const USSF_EXPORTS = { memory: "j", start: "k", malloc: "s", free: "q", tleAdd: "t", sgp4Init: "u", sgp4Remove: "v", propagate: "A", tleRemove: "E", logLevel: "F" };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function tool(command) {
  const { stdout, stderr } = await run(command, ["--version"]);
  return `${stdout}${stderr}`.trim().split("\n")[0];
}

/** The library's bytes, checked against the build this program is written for. */
export async function readUssf() {
  const ussf = await fs.readFile(path.join(ussfDir, "Sgp4Prop.xp.wasm"));
  if (sha256(ussf) !== USSF_SHA256) {
    throw new Error(`third_party/ussf-sgp4/Sgp4Prop.xp.wasm is ${sha256(ussf)}, not the build this program is written for (${USSF_SHA256}).`);
  }
  const exported = new Set(exportNames(ussf).map((e) => e.name));
  for (const [what, name] of Object.entries(USSF_EXPORTS)) {
    if (!exported.has(name)) throw new Error(`The Space Force build exports no "${name}" (${what}).`);
  }
  return ussf;
}

/** The notice the Space Force Agreement asks a binary redistribution to carry: copyright notice, disclaimer pointer, Agreement. */
export async function ussfNotice() {
  const agreement = await fs.readFile(path.join(ussfDir, "AGREEMENT.txt"), "utf8");
  return [
    "Copyright 2015 United States Government as represented by the Administrator of US Space Force. All Rights Reserved.",
    "",
    "This module contains the US Space Force SGP4 (Sgp4Prop WebAssembly v9.1.1.0, XP build), joined to SDN code by",
    `wasm-merge, which re-encodes its functions and leaves their behaviour as released. Library SHA-256 ${USSF_SHA256}.`,
    "The US Space Force does not endorse this module or anything derived from it.",
    "Export of any goods or technical data from the United States may require an export license from the U.S. Government.",
    "The Agreement it is distributed under follows.",
    "",
    agreement,
  ].join("\n");
}

/**
 * Merges `adapterPath` (a linked module exporting its memory as "memory") with the library and the shim in `workDir`.
 * Returns { bytes, ussf, shimSha256, toolchain }; `bytes` exports only `keepExports` (a Set of names), and the library's
 * minified exports and the shim's are gone.
 */
export async function joinUssf({ adapterPath, workDir, keepExports }) {
  const ussf = await readUssf();
  const toolchain = { wasmMerge: await tool("wasm-merge"), wat2wasm: await tool("wat2wasm") };
  const shimSource = path.join(root, "src/shim.wat");
  const shimPath = path.join(workDir, "shim.wasm");
  await run("wat2wasm", ["--enable-multi-memory", "--enable-threads", shimSource, "-o", shimPath]);
  const ussfPath = path.join(workDir, "ussf.wasm");
  await fs.writeFile(ussfPath, ussf);
  const mergedPath = path.join(workDir, "merged.wasm");
  await run("wasm-merge", ["-all", adapterPath, "adapter", ussfPath, "ussf", shimPath, "a", "-o", mergedPath], { maxBuffer: 64 * 1024 * 1024 });
  const bytes = filterExports(new Uint8Array(await fs.readFile(mergedPath)), keepExports);
  return { bytes, ussf, shimSha256: sha256(await fs.readFile(shimSource)), toolchain };
}
