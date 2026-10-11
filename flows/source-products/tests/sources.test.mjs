// sources.json against the modules and the flow. Every orbit data-source module of the repository is in the registry as
// a source that gives products, one that cannot (with the reason), or one that describes; every source that gives
// products enters the flow where its manifest says it can, and the flow, run with the source's recipe, names the source on
// the records. The sources the paper lists that have no module are checked against the ephemeris-source inventory and
// against the file system, so an entry cannot outlive its module.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXTURE as VALLADO, mpeStream } from '../../../analysis/epoch-state/tests/fixtures.mjs';
import { fitOcm, ommParam, param, records, unpackMnv, unpackOcm, unpackOmm } from '../../../analysis/gp-error-model/tests/products-fixtures.mjs';
import { gpHistory } from '../../../analysis/maneuver-detection/tests/fixtures.mjs';
import { ommRecord } from '../../../analysis/maneuver-detection/study/lib/host.mjs';
import { recipeFor, registry } from '../recipe.mjs';
import { egressBytes, flowDocument, runFlow } from './flow-harness.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifestOf = (module) => readJson(`${root}${module}/plugin-manifest.json`);
const exists = (module) => fs.existsSync(`${root}${module}/plugin-manifest.json`);
const deps = readJson(`${root}flows/source-products.deps.json`);
const inventory = readJson(`${root}data-source/ephemeris-source/sources.json`).sources.map((s) => s.source_id);

const method = (manifest, id) => manifest.methods.find((m) => m.methodId === id);
const port = (manifest, methodId, direction, portId) => method(manifest, methodId)?.[direction].find((p) => p.portId === portId);
const typesOf = (p) => p.acceptedTypeSets.flatMap((set) => set.allowedTypes.map((t) => t.fileIdentifier).filter(Boolean));
const acceptsAnyFlatbuffer = (p) => p.acceptedTypeSets.some((set) => set.allowedTypes.some((t) => t.acceptsAnyFlatbuffer));
const ORBIT_TYPES = new Set(['$OMM', '$OEM', '$MPE', '$OCM', '$OPM']);
const OBSERVATION_TYPES = new Set(['$TDM']);

// The flow's own port that takes a trigger's frames: its node's module, method and port manifest.
function flowPort({ trigger, port: portId }) {
  const binding = flowDocument.triggerBindings.find((b) => b.triggerId === trigger && b.targetPortId === portId);
  assert.ok(binding, `the flow binds no port ${portId} to the trigger ${trigger}`);
  const node = flowDocument.nodes.find((n) => n.nodeId === binding.targetNodeId);
  return port(manifestOf(deps[node.pluginId].replace('../', '')), node.methodId, 'inputPorts', portId);
}

const wiredModules = new Set(registry.sources.flatMap((s) => s.via.map((w) => w.module)));
const classified = new Map([
  ...[...wiredModules].map((m) => [m, 'sources']),
  ...registry.refused.map((r) => [r.module, 'refused']),
  ...registry.support.map((s) => [s.module, 'support']),
]);

