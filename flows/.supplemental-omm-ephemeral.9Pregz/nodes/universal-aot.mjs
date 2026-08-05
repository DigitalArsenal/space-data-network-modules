import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listWasmCustomSections } from "space-data-module-sdk";

const nodesRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(nodesRoot);
const compilerScript = path.join(packageRoot, "scripts/compile-universal-aot.sh");

async function runCompiler(args) {
  await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [compilerScript, ...args], {
      cwd: packageRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `universal-AOT compiler exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
          ),
        );
      }
    });
  });
}

export async function compileUniversalAot({
  wasmBytes,
  stagingDirectory,
  mode,
  productionMode,
}) {
  if (!(wasmBytes instanceof Uint8Array) || wasmBytes.byteLength === 0) {
    throw new Error("universal-AOT input must be non-empty WASM bytes");
  }
  if (!WebAssembly.validate(wasmBytes)) {
    throw new Error("universal-AOT input is not browser-valid WASM");
  }
  if (mode !== "parent" && mode !== "child") {
    throw new Error(`unknown universal-AOT profile ${JSON.stringify(mode)}`);
  }
  if (typeof productionMode !== "boolean") {
    throw new Error("universal-AOT productionMode must be an explicit boolean");
  }
  if (!productionMode) return wasmBytes;
  if (typeof stagingDirectory !== "string" || stagingDirectory.length === 0) {
    throw new Error("production universal-AOT staging directory is required");
  }

  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  const inputPath = path.join(stagingDirectory, `${mode}-portable.wasm`);
  const outputPath = path.join(stagingDirectory, `${mode}-universal.wasm`);
  await writeFile(inputPath, wasmBytes, { mode: 0o600 });
  await runCompiler([mode, inputPath, outputPath]);
  const compiled = new Uint8Array(await readFile(outputPath));
  if (!WebAssembly.validate(compiled)) {
    throw new Error("WasmEdge universal-AOT output is not browser-valid WASM");
  }
  const unchanged = compiled.byteLength === wasmBytes.byteLength &&
    compiled.every((byte, index) => byte === wasmBytes[index]);
  if (unchanged) {
    throw new Error("WasmEdge universal-AOT compiler returned unchanged portable WASM");
  }
  const aotSections = listWasmCustomSections(compiled).filter(
    (section) => section.name === "wasmedge",
  );
  if (aotSections.length !== 1 || aotSections[0].dataBytes.byteLength === 0) {
    throw new Error(
      "WasmEdge universal-AOT output must contain exactly one non-empty wasmedge section",
    );
  }
  return compiled;
}
