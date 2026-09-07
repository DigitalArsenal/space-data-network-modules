import { ByteBuffer } from 'flatbuffers';
import { DSS } from 'spacedatastandards.org/lib/js/DSS/main.js';
import { request } from './bridge.js';

const decoder = new TextDecoder(), encoder = new TextEncoder();
export async function sourceLanes(signal) {
  const response = await request('/api/v1/sync', { signal });
  if (!response.ok) throw new Error(`Dataset discovery failed (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer()), view = new DataView(bytes.buffer);
  const lanes = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw new Error('Dataset discovery returned a truncated frame.');
    const length = view.getUint32(offset, true);
    if (length < 8 || offset + 4 + length > bytes.length) throw new Error('Dataset discovery returned an invalid frame.');
    const frame = bytes.subarray(offset, offset + length + 4);
    if (decoder.decode(frame.subarray(8, 12)) === '$DSS') {
      const row = DSS.getSizePrefixedRootAsDSS(new ByteBuffer(frame));
      const schema = row.SCHEMA_NAME()?.replace(/\.fbs$/i, '').toUpperCase();
      const node = row.PROVIDER_PEER_ID(), provider = row.PROVIDER_ID(), source = row.SOURCE_NAME();
      if (node && provider && source && ['CAT', 'MPE', 'OMM', 'OEM', 'OCM'].includes(schema)) {
        const id = JSON.stringify([node, provider, source, schema]);
        if (!lanes.some(l => l.id === id)) lanes.push({ id, node, provider, source, schema, head: row.HEAD() || '', total: Number(row.TOTAL_ROWS()) });
      }
    }
    offset += length + 4;
  }
  return lanes;
}

/** The existing SDN FlatSQL sync connector carries a bounded JSON control
 * header followed by canonical size-prefixed records. Each request keeps the
 * selected provider/source and the first response's immutable snapshot.
 */
export async function loadCatalog(layer, { signal, onProgress = () => {} } = {}) {
  const query = { op: 'read_chunk', schema: 'CAT.fbs', source_name: layer.source, provider_id: layer.provider, limit: 1000 };
  // Discovery publishes a feed head; read_chunk returns a different row-snapshot
  // identity. Start a fresh bounded snapshot, then retain it across all pages.
  const chunks = [], cursors = new Set();
  let bytesRead = 0, recordsRead = 0, snapshot = '', head = '', total;
  for (;;) {
    const json = encoder.encode(JSON.stringify(query)), body = new Uint8Array(json.length + 4);
    new DataView(body.buffer).setUint32(0, json.length); body.set(json, 4);
    const response = await request(`/api/v1/data/remote/${encodeURIComponent(layer.node)}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'XMLHttpRequest' }, body, signal,
    });
    if (!response.ok) throw new Error(`Could not load ${layer.source} (${response.status}).`);
    if (response.headers.get('X-SDN-Remote-Peer') !== layer.node) throw new Error('The responding node differs from the selected source.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 4 || bytes.length > 8 * 1024 * 1024) throw new Error('The catalog page is invalid or too large.');
    const length = new DataView(bytes.buffer).getUint32(0);
    if (length > bytes.length - 4) throw new Error('The catalog page header is truncated.');
    const header = JSON.parse(decoder.decode(bytes.subarray(4, length + 4)));
    if (header.status === 'error') throw new Error(header.error?.message || 'The provider could not serve this catalog.');
    if (snapshot && header.snapshot_id !== snapshot || head && header.head !== head) throw new Error('The provider changed its snapshot between pages. Reload the source.');
    if (header.schema !== 'CAT.fbs' || !Number.isSafeInteger(header.total_count) || header.total_count < 0 || total != null && total !== header.total_count) throw new Error('The provider returned an inconsistent catalog page.');
    total = header.total_count;
    snapshot = header.snapshot_id || snapshot; head = header.head || head;
    if (!snapshot || !head) throw new Error('The provider did not identify its catalog snapshot.');
    const stream = bytes.subarray(length + 4), view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    let offset = 0;
    while (offset < stream.length) {
      if (offset + 4 > stream.length) throw new Error('Truncated catalog record.');
      const n = view.getUint32(offset, true);
      if (n < 8 || offset + n + 4 > stream.length || decoder.decode(stream.subarray(offset + 8, offset + 12)) !== '$CAT') throw new Error('The provider returned invalid CAT data.');
      offset += n + 4; ++recordsRead;
    }
    bytesRead += stream.length;
    if (bytesRead > 128 * 1024 * 1024 || recordsRead > 250000) throw new Error('This catalog exceeds the editor’s input limit.');
    chunks.push(stream); onProgress(recordsRead, Number(header.total_count));
    if (!header.next_cursor) break;
    if (cursors.has(header.next_cursor) || stream.length === 0) throw new Error('The provider did not advance its catalog cursor.');
    cursors.add(header.next_cursor);
    Object.assign(query, { cursor: header.next_cursor, snapshot_id: snapshot, head, total_count: header.total_count, high_water_mark: header.high_water_mark });
  }
  const stream = new Uint8Array(bytesRead); let offset = 0;
  for (const chunk of chunks) { stream.set(chunk, offset); offset += chunk.length; }
  if (recordsRead !== total) throw new Error('The catalog changed or a page is missing. Reload the source.');
  const contentSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', stream))].map(b => b.toString(16).padStart(2, '0')).join('');
  return { stream, head, snapshot, contentSha256, count: recordsRead };
}
