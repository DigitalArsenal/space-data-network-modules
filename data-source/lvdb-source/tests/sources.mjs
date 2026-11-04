import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const marker='https://raw.githubusercontent.com/apace7/local_volume_database/main/code/release_version.txt';
export const urls=['comb_all.ecsv','pm_overview.csv','j_factor.csv'].map(n=>'https://github.com/apace7/local_volume_database/releases/download/v1.1.1/'+n).concat('https://api.github.com/repos/apace7/local_volume_database/tarball/v1.1.1');
export async function sources(root){const dir=path.join(root,'tests/cache');await fs.mkdir(dir,{recursive:true});const provenance=(await fs.readFile(path.join(root,'tests/fixtures/provenance.tsv'),'utf8')).trim().split('\n').slice(1).map(l=>l.split('\t'));const all=[];for(const [i,url]of urls.entries()){const file=path.join(dir,i+'.bin');let bytes;try{bytes=await fs.readFile(file);}catch{const r=await fetch(url,{signal:AbortSignal.timeout(90000)});if(!r.ok)throw Error('Fetch '+url+': '+r.status);bytes=Buffer.from(await r.arrayBuffer());await fs.writeFile(file,bytes);}if(hash(bytes)!==(i<3?provenance[i][3]:'1daa9ffb5f2705b9819e13dbc5557f78546ede33892dbd371f2067a02fbbf628'))throw Error('Release asset hash changed: '+url);all.push({url,bytes,retrievedMs:Date.parse(provenance[0][2])});}return all;}
export function tarFiles(gz){const b=gunzipSync(gz),out={};for(let at=0;at+512<=b.length&&b[at];){const name=b.subarray(at,at+100).toString().split('\0')[0].split('/').slice(1).join('/');const n=parseInt(b.subarray(at+124,at+136).toString().replaceAll('\0','').trim(),8);out[name]=b.subarray(at+512,at+512+n);at+=512+Math.ceil(n/512)*512;}return out;}
// Independent test-only CSV reader; no record construction or host data conversion.
export function csv(text,delimiter=','){const rows=[];let row=[],cell='',quote=false;for(let i=0;i<=text.length;i++){const c=text[i]??'\n';if(c==='"'){if(quote&&text[i+1]==='"'){cell+='"';i++;}else quote=!quote;}else if(!quote&&(c===delimiter||c==='\n')){row.push(cell);cell='';if(c==='\n'){if(row.some(Boolean))rows.push(row);row=[];}}else if(c!=='\r')cell+=c;}const keys=rows.shift();return rows.map(r=>Object.fromEntries(keys.map((k,i)=>[k,r[i]])));}
export const ecsv=b=>csv(b.toString().split('\n').filter(l=>!l.startsWith('#')).join('\n'),' ');
