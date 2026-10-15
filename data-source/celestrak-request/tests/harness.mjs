// The SDK browser harness; its BrowserHost answers plugin.getConfig from the node config (one ModuleConfig on raw
// "config", as the Go node answers it). The hostcall import is wrapped only to record which operations the module calls.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decodeHostCall } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

export const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
export const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
export const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
export const sdsLib = (code) => import(pathToFileURL(path.join(STANDARDS_ROOT, `lib/js/${code}/main.js`)).href);
export const flatbuffers = createRequire(pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/ICN/main.js")))("flatbuffers");

export async function createHarness(t, config = {}) {
  // Record the hostcalls the module makes (the SDK harness's BrowserHost answers them, plugin.getConfig from `config`).
  const calls = [];
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    let memory;
    const host = imports.space_data_module_host;
    if (!host) return instantiate(module, imports);
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (opPtr, opLen, ptr, len) => {
        calls.push(decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice()).op);
        return host.call(opPtr, opLen, ptr, len);
      },
    } };
    const instance = await instantiate(module, wrapped);
    memory = (instance.instance ?? instance).exports.memory;
    return instance;
  };
  let harness;
  try {
    harness = await createBrowserModuleHarness({
      wasmSource: new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)),
      manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
      surface: "direct",
      hostOptions: { config },
    });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => harness.destroy());
  harness.calls = calls;
  return harness;
}
