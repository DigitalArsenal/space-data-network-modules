#!/usr/bin/env node
// Diagnostic evidence, not a test: use the already-built published-MSIS Nyx
// runner with its corrected planetary-data WGS84 ellipsoid. Cached stock Nyx
// remains the table of record. No physics is implemented in JavaScript.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CASES, ALL, buildMetrics, run, reference, scoreResponse, sha256 } from './scoring.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(process.argv[2]);
const out = path.join(here, 'drag-settings-diagnostic.json');
const repo = path.resolve(here, '../../../../..');
const work = fs.mkdtempSync(path.join(here, '.drag-settings-'));
try {
  const metrics = buildMetrics(work);
  const input = metrics({ mode: 'nyx-drag-input', casesExport: CASES, scratch, repo });
  const binary = path.join(scratch, 'target/release/ffm-xval-nyx-msis');
  const invoke = (request) => JSON.parse(execFileSync(binary, { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 64 << 20 }));
  const raw = invoke(input);
  const { cases: trajectories } = metrics({ mode: 'nyx-samples-si', cases: raw.cases });
  const stock = JSON.parse(fs.readFileSync(path.join(here, 'nyx-2.6.0.json'), 'utf8'));
  const published = JSON.parse(fs.readFileSync(path.join(scratch, 'out/nyx-2.6.0-msis-published.json'), 'utf8'));
  const cases = [];
  for (const c of trajectories) {
    const g = stock.cases.find((r) => r.id === c.id);
    const old = published.cases.find((r) => r.id === c.id);
    const ffm = await run(g, ALL[2]);
    const compare = (samples) => metrics({ mode: 'positions', positions: samples.slice(1).map((s) => s.slice(1, 4)), scale: 1, samples: c.samples });
    const row = { id: c.id, finest: scoreResponse(ffm, c, metrics), cachedPublishedMinusWgs84: compare(old.samples), stockMinusWgs84: compare(g.samples), orekitMinusWgs84: compare(reference(g).samples) };
    row.finest.met = row.finest.worstM <= CASES.protocol.tolerancesM.default.drag;
    cases.push(row);
    console.error(`${c.id}: published MSIS + WGS84 ${row.finest.worstM} m; cached published change ${row.cachedPublishedMinusWgs84.worstM} m`);
  }
  // The same GCRF initial state through ANISE with PCA's default shape, and
  // with the case GM present (which activates the runner's WGS84 correction).
  const geo = { mode: 'geodetic', kernel: input.kernel, pca: input.pca, bpc: input.bpc, states: [{ utc: input.cases[0].epochs[0], state: input.cases[0].state }] };
  const geodetic = { pcaDefault: invoke(geo).rows[0], wgs84: invoke({ ...geo, gmKm3S2: input.gmKm3S2 }).rows[0] };
  fs.writeFileSync(out, `${JSON.stringify({
    note: 'Diagnostic rerun of all eight supported drag cases using the prebuilt two-line published-MSIS variant and the current runner, which corrects ANISE planetary-data Earth shape to WGS84. FFM finest; 24 hourly propagated samples on UTC 2026-08-02/03, GCRF, meters, tolerance 0.1 m from the unmodified shared protocol. Stock/cached published evidence is preserved.',
    binary: { file: binary, sha256: sha256(binary) },
    source: { file: 'src/main.rs', sha256: sha256(path.join(here, 'src/main.rs')) },
    input, trajectories, geodetic, cases,
  }, null, 1)}\n`);
  console.error(`-> ${out}`);
} finally { fs.rmSync(work, { recursive: true, force: true }); }