test('the registry is well formed: unique ids, the audit\'s licence classes, a lane for every kind', () => {
  const ids = registry.sources.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of registry.sources) {
    assert.ok(['element-set', 'ephemeris', 'observation'].includes(s.kind), `${s.id}: ${s.kind}`);
    assert.ok(registry.lanes[s.kind], `${s.id}: no lane ${s.kind}`);
    assert.ok(s.originator && s.lineage && s.licence.id, `${s.id} names its originator, lineage and licence`);
    assert.ok(Object.hasOwn(registry.licence.classes, s.licence.class), `${s.id}: ${s.licence.class}`);
    assert.equal(typeof s.ownModel, 'boolean');
    assert.ok(s.via.length > 0, `${s.id} is given by a module`);
  }
  // A lane that lists its sources lists the registry's sources of its kind.
  for (const [kind, lane] of Object.entries(registry.lanes)) {
    if (lane.sources) assert.deepEqual(lane.sources, registry.sources.filter((s) => s.kind === kind).map((s) => s.id), `the ${kind} lane's sources`);
  }
  // An observation source names the fit class its realism factor was measured for, and a factor for it.
  for (const s of registry.sources.filter((x) => x.kind === 'observation')) {
    assert.ok(s.fitClass, `${s.id}: an observation source names its fit class`);
    const measured = (s.realism ?? []).filter((r) => r.sources.includes(s.id) && r.class === s.fitClass);
    assert.equal(measured.length, 1, `${s.id}: one measured realism factor for the class ${s.fitClass}`);
    assert.ok(measured[0].factor > 0 && measured[0].samples > 0 && measured[0].objects > 0 && measured[0].evidence && measured[0].window, `${s.id}: the factor is measured, with its evidence`);
    assert.equal(measured[0].factor, measured[0].meanD2Over3, 'the factor is the measured mean d2/3');
  }
  // Every trigger of the flow serves a lane, and every lane names triggers the flow has.
  const named = Object.values(registry.lanes).flatMap((lane) => lane.ingress.flatMap((entry) => entry.split(' or ')));
  assert.deepEqual([...new Set(named)].sort(), flowDocument.triggers.map((t) => t.triggerId).sort());
});

test('every module a source is given by has the method and the output port, typed as the registry says, and the flow takes that type where it enters', () => {
  for (const s of registry.sources) {
    for (const w of s.via) {
      assert.ok(exists(w.module), `${w.module} is not a module of this repository`);
      const out = port(manifestOf(w.module), w.method, 'outputPorts', w.port);
      assert.ok(out, `${w.module} ${w.method} has no output port ${w.port}`);
      if (w.wildcard) assert.ok(acceptsAnyFlatbuffer(out), `${w.module} ${w.port} is not a wildcard port`);
      else assert.ok(typesOf(out).includes(w.type), `${w.module} ${w.method} ${w.port} gives ${typesOf(out)}, not ${w.type}`);
      assert.ok(w.into.length > 0);
      for (const into of w.into) {
        if (s.kind === 'observation') {
          // An observation enters the lane's estimator, whose $OCM enters the flow (checked below).
          const { estimator } = registry.lanes.observation;
          assert.ok(estimator.inputs.includes(into.estimator), `${into.estimator} is not an input of ${estimator.module}`);
          const accepted = port(manifestOf(estimator.module), estimator.method, 'inputPorts', into.estimator);
          assert.ok(accepted && typesOf(accepted).includes(w.type), `${estimator.module} ${into.estimator} takes ${accepted && typesOf(accepted)}, not ${w.type}`);
          continue;
        }
        const taken = flowPort(into);
        assert.ok(typesOf(taken).includes(w.type), `the flow's ${into.trigger} (${into.port}) takes ${typesOf(taken)}, not ${w.type}`);
        assert.equal(registry.lanes[s.kind].ingress.some((entry) => entry.split(' or ').includes(into.trigger)), true, `${into.trigger} is not an ingress of the ${s.kind} lane`);
      }
    }
    if (s.kind === 'ephemeris') {
      assert.ok(s.fit, `${s.id}: an ephemeris source is fitted before its products`);
      const fit = manifestOf(s.fit.module);
      assert.ok(port(fit, s.fit.method, 'inputPorts', s.fit.input), `${s.fit.module} takes no ${s.fit.input}`);
      const out = port(fit, s.fit.method, 'outputPorts', s.fit.output);
      assert.ok(out, `${s.fit.module} gives no ${s.fit.output}`);
      assert.ok(typesOf(out).includes(s.fit.unwrap ?? '$OMM'), `${s.fit.module} ${s.fit.output} gives ${typesOf(out)}`);
      assert.ok(flowPort(s.fit.into), 'the fit enters the flow as fit_omm');
    }
  }
  const { estimator } = registry.lanes.observation;
  const estimation = manifestOf(estimator.module);
  for (const input of estimator.inputs) assert.ok(port(estimation, estimator.method, 'inputPorts', input), `${estimator.module} takes no ${input}`);
  assert.ok(typesOf(port(estimation, estimator.method, 'outputPorts', estimator.output)).includes('$OCM'));
  assert.ok(flowPort(estimator.into));
});

