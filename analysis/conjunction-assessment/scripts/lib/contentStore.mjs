// A local content-addressed store: bytes are filed under their SHA-256, and
// every read is verified against its name. It stands in, in the local
// harness, for SDN's content-addressed retrieval (records announced by CID).
// Also the CID of a hash: CIDv1, raw codec, sha2-256, base32.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** The CIDv1 (raw, sha2-256) of a SHA-256 hex digest, base32 multibase ('b...'). */
export function cidOf(hex) {
  const bytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), Buffer.from(hex, 'hex')]);
  let bits = 0, value = 0, out = 'b';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (hash) => path.join(dir, hash);
  return {
    dir,
    put(bytes) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (!fs.existsSync(file(hash))) {
        const temporary = `${file(hash)}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, bytes);
        fs.renameSync(temporary, file(hash));
      }
      return hash;
    },
    async get(hash) {
      const bytes = new Uint8Array(fs.readFileSync(file(hash)));
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Content ${hash} does not match its name.`);
      return bytes;
    },
    has: (hash) => fs.existsSync(file(hash)),
  };
}
