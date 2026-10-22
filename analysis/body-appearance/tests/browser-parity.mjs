import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeRequest} from '../codec.js';

window.runAppearanceParity = async requests => {
  const bytes = new Uint8Array(await (await fetch('/module.wasm')).arrayBuffer());
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    v => v.toString(16).padStart(2, '0')).join('');
  const artifactSha256 = await digest(bytes);
  const harness = await createBrowserModuleHarness({wasmSource: bytes, surface: 'direct'});
  try {
    const outputs = [];
    for (const {name, method, values} of requests) {
      const response = await harness.invoke(encodeRequest(method, values));
      if (response.statusCode !== 0 || response.outputs.length !== 1)
        throw new Error(`${name}: ${response.errorCode}: ${response.errorMessage}`);
      outputs.push({name, sha256: await digest(response.outputs[0].payload), bytes: response.outputs[0].payload.length});
    }
    return {artifactSha256, outputs,crossOriginIsolated:window.crossOriginIsolated,
      sharedArrayBuffer:typeof SharedArrayBuffer==='function'};
  } finally { await harness.destroy(); }
};
