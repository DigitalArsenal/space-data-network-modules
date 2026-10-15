// The screening work products as $SCR records (spacedatastandards.org SCR):
// the frames the host passes between coarse_grid / search_candidates /
// search_grid, a GPU screener and refine_candidates. Encoding and decoding
// only; no physics.
import * as flatbuffers from 'flatbuffers';
import {
  SCR, SCRBlock, SCRCandidates, SCRExclusion, SCRExclusions, SCRGrid, SCRRoles,
} from '../src/js/sds/SCR.mjs';

const finish = (b, build) => {
  const arm = build();
  SCR.startSCR(b);
  arm(b);
  b.finish(SCR.endSCR(b), '$SCR');
  return b.asUint8Array().slice();
};

const root = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bb = new flatbuffers.ByteBuffer(u8);
  if (!SCR.bufferHasIdentifier(bb)) throw new Error('Not a $SCR record.');
  return { scr: SCR.getRootAsSCR(bb), bb, u8 };
};

// A struct vector's first byte in the buffer (null when absent).
const structVector = (table, slot) => {
  const o = table.bb.__offset(table.bb_pos, slot);
  if (!o) return null;
  return { start: table.bb.__vector(table.bb_pos + o), length: table.bb.__vector_len(table.bb_pos + o) };
};

/** $SCR BLOCK of the window's coarse steps [firstStep, firstStep + stepCount). */
export function blockFrame(firstStep, stepCount) {
  const b = new flatbuffers.Builder(64);
  return finish(b, () => {
    const block = SCRBlock.createSCRBlock(b, firstStep, stepCount);
    return (x) => SCR.addBlock(x, block);
  });
}

/** $SCR EXCLUSIONS from index -> first failing JD (the reason is the module's own). */
export function excludedFrame(excluded) {
  const b = new flatbuffers.Builder(64 + excluded.size * 24);
  return finish(b, () => {
    const rows = [...excluded].map(([index, jd]) => {
      SCRExclusion.startSCRExclusion(b);
      SCRExclusion.addIndex(b, index);
      SCRExclusion.addFirstFailureJd(b, jd);
      return SCRExclusion.endSCRExclusion(b);
    });
    const v = SCRExclusions.createExclusionsVector(b, rows);
    const x = SCRExclusions.createSCRExclusions(b, v);
    return (r) => SCR.addExclusions(r, x);
  });
}

/** $SCR CANDIDATES from (obj1, obj2, step) triples [from, to). */
export function candidatesFrame(triples, from = 0, to = triples.length) {
  const count = (to - from) / 3;
  const b = new flatbuffers.Builder(64 + count * 12);
  return finish(b, () => {
    SCRCandidates.startPairsVector(b, count);
    for (let q = to - 3; q >= from; q -= 3) {   // vectors are written back to front
      b.prep(4, 12);
      b.writeInt32(triples[q + 2]);
      b.writeInt32(triples[q + 1]);
      b.writeInt32(triples[q]);
    }
    const v = b.endVector();
    const c = SCRCandidates.createSCRCandidates(b, v);
    return (r) => SCR.addCandidates(r, c);
  });
}

/** $SCR ROLES, one role value per object (ROLE: 0 secondary, 1 primary, 2 skip). */
export function rolesFrame(roles) {
  const b = new flatbuffers.Builder(64 + roles.length);
  return finish(b, () => {
    const v = SCRRoles.createRolesVector(b, Array.from(roles));
    const x = SCRRoles.createSCRRoles(b, v);
    return (r) => SCR.addRoles(r, x);
  });
}

/** The candidate triples of a $SCR CANDIDATES, as a Uint32Array (obj1, obj2, step, ...). */
export function candidateTriples(bytes) {
  const { scr, u8 } = root(bytes);
  const c = scr.CANDIDATES();
  if (!c) throw new Error('Not a $SCR CANDIDATES record.');
  const v = structVector(c, 4);
  if (!v || v.length === 0) return new Uint32Array(0);
  const out = new Uint32Array(v.length * 3);
  new Uint8Array(out.buffer).set(u8.subarray(v.start, v.start + v.length * 12));
  return out;
}

