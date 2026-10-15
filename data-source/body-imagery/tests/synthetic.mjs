// Synthetic global GeoTIFFs for the body-imagery tests: each pixel a known
// function of IAU planetocentric longitude and latitude (test-only).
export const TITAN = { naif: 606, url: "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Titan_ISS_P19658_Mosaic_Global_4km.tif", a: 2575.15, c: 2574.47, meridian: 180 };
export const CERES = { naif: 2000001, url: "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif", a: 487.3, c: 446.0, meridian: 0 };
export const W = 2048, H = 1024;
export const DEG = Math.PI / 180;
// The source pixel at planetocentric (lon, lat), degrees east and north.
export const truth = (lon, lat) => Math.round(128 + 90 * Math.sin(2 * lon * DEG) * Math.cos(lat * DEG) + 30 * Math.sin(3 * lat * DEG));

// TIFF LZW, MSB-first, early change (the decoder's counterpart, test-only).
function lzw(bytes) {
  const out = [];
  let acc = 0, bits = 0;
  const put = (code, width) => { acc = (acc << width) | code; bits += width; while (bits >= 8) { out.push((acc >>> (bits - 8)) & 0xff); bits -= 8; } acc &= (1 << bits) - 1; };
  let dict = new Map(), next = 258, width = 9;
  const reset = () => { dict = new Map(); for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i); next = 258; width = 9; };
  reset();
  put(256, width);
  let w = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b), wc = w + c;
    if (dict.has(wc)) { w = wc; continue; }
    put(dict.get(w), width);
    dict.set(wc, next++);
    // libtiff's LZWEncode: a clear code when the table is full, else one
    // more bit once the next code no longer fits.
    if (next === 4094) { put(256, width); reset(); }
    else if (next > (1 << width) - 1 && width < 12) width++;
    w = c;
  }
  if (w) put(dict.get(w), width);
  put(257, width);
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Buffer.from(out);
}

// A little-endian classic GeoTIFF: grey, 8-bit, equirectangular in metres on a
// sphere of radius a, x from the central meridian.
export function geotiff(body, { tiled }) {
  const pixels = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let lon = body.meridian - 180 + (x + 0.5) * 360 / W;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    pixels[y * W + x] = truth(lon, 90 - (y + 0.5) * 180 / H);
  }
  const segments = [];
  if (tiled) {
    const T = 256;
    for (let ty = 0; ty < H / T; ty++) for (let tx = 0; tx < W / T; tx++) {
      const tile = Buffer.alloc(T * T);
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) tile[y * T + x] = pixels[(ty * T + y) * W + tx * T + x];
      for (let y = 0; y < T; y++) for (let x = T - 1; x > 0; x--) tile[y * T + x] = (tile[y * T + x] - tile[y * T + x - 1]) & 0xff;  // predictor 2
      segments.push(lzw(tile));
    }
  } else {
    for (let y = 0; y < H; y++) segments.push(pixels.subarray(y * W, (y + 1) * W));
  }
  const r = body.a * 1000, sx = 2 * Math.PI * r / W, sy = Math.PI * r / H;
  const tags = [];
  const tag = (id, type, values) => tags.push({ id, type, values });
  tag(256, 4, [W]); tag(257, 4, [H]); tag(258, 3, [8]); tag(259, 3, [tiled ? 5 : 1]); tag(262, 3, [1]); tag(277, 3, [1]); tag(284, 3, [1]);
  if (tiled) { tag(317, 3, [2]); tag(322, 3, [256]); tag(323, 3, [256]); tag(324, 4, segments.map(() => 0)); tag(325, 4, segments.map((s) => s.length)); }
  else { tag(278, 4, [1]); tag(273, 4, segments.map(() => 0)); tag(279, 4, segments.map((s) => s.length)); }
  tag(33550, 12, [sx, sy, 0]);
  tag(33922, 12, [0, 0, 0, -Math.PI * r, Math.PI / 2 * r, 0]);
  tag(34735, 3, [1, 1, 0, 3, 1024, 0, 1, 1, 2057, 34736, 1, 0, 3088, 34736, 1, 1]);
  tag(34736, 12, [r, body.meridian]);
  tags.sort((a, b) => a.id - b.id);
  const size = { 3: 2, 4: 4, 12: 8 };
  // Layout: header, directory, out-of-line values, then the image data.
  const dirAt = 8, dirLen = 2 + 12 * tags.length + 4;
  let at = dirAt + dirLen;
  const extra = [];
  for (const t of tags) { const len = t.values.length * size[t.type]; t.inline = len <= 4; if (!t.inline) { t.offset = at; at += len; } }
  let dataAt = at;
  const offsets = segments.map((s) => { const o = dataAt; dataAt += s.length; return o; });
  for (const t of tags) if (t.id === 273 || t.id === 324) t.values = offsets;
  const buf = Buffer.alloc(dataAt);
  buf.write("II", 0); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(dirAt, 4);
  buf.writeUInt16LE(tags.length, dirAt);
  const writeValues = (t, pos) => t.values.forEach((v, i) => { if (t.type === 3) buf.writeUInt16LE(v, pos + 2 * i); else if (t.type === 4) buf.writeUInt32LE(v, pos + 4 * i); else buf.writeDoubleLE(v, pos + 8 * i); });
  tags.forEach((t, i) => {
    const e = dirAt + 2 + 12 * i;
    buf.writeUInt16LE(t.id, e); buf.writeUInt16LE(t.type, e + 2); buf.writeUInt32LE(t.values.length, e + 4);
    if (t.inline) writeValues(t, e + 8); else { buf.writeUInt32LE(t.offset, e + 8); writeValues(t, t.offset); }
  });
  segments.forEach((s, i) => s.copy(buf, offsets[i]));
  void extra;
  return buf;
}

