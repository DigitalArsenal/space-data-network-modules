#!/usr/bin/env node
// E2E (modules-apache-2-license-20261024): the public modules repo is Apache-2.0 throughout
// (owner 2026-10-24: "Apache 2.0 for all of it"), and the third-party code in it keeps its own
// license, listed in NOTICE. Reads the tracked files of this checkout; no network, no build.
//   1. LICENSE is the canonical Apache License 2.0 text (SHA-256 of apache.org's LICENSE-2.0.txt).
//   2. NOTICE opens with the copyright line of Edgesource Corporation, never Digital Arsenal.
//   3. Every package.json of ours declares Apache-2.0 or a listed SPDX expression; a package that
//      is not private must declare one. An expression names only licenses that a NOTICE row
//      inside the package carries.
//   4. Every third_party/, vendor/ and deps/ directory has a NOTICE row, and each NOTICE row's
//      path exists and its license text exists and carries that license's terms.
//   5. No tracked file says UNLICENSED.
// usage: node scripts/license-check.e2e.mjs
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// https://www.apache.org/licenses/LICENSE-2.0.txt, 11,358 bytes.
const APACHE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const NOTICE_LINE = 'Space Data Network modules. Copyright 2026 Edgesource Corporation. Licensed under the Apache License 2.0.';

/** Directory names that hold third-party code; the unit is the child directory, else the directory. */
const CONTAINERS = new Set(['third_party', 'vendor', 'deps']);

/** The SPDX expressions a package.json may declare besides Apache-2.0. */
const EXPRESSIONS = {
  // A C++ port of the MIT-licensed UzTak/star-search; its LICENSE ships in vendor/.
  'maneuver/star-search/package.json': 'Apache-2.0 AND MIT',
};

/** Paths another task holds, so this task leaves them; their UNLICENSED is reported, not failed. */
const HELD = {
  'propagator/ffm/': 'modules-ffm-planetary-gravity-20261024',
};

/** Third-party paths whose terms are open. Each prints on every run. */
const OPEN = {
  'analysis/od/src/cpp/deps/vallado-sgp4/': 'no license text in the tree, and none in the file headers',
  'third_party/hwm14/': 'the repository treats it as a U.S. Government work; the publisher lists CC BY-NC-ND for the article and its supporting information (NOTICE.md)',
};

/** What each license's text must say, on text with comment marks and line breaks removed. */
const TERMS = {
  'Apache-2.0': /Apache License Version 2\.0, January 2004/,
  'MIT': /Permission is hereby granted, free of charge, to any person obtaining a copy/,
  'BSD-3-Clause': /Redistribution and use in source and binary forms.*Neither the name of/,
  'ISC': /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/,
  'Unlicense': /This is free and unencumbered software released into the public domain/,
  'LicenseRef-USSF-SGP4': /OPEN SOURCE AGREEMENT for SGP4/,
  'LicenseRef-Public-Domain': /disclaims copyright|public domain/i,
  'LicenseRef-US-Government-Work': /17 U\.S\.C\. 105/,
  'LicenseRef-Unstated': null,
};

const failures = [];
const ok = (what) => console.log(`ok    ${what}`);
const note = (what) => console.log(`note  ${what}`);
const fail = (what) => { failures.push(what); console.log(`FAIL  ${what}`); };

