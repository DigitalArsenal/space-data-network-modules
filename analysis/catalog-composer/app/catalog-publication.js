import { readPage } from './read-page.js';
const encoder = new TextEncoder(), decoder = new TextDecoder();
const PROFILE = 'dataset-publication-offset-v1', MAX_BYTES = 128 * 1024 * 1024;
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const hash = bytes => crypto.subtle.digest('SHA-256', bytes).then(value => [...new Uint8Array(value)].map(b => b.toString(16).padStart(2, '0')).join(''));

/** Read the complete published edition, never a mixture of historical batches. */
export async function loadPublishedCatalog(layer, { request, signal, onProgress = () => {}, onRetry = () => {} }) {
  if (!layer.manifest) throw new Error('Refresh sources to select a published catalog edition.');
  const scope = { schema: 'CAT.fbs', provider_id: layer.provider, source_name: layer.source, query_profile: PROFILE };
  async function read(query) {
    const json = encoder.encode(JSON.stringify({ ...scope, ...query })), body = new Uint8Array(json.length + 4);
    new DataView(body.buffer).setUint32(0, json.length); body.set(json, 4);
    const response = await readPage(request, `/api/v1/data/remote/${encodeURIComponent(layer.node)}`, { method: 'POST', body, signal }, { onRetry });
    if (!response.ok) throw new Error(`Could not load ${layer.source} (${response.status}).`);
    if (response.headers.get('X-SDN-Remote-Peer') !== layer.node) throw new Error('The responding node differs from the selected source.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 4 || bytes.length > 8 * 1024 * 1024) throw new Error('Invalid catalog response size.');
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
    if (length > bytes.length - 4) throw new Error('Truncated catalog response header.');
    const header = JSON.parse(decoder.decode(bytes.subarray(4, length + 4)));
    if (header.status !== 'ok') throw new Error(header.error?.message || 'The published catalog is unavailable.');
    if (header.schema !== scope.schema || header.provider_id !== scope.provider_id || header.source_name !== scope.source_name || header.query_profile !== PROFILE) throw new Error('The publication differs from the selected source.');
    return { header, bytes: bytes.subarray(length + 4) };
  }
  const publications = [];
  let totalPublications;
  for (let offset = 0;;) {
    const { header, bytes } = await read({ op: 'list_published_shards', publication_offset: offset, publication_limit: 1000 });
    if (bytes.length || !Array.isArray(header.publications) || header.publication_offset !== offset || header.publication_count !== header.publications.length || !integer(header.total_publication_count, 0, 16000) || totalPublications != null && totalPublications !== header.total_publication_count) throw new Error('The catalog publication list changed. Refresh sources.');
    totalPublications = header.total_publication_count;
    if (header.publications.length > 1000 || offset + header.publications.length > totalPublications || !header.publications.length && offset < totalPublications) throw new Error('Invalid publication listing page.');
    publications.push(...header.publications); offset = publications.length;
    if (offset === totalPublications) break;
  }
  const targets = publications.filter(p => p.manifest_cid === layer.manifest);
  if (targets.length !== 1 || typeof targets[0].batch_id !== 'string') throw new Error('The selected catalog edition is no longer available. Refresh sources.');
  const target = targets[0];
  const shards = publications.filter(p => p.batch_id === target.batch_id).sort((a, b) => a.offset - b.offset);
  if (!target.batch_id && (shards.length !== 1 || target.offset !== 0 || target.record_count !== layer.total)) throw new Error('This source needs an unambiguous complete catalog publication.');
  const last = shards.at(-1), expected = last.offset + last.record_count;
  if (!integer(expected, 1, 250000)) throw new Error('Invalid catalog edition size.');
  let count = 0, size = 0;
  const cids = new Set();
  for (const shard of shards) {
    if (shard.schema !== scope.schema || shard.provider_id !== scope.provider_id || shard.source_name !== scope.source_name || shard.query_profile !== PROFILE || shard.offset !== count || !integer(shard.record_count, 1, 250000) || !integer(shard.byte_count, 1, MAX_BYTES) || !/^[a-f0-9]{64}$/.test(shard.shard_sha256) || !/^[A-Za-z0-9]{10,128}$/.test(shard.shard_cid) || cids.has(shard.shard_cid)) throw new Error('The published catalog has missing, duplicate or invalid shards.');
    cids.add(shard.shard_cid); count += shard.record_count; size += shard.byte_count;
  }
  if (count !== expected || size > MAX_BYTES) throw new Error('The published catalog is incomplete or exceeds the editor limit.');
  const stream = new Uint8Array(size);
  let streamOffset = 0, recordsRead = 0;
  for (const shard of shards) {
    const output = stream.subarray(streamOffset, streamOffset + shard.byte_count);
    for (let offset = 0; offset < output.length;) {
      const length = Math.min(4 * 1024 * 1024, output.length - offset);
      const { header, bytes } = await read({ op: 'read_published_shard', batch_id: target.batch_id, cid: shard.shard_cid, byte_offset: offset, byte_length: length });
      if (header.immutable_bytes !== true || header.cid !== shard.shard_cid || header.batch_id !== target.batch_id || header.shard_sha256 !== shard.shard_sha256 || header.total_byte_count !== output.length || header.byte_offset !== offset || header.byte_length !== length || bytes.length !== length) throw new Error('The published shard changed or returned an incomplete range.');
      output.set(bytes, offset); offset += length;
    }
    if (await hash(output) !== shard.shard_sha256) throw new Error('The catalog shard failed its content hash check.');
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    let offset = 0, shardRows = 0;
    while (offset < output.length) {
      if (offset + 4 > output.length) throw new Error('Truncated catalog record.');
      const length = view.getUint32(offset, true);
      if (length < 8 || offset + length + 4 > output.length || decoder.decode(output.subarray(offset + 8, offset + 12)) !== '$CAT') throw new Error('Invalid published CAT record.');
      offset += length + 4; ++shardRows;
    }
    if (shardRows !== shard.record_count) throw new Error('The shard record count differs from its publication.');
    recordsRead += shardRows; streamOffset += output.length; onProgress(recordsRead, expected);
  }
  return { stream, head: last.feed_head || layer.manifest, snapshot: layer.manifest, contentSha256: await hash(stream), count: recordsRead, batch: target.batch_id };
}
