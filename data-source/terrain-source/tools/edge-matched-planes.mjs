// Lossless body payload layout D. Topology mirrors src/tile_mesh.hpp; no height-product assumptions.
export const EDGE_MATCHED_PLANES = "qm-edge-matched-planes-v1";
const zz = (d) => ((d << 1) ^ (d >> 31)) & 0xffff;

/** edge_matched_mesh (tile_mesh.hpp), verbatim port. */
export function edgeMatchedMesh(n, cand, edges) {
  const L = n - 1, s = L / (cand - 1);
  const row = [], col = [], indices = [];
  const vertexOf = new Int32Array(n * n).fill(-1);
  const vertex = (r, c) => {
    const key = r * n + c;
    let vx = vertexOf[key];
    if (vx < 0) { vx = row.length; vertexOf[key] = vx; row.push(r); col.push(c); }
    return vx;
  };
  for (let j = 1; j + 2 < cand; j++) {
    for (let i = 1; i + 2 < cand; i++) {
      const bl = vertex(j * s, i * s), br = vertex(j * s, (i + 1) * s);
      const tl = vertex((j + 1) * s, i * s), tr = vertex((j + 1) * s, (i + 1) * s);
      indices.push(bl, br, tr, bl, tr, tl);
    }
  }
  const outer = [], inner = [];
  for (const c of edges[0]) outer.push([vertex(0, c), c]);
  for (const r of edges[1]) if (r > 0) outer.push([vertex(r, L), L + r]);
  for (let k = edges[2].length - 1; k >= 0; k--) { const c = edges[2][k]; if (c < L) outer.push([vertex(L, c), 3 * L - c]); }
  for (let k = edges[3].length - 1; k >= 0; k--) { const r = edges[3][k]; if (r < L) outer.push([vertex(r, 0), 4 * L - r]); }
  for (let c = s; c <= L - s; c += s) inner.push([vertex(s, c), c]);
  for (let r = 2 * s; r <= L - s; r += s) inner.push([vertex(r, L - s), L + r]);
  for (let c = L - 2 * s; c >= s; c -= s) inner.push([vertex(L - s, c), 3 * L - c]);
  for (let r = L - 2 * s; r >= 2 * s; r -= s) inner.push([vertex(r, s), 4 * L - r]);
  inner.push([inner[0][0], 4 * L + s]);
  let a = 0, b = 0;
  while (a + 1 < outer.length || b + 1 < inner.length) {
    const outerNext = b + 1 === inner.length || (a + 1 < outer.length && outer[a + 1][1] <= inner[b + 1][1]);
    if (outerNext) { indices.push(outer[a][0], outer[a + 1][0], inner[b][0]); a++; }
    else { indices.push(outer[a][0], inner[b + 1][0], inner[b][0]); b++; }
  }
  return { n, row, col, indices };
}

const postsOf = (n, count) => { const out = [], stride = (n - 1) / (count - 1); for (let k = 0; k < n; k += stride) out.push(k); return out; };

/** The topology part of a QM (u/v zigzag, padding, triangle count, index codes, edge lists) from a descriptor. */
export function topology({ n, cand, counts }) {
  const edges = counts.map((c) => postsOf(n, c));
  const m = edgeMatchedMesh(n, cand, edges);
  const nv = m.row.length;
  const remap = new Int32Array(nv).fill(-1);
  let next = 0;
  for (const i of m.indices) if (remap[i] < 0) remap[i] = next++;
  if (next !== nv) throw new Error("unreferenced vertex");
  const qu = new Uint16Array(nv), qv = new Uint16Array(nv);
  for (let i = 0; i < nv; i++) {
    qu[remap[i]] = Math.floor((32767 * m.col[i]) / (n - 1));
    qv[remap[i]] = Math.floor((32767 * m.row[i]) / (n - 1));
  }
  return { nv, qu, qv, indices: m.indices.map((i) => remap[i]) };
}