test('every orbit data-source module of the repository is classified, and none is classified twice', () => {
  const orbitRelated = fs.readdirSync(`${root}data-source`).filter((dir) => fs.existsSync(`${root}data-source/${dir}/plugin-manifest.json`)).filter((dir) => {
    const manifest = manifestOf(`data-source/${dir}`);
    const gives = manifest.methods.some((m) => m.outputPorts.some((p) => typesOf(p).some((t) => ORBIT_TYPES.has(t) || OBSERVATION_TYPES.has(t) || t === '$CAT')));
    return gives || /ephemeri|element set|\bOMM\b|\bOEM\b|almanac|\bGP\b/i.test(manifest.description ?? '');
  }).map((dir) => `data-source/${dir}`);
  assert.ok(orbitRelated.length >= 17, `${orbitRelated.length} orbit-related modules found`);
  for (const module of orbitRelated) assert.ok(classified.has(module), `${module} gives or describes orbit data and is not in sources.json`);
  const listed = [...registry.sources.flatMap((s) => s.via.map((w) => w.module)), ...registry.refused.map((r) => r.module), ...registry.support.map((s) => s.module)];
  const seen = new Set(registry.sources.flatMap((s) => s.via.map((w) => w.module)));
  for (const module of [...registry.refused.map((r) => r.module), ...registry.support.map((s) => s.module)]) {
    assert.equal(seen.has(module), false, `${module} is both a source and refused or described`);
    seen.add(module);
  }
  assert.ok(listed.every((module) => exists(module)));
});

test('the sources refused give no orbit records, with a reason and the task that changes it', () => {
  for (const r of registry.refused) {
    assert.ok(r.reason.length > 40 && (r.task || r.permanent), r.module);
    const manifest = manifestOf(r.module);
    assert.equal(r.check, 'no-orbit-output');
    const gives = manifest.methods.flatMap((m) => m.outputPorts.flatMap(typesOf)).filter((t) => ORBIT_TYPES.has(t));
    assert.deepEqual(gives, [], `${r.module} gives ${gives}: it can be wired, so it is not refused`);
  }
});

test('the sources without a module are the inventory\'s that no module gives, each with the task that builds it', () => {
  const covered = new Set([...registry.sources, ...registry.refused, ...registry.missing].flatMap((s) => s.registry));
  assert.deepEqual(inventory.filter((id) => !covered.has(id)), [], 'every source of the ephemeris-source inventory is wired, refused or missing');
  for (const id of covered) assert.ok(inventory.includes(id), `${id} is not in the ephemeris-source inventory`);
  for (const m of registry.missing) {
    assert.match(m.task, /^[a-z0-9-]+-\d{8}$/);
    if (m.module) assert.equal(exists(m.module), false, `${m.module} exists: move ${m.name} to sources`);
    else assert.ok(exists(m.extends), `${m.extends} is not a module`);
    assert.ok(['element-set', 'ephemeris', 'observation'].includes(m.kind));
  }
});

// ── the flow, run with each source's recipe ──
const frame = (trigger, portId, bytes) => ({ trigger, portId, bytes });
const history = gpHistory(1);
const sets = Buffer.concat(history.rows.map((row) => Buffer.from(ommRecord(row))));
const provider = (module) => manifestOf(module).pluginId;

