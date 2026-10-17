// The SDK's native WasmEdge host owns execution and threads. This E2E adds an
// actual typed keyslot host binding over private pipes: keys stay in Node,
// and only payloads/signatures cross the boundary. No browser target override.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPublicKey,verify} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolveWasmEdgeRunnerBuildPlan} from 'space-data-module-sdk/testing';
import {encodePluginInvokeRequest,decodePluginInvokeResponse} from 'space-data-module-sdk/invoke';
import {decodeHostCall,encodeHostCallResult} from 'space-data-module-sdk/runtime-contracts';
const exec=promisify(execFile);
const binding=String.raw`
#include <unistd.h>
#include <errno.h>
static _Thread_local Bytes signing_response;
static bool pipe_bytes(int fd, uint8_t *data, uint32_t size, bool writing) {
  uint32_t offset=0;
  while(offset<size) {
    ssize_t n=writing?write(fd,data+offset,size-offset):read(fd,data+offset,size-offset);
    if(n<0 && errno==EINTR)continue;
    if(n<=0)return false;
    offset+=(uint32_t)n;
  }
  return true;
}
static WasmEdge_Result hostcall_call(void *data,
    const WasmEdge_CallingFrameContext *frame, const WasmEdge_Value *in, WasmEdge_Value *out) {
  (void)data;
  WasmEdge_MemoryInstanceContext *memory=WasmEdge_CallingFrameGetMemoryInstance(frame,0);
  uint32_t ptr=(uint32_t)WasmEdge_ValueGetI32(in[2]),size=(uint32_t)WasmEdge_ValueGetI32(in[3]);
  const uint8_t *request=memory?WasmEdge_MemoryInstanceGetPointerConst(memory,ptr,size):NULL;
  if(!request || size>16*1024*1024)return WasmEdge_Result_Fail;
  uint8_t header[4]={(uint8_t)size,(uint8_t)(size>>8),(uint8_t)(size>>16),(uint8_t)(size>>24)};
  if(!pipe_bytes(3,header,4,true)||!pipe_bytes(3,(uint8_t*)request,size,true)||!pipe_bytes(4,header,4,false))return WasmEdge_Result_Fail;
  size=(uint32_t)header[0]|(uint32_t)header[1]<<8|(uint32_t)header[2]<<16|(uint32_t)header[3]<<24;
  if(size>16*1024*1024)return WasmEdge_Result_Fail;
  free(signing_response.data);signing_response.data=malloc(size);signing_response.size=size;
  if(!signing_response.data||!pipe_bytes(4,signing_response.data,size,false))return WasmEdge_Result_Fail;
  hostcall_response=&signing_response;out[0]=WasmEdge_ValueGenI32(0);return WasmEdge_Result_Success;
}
`;
export async function createSigningServer(wasmPath,signPayload) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mission-screening-wasmedge-'));
  try {
  const install=process.env.MISSION_SCREENING_WASMEDGE_ROOT??path.join(os.homedir(),'.wasmedge');
  const plan=resolveWasmEdgeRunnerBuildPlan({runnerKind:'wasi-threads',outputPath:path.join(dir,'host'),
    wasmedgeIncludeDir:path.join(install,'include'),wasmedgeLibDir:path.join(install,'lib')});
  const original=await fs.readFile(plan.runnerSourcePath,'utf8');
  const start=original.indexOf('static WasmEdge_Result hostcall_call('),end=original.indexOf('static WasmEdge_Result hostcall_response_len(',start);
  if(start<0||end<0)throw Error('SDK native host binding seam changed');
  const src=path.join(dir,'host.c');await fs.writeFile(src,original.slice(0,start)+binding+'\n'+original.slice(end));
  await exec('clang',[src,'-std=c11','-O2','-pthread',`-I${plan.wasmedgeIncludeDir}`,`-L${plan.wasmedgeLibDir}`,'-lwasmedge',`-Wl,-rpath,${plan.wasmedgeLibDir}`,'-o',plan.outputPath]);
  await exec(plan.outputPath,['--version']);
  const aot=path.join(dir,'module.aot.wasm');
  const compiler=process.env.WASMEDGE_COMPILER??path.join(plan.wasmedgeLibDir,'../bin/wasmedgec');
  await exec(compiler,['--enable-threads',wasmPath,aot],{timeout:60000});
  const fallback=path.join(dir,'unsupported.piv');await fs.writeFile(fallback,encodeHostCallResult({ok:false,error:{code:'unsupported'}}));
  let child;
  return {
    async invoke(request) {
      if(child)throw Error('Concurrent invokes are not supported by this E2E host');
      return await new Promise((resolve,reject)=>{
        child=spawn(plan.outputPath,['--sdm-direct','--sdm-hostcall-config',fallback,'--sdm-hostcall-unsupported',fallback,aot],{stdio:['pipe','pipe','pipe','pipe','pipe']});
        const owned=child,output=[],errors=[];let pending=Buffer.alloc(0),callbackError;
        const deadline=setTimeout(()=>owned.kill('SIGTERM'),540000);
        owned.stdout.on('data',b=>output.push(b));owned.stderr.on('data',b=>errors.push(b));
        owned.stdio[3].on('data',b=>{
          pending=Buffer.concat([pending,b]);
          while(pending.length>=4&&pending.length>=4+pending.readUInt32LE(0)) {
            const n=pending.readUInt32LE(0),bytes=pending.subarray(4,4+n);pending=pending.subarray(4+n);let answer;
            try{const call=decodeHostCall(Uint8Array.from(bytes));if(call.op==='keyslot.sign')answer=encodeHostCallResult({op:call.op,ok:true,raw:{data:signPayload(call.params,call.raw.payload)}});
              else if(call.op==='crypto.ed25519.verify'){
                const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),call.raw.public_key]),format:'der',type:'spki'});
                answer=encodeHostCallResult({op:call.op,ok:true,result:{VALUE:verify(null,call.raw.data,key,call.raw.signature)}});
              } else throw Error(`Unsupported operation ${call.op}`);
            }catch(error){callbackError=error;answer=encodeHostCallResult({ok:false,error:{code:'failed',message:error.message}});}
            const h=Buffer.alloc(4);h.writeUInt32LE(answer.length);owned.stdio[4].write(Buffer.concat([h,answer]));
          }
        });
        owned.on('error',reject);owned.on('close',code=>{clearTimeout(deadline);child=null;
          if(callbackError)return reject(callbackError);
          if(code!==0)return reject(Error(`WasmEdge host exit ${code}: ${Buffer.concat(errors)}`));
          try{resolve(decodePluginInvokeResponse(Buffer.concat(output)));}catch(error){reject(error);}
        });
        owned.stdin.end(encodePluginInvokeRequest(request));
      });
    },
    async destroy(){if(child){const owned=child;await new Promise(resolve=>{owned.once('close',resolve);owned.kill('SIGTERM');});}await fs.rm(dir,{recursive:true,force:true});},
  };
  } catch(error) {await fs.rm(dir,{recursive:true,force:true});throw error;}
}
