// SDS records in and out of the module's consumer methods: $SKQ cones
// encoded, $SKT and $STR decoded (spacedatastandards.org 1.254 lib/js), and
// cone_tiles / cone_rows run in the SDK's direct harness. No star math here:
// every place, pixel and epoch is the module's.
import fs from 'node:fs';
import path from 'node:path';
import * as flatbuffers from 'flatbuffers';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {SKQ, skqQueryKind} from 'spacedatastandards.org/lib/js/SKQ/main.js';
import {SKT, sktPartitionScheme, sktPayloadKind} from 'spacedatastandards.org/lib/js/SKT/main.js';
import {STR} from 'spacedatastandards.org/lib/js/STR/main.js';
import {sizePrefixed} from './sdn-lanes.mjs';

export {sktPartitionScheme};
export const readTile = (bytes) => SKT.getSizePrefixedRootAsSKT(new flatbuffers.ByteBuffer(bytes));
export const readRow = (bytes) => STR.getSizePrefixedRootAsSTR(new flatbuffers.ByteBuffer(bytes));
const concat = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));

/** Size-prefixed $SKQ cones: {ra, dec, radius} in degrees, `jd` (TT) or NaN for J2016.0, G limit. */
export function cones(list) {
  return concat(list.map(({ra, dec, radius, jd = NaN, magLimit = NaN}) => {
    const b = new flatbuffers.Builder(256);
    SKQ.startSKQ(b);
    SKQ.addQueryKind(b, skqQueryKind.CONE);
    SKQ.addEpochJdTt(b, jd);
    SKQ.addMagLimit(b, magLimit);
    SKQ.addRaDeg(b, ra);
    SKQ.addDecDeg(b, dec);
    SKQ.addRadiusDeg(b, radius);
    SKQ.finishSizePrefixedSKQBuffer(b, SKQ.endSKQ(b));
    return b.asUint8Array();
  }));
}

/** Size-prefixed $SKT index records for every pixel of a HEALPix order (a sky partition to ask cone_tiles about). */
export function skyPixels(order) {
  const out = [];
  for (let p = 0; p < 12 * 4 ** order; p++) {
    const b = new flatbuffers.Builder(128);
    const id = b.createString(`sky-o${order}`);
    SKT.startSKT(b);
    SKT.addLayerId(b, id);
    SKT.addPartition(b, sktPartitionScheme.HEALPIX);
    SKT.addPayloadKind(b, sktPayloadKind.POINT_SOURCES);
    SKT.addOrder(b, order);
    SKT.addPixel(b, BigInt(p));
    SKT.finishSizePrefixedSKTBuffer(b, SKT.endSKT(b));
    out.push(b.asUint8Array());
  }
  return concat(out);
}

export async function coneHarness(packageDir) {
  const wasm = fs.readFileSync(path.join(packageDir, 'dist/cones/module.wasm'));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'cones/plugin-manifest.json'), 'utf8'));
  const harness = await createBrowserModuleHarness({wasmSource: wasm, manifest, surface: 'direct'});
  const frame = (portId, code, payload) => ({portId, payload: new Uint8Array(payload),
    typeRef: {schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer'}});
  async function call(methodId, inputs, port) {
    const response = await harness.invoke({methodId, inputs});
    if (response.errorCode || response.error) throw new Error(`${methodId}: ${response.errorMessage ?? response.error ?? response.errorCode}`);
    const out = response.outputs.filter((f) => f.portId === port).map((f) => new Uint8Array(f.payload));
    return out.flatMap((b) => sizePrefixed(b));
  }
  return {
    /** The tiles (size-prefixed $SKT stream) any of `query` may touch. */
    tiles: (query, tiles) => call('cone_tiles', [frame('query', 'SKQ', query), frame('tiles', 'SKT', tiles)], 'tiles'),
    /** The rows (size-prefixed $STR streams) inside any of `query`. */
    rows: (query, rowStreams) => call('cone_rows', [frame('query', 'SKQ', query), ...rowStreams.map((s) => frame('rows', 'STR', s))], 'rows'),
    destroy: () => harness.destroy(),
  };
}
