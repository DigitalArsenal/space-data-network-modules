// The canonical $TDM the module gives, unpacked with the SDS generated object API of this module's pinned standards.
import { ByteBuffer } from 'flatbuffers';
import { TDM } from 'spacedatastandards.org/lib/js/TDM/TDM.js';

export const unpackTdm = (bytes) => TDM.getRootAsTDM(new ByteBuffer(new Uint8Array(bytes))).unpack();
