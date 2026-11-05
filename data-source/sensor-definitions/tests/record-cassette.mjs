#!/usr/bin/env node
// Records the cassette tests/fixtures/cassette.json.gz: the real responses of the requests plan_sources plans.
//   SATCAT_FILE=/path/satcat.csv SATCAT_RETRIEVED=2026-11-05T15:31:06Z node tests/record-cassette.mjs
// OSCAR and the MediaWiki API are fetched here, one request a second. CelesTrak blocks some addresses and asks for one SATCAT
// request per three hours, so the SATCAT comes from a file the caller fetched (SATCAT_FILE), trimmed to whole rows: the rows of
// the roster's NORAD ids and of the constellation prefixes. Everything is recorded with its fetch time and sha256 (provenance.json).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { encodeTimerTick } from 'space-data-module-sdk/runtime-contracts';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(fs.readFileSync(here('../plugin-manifest.json'), 'utf8'));
const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(here('../dist/isomorphic/module.wasm')), manifest, surface: 'direct', hostOptions: { config: { producer_peer_id: 'x' } } });
const TICK = { schemaName: 'TimerTick.fbs', fileIdentifier: 'TICK', rootTypeName: 'TimerTick', wireFormat: 'flatbuffer' };
const plan = await host.invoke({ methodId: 'plan_sources', inputs: [{ portId: 'tick', typeRef: TICK, payload: encodeTimerTick({ triggerId: 'weekly', scheduledMs: 0, firedMs: 0 }) }] });
await host.destroy();
if (plan.statusCode !== 0) throw new Error(`plan_sources: ${plan.errorCode} ${plan.errorMessage}`);
const { decodeHttpRequest } = await import('space-data-module-sdk/runtime-contracts');
const urls = plan.outputs.filter((o) => o.portId === 'request').map((o) => decodeHttpRequest(new Uint8Array(o.payload)).url);

// The SATCAT rows the roster names: NORAD ids of platforms and the constellation prefixes.
const roster = fs.readFileSync(here('../src/roster.hpp'), 'utf8');
const platforms = roster.slice(roster.indexOf('kPlatforms[]'), roster.indexOf('// ---- Ground sensors'));
const norads = new Set([...platforms.matchAll(/\{"[a-z0-9_]+", (\d+), nullptr,/g)].map((m) => m[1]));
const prefixes = [...platforms.matchAll(/\{"[a-z0-9_]+", 0, "([A-Z-]+)",/g)].map((m) => m[1]);
function trimSatcat(csv) {
  const lines = csv.split('\n');
  const out = [lines[0]];
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    if (norads.has(f[2]) || (prefixes.some((p) => line.startsWith(p)) && f[3] === 'PAY' && f[8] === '')) out.push(line);
  }
  return `${out.join('\n')}\n`;
}

const responses = {}, provenance = [];
for (const url of urls) {
  let body, retrievedMs, original;
  if (url.includes('celestrak.org')) {
    original = fs.readFileSync(process.env.SATCAT_FILE);
    retrievedMs = Date.parse(process.env.SATCAT_RETRIEVED);
    body = trimSatcat(original.toString('utf8'));
  } else {
    const res = await fetch(url);
    if (res.status !== 200) throw new Error(`${res.status} ${url}`);
    original = Buffer.from(await res.arrayBuffer());
    retrievedMs = Date.now();
    body = original.toString('utf8');
    await new Promise((r) => setTimeout(r, 1100));
  }
  responses[url] = { status: 200, retrievedMs, body };
  provenance.push({ url, retrievedAt: new Date(retrievedMs).toISOString(), originalBytes: original.length, originalSha256: sha256(original), recordedBytes: Buffer.byteLength(body), recordedSha256: sha256(Buffer.from(body)) });
  console.log(`${url.slice(0, 100)} ${original.length} -> ${Buffer.byteLength(body)}`);
}
fs.mkdirSync(here('./fixtures'), { recursive: true });
fs.writeFileSync(here('./fixtures/cassette.json.gz'), gzipSync(JSON.stringify({ responses })));
fs.writeFileSync(here('./fixtures/provenance.json'), `${JSON.stringify({ recordedWith: 'tests/record-cassette.mjs', requests: provenance }, null, 2)}\n`);
