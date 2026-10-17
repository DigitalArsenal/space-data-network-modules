// Support for part (v) of propagator/ffm/tests/e2e-ffm-rename.mjs. This module
// has no standalone test entry. Native ERFA/C++ owns all reference physics,
// differences and numerical verdicts; JavaScript transports arrays only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { composeErfaTranslationUnit, ERFA_ROOT } from '../../../foundation/frames/erfa-amalgamation.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const checkout = path.resolve(packageRoot, '../..');

export async function checkTargetingFrameConversion({ workDir }) {
  if (!workDir) throw new Error('A worktree directory is required for the ERFA reference.');
  const base = path.resolve(workDir);
  const relative = path.relative(checkout, base);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The ERFA reference work directory must be inside this checkout.');
  }
  fs.mkdirSync(base, { recursive: true });
  const work = fs.mkdtempSync(path.join(base, 'targeting-erfa-'));
  const log = path.join(base, 'targeting-frame-reference.log');
  const environment = { ...process.env, TMPDIR: work, TMP: work, TEMP: work };
  const execute = (command, args, input) => {
    const result = spawnSync(command, args, {
      cwd: work, env: environment, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    fs.appendFileSync(log, `${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`ERFA reference exited ${result.status}: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  let harness;
  try {
    fs.writeFileSync(log, 'Targeting WASM ingest against independent native ERFA C.\n');
    const source = path.join(work, 'erfa-all.cpp');
    fs.writeFileSync(source, (await composeErfaTranslationUnit()).source);
    const executable = path.join(work, 'frame-reference');
    execute('c++', ['-std=c++17', '-O2', '-ffp-contract=off', '-I', ERFA_ROOT,
      source, path.join(packageRoot, 'tests/ffm-frame-reference.cpp'), '-o', executable]);
    const fixtures = JSON.parse(execute(executable, ['--fixtures']));
    harness = await createBrowserModuleHarness({
      wasmSource: fs.readFileSync(path.join(packageRoot, 'dist/isomorphic/module.wasm')),
      surface: 'direct',
    });
    const exports = harness.instance.exports;
    if (typeof exports.plugin_reference_ingest_gcrf !== 'function') {
      throw new Error('Targeting artifact lacks the shared ingest conversion diagnostic; rebuild targeting.');
    }
    const candidate = exports.plugin_alloc(16);
    const input = exports.plugin_alloc(56);
    const output = exports.plugin_alloc(48);
    const finish = exports.plugin_alloc(88);
    const rows = [];
    try {
      new Float64Array(harness.memory.buffer, candidate, 2).set([2425.73, 0]);
      for (const fixture of fixtures) {
        new Float64Array(harness.memory.buffer, input, 7).set(fixture.state);
        const ingestStatus = exports.plugin_reference_ingest_gcrf(input, output);
        if (ingestStatus !== 0) throw new Error(`${fixture.id}: targeting ingest returned ${ingestStatus}`);
        const finishStatus = exports.plugin_reference_finish(candidate, input, finish);
        if (finishStatus !== 0) throw new Error(`${fixture.id}: targeting finish returned ${finishStatus}`);
        rows.push([...new Float64Array(harness.memory.buffer, output, 6),
          ...new Float64Array(harness.memory.buffer, finish, 11)]);
      }
    } finally {
      for (const pointer of [candidate, input, output, finish]) exports.plugin_free(pointer);
    }
    const result = JSON.parse(execute(executable, ['--compare'], rows.map((row) => row.join(' ')).join('\n')));
    fs.writeFileSync(path.join(base, 'targeting-frame-reference.json'), `${JSON.stringify(result, null, 2)}\n`);
    return {
      pass: result.pass,
      evidence: `${result.caseCount} ECEF->GCRF states; native ERFA reference; max position error=${result.positionErrorM} m <= ${result.positionLimitM} m; velocity=${result.velocityErrorMPerS} m/s <= ${result.velocityLimitMPerS} m/s; actual finish radius error=${result.finishRadiusErrorM} m, inclination error=${result.finishInclinationErrorRad} rad; UTC JD, UT1=UTC, classical FK5, zero polar motion; tolerance covers native/WASM roundoff`,
      result,
    };
  } finally {
    if (harness) await harness.destroy();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
