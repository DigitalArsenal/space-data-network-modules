// Runs plan_sources and build_sensors in the SDK's browser harness with the cassette as the only network.
import fs from 'node:fs';
import {storedCatRecords, SATCAT_URL} from './stored-cat-fixture.mjs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ByteBuffer } from 'flatbuffers';
import { SNR } from 'spacedatastandards.org/lib/js/SNR/SNR.js';
import { PVN } from 'spacedatastandards.org/lib/js/PVN/PVN.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { decodeFlowNotice, decodeHttpRequest, decodeIngestRequest, encodeHttpResponse, encodeTimerTick } from 'space-data-module-sdk/runtime-contracts';

export const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const manifest = JSON.parse(fs.readFileSync(here('../plugin-manifest.json'), 'utf8'));
export const cassette = JSON.parse(gunzipSync(fs.readFileSync(here('./fixtures/cassette.json.gz')))).responses;
const TICK = { schemaName: 'TimerTick.fbs', fileIdentifier: 'TICK', rootTypeName: 'TimerTick', wireFormat: 'flatbuffer' };
const HRSP = { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' };
export const PEER = '16Uiu2HAmTestProducer';

export async function harness(config = { producer_peer_id: PEER }) {
  let stored = storedCatRecords(PEER);
  const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(here('../dist/isomorphic/module.wasm')), manifest, surface: 'direct',
    hostcallDispatch(operation, params) {
      if (operation === 'plugin.getConfig') return config;
      if (operation === 'storage.query') {
        if (params.schema !== 'CAT.fbs' || params.limit !== 250000) throw Error('Unexpected identity query');
        return stored;
      }
      throw Error('Unexpected host operation ' + operation);
    } });
  host.setStored = records => { stored = records; };
  return host;
}

export async function plan(host) {
  const r = await host.invoke({ methodId: 'plan_sources', inputs: [{ portId: 'tick', typeRef: TICK, payload: encodeTimerTick({ triggerId: 'weekly', scheduledMs: 1, firedMs: 1 }) }] });
  return { result: r, urls: r.outputs.filter((o) => o.portId === 'request').map((o) => decodeHttpRequest(new Uint8Array(o.payload)).url) };
}

// `mutate(url, entry)` may change or replace a response (a stale quote, a failed fetch, a changed SATCAT row).
export async function build(host, urls, mutate = (u, e) => e) {
  host.setStored(storedCatRecords(PEER, mutate(SATCAT_URL, structuredClone(cassette[SATCAT_URL]))));
  const inputs = urls.map((url) => {
    const e = mutate(url, structuredClone(cassette[url]));
    return { portId: 'response', typeRef: HRSP, payload: encodeHttpResponse({ url, status: e.status, error: e.error ?? '', headers: {}, body: new Uint8Array(Buffer.from(e.body)), retrievedMs: e.retrievedMs }) };
  });
  return host.invoke({ methodId: 'build_sensors', inputs });
}

// A size-prefixed record stream to its records, each as { bytes, snr (unpacked), root }.
export function records(frame) {
  const out = [];
  if (!frame) return out;
  const b = Buffer.from(frame.payload);
  for (let at = 0; at < b.length;) {
    const size = b.readUInt32LE(at) + 4;
    const bytes = new Uint8Array(b.subarray(at, at + size));
    const root = SNR.getSizePrefixedRootAsSNR(new ByteBuffer(bytes));
    out.push({ size, bytes, root, snr: root.unpack() });
    at += size;
  }
  return out;
}

export const frames = (result, port) => result.outputs.filter((o) => o.portId === port);
export const notices = (result) => frames(result, 'notice').map((f) => decodeFlowNotice(new Uint8Array(f.payload)));
export const pvns = (result) => frames(result, 'provenance').map((f) => PVN.getRootAsPVN(new ByteBuffer(new Uint8Array(f.payload))).unpack());
export const metas = (result, port) => frames(result, port).map((f) => decodeIngestRequest(new Uint8Array(f.payload)));
export const itemMap = (notice) => Object.fromEntries(notice.items.map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
