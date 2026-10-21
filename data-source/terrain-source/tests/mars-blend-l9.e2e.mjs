// Built body_plan -> local HTTP ranges -> built tile/pack. Independent PDS
// byte reads, Mars planetocentric degrees E, heights above R=3396000 m.
// USGS blend area registration is x=(lon+180)*296.3735-.5, y=(90-lat)*296.3735-.5.
// Tolerance: each mesh's quantum plus 0.5 m (int16 source rounding).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createBodyLane, MARS_CONFIG, dttOf } from '../tools/body-lane.mjs';
import { decodeEdgeMatchedPlanes } from '../tools/edge-matched-planes.mjs';
import { decodeQuantizedMesh } from './helpers.mjs';
import { configFrame } from '../typed-frames.mjs';
import { decodeModuleConfig } from '../../terrain-ingest/tests/typed.mjs';

const cap=(product,lo,hi,a=-90,b=90,fill,feather_posts,fill_edges=true)=>({product,min_level:lo,max_level:hi,lat_min:a,lat_max:b,...(fill?{fill,feather_posts,fill_edges}:{})});
// Republish ladder, including the measured fill widths on each polar ring.
export const LADDER=[
 cap('megr_4',0,3),cap('megr_16',4,5),cap('megr_32',6,6),cap('megr_64',7,7),cap('megr_128',8,8,-87.1875,87.1875),
 cap('megr_s_512',8,8,-90,-87.1875,'megr_128',58),cap('megr_n_512',8,8,87.1875,90,'megr_128',56),
 cap('megr_s_512',9,9,-90,-78.75,'hrsc_mola_blend_200m_v2',42),
 cap('hrsc_mola_blend_200m_v2',9,9,-78.75,78.75,'megr_128',4,false),
 cap('megr_n_512',9,9,78.75,90,'hrsc_mola_blend_200m_v2',41),
 cap('megr_s_512',10,10,-90,-84.375,'hrsc_mola_blend_200m_v2',64),
 cap('megr_n_512',10,10,84.375,90,'hrsc_mola_blend_200m_v2',39),
];
const dir=process.env.MARS_HD_DIR, R=3396000, rad=Math.PI/180, grid=321;
const key=h=>`${h.level}/${h.x}/${h.y}`;
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
function fileReader(name,n,bytes,offset,le=false,float=false) {
 const fd=fs.openSync(path.join(dir,name),'r'), rows=new Map();
 return {at(j,i){
  if(!rows.has(j)) {const b=Buffer.alloc(n*bytes);assert.equal(fs.readSync(fd,b,0,b.length,offset+j*b.length),b.length);if(rows.size>=48)rows.delete(rows.keys().next().value);rows.set(j,b);}
  const b=rows.get(j),v=float?b.readFloatBE(i*bytes):le?b.readInt16LE(i*bytes):b.readInt16BE(i*bytes);
  return v===-32768?NaN:v;
 },close(){fs.closeSync(fd);}};
}
function bilinear(at,x,y) {
 const i=Math.floor(x),j=Math.floor(y),fx=x-i,fy=y-j;
 return (1-fy)*((1-fx)*at(j,i)+fx*at(j,i+1))+fy*((1-fx)*at(j+1,i)+fx*at(j+1,i+1));
}
function oracle() {
 const blend=fileReader('Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif',106694,2,854272,true);
 const mega=fileReader('mega90n000eb.img',5760,2,0),poles=new Map(),mola=new Map();
 const wrap=(i,n)=>(i%n+n)%n;
 const areoid=(lat,lon)=>bilinear((j,i)=>mega.at(j,wrap(i,5760)),((lon+360)%360)*16-.5,(90-lat)*16-.5);
 const raw=(lat,lon)=>bilinear((j,i)=>blend.at(j,wrap(i,106694)),(lon+180)*296.3735-.5,(90-lat)*296.3735-.5);
 const megr=(lat,lon)=>bilinear((j,i)=>{
  i=wrap(i,46080);const band=Math.floor((j-256)/5632),sector=Math.floor(i/11520);
  const name=`megr${['88n','44n','00n','44s'][band]}${['000','090','180','270'][sector]}hb.img`;
  if(!mola.has(name))mola.set(name,fileReader(name,11520,2,0));
  return mola.get(name).at(j-(256+band*5632),i-sector*11520);
 },((lon+360)%360)*128-.5,(90-lat)*128-.5);
 return {raw,rawPost:(j,i)=>blend.at(j,wrap(i,106694)),areoid,megr,blend:(lat,lon)=>raw(lat,lon)+areoid(lat,lon),polar(lat,lon){
  const south=lat<0,name=`megr_${south?'s':'n'}_512.img`;
  if(!poles.has(name))poles.set(name,fileReader(name,12288,4,0,false,true));
  const rho=2*R*Math.tan((90-Math.abs(lat))*rad/2)/(R*rad/512),c=6143.5;
  return bilinear((j,i)=>poles.get(name).at(j,i),c+rho*Math.sin(lon*rad),c+(south?-1:1)*rho*Math.cos(lon*rad));
 },close(){for(const f of [blend,mega,...poles.values(),...mola.values()])f.close();}};
}
function mesh(sized) {
 const t=dttOf(sized.subarray(4)).unpack(),m=decodeQuantizedMesh(decodeEdgeMatchedPlanes(t.PAYLOAD.BYTES)),q=(m.header.maxHeight-m.header.minHeight)/32767,posts=new Map();
 for(let k=0;k<m.vertexCount;k++) {const i=Math.round(m.u[k]/32767*(grid-1)),j=Math.round(m.v[k]/32767*(grid-1));posts.set(`${i}/${j}`,{i,j,lat:t.SOUTH_DEG+j*(t.NORTH_DEG-t.SOUTH_DEG)/(grid-1),lon:t.WEST_DEG+i*(t.EAST_DEG-t.WEST_DEG)/(grid-1),h:m.header.minHeight+m.h[k]*q});}
 return {t,m,q,posts};
}
function healthy(m) {
 for(const p of m.posts.values()) {
  assert.ok(Number.isFinite(p.h)&&p.h!==0&&p.h>-30000&&p.h<30000,`finite, nonzero, plausible height ${m.t.X}/${m.t.Y} ${p.i}/${p.j}: ${p.h}`);
  const a=[];for(let y=p.j-1;y<=p.j+1;y++)for(let x=p.i-1;x<=p.i+1;x++){const v=m.posts.get(`${x}/${y}`);if(v)a.push(v.h);}
  if(a.length===9){const med=median(a),mad=median(a.map(v=>Math.abs(v-med)));assert.ok(Math.abs(p.h-med)<=10*mad+2*m.q,`3x3 spike ${m.t.X}/${m.t.Y} ${p.i}/${p.j}`);}
 }
}
const cfg=caps=>({...MARS_CONFIG,caps,grid_size:65,max_grid_size:grid,fill_diagnostics:1});
const solo=c=>cfg([cap('megr_4',0,2),c]);
function success(r){assert.equal(r.response.statusCode,0,`${r.response.errorCode}: ${r.response.errorMessage}`);return r;}

