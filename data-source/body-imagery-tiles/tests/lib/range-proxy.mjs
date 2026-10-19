// A caching proxy for byte ranges of one upstream file: the provider node's flow is pointed at it, and it answers
// GET with Range (and If-Match) from its cache, or from the upstream once (then cached, keyed by the range, with the
// upstream's status, ETag and the body's sha256). A run is offline after its first.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

export async function startRangeProxy({upstream, cacheDir, offline = false}) {
  fs.mkdirSync(cacheDir, {recursive: true});
  const stats = {hits: 0, misses: 0, bytes: 0, errors: []};
  const server = http.createServer(async (req, res) => {
    const range = String(req.headers.range ?? '');
    const key = sha256(`${upstream} ${range}`);
    const file = path.join(cacheDir, `${key}.body`), meta = path.join(cacheDir, `${key}.json`);
    try {
      if (!/^bytes=\d+-\d+$/.test(range)) throw new Error(`only one whole range is proxied, not "${range}"`);
      if (!fs.existsSync(meta)) {
        if (offline) throw new Error(`not cached: ${range}`);
        const headers = {range};
        if (req.headers['if-match']) headers['if-match'] = req.headers['if-match'];
        const answer = await fetch(upstream, {headers, signal: AbortSignal.timeout(900_000)});
        const bytes = Buffer.from(await answer.arrayBuffer());
        if (answer.status !== 206) { stats.errors.push(`upstream ${answer.status}`); res.writeHead(answer.status); res.end(bytes); return; }
        fs.writeFileSync(file, bytes);
        fs.writeFileSync(meta, JSON.stringify({status: 206, range, bytes: bytes.length, sha256: sha256(bytes),
          etag: answer.headers.get('etag'), contentRange: answer.headers.get('content-range'), fetched: new Date().toISOString()}));
        stats.misses += 1;
      } else stats.hits += 1;
      const bytes = fs.readFileSync(file);
      const cached = JSON.parse(fs.readFileSync(meta, 'utf8'));
      if (sha256(bytes) !== cached.sha256) throw new Error(`${file} is not the answer cached`);
      if (req.headers['if-match'] && cached.etag && req.headers['if-match'] !== cached.etag) {
        res.writeHead(412);
        res.end();
        return;
      }
      stats.bytes += bytes.length;
      res.writeHead(206, {'content-type': 'image/tiff', 'content-length': bytes.length, 'content-range': cached.contentRange, etag: cached.etag});
      res.end(bytes);
    } catch (error) {
      stats.errors.push(String(error?.message ?? error).slice(0, 300));
      res.writeHead(502);
      res.end(String(error?.message ?? error));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${server.address().port}/source.tif`, stats, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); })};
}
