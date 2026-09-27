// Read an already-running node's IPFS publication; never starts a daemon or
// reads its credentials. Requires immutable CIDs, never a mutable latest alias.
import fs from 'node:fs';
import {ByteBuffer} from 'flatbuffers';
import {OPM} from 'spacedatastandards.org/lib/js/OPM/OPM.js';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {request} from '../../../files/orbit-products/tests/vimpel-fixture.mjs';
import {parseDatefirst,crosswalkCandidates,sha256} from '../app/crosswalk.js';
const [gateway,orbitsCid,crosswalkCid]=process.argv.slice(2);
if(!gateway || ![orbitsCid,crosswalkCid].every(x=>/^[A-Za-z0-9]{20,128}$/.test(x)))throw new Error('Usage: node tools/screen-node-crosswalk.mjs GATEWAY ORBITS_CID DATEFIRST_CID');
async function read(cid,limit) {
 const response=await fetch(new URL('ipfs/'+cid,gateway.replace(/\/?$/,'/')),{signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error(`Node returned ${response.status} for ${cid}`);
 const chunks=[];let length=0;const reader=response.body.getReader();
 try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>limit)throw new Error('Published product exceeds the input bound.');chunks.push(value);}}
 finally{await reader.cancel();}
 return new Uint8Array(Buffer.concat(chunks));
}
const input=await read(orbitsCid,16*1024*1024),crosswalkBytes=await read(crosswalkCid,8*1024*1024);
const root=new URL('../../../files/orbit-products/',import.meta.url),wasm=fs.readFileSync(new URL('dist/isomorphic/module.wasm',root));
const h=await createBrowserModuleHarness({wasmSource:wasm,manifest:JSON.parse(fs.readFileSync(new URL('plugin-manifest.json',root))),surface:'direct'});
try {
 const out=await h.invoke(request(new TextDecoder('utf-8',{fatal:true}).decode(input)));if(out.statusCode)throw new Error(out.errorMessage);
 const states=out.outputs.filter(x=>x.portId==='states'),edition='ipfs:'+orbitsCid;
 const products=states.map((x,i)=>({id:'v'+i,provider:'vimpel',nativeId:OPM.getSizePrefixedRootAsOPM(new ByteBuffer(x.payload)).OBJECT_NAME().replace(/^vimpel:/,''),recordId:edition+'#'+i}));
 const crosswalk=await parseDatefirst(crosswalkBytes,{recordId:'ipfs:'+crosswalkCid}),selection=crosswalkCandidates(crosswalk,products);
 const counts=(rows,key)=>rows.reduce((a,row)=>(a[row[key]]=(a[row[key]]||0)+1,a),{});
 console.log(JSON.stringify({retrievedAt:new Date().toISOString(),gateway,providerEdition:edition,providerSha256:await sha256(input),normalizedRecords:states.length,normalizerSha256:await sha256(wasm),crosswalkEdition:crosswalk.recordId,crosswalkSha256:crosswalk.sha256,rows:crosswalk.edges.length,counts:counts(crosswalk.edges,'status'),candidatePairs:selection.pairs.length,unresolved:counts(selection.unresolved,'reason'),acceptedIdentities:0,limitation:'This provider-only audit has no independent Space-Track state products. Missing counterproducts are insufficient evidence; no identity or independent corroboration is inferred.'},null,2));
} finally {await h.destroy();}
