import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Builder } from 'flatbuffers';
import { loadPublishedCatalog } from '../app/catalog-publication.js';
const scope={schema:'CAT.fbs',provider_id:'celestrak',source_name:'satcat',query_profile:'dataset-publication-offset-v1'};
const layer={node:'peer-celestrak',provider:'celestrak',source:'satcat',manifest:'current-manifest-last'};
function record(id){const b=new Builder(),name=b.createString('Satellite '+id);b.startObject(3);b.addFieldOffset(0,name,0);b.addFieldInt32(2,id,0);b.finishSizePrefixed(b.endObject(),'$CAT');return Buffer.from(b.asUint8Array());}
function fixture(change=()=>{}){
 const streams=[Buffer.concat([record(1),record(2)]),record(3),record(999)];
 const pubs=streams.map((bytes,i)=>({...scope,offset:i===1?2:0,record_count:i===0?2:1,byte_count:bytes.length,batch_id:i===2?'old':'current',manifest_cid:i===1?layer.manifest:'manifest-'+i,shard_cid:'bafytestpublication'+i,shard_sha256:createHash('sha256').update(bytes).digest('hex'),feed_head:'feed-'+i}));
 change(pubs,streams); const calls=[];
 const request=async(path,options)=>{
  const q=JSON.parse(new TextDecoder().decode(options.body.subarray(4)));calls.push(q);
  let header,body=Buffer.alloc(0);
  if(q.op==='list_published_shards')header={...scope,op:q.op,status:'ok',publication_offset:0,publication_count:pubs.length,total_publication_count:pubs.length,publications:pubs};
  else {const i=pubs.findIndex(p=>p.shard_cid===q.cid),p=pubs[i];body=streams[i].subarray(q.byte_offset,q.byte_offset+q.byte_length);header={...scope,status:'ok',immutable_bytes:true,cid:p.shard_cid,batch_id:p.batch_id,shard_sha256:p.shard_sha256,total_byte_count:p.byte_count,byte_offset:q.byte_offset,byte_length:q.byte_length};}
  const json=Buffer.from(JSON.stringify(header)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);
  return new Response(Buffer.concat([length,json,body]),{headers:{'X-SDN-Remote-Peer':layer.node}});
 }; return {request,calls,streams};
}
test('loads one complete published edition without mixing historical batches',async()=>{
 const f=fixture(),progress=[];const result=await loadPublishedCatalog(layer,{request:f.request,onProgress:(n,total)=>progress.push([n,total])});
 assert.equal(result.count,3);assert.equal(result.batch,'current');assert.equal(result.snapshot,layer.manifest);
 assert.deepEqual(Buffer.from(result.stream),Buffer.concat(f.streams.slice(0,2)));assert.deepEqual(progress,[[2,3],[3,3]]);assert.equal(f.calls.length,3);
 assert.ok(f.calls.slice(1).every(q=>q.op==='read_published_shard' && q.batch_id==='current'));
});
test('uses the full batch when discovery points to an earlier shard',async()=>{
 const f=fixture(pubs=>{pubs[0].manifest_cid=layer.manifest;pubs[1].manifest_cid='last-in-batch';});
 assert.equal((await loadPublishedCatalog(layer,{request:f.request})).count,3);
});
test('rejects incomplete editions, duplicate offsets, wrong hashes and withdrawn manifests',async()=>{
 const changes=[pubs=>pubs[1].offset=4,pubs=>pubs[1].offset=0,pubs=>pubs[0].shard_sha256='0'.repeat(64),pubs=>pubs[1].manifest_cid='withdrawn',pubs=>pubs[0].schema='OMM.fbs'];
 for(const change of changes){const f=fixture(change);await assert.rejects(loadPublishedCatalog(layer,{request:f.request}));}
});
test('binds the responding peer and requires an explicit publication',async()=>{
 const f=fixture();await assert.rejects(loadPublishedCatalog({...layer,manifest:''},{request:f.request}),/Refresh sources/);
 const wrong=async(...args)=>{const r=await f.request(...args);r.headers.set('X-SDN-Remote-Peer','another-node');return r;};
 await assert.rejects(loadPublishedCatalog(layer,{request:wrong}),/responding node/);
});
test('loads a complete source-scoped publication without inventing a batch identity',async()=>{
 const f=fixture(pubs=>{pubs.splice(1);Object.assign(pubs[0],{batch_id:'',manifest_cid:layer.manifest});});
 const result=await loadPublishedCatalog({...layer,total:2},{request:f.request});assert.equal(result.count,2);assert.equal(result.batch,'');assert.equal(f.calls[1].batch_id,'');
 await assert.rejects(loadPublishedCatalog({...layer,total:3},{request:f.request}),/unambiguous complete/);
 const ambiguous=fixture(pubs=>{for(const p of pubs)p.batch_id='';});
 await assert.rejects(loadPublishedCatalog({...layer,total:3},{request:ambiguous.request}),/unambiguous complete/);
});