/** Rebuild the exact QM bytes from header, descriptor, the zigzag heights bytes and the extensions. */
export function rebuildQM(header, desc, hBytes, extBytes) {
  const t = topology(desc);
  const nv = t.nv, wide = nv > 65536, isz = wide ? 4 : 2;
  const parts = [];
  const head = Buffer.alloc(92); Buffer.from(header).copy(head, 0); head.writeUInt32LE(nv, 88); parts.push(head);
  const uv = Buffer.alloc(4 * nv);
  let pu = 0, pv = 0;
  for (let i = 0; i < nv; i++) { uv.writeUInt16LE(zz(t.qu[i] - pu), 2 * i); pu = t.qu[i]; uv.writeUInt16LE(zz(t.qv[i] - pv), 2 * (nv + i)); pv = t.qv[i]; }
  parts.push(uv, Buffer.from(hBytes));
  let len = 92 + 6 * nv;
  const pad = wide ? (4 - (len % 4)) % 4 : len % 2;
  parts.push(Buffer.alloc(pad)); len += pad;
  const ib = Buffer.alloc(4 + t.indices.length * isz);
  ib.writeUInt32LE(t.indices.length / 3, 0);
  let highest = 0;
  for (let k = 0; k < t.indices.length; k++) {
    const code = highest - t.indices[k];
    if (wide) ib.writeUInt32LE(code >>> 0, 4 + 4 * k); else ib.writeUInt16LE(code & 0xffff, 4 + 2 * k);
    if (code === 0) highest++;
  }
  parts.push(ib);
  const tests = [(u, v) => u === 0, (u, v) => v === 0, (u, v) => u === 32767, (u, v) => v === 32767];
  for (let k = 0; k < 4; k++) {
    const e = [];
    for (let i = 0; i < nv; i++) if (tests[k](t.qu[i], t.qv[i])) e.push(i);
    const eb = Buffer.alloc(4 + e.length * isz); eb.writeUInt32LE(e.length, 0);
    e.forEach((x, i) => (wide ? eb.writeUInt32LE(x, 4 + 4 * i) : eb.writeUInt16LE(x, 4 + 2 * i)));
    parts.push(eb);
  }
  parts.push(Buffer.from(extBytes));
  return Buffer.concat(parts);
}

export function decodeEdgeMatchedPlanes(payload) {
  const b = Buffer.from(payload);
  if (b.length < 104) throw new Error("truncated edge-matched planes header");
  const n = b.readUInt16LE(88), cand = b.readUInt16LE(90);
  const counts = [0, 1, 2, 3].map((i) => b.readUInt16LE(92 + 2 * i));
  const nv = b.readUInt32LE(100);
  if (n < 4 || n > 4097 || cand < 4 || cand > n || (n - 1) % (cand - 1) ||
      counts.some((c) => c < 2 || c > n || (n - 1) % (c - 1)) ||
      nv > 1024 * 1024 || nv !== (cand - 2) ** 2 + counts.reduce((a, c) => a + c, 0) - 4 || 104 + 2 * nv > b.length)
    throw new Error("invalid edge-matched planes descriptor");
  const interleave = (data) => {
    const out = Buffer.alloc(data.length), count = data.length / 2;
    for (let i = 0; i < count; i++) { out[2 * i] = data[i]; out[2 * i + 1] = data[count + i]; }
    return out;
  };
  const extensions = [];
  for (let at = 104 + 2 * nv; at < b.length;) {
    if (b.length - at < 5) throw new Error("truncated edge-matched extension");
    const id = b[at], size = b.readUInt32LE(at + 1);
    if (size > b.length - at - 5 || (id === 1 && size !== 2 * nv))
      throw new Error("invalid edge-matched extension size");
    const data = b.subarray(at + 5, at + 5 + size);
    extensions.push(b.subarray(at, at + 5), id === 1 ? interleave(data) : data);
    at += 5 + size;
  }
  return rebuildQM(b.subarray(0, 88), { n, cand, counts },
    interleave(b.subarray(104, 104 + 2 * nv)), Buffer.concat(extensions));
}
