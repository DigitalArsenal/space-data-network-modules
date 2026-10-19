// The imagery lane as a consumer finds it over SDN (the stack's
// deployment/star-catalog-provider-node/lanes.mjs recipe): a Helia node from
// sdn-js dials the publisher, asks list_published_shards per (schema,
// provider, source), takes the newest complete batch, and reads each shard
// through its $DPM (provider peer, listed CID, length and sha256 checked).
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export function sizePrefixed(bytes) {
  const out = [];
  for (let o = 0; o + 4 <= bytes.length;) {
    const n = new DataView(bytes.buffer, bytes.byteOffset + o, 4).getUint32(0, true);
    if (n === 0 || o + 4 + n > bytes.length) throw new Error(`a size prefix at ${o} runs past the stream`);
    out.push(bytes.subarray(o, o + 4 + n));
    o += 4 + n;
  }
  return out;
}

function complete(shards) {
  const s = [...shards].sort((a, b) => a.offset - b.offset);
  if (s.length === 0 || s[0].offset !== 0) return false;
  for (let i = 1; i < s.length; i++) if (s[i - 1].record_count !== s[i - 1].limit || s[i].offset !== s[i - 1].offset + s[i - 1].limit) return false;
  return s.at(-1).record_count < s.at(-1).limit;
}

export async function openLanes({sdnJs, provider, addrs}) {
  const sdn = await import(pathToFileURL(path.join(sdnJs, 'dist/index.mjs')).href);
  const sdsJs = (rel) => pathToFileURL(path.join(sdnJs, 'node_modules', rel)).href;
  const flatbuffers = await import(sdsJs('flatbuffers/mjs/flatbuffers.js'));
  const {DPM} = await import(sdsJs('spacedatastandards.org/lib/js/DPM/DPM.js'));
  const {publicationAssetKind} = await import(sdsJs('spacedatastandards.org/lib/js/DPM/publicationAssetKind.js'));
  const node = await sdn.createHeliaSDNNode({edgeRelays: addrs, enableAutoDial: false, enableDHT: false, enableIdentify: true, allowPrivateAddressDial: true});
  const fetchCid = (cid, maxBytes = 64 << 20) => sdn.fetchCIDBytesFromHelia(node.helia, cid, {providerAddrs: addrs, maxBytes});
  const peer = async () => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const c = node.libp2p.getConnections().find((x) => String(x.remotePeer) === provider);
      if (c) return c.remotePeer;
      if (Date.now() > deadline) throw new Error(`no connection to the publishing node ${provider}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  // flatsql-sync 2.0 list-published, paged (the stack's deployment/solar-system-provider-node/lane-cids.mjs recipe).
  async function list(lane) {
    const target = await peer();
    const transport = {async dialProtocol(_target, protocolId, payload) {
      const stream = await node.libp2p.dialProtocol(target, protocolId);
      const chunks = [];
      const reading = (async () => { for await (const c of stream) chunks.push(c instanceof Uint8Array ? c : c.subarray()); })();
      if (!stream.send(payload)) await stream.onDrain?.();
      await stream.close();
      await reading;
      return new Uint8Array(Buffer.concat(chunks));
    }};
    const batches = new Map();
    for (let cursor = '', pages = 0; pages < 1000; pages++) {
      const page = await sdn.requestFlatSqlPublishedList(transport, {targetPeerId: provider, schema: lane.schema, providerId: lane.providerId,
        sourceName: lane.sourceName, cursor, limit: 500});
      for (const p of page.publications) {
        if (p.providerId !== lane.providerId || p.sourceName !== lane.sourceName) continue;
        const row = {batch_id: p.batchId, published_at: new Date(p.publishedAtMs).toISOString(), record_count: p.recordCount, limit: p.limit,
          offset: p.offset, manifest_cid: p.manifestCid, shard_cid: p.shardCid};
        batches.set(row.batch_id, [...(batches.get(row.batch_id) ?? []), row]);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const newest = (b) => Math.max(...b.map((p) => Date.parse(p.published_at)));
    return [...batches.values()].sort((a, b) => newest(b) - newest(a)).find(complete) ?? null;
  }
  async function shard(listed, schema) {
    const bytes = await fetchCid(listed.manifest_cid, 1 << 20);
    const prefixed = bytes.length >= 8 && String.fromCharCode(...bytes.subarray(8, 12)) === '$DPM';
    const bb = new flatbuffers.ByteBuffer(bytes);
    const root = prefixed ? DPM.getSizePrefixedRootAsDPM(bb) : DPM.getRootAsDPM(bb);
    if (String(root.PROVIDER_PEER_ID() ?? '') !== provider) throw new Error(`${listed.manifest_cid}: $DPM names provider ${root.PROVIDER_PEER_ID()}`);
    for (let i = 0; i < root.assetsLength(); i++) {
      const a = root.ASSETS(i);
      if (!a || a.ASSET_KIND() !== publicationAssetKind.DATA_SHARD || String(a.SCHEMA_NAME() ?? '') !== schema) continue;
      const cid = String(a.CID() ?? '').trim();
      if (listed.shard_cid && cid !== listed.shard_cid) throw new Error(`${listed.manifest_cid}: $DPM shard ${cid} is not the listed ${listed.shard_cid}`);
      let data = await fetchCid(cid);
      if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data);
      if (data.length !== Number(a.BYTE_LENGTH()) || sha256(data) !== String(a.BYTE_SHA256() ?? '').trim().toLowerCase()) throw new Error(`${cid}: not the bytes its $DPM states`);
      return data;
    }
    throw new Error(`${listed.manifest_cid}: $DPM has no ${schema} data shard`);
  }
  // The newest complete batch's records (size-prefixed), or null when none is listed yet.
  async function records(lane) {
    const batch = await list(lane);
    if (!batch) return null;
    const shards = await Promise.all(batch.map((p) => shard(p, lane.schema)));
    return {batch: batch[0].batch_id, shards: batch.length, records: shards.flatMap((s) => sizePrefixed(new Uint8Array(s)))};
  }
  const close = () => Promise.race([node.stop(), new Promise((r) => setTimeout(r, 5000))]);
  return {records, fetchCid, close};
}
