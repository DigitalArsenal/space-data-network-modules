// SpaceX MEME text -> $OEM by data-source/spacex-starlink-source (WASM). The
// module fetches its files through the `space_data_module_host` http.request
// call; this host answers from bytes already fetched (politely, in memory), so
// the module's own parser runs on them and nothing is written anywhere. The
// same host contract as orbit-accuracy-experiments' supgp-omm reader.
import fs from 'node:fs';
import path from 'node:path';
import { stripWasmCustomSections } from 'space-data-module-sdk/bundle';
import { MODULES } from './host.mjs';

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const envelope = (obj) => {
  const meta = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(8 + meta.length);
  new DataView(out.buffer).setUint32(0, meta.length, true);
  out.set(meta, 4);
  return out;
};

export async function loadMemeReader() {
  const raw = fs.readFileSync(path.join(MODULES, 'data-source/spacex-starlink-source/dist/isomorphic/module.wasm'));
  const compiled = await WebAssembly.compile(stripWasmCustomSections(new Uint8Array(raw)));
  const MANIFEST_URL = 'memory://starlink/MANIFEST.txt';
  return {
    // filename: the MEME file name; bytes: the file. Returns the module's $OEM bytes, or null.
    async read(filename, bytes) {
      let response = new Uint8Array(0);
      let instance = null;
      const memory = () => new Uint8Array(instance.exports.memory.buffer);
      const serve = (url) => (url === MANIFEST_URL ? { status: 200, body: Buffer.from(`${filename}\n`) }
        : url.endsWith(`/${filename}`) ? { status: 206, body: bytes } : { status: 404, body: Buffer.alloc(0) });
      const host = {
        call(opPtr, opLen, payloadPtr, payloadLen) {
          const op = new TextDecoder().decode(memory().slice(opPtr, opPtr + opLen));
          const request = memory().slice(payloadPtr, payloadPtr + payloadLen);
          const meta = JSON.parse(new TextDecoder().decode(request.subarray(4, 4 + u32(request, 0))));
          if (op !== 'http.request') { response = envelope({ ok: false, error: { message: `unhandled host call ${op}` } }); return 0; }
          const answer = serve(meta.url);
          response = envelope({ ok: true, result: { status: answer.status, body_encoding: 'base64', body: Buffer.from(answer.body).toString('base64') } });
          return 0;
        },
        response_len: () => response.length,
        read_response(dst, len) { const n = Math.min(len, response.length); memory().set(response.subarray(0, n), dst); return n; },
        clear_response() { response = new Uint8Array(0); return 0; },
        last_status_code: () => 0,
      };
      instance = await WebAssembly.instantiate(compiled, { space_data_module_host: host, wasi_snapshot_preview1: { fd_close: () => 0, fd_write: () => 0, fd_seek: () => 0 } });
      const ex = instance.exports;
      ex._initialize?.();
      const cfg = new TextEncoder().encode(JSON.stringify({ manifestUrl: MANIFEST_URL, offset: 0, count: 1, rangeBytes: bytes.length }));
      const cfgPtr = ex.plugin_alloc(cfg.length);
      memory().set(cfg, cfgPtr);
      const lenPtr = ex.plugin_alloc(4);
      const resultPtr = ex.plugin_invoke_stream(cfgPtr, cfg.length, lenPtr);
      const result = memory().slice(resultPtr, resultPtr + u32(memory(), lenPtr));
      if (result.length < 4 || u32(result, 0) === 0) return null;
      const n = u32(result, 4);
      return Buffer.from(result.slice(8, 8 + n));
    },
  };
}
