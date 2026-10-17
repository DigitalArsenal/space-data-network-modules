#!/usr/bin/env node
// Migrate reference-record pins after an identifier-only rename. Every changed
// pin requires authenticated previous bytes and an exact text transformation;
// foreign reference engines are not rerun, and their original pins are retained.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const { values: options } = parseArgs({ options: {
  'previous-root': { type: 'string' }, 'previous-module': { type: 'string' },
} });
if (!options['previous-root'] || !options['previous-module'])
  throw new Error('Provide --previous-root and --previous-module for authenticated previous source bytes.');
const previousRoot = path.resolve(options['previous-root']);
const previousName = options['previous-module'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const replacements = [[previousName.toUpperCase(), 'FFM'],
  [previousName[0].toUpperCase() + previousName.slice(1), 'Ffm'], [previousName, 'ffm'],
  ['centered'.replace('ere', 're'), 'centered'],
  ...['meters', 'meter', 'kilometers', 'kilometer', 'centers', 'center']
    .map((word) => [word.replace('er', 're'), word]),
  ['modeling'.replace('l', 'll'), 'modeling'], ['behavior'.replace('or', 'our'), 'behavior']];
const transform = (text) => replacements.reduce((value, [from, to]) => value.replaceAll(from, to), text);
const oldPath = (file) => path.join(previousRoot, path.relative(root, file).replaceAll('ffm', previousName));
function migration(file, recorded) {
  const current = fs.readFileSync(file), checksum = hash(current);
  if (checksum === recorded) return null;
  let previous = fs.readFileSync(oldPath(file));
  if (hash(previous) !== recorded && file.endsWith('.json')) {
    // Some reference records already gained historical-source annotations.
    // Recover their exact prior serialization using original string spellings;
    // the recorded checksum must authenticate the entire recovered document.
    const spellings = new Map();
    const collect = (value) => {
      if (typeof value === 'string') spellings.set(transform(value), value);
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
        spellings.set(transform(key), key); collect(item);
      }
    };
    collect(JSON.parse(previous));
    previous = Buffer.from(current.toString('utf8').replace(/"(?:\\.|[^"\\])*"/g, (token) => {
      const value = JSON.parse(token);
      return spellings.has(value) ? JSON.stringify(spellings.get(value)) : token;
    }));
  }
  if (hash(previous) !== recorded) throw new Error(`Previous bytes do not authenticate the recorded pin: ${file}`);
  if (transform(previous.toString('utf8')) !== current.toString('utf8'))
    throw new Error(`Changes exceed identifiers and spelling: ${file}`);
  return { previousSha256: recorded, sha256: checksum };
}
const exportFile = path.join(here, 'cases/ffm-reference-cases.json');
const records = ['gmat/gmat-R2026a.json', 'gmat/gmat-R2022a.json', 'nyx/nyx-2.6.0.json',
  'tudat/tudatpy-1.0.0.json', 'tudat/tudatpy-1.0.0-fine.json', 'tudat/tudatpy-1.0.0-stm.json',
  'basilisk/basilisk-2.12.0.json', 'basilisk/basilisk-wgs84-diagnostic.json',
  'basilisk/basilisk-wgs84-gtd7d-diagnostic.json', 'basilisk/lst-probes.json'];
const writes = [];
const initialHashes = new Map();
for (const name of records) {
  const file = path.join(here, name), directory = path.dirname(file);
  const bytes = fs.readFileSync(file);
  initialHashes.set(file, hash(bytes));
  const record = JSON.parse(bytes);
  const changes = [];
  const exportChange = migration(exportFile, record.caseExportSha256);
  if (exportChange) {
    record.caseExportSha256 = exportChange.sha256;
    changes.push({ path: path.relative(directory, exportFile), ...exportChange });
  }
  if (name === 'nyx/nyx-2.6.0.json') {
    const lock = path.join(directory, 'Cargo.lock');
    const changed = migration(lock, record.tool.cargoLockSha256);
    if (changed) {
      record.tool.cargoLockSha256 = changed.sha256;
      changes.push({ path: 'Cargo.lock', ...changed });
    }
  }
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.sha256 === 'string' && typeof (value.path ?? value.file) === 'string') {
      const target = path.resolve(directory, value.path ?? value.file);
      if (target.startsWith(root + path.sep) && fs.existsSync(target)
          && value.role !== 'historical-source') {
        const changed = migration(target, value.sha256);
        if (changed) {
          value.sha256 = changed.sha256;
          changes.push({ path: path.relative(directory, target), ...changed });
        }
      }
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(record.inputFiles);
  if (changes.length) {
    record.provenance = { ...record.provenance, identifierRename: {
      scope: 'Identifier and American spelling changes only, plus these provenance annotations; each previous source file matched its recorded checksum and transformed exactly to the current file. Reference trajectories were not rerun or changed. Previous input checksums are retained below.',
      files: [...(record.provenance?.identifierRename?.files ?? []), ...changes],
    } };
    writes.push([file, record]);
    console.log(`${name}: ${changes.length} authenticated input-pin migrations; numerical records unchanged.`);
  }
}
// Reference records can pin another record from this same transaction. Bind
// those links to its completed provenance document, preserving the prior pin.
const completed = new Map();
for (const [file, record] of writes) {
  for (const pin of Array.isArray(record.inputFiles) ? record.inputFiles : []) {
    const target = path.resolve(path.dirname(file), pin.path ?? pin.file ?? '');
    if (!completed.has(target)) continue;
    if (pin.sha256 !== initialHashes.get(target))
      throw new Error(`Reference-record link did not authenticate before migration: ${target}`);
    pin.sha256 = hash(completed.get(target));
    const proof = record.provenance.identifierRename.files.find((entry) =>
      path.resolve(path.dirname(file), entry.path) === target);
    if (!proof) throw new Error(`Missing reference-record migration proof: ${target}`);
    proof.sha256 = pin.sha256;
  }
  completed.set(file, JSON.stringify(record, null, 1) + '\n');
}
// Validate the complete migration before replacing any reference record.
for (const [file, contents] of completed) fs.writeFileSync(file, contents);
