// Independent source reader. UTC epochs, source units/frames; exact binary64 equality
// (zero numerical tolerance: the parser performs no arithmetic on measurements).
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const hash=b=>createHash('sha256').update(b).digest('hex');
export function rows(bytes){const a=JSON.parse(bytes);return Array.isArray(a[0])?a.slice(1).map(v=>Object.fromEntries(a[0].map((k,i)=>[k,v[i]]))):a;}
const stamp=s=>Date.parse(s.replace(' ','T')+(/Z$/.test(s)?'':'Z'));
const numeric=v=>v===null?NaN:Number(v);
const same=(a,b,label)=>assert.ok(Object.is(a,b)||a===b,`${label}: ${a} != ${b}`);
const ignored=new Set(['time_tag','source','satellite','energy','propagated_time_tag','observed','noaa_scale']);
export function verifySws(records,sources){
 verifyQuantities(records);
 let values=0,flags=0,sourceRows=0;const consumed=new Set();
 for(const source of sources){const data=rows(source.bytes);sourceRows+=data.length;const name=source.file.replace('.json','');
 const relevant=records.filter(r=>r.PROVENANCE.LINEAGE===source.url);assert(relevant.length,source.file);
 for(const r of relevant){assert.equal(r.SOURCE_DIGEST,hash(source.bytes));assert.equal(r.SOURCE_CID,'f01551220'+hash(source.bytes));assert.equal(Date.parse(r.RETRIEVED_AT),Date.parse(source.retrieved_at));assert.equal(r.PROVENANCE.SOURCE_ID,'noaa-swpc-rt');assert.equal(r.PROVENANCE.PROVIDER_ID,'space-weather');assert.equal(r.PROVENANCE.LICENSE_ID,'public-domain');
  const [feed,key,field]=r.SERIES_ID.split('/');assert.equal(feed,name);assert.equal(r.QUANTITY_NAME,field);
  const expected=data.filter(x=>[x.source??'',x.satellite??'',x.energy??'',x.time_tag.slice(0,10)].join('|')===key).sort((a,b)=>stamp(a.time_tag)-stamp(b.time_tag));assert.equal(r.EPOCHS_MS.length,expected.length);assert.equal(r.VALUES.length,expected.length);
  assert.deepEqual(r.EPOCHS_MS.map(Number),expected.map(x=>stamp(x.time_tag)));
  assert.deepEqual(r.PLATFORMS,expected[0].source?[expected[0].source]:expected[0].satellite?[String(expected[0].satellite)]:[]);
  for(let i=0;i<expected.length;i++){const x=expected[i];same(r.VALUES[i],numeric(x[field]),`${feed} ${field} ${x.time_tag}`);values++;
   if('active'in x)assert.equal(Boolean(r.ACTIVE[i]),x.active);
   if(r.QUALITY.length)assert.equal(r.QUALITY[i],x.overall_quality);
   if(r.SAMPLE_COUNTS.length)assert.equal(r.SAMPLE_COUNTS[i],x[field.startsWith('alpha_')?'alpha_sample_size':feed==='rtsw_wind_1m'?'proton_sample_size':'sample_size']);
   if(x.propagated_time_tag)assert.equal(Number(r.PROPAGATED_EPOCHS_MS[i]),stamp(x.propagated_time_tag));
   if(x.observed){assert.equal(r.SAMPLE_STATUS[i],{observed:4,estimated:2,predicted:7}[x.observed]);assert.equal(r.NOAA_SCALE_LEVELS[i],x.noaa_scale?Number(x.noaa_scale.slice(1)):0);assert.equal(r.NOAA_SCALE_KIND,1);}
   for(let f=0;f<r.FLAG_NAMES.length;f++){const k=r.FLAG_NAMES[f];same(r.FLAG_VALUES[f*expected.length+i],k.startsWith('kp=')?Number(x.kp===k.slice(3)):numeric(x[k]),feed+' flag '+k);flags++;}
  }
  const suffix=field.match(/_(gse|gsm|gci)$/)?.[1];assert.equal(r.REFERENCE_FRAME?.NAME??'',suffix?.toUpperCase()??'');
  if(expected[0].energy?.includes('nm')){const [lo,hi]=expected[0].energy.replace('nm','').split('-').map(Number);assert.equal(r.PASSBAND_MIN_NM,lo);assert.equal(r.PASSBAND_MAX_NM,hi);assert.equal(r.UNITS,'W/m^2');assert.equal(r.QUANTITY,field==='flux'?35:36);}
  if(expected[0].energy?.includes('MeV')){assert.equal(r.ENERGY_MIN_MEV,Number(expected[0].energy.match(/[\d.]+/)[0]));assert(Number.isNaN(r.ENERGY_MAX_MEV));assert.equal(r.QUANTITY,feed.startsWith('integral-protons')?37:38);}
  consumed.add(r.SERIES_ID);
 }
 // Coverage is driven by source keys, not by whatever the producer emitted.
 for(const x of data){const key=[x.source??'',x.satellite??'',x.energy??'',x.time_tag.slice(0,10)].join('|');const group=relevant.filter(r=>r.SERIES_ID.split('/')[1]===key);assert(group.length);
  for(const [k,v]of Object.entries(x)){if(ignored.has(k))continue;const q=group.find(r=>r.QUANTITY_NAME===k);if(q)continue;assert(group.every(r=>r.FLAG_NAMES.includes(k)||(k==='kp'&&r.FLAG_NAMES.includes('kp='+v))),`Unrepresented ${source.file} key ${k}`);}
 }
 }
 assert.equal(consumed.size,records.length,'No extra or duplicate SWS records');return {records:records.length,sourceRows,values,flags};
}
export function verifySwa(records,source){const expected=rows(source.bytes);assert.equal(records.length,expected.length);let fields=0;for(const x of expected){const r=records.find(r=>r.PRODUCT_ID===x.product_id&&Date.parse(r.ISSUED_AT)===stamp(x.issue_datetime));assert(r);assert.equal(r.MESSAGE,x.message);assert.equal(r.SOURCE_DIGEST,hash(source.bytes));assert.equal(r.SOURCE_CID,'f01551220'+hash(source.bytes));assert.equal(Date.parse(r.RETRIEVED_AT),Date.parse(source.retrieved_at));for(const key of Object.keys(x))assert(['product_id','issue_datetime','message'].includes(key),'Unrepresented SWA key '+key);fields+=Object.keys(x).length;
 const time=label=>{const value=x.message.match(new RegExp(label+': ([^\\r\\n]+)'))?.[1];if(!value)return '';const m=value.match(/^(\d{4}) (\w{3}) (\d{2}) (\d{2})(\d{2}) UTC$/);if(!m)return '';return new Date(Date.UTC(+m[1],['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[2]),+m[3],+m[4],+m[5])).toISOString().replace('.000Z','Z');};
 for(const [dst,label]of Object.entries({BEGIN_TIME:'Begin Time',END_TIME:'End Time',VALID_FROM:'Valid From',VALID_TO:'Valid To'}))assert.equal(r[dst]??'',time(label));
 const scale=x.message.match(/(?:NOAA|Noaa) Scale: ([GSR])([1-5])/);assert.equal(r.SCALE_FAMILY,scale?{G:1,S:2,R:3}[scale[1]]:0);assert.equal(r.SCALE_LEVEL,scale?+scale[2]:0);
assert.equal(r.MESSAGE_CODE,x.message.match(/Space Weather Message Code: ([^\r\n]+)/)?.[1]??'');assert.equal(r.SERIAL_NUMBER,x.message.match(/Serial Number: ([^\r\n]+)/)?.[1]??'');}return {records:records.length,sourceRows:expected.length,fields};}
export function verifyFlares(records,source){
 const expected=rows(source.bytes);assert.equal(records.length,expected.length);
 const byId=new Map(records.map(r=>[r.EVENT_ID,r]));assert.equal(byId.size,records.length,'Unique flare identities');
 const strings={begin_time:'BEGIN_TIME',max_time:'PEAK_TIME',end_time:'END_TIME',max_class:'XRAY_CLASS',begin_class:'BEGIN_XRAY_CLASS',end_class:'END_XRAY_CLASS',max_ratio_time:'PEAK_RATIO_TIME'};
 const numbers={max_xrlong:'PEAK_FLUX_W_M2',current_int_xrlong:'INTEGRATED_FLUX_J_M2',max_ratio:'PEAK_RATIO'};
 const keys=['time_tag','satellite',...Object.keys(strings),...Object.keys(numbers)].sort();let fields=0,nullRatios=0;
 for(const x of expected){
  assert.deepEqual(Object.keys(x).sort(),keys,'Every source field has an independent comparison');
  const r=byId.get(String(x.satellite)+'/'+x.time_tag);assert(r,'Flare time_tag identity');
  assert.equal(r.PLATFORM,String(x.satellite));fields+=2;
  for(const [src,dst] of Object.entries(strings)){assert.equal(r[dst]??null,x[src],src);fields++;}
  for(const [src,dst] of Object.entries(numbers)){same(r[dst],numeric(x[src]),src);fields++;}
  if(x.max_ratio===null){assert(Number.isNaN(r.PEAK_RATIO));nullRatios++;}
  assert.equal(r.PRODUCT,'xray-flares-7-day');assert.equal(r.EVENT_KIND,1);
  assert.equal(r.PASSBAND_MIN_NM,.1);assert.equal(r.PASSBAND_MAX_NM,.8);
  assert.equal(r.SOURCE_DIGEST,hash(source.bytes));assert.equal(r.SOURCE_CID,'f01551220'+hash(source.bytes));
  assert.equal(Date.parse(r.RETRIEVED_AT),Date.parse(source.retrieved_at));
  assert.equal(r.PROVENANCE.LINEAGE,source.url);assert.equal(r.PROVENANCE.LICENSE_ID,'public-domain');
  assert.equal(r.PROVENANCE.PROVIDER_ID,'space-weather');assert.equal(r.PROVENANCE.SOURCE_ID,'noaa-swpc-rt');
 }
 return {records:records.length,sourceRows:expected.length,fields,nullRatios};
}


// Independent metadata contract, kept separate from C++ field dispatch.
export function verifyQuantities(records){
 const base={bt:[1,'nT'],bx:[2,'nT'],by:[3,'nT'],bz:[4,'nT'],phi:[5,'deg'],theta:[6,'deg'],speed:[7,'km/s'],proton_speed:[7,'km/s'],vx:[8,'km/s'],vy:[9,'km/s'],vz:[10,'km/s'],proton_vx:[8,'km/s'],proton_vy:[9,'km/s'],proton_vz:[10,'km/s'],density:[11,'cm^-3'],proton_density:[11,'cm^-3'],temperature:[12,'K'],proton_temperature:[12,'K'],alpha_speed:[13,'km/s'],alpha_density:[14,'cm^-3'],alpha_temperature:[15,'K'],estimated_kp:[20,'1'],kp:[20,'1']};
 for(const r of records){const feed=r.SERIES_ID.split('/')[0],field=r.QUANTITY_NAME,key=field.replace(/_(?:gse|gsm|gci)$/,'');let expected=base[key];
  if(feed==='rtsw_ephemerides_1h')expected=[0,key.startsWith('v')?'km/s':'km'];
  if(key.startsWith('alpha_v'))expected=[0,'km/s'];
  if(field==='flux')expected=feed==='xrays-7-day'?[35,'W/m^2']:[feed.startsWith('integral-protons')?37:38,'cm^-2 s^-1 sr^-1'];
  if(field==='observed_flux')expected=[36,'W/m^2'];
  assert(expected,'Missing test quantity contract '+field);assert.deepEqual([r.QUANTITY,r.UNITS],expected,feed+'/'+field);
  assert.equal(r.CADENCE_S,feed==='rtsw_ephemerides_1h'?3600:feed==='noaa-planetary-k-index-forecast'?10800:feed.startsWith('integral-')?300:60);
  assert.equal(r.LOCATION,feed.startsWith('rtsw_')?1:feed.startsWith('propagated-')?3:feed.includes('k-index')||feed==='planetary_k_index_1m'?5:4);
  assert.equal(r.SAMPLE_CONVENTION,0,'Unknown sample convention must remain unspecified');
  if(feed==='integral-protons-7-day'&&r.ENERGY_MIN_MEV===10){assert.equal(r.NOAA_SCALE_KIND,2);assert.deepEqual(r.NOAA_SCALE_LEVELS,r.VALUES.map(x=>[10,100,1000,10000,100000].filter(t=>x>=t).length));}
 }
}
