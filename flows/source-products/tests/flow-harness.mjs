// The compiled flow in the SDK's JS flow host, and the modules it links one by one through the SDK's browser module
// harness: the flow must give the bytes the chain of modules gives.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFlowRuntimeHost } from 'space-data-module-sdk/flow';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
export const modulesRoot = here('../../../');
export const flowDist = here('../dist/');
export const flowWasm = new Uint8Array(fs.readFileSync(`${flowDist}isomorphic/module.wasm`));
export const flowDocument = JSON.parse(fs.readFileSync(`${flowDist}flow.json`, 'utf8'));
export const flowManifest = JSON.parse(fs.readFileSync(`${flowDist}plugin-manifest.json`, 'utf8'));

// Every ingress frame is enqueued before the flow drains; frames are { trigger, portId, bytes }.
export async function runFlow(frames) {
  const host = await createFlowRuntimeHost({ wasmSource: flowWasm, runtimeTarget: 'wasmedge' });
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
export const egressJson = (egress, port) => JSON.parse(egressBytes(egress, port).toString());

// A module of this repository by its path, as the flow links it.
export function moduleAt(relative) {
  const dir = `${modulesRoot}${relative}/`;
  const wasm = fs.readFileSync(`${dir}dist/isomorphic/module.wasm`);
  const manifest = JSON.parse(fs.readFileSync(`${dir}plugin-manifest.json`, 'utf8'));
  return async function invoke(methodId, inputs) {
    const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
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
