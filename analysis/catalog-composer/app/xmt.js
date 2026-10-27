// The editor's side of the module's $XMT ports: its saved recipe (the editor's own document) becomes an $XMT
// COMPOSE_RECIPE or MATCH_REQUEST at the call, and the module's $XMT reports become the rows the editor renders.
// Nothing here decides anything; the module does.
import { Builder, ByteBuffer } from 'flatbuffers';
import * as x from '../dist/sds/xmt.mjs';

const table = (Type, fields) => Object.assign(new Type(), fields);
export const XMT_TYPE = Object.freeze({ schemaName: 'XMT.fbs', fileIdentifier: '$XMT', rootTypeName: 'XMT', wireFormat: 'flatbuffer' });
const ms = (seconds) => BigInt(Math.round(seconds * 1000));
const seconds = (millis) => Number(millis) / 1000;

export function encodeXmt(fields) {
  const b = new Builder(4096);
  b.finishSizePrefixed(table(x.XMTT, fields).pack(b), '$XMT');
  return new Uint8Array(b.asUint8Array());
}
export function decodeXmt(bytes) {
  // Generated FlatBuffers strings use TextDecoder, which rejects shared views.
  // Own the response bytes before decoding an external guest arena.
  const view = new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return x.XMT.getSizePrefixedRootAsXMT(new ByteBuffer(view)).unpack();
}

// One binary search document per composed object. No text or JSON record is
// passed into FlatSQL; nested strings are indexed from the canonical schema.
export function* compositionSearchRecords(bytes) {
  const report = decodeXmt(bytes).COMPOSE_REPORT;
  if (!report) throw new Error('A composition report is required for search');
  for (let index = 0; index < report.OBJECTS.length; index++) {
    const object = report.OBJECTS[index];
    yield { index, source: object.STATE?.STATUS === x.xmtStateChoice.Overlap ? 'overlap' : 'catalog',
      bytes: encodeXmt({ COMPOSE_REPORT: table(x.XMTComposeReportT, { OBJECT_COUNT: 1, OBJECTS: [object] }) }) };
  }
}

// The editor's recipe (version 1: NORAD first; version 2: international designators) and the coverage each state
// source declares, as a COMPOSE_RECIPE.
export function composeRecipe(recipe, coverage = []) {
  return encodeXmt({ COMPOSE_RECIPE: table(x.XMTComposeRecipeT, {
    IDENTITY_RULE: recipe.version === 2 ? x.xmtIdentityRule.InternationalDesignator : x.xmtIdentityRule.NoradFirst,
    AS_OF_MS: ms(recipe.asOf),
    MAX_AGE_S: recipe.version === 2 || recipe.maxAgeSeconds == null ? Infinity : recipe.maxAgeSeconds,
    LAYERS: recipe.layers.map((l) => table(x.XMTLayerT, { ID: l.id, NODE: l.node, PROVIDER: l.provider, SOURCE: l.source, HEAD: l.head, NATIVE_KEYS: l.nativeKeys ?? [] })),
    STATE_SOURCES: recipe.stateSources ?? [],
    OVERRIDES: Object.entries(recipe.overrides ?? {}).map(([key, o]) => table(x.XMTObjectOverrideT, {
      OBJECT_KEY: key, CATALOG_LAYER: o.catalogLayer ?? null, STATE_SOURCES: o.stateSources ?? [], MAX_AGE_S: o.maxAgeSeconds ?? NaN })),
    STATE_CANDIDATES: (recipe.stateCandidates ?? []).map((s) => table(x.XMTStateCandidateT, { OBJECT_KEY: s.objectKey, SOURCE_ID: s.sourceId, RECORD_ID: s.recordId, EPOCH_MS: ms(s.epoch) })),
    COVERAGE: coverage.map((c) => table(x.XMTSourceCoverageT, { SOURCE_ID: c.sourceId, HEAD: c.head, OBJECTS: c.objects })),
  }) });
}

