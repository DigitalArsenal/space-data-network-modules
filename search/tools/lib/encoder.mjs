/**
 * The student query encoder — REFERENCE IMPLEMENTATION.
 *
 * This is the exact arithmetic the WASM module must reproduce bit-for-bit:
 *
 *     encode(text) = L2normalise( Σ idf[t]·scale[t]·Wq[t] / Σ idf[t] )
 *
 * A gather, a weighted sum, a normalise. There is no runtime to load and no
 * session to create — which is the entire point, given the teacher's
 * session-create measurably froze a main thread for nine seconds.
 *
 * Keeping a JS reference alongside the WASM is not duplication: it is the
 * oracle the tri-runtime parity test compares against, in the same way the
 * module SDK's parity lanes work.
 */

/** Parse the .sdnemb container produced by distill-encoder.mjs. */
export function loadEncoder(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = String.fromCharCode(...u8.subarray(0, 8));
  if (magic !== "SDNEMB01") throw new Error(`bad magic ${JSON.stringify(magic)}`);
  const dim = dv.getUint32(8, true);
  const count = dv.getUint32(12, true);
  const vocabBytes = dv.getUint32(16, true);

  let off = 20;
  const vocabText = new TextDecoder().decode(u8.subarray(off, off + vocabBytes));
  off += vocabBytes;

  const idf = new Float32Array(u8.buffer.slice(u8.byteOffset + off, u8.byteOffset + off + count * 4));
  off += count * 4;
  const scale = new Float32Array(u8.buffer.slice(u8.byteOffset + off, u8.byteOffset + off + count * 4));
  off += count * 4;
  const weights = new Int8Array(u8.buffer, u8.byteOffset + off, count * dim);

  const vocab = new Map();
  vocabText.split("\n").forEach((w, i) => {
    if (w) vocab.set(w, i);
  });

  return { dim, count, vocab, idf, scale, weights };
}

/**
 * WordPiece tokenization to STUDENT slot indices.
 *
 * Note this returns slots in the pruned domain vocabulary, not BERT ids: the
 * student never sees the 27k tokens the catalogue does not use.
 */
export function tokenizeToSlots(text, vocab) {
  const clean = String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([\p{P}\p{S}])/gu, " $1 ")
    .trim();
  const slots = [];
  for (const word of clean.split(/\s+/)) {
    if (!word) continue;
    let start = 0;
    const sub = [];
    let ok = true;
    while (start < word.length) {
      let end = word.length;
      let found = -1;
      while (start < end) {
        const piece = (start > 0 ? "##" : "") + word.slice(start, end);
        const id = vocab.get(piece);
        if (id !== undefined) {
          found = id;
          break;
        }
        end -= 1;
      }
      if (found < 0) {
        ok = false;
        break;
      }
      sub.push(found);
      start = end;
    }
    // Out-of-domain words contribute nothing rather than a misleading [UNK]
    // vector — for a 3.5k-token domain vocabulary that is the honest choice.
    if (ok) slots.push(...sub);
  }
  return slots;
}

/** Encode text to a normalised vector in the teacher's space. */
export function encode(model, text, out = new Float32Array(model.dim)) {
  const { dim, idf, scale, weights } = model;
  out.fill(0);
  const slots = tokenizeToSlots(text, model.vocab);
  let wsum = 0;
  for (const s of slots) {
    const w = idf[s];
    const q = w * scale[s];
    wsum += w;
    const off = s * dim;
    for (let d = 0; d < dim; d += 1) out[d] += q * weights[off + d];
  }
  if (wsum > 0) for (let d = 0; d < dim; d += 1) out[d] /= wsum;
  let norm = 0;
  for (let d = 0; d < dim; d += 1) norm += out[d] * out[d];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let d = 0; d < dim; d += 1) out[d] /= norm;
  return out;
}
