// The same isomorphic WASM artifact owns JPEG encoding, provenance and DTT packing.
import fs from 'node:fs';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { encodeHttpResponse, encodeModuleConfig } from 'space-data-module-sdk/runtime-contracts';
import { flatbuffers } from './runner.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const sds = path.dirname(require.resolve('spacedatastandards.org/package.json'));
const { PNM } = await import(pathToFileURL(path.join(sds, 'lib/js/PNM/main.js')));
const type = (schemaName, fileIdentifier, rootTypeName) => ({schemaName, fileIdentifier, rootTypeName, wireFormat:'flatbuffer'});
export async function openHdRunner() {
  const h = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(new URL('../../dist/isomorphic/module.wasm', import.meta.url)),
    manifest: JSON.parse(fs.readFileSync(new URL('../../plugin-manifest.json', import.meta.url))),
    surface:'direct', hostOptions:{config:{jpeg_quality:88,retrieved_at:'2026-10-22T00:00:00.000Z'}},
  });
  return {
    async encode(unit, raster) {
      const r = await h.invoke({methodId:'tiles_window', inputs:[
        {portId:'unit', typeRef:type('ModuleConfig.fbs','MCFG','ModuleConfig'), payload:encodeModuleConfig(unit)},
        {portId:'rows_0', typeRef:type('HttpResponse.fbs','HRSP','HttpResponse'), payload:encodeHttpResponse({status:200,body:raster})},
      ]});
      if(r.statusCode !== 0) throw Error(`${r.errorCode}: ${r.errorMessage}`);
      const names = Buffer.from(r.outputs.find(o=>o.portId==='names').payload), list=[];
      for(let at=0; at<names.length;) {
        const n=names.readUInt32LE(at); at+=4;
        list.push(PNM.getRootAsPNM(new flatbuffers.ByteBuffer(names.subarray(at,at+n))).FILE_NAME()); at+=n;
      }
      const files=r.outputs.filter(o=>o.portId==='file');
      if(files.length!==list.length) throw Error('file/name mismatch');
      return files.map((o,i)=>({path:list[i],bytes:Buffer.from(o.payload)}));
    },
    destroy:()=>h.destroy?.(),
  };
}
