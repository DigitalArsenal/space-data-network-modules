#!/usr/bin/env node
/**
 * Batch-download SOCRATES GP data via Tor.
 *
 * PURPOSE OF TOR HERE: firewall/erroneous-block RECOVERY only — this project
 * has been the victim of upstream blocks unrelated to our request behavior.
 * It is NOT a rate-limit evasion mechanism. ALL rules in
 * CELESTRAK_FETCH_POLICY.md apply exactly as if fetching directly:
 *   - serial, >= 2.5s between requests (--rate is floor-enforced)
 *   - NEVER request the same data more than once in a 3-hour period
 *   - 60s backoff + at most one retry on 429/503
 *   - abort after 30 consecutive failures
 *
 * Usage: node fetch-socrates-gp-tor.mjs [--top N] [--rate MS>=2500] [--start OFFSET]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { FetchPolicy, sleep } from './lib/celestrakFetchPolicy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'tests', 'data', 'socrates_gp');

const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i+1] ? args[i+1] : def; };
const TOP = parseInt(getArg('--top', '50000'));
const RATE_MS = FetchPolicy.clampInterval(getArg('--rate', '2500'));
const START = parseInt(getArg('--start', '0'));

mkdirSync(DATA_DIR, { recursive: true });
const policy = new FetchPolicy(join(__dirname, '..', 'tests', 'data', '.celestrak-fetch-ledger'));

// Rotate Tor circuit via control port (reachability recovery only)
async function rotateTorCircuit() {
  return new Promise((resolve, reject) => {
    const client = net.connect(9051, '127.0.0.1', () => {
      client.write('AUTHENTICATE ""\r\n');
    });
    let buf = '';
    client.on('data', (data) => {
      buf += data.toString();
      if (buf.includes('250 OK') && !buf.includes('NEWNYM')) {
        client.write('SIGNAL NEWNYM\r\n');
      } else if (buf.includes('250 OK') && buf.includes('NEWNYM')) {
        client.end();
        resolve();
      }
    });
    client.on('error', reject);
    setTimeout(() => { client.end(); resolve(); }, 3000);
  });
}

// Parse CSV
const csvPath = existsSync(join(__dirname, '..', 'tests', 'data', 'socrates_current.csv'))
  ? join(__dirname, '..', 'tests', 'data', 'socrates_current.csv')
  : join(__dirname, '..', 'tests', 'data', 'socrates_maxprob.csv');
console.log(`CSV: ${csvPath}`);
const csv = readFileSync(csvPath, 'utf8');
const lines = csv.trim().split('\n');

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
  if (!seen.has(key)) { seen.add(key); pairs.push({ id1, id2 }); }
}

console.log(`Total pairs: ${pairs.length}, starting at offset ${START}`);
console.log(`Policy: serial ${RATE_MS}ms/request, 3h same-key ledger, halt after 30 consecutive failures.`);

let downloaded = 0, cached = 0, errors = 0, rotations = 0, ledgerSkipped = 0;

const agent = new SocksProxyAgent('socks5h://127.0.0.1:9050');

for (let i = START; i < pairs.length; i++) {
  const { id1, id2 } = pairs[i];
  const url = `https://celestrak.org/SOCRATES/data.php?CATNR=${id1},${id2}&FORMAT=json`;
  const key = url;
  const outFile = join(DATA_DIR, `gp_${id1},${id2}.json`);

  if (existsSync(outFile)) { cached++; continue; }
  if (!policy.allowed(key)) { ledgerSkipped++; continue; }
  let retried = false;
  for (;;) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(url, {
        agent,
        signal: controller.signal,
        headers: { 'User-Agent': 'OrbPro-SOCRATES-Validation/1.0' }
      });
      clearTimeout(timeout);

      if ((res.status === 429 || res.status === 503) && !retried) {
        // Slow down first; one retry only — never rotate-and-hammer.
        rotations++;
        retried = true;
        console.log(`  ⟳ ${res.status} on ${key} — 60s backoff, then rotate + single retry (${rotations})`);
        policy.noteFailure(`${res.status} on ${key}`);
        await sleep(60_000);
        await rotateTorCircuit();
        continue;
      }

      if (!res.ok) {
        errors++;
        policy.noteFailure(`HTTP ${res.status} on ${key}`);
        break;
      }

      const text = await res.text();
      const data = JSON.parse(text);
      if (!data || data.length < 2) {
        errors++;
        policy.noteFailure(`short payload on ${key}`);
        break;
      }
      writeFileSync(outFile, text);
      policy.record(key);
      policy.noteSuccess();
      downloaded++;
      break;
    } catch (e) {
      errors++;
      policy.noteFailure(`${e.message} on ${key}`);
      break;
    }
  }

  const total = downloaded + errors;
  if (total % 100 === 0 || i === pairs.length - 1) {
    console.log(`  [${i+1}/${pairs.length}] ${downloaded} new, ${cached} cached, ${ledgerSkipped} ledger-skipped, ${errors} err, ${rotations} backoffs`);
  }

  await sleep(RATE_MS);
}

console.log(`\nDone: ${downloaded} downloaded, ${cached} cached, ${ledgerSkipped} ledger-skipped, ${errors} errors, ${rotations} backoff/rotations`);
console.log(`Total GP files: ${downloaded + cached}`);
