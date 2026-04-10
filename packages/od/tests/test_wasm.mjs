/**
 * Node.js WASM Test Harness for OD SDN Plugin
 *
 * Tests the WASM build of the SGP4 equinoctial fitter against
 * SpaceX MEME ephemeris data and CelesTrak SupGP reference.
 *
 * Usage:
 *   node tests/test_wasm.mjs [meme_dir] [celestrak_csv] [max_files]
 *
 * Default:
 *   meme_dir:      tests/data/meme
 *   celestrak_csv:  tests/data/celestrak_starlink_supgp.csv
 *   max_files:      20
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load WASM module ──

async function loadWasm() {
  const moduleJsPath = join(ROOT, 'dist', 'browser', 'module.js');
  const moduleWasmPath = join(ROOT, 'dist', 'browser', 'module.wasm');
  if (!existsSync(moduleJsPath) || !existsSync(moduleWasmPath)) {
    throw new Error(
      `Browser artifacts not found at ${moduleJsPath} and ${moduleWasmPath}. Run: bash build.sh`
    );
  }

  // Emscripten MODULARIZE output
  const require = createRequire(import.meta.url);
  const ODModuleFactory = require(moduleJsPath);
  const previousExitCode = process.exitCode;
  const Module = await ODModuleFactory({
    print() {},
    printErr() {},
    locateFile(path) {
      return path.endsWith('.wasm') ? moduleWasmPath : path;
    },
  });
  process.exitCode = previousExitCode;
  return Module;
}

// ── Parse CelesTrak CSV ──

function parseCelestrakCSV(path) {
  if (!existsSync(path)) return new Map();
  const lines = readFileSync(path, 'utf-8').split('\n');
  const records = new Map();

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(',');
    if (fields.length < 18) continue;
    const norad = parseInt(fields[11]);
    const rms = parseFloat(fields[17]);
    if (isNaN(norad) || isNaN(rms)) continue;
    records.set(norad, {
      name: fields[0],
      rms,
      bstar: fields[14],
      ndot: fields[15],
    });
  }
  return records;
}

// ── Test runner ──

async function main() {
  const args = process.argv.slice(2);
  const memeDir = args[0] || join(ROOT, 'tests', 'data', 'meme');
  const celestrakCSV = args[1] || join(ROOT, 'tests', 'data', 'celestrak_starlink_supgp.csv');
  const maxFiles = parseInt(args[2] || '20');

  console.log('='.repeat(60));
  console.log('OD SDN Plugin — WASM Node.js Test Harness');
  console.log('='.repeat(60));
  console.log();

  // Load WASM
  console.log('Loading WASM module...');
  const Module = await loadWasm();
  console.log('WASM module loaded ✓');

  // Wrap C functions — use manual memory management for strings
  const _wasm_parse_and_fit = Module.cwrap('wasm_parse_and_fit', 'number', ['number', 'number']);
  const _wasm_parse = Module.cwrap('wasm_parse', 'number', ['number', 'number']);
  const _wasm_fit = Module.cwrap('wasm_fit', 'number', ['number']);
  const _wasm_malloc = Module.cwrap('wasm_malloc', 'number', ['number']);
  const _wasm_free = Module.cwrap('wasm_free', null, ['number']);

  // Helper: allocate string in WASM memory, call fn, read result string, free
  function wasmParseAndFit(content) {
    const len = Module.lengthBytesUTF8(content);
    const ptr = Module._wasm_malloc(len + 1);
    Module.stringToUTF8(content, ptr, len + 1);
    const resultPtr = _wasm_parse_and_fit(ptr, len);
    Module._wasm_free(ptr);
    return Module.UTF8ToString(resultPtr);
  }

  // Load CelesTrak reference
  const celestrak = parseCelestrakCSV(celestrakCSV);
  console.log(`CelesTrak records: ${celestrak.size}`);

  // List MEME files
  if (!existsSync(memeDir)) {
    console.error(`MEME directory not found: ${memeDir}`);
    console.error('Run: cd tests/data/meme && bash ../../../scripts/download-meme.sh . 20');
    process.exit(1);
  }

  let memeFiles = readdirSync(memeDir)
    .filter(f => f.startsWith('MEME_') && f.endsWith('.txt'))
    .sort()
    .slice(0, maxFiles);

  console.log(`MEME files: ${memeFiles.length}`);
  console.log();

  // Run tests
  let total = 0, success = 0, failed = 0, parseErr = 0;
  let betterCount = 0, worseCount = 0;
  const rmsValues = [];
  const timings = [];

  console.log('Running fits...');
  console.log('-'.repeat(60));

  for (const file of memeFiles) {
    total++;
    const content = readFileSync(join(memeDir, file), 'utf-8');

    // Extract NORAD from filename: MEME_NORAD_NAME_...
    const parts = file.split('_');
    const norad = parseInt(parts[1]);

    try {
      const t0 = performance.now();

      // Method 1: parse-and-fit in one call
      const resultJson = wasmParseAndFit(content);

      const t1 = performance.now();
      const elapsed = t1 - t0;
      timings.push(elapsed);

      const result = JSON.parse(resultJson);

      if (result.error) {
        parseErr++;
        console.log(`  ✗ ${file}: ${result.error}`);
        continue;
      }

      const rms = parseFloat(result.RMS);
      if (isNaN(rms) || rms > 50) {
        failed++;
        console.log(`  ✗ ${file}: RMS=${rms} (diverged)`);
        continue;
      }

      success++;
      rmsValues.push(rms);

      // Compare to CelesTrak
      let comparison = '';
      if (celestrak.has(norad)) {
        const ctRms = celestrak.get(norad).rms;
        if (rms <= ctRms) {
          betterCount++;
          comparison = ` ✓ beats CT (${ctRms.toFixed(3)})`;
        } else {
          worseCount++;
          comparison = ` ✗ loses to CT (${ctRms.toFixed(3)})`;
        }
      }

      if (total % 5 === 0 || total === memeFiles.length) {
        const medianRms = rmsValues.length > 0
          ? rmsValues.slice().sort((a, b) => a - b)[Math.floor(rmsValues.length / 2)]
          : 0;
        console.log(`  [${total}/${memeFiles.length}] ${success} ok | median RMS: ${medianRms.toFixed(3)} km | ${elapsed.toFixed(0)} ms${comparison}`);
      }

    } catch (err) {
      failed++;
      console.log(`  ✗ ${file}: ${err.message}`);
    }
  }

  // Statistics
  rmsValues.sort((a, b) => a - b);
  timings.sort((a, b) => a - b);

  const median = rmsValues.length > 0 ? rmsValues[Math.floor(rmsValues.length / 2)] : 0;
  const mean = rmsValues.length > 0 ? rmsValues.reduce((a, b) => a + b) / rmsValues.length : 0;
  const p90 = rmsValues.length > 0 ? rmsValues[Math.floor(rmsValues.length * 0.9)] : 0;
  const p95 = rmsValues.length > 0 ? rmsValues[Math.floor(rmsValues.length * 0.95)] : 0;
  const best = rmsValues.length > 0 ? rmsValues[0] : 0;
  const worst = rmsValues.length > 0 ? rmsValues[rmsValues.length - 1] : 0;

  const medianTime = timings.length > 0 ? timings[Math.floor(timings.length / 2)] : 0;
  const p90Time = timings.length > 0 ? timings[Math.floor(timings.length * 0.9)] : 0;

  console.log();
  console.log('='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));

  console.log();
  console.log('Files:');
  console.log(`  Total:      ${total}`);
  console.log(`  Success:    ${success} (${(100 * success / Math.max(1, total)).toFixed(1)}%)`);
  console.log(`  Failed:     ${failed}`);
  console.log(`  Parse err:  ${parseErr}`);

  console.log();
  console.log('Fit Quality (RMS, km):');
  console.log(`  Best:    ${best.toFixed(3)}`);
  console.log(`  Median:  ${median.toFixed(3)}`);
  console.log(`  Mean:    ${mean.toFixed(3)}`);
  console.log(`  P90:     ${p90.toFixed(3)}`);
  console.log(`  P95:     ${p95.toFixed(3)}`);
  console.log(`  Worst:   ${worst.toFixed(3)}`);

  console.log();
  console.log('Timing (WASM):');
  console.log(`  Median fit:  ${medianTime.toFixed(0)} ms`);
  console.log(`  P90 fit:     ${p90Time.toFixed(0)} ms`);

  if (celestrak.size > 0) {
    console.log();
    console.log('CelesTrak Comparison:');
    console.log(`  Better RMS:  ${betterCount}`);
    console.log(`  Worse RMS:   ${worseCount}`);
    const winRate = 100 * betterCount / Math.max(1, betterCount + worseCount);
    console.log(`  Win rate:    ${winRate.toFixed(1)}%`);
  }

  console.log();
  console.log('='.repeat(60));

  // Assert minimum quality
  const PASS = median < 0.35 && success >= total * 0.9;
  console.log(PASS ? '\n✓ PASS' : '\n✗ FAIL');
  process.exit(PASS ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
