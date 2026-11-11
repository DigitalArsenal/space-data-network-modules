// SDNAP_RECORD_DIR: the tests that hold the stored AP record's flights against recorded files (ap-terms, epoch-store,
// covariance, fit) write this build's own flights there, named for this build's version (`<stem>-<version>.<ext>`), by the
// very calls they make; a release that moves those flights by design records them from itself this way and the tests state
// the history. Without the variable nothing is written.
import fs from 'node:fs';
import path from 'node:path';

const version = JSON.parse(fs.readFileSync(new URL('../../plugin-manifest.json', import.meta.url), 'utf8')).version;

/** Writes `bytes` (a Uint8Array or a Float64Array) as `<stem>-<version>.<ext>` under SDNAP_RECORD_DIR, if it is set. */
export function recordReference(stem, ext, bytes) {
  const dir = process.env.SDNAP_RECORD_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stem}-${version}.${ext}`), new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}