test('Mars blend L9: detached raster + areoid, holes, polar seams, complete block walk', {skip:!dir&&'MARS_HD_DIR unset',timeout:3600000},async t=>{
 const readers=oracle(),lanes=[];t.after(()=>{readers.close();for(const l of lanes)l.destroy();});
 const lane=async config=>{const l=await createBodyLane({dataDir:dir,config});lanes.push(l);return l;};
 const free=fs.statfsSync(dir);assert.ok(free.bavail*free.bsize>20*1024**3);
 const whole=await lane(cfg(LADDER));const root=await whole.planUnit(0);assert.ok(root.backlog>0);
 const band=await lane(solo(LADDER[8])),first=await band.planUnit(1),count=first.backlog+1;
 assert.equal(count,896);assert.equal(count*32,28672);assert.equal(count*512,458752);
 console.log(`L9 blend band: ${count} units; ${count*32} files; ${count*512} tiles. Full ladder: ${root.backlog+1} units.`);
 const units=[first,await band.planUnit(387),await band.planUnit(count)];
 const seamTiles=new Map();let checked=0,holes=0;
 for(const u of units) {
  console.log(`encode blend unit ${u.index}: ${u.headers.length} tiles, ${u.requests.length} frames`);
  assert.ok(u.requests.length<=16);assert.ok(u.requests.some(r=>r.url.endsWith('.tif')&&Number(r.headers.range.match(/=(\d+)/)[1])>=854272));
  const result=success(await band.encode(u));assert.equal(result.byKey.size,u.headers.length);
  for(const [k,sized] of result.byKey) {
   const m=mesh(sized);healthy(m);
   const report=result.report.tiles.find(r=>`${r.level}/${r.x}/${r.y}`===k),invalid=[];
   const limit=4*296.3735/128;
   if(report.feathered_posts || report.filled_posts) {
    for(let j=Math.floor((90-m.t.NORTH_DEG)*296.3735-.5-limit);j<=Math.ceil((90-m.t.SOUTH_DEG)*296.3735-.5+limit);j++)
     for(let i=Math.floor((m.t.WEST_DEG+180)*296.3735-.5-limit);i<=Math.ceil((m.t.EAST_DEG+180)*296.3735-.5+limit);i++)
      if(!Number.isFinite(readers.rawPost(j,i)))invalid.push([i,j]);
   }
   for(const p of m.posts.values()) {
    const h=readers.blend(p.lat,p.lon),px=(p.lon+180)*296.3735-.5,py=(90-p.lat)*296.3735-.5;
    let d=limit;for(const [i,j] of invalid)d=Math.min(d,Math.hypot(i-px,j-py));
    const w=d/limit,weight=w*w*(3-2*w);
    const expected=!Number.isFinite(h)?readers.megr(p.lat,p.lon):d<limit?readers.megr(p.lat,p.lon)+weight*(h-readers.megr(p.lat,p.lon)):h;
    assert.ok(Math.abs(p.h-expected)<=m.q+.5,`${k} ${p.i}/${p.j}: h=${p.h}, oracle=${expected}, q=${m.q}`);
    if(Number.isFinite(h))checked++;else holes++;
   }
   if((m.t.Y===32&&m.t.X===0)||(m.t.Y===479&&m.t.X===1023))seamTiles.set(m.t.Y,{m,report:result.report.tiles.find(r=>`${r.level}/${r.x}/${r.y}`===k)});
  }
  const packed=await band.pack(u,result.records);assert.equal(packed.length,32);
 }
 for(const [c,brow,prow,x,edge,other] of [[LADDER[7],32,31,0,2,0],[LADDER[9],479,480,1023,0,2]]) {
  const l=await lane(solo(c)),head=await l.planUnit(1),total=head.backlog+1;
  let u;
  for(let k=0;k<total;k++) {
   const next=await l.planUnit(c.product==='megr_s_512'?total-k:k+1);
   if(next.headers.some(h=>h.x===x&&h.y===prow)){u=next;break;}
  }
  assert.ok(u);
  const on=success(await l.encode(u)),r=on.report.tiles.find(r=>r.x===x&&r.y===prow),m=mesh(on.byKey.get(`9/${x}/${prow}`));
  const adjacent=seamTiles.get(brow);assert.ok(adjacent);
  const options=decodeModuleConfig(u.options),plain=Object.fromEntries(Object.entries(options).filter(([k])=>!k.startsWith('body')&&!k.startsWith('fill')&&k!=='featherPosts'));
  const off=success(await l.encode({...u,requests:u.requests.slice(0,options.bodyFillFrame),options:configFrame(plain,'options').payload},k=>k===`9/${x}/${prow}`));
  const bare=mesh(off.byKey.get(`9/${x}/${prow}`));
  assert.equal(r[`edgeHeight${edge}`],adjacent.report[`edgeHeight${other}`],'pre-quantization edge hashes exactly equal');
  let before=0,after=0;
  for(const p of m.posts.values())if(p.j===(edge===0?0:grid-1)) {
   const q=adjacent.m.posts.get(`${p.i}/${other===0?0:grid-1}`);if(!q)continue;
   // Compare the actually encoded unfilled cap to the neighbouring band's
   // surface, including that band's own nodata fill at the antimeridian.
   const previous=bare.posts.get(`${p.i}/${p.j}`);
   if(previous)before=Math.max(before,Math.abs(previous.h-q.h));
   after=Math.max(after,Math.abs(p.h-q.h));assert.ok(Math.abs(p.h-q.h)<=m.q+adjacent.m.q+1e-8);
  }
  assert.ok(Number.isFinite(before)&&before>0);healthy(m);console.log(`${c.product} N=${c.feather_posts}: step before=${before} m, after=0 (exact edge hash), decoded max=${after} m`);
 }
 assert.ok(checked>0);console.log(`Independent vertex checks=${checked}, nodata gap vertices=${holes}; datum=h_blend+bilinear(MEGA DN), R=3396000m; N L8 S/N=58/56, L9 S/N=42/41, L10 S/N=64/39, blend holes=4.`);
});
