#!/usr/bin/env node
// Evidence authentication and all printed-state replays, serially.
// Reference: Vallado SGP4-VER in python-sgp4 2.27, TEME, WGS-72, UTC epochs.
// C++ forms exact TLE epoch text, Julian-date requests and SI difference norms.
// The comparison tolerance is documented in replay-metrics.cpp. Printing
// component resolution remains diagnostic; primary criteria are assessed in C++.
// --write-criteria appends only the acceptance record, preserving every existing
// measurement. The default E2E replays and verifies that record without writing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { invokePiv, loadRawSgp4Module } from '../../lib/pivInvokeHelper.mjs';
import { ReferenceFrame, decodePropagatorState, encodeOmmPayload, encodePropagatorBatchRequest } from '../../lib/payloadEncoders.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), pkg = path.resolve(here, '../../..');
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
const OMM_TYPE = { schemaName: 'orbpro.sds.omm', fileIdentifier: '$OMM', rootTypeName: 'OMM' };
const PROP_TYPE = { schemaName: 'orbpro.propagator.PropagatorBatchRequest', fileIdentifier: 'PROP', rootTypeName: 'PropagatorBatchRequest' };
async function main() {
  const writing = process.argv.length === 3 && process.argv[2] === '--write-criteria';
  if (process.argv.length > 2 && !writing) throw new Error('Usage: check-vallado.mjs [--write-criteria]');
  const summaryFile = path.join(here, 'summary-vallado.json');
  const summaryText = fs.readFileSync(summaryFile, 'utf8'), summary = JSON.parse(summaryText);
  const tools = JSON.parse(fs.readFileSync(path.join(here, 'tools.json'), 'utf8'));
  const causes = JSON.parse(fs.readFileSync(path.join(here, 'causes.json'), 'utf8'));
  check(summary.module.version === JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version, 'SGP4 version differs');
  check(tools.reference.package.includes('2.27') && /^[0-9a-f]{64}$/.test(tools.reference.sha256), 'reference package version/hash pin missing');
  for (const [name, checksum] of Object.entries(summary.module)) if (name !== 'version') check(hash(path.join(pkg, name)) === checksum, `module/source hash differs: ${name}`);
  check(hash(path.join(here, 'sgp4_vallado_native.cpp')) === summary.native.harnessSha256, 'native harness hash differs');
  const roots = [process.env.VALLADO_DATA_DIR, path.join(here, 'data'), '/Users/tj/software/tools/xval/sgp4-vallado/src/sgp4-2.27/sgp4'].filter(Boolean);
  const inputs = {};
  for (const [name, checksum] of Object.entries(summary.inputs)) {
    const file = roots.map((root) => path.join(root, name)).find((file) => fs.existsSync(file));
    check(/^[0-9a-f]{64}$/.test(checksum) && tools.reference.files[`sgp4/${name}`]?.sha256 === checksum, `input checksum pin differs: ${name}`);
    if (file) { check(hash(file) === checksum, `input hash differs: ${name}`); inputs[name] = fs.readFileSync(file, 'latin1').replace(/\r/g, ''); }
    else console.log(`Unavailable input: ${name}; reason: absent from VALLADO_DATA_DIR, evidence/data and the recorded local xval package.`);
  }
  const work = fs.mkdtempSync(path.join(here, '.check-vallado-'));
  process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
  const binary = path.join(work, 'replay-metrics');
  execFileSync('/usr/bin/clang++', ['-std=c++17', '-O2', '-ffp-contract=off', '-w', '-I', path.join(pkg, 'src/cpp/src'), '-I', path.resolve(pkg, '../hpop/src/cpp/include'), path.join(here, 'replay-metrics.cpp'), path.join(pkg, 'src/cpp/src/SGP4.cpp'), '-o', binary], { cwd: work, env: { ...process.env, TMPDIR: work }, stdio: ['ignore', 'pipe', 'pipe'] });
  const metrics = (input) => JSON.parse(execFileSync(binary, [], { cwd: work, input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 16 << 20 }));
  const validation = metrics({ mode: 'validate', summary });
  errors.push(...validation.failures);
  for (const exceeded of validation.exceeded) {
    const cause = causes[exceeded.key];
    check(Boolean(cause?.classification && cause?.statement && cause?.evidence?.length), `${exceeded.label}: printing exceedance has no recorded cause`);
    for (const evidence of cause?.evidence ?? []) check(fs.existsSync(path.resolve(here, evidence.split('#')[0])), `${exceeded.key}: cause evidence missing: ${evidence}`);
  }
  check(JSON.stringify(summary.errors.expected) === JSON.stringify(summary.errors.vallado) && summary.errors.match === true, 'Vallado error-code verdict differs');
  check(summary.errors.wasmStops.every((row) => row.wasmValid === false), 'WASM accepts a recorded stop');
  console.log(`Hashes: SGP4 module/source, harness and ${Object.keys(inputs).length} available reference inputs verified; python-sgp4 2.27 source archive pinned.`);
  console.log(`Coverage: ${summary.sets.length} sets, ${summary.tables.all.source.samples} scored rows; ${validation.exceeded.length} table printing exceedances have recorded causes.`);
  if (Object.keys(inputs).length !== 2) throw new Error('cannot replay without both authenticated reference inputs (unavailability reasons recorded above)');
  const sets = [], blocks = [];
  const lines = inputs['SGP4-VER.TLE'].split('\n');
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('1 ')) sets.push({ line1: lines[i], line2: lines[i + 1] });
  for (const line of inputs['tcppver.out'].split('\n')) {
    if (/^\s*\d+ xx\s*$/.test(line)) blocks.push({ satnum: Number(line.trim().split(/\s+/)[0]), rows: [] });
    else if (line.trim()) { const values = line.trim().split(/\s+/).slice(0, 7).map(Number); blocks.at(-1).rows.push({ tsince: values[0], r: values.slice(1, 4), v: values.slice(4, 7) }); }
  }
  check(sets.length === summary.sets.length && blocks.length === summary.sets.length, 'reference set count differs');
  for (const [index, block] of blocks.entries()) check(block.satnum === summary.sets[index]?.satnum && block.rows.length === summary.sets[index]?.rows, `block ${index}: printed identity/row count differs`);
  // The triangle criterion is per sample, so maxima or selected blocks cannot
  // establish it. Replay all printed states using one strict native helper and
  // the shipped WASM; the compiler-variant measurements remain unchanged.
  const replayed = [];
  try {
    for (const [index, set] of sets.entries()) {
      if (summary.sets[index].initError) {
        replayed.push({ index, satnum: blocks[index].satnum, method: null, initError: summary.sets[index].initError, samples: [] });
        continue;
      }
      const prepared = metrics({ mode: 'prepare', ...set, rows: blocks[index].rows });
      check(prepared.omm.epoch === summary.sets[index].epochIso, `${index}: TLE epoch differs`);
      const module = await loadRawSgp4Module();
      const wasm = [];
      try {
        const ingest = invokePiv(module, { methodId: 'ingest_omm', inputs: [{ portId: 'omm', typeRef: OMM_TYPE, payload: encodeOmmPayload({ ...prepared.omm, objectId: 'VALLADO', objectName: `SGP4-VER ${prepared.omm.noradId}` }) }] });
        if (ingest.response.STATUS_CODE !== 0) throw new Error(ingest.response.ERROR_MESSAGE);
        for (const row of prepared.rows) {
          const result = invokePiv(module, { methodId: 'propagate_state', inputs: [{ portId: 'request', typeRef: PROP_TYPE, payload: encodePropagatorBatchRequest({ epoch: row.requestJd, catalogNumbers: [prepared.omm.noradId], outputFrame: ReferenceFrame.TEME }) }], outputStreamCap: 1 });
          if (result.response.STATUS_CODE !== 0) throw new Error(result.response.ERROR_MESSAGE);
          const state = decodePropagatorState(result.outputPayloads[0].bytes);
          if (!state.valid) throw new Error('WASM returned invalid printed sample');
          wasm.push({ position: state.position, velocity: state.velocity });
        }
      } finally { module._plugin_destroy(); }
      const actual = metrics({ mode: 'score', prepared, wasm });
      const mismatch = metrics({ mode: 'compare', actual, expected: summary.sets[index] });
      check(mismatch.length === 0, `${blocks[index].satnum} block ${index}: replay differs: ${mismatch.join(', ')}`);
      replayed.push({ index, satnum: blocks[index].satnum, method: prepared.method, samples: actual.samples });
    }
    const acceptance = { ...metrics({ mode: 'criteria', summary, blocks: replayed }),
      provenance: { evaluator: 'replay-metrics.cpp', sha256: hash(path.join(here, 'replay-metrics.cpp')),
        reference: 'Authenticated SGP4-VER.TLE and tcppver.out; strict native source and shipped WASM identified by the unchanged summary pins.' } };
    for (const [regime, rows] of Object.entries(acceptance.tables)) for (const [key, row] of Object.entries(rows)) {
      if (!row.met) check(Boolean(causes[key]?.classification && causes[key]?.statement && causes[key]?.evidence?.length), `${regime}/${key}: primary criterion miss has no cause`);
      console.log(`Primary ${regime}/${key}: ${row.met ? 'met' : 'not met'}; ${row.exceeded}/${row.samples} samples exceed the stated criterion.`);
    }
    console.log(`Re-score: all ${replayed.filter((b) => !b.initError).length} propagating sets, ${summary.tables.all.source.samples} printed states; source, module, timeOnly and wasm maxima match within reduction roundoff.`);
    console.log(`Primary counts: ${acceptance.verdict.scored} rows, ${acceptance.verdict.met} met, ${acceptance.verdict.missed} missed; printing remains diagnostic.`);
    if (writing) {
      if (errors.length) throw new Error(`Cannot record acceptance criteria: ${errors.join('; ')}`);
      // Append, never regenerate the original measured fields or their text.
      if (summary.acceptance) {
        const marker = '\n "acceptance": ';
        const start = summaryText.lastIndexOf(marker);
        if (start < 0) throw new Error('Acceptance record is not the final authored field');
        fs.writeFileSync(summaryFile, `${summaryText.slice(0, start)}${marker}${JSON.stringify(acceptance, null, 1).replaceAll('\n', '\n ')}\n}\n`);
      } else {
        fs.writeFileSync(summaryFile, `${summaryText.trimEnd().slice(0, -1).trimEnd()},\n "acceptance": ${JSON.stringify(acceptance, null, 1).replaceAll('\n', '\n ')}\n}\n`);
      }
      console.log('Recorded Vallado acceptance criteria and per-sample evidence; original measured fields unchanged.');
    } else {
      check(JSON.stringify(summary.acceptance) === JSON.stringify(acceptance), 'acceptance criteria, per-sample evidence or verdicts differ; regenerate explicitly with --write-criteria');
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  for (const error of errors) console.error(`FAIL: ${error}`);
  if (!writing) console.log(`${errors.length ? 'FAIL' : 'PASS'} Vallado evidence E2E: ${errors.length} failure(s).`);
  process.exitCode = errors.length ? 1 : 0;
}
await main().catch((error) => { console.error(`FAIL Vallado evidence E2E: ${error.message}`); process.exitCode = 1; });
