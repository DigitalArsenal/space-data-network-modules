// One screening worker of the local distributed harness: an independent
// process that declares its capability (module threads, memory, runtime),
// runs the units it is given through its own module instance (Node's V8, or
// WasmEdge ahead-of-time compiled as SDN nodes run it), files each output in
// the content store, and signs a PNM (the SDS publish notification record)
// naming the output's CID. Behaviours for the harness: honest; cheat=f, which
// hides the closest conjunction of a fraction f of its screen units; drop=f,
// which never answers a fraction f of its units. All geometry is in the module.
import fs from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import { createModuleHarness } from 'space-data-module-sdk/testing';
import { PNMT, PNM } from 'spacedatastandards.org/lib/js/PNM/main.js';
import { CQR } from 'spacedatastandards.org/lib/js/CQR/main.js';
import { createConjunctionCommandHarness } from '../../tests/lib/conjunctionCommandHarness.mjs';
import { packFrames, runUnit, unpackFrames } from '../../gpu/workUnits.mjs';
import { cidOf, openStore } from './contentStore.mjs';

let config, store, harness, keys, moduleSha;
const fraction = (seed, id) => parseInt(createHash('sha256').update(`${seed}:${id}`).digest('hex').slice(0, 12), 16) / 2 ** 48;
const behaviour = (name) => { const m = new RegExp(`${name}=([0-9.]+)`).exec(config.behaviour ?? ''); return m ? Number(m[1]) : 0; };

// The output with the screen unit's closest conjunction removed (still a valid CQR result).
function hideClosest(output) {
  const frames = unpackFrames(output).map((f) => CQR.getRootAsCQR(new flatbuffers.ByteBuffer(f)).unpack());
  let best = null;
  frames.forEach((r, i) => (r.CATALOG_RESULT.EVENTS ?? []).forEach((e, j) => { if (!best || e.MISS_DISTANCE_M < best.miss) best = { i, j, miss: e.MISS_DISTANCE_M }; }));
  if (!best) return output;
  frames[best.i].CATALOG_RESULT.EVENTS.splice(best.j, 1);
  return packFrames(frames.map((r) => { const b = new flatbuffers.Builder(1 << 16); CQR.finishCQRBuffer(b, r.pack(b)); return b.asUint8Array().slice(); }));
}

function pnm(unitId, cid) {
  const record = new PNMT();
  record.MULTIFORMAT_ADDRESS = `/ipfs/${cid}`;
  record.PUBLISH_TIMESTAMP = new Date().toISOString();
  record.CID = cid;
  record.FILE_NAME = `ca-unit-${unitId.slice(0, 16)}`;
  record.FILE_ID = `ca.unit:${unitId}`;
  record.SIGNATURE = sign(null, Buffer.from(`${record.FILE_ID}\n${cid}`), keys.privateKey).toString('base64');
  record.SIGNATURE_TYPE = 'ed25519';
  record.TIMESTAMP_SIGNATURE = sign(null, Buffer.from(record.PUBLISH_TIMESTAMP), keys.privateKey).toString('base64');
  record.TIMESTAMP_SIGNATURE_TYPE = 'ed25519';
  const b = new flatbuffers.Builder(1024);
  PNM.finishPNMBuffer(b, record.pack(b));
  return Buffer.from(b.asUint8Array()).toString('base64');
}

// Units run one at a time, in the order they arrive.
let chain = Promise.resolve();
process.on('message', (message) => { chain = chain.then(() => handle(message)); });
async function handle(message) {
  if (message.type === 'init') {
    config = message;
    store = openStore(config.storeDir);
    keys = generateKeyPairSync('ed25519');
    moduleSha = createHash('sha256').update(fs.readFileSync(config.modulePath)).digest('hex');
    harness = config.runtime === 'wasmedge-aot'
      ? await createModuleHarness({ runtime: { kind: 'wasmedge', launchPlan: { command: config.aotRunner, args: [config.aotModule, '--serve-plugin-invoke'],
        cwd: process.cwd(), env: process.env } } })
      : await createConjunctionCommandHarness({ runtimeKind: 'browser' });
    process.send({ type: 'ready', id: config.id, moduleSha256: moduleSha, publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') });
    return;
  }
  if (message.type === 'stop') { await harness?.destroy?.(); process.exit(0); }
  if (message.type !== 'unit') return;
  const { record, unitId, attempt } = message;
  if (record.module !== moduleSha) { process.send({ type: 'error', unitId, attempt, message: 'module differs' }); return; }
  if (fraction(`${config.id}:drop`, unitId) < behaviour('drop')) return;   // never answers
  try {
    const c = process.cpuUsage(), t = performance.now();
    let output = await runUnit(record, { invoke: (methodId, inputs) => harness.invoke({ methodId, inputs }), fetch: (h) => store.get(h), threads: config.threads });
    if (record.kind === 'ca.screen/1' && fraction(`${config.id}:cheat`, unitId) < behaviour('cheat')) output = hideClosest(output);
    const u = process.cpuUsage(c);
    const hash = store.put(output);
    process.send({ type: 'result', unitId, attempt, worker: config.id, hash, pnm: pnm(unitId, cidOf(hash)),
      wallS: (performance.now() - t) / 1000, cpuS: (u.user + u.system) / 1e6 });
  } catch (error) {
    process.send({ type: 'error', unitId, attempt, message: String(error?.stack ?? error) });
  }
}