for (const source of registry.sources.filter((s) => s.kind !== 'observation')) {
  for (const w of source.via) {
    test(`${source.id} through ${w.module}: the records name the source, its provider and its licence`, async () => {
      const recipeBytes = Buffer.from(JSON.stringify(recipeFor(source.id, { created: '2026-10-11T00:00:00Z', via: w.module })));
      const mpe = w.type === '$MPE';
      const lane = source.kind === 'ephemeris' ? ['fit_omm', 'omm', 'fit_recipe'] : [mpe ? 'element_sets_mpe' : 'element_sets', mpe ? 'mpe' : 'omm', 'element_set_recipe'];
      const input = mpe ? Buffer.from(mpeStream(VALLADO.cases)) : sets;
      const { egress, result } = await runFlow([frame(lane[0], lane[1], input), frame(lane[2], 'recipe', recipeBytes)]);
      assert.equal(result.handlersSkipped, 0);

      const ocms = records(egressBytes(egress, 'ocm')).map(unpackOcm);
      const omms = records(egressBytes(egress, 'omm')).map(unpackOmm);
      assert.ok(ocms.length > 0 && omms.length > 0, 'an $OCM and an $OMM');
      for (const ocm of ocms) {
        assert.equal(param(ocm, 'SOURCE_ID'), source.id);
        assert.equal(param(ocm, 'SOURCE_KIND'), source.kind);
        assert.equal(param(ocm, 'SOURCE_ORIGINATOR'), source.originator);
        assert.equal(param(ocm, 'SOURCE_PROVIDER'), provider(w.module));
        assert.equal(param(ocm, 'SOURCE_LINEAGE'), source.lineage);
        assert.equal(param(ocm, 'LICENCE_CLASS'), source.licence.class);
        assert.equal(param(ocm, 'LICENCE_ID'), source.licence.id);
        // Rule 3 for a source the model was measured on, rule 4 (pooled) for the others.
        const labels = JSON.parse(param(ocm, 'COV_LABELS'));
        assert.deepEqual([...new Set(labels.map((l) => l.rule))], [source.ownModel ? 3 : 4]);
        // Calibrated only where the held-out cell was realistic and the lineage is one the model was measured on.
        for (const label of labels) if (label.calibration === 'CALIBRATED') assert.ok(source.ownModel, `${source.id} was not measured`);
      }
      for (const omm of omms) {
        assert.equal(omm.ORIGINATOR, source.originator);
        for (const text of [source.id, provider(w.module), source.licence.class]) assert.ok(omm.COMMENT.includes(text), `the $OMM names ${text}`);
        // And as USER_DEFINED_x keywords, which only a flow that links every module's own SDS code can write (see the module builds).
        assert.equal(ommParam(omm, 'SOURCE_ID'), source.id);
        assert.equal(ommParam(omm, 'SOURCE_PROVIDER'), provider(w.module));
        assert.equal(ommParam(omm, 'LICENCE_CLASS'), source.licence.class);
        assert.equal(ommParam(omm, 'LICENCE_ID'), source.licence.id);
      }
      if (!mpe) {
        // The burn in the history, on a $MNV that names the source.
        const burns = records(egressBytes(egress, 'mnv')).map(unpackMnv).filter((m) => m.DELTA_VEL_V !== 0);
        assert.equal(burns.length, 1);
        // The lineage is a tag only where it says more than the source's id.
        const tags = [`source:${source.id}`, `originator:${source.originator}`, `provider:${provider(w.module)}`, `licence:${source.licence.class}`, `licence-id:${source.licence.id}`,
          ...(source.lineage === source.id ? [] : [`lineage:${source.lineage}`])];
        for (const tag of tags) assert.ok(burns[0].TAGS.includes(tag), tag);
      }
    });
  }
}

