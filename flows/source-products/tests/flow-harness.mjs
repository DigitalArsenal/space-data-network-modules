// The compiled flow in the SDK's JS flow host, and the modules it links one by one through the SDK's browser module
// harness: the flow must give the bytes the chain of modules gives.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFlowRuntimeHost } from 'space-data-module-sdk/flow';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { decodeHostCall, encodeHostCallResult, encodeModuleConfig } from 'space-data-module-sdk/runtime-contracts';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
export const modulesRoot = here('../../../');
export const flowDist = here('../dist/');
export const flowWasm = new Uint8Array(fs.readFileSync(`${flowDist}isomorphic/module.wasm`));
export const flowDocument = JSON.parse(fs.readFileSync(`${flowDist}flow.json`, 'utf8'));
export const flowManifest = JSON.parse(fs.readFileSync(`${flowDist}plugin-manifest.json`, 'utf8'));

// The host side of the typed hostcall, as the Go node answers it: plugin.getConfig is one ModuleConfig on raw "config"
// (the flow's node configuration, shared by every node); the flow asks for nothing else.
export function hostStub(config) {
  const memoryRef = { memory: null };
  const decoder = new TextDecoder();
  let response = new Uint8Array(0);
  const answer = (r) => { response = encodeHostCallResult(r); return 0; };
  const imports = { space_data_module_host: {
    call(opPtr, opLen, payloadPtr, payloadLen) {
      const heap = new Uint8Array(memoryRef.memory.buffer);
      const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
      decodeHostCall(Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen)));
      if (operation === 'plugin.getConfig') return answer({ ok: true, op: operation, raw: { config: encodeModuleConfig(config) } });
      return answer({ ok: false, error: { code: 'unsupported', message: `unexpected op ${operation}` } });
    },
    response_len() { return response.length; },
    read_response(dst, len) { const n = Math.min(len, response.length); new Uint8Array(memoryRef.memory.buffer).set(response.subarray(0, n), dst); return n; },
  } };
  return { imports, memoryRef };
}

// Every ingress frame is enqueued before the flow drains; frames are { trigger, portId, bytes }. `config` is the flow's
// node configuration (recipe.mjs flowConfig).
export async function runFlow(frames, config = {}) {
  const stub = hostStub(config);
  const host = await createFlowRuntimeHost({ wasmSource: flowWasm, extraImports: stub.imports, runtimeTarget: 'wasmedge' });
  stub.memoryRef.memory = host.memory;
  const egress = new Map();
  for (const frame of frames) {
    const index = flowDocument.triggers.findIndex((t) => t.triggerId === frame.trigger);
    if (index < 0) throw new Error(`no trigger ${frame.trigger}`);
    host.enqueueTriggerFrame(index, { portId: frame.portId, bytes: frame.bytes, ...(frame.typeRef ? { typeRef: frame.typeRef } : {}) });
  }
  const result = await host.drain({
    'sdn.flow.egress:emit': ({ frames: out }) => {
      for (const f of out) {
        if (!egress.has(f.portId)) egress.set(f.portId, []);
        egress.get(f.portId).push(Buffer.from(f.bytes));
      }
      return { statusCode: 0 };
    },
  }, { maxIterations: 500 });
  return { egress, result };
}
export const egressBytes = (egress, port) => Buffer.concat(egress.get(port) ?? []);

// A module of this repository by its path, as the flow links it.
// `config` is the node configuration the module is called with (the same flow config).
export function moduleAt(relative) {
  const dir = `${modulesRoot}${relative}/`;
  const wasm = fs.readFileSync(`${dir}dist/isomorphic/module.wasm`);
  const manifest = JSON.parse(fs.readFileSync(`${dir}plugin-manifest.json`, 'utf8'));
  return async function invoke(methodId, inputs, config = {}) {
    const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct', hostOptions: { config } });
    try {
      const response = await h.invoke({ methodId, inputs });
      if (response.statusCode !== 0) throw new Error(`${relative} ${methodId}: ${response.errorCode}: ${response.errorMessage}`);
      const byPort = new Map();
      for (const f of response.outputs) {
        if (!byPort.has(f.portId)) byPort.set(f.portId, []);
        byPort.get(f.portId).push(Buffer.from(f.payload));
      }
      return byPort;
    } finally {
      h.destroy();
    }
  };
}
export const bytesOf = (byPort, port) => Buffer.concat(byPort.get(port) ?? []);
export const framesOf = (byPort, port) => byPort.get(port) ?? [];

// One source's run: its recipe (recipe.mjs) as the flow's node configuration and its models on the `models` trigger.
export async function runSource(frames, recipe) {
  const { flowConfig, modelsBytes } = await import('../recipe.mjs');
  return runFlow([...frames, { trigger: 'models', portId: 'models', bytes: modelsBytes(recipe) }], flowConfig(recipe));
}
