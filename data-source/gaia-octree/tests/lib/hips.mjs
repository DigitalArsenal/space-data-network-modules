// The second, independent check of the angular layer: CDS's Gaia DR3 HiPS
// catalog (I/355/gaiadr3, the IVOA HiPS standard, NESTED HEALPix in the
// equatorial frame, sorted by mean G). A HiPS catalog tile at (Norder, Npix)
// holds the brightest sources of its pixel that no ancestor tile holds; so a
// pixel's sources to G <= limit are its ancestors' sources that lie in it,
// plus its own tile's and its descendants', descending only while a tile's
// faintest source is no fainter than the limit. Ancestor rows are assigned
// to the pixel by their source_id (Gaia's own order-12 pixel, shifted to the
// order), so a star that moved across a pixel edge since its source was
// created can differ; the comparison reports those. Tiles are cached raw.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SERVICE = 'https://hipscat.cds.unistra.fr/HiPSCatService/I/355/gaiadr3';

export function hipsCatalog(cacheDir, {offline = false} = {}) {
  fs.mkdirSync(cacheDir, {recursive: true});
  let fetched = 0;
  async function tile(order, pix) {
    const rel = `Norder${order}/Dir${Math.floor(pix / 10000) * 10000}/Npix${pix}.tsv`;
    const file = path.join(cacheDir, `${crypto.createHash('sha256').update(rel).digest('hex')}.tsv`);
    if (!fs.existsSync(file)) {
      if (offline) throw new Error(`HiPS tile not cached: ${rel}`);
      const answer = await fetch(`${SERVICE}/${rel}`, {signal: AbortSignal.timeout(120_000)});
      if (answer.status === 404) { fs.writeFileSync(file, ''); return []; }
      if (!answer.ok) throw new Error(`${rel}: HTTP ${answer.status}`);
      fs.writeFileSync(file, Buffer.from(await answer.arrayBuffer()));
      fetched += 1;
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    if (!lines.length) return [];
    const head = lines[0].split('\t');
    const id = head.indexOf('Source'), g = head.indexOf('Gmag');
    if (id < 0 || g < 0) throw new Error(`${rel}: no Source/Gmag columns`);
    return lines.slice(1).map((l) => { const f = l.split('\t'); return {id: BigInt(f[id]), g: f[g] === '' ? NaN : Number(f[g])}; });
  }
  /** Source ids of the stars to `limit` in nested pixel `pix` at `order`. */
  async function pixelSources(order, pix, limit) {
    const ids = new Set();
    for (let k = 1; k < order; k++) {
      const ancestor = Math.floor(pix / 4 ** (order - k));
      for (const s of await tile(k, ancestor)) if (s.g <= limit && s.id >> BigInt(35 + 2 * (12 - order)) === BigInt(pix)) ids.add(String(s.id));
    }
    const walk = async (k, p) => {
      const rows = await tile(k, p);
      for (const s of rows) if (s.g <= limit) ids.add(String(s.id));
      const faintest = rows.reduce((m, s) => (s.g > m ? s.g : m), -Infinity);
      if (rows.length && faintest <= limit && k < 11) for (let c = 0; c < 4; c++) await walk(k + 1, 4 * p + c);
    };
    await walk(order, pix);
    return ids;
  }
  return {pixelSources, get fetched() { return fetched; }};
}
