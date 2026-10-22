// Built planner -> local byte-range HTTP -> built GeoTIFF decoder -> terrain
// mesh -> block pack. Independent oracle: GDAL source posts, fixed-resolution mask
// Euclidean distances, PDS blend/MEGA bytes. Planetocentric degrees E; metres
// above R=3396000. Tolerance = mesh quantum + 0.5 m (source/mesh rounding).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createBodyLane,MARS_CONFIG,dttOf} from '../tools/body-lane.mjs';
import {decodeEdgeMatchedPlanes} from '../tools/edge-matched-planes.mjs';
import {decodeQuantizedMesh} from './helpers.mjs';
import {decodeModuleConfig} from '../../terrain-ingest/tests/typed.mjs';
const dir=process.env.MARS_HD_DIR,grid=321,root=fileURLToPath(new URL('..',import.meta.url));
v8.setFlagsFromString('--expose_gc');const gc=vm.runInNewContext('gc');
const cap=(product,L,fill,N)=>({product,min_level:L,max_level:L,fill,feather_posts:N,fill_edges:false});
export const INSETS=[cap('hrsc_hmc30_dt5',10,'hrsc_mola_blend_200m_v2',64)];
for(let L=10;L<=15;L++)for(const [product,fill,N] of [['msl_gale_dem_1m_v3','hrsc_mola_blend_200m_v2',58],['msr_trn_hirise_dtm_1m_v003','hrsc_hmc30_dt5',64]])INSETS.push(cap(product+(L===15?'':`_ovr${2**(15-L)}`),L,fill,N));
const key=h=>`${h.level}/${h.x}/${h.y}`;
const family=name=>name.startsWith('HMC')?'HMC':name.startsWith('MSL')?'Gale':'Jezero';
const tileAt=(L,lon,lat)=>`${L}/${Math.floor((lon+180)/(180/2**L))}/${Math.floor((lat+90)/(180/2**L))}`;
function runPython(script,args,{echo=false}={}) {return new Promise((resolve,reject)=>{
 const child=spawn('python3',['-c',script,...args],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>{out+=b;if(echo)process.stdout.write(b);});child.stderr.on('data',b=>{err+=b;});child.on('error',reject);child.on('exit',c=>c===0?resolve(out):reject(new Error(`GDAL oracle exit ${c}: ${err}`)));
});}
function planHash(u){const h=createHash('sha256');for(const t of u.headers)h.update(t.sized);h.update(JSON.stringify(u.requests));h.update(u.options);h.update(u.pack);h.update(JSON.stringify(u.job,(_,v)=>typeof v==='bigint'?v.toString():v));return h.digest('hex');}
function success(r){assert.equal(r.response.statusCode,0,`${r.response.errorCode}: ${r.response.errorMessage}`);return r;}
function mesh(sized){const t=dttOf(sized.subarray(4)).unpack(),m=decodeQuantizedMesh(decodeEdgeMatchedPlanes(t.PAYLOAD.BYTES)),q=(m.header.maxHeight-m.header.minHeight)/32767,posts=[];
 for(let k=0;k<m.vertexCount;k++){const i=Math.round(m.u[k]/32767*(grid-1)),j=Math.round(m.v[k]/32767*(grid-1));posts.push({i,j,lat:t.SOUTH_DEG+j*(t.NORTH_DEG-t.SOUTH_DEG)/(grid-1),lon:t.WEST_DEG+i*(t.EAST_DEG-t.WEST_DEG)/(grid-1),h:m.header.minHeight+m.h[k]*q,q});}return {t,q,posts};}
function healthy(m){
 const map=new Map(m.posts.map(p=>[`${p.i}/${p.j}`,p])),median=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)];
 for(const p of m.posts){assert.ok(Number.isFinite(p.h)&&p.h!==0&&p.h>-30000&&p.h<30000,`invalid post ${p.h}`);
  const a=[];for(let y=p.j-1;y<=p.j+1;y++)for(let x=p.i-1;x<=p.i+1;x++){const n=map.get(`${x}/${y}`);if(n)a.push(n.h);}
  if(a.length===9){const med=median([...a]),mad=median(a.map(x=>Math.abs(x-med)));if(Math.abs(p.h-med)>10*mad+2*m.q)p.checkSpike=true;}
 }
}

