// Versioned human decisions. Association review never rewrites provider records.
import { identityKey, sha256 } from './crosswalk.js';
const encode = value => new TextEncoder().encode(JSON.stringify(value));
export async function sealReview(recipe, report, execution = {}) {
  const value = { version: 1, recipe: structuredClone(recipe), report: structuredClone(report), execution: structuredClone(execution) };
  return { ...value, sha256: await sha256(encode(value)) };
}
export async function verifyReview(review) {
  const { sha256: digest, ...value } = review;
  if (await sha256(encode(value)) !== digest) throw new Error('The review changed since its trajectory check.');
  return review;
}
export function validateDecisions(decisions) {
  if (!Array.isArray(decisions) || decisions.length > 256 || encode(decisions).length > 768 * 1024) throw new Error('Keep at most 256 review decisions and 768 KiB per recipe; export an archive before continuing.');
  const ids = new Set();
  for (const d of decisions) {
    if (!['accepted', 'rejected', 'revoked'].includes(d.status) || !/^[a-f0-9]{64}$/.test(d.reviewSha256) || !d.left?.provider || !d.left?.nativeId || !d.right?.provider || !d.right?.nativeId || !d.reason?.trim() || !Number.isFinite(Date.parse(d.reviewedAt)) || ids.has(d.id)) throw new Error('Invalid identity review history.');
    if(d.status==='accepted' && d.diagnostics?.status!=='compatible') throw new Error('An accepted decision needs compatible diagnostics.');
    ids.add(d.id);
  }
  return decisions;
}
export function activeBindings(decisions = []) {
  validateDecisions(decisions);
  const latest = new Map();
  for (const d of decisions) latest.set([identityKey(d.left), identityKey(d.right)].sort().join('|'), d);
  const bindings=[...latest.values()].filter(d => d.status === 'accepted'),checked=[];
  for(const d of bindings){assertNoConflict(checked,d.left,d.right);checked.push(d);}
  return bindings;
}
function assertNoConflict(bindings, left, right) {
  // Connected components must contain at most one native object per provider.
  // This catches transitive contradictions (A1-B1-C1-A2) as well as direct ones.
  const graph = new Map();
  for (const d of [...bindings, { left, right }]) {
    for (const [a, b] of [[d.left,d.right],[d.right,d.left]]) {
      const key = identityKey(a); if (!graph.has(key)) graph.set(key, { identity: a, peers: new Set() });
      graph.get(key).peers.add(identityKey(b));
    }
  }
  const todo = [identityKey(left)], visited = new Set(), providers = new Map();
  while (todo.length) {
    const key = todo.pop(); if (visited.has(key)) continue; visited.add(key);
    const { identity, peers } = graph.get(key);
    if (providers.has(identity.provider) && providers.get(identity.provider) !== identity.nativeId) throw new Error('This association conflicts with an accepted identity. Revoke the earlier decision before accepting another.');
    providers.set(identity.provider, identity.nativeId); todo.push(...peers);
  }
}
export async function recordDecision(decisions, review, index, status, reason, reviewedAt = new Date().toISOString()) {
  validateDecisions(decisions); await verifyReview(review);
  if (!['accepted','rejected','revoked'].includes(status) || !reason?.trim() || reason.length > 2048) throw new Error('Provide an explicit review decision and reason.');
  const match = review.report.matches[index];
  if (!match) throw new Error('Choose a checked pair.');
  const left = review.recipe.candidates.find(c => c.id === match.left), right = review.recipe.candidates.find(c => c.id === match.right);
  if (!left || !right || left.provider === right.provider) throw new Error('The review has no distinct provider pair.');
  if (status === 'accepted') {
    if (match.status !== 'compatible') throw new Error('Only a compatible, unambiguous match can be accepted.');
    assertNoConflict(activeBindings(decisions), left, right);
  }
  const decision = { id: crypto.randomUUID(), status, reviewedAt, reason: reason.trim(), reviewSha256: review.sha256,
    left: structuredClone(left), right: structuredClone(right), policy: structuredClone(review.report.policy),
    evidence: structuredClone(match.evidence), diagnostics: structuredClone(match), execution: structuredClone(review.execution) };
  return validateDecisions([...decisions, decision]);
}
