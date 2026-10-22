// Test-only, bounded capture of public source bytes. Never execute downloads.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function createEvidenceStore(root, prefix) {
  await fs.mkdir(root, {recursive:true});
  const dir = await fs.mkdtemp(path.join(root, prefix));
  const provenance = [];
  async function get(source, filename, url, maxBytes = 2 * 1024 * 1024) {
    const destination = path.join(dir, source);
    await fs.mkdir(destination, {recursive:true});
    const receipt = {source, file:`${source}/${filename}`, url, requestedAt:new Date().toISOString()};
    try {
      const response = await fetch(url, {redirect:'error', signal:AbortSignal.timeout(20000)});
      Object.assign(receipt, {status:response.status, contentType:response.headers.get('content-type'),
        lastModified:response.headers.get('last-modified')});
      let size = 0; const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        assert.ok(size <= maxBytes, `${url}: response exceeds byte limit`);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      await fs.writeFile(path.join(destination, filename), bytes);
      Object.assign(receipt, {bytes:size, sha256:sha256(bytes)});
      assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
      return bytes;
    } catch (error) {
      receipt.error = error.message;
      receipt.errorCode = error.cause?.code ?? error.code ?? null;
      throw error;
    } finally {
      receipt.retrievedAt = new Date().toISOString();
      provenance.push(receipt);
      // Preserve failures as well as successes, including interrupted runs.
      await fs.writeFile(path.join(dir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    }
  }
  return {dir, provenance, get};
}
