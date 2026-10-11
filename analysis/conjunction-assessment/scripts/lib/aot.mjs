// WasmEdge ahead-of-time compilation of the module, as SDN nodes run it: the
// module's sections, without the appended signature trailer (which AOT
// compilers do not read), compiled to a universal wasm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** The path of the AOT-compiled module. `compiler` is wasmedgec or a compiler taking (in, out). */
export function aotModule(wasmPath, compiler, args = ['--enable-threads']) {
  const bytes = fs.readFileSync(wasmPath);
  let at = 8;
  while (at < bytes.length && bytes[at] <= 13) {
    let p = at + 1, size = 0, shift = 0;
    for (;;) { const x = bytes[p++]; size |= (x & 0x7f) << shift; shift += 7; if (!(x & 0x80)) break; }
    at = p + size;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-aot-'));
  fs.writeFileSync(path.join(dir, 'module.wasm'), bytes.subarray(0, at));
  execFileSync(compiler, [...args, path.join(dir, 'module.wasm'), path.join(dir, 'module.aot.wasm')], { stdio: 'ignore' });
  return path.join(dir, 'module.aot.wasm');
}
