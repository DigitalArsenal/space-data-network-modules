// The provider-node side of the E2E, IO only: run data-source/dust-map-3d's
// retrieval stages (plan_dust, advance_dust x13, build_dust) exactly as the
// flow does, answering each range request from the offline copy of the
// published Zenodo file instead of the network, and return the $PCE rows the
// node would publish over SDN. No dust physics here: every number is WASM.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';

const moduleDir = fileURLToPath(new URL('../../../data-source/dust-map-3d/', import.meta.url));
export const dustSource = {
  file: path.join(moduleDir, '.source-cache/mean_and_std_healpix.fits'),
  url: 'https://zenodo.org/records/10658339/files/mean_and_std_healpix.fits?download=1',
  bytes: 3252715200,
  // Ranges the stages read (whole bytes of the published v1.0.2 file).
  ranges: [[0, 1623225599], [3246402240, 3252715199]],
};

function respond(fd, request) {
  const [first, last] = request.headers.Range.slice(6).split('-').map(Number);
  const end = Math.min(last, dustSource.bytes - 1);
  const header = Buffer.alloc(8);
  header.write('$HRB');
  if (!(first <= end)) { header.writeInt32LE(416, 4); return header; }
  const body = Buffer.alloc(end - first + 1);
  fs.readSync(fd, body, 0, body.length, first);
  header.writeInt32LE(206, 4);
  return Buffer.concat([header, body]);
}

const frame = (portId, payload) => ({portId, payload,
  typeRef: {wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: payload.length}});

export async function deliverDustRows({retrievedAtMs, progress = () => {}}) {
  const wasm = fs.readFileSync(path.join(moduleDir, 'dist/isomorphic/module.wasm'));
  const manifest = JSON.parse(fs.readFileSync(path.join(moduleDir, 'plugin-manifest.json'), 'utf8'));
  const harness = await createBrowserModuleHarness({wasmSource: wasm, manifest, surface: 'direct'});
  const fd = fs.openSync(dustSource.file, 'r');
  let bytesServed = 0;
  try {
    const call = async (methodId, inputs) => {
      const response = await harness.invoke({methodId, inputs});
      if (response.statusCode !== 0) throw new Error(`dust-map-3d ${methodId}: ${response.errorCode}: ${response.errorMessage}`);
      return response.outputs;
    };
    const pick = (outputs, port) => outputs.filter(f => f.portId === port).map(f => Buffer.from(f.payload));
    let outputs = await call('plan_dust', [frame('config', Buffer.from(JSON.stringify({access: 'anonymous'})))]);
    for (let stage = 1; ; ++stage) {
      const requests = pick(outputs, 'request').map(b => JSON.parse(b.toString()));
      const responses = requests.map(r => respond(fd, r));
      bytesServed += responses.reduce((n, b) => n + b.length - 8, 0);
      const inputs = [frame('state', pick(outputs, 'state')[0]), ...responses.map(b => frame('response', b))];
      progress(`dust-map-3d stage ${stage}: ${requests.length} ranges`);
      if (stage === 14) {
        inputs.push(frame('receipt', Buffer.from(JSON.stringify({retrieved_at_ms: retrievedAtMs, producer_peer_id: 'e2e-offline-provider'}))));
        outputs = await call('build_dust', inputs);
        break;
      }
      outputs = await call('advance_dust', inputs);
    }
    const stream = pick(outputs, 'records')[0];
    const rows = [];
    for (let at = 0; at < stream.length;) {
      const size = stream.readUInt32LE(at);
      rows.push(new Uint8Array(stream.subarray(at, at + 4 + size)));  // each row as stored: size-prefixed
      at += 4 + size;
    }
    return {rows, meta: JSON.parse(pick(outputs, 'meta')[0]), report: JSON.parse(pick(outputs, 'report')[0]), bytesServed};
  } finally {
    fs.closeSync(fd);
    await harness.destroy();
  }
}
