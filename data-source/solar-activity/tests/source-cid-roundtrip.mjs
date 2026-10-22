// Raw public source files only. This is NOT typed solar-record publication.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createLocalNode} from './lib/local-node.mjs';
import {sha256} from './lib/evidence-store.mjs';

const evidence = new URL('./evidence/',import.meta.url);
const captures = ['2026-10-22-ts940s','2026-10-22-freshness-R5Cpu0'];
const startedAt = new Date().toISOString();
const binary = process.env.SDN_NODE_BINARY;
assert.ok(binary,'Set SDN_NODE_BINARY to the native full-node binary');
const binarySha256 = sha256(await fs.readFile(binary));
const node = await createLocalNode(binary,process.env.SOLAR_NODE_WORK);
const receipt = {status:'RUNNING',scope:'raw-source-files-only',startedAt,
  binarySha256,stateDirectory:node.dir,records:[],
  publishedSolarRecords:0,solarRecordCidReadBacks:0};
const receiptPath = new URL('source-cid-roundtrip.json',evidence);
try {
  receipt.peerId = await node.start();
  for (const capture of captures) {
    const provenance = JSON.parse(await fs.readFile(new URL(`${capture}/provenance.json`,evidence)));
    for (const item of provenance.filter(r=>r.status===200 && !r.error)) {
      const sourceFile = `${capture}/${item.file}`;
      const original = await fs.readFile(new URL(sourceFile,evidence));
      assert.equal(sha256(original),item.sha256,sourceFile);
      const form = new FormData();
      form.append('file',new Blob([original]),item.file.split('/').at(-1));
      const added = await fetch(`${node.rpc}/api/v0/add?pin=true&cid-version=1`,
        {method:'POST',body:form,signal:AbortSignal.timeout(20000)});
      assert.equal(added.status,200,'Native node IPFS add');
      const {Hash:cid} = JSON.parse((await added.text()).trim());
      assert.match(cid,/^b[a-z2-7]+$/,'CIDv1 base32 returned by real Kubo');
      const response = await fetch(`${node.rpc}/api/v0/cat?arg=${encodeURIComponent(cid)}`,
        {method:'POST',signal:AbortSignal.timeout(20000)});
      assert.equal(response.status,200,'CID read-back');
      const retrieved = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(retrieved,original,sourceFile);
      receipt.records.push({sourceFile,sourceUrl:item.url,cid,bytes:retrieved.length,
        sourceSha256:item.sha256,readBackSha256:sha256(retrieved)});
      await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n');
    }
  }
  receipt.status = 'PASS_RAW_SOURCE_FILES_ONLY';
} catch (error) {
  receipt.status = 'FAIL';receipt.error = error.message;process.exitCode = 1;
} finally {
  await node.stop();
  receipt.completedAt = new Date().toISOString();
  receipt.nodeStopped = node.child.exitCode!==null || node.child.signalCode!==null;
  await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n');
}
console.log(JSON.stringify({status:receipt.status,rawFilesReadBack:receipt.records.length,
  publishedSolarRecords:0,nodeStopped:receipt.nodeStopped,receipt:fileURLToPath(receiptPath),error:receipt.error},null,2));
