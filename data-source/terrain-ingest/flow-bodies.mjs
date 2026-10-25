// Local publication adapter: host file I/O and framing only. terrain-source
// WASM chooses source pixels, byte ranges, masks, feathering and mesh geometry.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createBrowserModuleHarness} from 'space-data-module-sdk/testing';
import {encodeModuleConfig,decodeFlowNotice} from 'space-data-module-sdk/runtime-contracts';
import {TYPE,planHeader,granuleFrame,STANDARDS_ROOT,flatbuffers} from '../terrain-source/typed-frames.mjs';
import {splitSized} from '../terrain-source/tools/body-lane.mjs';
const PNM=await import(`file://${STANDARDS_ROOT}/lib/js/PNM/main.js`);
const sourceRoot=fileURLToPath(new URL('../terrain-source/',import.meta.url));
export async function createRasterLane(config,{wasmPath=path.join(sourceRoot,'dist/isomorphic/module.wasm'),harness,onTileInputs}={}) {
  const source=harness??await createBrowserModuleHarness({wasmSource:fs.readFileSync(wasmPath),manifest:JSON.parse(fs.readFileSync(path.join(sourceRoot,'plugin-manifest.json'))),surface:'direct'});
  const fd=fs.openSync(config.sourceFile,'r'),fileBytes=fs.fstatSync(fd).size;
  if(fileBytes!==config.options.rasterFileBytes)throw Error('source size changed');
  const options={portId:'options',typeRef:TYPE.MCFG,payload:encodeModuleConfig(config.options)};
  async function tile(addresses) {
    const grid=config.gridsByLevel?.[addresses[0].level]??config.plan.gridSize;
    const tileOptions={...config.options,minGridSize:grid,maxGridSize:grid};
    const options={portId:'options',typeRef:TYPE.MCFG,payload:encodeModuleConfig(tileOptions)};
    const plan={portId:'plan',typeRef:TYPE.DTT,payload:Buffer.concat(addresses.map(a=>planHeader({...config.plan,gridSize:grid},a)))};
    const probe=await source.invoke({methodId:'tile',inputs:[plan,{portId:'options',typeRef:TYPE.MCFG,payload:encodeModuleConfig({...tileOptions,sourcePixelRangesOnly:true})},granuleFrame('dem',Buffer.alloc(0),200)]});
    if(probe.statusCode===413&&addresses.length>1) {
      const middle=Math.floor(addresses.length/2);
      const left=await tile(addresses.slice(0,middle));if(global.gc)global.gc();
      const right=await tile(addresses.slice(middle));if(global.gc)global.gc();return Buffer.concat([left,right]);
    }
    if(probe.statusCode!==0)throw Error(`range plan: ${probe.errorCode}: ${probe.errorMessage}`);
    const request=decodeFlowNotice(probe.outputs.find(o=>o.portId==='report').payload);
    if(request.reason!=='source-pixel-ranges')throw Error(`unexpected range report: ${request.reason}`);
    const boundary='sdn-body-source-pixels';
    const parts=[];
    for(const item of request.items) {
      const [offset,length]=item.split(':').map(Number);
      if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<1||offset+length>fileBytes)throw Error('bad guest range');
      const bytes=Buffer.allocUnsafe(length);
      if(fs.readSync(fd,bytes,0,length,offset)!==length)throw Error('short source read');
      parts.push(Buffer.from(`--${boundary}\r\nContent-Range: bytes ${offset}-${offset+length-1}/${fileBytes}\r\n\r\n`),bytes,Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const frame=granuleFrame('dem',Buffer.concat(parts),206,{url:config.sourceUrl,headers:{'content-type':`multipart/byteranges; boundary=${boundary}`}});
    const inputs=[plan,options,frame];if(onTileInputs)await onTileInputs(inputs);
    const response=await source.invoke({methodId:'tile',inputs});
    if(response.statusCode!==0)throw Error(`tile: ${response.errorCode}: ${response.errorMessage}`);
    return Buffer.from(response.outputs.find(o=>o.portId==='records').payload);
  }
  async function pack(records) {
    const response=await source.invoke({methodId:'pack',inputs:[{portId:'records',typeRef:TYPE.DTT,payload:records},
      {portId:'options',typeRef:TYPE.MCFG,payload:encodeModuleConfig({pathPrefix:`terrain/${config.naif}`,rootMaxLevel:2})}]});
    if(response.statusCode!==0)throw Error(`pack: ${response.errorCode}: ${response.errorMessage}`);
    const names=splitSized(response.outputs.find(o=>o.portId==='names').payload).map(b=>PNM.PNM.getSizePrefixedRootAsPNM(new flatbuffers.ByteBuffer(Uint8Array.from(b))).FILE_NAME());
    const files=response.outputs.filter(o=>o.portId==='file');
    if(names.length!==files.length)throw Error('pack names mismatch');
    return files.map((o,i)=>({name:names[i],bytes:Buffer.from(o.payload)}));
  }
  return {source,tile,pack,destroy:async()=>{fs.closeSync(fd);await source.destroy();}};
}
export function* blocks(maxLevel) {
  let index=0;const root=[];
  for(let level=0;level<=2;level++)for(let y=0;y<2**level;y++)for(let x=0;x<2**(level+1);x++)root.push({level,x,y,childAvailability:15});
  yield {index:index++,addresses:root};
  for(let level=3;level<=maxLevel;level++)for(let by=0;by<2**level;by+=4)for(let bx=0;bx<2**(level+1);bx+=4) {
    const addresses=[];
    for(let y=by;y<by+4;y++)for(let x=bx;x<bx+4;x++)addresses.push({level,x,y,childAvailability:level<maxLevel?15:0});
    yield {index:index++,addresses};
  }
}
async function main() {
  const args=process.argv.slice(2),opt={};
  for(let i=0;i<args.length;i+=2){if(!/^--[a-z]+$/.test(args[i])||args[i+1]===undefined)throw Error('expected --key value pairs');opt[args[i].slice(2)]=args[i+1];}
  const config=JSON.parse(fs.readFileSync(opt.config));
  const worker=Number(opt.worker??0),workers=Number(opt.workers??1),limit=Number(opt.limit??Infinity);
  if(!Number.isInteger(workers)||workers<1||workers>6||!Number.isInteger(worker)||worker<0||worker>=workers)throw Error('worker bound is 1..6; this process never spawns workers');
  const lane=await createRasterLane(config);let count=0,bytes=0;
  try {
    for(const block of blocks(config.maxLevel)) {
      if(block.index%workers!==worker||block.index>=limit)continue;
      const first=block.addresses[0];
      const relative=block.index===0?`terrain/${config.naif}/root.dtts.gz`:`terrain/${config.naif}/${first.level}/${first.x>>2}_${first.y>>2}.dtts.gz`;
      if(fs.existsSync(path.join(opt.out,relative)))continue;
      const free=fs.statfsSync(opt.out);if(free.bavail*free.bsize<25*1024**3)throw Error('disk stop: below 25 GiB');
      let records;
      if(block.index===0) {const parts=[];for(const a of block.addresses){parts.push(await lane.tile([a]));if(global.gc)global.gc();}records=Buffer.concat(parts);}
      else records=await lane.tile(block.addresses);
      for(const file of await lane.pack(records)) {
        if(!file.name.startsWith(`terrain/${config.naif}/`))throw Error('pack escaped body prefix');
        const target=path.join(opt.out,file.name);fs.mkdirSync(path.dirname(target),{recursive:true});
        fs.writeFileSync(target+'.part',file.bytes);fs.renameSync(target+'.part',target);bytes+=file.bytes.length;
      }
      count++;if(global.gc)global.gc();
      if(process.resourceUsage().maxRSS*1024>=2_000_000_000)throw Error('encoder exceeded the 2 GB RSS acceptance limit');
      if(count%10===0||block.index===0)console.log(`worker ${worker} block ${block.index} count ${count} bytes ${bytes} peakRssBytes ${process.resourceUsage().maxRSS*1024}`);
    }
  }finally{await lane.destroy();}
  const wasmSha256=createHash('sha256').update(fs.readFileSync(path.join(sourceRoot,'dist/isomorphic/module.wasm'))).digest('hex');
  const report=`worker ${worker}\ncount ${count}\nbytes ${bytes}\npeakRssBytes ${process.resourceUsage().maxRSS*1024}\nwasmSha256 ${wasmSha256}\n`;
  fs.writeFileSync(path.join(opt.out,`worker-${worker}.txt`),report);console.log(report.trimEnd().replace(/\n/g,' '));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
