// Test-only independent source reader. Units: F10.7 sfu, Kp*10 integers, Ap dimensionless; UTC days.
import assert from 'node:assert/strict';
export function verifySources(records,bodies,today) {
 const rows=new Map();const key=(y,m,d)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
 for(const body of bodies.slice(0,2))for(const line of body.toString().split('\n')) {
  if(!line||line.startsWith('#'))continue;const v=line.trim().split(/\s+/).map(Number);assert.equal(v.length,28);
  rows.set(key(...v.slice(0,3)),{flux:v[25],adj:v[26],ap:v[23],kp:v.slice(7,15).map(k=>k<0?-1:Math.round(k*10)),aps:v.slice(15,23),predicted:false});
 }
 const parts=bodies[2].toString().split('45-DAY F10.7 CM FLUX FORECAST');assert.equal(parts.length,2);
 for(const [i,text] of parts.entries())for(const m of text.matchAll(/(\d{2})([A-Z][a-z]{2})(\d{2})\s+(\d+)/g)){
  const d=new Date(`${m[2]} ${m[1]}, 20${m[3]} 00:00:00 GMT`).toISOString().slice(0,10);let row=rows.get(d);if(!row){row={flux:-1,adj:-1,ap:-1,kp:Array(8).fill(-1),aps:Array(8).fill(-1),predicted:false};rows.set(d,row);}
  if(i===0&&row.ap<0)row.ap=Number(m[4]);if(i===1&&row.flux<0){row.flux=Number(m[4]);row.predicted=true;}
 }
 for(const r of JSON.parse(bodies[3])){const d=r.time_tag.slice(0,10),row=rows.get(d);if(row){const k=Number(r.time_tag.slice(11,13))/3;if(row.kp[k]<0)row.kp[k]=Math.round(r.kp*10);}}
 const mean=(d,offset,field)=>Array.from({length:81},(_,i)=>rows.get(new Date(Date.parse(d+'T00:00:00Z')+(offset+i)*86400000).toISOString().slice(0,10))?.[field]);
 let current=false;for(const r of records){const src=rows.get(r.DATE);assert(src,r.DATE);assert.equal(r.F107_OBS,Math.fround(src.flux),r.DATE+' flux');assert.equal(r.AP_AVG,src.ap,r.DATE+' daily Ap');
 for(let i=0;i<8;i++){assert.equal(r['KP'+(i+1)],src.kp[i],r.DATE+' Kp');assert.equal(r['AP'+(i+1)],src.aps[i],r.DATE+' ap');}
 assert.equal(r.F107_DATA_TYPE,src.predicted?2:0);assert.equal(r.ISN,0,'SN must be absent/default');
 for(const [field,offset] of [['F107_OBS_CENTER81',-40],['F107_OBS_LAST81',-80]]){const values=mean(r.DATE,offset,'flux');assert(values.every(v=>v>0));assert.equal(r[field],Math.fround(values.reduce((a,b)=>a+b,0)/81),r.DATE+' '+field);}
 current ||= r.DATE===today;
 }
 assert(current,'Today must be published');assert(records.length>=40);
}
