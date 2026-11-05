#!/usr/bin/env node
// Records the cassette tests/fixtures/cassette.json.gz: the real responses of the requests plan_sources plans (Wikidata wbgetentities, MediaWiki
// extracts, one Overpass query). The sources are fetched here with an identifying User-Agent, one request every 1.1 seconds (the Overpass request
// is retried with growing pauses when the public server is at capacity). Everything is recorded with its fetch time and sha256 (provenance.json).
//   node tests/record-cassette.mjs            re-fetches only the requests the cassette does not hold yet
//   REFRESH=1 node tests/record-cassette.mjs  re-fetches everything (the weekly re-record)
//   SKIP=overpass node tests/record-cassette.mjs  leaves the requests whose URL contains the word for a later run
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { decodeHttpRequest, encodeTimerTick } from 'space-data-module-sdk/runtime-contracts';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const UA = 'SDN-space-infrastructure/0.1 (https://spacedatanetwork.org; edg.nn@proton.me)';
const manifest = JSON.parse(fs.readFileSync(here('../plugin-manifest.json'), 'utf8'));
const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(here('../dist/isomorphic/module.wasm')), manifest, surface: 'direct', hostOptions: { config: { producer_peer_id: 'x' } } });
const TICK = { schemaName: 'TimerTick.fbs', fileIdentifier: 'TICK', rootTypeName: 'TimerTick', wireFormat: 'flatbuffer' };
const plan = await host.invoke({ methodId: 'plan_sources', inputs: [{ portId: 'tick', typeRef: TICK, payload: encodeTimerTick({ triggerId: 'weekly', scheduledMs: 0, firedMs: 0 }) }] });
await host.destroy();
if (plan.statusCode !== 0) throw new Error(`plan_sources: ${plan.errorCode} ${plan.errorMessage}`);
const urls = plan.outputs.filter((o) => o.portId === 'request').map((o) => decodeHttpRequest(new Uint8Array(o.payload)).url);

const kept = !process.env.REFRESH && fs.existsSync(here('./fixtures/cassette.json.gz')) ? JSON.parse(gunzipSync(fs.readFileSync(here('./fixtures/cassette.json.gz')))).responses : {};
const keptProvenance = !process.env.REFRESH && fs.existsSync(here('./fixtures/provenance.json')) ? JSON.parse(fs.readFileSync(here('./fixtures/provenance.json'), 'utf8')).requests : [];
const responses = {}, provenance = [];
// The cassette is written after every response, so an interrupted run keeps what it fetched.
function save() {
  fs.mkdirSync(here('./fixtures'), { recursive: true });
  fs.writeFileSync(here('./fixtures/cassette.json.gz'), gzipSync(JSON.stringify({ responses: Object.fromEntries(urls.filter((u) => responses[u] ?? kept[u]).map((u) => [u, responses[u] ?? kept[u]])) })));
  fs.writeFileSync(here('./fixtures/provenance.json'), `${JSON.stringify({ recordedWith: 'tests/record-cassette.mjs', requests: urls.map((u) => provenance.find((y) => y && y.url === u) ?? keptProvenance.find((x) => x && x.url === u)).filter(Boolean) }, null, 2)}\n`);
}
for (const url of urls) {
  if (kept[url]) {
    responses[url] = kept[url];
    provenance.push(keptProvenance.find((x) => x.url === url));
    continue;
  }
  if (process.env.SKIP && url.includes(process.env.SKIP)) continue; // SKIP=overpass: leave a source that is down for a later run
  let res, body, original;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      original = Buffer.from(await res.arrayBuffer());
    } catch (error) {
      res = { status: 0 };
      original = Buffer.alloc(0);
      console.log(`  ${error.cause?.code ?? error.message} ${url.slice(0, 80)}`);
    }
    if (res.status === 200 && original.length) break;
    console.log(`  ${res.status} ${url.slice(0, 80)}: retry ${attempt}`);
    await new Promise((r) => setTimeout(r, 15000 * attempt));
  }
  if (res.status !== 200) throw new Error(`${res.status} ${url}`);
  const retrievedMs = Date.now();
  body = original.toString('utf8');
  responses[url] = { status: 200, retrievedMs, body };
  provenance.push({ url, retrievedAt: new Date(retrievedMs).toISOString(), bytes: original.length, sha256: sha256(original) });
  console.log(`${url.slice(0, 110)} ${original.length}`);
  save();
  await new Promise((r) => setTimeout(r, 1100));
}
save();
