// Association metadata only. Dates and identifiers never supply orbital states.
export const MAX_CROSSWALK_BYTES = 8 * 1024 * 1024;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
export function numericId(value) {
  if (!/^\d{1,20}$/.test(value) || /^0+$/.test(value)) throw new Error('Expected a positive decimal provider ID.');
  return value.replace(/^0+/, '');
}
export const identityKey = ({ provider, nativeId }) => JSON.stringify([provider, nativeId]);
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}
function detectionDate(value, line) {
  if (!/^\d{8}$/.test(value)) throw new Error(`Invalid datefirst date at line ${line}.`);
  // An explicitly unknown date is absent; it is never epoch zero.
  if (value === '00000000') return undefined;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== iso) throw new Error(`Invalid datefirst date at line ${line}.`);
  return iso;
}

/** Preserve every declaration, including duplicate rows and leading-zero aliases. */
export async function parseDatefirst(bytes, { leftProvider = 'vimpel', rightProvider = 'space-track', recordId, source = 'datefirst' } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_CROSSWALK_BYTES) throw new Error('datefirst must contain 1 byte to 8 MiB.');
  if (![leftProvider, rightProvider, source].every(identifier) || leftProvider === rightProvider || !identifier(recordId)) throw new Error('Specify distinct providers and an immutable crosswalk edition.');
  const digest = await sha256(bytes), lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').split(/\r?\n/);
  const edges = [], seen = new Map(); let header = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line) continue;
    if (!header) {
      if (line.split(/\s+/).join(' ') !== 'Nvym t_det_v Nnor t_det_n') throw new Error('Expected datefirst header: Nvym t_det_v Nnor t_det_n.');
      header = true; continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length !== 4 || edges.length >= 100000) throw new Error(`Invalid or excessive datefirst rows at line ${i + 1}.`);
    const [v, vd, n, nd] = fields;
    const left = { provider: leftProvider, nativeId: numericId(v), originalNativeId: v }, right = { provider: rightProvider, nativeId: numericId(n), originalNativeId: n };
    const key = JSON.stringify([identityKey(left), identityKey(right)]);
    const edge = { left, right, evidence: { source, recordId, sha256: digest, line: i + 1, original: lines[i] }, status: 'proposed' };
    try { edge.evidence.leftDetectionDate = detectionDate(vd, i + 1); edge.evidence.rightDetectionDate = detectionDate(nd, i + 1); }
    catch (error) { edge.status = 'invalid'; edge.reason = error.message; }
    if (seen.has(key)) { if (edge.status === 'proposed') edge.status = 'duplicate'; edge.duplicateOf = seen.get(key); }
    else seen.set(key, i + 1);
    edges.push(edge);
  }
  if (!header || !edges.length) throw new Error('datefirst contains no associations.');
  const partners = new Map();
  for (const edge of edges) for (const [a, b] of [[edge.left, edge.right], [edge.right, edge.left]]) {
    const key = identityKey(a); if (!partners.has(key)) partners.set(key, new Set()); partners.get(key).add(identityKey(b));
  }
  for (const edge of edges) if (edge.status !== 'invalid' && (partners.get(identityKey(edge.left)).size > 1 || partners.get(identityKey(edge.right)).size > 1)) edge.status = 'conflicting';
  return { version: 1, format: 'datefirst', recordId, sha256: digest, bytes: bytes.length, edges };
}

/** Select attributed candidates only when both immutable source products exist. */
export function crosswalkCandidates(crosswalk, products) {
  const byIdentity = new Map(), productIds = new Set();
  for (const p of products) {
    if (![p.provider, p.nativeId, p.id, p.recordId].every(identifier)) throw new Error('Every product needs provider, native ID, candidate ID and immutable record ID.');
    if (productIds.has(p.id)) throw new Error('Product candidate IDs must be unique.');
    productIds.add(p.id);
    const key = identityKey({ provider: p.provider, nativeId: numericId(p.nativeId) });
    if (byIdentity.has(key)) throw new Error('Choose one product edition per native object.');
    byIdentity.set(key, { ...p, originalNativeId:p.nativeId, nativeId:numericId(p.nativeId) });
  }
  const candidates = new Map(), pairs = [], unresolved = [];
  for (const edge of crosswalk.edges) {
    const left = byIdentity.get(identityKey(edge.left)), right = byIdentity.get(identityKey(edge.right));
    if (edge.status !== 'proposed' || !left || !right) { unresolved.push({ ...edge, reason: edge.status === 'proposed' ? 'missing-state-product' : edge.status }); continue; }
    candidates.set(left.id, left); candidates.set(right.id, right);
    pairs.push({ left: left.id, right: right.id, evidence: edge.evidence });
  }
  if (candidates.size > 64 || pairs.length > 4096) throw new Error('Split this crosswalk into batches of at most 64 candidates and 4,096 pairs.');
  return { candidates: [...candidates.values()], pairs, unresolved };
}
