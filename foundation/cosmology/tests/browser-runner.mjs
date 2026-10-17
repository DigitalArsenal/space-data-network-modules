import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {exercise} from './exercise.mjs';

globalThis.runCosmology = async () => {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function')
    throw new Error('Browser must be cross-origin isolated');
  const oracle = await (await fetch('/oracle.json')).json();
  const wasmSource = new Uint8Array(await (await fetch('/module.wasm')).arrayBuffer());
  const harness = await createBrowserModuleHarness({wasmSource, surface: 'direct'});
  try {
    if (!(harness.memory.buffer instanceof SharedArrayBuffer)) throw new Error('Expected shared WASM memory');
    return await exercise(harness, oracle);
  } finally { await harness.destroy?.(); }
};
