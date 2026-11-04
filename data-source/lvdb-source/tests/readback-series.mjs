import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {ByteBuffer} from 'flatbuffers';
import {hash} from './sources.mjs';
const require=createRequire(import.meta.url);
const sds=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const {DPM}=await import(pathToFileURL(path.join(sds,'lib/js/DPM/DPM.js')));
const {SSY}=await import(pathToFileURL(path.join(sds,'lib/js/SSY/SSY.js')));
const {publicationAssetKind}=await import(pathToFileURL(path.join(sds,'lib/js/DPM/publicationAssetKind.js')));

// The auto-publisher's summary CID names the FIRST signed part, not a manifest
// containing every part. Walk the public typed list-published protocol for the
// batch's complete manifest series, then retrieve every manifest/shard by CID.
// open-manifest is a raw-table operation and requires private-read authority.
export async function readbackSeries({root,node,peerId,batchId,firstManifestCid,expectedCount}) {
  const sdnRoot=process.env.SDN_JS??path.resolve(root,'../../../space-data-network/sdn-js');
  const sdn=await import(pathToFileURL(path.join(sdnRoot,'dist/index.mjs')));
  const addrs=[`/ip4/127.0.0.1/tcp/${node.ports.ws}/ws/p2p/${peerId}`];
  const client=await sdn.createHeliaSDNNode({edgeRelays:addrs,enableAutoDial:false,enableDHT:false,enableIdentify:true,allowPrivateAddressDial:true});
  try {
    let peer;
    const deadline=Date.now()+30000;
    while(!peer&&Date.now()<deadline){
      peer=client.libp2p.getConnections().find(c=>String(c.remotePeer)===peerId)?.remotePeer;
      if(!peer)await new Promise(r=>setTimeout(r,200));
    }
    assert(peer,'Scratch-node peer connection timed out');
    const segments=[];const cursors=new Set();let cursor='',totalParts;
    do {
      assert(!cursors.has(cursor),'Repeated publication-page cursor');cursors.add(cursor);
      const stream=await client.libp2p.dialProtocol(peer,sdn.FLATSQL_SYNC_LIST_PUBLISHED_PROTOCOL_ID,{signal:AbortSignal.timeout(30000)});
      const chunks=[];
      const reading=(async()=>{for await(const c of stream)chunks.push(c instanceof Uint8Array?c:c.subarray());})();
      // Two parts/page deliberately exercises pagination in the eight-shard fixture.
      if(!stream.send(sdn.encodeFlatSqlPublishedListRequest({schema:'SSY.fbs',providerId:'lvdb',sourceName:'comb-all',batchId,cursor,limit:2})))await stream.onDrain?.();
      await stream.close();await reading;
      const page=sdn.decodeFlatSqlPublishedList(Buffer.concat(chunks));
      totalParts??=page.totalCount;assert.equal(page.totalCount,totalParts);
      assert(totalParts>1&&totalParts<10000,'Bounded multi-shard fixture');
      for(const p of page.publications){
        assert.equal(p.batchId,batchId);assert.equal(p.providerId,'lvdb');assert.equal(p.sourceName,'comb-all');assert.equal(p.schemaName,'SSY.fbs');
        segments.push({...p,cid:p.shardCid,rowCount:p.recordCount});
      }
      cursor=page.nextCursor;
    } while(cursor);
    assert.equal(segments.length,totalParts,'Every publication page consumed');
    segments.sort((a,b)=>a.offset-b.offset);
    let offset=0;for(const s of segments){assert.equal(s.offset,offset,'No gap or overlap in batch');offset+=s.rowCount;}
    assert.equal(offset,expectedCount,'Complete batch manifest count');
    assert(segments.some(s=>s.manifestCid===firstManifestCid),'Summary manifest belongs to this series');
    const cat=async cid=>{
      const r=await fetch(node.rpc+'/api/v0/cat?arg='+encodeURIComponent(cid),{method:'POST',signal:AbortSignal.timeout(30000)});
      assert.equal(r.status,200,`CID ${cid}`);return Buffer.from(await r.arrayBuffer());
    };
    const ids=new Set(),seenShards=new Set(),parts=[],shards=[];
    for(const segment of segments){
      assert(segment.cid&&segment.manifestCid,'Every segment must be published');
      const bytes=await cat(segment.manifestCid);
      const dpm=(bytes.subarray(8,12).toString()==='$DPM'?DPM.getSizePrefixedRootAsDPM:DPM.getRootAsDPM)(new ByteBuffer(bytes)).unpack();
      assert(dpm.PROVIDER_SIGNATURE.length);assert.equal(dpm.PROVIDER_PEER_ID,peerId);
      assert(dpm.SOURCES.some(s=>s.SOURCE_NAME==='comb-all'&&s.LICENSE==='CC0-1.0'));
      const assets=dpm.ASSETS.filter(a=>a.ASSET_KIND===publicationAssetKind.DATA_SHARD&&a.SCHEMA_NAME==='SSY.fbs');
      assert.deepEqual(assets.map(a=>a.CID),[segment.cid],'Signed part binds the batch segment');
      for(const asset of assets){
        assert(!seenShards.has(asset.CID),'Duplicate shard in batch manifest');seenShards.add(asset.CID);
        let b=await cat(asset.CID);
        assert.equal(hash(b),asset.BYTE_SHA256.toLowerCase());assert.equal(b.length,Number(asset.BYTE_LENGTH));
        if(b[0]===31&&b[1]===139)b=gunzipSync(b);
        let count=0;
        for(let at=0;at<b.length;){
          assert(at+4<=b.length,'Truncated frame length');const n=b.readUInt32LE(at);
          assert(n>8&&at+4+n<=b.length,'Truncated record');
          const record=SSY.getSizePrefixedRootAsSSY(new ByteBuffer(b.subarray(at,at+4+n)));
          assert(!ids.has(record.ID()),'Duplicate SSY identity across shards');ids.add(record.ID());count++;at+=4+n;
        }
        assert.equal(count,segment.rowCount,'Shard count matches batch segment');parts.push(b);
        shards.push({manifestCid:segment.manifestCid,cid:asset.CID,count});
        console.log(`PASS SSY shard CID=${asset.CID} records=${count}`);
      }
    }
    assert.equal(ids.size,expectedCount,'Complete unique SSY identities');
    return {records:Buffer.concat(parts),shards,uniqueRecords:ids.size,manifestCids:segments.map(s=>s.manifestCid)};
  } finally {await client.stop();}
}
