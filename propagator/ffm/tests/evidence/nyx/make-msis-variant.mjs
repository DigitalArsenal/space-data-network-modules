#!/usr/bin/env node
// A diagnostic build of the runner on nyx-space 2.6.0 with its NRLMSISE-00
// brought to the published model (nrlmsise00-published.patch), to show what
// the drag cases' differences come from. Two lines of Nyx's Rust port differ
// from the NRL Fortran (GTSE7/GLOBE7, GTS7) and the C port FFM vendors:
//   - the day-of-year angle rate: Nyx 2*pi/365.25, the model DR = 1.72142E-2
//     (2*pi/365), so every annual and semiannual term is phase-shifted by
//     (doy - phase) * 1.2e-5 rad, about 0.15 day in August;
//   - anomalous oxygen: Nyx skips the factor
//     exp(-ZSHT/ZSHO * (exp(-(z - ZMHO)/ZSHT) - 1)) below ZMHO = 550 km,
//     which the model applies at every height; at 400 km Nyx's anomalous
//     oxygen is 6.6 times the model's.
// Nothing else changes; check-density.mjs and run-nyx.mjs --bin measure the
// effect. Diagnostic only: the results tables use stock Nyx.
//
//   node tests/evidence/nyx/make-msis-variant.mjs <cargo> <work dir>   (prints the binary's path)
//
// Needs the stock crate already unpacked under CARGO_HOME (run-nyx.mjs's
// build does that); builds offline into CARGO_TARGET_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [cargo, workArg] = process.argv.slice(2);
if (!workArg) throw new Error('usage: make-msis-variant.mjs <cargo> <work dir>');
const work = path.resolve(workArg);
const home = process.env.CARGO_HOME ?? path.join(process.env.HOME, '.cargo');
const registry = path.join(home, 'registry/src');
const index = fs.readdirSync(registry).find((d) => fs.existsSync(path.join(registry, d, 'nyx-space-2.6.0')));
if (!index) throw new Error(`nyx-space-2.6.0 not unpacked under ${registry}`);
const crate = path.join(work, 'nyx-space-2.6.0'), runner = path.join(work, 'runner');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(runner, 'src'), { recursive: true });
fs.cpSync(path.join(registry, index, 'nyx-space-2.6.0'), crate, { recursive: true });
execFileSync('patch', ['-p1', '-d', crate, '-i', path.join(here, 'nrlmsise00-published.patch')], { stdio: ['ignore', 'ignore', 'inherit'] });
fs.copyFileSync(path.join(here, 'src/main.rs'), path.join(runner, 'src/main.rs'));
fs.copyFileSync(path.join(here, 'Cargo.lock'), path.join(runner, 'Cargo.lock'));
fs.writeFileSync(path.join(runner, 'Cargo.toml'), `${fs.readFileSync(path.join(here, 'Cargo.toml'), 'utf8')
  .replace('name = "ffm-xval-nyx"', 'name = "ffm-xval-nyx-msis"')}\n[patch.crates-io]\nnyx-space = { path = "../nyx-space-2.6.0" }\n`);
execFileSync(cargo, ['build', '--release', '--offline', '--manifest-path', path.join(runner, 'Cargo.toml')], { stdio: ['ignore', 'ignore', 'inherit'] });
console.log(path.join(process.env.CARGO_TARGET_DIR ?? path.join(runner, 'target'), 'release/ffm-xval-nyx-msis'));
