// foundation/time `convert_time`: one instant between time scales (TDB to UTC here). Host side only: encodes the TIM
// request and decodes the TIM result; the conversion (leap seconds, Orekit's TDB terms) is the module's.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { openModule } from './modules.mjs';

const require = createRequire(import.meta.url);
const standards = path.dirname(require.resolve('spacedatastandards.org/package.json'));
const T = await import(pathToFileURL(path.join(standards, 'lib/js/TIM/main.js')));
const TYPE = { schemaName: 'TIM.fbs', fileIdentifier: '$TIM', rootTypeName: 'TIM' };

export async function openTime(modules) { return openModule(modules, 'foundation/time'); }

function request(iso, from, to) {
  const b = new flatbuffers.Builder(512);
  const envelope = new T.TIMT(from, null, new T.TIMConversionRequestT(
    new T.TIMInstantT(from, T.timEpochRepresentation.ISO8601, 0, 0, iso, 0, null, 0, false, null, null),
    to, T.timEpochRepresentation.ISO8601, 0, false, 0, false, 'g1'), null);
  T.TIM.finishTIMBuffer(b, envelope.pack(b));
  return b.asUint8Array();
}

/** ISO strings in time system `from` ('TDB') to ISO UTC strings, one module call each. */
export async function convertAll(mod, isos, from = T.timingStandard.TDB, to = T.timingStandard.UTC) {
  const out = new Array(isos.length);
  for (let i = 0; i < isos.length; i += 1) {
    const r = await mod.call('convert_time', [{ portId: 'request', typeRef: TYPE, payload: request(isos[i], from, to) }]);
    const result = T.TIM.getRootAsTIM(new flatbuffers.ByteBuffer(new Uint8Array(r.result))).CONVERSION_RESULT();
    if (result.STATUS() !== T.timConversionStatus.OK) throw new Error(`convert_time: status ${result.STATUS()} for ${isos[i]}`);
    out[i] = result.TARGET().ISO8601();
  }
  return out;
}
export { T as TIMBindings };
