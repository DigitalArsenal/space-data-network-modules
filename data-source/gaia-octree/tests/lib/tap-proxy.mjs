// A caching proxy for TAP: the provider node's flow is pointed at it, and it
// answers POST <base>/sync from its cache, or from the upstream service once
// (then cached: 200s and ESA's 408 job timeouts). Each answer is stored raw
// with its status and sha256, keyed by the sha256 of the request body, so a
// run is offline after its first.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

export async function startTapProxy({upstream, cacheDir, offline = false}) {
  fs.mkdirSync(cacheDir, {recursive: true});
  const stats = {hits: 0, misses: 0, bytes: 0, errors: []};
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const key = sha256(body);
    const file = path.join(cacheDir, `${key}.body`), meta = path.join(cacheDir, `${key}.json`);
    try {
      if (!fs.existsSync(meta)) {
        if (offline) throw new Error(`not cached: ${new URLSearchParams(body.toString()).get("QUERY")?.replace(/^SELECT .* WHERE /, "")}`);
        const answer = await fetch(`${upstream}${req.url.replace(/^\/tap/, '')}`, {method: 'POST', body,
          headers: {'content-type': 'application/x-www-form-urlencoded'}, signal: AbortSignal.timeout(600_000)});
        const bytes = Buffer.from(await answer.arrayBuffer());
        // A 408 (ESA's job timeout) is kept too, so an offline run replays the split it led to; other failures are not.
        if (answer.status !== 200 && answer.status !== 408) { stats.errors.push(`upstream ${answer.status}`); res.writeHead(answer.status); res.end(bytes); return; }
        fs.writeFileSync(file, bytes);
        fs.writeFileSync(meta, JSON.stringify({status: answer.status, bytes: bytes.length, sha256: sha256(bytes),
          query: new URLSearchParams(body.toString()).get('QUERY'), fetched: new Date().toISOString()}));
        stats.misses += 1;
      } else stats.hits += 1;
      const bytes = fs.readFileSync(file);
      const {sha256: want, status} = JSON.parse(fs.readFileSync(meta, 'utf8'));
      if (sha256(bytes) !== want) throw new Error(`${file} is not the answer cached`);
      stats.bytes += bytes.length;
      res.writeHead(status, {'content-type': status === 200 ? 'text/csv' : 'application/x-votable+xml', 'content-length': bytes.length});
      res.end(bytes);
    } catch (error) {
      stats.errors.push(String(error?.message ?? error).slice(0, 300));
      res.writeHead(502);
      res.end(String(error?.message ?? error));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${server.address().port}/tap`, stats, close: () => new Promise((r) => server.close(r))};
}
