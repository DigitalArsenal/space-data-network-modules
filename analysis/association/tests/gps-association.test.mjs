import assert from 'node:assert/strict';
import test from 'node:test';
import { associate } from './lib.mjs';
import { gpsScenario } from './gps-scenario.mjs';

// The public-data scenario of gps-scenario.mjs (its header says how the
// observations are made).
// Expected: every catalogued radar and optical observation associates with
// its own satellite (a correct observation falls outside the 0.9973 gate with
// probability 0.0027; those are counted, not failed); every Galileo and
// dropped-GPS radar and optical observation is a UCT; a Doppler-only observation (one degree of
// freedom) is associated correctly or flagged ambiguous; and for the correct
// associations the Mahalanobis distances are chi-square distributed: the
// p-values are uniform (Kolmogorov-Smirnov at alpha = 0.01) and, for the
// two-dimensional optical case, p = exp(-d2/2) exactly.
test('GNSS observations associate with an independent catalog; uncatalogued ones are UCTs', async (t) => {
  const { inputs, truthOf, catalog } = gpsScenario();
  const { report, records, error } = await associate(inputs);
  assert.equal(error, undefined, error);

  const noradOf = Object.fromEntries(catalog.map((c) => [c.prn, c.norad]));
  const tally = { RDO: { right: 0, wrong: 0, falseUct: 0, uct: 0 }, EOO: { right: 0, wrong: 0, falseUct: 0, uct: 0 }, RFO: { right: 0, wrong: 0, ambiguousWrong: 0, falseUct: 0, uct: 0 } };
  const pValues = [];
  for (const o of report.observations) {
    const sat = truthOf.get(o.id), expected = noradOf[sat], c = tally[o.type];
    if (!expected) {
      // One Doppler value can coincide with another satellite's; that is
      // allowed only when flagged ambiguous.
      assert.ok(o.status === 'uct' || (o.type === 'RFO' && o.ambiguous), `${o.id}: ${sat} is not in the catalog`);
      c.uct++;
      continue;
    }
    if (o.status === 'uct') { c.falseUct++; continue; }
    if (o.object.norad_cat_id === expected) {
      c.right++;
      if (o.type !== 'RFO') pValues.push(o.p_value);
      if (o.dof === 2) assert.ok(Math.abs(o.p_value - Math.exp(-o.d2 / 2)) < 1e-12, `${o.id}: two-dof p-value`);
    } else if (o.type === 'RFO' && o.ambiguous) c.ambiguousWrong++;
    else { c.wrong++; t.diagnostic(JSON.stringify({ id: o.id, sat, expected, got: o.object, d2: o.d2, amb: o.ambiguous, cands: o.candidates.map((x) => [x.object.norad_cat_id, x.d2, x.in_gate]) })); }
  }
  t.diagnostic(JSON.stringify({ counts: report.counts, tally }));
  for (const type of ['RDO', 'EOO', 'RFO']) assert.equal(tally[type].wrong, 0, `${type}: unflagged wrong associations`);
  assert.ok(tally.RDO.uct > 20 && tally.EOO.uct > 20, 'Galileo and the dropped GPS satellites were observed');
  const catalogued = tally.RDO.right + tally.EOO.right + tally.RDO.falseUct + tally.EOO.falseUct;
  assert.ok(catalogued > 150, `${catalogued} catalogued radar and optical observations`);
  // False UCTs: binomial(catalogued, 0.0027); at most mean + 4 sigma.
  const falseUcts = tally.RDO.falseUct + tally.EOO.falseUct;
  assert.ok(falseUcts <= catalogued * 0.0027 + 4 * Math.sqrt(catalogued * 0.0027), `${falseUcts} false UCTs of ${catalogued}`);
  // Uniform p-values: one-sample Kolmogorov-Smirnov, D < 1.628/sqrt(n) (alpha 0.01).
  pValues.sort((a, b) => a - b);
  const n = pValues.length;
  const D = Math.max(...pValues.map((p, i) => Math.max((i + 1) / n - p, p - i / n)));
  assert.ok(D < 1.628 / Math.sqrt(n), `KS D = ${D.toFixed(4)} for ${n} p-values`);
  // The records: identity on the associated ones, UCT on the rest.
  for (const { record } of records.associated) {
    assert.equal(record.UCT, false);
    assert.ok((record.SAT_NO ?? record.NORAD_CAT_ID) > 0);
  }
  for (const { record } of records.ucts) assert.equal(record.UCT, true);
  // Every record carries its association statistics (SDS 1.241.0): the
  // report's d2, dof, gate, p-value and ambiguity (a UCT: its nearest
  // candidate's d2 and p-value, 0 without one).
  const byId = new Map(report.observations.map((o) => [o.id, o]));
  for (const { record } of [...records.associated, ...records.ucts]) {
    const o = byId.get(record.ID), c = o.status === 'uct' ? o.candidates[0] : o;
    assert.deepEqual([record.CORR_MAHALANOBIS_SQ, record.CORR_DOF, record.CORR_GATE, record.CORR_P_VALUE, record.CORR_AMBIGUOUS],
      [c?.d2 ?? 0, o.dof, o.gate, c?.p_value ?? 0, o.ambiguous], record.ID);
  }
  assert.equal(records.associated.length + records.ucts.length, report.observations.length);
});
