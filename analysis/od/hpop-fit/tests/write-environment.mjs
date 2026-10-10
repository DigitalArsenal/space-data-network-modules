// Frames public environment files as the PRW records the OD HPOP fit takes:
//   earth_orientation.prw  IERS finals2000A (Bulletin A) rows, MJD from..to
//   space_weather.prw      CSSI SpaceWeather-All-v1.2 daily rows
//   jb2008_indices.prw     SET SOLFSMY.TXT + DTCFILE.TXT rows
//   kernel.prw             an SPK (DE440 excerpt) as NATIVE_INPUT
// Parsing is propagator/hpop's own fixture writers (make-eop/spw/jb2008);
// this only re-frames their rows. No physics.
//
//   node write-environment.mjs <out> <from YYYY-MM-DD> <to YYYY-MM-DD> \
//     --finals <finals.all> --spw <SpaceWeather-All-v1.2.txt> \
//     [--solfsmy <SOLFSMY.TXT> --dtc <DTCFILE.TXT>] --kernel <de440 excerpt.bsp>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as flatbuffers from 'flatbuffers';
import { sds, makeTable, encodePrw, nativeInput } from '../../../../propagator/hpop/tests/lib/prwCodec.mjs';

const [out, from, to, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i < 0 ? null : rest[i + 1]; };
const fixtures = new URL('../../../../propagator/hpop/tests/fixtures/orekit/', import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'od-hpop-env-'));
const mjd = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000 + 40587;
fs.mkdirSync(out, { recursive: true });
try {
  execFileSync(process.execPath, [new URL('make-eop.mjs', fixtures).pathname, flag('finals'), String(mjd(from)), String(mjd(to)), path.join(tmp, 'eop.json')]);
  const eop = JSON.parse(fs.readFileSync(path.join(tmp, 'eop.json')));
  const bytes = Buffer.from(eop.payloadBase64, 'base64'), rows = [];
  for (let at = 0; at < bytes.length;) {
    const n = bytes.readUInt32LE(at);
    rows.push(sds.EOP.getSizePrefixedRootAsEOP(new flatbuffers.ByteBuffer(new Uint8Array(bytes.subarray(at, at + 4 + n)))).unpack());
    at += 4 + n;
  }
  fs.writeFileSync(path.join(out, 'earth_orientation.prw'), encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', { ROWS: rows })));
  execFileSync(process.execPath, [new URL('make-spw.mjs', fixtures).pathname, flag('spw'), from, to, path.join(tmp, 'spw.json')]);
  const spw = JSON.parse(fs.readFileSync(path.join(tmp, 'spw.json')));
  fs.writeFileSync(path.join(out, 'space_weather.prw'), encodePrw('SPACE_WEATHER', makeTable('PRWSpaceWeatherTable', { ROWS: spw.rows.map((r) => makeTable('SPW', r)) })));
  if (flag('solfsmy')) {
    execFileSync(process.execPath, [new URL('make-jb2008.mjs', fixtures).pathname, flag('solfsmy'), flag('dtc'), from, to, path.join(tmp, 'jb.json')]);
    const jb = JSON.parse(fs.readFileSync(path.join(tmp, 'jb.json')));
    fs.writeFileSync(path.join(out, 'jb2008_indices.prw'), encodePrw('JB2008_INDICES', makeTable('PRWJB2008IndicesTable', { ROWS: jb.rows.map((r) => makeTable('PRWJB2008Indices', r)) })));
  }
  fs.writeFileSync(path.join(out, 'kernel.prw'), nativeInput(fs.readFileSync(flag('kernel'))));
  console.log(JSON.stringify({ out, from, to, eopRows: rows.length, spwRows: spw.rows.length }));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
