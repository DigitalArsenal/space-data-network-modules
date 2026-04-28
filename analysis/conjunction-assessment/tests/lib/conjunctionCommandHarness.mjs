import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadModule } from "space-data-module-sdk/host/isomorphic";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const ISOMORPHIC_WASM_PATH = path.join(
  PACKAGE_ROOT,
  "dist",
  "isomorphic",
  "module.wasm",
);

export function conjunctionArtifactPath() {
  return ISOMORPHIC_WASM_PATH;
}

export function conjunctionArtifactExists() {
  return fs.existsSync(ISOMORPHIC_WASM_PATH);
}

export async function createConjunctionCommandHarness(options = {}) {
  return loadModule({
    wasmSource: options.wasmSource ?? ISOMORPHIC_WASM_PATH,
    runtimeKind: options.runtimeKind ?? "wasmedge",
    enableThreads: options.enableThreads ?? true,
    wasmEdgeBinary: options.wasmEdgeBinary,
    wasmEdgeRunnerBinary: options.wasmEdgeRunnerBinary,
    cwd: options.cwd ?? PACKAGE_ROOT,
    env: options.env,
  });
}

export async function invokeConjunctionJson(harness, request) {
  const response = await harness.invoke({
    methodId: "invoke",
    inputs: [
      {
        portId: "request",
        payload: Buffer.from(JSON.stringify(request), "utf8"),
      },
    ],
  });

  const payload = response.outputs?.find((frame) => frame.portId === "response")
    ?.payload;
  return {
    response,
    json:
      payload instanceof Uint8Array
        ? JSON.parse(new TextDecoder().decode(payload))
        : null,
  };
}
