#!/usr/bin/env node
// ONE serial end-to-end evidence check. Each child authenticates its oracle and
// replays its documented C++/WASM slice. Independent C++ reductions then check
// raw summary scores against the shared export (GMAT limits only for GMAT).
// Source, frame, epochs, units and tolerance rationale remain in consolidated.json.
// No network, module rebuild, unit-test suite, or parallel child execution.
// node propagator/hpop/tests/evidence/check-all.mjs   (from repository root)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { here, root, childEnv, generate, applyBlocks } from './consolidate.mjs';
const checks = [
  ['Orekit', 'propagator/hpop/tests/evidence/orekit/check-orekit.mjs'],
  ['GMAT R2026a / R2022a', 'propagator/hpop/tests/evidence/gmat/check-gmat.mjs'],
  ['Nyx', 'propagator/hpop/tests/evidence/nyx/check-nyx.mjs'],
  ['tudatpy / Tudat WASM', 'propagator/hpop/tests/evidence/tudat/check-tudat.mjs'],
  ['Basilisk', 'propagator/hpop/tests/evidence/basilisk/check-basilisk.mjs'],
  ['ERFA / SPICE', 'propagator/hpop/tests/evidence/erfa-spice/check-erfa-spice.mjs'],
  ['Horizons', 'propagator/hpop/tests/evidence/horizons/check-horizons.mjs'],
  ['Vallado SGP4-VER', 'propagator/sgp4/tests/evidence/vallado/check-vallado.mjs'],
  ['SGP4-XP', 'propagator/sgp4/tests/evidence/xp/run-xp.mjs', '--check'],
];
async function child(label, script, args, work) {
  if (!fs.existsSync(path.join(root, script))) throw new Error(`${label}: check script missing`);
  console.log(`\n=== ${label} ===`);
  const result = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--v8-pool-size=1', script, ...args], { cwd: root, env: childEnv(work), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stdout.on('data', (chunk) => process.stdout.write(chunk));
    p.stderr.on('data', (chunk) => { stderr += chunk; });
    p.on('error', reject); p.on('close', (status, signal) => resolve({ status, signal, stderr }));
  });
  if (result.status !== 0 || result.stderr !== '') throw new Error(`${label}: exit=${result.status}, signal=${result.signal}, stderr=${JSON.stringify(result.stderr)}`);
  console.log(`Child contract: exit 0; stderr empty.`);
}
const work = fs.mkdtempSync(path.join(here, '.check-all-'));
const failures = [];
try {
  console.log('Consolidated evidence E2E: serial checks; one worker per child; offline C++/WASM scoring.');
  for (const [label, script, ...args] of checks) {
    try { await child(label, script, args, work); }
    catch (error) { failures.push(error.message); console.log(`FAIL child contract: ${error.message}`); }
  }
  console.log('\n=== Independent consolidation ===');
  const result = generate(work);
  const md = path.join(here, 'CONSOLIDATED.md');
  // Regeneration is an explicit authoring command. A check must not erase drift.
  if (!fs.existsSync(md) || fs.readFileSync(md, 'utf8') !== result.markdown)
    throw new Error('CONSOLIDATED.md differs from regenerated evidence; run consolidate.mjs --write and review it.');
  applyBlocks(result.blocks);
  const json = JSON.stringify(result.data, null, 2) + '\n', output = path.join(here, 'consolidated.json');
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== json)
    throw new Error('consolidated.json differs from regenerated evidence; run consolidate.mjs --write and review it.');
  // Writing identical bytes makes successful runs idempotent, without timestamps.
  fs.writeFileSync(output, json); fs.writeFileSync(md, result.markdown);
  for (const t of result.data.tools) {
    const c = t.counts;
    console.log(`${t.label}: ${c.scored} primary scored, ${c.skipped} skipped; ${c.met} met, ${c.missed} missed; ${c.diagnostic} diagnostic, ${c.decomposition} decomposition (${c.untoleranced} without primary limit); version/checksum pins present.`);
  }
  for (const d of result.data.dragDiagnostics) for (const r of d.rows)
    console.log(`Drag diagnostic, suite: ${d.label} ${r.orbit}, ${r.cases} cases; stock ${r.stockDisplay}, adjusted ${r.correctedDisplay}, limit ${r.limitDisplay}: ${r.met ? 'met' : 'not met'}.`);
  for (const row of result.data.tools.find((t) => t.id === 'vallado').rows.filter((r) => r.consistency))
    console.log(`Vallado request criterion, ${row.regime}: ${row.status}; ${row.consistency.exceeded}/${row.consistency.samples} samples exceed; maximum excess ${row.consistency.positionExceedanceDisplay}, ${row.consistency.velocityExceedanceDisplay}.`);
  console.log('Coverage: every propagation tool accounts for all 72 exported case IDs.');
  console.log('Verdicts: independently recomputed from numeric scores; only limited primary rows enter met/missed counts; every exceeded bound has a recorded cause.');
  console.log('Vallado: fixed source/module criteria and per-sample request bounds recomputed independently; printing retained as a diagnostic, without widening any allowance.');
  console.log('Drag diagnostics: GMAT steps30 and Nyx finest scores reproduced before suite re-scoring; full supported drag coverage checked; per-tool scored evidence unchanged.');
  console.log('Artifacts: consolidated.json, CONSOLIDATED.md and both generated documentation blocks match byte-for-byte.');
  if (failures.length) {
    console.log(`FAIL consolidated evidence E2E: ${failures.length} child contract failure(s); all 9 scripts ran; consolidated data/documents match.`);
    process.exitCode = 1;
  } else console.log('PASS consolidated evidence E2E: 9 serial check scripts, 11 tool records; exit 0 and empty stderr for every child.');
} catch (error) {
  console.log(`FAIL consolidated evidence E2E: ${error.message}`); process.exitCode = 1;
} finally { fs.rmSync(work, { recursive: true, force: true }); }