const RECORD = { [x.xmtRecordChoice.Selected]: 'selected', [x.xmtRecordChoice.IdentityConflict]: 'identity-conflict', [x.xmtRecordChoice.MissingDesignator]: 'missing-designator' };
const STATE = Object.fromEntries(Object.entries(x.xmtStateChoice).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k.toLowerCase()]));
// The rows the editor lists, from a COMPOSE_REPORT.
export function composeView(bytes) {
  const r = decodeXmt(bytes).COMPOSE_REPORT;
  if (!r) throw new Error('The module answered without a composition report.');
  return {
    inputRecords: r.INPUT_RECORDS, objectCount: r.OBJECT_COUNT, identityConflicts: r.IDENTITY_CONFLICTS,
    objects: r.OBJECTS.map((o) => ({
      key: o.KEY, internationalDesignator: o.INTERNATIONAL_DESIGNATOR, name: o.NAME, selectedLayer: o.SELECTED_LAYER, status: RECORD[o.STATUS],
      candidates: o.CANDIDATES.map((c) => ({ layer: c.LAYER, record: c.ORDINAL, nativeKey: c.NATIVE_KEY, name: c.NAME, designator: c.DESIGNATOR })),
      state: o.STATE && { status: STATE[o.STATE.STATUS], sourceId: o.STATE.SOURCE_ID ?? '', recordId: o.STATE.RECORD_ID ?? '', epoch: o.STATE.EPOCH_MS ? seconds(o.STATE.EPOCH_MS) : undefined, sources: o.STATE.SOURCES },
    })),
  };
}

const evidence = (e = {}) => table(x.OILEvidenceT, { SOURCE: e.source ?? null, RECORD_ID: e.recordId ?? e.sha256 ?? null, LINE: e.line ?? 0, ORIGINAL: e.original ?? e.note ?? null });
// The editor's match recipe (candidates, pairs, the four thresholds) as a MATCH_REQUEST.
export function matchRequest(recipe) {
  return encodeXmt({ MATCH_REQUEST: table(x.XMTMatchRequestT, {
    POLICY: table(x.XMTMatchPolicyT, { POSITION_TOLERANCE_KM: recipe.positionToleranceKm, VELOCITY_TOLERANCE_KM_S: recipe.velocityToleranceKmS,
      FINITE_DIFFERENCE_TOLERANCE_KM_S: recipe.finiteDifferenceToleranceKmS, MINIMUM_SPAN_S: recipe.minimumSpanSeconds }),
    TRAJECTORIES: recipe.candidates.map((c) => table(x.XMTTrajectoryT, { ID: c.id, PROVIDER: c.provider, NATIVE_ID: c.nativeId, RECORD_ID: c.recordId })),
    PAIRS: recipe.pairs.map((p) => table(x.OILLinkT, { LEFT: table(x.OILIdentifierT, { TRAJECTORY_ID: p.left }), RIGHT: table(x.OILIdentifierT, { TRAJECTORY_ID: p.right }),
      STATUS: x.oilLinkStatus.Proposed, EVIDENCE: evidence(p.evidence) })),
  }) });
}
const VERDICT = { [x.xmtPairVerdict.Compatible]: 'compatible', [x.xmtPairVerdict.Ambiguous]: 'ambiguous', [x.xmtPairVerdict.Rejected]: 'rejected', [x.xmtPairVerdict.Insufficient]: 'insufficient' };
// The rows the review shows, from a MATCH_REPORT; the evidence is the recipe's own (pairs in request order).
export function matchView(bytes, recipe) {
  const r = decodeXmt(bytes).MATCH_REPORT;
  if (!r) throw new Error('The module answered without a match report.');
  const p = r.POLICY;
  return {
    policy: { positionToleranceKm: p.POSITION_TOLERANCE_KM, velocityToleranceKmS: p.VELOCITY_TOLERANCE_KM_S, finiteDifferenceToleranceKmS: p.FINITE_DIFFERENCE_TOLERANCE_KM_S, minimumSpanSeconds: p.MINIMUM_SPAN_S },
    matches: r.PAIRS.map((m, i) => ({
      left: m.LINK?.LEFT?.TRAJECTORY_ID, right: m.LINK?.RIGHT?.TRAJECTORY_ID, evidence: recipe?.pairs?.[i]?.evidence, status: VERDICT[m.VERDICT], reason: m.REASON,
      ...(m.SAMPLES ? { maximumPositionResidualKm: m.MAX_POSITION_RESIDUAL_KM, maximumVelocityResidualKmS: m.MAX_VELOCITY_RESIDUAL_KM_S,
        leftFiniteDifferenceResidualKmS: m.LEFT_FINITE_DIFFERENCE_RESIDUAL_KM_S, rightFiniteDifferenceResidualKmS: m.RIGHT_FINITE_DIFFERENCE_RESIDUAL_KM_S, samples: m.SAMPLES, spanSeconds: m.SPAN_S } : {}),
    })),
  };
}
