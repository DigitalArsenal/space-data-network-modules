// Real pinned WasmEdge C API with the standard wasi-threads verification host.
// The SDK parity engine still owns fixture encoding, byte comparison and report.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertWasmEdgeVersionMatchesPin } from 'space-data-module-sdk/testing';
import { packageDir, wasiThreadsLaunchPlan } from '../tests/lib/wasmedgeWasiThreadsRunner.mjs';

function execute(launch, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe','pipe','pipe'] });
    const stdout = [], stderr = [];
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Error(`WasmEdge parity timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', b => stdout.push(b)); child.stderr.on('data', b => stderr.push(b));
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timeout); resolve({code,signal,stdout:new Uint8Array(Buffer.concat(stdout)),stderr:new Uint8Array(Buffer.concat(stderr))}); });
    child.stdin.end(stdin);
  });
}

export function wasmedgeParityLane(runtime) {
  return async context => {
    // Stage the SDK's single loaded byte sequence inside the package so both
    // native and Docker paths read it even if a later source rebuild starts.
    const dir = fs.mkdtempSync(path.join(packageDir, '.sdk-build/parity-'));
    const wasmPath = path.join(dir, 'module.wasm');
    fs.writeFileSync(wasmPath, context.loadableBytes);
    const runs = [];
    try {
      const version = await execute(await wasiThreadsLaunchPlan(runtime, {wasmPath,hostArgs:['--version']}), new Uint8Array(), context.timeoutMs);
      assertWasmEdgeVersionMatchesPin(new TextDecoder().decode(version.stdout), context.pin, `${runtime} standard WASI threads host`);
      for (const c of context.plan.cases) for (const threadCount of c.threadCounts) {
        context.log(`${runtime}: ${c.id} / workers ${threadCount}`);
        const hostArgs = ['--enable-threads', ...Object.entries({...c.env,[context.plan.threadEnvVar]:String(threadCount)}).flatMap(([name,value])=>['--env',`${name}=${value}`])];
        const outcome = await execute(await wasiThreadsLaunchPlan(runtime,{wasmPath,hostArgs,args:c.args}),c.stdinBytes,context.timeoutMs);
        const stderr = new TextDecoder().decode(outcome.stderr);
        const exitClass = outcome.signal || /unreachable|out of bounds|trap|execution failed/i.test(stderr) ? 'trap' : outcome.code === 0 ? 'ok' : 'guest-error';
        const spawnCount = Number(/wasi-thread-spawn count=(\d+)/.exec(stderr)?.[1] ?? 0);
        runs.push({caseId:c.id,threadCount,exitClass,exitDetail:outcome.code===0?null:`exit=${outcome.code}`,stdout:outcome.stdout,stderr:outcome.stderr,spawnCount});
      }
      return runs;
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  };
}
