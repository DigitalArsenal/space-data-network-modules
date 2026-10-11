// A screening worker process (screenWorker.mjs) seen from its coordinator:
// spawn it and wait for its declaration (module hash, public key), check
// that an answer's PNM is signed by it and names the unit and the output's
// CID, and run one unit at a time on it.
import path from 'node:path';
import { fork } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { PNM } from 'spacedatastandards.org/lib/js/PNM/main.js';
import { cidOf } from './contentStore.mjs';

const workerScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenWorker.mjs');

/** @param {{id, runtime: 'node'|'wasmedge-aot', threads, memoryMiB, behaviour?, storeDir, modulePath, aotModule?, aotRunner?}} o */
export function spawnWorker(o) {
  return new Promise((resolve, reject) => {
    const child = fork(workerScript, [], { execArgv: ['--max-old-space-size=8192'] });
    const w = { ...o, behaviour: o.behaviour ?? 'honest', child };
    child.once('message', (m) => {
      if (m.type !== 'ready') return reject(new Error(`${o.id}: ${JSON.stringify(m)}`));
      w.publicKey = createPublicKey({ key: Buffer.from(m.publicKey, 'base64'), format: 'der', type: 'spki' });
      w.publicKeyBase64 = m.publicKey;
      w.moduleSha256 = m.moduleSha256;
      resolve(w);
    });
    child.on('error', reject);
    child.send({ type: 'init', id: o.id, runtime: o.runtime, threads: o.threads, behaviour: w.behaviour, storeDir: o.storeDir,
      modulePath: o.modulePath, aotModule: o.aotModule, aotRunner: o.aotRunner });
  });
}

/** The answer's PNM is the worker's, for this unit, naming the output it filed. */
export function signedByWorker(w, unitId, m, store) {
  const pnm = PNM.getRootAsPNM(new flatbuffers.ByteBuffer(Buffer.from(m.pnm, 'base64')));
  return pnm.FILE_ID() === `ca.unit:${unitId}` && pnm.CID() === cidOf(m.hash) && store.has(m.hash) &&
    verify(null, Buffer.from(`${pnm.FILE_ID()}\n${pnm.CID()}`), w.publicKey, Buffer.from(pnm.SIGNATURE(), 'base64'));
}

/** Runs one unit on the worker and returns its answer (the caller checks it). */
export function runOn(w, record, unitId) {
  return new Promise((resolve) => {
    const listener = (m) => { if (m.unitId !== unitId) return; w.child.off('message', listener); resolve(m); };
    w.child.on('message', listener);
    w.child.send({ type: 'unit', record, unitId });
  });
}

export const stopWorker = (w) => w.child.send({ type: 'stop' });
