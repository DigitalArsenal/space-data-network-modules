// Fixture policy for tests/cislunar-sources.e2e.mjs. Every response is a real
// fetch; trimming only removes whole listing lines or whole SPK segments
// (records copied unchanged, CSPICE spksub semantics at segment granularity).
import assert from "node:assert/strict";
import crypto from "node:crypto";

export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export const LRO_DIR = "https://naif.jpl.nasa.gov/pub/naif/pds/data/lro-l-spice-6-v1.0/lrosp_1000/data/spk/";
export const LADEE_DIR = "https://naif.jpl.nasa.gov/pub/naif/pds/pds4/ladee/ladee_spice/spice_kernels/spk/";
export const LISTING_URL = "https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND=%27MB%27";

// Listing rows kept: discovery candidates of every admission outcome, notables
// (never probed) and excluded entries (simulation, NEOCP).
export const LISTING_IDS = [-2, -85, -152, -169, -231, -240, -1176, -78000, -125544, -9901492, -998, -937016];

// Kernels: [file-name suffix, which whole segments to keep].
export const KERNEL_TRIM = {
  "lrorg_": (n) => [n - 2, n - 1],                  // the newest two daily LRO segments
  "ladee_r_13250_13279_pha": (n) => [n - 1],        // the last Earth-centered phasing segment
  "ladee_r_13278_13325_loa": () => [10, 11],        // two Moon-centered segments after LOI-2 (2013-10-09)
};

export function trimListing(text) {
  const lines = text.split("\n");
  const ruler = lines.findIndex((l) => /^\s+-{7}\s+-{10}/.test(l));
  assert.ok(ruler > 0, "listing ruler");
  const keep = lines.filter((line, i) => {
    if (i <= ruler) return true;
    const id = Number(line.slice(0, 9).trim());
    return /^\s*$/.test(line) || /Number of matches|\*{10}/.test(line) ? true : LISTING_IDS.includes(id);
  });
  // Horizons repeats one row in its footer; keep one copy of each id.
  const seen = new Set();
  return keep.filter((line, i) => {
    if (i <= ruler) return true;
    const id = Number(line.slice(0, 9).trim());
    if (!Number.isInteger(id) || !line.trim() || !LISTING_IDS.includes(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id); return true;
  }).join("\n");
}

// Keep whole segments of a DAF/SPK (either byte order, kept as found), rewriting only the file
// record pointers, one summary record, one name record and segment addresses.
export function trimSpk(bytes, pick) {
  const b = Buffer.from(bytes);
  assert.equal(b.subarray(0, 8).toString(), "DAF/SPK ");
  const fmt = b.subarray(88, 96).toString();
  assert.ok(fmt === "LTL-IEEE" || fmt === "BIG-IEEE", fmt);
  const le = fmt === "LTL-IEEE";
  const I = (buf, at) => le ? buf.readInt32LE(at) : buf.readInt32BE(at);
  const D = (buf, at) => le ? buf.readDoubleLE(at) : buf.readDoubleBE(at);
  const wI = (buf, v, at) => le ? buf.writeInt32LE(v, at) : buf.writeInt32BE(v, at);
  const wD = (buf, v, at) => le ? buf.writeDoubleLE(v, at) : buf.writeDoubleBE(v, at);
  const nd = I(b, 8), ni = I(b, 12), fward = I(b, 76);
  assert.equal(nd, 2); assert.equal(ni, 6);
  const ss = nd + Math.ceil(ni / 2), word = (address) => (address - 1) * 8;
  const segments = [];
  for (let rec = fward; rec;) {
    const at = (rec - 1) * 1024;
    const next = D(b, at), count = D(b, at + 16);
    for (let i = 0; i < count; i++) {
      const s = at + 24 + i * ss * 8, ic = [];
      for (let k = 0; k < 6; k++) ic.push(I(b, s + 16 + k * 4));
      const name = b.subarray(at + 1024 + i * ss * 8, at + 1024 + (i + 1) * ss * 8);
      segments.push({ dc: [D(b, s), D(b, s + 8)], ic, name });
    }
    rec = next;
  }
  const kept = pick(segments.length).map((i) => segments[i]);
  assert.ok(kept.length && kept.length * ss <= 125, "one summary record");
  const out = [];
  const file = Buffer.from(b.subarray(0, 1024));
  wI(file, 2, 76); wI(file, 2, 80); // FWARD = BWARD = record 2; comments dropped
  const summary = Buffer.alloc(1024), names = Buffer.alloc(1024, 0x20);
  wD(summary, 0, 0); wD(summary, 0, 8); wD(summary, kept.length, 16);
  let free = 3 * 128 + 1; // data begins at record 4
  const data = [];
  kept.forEach((seg, i) => {
    const words = b.subarray(word(seg.ic[4]), word(seg.ic[5]) + 8);
    const s = 24 + i * ss * 8;
    wD(summary, seg.dc[0], s); wD(summary, seg.dc[1], s + 8);
    const ic = [...seg.ic.slice(0, 4), free, free + words.length / 8 - 1];
    ic.forEach((v, k) => wI(summary, v, s + 16 + k * 4));
    seg.name.copy(names, i * ss * 8);
    data.push(words); free += words.length / 8;
  });
  wI(file, free, 84);
  out.push(file, summary, names, ...data);
  const total = Buffer.concat(out);
  const pad = (1024 - (total.length % 1024)) % 1024;
  return { bytes: Buffer.concat([total, Buffer.alloc(pad)]), segments: segments.length,
    kept: kept.map((s) => ({ target: s.ic[0], center: s.ic[1], type: s.ic[3], start_et: s.dc[0], stop_et: s.dc[1] })) };
}
