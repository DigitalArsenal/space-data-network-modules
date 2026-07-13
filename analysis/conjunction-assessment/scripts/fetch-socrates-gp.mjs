#!/usr/bin/env node
/**
 * Batch-download SOCRATES GP data (JSON) for top N conjunctions.
 *
 * SOCRATES data.php returns the EXACT GP data used for the computation,
 * not the current catalog. This is critical for validation.
 *
 * FETCH POLICY (CELESTRAK_FETCH_POLICY.md): serial, >= 2.5s between network
 * requests (--rate is floor-enforced); NEVER request the same data more than
 * once in a 3-hour period (persistent ledger — --force-refresh does NOT
 * bypass it); abort after 30 consecutive failures. Cache hits make no
 * network request and are always allowed.
 *
 * Usage: node fetch-socrates-gp.mjs [--top N] [--rate MS>=2500]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  defaultCelestrakCacheDir,
  fetchCachedText,
  readCachedText,
} from './lib/celestrakFetchCache.mjs';
import { FetchPolicy, sleep } from './lib/celestrakFetchPolicy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'tests', 'data', 'socrates_gp');

const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i+1] ? args[i+1] : def; };
const TOP = parseInt(getArg('--top', '1000'));
const RATE_MS = FetchPolicy.clampInterval(getArg('--rate', '2500'));
const CACHE_DIR = getArg('--cache-dir', defaultCelestrakCacheDir());
const FORCE_REFRESH = args.includes('--force-refresh');

mkdirSync(DATA_DIR, { recursive: true });
const policy = new FetchPolicy(join(__dirname, '..', 'tests', 'data', '.celestrak-fetch-ledger'));

// Parse SOCRATES CSV
// Use the most recent SOCRATES CSV
const csvPath = existsSync(join(__dirname, '..', 'tests', 'data', 'socrates_current.csv'))
  ? join(__dirname, '..', 'tests', 'data', 'socrates_current.csv')
  : join(__dirname, '..', 'tests', 'data', 'socrates_maxprob.csv');
console.log(`Using CSV: ${csvPath}`);
const csv = readFileSync(csvPath, 'utf8');
const lines = csv.trim().split('\n');
const header = lines[0].split(',');

const pairs = [];
const seen = new Set();

for (let i = 1; i < lines.length && pairs.length < TOP; i++) {
  const fields = [];
  let current = '', inQ = false;
  for (const ch of lines[i]) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { fields.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  fields.push(current.trim());

  const id1 = fields[0], id2 = fields[3];
  const key = `${id1},${id2}`;
  if (!seen.has(key)) {
    seen.add(key);
    pairs.push({ id1, id2 });
  }
}

console.log(`Fetching GP data for ${pairs.length} SOCRATES pairs...`);
console.log(`Output: ${DATA_DIR}`);
console.log(`Cache: ${CACHE_DIR}`);
console.log(`Policy: serial ${RATE_MS}ms between network requests, 3h same-key ledger, halt after 30 consecutive failures.\n`);

let downloaded = 0, cached = 0, errors = 0, ledgerSkipped = 0;

for (let i = 0; i < pairs.length; i++) {
  const { id1, id2 } = pairs[i];
  const outFile = join(DATA_DIR, `gp_${id1},${id2}.json`);

  if (existsSync(outFile)) {
    cached++;
    continue;
  }

  const url = `https://celestrak.org/SOCRATES/data.php?CATNR=${id1},${id2}&FORMAT=json`;
  const cacheOpts = { cacheDir: CACHE_DIR, extension: 'json' };
  try {
    let text;
    let fromNetwork = false;
    if (!FORCE_REFRESH) {
      try { text = await readCachedText(url, cacheOpts); } catch { /* cache miss */ }
    }
    if (text === undefined) {
      // Network attempt: the 3-hour rule applies (even with --force-refresh).
      if (!policy.allowed(url)) { ledgerSkipped++; continue; }
      ({ text } = await fetchCachedText(url, {
        ...cacheOpts,
        forceRefresh: FORCE_REFRESH,
        headers: {
          'user-agent': 'OrbPro-SOCRATES-Validation/1.0',
          accept: 'application/json, */*;q=0.1',
        },
      }));
      fromNetwork = true;
    }
    const data = JSON.parse(text);
    if (!data || data.length < 2) throw new Error(`Only ${data?.length || 0} objects`);
    writeFileSync(outFile, text);
    if (fromNetwork) {
      policy.record(url);
      policy.noteSuccess();
      await sleep(RATE_MS);
    }
    downloaded++;
  } catch (e) {
    errors++;
    policy.noteFailure(`${id1},${id2}`); // throws + aborts the run at the halt threshold
    if (errors <= 10) console.error(`  ✗ ${id1},${id2}: ${e.message}`);
    await sleep(RATE_MS);
  }

  if ((downloaded + errors) % 100 === 0 || i === pairs.length - 1) {
    console.log(`  [${i+1}/${pairs.length}] ${downloaded} downloaded, ${cached} cached, ${ledgerSkipped} ledger-skipped, ${errors} errors`);
  }
}

console.log(`\nDone: ${downloaded} downloaded, ${cached} cached, ${ledgerSkipped} ledger-skipped, ${errors} errors`);
console.log(`Total GP files: ${downloaded + cached}`);
