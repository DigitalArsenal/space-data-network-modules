// Offline CA acceptance reduction; propagation and screening stay in WASM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

function groupEvents(events) {
  const groups = new Map();
  for (const event of events) {
    assert(Number.isFinite(event.tcaJd) && Number.isFinite(event.missM), 'Nonfinite CA event.');
    const key = [event.primaryNorad, event.secondaryNorad].sort((a, b) => a - b).join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  for (const events of groups.values()) events.sort((a, b) => a.tcaJd - b.tcaJd);
  return groups;
}
function eventSet(reference, candidate) {
  const missingPairs = [...reference.keys()].filter((key) => !candidate.has(key));
  const extraPairs = [...candidate.keys()].filter((key) => !reference.has(key));
  const countDifferences = [...reference].flatMap(([pair, events]) => candidate.has(pair) && candidate.get(pair).length !== events.length
    ? [{ pair, reference: events.length, candidate: candidate.get(pair).length }] : []);
  return { equal: !missingPairs.length && !extraPairs.length && !countDifferences.length, missingPairs, extraPairs, countDifferences };
}
function delta(reference, candidate) {
  if (!candidate) return null;
  return { missMeters: Math.abs(candidate.missM - reference.missM), tcaSeconds: Math.abs(candidate.tcaJd - reference.tcaJd) * 86400 };
}
function summarize(events) {
  return { events: events.length, fastFailures: events.filter((e) => !e.fastPass).length,
    fastNoWorseMiss: events.filter((e) => e.fastNoWorseMiss).length, fastNoWorseTca: events.filter((e) => e.fastNoWorseTca).length,
    ...Object.fromEntries(['standard', 'fast'].map((name) => [name, {
      maxMissMeters: Math.max(0, ...events.map((e) => e[name]?.missMeters ?? Infinity)),
      maxTcaSeconds: Math.max(0, ...events.map((e) => e[name]?.tcaSeconds ?? Infinity)),
    }])) };
}

// DECISION-CA.md, 2026-10-17: the reference integrator is the oracle.
// Standard deltas and sigma fractions are evidence, not acceptance gates.
export function compareEvents(standardRun, fastRun, referenceRun, catalogRecords, modulesRoot, sha256) {
  for (const key of ['catalogSha256', 'selectedIdsSha256', 'objects', 'startUtc', 'days', 'windowHours', 'profile', 'environmentSha256', 'workers']) {
    assert.deepEqual(fastRun[key], standardRun[key], `Standard/Fast input differs: ${key}`);
    assert.deepEqual(referenceRun[key], standardRun[key], `Reference input differs: ${key}`);
  }
  for (const run of [standardRun, fastRun, referenceRun]) {
    assert(run.completed, run.error);
    for (const key of ['workers', 'thresholdKm', 'uncertaintyModelSha256'])
      assert.deepEqual(run.screen[key], referenceRun.screen[key], `Screen controls differ: ${key}`);
  }
  const standard = groupEvents(standardRun.screen.events), fast = groupEvents(fastRun.screen.events), reference = groupEvents(referenceRun.screen.events);
  const sets = { standard: eventSet(reference, standard), fast: eventSet(reference, fast) };
  const byId = new Map(catalogRecords.map((r) => [Number(r.NORAD_CAT_ID), r]));
  const metadata = (id) => {
    const r = byId.get(Number(id)); assert(r, `Missing OMM metadata for ${id}`);
    // Retain the archived epoch's submillisecond digits for the age boundary.
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z?$/.exec(r.EPOCH);
    assert(match, `Invalid OMM epoch for ${id}`);
    return { meanMotion: Number(r.MEAN_MOTION), inclination: Number(r.INCLINATION), eccentricity: Number(r.ECCENTRICITY),
      epochJd: (Date.parse(match[1] + 'Z') / 1000 + Number(match[2] ?? 0)) / 86400 + 2440587.5 };
  };
  const modelFile = path.join(modulesRoot, 'analysis/gp-error-model/data/e14-s3-kc.json');
  const model = JSON.parse(fs.readFileSync(modelFile));
  const maximumPredictionAgeDays = Math.max(...model.ageBinsDays.map((b) => b[1]));
  assert.equal(maximumPredictionAgeDays, 8, 'Owner decision requires the E14 eight-day domain.');
  const rows = [], sigmaPairs = { standard: [], fast: [] };
  for (const [pair, events] of reference) for (const [index, ref] of events.entries()) {
    const a = standard.get(pair)?.[index], b = fast.get(pair)?.[index];
    const primary = metadata(ref.primaryNorad), secondary = metadata(ref.secondaryNorad);
    const ages = [ref.tcaJd - primary.epochJd, ref.tcaJd - secondary.epochJd];
    const da = delta(ref, a), db = delta(ref, b);
    rows.push({ pair, eventIndex: index, referenceTcaJd: ref.tcaJd, referenceMissMeters: ref.missM,
      primaryAgeDays: ages[0], secondaryAgeDays: ages[1], inDomain: ages.every((age) => age >= 0 && age <= maximumPredictionAgeDays),
      standard: da, fast: db, fastPass: !!db && db.missMeters <= 1 && db.tcaSeconds <= 0.001,
      fastNoWorseMiss: !!da && !!db && db.missMeters <= da.missMeters,
      fastNoWorseTca: !!da && !!db && db.tcaSeconds <= da.tcaSeconds });
    for (const [name, candidate] of [['standard', a], ['fast', b]]) if (candidate)
      sigmaPairs[name].push({ key: pair, standard: ref, fast: candidate, primary, secondary });
  }
  assert(rows.length > 0, 'An empty screen cannot establish event-set equivalence.');
  const inside = rows.filter((e) => e.inDomain), outside = rows.filter((e) => !e.inDomain);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffm-ca-sigma-'));
  const sigma = { acceptanceGate: false, modelSha256: sha256(fs.readFileSync(modelFile)) };
  try {
    const executable = path.join(temp, 'compare');
    execFileSync('clang++', ['-std=c++17', '-O2', '-I', path.join(modulesRoot, 'propagator/ffm/src/cpp/include'),
      path.join(modulesRoot, 'propagator/ffm-fast/scripts/compare-ca-sigma.cpp'), '-o', executable], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const name of ['standard', 'fast']) {
      const diagnostic = JSON.parse(execFileSync(executable, [], { encoding: 'utf8',
        input: JSON.stringify({ model, pairs: sigmaPairs[name] }), maxBuffer: 16 * 1024 * 1024 }));
      sigma[name] = diagnostic;
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  return { pass: sets.fast.equal && inside.length > 0 && inside.every((e) => e.fastPass), eventSets: sets,
    thresholds: { missMeters: 1, tcaSeconds: 0.001, maximumPredictionAgeDays },
    inDomain: summarize(inside), outOfDomain: summarize(outside), allEvents: summarize(rows), events: rows, sigma };
}
