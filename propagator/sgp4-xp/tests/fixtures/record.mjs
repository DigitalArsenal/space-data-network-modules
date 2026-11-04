#!/usr/bin/env node
// Records the fixtures of tests/ocm-record.e2e.mjs from this directory's dist (PROVENANCE.md):
//   xp-fit-current.oem  block 1's states are the set below flown by `propagate` at block 1's own epochs; block 2 (NASA's
//                       ISS ephemeris) and every other field are kept as they are
//   xp-fit-current.ocm  the two size-prefixed $OCM that `fit` writes for that $OEM
//   xp-fit-current.omm  the ingest_omm input: the two foreign SGP4XP $OMM, their elements set to the fitted $OCM's
//                       (BTERM in BSTAR, AGOM in MEAN_MOTION_DDOT), their free-form list kept for the refusal by count
// The module computes every state and every fit; this script moves bytes.
//   cd propagator/sgp4-xp && node tests/fixtures/record.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import * as E from 'spacedatastandards.org/lib/js/OEM/main.js';
import * as O from 'spacedatastandards.org/lib/js/OCM/main.js';
import * as M from 'spacedatastandards.org/lib/js/OMM/main.js';
import { loadModule } from '../lib/module.mjs';
import { frame, ocmBytes, readOem } from '../lib/sds.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const SET = { epoch: '2024-04-09T12:00:00.000000', meanMotion: 15.5, eccentricity: 0.0006317, inclination: 51.64, raan: 208.9163, argPerigee: 69.9862, meanAnomaly: 25.2906, bterm: 0.005, agom: 0.01, norad: 25544, name: 'ISS', id: '1998-067A' };
const records = (bytes) => { const out = []; for (let at = 0; at < bytes.length;) { const n = bytes.readUInt32LE(at); out.push(new Uint8Array(bytes.subarray(at, at + 4 + n))); at += 4 + n; } return out; };
const bb = (bytes) => new flatbuffers.ByteBuffer(new Uint8Array(bytes));
const packed = (finish, t) => { const b = new flatbuffers.Builder(1 << 16); finish(b, t.pack(b)); return Buffer.from(b.asUint8Array()); };

const module = await loadModule();
try {
  const oem = E.OEM.getSizePrefixedRootAsOEM(bb(fs.readFileSync(here('xp-fit-current.oem')))).unpack();
  const block = oem.EPHEMERIS_DATA_BLOCK[0];
  const grid = packed((b, o) => E.OEM.finishSizePrefixedOEMBuffer(b, o), Object.assign(new E.OEMT(), {
    EPHEMERIS_DATA_BLOCK: [Object.assign(new E.ephemerisDataBlockT(), { CENTER_NAME: 'EARTH', EPHEMERIS_DATA_LINES: block.EPHEMERIS_DATA_LINES.map((l) => Object.assign(new E.ephemerisDataLineT(), { EPOCH: l.EPOCH })) })],
  }));
  const flown = await module.invoke('propagate', [frame('ocm', 'OCM', ocmBytes(SET)), frame('grid', 'OEM', grid)]);
  const states = readOem(flown.ephemeris[0]).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  if (states.length !== block.EPHEMERIS_DATA_LINES.length) throw new Error(`propagate returned ${states.length} of ${block.EPHEMERIS_DATA_LINES.length} states`);
  block.EPHEMERIS_DATA_LINES.forEach((l, i) => { for (const k of ['X', 'Y', 'Z', 'X_DOT', 'Y_DOT', 'Z_DOT']) l[k] = states[i][k]; });
  const oemOut = packed((b, o) => E.OEM.finishSizePrefixedOEMBuffer(b, o), oem);
  fs.writeFileSync(here('xp-fit-current.oem'), oemOut);

  const fitted = await module.invoke('fit', [frame('ephemeris', 'OEM', oemOut)]);
  const sets = fitted.elements;
  fs.writeFileSync(here('xp-fit-current.ocm'), Buffer.concat(sets.map((s) => Buffer.from(s))));

  const omms = records(fs.readFileSync(here('xp-fit-current.omm'))).map((r) => M.OMM.getSizePrefixedRootAsOMM(bb(r)).unpack());
  if (omms.length !== sets.length) throw new Error(`${omms.length} $OMM for ${sets.length} fits`);
  const out = omms.map((t, k) => {
    const me = O.OCM.getSizePrefixedRootAsOCM(bb(sets[k])).unpack().MEAN_ELEMENTS;
    Object.assign(t, { EPOCH: me.EPOCH, MEAN_MOTION: me.MEAN_MOTION, ECCENTRICITY: me.ECCENTRICITY, INCLINATION: me.INCLINATION, RA_OF_ASC_NODE: me.RA_OF_ASC_NODE,
      ARG_OF_PERICENTER: me.ARG_OF_PERICENTER, MEAN_ANOMALY: me.MEAN_ANOMALY, BSTAR: me.BTERM, MEAN_MOTION_DDOT: me.AGOM });
    return packed((b, o) => M.OMM.finishSizePrefixedOMMBuffer(b, o), t);
  });
  fs.writeFileSync(here('xp-fit-current.omm'), Buffer.concat(out));
  const sha = async (name) => (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(here(name))).digest('hex');
  for (const name of ['xp-fit-current.oem', 'xp-fit-current.ocm', 'xp-fit-current.omm']) console.log(name, await sha(name));
} finally {
  await module.destroy();
}