const ORACLE=String.raw`# Independent GDAL reads and brute-force Euclidean source-mask distances.
from osgeo import gdal
import numpy as np,json,math,sys
from pathlib import Path
from functools import lru_cache
gdal.UseExceptions();gdal.SetCacheMax(128*1024**2)
r=Path(sys.argv[1]);cache=Path(sys.argv[2]);request=json.load(open(sys.argv[3]));rad=math.pi/180
blend=np.memmap(r/'Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif',dtype='<i2',offset=854272,shape=(53347,106694),mode='r');mega=np.memmap(r/'mega90n000eb.img',dtype='>i2',shape=(2880,5760),mode='r')
def interp(a,x,y):
 i=math.floor(x);j=math.floor(y);fx=x-i;fy=y-j
 v=np.array([a[j,i%a.shape[1]],a[j,(i+1)%a.shape[1]],a[j+1,i%a.shape[1]],a[j+1,(i+1)%a.shape[1]]],dtype=float)
 if np.any(v==-32768):return float('nan')
 return (1-fy)*((1-fx)*v[0]+fx*v[1])+fy*((1-fx)*v[2]+fx*v[3])
def areoid(lat,lon):return interp(mega,(lon%360)*16-.5,(90-lat)*16-.5)
def backing(lat,lon):return interp(blend,(lon+180)*296.3735-.5,(90-lat)*296.3735-.5)+areoid(lat,lon)
class Source:
 def __init__(self,name,ds=None):
  self.name=name;self.ds=ds if ds is not None else gdal.Open(str(r/name));self.b=self.ds.GetRasterBand(1);self.gt=self.ds.GetGeoTransform();self.w=self.ds.RasterXSize;self.h=self.ds.RasterYSize;self.nd=self.b.GetNoDataValue();self.radius=3396000 if name.startswith('HMC') else 3396190;self.arc=self.radius*rad;self.step=self.gt[1];self.edge=None
 @lru_cache(maxsize=64)
 def row(self,j):return self.b.ReadAsArray(0,int(j),self.w,1)[0]
 def xy(self,lat,lon):return (lon*self.arc-self.gt[0])/self.step-.5,(self.gt[3]-lat*self.arc)/self.step-.5
 def raw(self,lat,lon):
  x,y=self.xy(lat,lon);i=math.floor(x);j=math.floor(y)
  if i<0 or j<0 or i+1>=self.w or j+1>=self.h:return float('nan')
  a=self.row(j);b=self.row(j+1);v=np.array([a[i],a[i+1],b[i],b[i+1]],dtype=float)
  if np.any(v==self.nd) or not np.all(np.isfinite(v)):return float('nan')
  fx=x-i;fy=y-j;return (1-fy)*((1-fx)*v[0]+fx*v[1])+fy*((1-fx)*v[2]+fx*v[3])
 def edges(self):
  if self.edge is not None:return self.edge
  target=cache/(self.name+'.edges.npy')
  if target.exists():self.edge=np.load(target);return self.edge
  pts=[]
  for y in range(0,self.h,128):
   a=max(0,y-1);z=min(self.h,y+129);data=self.b.ReadAsArray(0,a,self.w,z-a);valid=np.isfinite(data)&(data!=self.nd);top=y-a;count=min(128,self.h-y);v=valid[top:top+count];near=np.zeros(v.shape,bool)
   for dy in [-1,0,1]:
    ay=max(0,top+dy);by=min(len(valid),top+count+dy);dest=max(0,-(top+dy));vv=valid[ay:by]
    for dx in [-1,0,1]:
     lo=max(0,-dx);hi=min(self.w,self.w-dx);near[dest:dest+len(vv),lo:hi]|=vv[:,lo+dx:hi+dx]
   yy,xx=np.nonzero(near&~v)
   if len(xx):pts.append(np.column_stack((xx,yy+y)))
  self.edge=np.concatenate(pts).astype(float) if pts else np.zeros((0,2));np.save(target,self.edge);return self.edge
 def distance(self,lat,lon,limit):
  x,y=self.xy(lat,lon)
  ix=math.floor(x+.5);iy=math.floor(y+.5)
  if ix<0 or iy<0 or ix>=self.w or iy>=self.h:return 0
  value=self.row(iy)[ix]
  if not np.isfinite(value) or value==self.nd:return 0
  best=min(limit/self.step,x+1,y+1,self.w-x,self.h-y)
  p=self.edges()
  if len(p):
   q=p[(abs(p[:,0]-x)<best)&(abs(p[:,1]-y)<best)]
   if len(q):best=min(best,float(np.sqrt(np.min((q[:,0]-x)**2+(q[:,1]-y)**2))))
  return best*self.step
sources={name:Source(name) for name in request['files']}
if request['product']=='HMC' and len(sources)>1:
 import hashlib
 # Independent GDAL mosaic, first file wins overlaps just as the product list.
 vrt=gdal.BuildVRT('',[str(r/name) for name in reversed(request['files'])])
 name='HMC_mosaic_'+hashlib.sha256('|'.join(request['files']).encode()).hexdigest()
 sources={name:Source(name,vrt)}
masks=sources if request['product']=='HMC' else {name:Source(name) for name in request['masks']}
hmc=Source('HMC_13E10_dt5.tif') if request.get('fill')=='hrsc_hmc30_dt5' else None
spacing=50 if hmc else 3396000*rad/296.3735;band=request['N']*spacing
out=[]
for p in request['probes']:
 lat,lon=p['lat'],p['lon'];add=0 if request['product']=='HMC' else areoid(lat,lon)
 raw=float('nan');distance=0
 for src in sources.values():
  v=src.raw(lat,lon)
  if np.isfinite(v) and not np.isfinite(raw):raw=v+add
 for src in masks.values():distance=max(distance,src.distance(lat,lon,band))
 fill=backing(lat,lon)
 if hmc:
  h=hmc.raw(lat,lon);d=hmc.distance(lat,lon,64*3396000*rad/296.3735)
  if np.isfinite(h):
   w=min(1,d/(64*3396000*rad/296.3735));fill=fill+(w*w*(3-2*w))*(h-fill)
 if not np.isfinite(raw):expected=fill;kind='gap'
 elif distance>=band-1e-7:expected=raw;kind='interior'
 else:
  w=distance/band;expected=fill+w*w*(3-2*w)*(raw-fill);kind='feather'
 out.append(dict(expected=expected,raw=raw if np.isfinite(raw) else None,backing=fill,distance=distance,kind=kind))
print(json.dumps(out,allow_nan=False))
`;
const QA=String.raw`from osgeo import gdal
import numpy as np,json,math
from pathlib import Path
gdal.UseExceptions();gdal.SetCacheMax(128*1024**2)
import sys
r=Path(sys.argv[1])
blend=np.memmap(r/'Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif',dtype='<i2',offset=854272,shape=(53347,106694),mode='r')
mega=np.memmap(r/'mega90n000eb.img',dtype='>i2',shape=(2880,5760),mode='r')
def bilinear(a,x,y):
 i=np.floor(x).astype(int);j=np.floor(y).astype(int);fx=x-i;fy=y-j
 vals=[a[j,i%a.shape[1]],a[j,(i+1)%a.shape[1]],a[j+1,i%a.shape[1]],a[j+1,(i+1)%a.shape[1]]]
 z=(1-fy)*((1-fx)*vals[0]+fx*vals[1])+fy*((1-fx)*vals[2]+fx*vals[3]);z[np.any(np.array(vals)==-32768,axis=0)]=np.nan;return z
def base(lat,lon):return bilinear(blend,(lon+180)*296.3735-.5,(90-lat)*296.3735-.5),bilinear(mega,(lon%360)*16-.5,(90-lat)*16-.5)


layouts=json.loads('[{"name": "HMC_11E10_dt5.tif", "w": 13336, "h": 17782, "gt": [-1333625.0, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-22.50031918525748, 15.000072193932178, -11.250370486987961, 30.000566176582794]}, {"name": "HMC_11E20_dt5.tif", "w": 13337, "h": 17782, "gt": [-666825.0, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-11.250370486987961, 15.000072193932178, 0.00042178871844141875, 30.000566176582794]}, {"name": "HMC_11E30_dt5.tif", "w": 13336, "h": 17782, "gt": [-1333625.0, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-22.50031918525748, -0.00042178871844141875, -11.250370486987961, 15.000072193932175]}, {"name": "HMC_11E40_dt5.tif", "w": 13337, "h": 17782, "gt": [-666825.0, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-11.250370486987961, -0.00042178871844141875, 0.00042178871844141875, 15.000072193932175]}, {"name": "HMC_11W10_dt5.tif", "w": 13336, "h": 17782, "gt": [-2667225.0000000005, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-45.00021658179653, 15.000072193932178, -33.75026788352701, 30.000566176582794]}, {"name": "HMC_11W20_dt5.tif", "w": 13337, "h": 17782, "gt": [-2000425.0000000002, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-33.75026788352701, 15.000072193932178, -22.499475607820603, 30.000566176582794]}, {"name": "HMC_11W30_dt5.tif", "w": 13336, "h": 17782, "gt": [-2667225.0000000005, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-45.00021658179653, -0.00042178871844141875, -33.75026788352701, 15.000072193932175]}, {"name": "HMC_11W40_dt5.tif", "w": 13337, "h": 17782, "gt": [-2000425.0000000002, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-33.75026788352701, -0.00042178871844141875, -22.499475607820603, 15.000072193932175]}, {"name": "HMC_13E10_dt5.tif", "w": 13336, "h": 17782, "gt": [4000775.0, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [67.49927040089868, 15.000072193932178, 78.7492190991682, 30.000566176582794]}, {"name": "HMC_13E20_dt5.tif", "w": 13337, "h": 17782, "gt": [4667575.0, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [78.7492190991682, 15.000072193932178, 90.0000113748746, 30.000566176582794]}, {"name": "HMC_13E30_dt5.tif", "w": 13336, "h": 17782, "gt": [4000775.0, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [67.49927040089868, -0.00042178871844141875, 78.7492190991682, 15.000072193932175]}, {"name": "HMC_13E40_dt5.tif", "w": 13337, "h": 17782, "gt": [4667575.0, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [78.7492190991682, -0.00042178871844141875, 90.0000113748746, 15.000072193932175]}, {"name": "HMC_20E10_dt5.tif", "w": 13336, "h": 17782, "gt": [1333575.0, 50.0, 0.0, 25.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [22.4994756078206, -15.000072193932175, 33.74942430609012, 0.00042178871844141875]}, {"name": "HMC_20E20_dt5.tif", "w": 13337, "h": 17782, "gt": [2000375.0, 50.0, 0.0, 25.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [33.74942430609012, -15.000072193932175, 45.00021658179652, 0.00042178871844141875]}, {"name": "HMC_20E30_dt5.tif", "w": 13336, "h": 17782, "gt": [1333575.0, 50.0, 0.0, -889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [22.4994756078206, -30.00056617658279, 33.74942430609012, -15.000072193932175]}, {"name": "HMC_20E40_dt5.tif", "w": 13337, "h": 17782, "gt": [2000375.0, 50.0, 0.0, -889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [33.74942430609012, -30.00056617658279, 45.00021658179652, -15.000072193932175]}, {"name": "HMC_20W10_dt5.tif", "w": 13336, "h": 17782, "gt": [-25.0, 50.0, 0.0, 25.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [-0.00042178871844141875, -15.000072193932175, 11.24952690955108, 0.00042178871844141875]}, {"name": "HMC_20W20_dt5.tif", "w": 13337, "h": 17782, "gt": [666775.0000000001, 50.0, 0.0, 25.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [11.249526909551081, -15.000072193932175, 22.50031918525748, 0.00042178871844141875]}, {"name": "HMC_20W30_dt5.tif", "w": 13336, "h": 17782, "gt": [-25.0, 50.0, 0.0, -889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [-0.00042178871844141875, -30.00056617658279, 11.24952690955108, -15.000072193932175]}, {"name": "HMC_20W40_dt5.tif", "w": 13337, "h": 17782, "gt": [666775.0000000001, 50.0, 0.0, -889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [11.249526909551081, -30.00056617658279, 22.50031918525748, -15.000072193932175]}, {"name": "MSL_Gale_DEM_Mosaic_1m_v3.tif", "w": 32980, "h": 57440, "gt": [8127993.492786024, 1.0, 0.0, -244781.075189438, 0.0, -1.0], "radius": 3396190.0, "nodata": -32767.0, "block": [32980, 1], "type": "Float32", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [137.12416650612477, -5.098652339315738, 137.68055905434542, -4.1296047962656]}, {"name": "MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40.tif", "w": 19144, "h": 26816, "gt": [4567580.0, 1.0, 0.0, 1101802.0, 0.0, -1.0], "radius": 3396190.0, "nodata": -32767.0, "block": [256, 256], "type": "Float32", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND", "PREDICTOR": "3"}, "bbox": [77.05783733782991, 18.135664034005845, 77.38080819723366, 18.588066173881064]}]');out=[]
# Warp average directly onto the backing post footprints, in the source sphere's projected coordinates.
# The blend's geographic spacing is 1/296.3735 degrees; offsets -180,90.
def averaged(m,back):
 ds=gdal.Open(str(r/m['name']));arc=m['radius']*math.pi/180
 if back=='blend':
  step=1/296.3735;ox=-180;oy=90;sp=arc*step
 else:
  h=next(x for x in layouts if x['name']=='HMC_13E10_dt5.tif');factor=m['radius']/h['radius'];ox=h['gt'][0]*factor/arc;oy=h['gt'][3]*factor/arc;sp=50*factor;step=sp/arc
 gt=m['gt'];w,h=m['w'],m['h'];west=gt[0]/arc;east=(gt[0]+gt[1]*w)/arc;north=gt[3]/arc;south=(gt[3]+gt[5]*h)/arc
 x0=math.floor((west-ox)/step);x1=math.ceil((east-ox)/step);y0=math.floor((oy-north)/step);y1=math.ceil((oy-south)/step)
 bounds=[(ox+x0*step)*arc,(oy-y1*step)*arc,(ox+x1*step)*arc,(oy-y0*step)*arc]
 dst=gdal.Warp('',ds,format='MEM',outputBounds=bounds,width=x1-x0,height=y1-y0,resampleAlg='average',outputType=gdal.GDT_Float32,srcNodata=m['nodata'],dstNodata=-32767,warpMemoryLimit=128)
 z=dst.ReadAsArray().astype(float);yy,xx=np.nonzero((z!=-32767)&np.isfinite(z));lat=oy-(y0+yy+.5)*step;lon=ox+(x0+xx+.5)*step
 bb,aa=base(lat,lon)
 if back!='blend':
  h=next(x for x in layouts if x['name']=='HMC_13E10_dt5.tif');hd=gdal.Open(str(r/h['name']));arr=hd.ReadAsArray();ix=x0+xx;iy=y0+yy;bb=arr[iy,ix].astype(float);bb[bb==-32768]=np.nan;aa0=0
 else:aa0=aa
 delta=z[yy,xx]+(aa if m['name'].startswith(('MSL','MSR')) else 0)-(bb+aa0)
 good=delta[np.isfinite(delta)];med,p99=np.percentile(abs(good),[50,99]);row=dict(name=m['name'],backing=back,median_abs=float(med),p99_abs=float(p99),accepted=bool(med<25 and p99<250),samples=len(good),method='GDAL average onto exact backing post footprints; all valid overlap posts')
 return row
for m in layouts:
 back='HMC_13E10_dt5.tif' if m['name'].startswith('MSR') and next(x for x in out if x['name']=='HMC_13E10_dt5.tif')['accepted'] else 'blend'
 row=averaged(m,back);out.append(row);print(json.dumps(row),flush=True)
`;
const EDGE=String.raw`from osgeo import gdal
import numpy as np,json,math
from pathlib import Path
gdal.UseExceptions();gdal.SetCacheMax(128*1024**2)
import sys
r=Path(sys.argv[1])
blend=np.memmap(r/'Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif',dtype='<i2',offset=854272,shape=(53347,106694),mode='r')
mega=np.memmap(r/'mega90n000eb.img',dtype='>i2',shape=(2880,5760),mode='r')
def bilinear(a,x,y):
 i=np.floor(x).astype(int);j=np.floor(y).astype(int);fx=x-i;fy=y-j
 vals=[a[j,i%a.shape[1]],a[j,(i+1)%a.shape[1]],a[j+1,i%a.shape[1]],a[j+1,(i+1)%a.shape[1]]]
 z=(1-fy)*((1-fx)*vals[0]+fx*vals[1])+fy*((1-fx)*vals[2]+fx*vals[3]);z[np.any(np.array(vals)==-32768,axis=0)]=np.nan;return z
def base(lat,lon):return bilinear(blend,(lon+180)*296.3735-.5,(90-lat)*296.3735-.5),bilinear(mega,(lon%360)*16-.5,(90-lat)*16-.5)

all=json.loads('[{"name": "HMC_11E10_dt5.tif", "w": 13336, "h": 17782, "gt": [-1333625.0, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-22.50031918525748, 15.000072193932178, -11.250370486987961, 30.000566176582794]}, {"name": "HMC_11E20_dt5.tif", "w": 13337, "h": 17782, "gt": [-666825.0, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-11.250370486987961, 15.000072193932178, 0.00042178871844141875, 30.000566176582794]}, {"name": "HMC_11E30_dt5.tif", "w": 13336, "h": 17782, "gt": [-1333625.0, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-22.50031918525748, -0.00042178871844141875, -11.250370486987961, 15.000072193932175]}, {"name": "HMC_11E40_dt5.tif", "w": 13337, "h": 17782, "gt": [-666825.0, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-11.250370486987961, -0.00042178871844141875, 0.00042178871844141875, 15.000072193932175]}, {"name": "HMC_11W10_dt5.tif", "w": 13336, "h": 17782, "gt": [-2667225.0000000005, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-45.00021658179653, 15.000072193932178, -33.75026788352701, 30.000566176582794]}, {"name": "HMC_11W20_dt5.tif", "w": 13337, "h": 17782, "gt": [-2000425.0000000002, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-33.75026788352701, 15.000072193932178, -22.499475607820603, 30.000566176582794]}, {"name": "HMC_11W30_dt5.tif", "w": 13336, "h": 17782, "gt": [-2667225.0000000005, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-45.00021658179653, -0.00042178871844141875, -33.75026788352701, 15.000072193932175]}, {"name": "HMC_11W40_dt5.tif", "w": 13337, "h": 17782, "gt": [-2000425.0000000002, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [-33.75026788352701, -0.00042178871844141875, -22.499475607820603, 15.000072193932175]}, {"name": "HMC_13E10_dt5.tif", "w": 13336, "h": 17782, "gt": [4000775.0, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [67.49927040089868, 15.000072193932178, 78.7492190991682, 30.000566176582794]}, {"name": "HMC_13E20_dt5.tif", "w": 13337, "h": 17782, "gt": [4667575.0, 50.0, 0.0, 1778175.0000000002, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [78.7492190991682, 15.000072193932178, 90.0000113748746, 30.000566176582794]}, {"name": "HMC_13E30_dt5.tif", "w": 13336, "h": 17782, "gt": [4000775.0, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [67.49927040089868, -0.00042178871844141875, 78.7492190991682, 15.000072193932175]}, {"name": "HMC_13E40_dt5.tif", "w": 13337, "h": 17782, "gt": [4667575.0, 50.0, 0.0, 889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [78.7492190991682, -0.00042178871844141875, 90.0000113748746, 15.000072193932175]}, {"name": "HMC_20E10_dt5.tif", "w": 13336, "h": 17782, "gt": [1333575.0, 50.0, 0.0, 25.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [22.4994756078206, -15.000072193932175, 33.74942430609012, 0.00042178871844141875]}, {"name": "HMC_20E20_dt5.tif", "w": 13337, "h": 17782, "gt": [2000375.0, 50.0, 0.0, 25.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [33.74942430609012, -15.000072193932175, 45.00021658179652, 0.00042178871844141875]}, {"name": "HMC_20E30_dt5.tif", "w": 13336, "h": 17782, "gt": [1333575.0, 50.0, 0.0, -889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [22.4994756078206, -30.00056617658279, 33.74942430609012, -15.000072193932175]}, {"name": "HMC_20E40_dt5.tif", "w": 13337, "h": 17782, "gt": [2000375.0, 50.0, 0.0, -889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [33.74942430609012, -30.00056617658279, 45.00021658179652, -15.000072193932175]}, {"name": "HMC_20W10_dt5.tif", "w": 13336, "h": 17782, "gt": [-25.0, 50.0, 0.0, 25.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [-0.00042178871844141875, -15.000072193932175, 11.24952690955108, 0.00042178871844141875]}, {"name": "HMC_20W20_dt5.tif", "w": 13337, "h": 17782, "gt": [666775.0000000001, 50.0, 0.0, 25.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [11.249526909551081, -15.000072193932175, 22.50031918525748, 0.00042178871844141875]}, {"name": "HMC_20W30_dt5.tif", "w": 13336, "h": 17782, "gt": [-25.0, 50.0, 0.0, -889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13336, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [-0.00042178871844141875, -30.00056617658279, 11.24952690955108, -15.000072193932175]}, {"name": "HMC_20W40_dt5.tif", "w": 13337, "h": 17782, "gt": [666775.0000000001, 50.0, 0.0, -889075.0, 0.0, -50.0], "radius": 3396000.0, "nodata": -32768.0, "block": [13337, 1], "type": "Int16", "compression": {"INTERLEAVE": "BAND"}, "bbox": [11.249526909551081, -30.00056617658279, 22.50031918525748, -15.000072193932175]}, {"name": "MSL_Gale_DEM_Mosaic_1m_v3.tif", "w": 32980, "h": 57440, "gt": [8127993.492786024, 1.0, 0.0, -244781.075189438, 0.0, -1.0], "radius": 3396190.0, "nodata": -32767.0, "block": [32980, 1], "type": "Float32", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND"}, "bbox": [137.12416650612477, -5.098652339315738, 137.68055905434542, -4.1296047962656]}, {"name": "MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40.tif", "w": 19144, "h": 26816, "gt": [4567580.0, 1.0, 0.0, 1101802.0, 0.0, -1.0], "radius": 3396190.0, "nodata": -32767.0, "block": [256, 256], "type": "Float32", "compression": {"COMPRESSION": "LZW", "INTERLEAVE": "BAND", "PREDICTOR": "3"}, "bbox": [77.05783733782991, 18.135664034005845, 77.38080819723366, 18.588066173881064]}]');out=[]
hmc=gdal.Open(str(r/'HMC_13E10_dt5.tif'));hg=hmc.GetGeoTransform();ha=hmc.ReadAsArray();harc=3396000*math.pi/180
for m in all:
 ds=gdal.Open(str(r/m['name']));b=ds.GetRasterBand(1);gt=m['gt'];arc=m['radius']*math.pi/180
 w,h=m['w'],m['h'];delta=[]
 for y in range(0,h,256):
  a=max(0,y-1);z=min(h,y+257);block=b.ReadAsArray(0,a,w,z-a);valid=np.isfinite(block)&(block!=m['nodata']);top=y-a;rows=min(256,h-y)
  v=valid[top:top+rows];edge=np.zeros(v.shape,dtype=bool)
  edge[:,1:]|=v[:,1:]&~v[:,:-1];edge[:,:-1]|=v[:,:-1]&~v[:,1:]
  edge[:,0]|=v[:,0];edge[:,-1]|=v[:,-1]
  for j in range(rows):
   if y+j==0 or y+j==h-1:edge[j]|=v[j]
   else:edge[j]|=v[j]&(~valid[top+j-1]|~valid[top+j+1])
  yy,xx=np.nonzero(edge)
  if not len(xx):continue
  lat=(gt[3]+(y+yy+.5)*gt[5])/arc;lon=(gt[0]+(xx+.5)*gt[1])/arc
  bb,aa=base(lat,lon);raw=block[top+yy,xx].astype(float)
  d=raw-bb if m['name'].startswith(('MSL','MSR')) else raw-(bb+aa)
  if m['name'].startswith('MSR'):d=raw+aa-bilinear(ha,(lon*harc-hg[0])/50-.5,(hg[3]-lat*harc)/50-.5)
  delta.append(d[np.isfinite(d)])
 spacing=50 if m['name'].startswith('MSR') else 200
 d=np.concatenate(delta);p99=float(np.percentile(abs(d),99));N=int(np.clip(np.ceil(1.5*p99/(math.tan(math.pi/180)*spacing)),4,64))
 row=dict(name=m['name'],edge_samples=len(d),edge_p99=p99,N=N,spacing_fill_m=spacing,backing='HMC' if spacing==50 else 'blend+MEGA',ring='all valid posts with a 4-neighbor nodata or image exterior')
 out.append(row);print(json.dumps(row),flush=True)
`;
test('Mars insets: level sources, QA/datum, runtime coarse masks, backing, nested unique blocks', {skip:!dir&&'MARS_HD_DIR unset',timeout:7200000},async t=>{
 const free=fs.statfsSync(dir);assert.ok(free.bavail*free.bsize>20*1024**3);
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'mars-insets-e2e-'));
 const etags=Object.fromEntries(fs.readdirSync(dir).filter(n=>n.endsWith('.tif')).map(n=>[`inset_etag_${n}`,'"local-fixture-edition"']));
 const config={...MARS_CONFIG,...etags,inset_base_url:'https://local.invalid/raw/499/',fill_diagnostics:1,caps:[{product:'megr_4',min_level:0,max_level:2},...INSETS]};
 let lane;const open=async cfg=>createBodyLane({dataDir:dir,config:cfg});t.after(()=>lane?.destroy());
 const report={qa:[],counts:{},N:{HMC:64,Gale:58,Jezero:64},datum:{HMC:'sphere',Gale:'mega_16',Jezero:'mega_16'},cases:[],scratch};
 report.sizes=[];
 for(const [module,artifacts] of [['terrain-ingest',['isomorphic/module.wasm','guest-link/module-link.o']],['terrain-source',['isomorphic/module.wasm','guest-link/module-link.o','parity/module.wasm']]])for(const artifact of artifacts) {
  const file=`data-source/${module}/dist/${artifact}`,result=spawnSync('git',['cat-file','-s',`3e79f07c:${file}`],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0);const before=Number(result.stdout),after=fs.statSync(path.join(root,'..',module,'dist',artifact)).size;
  report.sizes.push({file,before,after,ratio:after/before});console.log(`size ${file}: ${before} -> ${after} (${(100*(after/before-1)).toFixed(2)}%)`);assert.ok(after<=before*1.1,`module grew over 10%: ${file}`);
 }

 {
  const text=await runPython(QA,[dir],{echo:true});report.qa=text.trim().split('\n').map(x=>JSON.parse(x));assert.equal(report.qa.length,22);assert.ok(report.qa.every(x=>x.accepted));
  report.edge= (await runPython(EDGE,[dir],{echo:true})).trim().split('\n').map(x=>JSON.parse(x));
  for(const group of ['HMC','Gale','Jezero'])assert.equal(Math.max(...report.edge.filter(x=>family(x.name)===group).map(x=>x.N)),report.N[group]);
 }
 const maskEdge=EDGE.replace('for m in all:\n ds=', "for m in all:\n if not m['name'].startswith(('MSL','MSR')):continue\n m['name']=m['name'].replace('.tif','_32m.tif');d=gdal.Open(str(r/m['name']));m.update(w=d.RasterXSize,h=d.RasterYSize,gt=d.GetGeoTransform())\n ds=");
 report.mask_edge=(await runPython(maskEdge,[dir],{echo:true})).trim().split('\n').map(x=>JSON.parse(x));
 for(const row of report.mask_edge)assert.equal(row.N,report.N[family(row.name)]);
 console.log('N HMC=64 (blend), Gale=58 (blend), Jezero=64 (HMC); 32 m mask ring remeasurement preserves N.');
 report.overviews=[];
 for(const name of fs.readdirSync(dir).filter(n=>/_(32|16|8|4|2)m\.tif$/.test(n))) {
  const real=fs.realpathSync(path.join(dir,name)),manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(real),'derived.json'),'utf8'));
  const record=manifest.records.find(x=>x.file===name);assert.ok(record);assert.equal(fs.statSync(real).size,record.bytes);
  const hash=createHash('sha256');await pipeline(fs.createReadStream(real),hash);assert.equal(hash.digest('hex'),record.sha256);
  report.overviews.push({...record,gdal_version:manifest.gdal_version});
 }
 report.derived=[];
 for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('_rows.tif'))) {
  const real=fs.realpathSync(path.join(dir,name)),manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(real),'derived.json'),'utf8'));
  const record=manifest.records.find(x=>x.file===name);assert.ok(record);assert.equal(fs.statSync(real).size,record.bytes);
  const hash=createHash('sha256');await pipeline(fs.createReadStream(real),hash);assert.equal(hash.digest('hex'),record.sha256);report.derived.push(record);
 }
 assert.equal(report.derived.length,10);
 assert.equal(report.overviews.length,10);console.log(`Verified ${report.overviews.length} overview hashes; ${report.overviews[0].gdal_version}`);
 const units=new Map(),tiles=new Map(),files=new Set();let total;
 for(let k=0;;k++){
  if(!lane||k%64===0){lane?.destroy();lane=null;gc();lane=await open(config);}
  const u=await lane.planUnit(k);assert.ok(u);if(total===undefined)total=u.backlog+1;
  if(k){const opts=decodeModuleConfig(u.options),name=opts.bodyTiffFiles.split(';')[0].split('=')[1],group=family(name),L=u.headers[0].level,bucket=`${group} L${L}`;
   const expected=L===15?1:group==='HMC'?50:2**(15-L);assert.ok(group==='HMC'||name.endsWith(expected===1?'.tif':`_${expected}m.tif`));assert.ok(u.requests.length<=16);
   report.counts[bucket]??={files:0,tiles:0,units:0};report.counts[bucket].units++;
   const blockNames=new Set();for(const h of u.headers){const k0=key(h);assert.ok(!tiles.has(k0),`duplicate tile ${k0}`);tiles.set(k0,{index:k,group});blockNames.add(`${h.level}/${Math.floor(h.x/4)}/${Math.floor(h.y/4)}`);}
   for(const f of blockNames){assert.ok(!files.has(f),`duplicate block ${f}`);files.add(f);}
   report.counts[bucket].files+=blockNames.size;report.counts[bucket].tiles+=u.headers.length;
   // Keep only the coordinates needed to locate fixed encoding units.
   units.set(k,{group,L});
  }
  if(k%256===0)console.log(`planned ${k+1}/${total} inset-walk units`);
  if(k+1===total)break;
 }
 for(const [k,v] of tiles){const [L,x,y]=k.split('/').map(Number);if(L>10){const parent=tiles.get(`${L-1}/${Math.floor(x/2)}/${Math.floor(y/2)}`);assert.ok(parent,`missing inset parent ${k}`);assert.equal(parent.group,v.group);}}
 assert.equal(Object.keys(report.counts).length,13,'HMC L10 plus Gale/Jezero L10-L15');
 console.log(JSON.stringify(report.counts));
 const cases=[['HMC','interior',10,-16,22],['HMC','edge',10,-44.999,22],['HMC','gap',10,76.66431746391227,11.24994869826952],['HMC','internal file seam',10,-11.25,22],['Gale','interior',10,137.4,-4.6],['Gale','edge',15,137.1751241680987,-4.6],['Gale','gap',10,137.4,-4.131],['Gale','native interior',15,137.4,-4.6],['Jezero','interior',10,77.22,18.36],['Jezero','edge',15,77.07596480274995,18.36],['Jezero','gap',10,77.22,18.136],['Jezero','native interior',15,77.22,18.36]];
 let checked=0;const edgeHashes=new Map();const kinds={interior:0,gap:0,feather:0};
 for(const [group,label,L,lon,lat] of cases){
  const anchor=tileAt(L,lon,lat),[,ax,ay]=anchor.split('/').map(Number);
  let found=tiles.get(anchor);
  if(!found&&group==='HMC'&&label==='gap') {
   // The original fixed block is unchanged. Coarse validity now excludes its
   // four wholly nodata tiles; encode its 12 covered tiles, including the gap
   // boundary, instead of admitting empty keys into L10 coverage.
   for(const [k,v] of tiles){const [z,x,y]=k.split('/').map(Number);if(z===L&&Math.floor(x/4)===Math.floor(ax/4)&&Math.floor(y/4)===Math.floor(ay/4)&&v.group===group){found=v;break;}}
   console.log(`HMC gap anchor ${anchor} correctly omitted; retaining fixed block ${L}/${Math.floor(ax/4)}/${Math.floor(ay/4)}`);
  }
  assert.ok(found,`fixed case block outside planned coverage ${group} ${label}`);assert.equal(found.group,group);
  lane.destroy();lane=null;gc();lane=await open(config);const u=await lane.planUnit(found.index);const opts=decodeModuleConfig(u.options);
  console.log(`encode ${group} ${label}: L${L} unit ${u.index}, tiles=${u.headers.length}, frames=${u.requests.length}`);
  const encoded=success(await lane.encode(u));assert.equal(encoded.byKey.size,u.headers.length);
  for(const r of encoded.report.tiles) {
   const k=`${r.level}/${r.x}/${r.y}`;
   for(const [dx,dy,a,b] of [[1,0,1,3],[-1,0,3,1],[0,1,2,0],[0,-1,0,2]]) {
    const neighbor=edgeHashes.get(`${r.level}/${r.x+dx}/${r.y+dy}`);
    if(neighbor)assert.equal(r[`edgeHeight${a}`],neighbor[`edgeHeight${b}`],`exact shared edge ${k}`);
   }
   edgeHashes.set(k,r);
  }
  const probes=[];for(const sized of encoded.byKey.values()){const m=mesh(sized);assert.ok(m.t.PROVENANCE.SOURCE_URL.startsWith('https://local.invalid/'));healthy(m);const stride=Math.max(1,Math.floor(m.posts.length/100));for(let k=0;k<m.posts.length;k++)if(k%stride===0||m.posts[k].checkSpike)probes.push(m.posts[k]);}
  const primary=opts.bodyTiffFiles.split(';').map(s=>s.split('=')).filter(([i])=>Number(i)<opts.bodyFillFrame).map(([,n])=>n);
  const input=path.join(scratch,'probes.json');fs.writeFileSync(input,JSON.stringify({product:group,files:primary,masks:group==='HMC'?primary:[group==='Gale'?'MSL_Gale_DEM_Mosaic_1m_v3_32m.tif':'MSR_hirise_soc_003_DTM_MOLATopography_DeltaGeoid_1m_Eqc_latTs0_lon0_Blend40_32m.tif'],fill:opts.bodyFillProduct,N:opts.featherPosts,probes}));
  const oracle=JSON.parse(await runPython(ORACLE,[dir,scratch,input]));assert.equal(oracle.length,probes.length);
  let before=0,after=0;const local={interior:0,gap:0,feather:0};
  for(let i=0;i<probes.length;i++){const p=probes[i],o=oracle[i];assert.ok(Math.abs(p.h-o.expected)<=p.q+.5,`${group} ${label} ${i} ${o.kind}: ${p.h} != ${o.expected}, q=${p.q}, d=${o.distance}`);local[o.kind]++;kinds[o.kind]++;checked++;
   if(o.kind==='feather'){before=Math.max(before,Math.abs(o.raw-o.backing));after=Math.max(after,Math.abs(o.expected-o.backing));}
  }
  if(label==='gap')assert.ok(local.gap>0,`${group} fixed gap block must check backing-filled posts`);
  assert.ok(after<=before+1e-8,'smoothstep never increases the source/backing step');
  const packed=await lane.pack(u,encoded.records);assert.equal(packed.length,1);console.log(`${group} ${label}: ${JSON.stringify(local)}, step before=${before} m after=${after} m`);
  report.cases.push({group,label,L,index:u.index,checked:probes.length,spike_checks:probes.filter(p=>p.checkSpike).length,kinds:local,step_before:before,step_after:after});
 }
 assert.ok(kinds.interior>0&&kinds.gap>0&&kinds.feather>0);report.checked=checked;
 // Full default planning A/B proof, plus byte-identical unfilled encoding.
 const baselineDist=(name,override)=>{
  if(override)return override;
  const dest=path.join(scratch,`base-${name}`);fs.mkdirSync(path.join(dest,'isomorphic'),{recursive:true});
  for(const file of ['isomorphic/module.wasm','plugin-manifest.json']) {
   const result=spawnSync('git',['show',`3e79f07c8081df801046cb7247b484d0dab81e89:data-source/${name}/dist/${file}`],{cwd:root,maxBuffer:32*1024**2});
   assert.equal(result.status,0,`baseline artifact unavailable; set MARS_BASE_INGEST_DIST and MARS_BASE_SOURCE_DIST: ${result.stderr}`);
   fs.writeFileSync(path.join(dest,file),result.stdout);
  }return dest;
 };
 const baseIngest=baselineDist('terrain-ingest',process.env.MARS_BASE_INGEST_DIST),baseSource=baselineDist('terrain-source',process.env.MARS_BASE_SOURCE_DIST);
 lane.destroy();lane=null;gc();const hashes=[[],[]];
 for(let side=0;side<2;side++){
  for(let k=0;k<735;k++){
   if(!lane||k%8===0){lane?.destroy();lane=null;gc();lane=await createBodyLane({dataDir:dir,config:MARS_CONFIG,...(side===0?{ingestDist:baseIngest,sourceDist:baseSource}:{})});}
   const u=await lane.planUnit(k);assert.ok(u);if(k===0)assert.equal(u.backlog+1,735);hashes[side].push(planHash(u));
   if(k%128===0)console.log(`default ${side===0?'base':'candidate'} ${k+1}/735`);
  }
  lane.destroy();lane=null;gc();
 }
 assert.deepEqual(hashes[1],hashes[0]);report.default_units=735;report.default_hash=createHash('sha256').update(hashes[0].join('\n')).digest('hex');console.log(`default 735/735 identical: ${report.default_hash}`);
 const outputs=[];for(let side=0;side<2;side++){lane=await createBodyLane({dataDir:dir,config:MARS_CONFIG,...(side===0?{ingestDist:baseIngest,sourceDist:baseSource}:{})});const u=await lane.planUnit(1);outputs.push(success(await lane.encode(u)).records);lane.destroy();lane=null;gc();}assert.deepEqual(outputs[1],outputs[0]);report.unfilled_byte_identical=true;
 fs.writeFileSync(process.env.MARS_INSETS_REPORT||path.join(scratch,'evidence.json'),JSON.stringify(report,null,2)+'\n');console.log(`Independent checks=${checked}; evidence ${scratch}`);
});