/** A $SCR SEARCH_REPORT as { first_step, step_count, last_step, objects, excluded: [{index, first_failure_jd, reason}], primaries, secondaries, skipped, candidates }. */
export function searchReport(bytes) {
  const { scr } = root(bytes);
  const r = scr.SEARCH_REPORT();
  if (!r) throw new Error('Not a $SCR SEARCH_REPORT record.');
  const excluded = [];
  for (let i = 0; i < r.excludedLength(); i++) {
    const x = r.EXCLUDED(i);
    excluded.push({ index: x.INDEX(), first_failure_jd: x.FIRST_FAILURE_JD(), reason: x.REASON() ?? '' });
  }
  return { first_step: r.FIRST_STEP(), step_count: r.STEP_COUNT(), last_step: r.LAST_STEP(), objects: r.OBJECTS(), excluded,
    primaries: r.PRIMARIES(), secondaries: r.SECONDARIES(), skipped: r.SKIPPED(), candidates: r.CANDIDATE_COUNT() };
}

/**
 * A $SCR GRID: { firstStep, stepCount, objects, stepS, states, bands } with states and bands the
 * rows' bytes (8 f32 per step and object, step-major; 2 f32 per object), 4-byte aligned.
 */
export function gridOf(bytes) {
  const { scr, u8 } = root(bytes);
  const g = scr.GRID();
  if (!g) throw new Error('Not a $SCR GRID record.');
  const firstStep = g.FIRST_STEP(), stepCount = g.STEP_COUNT(), objects = g.OBJECTS();
  const s = structVector(g, 14), d = structVector(g, 16);
  if (!s || !d || s.length !== stepCount * objects || d.length !== objects) throw new Error('$SCR GRID rows do not match its header.');
  const aligned = (start, n) => {
    const view = u8.subarray(start, start + n);
    return view.byteOffset % 4 === 0 ? view : view.slice();
  };
  return { firstStep, stepCount, objects, stepS: g.STEP_S(), states: aligned(s.start, s.length * 32), bands: aligned(d.start, d.length * 8) };
}

/** A $SCR GRID record from rows (the layout gridOf returns). */
export function gridFrame({ firstStep, stepCount, objects, stepS = 0, states, bands }) {
  const b = new flatbuffers.Builder(256 + states.byteLength + bands.byteLength);
  const raw = (bytes, stride) => {
    const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    b.startVector(stride, bytes.byteLength / stride, 4);
    b.prep(4, bytes.byteLength);
    b.space -= bytes.byteLength;
    b.bb.bytes().set(u8, b.space);
    return b.endVector();
  };
  return finish(b, () => {
    const sv = raw(states, 32), bv = raw(bands, 8);
    const grid = SCRGrid.createSCRGrid(b, firstStep, stepCount, objects, 0, stepS, sv, bv);
    return (r) => SCR.addGrid(r, grid);
  });
}

/** The roles of a $SCR ROLES, as a Uint8Array (ROLE values). */
export function rolesOf(bytes) {
  const { scr } = root(bytes);
  const r = scr.ROLES();
  if (!r) throw new Error('Not a $SCR ROLES record.');
  return r.rolesArray()?.slice() ?? new Uint8Array(0);
}

/** A $SCR EXCLUSIONS as index -> first failing JD. */
export function exclusionsOf(bytes) {
  const { scr } = root(bytes);
  const x = scr.EXCLUSIONS();
  if (!x) throw new Error('Not a $SCR EXCLUSIONS record.');
  const out = new Map();
  for (let i = 0; i < x.exclusionsLength(); i++) out.set(x.EXCLUSIONS(i).INDEX(), x.EXCLUSIONS(i).FIRST_FAILURE_JD());
  return out;
}
