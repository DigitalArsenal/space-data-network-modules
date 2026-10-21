// Reproducible Mars assets and SMALL tile coverage/row-layout metadata.
// No raster values, validity masks, TIFF directories or strip arrays are compiled.
// GDAL_CACHEMAX=0 flushes translated rows. Gale/Jezero nodata is assigned AFTER
// translation: otherwise GDAL allocates their all-nodata rows last. The validator
// checks every offset and pixel; creation options alone do not guarantee layout.
// Usage: node tools/inset-overviews.mjs <hd-src> <mars-hd>
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
const [source,links]=process.argv.slice(2);
if(!source||!links)throw new Error('usage: inset-overviews.mjs <hd-src> <mars-hd>');
const run=(command,args)=>{const p=spawnSync(command,args,{encoding:'utf8',maxBuffer:32*1024**2});if(p.status!==0)throw new Error(`${command}: ${p.stderr}`);return p.stdout;};
const version=run('gdalwarp',['--version']).trim(),records=[];
const sha=async file=>{const h=createHash('sha256');await pipeline(fs.createReadStream(file),h);return h.digest('hex');};
const products=[['msl_gale_dem_1m_v3','MSL_Gale_DEM_Mosaic_1m_v3'],['msr_trn_hirise_dtm_1m_v003','MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40']];
fs.mkdirSync(links,{recursive:true});
async function derive(product,name,resolution){
 const native=path.resolve(source,product,name+'.tif'),out=path.resolve(source,product,'ovr');fs.mkdirSync(out,{recursive:true});
 const file=name+(resolution?`_${resolution}m`:'_rows')+'.tif',target=path.join(out,file);
 const command=resolution?'gdalwarp':'gdal_translate';
 const nativeInfo=JSON.parse(run('gdalinfo',['-json',native])),deferNodata=!resolution&&!name.startsWith('HMC');
 const args=resolution?['-overwrite','-r','average','-tr',String(resolution),String(resolution),'-tap','-srcnodata','-32767','-dstnodata','-32767','-nomd','-ot','Float32']:['--config','GDAL_CACHEMAX','0'];
 if(deferNodata)args.push('-a_nodata','none');
 args.push('-of','GTiff','-co','COMPRESS=NONE','-co','TILED=NO','-co','BLOCKYSIZE=1','-co','BIGTIFF=IF_SAFER');
 if(resolution)args.push('-wm','128');args.push(native,target);
 const recorded=path.join(out,'derived.json');const prior=fs.existsSync(recorded)?JSON.parse(fs.readFileSync(recorded)).records.find(r=>r.file===file):null;
 if(!fs.existsSync(target)||(!resolution&&(!prior?.command.includes('GDAL_CACHEMAX')||(deferNodata&&!prior?.command.includes('-a_nodata'))||process.env.INSET_REBUILD_ROWS==='1'))){
  const free=fs.statfsSync(out);if(free.bavail*free.bsize<32*1024**3)throw new Error('less than 32 GiB free before generation');
  if(fs.existsSync(target))fs.unlinkSync(target); // only this generator's derived output
  console.log(JSON.stringify({command,args}));run(command,args);
  if(deferNodata)run('gdal_edit',['-a_nodata',String(nativeInfo.bands[0].noDataValue),target]);
 }
 const info=JSON.parse(run('gdalinfo',['-json',target])),original=nativeInfo,band=info.bands[0],gt=info.geoTransform;
 if(run('gdalsrsinfo',['-o','proj4',target]).trim()!==run('gdalsrsinfo',['-o','proj4',native]).trim()||band.block[1]!==1||band.block[0]!==info.size[0]||info.metadata?.IMAGE_STRUCTURE?.COMPRESSION)throw new Error(`unexpected row layout: ${file}`);
 if(resolution){if(gt[1]!==resolution||gt[5]!==-resolution||band.type!=='Float32'||band.noDataValue!==-32767)throw new Error(`unexpected overview ${file}`);}
 else if(JSON.stringify(gt)!==JSON.stringify(original.geoTransform)||JSON.stringify(info.size)!==JSON.stringify(original.size)||band.type!==original.bands[0].type||band.noDataValue!==original.bands[0].noDataValue)throw new Error(`native geometry changed ${file}`);
 // Existing averaged overviews also defer empty strips. Normalize their
 // storage only, and compare every pixel before replacing the derived file.
 const ordered=target+'.ordered.tif';
 const rowCommand=resolution?['gdal_translate','--config','GDAL_CACHEMAX','0','-a_nodata','none','-co','COMPRESS=NONE','-co','TILED=NO','-co','BLOCKYSIZE=1','-co','BIGTIFF=IF_SAFER',target,ordered]:null;
 const rowPost=resolution?['gdal_edit','-a_nodata','-32767',ordered]:null;
 if(resolution&&!prior?.row_command){
  if(fs.existsSync(ordered))fs.unlinkSync(ordered);
  run(rowCommand[0],rowCommand.slice(1));run(rowPost[0],rowPost.slice(1));
  run('python3',['-c',String.raw`from osgeo import gdal
import sys
gdal.UseExceptions();gdal.SetCacheMax(128*1024**2)
a=gdal.Open(sys.argv[1]);b=gdal.Open(sys.argv[2]);w,h=a.RasterXSize,a.RasterYSize
assert a.GetGeoTransform()==b.GetGeoTransform() and a.GetProjection()==b.GetProjection()
for y in range(0,h,128):assert a.ReadAsArray(0,y,w,min(128,h-y)).tobytes()==b.ReadAsArray(0,y,w,min(128,h-y)).tobytes()
`,target,ordered]);
  fs.renameSync(ordered,target);
 }
 const link=path.resolve(links,file);if(fs.existsSync(link)||fs.lstatSync(link,{throwIfNoEntry:false})){if(!fs.lstatSync(link).isSymbolicLink()||fs.readlinkSync(link)!==target)throw new Error(`foreign output ${link}`);}else fs.symlinkSync(target,link);
 const record={file,product,native:path.basename(native),bytes:fs.statSync(target).size,sha256:await sha(target),resolution:resolution||gt[1],level:resolution?15-Math.log2(resolution):name.startsWith('HMC')?10:15,size:info.size,geoTransform:gt,command:[command,...args],row_command:rowCommand,row_post_command:rowPost,row_rename:resolution?[ordered,target]:null,post_command:deferNodata?['gdal_edit','-a_nodata',String(nativeInfo.bands[0].noDataValue),target]:null,gdal_version:version};records.push(record);
 console.log(JSON.stringify(record));
 const manifest=path.join(out,'derived.json'),previous=fs.existsSync(manifest)?JSON.parse(fs.readFileSync(manifest)).records:[];
 const updated=[...previous.filter(r=>r.file!==file),record];fs.writeFileSync(manifest,JSON.stringify({gdal_version:version,records:updated},null,2)+'\n');fs.writeFileSync(path.join(out,'SHA256SUMS'),updated.map(r=>`${r.sha256}  ${r.file}\n`).join(''));
 const overviews=updated.filter(r=>/_(32|16|8|4|2)m\.tif$/.test(r.file));
 if(overviews.length)fs.writeFileSync(path.join(out,'overviews.json'),JSON.stringify({gdal_version:version,native,records:overviews},null,2)+'\n');
}
for(const [product,name] of products){for(const resolution of [32,16,8,4,2])await derive(product,name,resolution);await derive(product,name,0);}
for(const file of fs.readdirSync(links).filter(n=>/^HMC_.*_dt5\.tif$/.test(n)).sort()){
 const info=JSON.parse(run('gdalinfo',['-json',path.join(links,file)]));
 if(info.metadata?.IMAGE_STRUCTURE?.COMPRESSION)await derive('hrsc_hmc30_dt5',file.slice(0,-4),0);
}
// GDAL reads the independent raster validity once, to classify coarse tiles.
// Coverage is stored as rectangles of TILE KEYS at one level (lossless RLE),
// never as pixels. L10/11 ancestors and L13..15 descendants are exact by construction.
const metadata=String.raw`from osgeo import gdal
import numpy as np,struct,json,sys,math
from pathlib import Path
gdal.UseExceptions();gdal.SetCacheMax(128*1024**2)
r=Path(sys.argv[1]);records=json.loads(sys.argv[2]);files=[];covers={};runtime={x['native']:x['file'] for x in records if x['file'].endswith('_rows.tif')}
natives=sorted(p.name for p in r.glob('HMC_*_dt5.tif'))+[x['native'] for x in records if x['file'].endswith('_rows.tif') and not x['file'].startswith('HMC')]
names=[runtime.get(n,n) for n in natives]+[x['file'] for x in records if not x['file'].endswith('_rows.tif')]
for name in names:
 ds=gdal.Open(str(r/name));b=ds.GetRasterBand(1);gt=ds.GetGeoTransform();w,h=ds.RasterXSize,ds.RasterYSize;radius=3396000 if name.startswith('HMC') else 3396190;arc=radius*math.pi/180
 with open(r/name,'rb') as f:
  head=f.read(16);le='<' if head[:2]==b'II' else '>';big=struct.unpack(le+'H',head[2:4])[0]==43;size=8 if big else 4;fmt='Q' if big else 'I';off=struct.unpack(le+fmt,head[size:2*size])[0];f.seek(off);n=struct.unpack(le+('Q' if big else 'H'),f.read(8 if big else 2))[0];entries=f.read(n*(20 if big else 12));tags={}
  for j in range(n):
   e=entries[j*(20 if big else 12):(j+1)*(20 if big else 12)];tag,typ=struct.unpack(le+'HH',e[:4]);count=struct.unpack(le+fmt,e[4:12 if big else 8])[0]
   if tag not in (273,279,259,278):continue
   sz={3:2,4:4,16:8}[typ];payload=e[12 if big else 8:]
   if sz*count>size:f.seek(struct.unpack(le+fmt,payload)[0]);payload=f.read(sz*count)
   tags[tag]=np.frombuffer(payload[:sz*count],dtype=le+{2:'u2',4:'u4',8:'u8'}[sz]).astype(np.int64)
  row=w*(2 if b.DataType==gdal.GDT_Int16 else 4);offsets=tags[273]
  assert tags[259][0]==1 and tags[278][0]==1 and len(offsets)==h and np.all(np.diff(offsets)==row) and np.all(tags[279]==row),name
 family='HMC' if name.startswith('HMC') else 'Gale' if name.startswith('MSL') else 'Jezero';bbox=[gt[0]/arc,(gt[3]-h*gt[1])/arc,(gt[0]+w*gt[1])/arc,gt[3]/arc]
 files.append(dict(name=name,family=family,radius=radius,width=w,height=h,bits=row//w*8,x=gt[0],y=gt[3],step=gt[1],nodata=b.GetNoDataValue(),first=int(offsets[0]),row_bytes=row,bytes=(r/name).stat().st_size,little=le=='<',bbox=bbox))
 # Translation is checked by pixel bits, including nodata, in bounded chunks.
 if name.endswith('_rows.tif'):
  native=next(x['native'] for x in records if x['file']==name);src=gdal.Open(str(r/native))
  for y in range(0,h,128):assert ds.ReadAsArray(0,y,w,min(128,h-y)).tobytes()==src.ReadAsArray(0,y,w,min(128,h-y)).tobytes(),name
 if family!='HMC' and not name.endswith('_8m.tif'):continue
 level=10 if family=='HMC' else 12;span=180/2**level;cover=covers.setdefault(family,set())
 xs=np.floor(((gt[0]+(np.arange(w)+.5)*gt[1])/arc+180)/span).astype(int)
 for y in range(0,h,128):
  a=b.ReadAsArray(0,y,w,min(128,h-y));valid=np.isfinite(a)&(a!=b.GetNoDataValue());ys=np.floor(((gt[3]-(y+np.arange(len(a))+.5)*gt[1])/arc+90)/span).astype(int)
  for ty in np.unique(ys):
   cols=np.any(valid[ys==ty],axis=0);cover.update((int(x),int(ty)) for x in np.unique(xs[cols]))

rects={}
for family,tiles in covers.items():
 active={};out=[]
 for y in range(min(t[1] for t in tiles),max(t[1] for t in tiles)+2):
  xs=sorted(x for x,yy in tiles if yy==y);runs=[]
  for x in xs:
   if runs and x==runs[-1][1]+1:runs[-1][1]=x
   else:runs.append([x,x])
  now=set(map(tuple,runs))
  for k in list(active):
   if k not in now:out.append([k[0],active.pop(k),k[1],y-1])
  for k in now:
   if k not in active:active[k]=y
 rects[family]=dict(level=10 if family=='HMC' else 12,tiles=len(tiles),rectangles=out)
print(json.dumps(dict(files=files,coverage=rects)))
`;
const info=JSON.parse(run('python3',['-c',metadata,path.resolve(links),JSON.stringify(records)]));
fs.writeFileSync(path.join(source,'inset-runtime.json'),JSON.stringify({...info,derived:records},null,2)+'\n');
const target=fileURLToPath(new URL('../../terrain-ingest/src/body_plan.hpp',import.meta.url));let cpp=fs.readFileSync(target,'utf8');
const q=JSON.stringify;
let block='// BEGIN GENERATED INSET METADATA (inset-overviews.mjs)\n';
block+=`const std::array<BodyInset,${info.files.length}>& body_insets() {\n    static constexpr std::array<BodyInset,${info.files.length}> rows = {{\n`;
for(const f of info.files)block+=`        // bbox W,S,E,N: ${f.bbox.join(", ")}\n        {${q(f.name)},${f.radius},${f.width},${f.height},${f.bits},${f.x},${f.y},${f.step},${f.nodata},${f.first}ULL,${f.row_bytes},${f.bytes}ULL,${f.little}},\n`;
block+='    }}; return rows;\n}\nconst BodyInset* body_inset(const std::string& name) {\n    for(const auto& row:body_insets())if(name==row.name)return &row;return nullptr;\n}\n';
block+='struct BodyInsetCoverage { const char* family; long level; const std::array<uint16_t,4>* rectangles; size_t count; };\nconst std::array<BodyInsetCoverage,3>& body_inset_coverage() {\n';
for(const [family,c] of Object.entries(info.coverage)){block+=`    static constexpr std::array<uint16_t,4> ${family}[] = { // L${c.level}, ${c.tiles} covered tile keys; ${c.rectangles.length} rectangles\n`;for(let k=0;k<c.rectangles.length;k+=6)block+='        '+c.rectangles.slice(k,k+6).map(r=>'{'+r.join(',')+'}').join(',')+',\n';block+='    };\n';}
block+='    static constexpr std::array<BodyInsetCoverage,3> rows = {{\n';
for(const [family,c] of Object.entries(info.coverage))block+=`        {${q(family)},${c.level},${family},${c.rectangles.length}},\n`;
block+='    }}; return rows;\n}\n// END GENERATED INSET METADATA';
const re=/\/\/ BEGIN GENERATED INSET METADATA[\s\S]*?\/\/ END GENERATED INSET METADATA/;
cpp=re.test(cpp)?cpp.replace(re,block):cpp.replace('#include "body_insets.hpp"','#include "body_insets.hpp"\n\n'+block);
for(const r of records.filter(r=>r.file.endsWith('_rows.tif'))){cpp=cpp.replaceAll(`"${r.native}"`,`"${r.file}"`).replaceAll(`"${r.product}/${r.native}"`,`"${r.product}/ovr/${r.file}"`);}
fs.writeFileSync(target,cpp);console.log(JSON.stringify(Object.fromEntries(Object.entries(info.coverage).map(([k,v])=>[k,{tiles:v.tiles,rectangles:v.rectangles.length}]))));
