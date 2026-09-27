// The SDK compiler emits the standard WASI threads ABI, while SDK 0.8.18's
// bundled native test runner implements Emscripten's distinct ABI. Supply only
// the missing verification host; SDK encoding/decoding and guest bytes are used
// unchanged. The source follows WebAssembly/wasi-threads' instance-per-thread
// contract and is compiled against the SDK-pinned WasmEdge C API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { loadWasmEdgePin, resolveWasmEdgeRunnerBuildPlan } from 'space-data-module-sdk/testing';
import { toLoadableWasmBytes } from 'space-data-module-sdk/bundle';

const execFile = promisify(execFileCallback);
export const packageDir = fileURLToPath(new URL('../../', import.meta.url));
const source = fileURLToPath(new URL('../native/wasmedge_wasi_threads_runner.c', import.meta.url));
const cache = path.join(packageDir, '.sdk-build');
let nativePromise;
let dockerPromise;

export async function buildNativeWasiThreadsRunner() {
  return nativePromise ??= (async () => {
    fs.mkdirSync(cache, { recursive: true });
    const outputPath = path.join(cache, 'wasmedge-wasi-threads-runner');
    const plan = resolveWasmEdgeRunnerBuildPlan({ outputPath });
    const stamp = createHash('sha256').update(fs.readFileSync(source)).update(plan.wasmedgeSharedLibraryPath).digest('hex');
    const stampPath = `${outputPath}.sha256`;
    if (!fs.existsSync(outputPath) || !fs.existsSync(stampPath) || fs.readFileSync(stampPath, 'utf8') !== stamp) {
      const temporaryOutput = `${outputPath}.${process.pid}.tmp`;
      await execFile(plan.compilerCommand, plan.compilerArgs.map(value => value === plan.runnerSourcePath ? source : value === outputPath ? temporaryOutput : value), { maxBuffer: 4 * 1024 * 1024 });
      if (process.platform === 'darwin') await execFile('install_name_tool', ['-change', '@rpath/libwasmedge.0.dylib', plan.wasmedgeSharedLibraryPath, temporaryOutput]);
      fs.renameSync(temporaryOutput, outputPath);
      fs.writeFileSync(stampPath, stamp);
    }
    return outputPath;
  })();
}

export async function buildDockerWasiThreadsRunner() {
  return dockerPromise ??= (async () => {
    fs.mkdirSync(cache, { recursive: true });
    const pin = loadWasmEdgePin();
    const output = path.join(cache, 'wasmedge-wasi-threads-runner-linux');
    const stampPath = `${output}.sha256`;
    const stamp = createHash('sha256').update(fs.readFileSync(source)).update(pin.dockerImage).digest('hex');
    if (!fs.existsSync(output) || !fs.existsSync(stampPath) || fs.readFileSync(stampPath, 'utf8') !== stamp) {
      const temporaryOutput = `${output}.${process.pid}.tmp`;
      const script = 'apt-get update -qq && apt-get install -y -qq --no-install-recommends gcc libc6-dev >/dev/null && ' +
        'gcc "$1" -std=c11 -O2 -pthread -Wall -Wextra -Werror -I/opt/wasmedge/include ' +
        '-L/opt/wasmedge/lib64 -L/opt/wasmedge/lib -lwasmedge -Wl,-rpath,/opt/wasmedge/lib64 ' +
        '-Wl,-rpath,/opt/wasmedge/lib -o "$2"';
      await execFile('docker', ['run', '--rm', '--entrypoint', '/bin/sh', '-v', `${packageDir}:/work`, '-w', '/work', pin.dockerImage, '-c', script, 'compile-wasi-threads-host', path.relative(packageDir, source), path.relative(packageDir, temporaryOutput)], { maxBuffer: 4 * 1024 * 1024 });
      fs.renameSync(temporaryOutput, output);
      fs.writeFileSync(stampPath, stamp);
    }
    return { image: pin.dockerImage, output };
  })();
}

// A signed artifact carries an appended $REC publication trailer after its last
// section, which WasmEdge refuses ("malformed section id"). Like the SDK's own
// WasmEdge loader, launch the canonical module payload the signature covers:
// staged once per payload inside the package so the Docker lane's mount sees it.
function loadableWasmPath(wasmPath) {
  const bytes = fs.readFileSync(wasmPath);
  const loadable = toLoadableWasmBytes(bytes);
  if (loadable.byteLength === bytes.byteLength) return wasmPath;
  fs.mkdirSync(cache, { recursive: true });
  const staged = path.join(cache, `loadable-${createHash('sha256').update(loadable).digest('hex').slice(0, 16)}.wasm`);
  if (!fs.existsSync(staged)) {
    const temporary = `${staged}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, loadable);
    fs.renameSync(temporary, staged);
  }
  return staged;
}

export async function wasiThreadsLaunchPlan(runtime, options = {}) {
  const wasmPath = loadableWasmPath(options.wasmPath ?? path.join(packageDir, 'dist/isomorphic/module.wasm'));
  const hostArgs = [...(options.hostArgs ?? []), ...Object.entries(options.guestEnv ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`])];
  if (runtime === 'wasmedge') return { command: await buildNativeWasiThreadsRunner(), args: [...hostArgs, wasmPath, ...(options.args ?? [])], cwd: packageDir, env: process.env };
  if (runtime === 'docker-wasmedge') {
    const { image } = await buildDockerWasiThreadsRunner();
    const relative = path.relative(packageDir, wasmPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Docker verification artifact must be inside the package.');
    return { command: 'docker', args: ['run', '--rm', '--init', '-i', '--entrypoint', '/work/.sdk-build/wasmedge-wasi-threads-runner-linux', '-v', `${packageDir}:/work`, '-w', '/work', image, ...hostArgs, relative, ...(options.args ?? [])], cwd: packageDir, env: process.env };
  }
  throw new Error(`Unsupported WASI threads host runtime: ${runtime}`);
}