const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
const files = git('ls-files', '-z').split('\0').filter((f) => f && fs.existsSync(path.join(root, f)));
const fileSet = new Set(files);
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const plain = (text) => text.split('\n').map((l) => l.replace(/^[\s*#/]+/, '')).join(' ').replace(/\s+/g, ' ');
const heldBy = (f) => Object.keys(HELD).find((prefix) => f.startsWith(prefix));
const exists = (p) => (p.endsWith('/') ? files.some((f) => f.startsWith(p)) : fileSet.has(p));

/** The third-party unit a tracked file belongs to, or null. */
function unitOf(file) {
  const parts = file.split('/');
  const at = parts.findIndex((p, i) => i < parts.length - 1 && CONTAINERS.has(p));
  if (at < 0) return null;
  return `${parts.slice(0, at + 2 < parts.length ? at + 2 : at + 1).join('/')}/`;
}

// 1. LICENSE
{
  const sha = createHash('sha256').update(fs.readFileSync(path.join(root, 'LICENSE'))).digest('hex');
  if (sha === APACHE_SHA256) ok(`LICENSE is the Apache License 2.0 (sha256 ${sha.slice(0, 8)}...${sha.slice(-6)})`);
  else fail(`LICENSE sha256 ${sha}, not the canonical Apache License 2.0 ${APACHE_SHA256}`);
}

// 2. NOTICE
const notice = read('NOTICE');
if (notice.split('\n')[0] === NOTICE_LINE) ok('NOTICE opens with the Edgesource Corporation copyright line');
else fail(`NOTICE must open with: ${NOTICE_LINE}`);
if (/digital ?arsenal/i.test(notice)) fail('NOTICE names Digital Arsenal; the copyright holder is Edgesource Corporation');

const rows = notice.split('\n').filter((l) => l.startsWith('|')).map((l) => l.slice(1, -1).split('|').map((c) => c.trim()))
  .filter((c) => c.length === 4 && c[0] !== 'Path' && !/^-+$/.test(c[0]))
  .map(([paths, component, license, texts]) => ({
    paths: paths.split(/,\s*/),
    component,
    license,
    ids: license.split(/ (?:AND|OR) /),
    any: / OR /.test(license),
    texts: texts === 'none in tree' ? [] : texts.split(/,\s*/),
  }));

// 3. packages
{
  const manifests = files.filter((f) => /(^|\/)package\.json$/.test(f) && !unitOf(f));
  let audited = 0;
  const heldSeen = new Set();
  for (const f of manifests) {
    const pkg = JSON.parse(read(f));
    if (!pkg.name) continue; // a type marker for generated files, not a package
    audited += 1;
    const dir = path.dirname(f);
    const held = heldBy(f);
    if (held) heldSeen.add(held);
    if (pkg.license === undefined) {
      if (!pkg.private) fail(`${f}: a published package declares no license`);
    } else if (pkg.license === 'Apache-2.0') {
      // the repository license
    } else if (EXPRESSIONS[f] === pkg.license) {
      for (const id of pkg.license.split(/ (?:AND|OR) /).filter((x) => x !== 'Apache-2.0')) {
        const carried = rows.some((r) => r.ids.includes(id) && r.paths.some((p) => p.startsWith(`${dir}/`)));
        if (!carried) fail(`${f}: declares ${id} but no NOTICE row inside ${dir}/ carries it`);
      }
    } else if (held) {
      note(`${f}: declares ${JSON.stringify(pkg.license)}; held by ${HELD[held]}`);
    } else {
      fail(`${f}: license ${JSON.stringify(pkg.license)} is neither Apache-2.0 nor a listed expression`);
    }
  }
  ok(`${audited} packages audited`);
}

// 4. third-party directories and NOTICE rows
{
  const units = [...new Set(files.map(unitOf).filter(Boolean))].sort();
  for (const unit of units) {
    if (!rows.some((r) => r.paths.some((p) => p.endsWith('/') && unit.startsWith(p)))) fail(`${unit}: third-party directory without a NOTICE row`);
  }
  for (const row of rows) {
    const where = row.paths[0];
    for (const p of row.paths) if (!exists(p)) fail(`NOTICE row ${where}: ${p} does not exist`);
    for (const id of row.ids) if (!(id in TERMS)) fail(`NOTICE row ${where}: unknown license identifier ${id}`);
    if (row.texts.length === 0) {
      if (!row.paths.every((p) => p in OPEN)) fail(`NOTICE row ${where}: no license text, and the path is not listed as open`);
      continue;
    }
    const missing = row.texts.filter((t) => !fileSet.has(t));
    if (missing.length) { fail(`NOTICE row ${where}: license text ${missing.join(', ')} does not exist`); continue; }
    const text = plain(row.texts.map(read).join('\n'));
    const carries = (id) => TERMS[id] && TERMS[id].test(text);
    if (!(row.any ? row.ids.some(carries) : row.ids.every(carries))) {
      fail(`NOTICE row ${where}: ${row.texts.join(', ')} does not carry the ${row.license} terms`);
    }
  }
  for (const [p, why] of Object.entries(OPEN)) {
    if (rows.some((r) => r.paths.includes(p))) note(`open: ${p}: ${why}`);
    else fail(`${p} is listed as open in the E2E but has no NOTICE row`);
  }
  ok(`${units.length} third-party directories and ${rows.length} NOTICE rows checked`);
}

// 5. UNLICENSED
{
  let hits = [];
  try {
    hits = git('grep', '-l', '-I', '-w', '-e', 'UNLICENSED', '--', '.', ':!scripts/license-check.e2e.mjs').split('\n').filter(Boolean);
  } catch (error) {
    if (error.status !== 1) throw error; // git grep exits 1 for no match
  }
  const own = hits.filter((f) => !heldBy(f));
  for (const f of own) fail(`${f} says UNLICENSED`);
  for (const [prefix, task] of Object.entries(HELD)) {
    const held = hits.filter((f) => f.startsWith(prefix));
    if (held.length) note(`${held.join(', ')} say UNLICENSED; held by ${task}`);
    else note(`${prefix} no longer says UNLICENSED; remove it from HELD in this script`);
  }
  if (own.length === 0) ok('no file of this task says UNLICENSED');
}

if (failures.length) {
  console.log(`\nFAIL (${failures.length})`);
  process.exit(1);
}
console.log('\nPASS');
