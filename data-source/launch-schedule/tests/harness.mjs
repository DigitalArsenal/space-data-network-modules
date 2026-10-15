// Shared test harness for the launch notices modules on the typed contracts (1.0): the SDK browser harness with the
// typed hostcall. The hostcall import is wrapped so a test can change the node config between invocations:
// plugin.getConfig is answered here with one ModuleConfig on raw "config" exactly as the Go node answers it (or FAILED
// when `config` is null), and every $PIV request the module sends lands in `wire`.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeHostCall, encodeHostCallResult, encodeHttpResponse, encodeModuleConfig, encodeTimerTick } from 'space-data-module-sdk/runtime-contracts';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';

export const producerPeerId = '16Uiu2HAm1apfD3rAJJjgx4AC5Ms3PejRBwoqEsKpRx36uYwXuW9h';
export const retrievedMs = 1790600400000;
export const nodeConfig = (over = {}) => ({
  launch_schedule_enabled: true,
  launch_schedule_producer_peer_id: producerPeerId,
  launch_schedule_source: { access: 'anonymous', limit: 100 },
  ...over,
});
export const TYPES = {
  TICK: { schemaName: 'TimerTick.fbs', fileIdentifier: 'TICK', rootTypeName: 'TimerTick', wireFormat: 'flatbuffer' },
  HRSP: { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' },
};
export const tick = () => ({ portId: 'tick', typeRef: TYPES.TICK, payload: encodeTimerTick({ triggerId: 'timer-launch-schedule', scheduledMs: retrievedMs, firedMs: retrievedMs }) });
// The host's answer to the plan's GET: the body, the request's CONTEXT echoed, the retrieval time.
export function httpResponse(context, body, status = 200, { retrieved = retrievedMs, headers = {} } = {}) {
  const bytes = body instanceof Uint8Array ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? ''));
  return { portId: 'response', typeRef: TYPES.HRSP, payload: encodeHttpResponse({ url: 'https://ll.thespacedevs.com/2.3.0/launches/upcoming/', status, headers, body: bytes, context, retrievedMs: retrieved }) };
}

const instantiate = WebAssembly.instantiate;
export async function harness(t, { wasm, manifest, config = {} }) {
  const stub = { config, wire: [] };
  WebAssembly.instantiate = async (module, imports) => {
    let memory;
    let answer = null;
    const host = imports.space_data_module_host;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (op, opLen, ptr, len) => {
        const call = decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice());
        stub.wire.push(call);
        answer = call.op !== 'plugin.getConfig'
          ? encodeHostCallResult({ ok: false, error: { code: 'unsupported', message: `unexpected op ${call.op}` } })
          : stub.config === null
            ? encodeHostCallResult({ ok: false, error: { code: 'unsupported', message: 'no node config' } })
            : encodeHostCallResult({ ok: true, op: call.op, raw: { config: encodeModuleConfig(stub.config) } });
        return 0;
      },
      response_len: () => answer.length,
      read_response: (dst, len) => { const n = Math.min(len, answer.length); new Uint8Array(memory.buffer).set(answer.subarray(0, n), dst); return n; },
    } };
    const result = await instantiate(module, wrapped);
    memory = (result.instance ?? result).exports.memory;
    return result;
  };
  let h;
  try {
    h = await createBrowserModuleHarness({ wasmSource: new Uint8Array(fs.readFileSync(wasm)), manifest: JSON.parse(fs.readFileSync(manifest, 'utf8')), surface: 'direct',
      hostcallDispatch: (op) => { throw new Error(`unexpected hostcall ${op}`); } });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => h.destroy());
  h.stub = stub;
  return h;
}
export const CORE = { wasm: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), manifest: fileURLToPath(new URL('../plugin-manifest.json', import.meta.url)) };
export const ADAPTER = { wasm: fileURLToPath(new URL('../host-adapter/dist/isomorphic/module.wasm', import.meta.url)), manifest: fileURLToPath(new URL('../host-adapter/plugin-manifest.json', import.meta.url)) };
