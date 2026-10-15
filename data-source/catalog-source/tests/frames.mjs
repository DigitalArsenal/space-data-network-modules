// Typed frames for the catalog-source tests: each edition goes in as the HttpResponse (HRSP) hostcap/http-request
// answers (BODY the edition verbatim); outputs are a size-prefixed $CAT stream and one FlowNotice (FNTC) report.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeFlowNotice, encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';

export const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL('../../../../spacedatastandards.org/', import.meta.url));
const { CAT } = await import(pathToFileURL(path.join(STANDARDS_ROOT, 'lib/js/CAT/main.js')).href);
const { ByteBuffer } = createRequire(pathToFileURL(path.join(STANDARDS_ROOT, 'lib/js/CAT/main.js')))('flatbuffers');
export const HRSP = { schemaName:'HttpResponse.fbs', fileIdentifier:'HRSP', rootTypeName:'HttpResponse', wireFormat:'flatbuffer' };
export const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
export const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));

export async function harness(t) {
  const host = await createBrowserModuleHarness({ wasmSource:fs.readFileSync(wasmPath), manifest, surface:'direct' });
  t.after(() => host.destroy()); return host;
}
export function request(methodId, text, status = 200) {
  const body = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return { methodId, inputs:[{ portId:'response', typeRef:HRSP, payload:encodeHttpResponse({ url:'https://example.invalid/edition', status, body, retrievedMs:Date.UTC(2026,8,7) }) }] };
}
// The CAT stream as raw bytes and unpacked rows, and the FlowNotice report.
export function decode(result) {
  assert.equal(result.statusCode, 0, result.errorMessage);
  const bytes = result.outputs.find(frame => frame.portId === 'catalog').payload, rows = [];
  for (let at = 0; at < bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset+at, 4).getUint32(0, true)+4;
    assert.ok(length > 12 && at+length <= bytes.length);
    rows.push(CAT.getSizePrefixedRootAsCAT(new ByteBuffer(bytes.slice(at, at+length))).unpack()); at += length;
  }
  const notice = decodeFlowNotice(result.outputs.find(frame => frame.portId === 'report').payload);
  assert.equal(notice.kind, 'info'); assert.equal(notice.schema, 'CAT.fbs'); assert.equal(notice.count, rows.length);
  const report = Object.fromEntries(notice.reason.split(';').map(pair => { const at = pair.indexOf('='); const v = pair.slice(at+1); return [pair.slice(0, at), /^\d+$/.test(v) ? Number(v) : v]; }));
  return { bytes, rows, notice, report:{ ...report, records:notice.count, nativeKeys:notice.items } };
}
