import { ByteBuffer } from 'flatbuffers';
import { CAT } from 'spacedatastandards.org/lib/js/CAT/main.js';

export function coverageDesignators(stream) {
  const objects = new Set(); let unresolved = 0;
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  for (let offset = 0; offset < stream.length;) {
    if (offset + 12 > stream.length) throw new Error('Truncated source coverage catalog.');
    const length = view.getUint32(offset, true);
    if (length < 8 || offset + length + 4 > stream.length || new TextDecoder().decode(stream.subarray(offset + 8, offset + 12)) !== '$CAT') throw new Error('Invalid source coverage catalog.');
    const row = CAT.getSizePrefixedRootAsCAT(new ByteBuffer(stream.subarray(offset, offset + length + 4)));
    const id = String(row.OBJECT_ID() || '').trim();
    if (/^\d{4}-\d{3}[A-Z]{1,3}$/.test(id)) objects.add(id); else ++unresolved;
    offset += length + 4;
  }
  return { objects: [...objects].sort(), unresolved };
}

// A provider must publish CAT membership for the same source as its orbital
// files. Another provider's catalog is never evidence of this source's coverage.
export function primarySources(lanes) {
  const groups = new Map();
  for (const lane of lanes) {
    const key = JSON.stringify([lane.node, lane.provider, lane.source]);
    const group = groups.get(key) || { id: key, node: lane.node, provider: lane.provider, source: lane.source, formats: [] };
    if (lane.schema === 'CAT') group.catalog = lane;
    else group.formats.push(lane.schema);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.formats.length).map(group => ({ ...group, published: Boolean(group.catalog?.manifest) }));
}
