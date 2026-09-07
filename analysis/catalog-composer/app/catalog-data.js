import { ByteBuffer } from 'flatbuffers';
import { DSS } from 'spacedatastandards.org/lib/js/DSS/main.js';
import { request } from './bridge.js';
import { loadPublishedCatalog } from './catalog-publication.js';

const decoder = new TextDecoder();
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
        if (!lanes.some(l => l.id === id)) lanes.push({ id, node, provider, source, schema, head: row.FEED_HEAD() || '', manifest: row.LAST_PUBLICATION_CID() || '', total: Number(row.TOTAL_ROWS()) });
      }
    }
    offset += length + 4;
  }
  return lanes;
}

export function loadCatalog(layer, options = {}) {
  return loadPublishedCatalog(layer, { ...options, request });
}
