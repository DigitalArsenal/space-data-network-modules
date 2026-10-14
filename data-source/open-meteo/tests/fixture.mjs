// Public contract: https://open-meteo.com/en/docs#api_documentation
// The first temperature samples (13, 12.7) and Berlin grid coordinate come
// from the documentation's July 1, 2022 response. Other fields are synthetic
// dimensional-analysis vectors, not observations. Repeated hours complete a
// one-day response; all expected values below are independently calculated.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeHostCall, encodeHostCallResult, encodeHttpResponse, encodeModuleConfig, encodeTimerTick } from 'space-data-module-sdk/runtime-contracts';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';

export const forecast={latitude:52.52,longitude:13.41,forecast_days:1,access:'noncommercial',variables:[
  'temperature_2m','dew_point_2m','relative_humidity_2m','cloud_cover','wind_speed_10m','pressure_msl','surface_pressure','precipitation',
]};
export const producerPeerId='16Uiu2HAm1apfD3rAJJjgx4AC5Ms3PejRBwoqEsKpRx36uYwXuW9h';
export const retrievedMs=1656633700000;
// The node CONFIG the scheduled flow runs with (the host sends it as one ModuleConfig, nested values as tables).
export const nodeConfig=(over={})=>({open_meteo_enabled:true,open_meteo_forecast:forecast,open_meteo_producer_peer_id:producerPeerId,...over});
export function response() {
  const values={temperature_2m:13,dew_point_2m:0,relative_humidity_2m:50,cloud_cover:75,wind_speed_10m:10,pressure_msl:1013.25,surface_pressure:900,precipitation:2.5};
  const units={temperature_2m:'°C',dew_point_2m:'°C',relative_humidity_2m:'%',cloud_cover:'%',wind_speed_10m:'m/s',pressure_msl:'hPa',surface_pressure:'hPa',precipitation:'mm'};
  const hourly={time:Array.from({length:24},(_,i)=>1656633600+i*3600)};
  for(const [name,value] of Object.entries(values)) hourly[name]=Array(24).fill(value);
  hourly.temperature_2m[1]=12.7; hourly.temperature_2m[2]=null;
  return {latitude:52.52,longitude:13.419,elevation:44.812,generationtime_ms:2.2119,utc_offset_seconds:0,timezone:'GMT',hourly,hourly_units:{time:'unixtime',...units}};
}

export const TYPES={
  TICK:{schemaName:'TimerTick.fbs',fileIdentifier:'TICK',rootTypeName:'TimerTick',wireFormat:'flatbuffer'},
  HRSP:{schemaName:'HttpResponse.fbs',fileIdentifier:'HRSP',rootTypeName:'HttpResponse',wireFormat:'flatbuffer'},
};
export const tick=()=>({portId:'tick',typeRef:TYPES.TICK,payload:encodeTimerTick({triggerId:'timer-open-meteo',scheduledMs:retrievedMs,firedMs:retrievedMs,sequence:0})});
// The host's answer to the plan's GET: the body (Open-Meteo JSON), the request's CONTEXT echoed, the retrieval time.
export function httpResponse(context,body=response(),status=200,retrieved=retrievedMs,url='https://api.open-meteo.com/v1/forecast') {
  const bytes=body instanceof Uint8Array?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  return {portId:'response',typeRef:TYPES.HRSP,payload:encodeHttpResponse({url,status,body:bytes,context,retrievedMs:retrieved})};
}

// The SDS $WXF JS library (to read records and the plan CONTEXT).
const standards=process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
export const standardsRoot=standards;
const require=createRequire(path.join(standards,'package.json'));
export const flatbuffers=require('flatbuffers');
export const wxf=await import(pathToFileURL(path.join(standards,'lib/js/WXF/main.js')));
export const readWxf=(bytes)=>wxf.WXF.getSizePrefixedRootAsWXF(new flatbuffers.ByteBuffer(Uint8Array.from(bytes))).unpack();
export function writeWxf(object) {
  const b=new flatbuffers.Builder(1024);
  b.finishSizePrefixed(object.pack(b),'$WXF');
  return b.asUint8Array().slice();
}

// The SDK harness with the typed hostcall. The tests change the node config between invocations (and take it away:
// `config` null answers FAILED), which BrowserHost's fixed `config` option cannot, so the hostcall import is wrapped:
// plugin.getConfig is answered here as the Go node answers it - one ModuleConfig FlatBuffer on raw "config"
// (encodeModuleConfig) - and every $PIV request the module sends lands in `wire`.
const instantiate=WebAssembly.instantiate;
export async function harness(t,{wasm,manifest,config={}}) {
  const stub={config,wire:[]};
  WebAssembly.instantiate=async (module,imports)=>{
    let memory, answer=null;
    const host=imports?.space_data_module_host;
    if(!host) return instantiate(module,imports);
    const wrapped={...imports,space_data_module_host:{...host,
      call:(op,opLen,ptr,len)=>{
        const call=decodeHostCall(new Uint8Array(memory.buffer,ptr,len).slice());
        stub.wire.push(call);
        if(call.op!=='plugin.getConfig') { answer=null; return host.call(op,opLen,ptr,len); }
        answer=stub.config===null
          ? encodeHostCallResult({ok:false,error:{code:'unsupported',message:'no node config'}})
          : encodeHostCallResult({ok:true,op:call.op,raw:{config:encodeModuleConfig(stub.config)}});
        return 0;
      },
      response_len:()=>(answer?answer.length:host.response_len()),
      read_response:(dst,len)=>{ if(!answer) return host.read_response(dst,len); const n=Math.min(len,answer.length); new Uint8Array(memory.buffer).set(answer.subarray(0,n),dst); return n; },
    }};
    const instance=await instantiate(module,wrapped);
    memory=instance.exports.memory;
    return instance;
  };
  t.after(()=>{ WebAssembly.instantiate=instantiate; });
  const h=await createBrowserModuleHarness({wasmSource:fs.readFileSync(wasm),manifest:JSON.parse(fs.readFileSync(manifest,'utf8')),surface:'direct',
    hostcallDispatch:(op)=>{ throw new Error(`unexpected hostcall ${op}`); }});
  t.after(()=>h.destroy());
  h.stub=stub;
  return h;
}
export const CORE={wasm:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),manifest:fileURLToPath(new URL('../plugin-manifest.json',import.meta.url))};
export const ADAPTER={wasm:fileURLToPath(new URL('../host-adapter/dist/isomorphic/module.wasm',import.meta.url)),manifest:fileURLToPath(new URL('../host-adapter/plugin-manifest.json',import.meta.url))};