// An observation source enters the flow by the estimates it supports: the newest fit's $OCM on `fit`, the SGP4 sets fitted to the
// estimated arcs on `fit_omm` (the history of fits, screened for maneuvers like any other lane's). The covariance is rule 2, the
// formal covariance times the factor measured for the source and its fit class.
for (const source of registry.sources.filter((s) => s.kind === 'observation')) {
  for (const w of source.via) {
    test(`${source.id} through ${w.module}: the fit's formal covariance times the factor measured for the source, uncalibrated, the burn in the fits' history, and the records name the source, its provider and its licence`, async () => {
      const recipe = recipeFor(source.id, { created: '2026-10-11T00:00:00Z', via: w.module, ages: [0] });
      const [realism] = source.realism;
      const x = [4000.5, 5000.25, 3000.125, -3.5, 4.25, 4.75];
      const lower = Array.from({ length: 21 }, (_, i) => (i === 0 || i === 2 || i === 5 ? 1e-6 : i === 9 || i === 14 || i === 20 ? 1e-12 : 0));
      // The designed history stands for the sets fitted to successive arcs; the newest fit is the one the estimator's $OCM belongs to.
      const newest = history.rows.at(-1);
      const fit = fitOcm({ norad: newest.NORAD_CAT_ID, name: 'FIT', epoch: newest.EPOCH, x, lower });
      const { egress, result } = await runFlow([frame('fit_omm', 'omm', sets), frame('fit', 'fit', fit), frame('fit_recipe', 'recipe', Buffer.from(JSON.stringify(recipe)))]);
      assert.equal(result.handlersSkipped, 0);

      const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
      assert.ok(ocm, 'an $OCM');
      assert.equal(param(ocm, 'SOURCE_ID'), source.id);
      assert.equal(param(ocm, 'SOURCE_KIND'), 'observation');
      assert.equal(param(ocm, 'SOURCE_ORIGINATOR'), source.originator);
      assert.equal(param(ocm, 'SOURCE_PROVIDER'), provider(w.module));
      assert.equal(param(ocm, 'SOURCE_LINEAGE'), source.lineage);
      assert.equal(param(ocm, 'LICENCE_CLASS'), source.licence.class);
      assert.equal(param(ocm, 'LICENCE_ID'), source.licence.id);
      // Rule 2: the formal covariance times the measured factor, and not calibrated, because the scaled covariance has not itself been tested.
      const labels = JSON.parse(param(ocm, 'COV_LABELS'));
      assert.deepEqual([...new Set(labels.map((l) => l.rule))], [2]);
      for (const label of labels) {
        assert.equal(label.method, 'fit-formal-scaled');
        assert.equal(label.scaleFactor, realism.factor);
        assert.equal(label.meanD2Over3, realism.meanD2Over3);
        assert.equal(label.calibration, 'UNCALIBRATED');
      }
      assert.ok(Math.abs(ocm.COVARIANCE_DATA[0] - lower[0] * realism.factor) < 1e-15, `${ocm.COVARIANCE_DATA[0]} against ${lower[0] * realism.factor}`);
      const [omm] = records(egressBytes(egress, 'omm')).map(unpackOmm);
      assert.equal(omm.ORIGINATOR, source.originator);
      for (const text of [source.id, provider(w.module), source.licence.class]) assert.ok(omm.COMMENT.includes(text), `the $OMM names ${text}`);
      assert.equal(ommParam(omm, 'SOURCE_ID'), source.id);
      assert.equal(ommParam(omm, 'SOURCE_PROVIDER'), provider(w.module));
      assert.equal(ommParam(omm, 'LICENCE_CLASS'), source.licence.class);
      assert.equal(ommParam(omm, 'LICENCE_ID'), source.licence.id);
      // The burn in the history of fits, on a $MNV that names the source.
      const burns = records(egressBytes(egress, 'mnv')).map(unpackMnv).filter((m) => m.DELTA_VEL_V !== 0);
      assert.equal(burns.length, 1);
      const tags = [`source:${source.id}`, `originator:${source.originator}`, `provider:${provider(w.module)}`, `licence:${source.licence.class}`, `licence-id:${source.licence.id}`,
        ...(source.lineage === source.id ? [] : [`lineage:${source.lineage}`])];
      for (const tag of tags) assert.ok(burns[0].TAGS.includes(tag), tag);
    });
  }
}
