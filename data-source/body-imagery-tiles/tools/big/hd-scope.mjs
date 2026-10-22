import fs from 'node:fs';
export const HD_SOURCES=JSON.parse(fs.readFileSync(new URL('./hd-sources.json',import.meta.url)));
export function planWindows({source,levels,bbox}) {
  const s=HD_SOURCES[source];
  if(!s) throw Error(`unknown HD source ${source}`);
  if(!Array.isArray(levels)||!levels.length||levels.some(l=>!Number.isInteger(l)||l<s.minLevel||l>s.maxLevel)) throw Error('explicit levels must be above protected base levels');
  if(!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite)) throw Error('explicit west,south,east,north bbox required');
  const [w,so,e,n]=bbox;
  if(w< -180||e>180||so< -90||n>90||w>=e||so>=n) throw Error('invalid bbox; split antimeridian regions');
  const out=[];
  for(const level of [...new Set(levels)].sort((a,b)=>a-b)) {
    const span=180/2**level;
    // Tile coverage encloses the requested polygon; the exact expanded bounds are recorded.
    const xa=Math.floor((w+180)/span), xb=Math.min(2**(level+1)-1,Math.ceil((e+180)/span)-1);
    const ya=Math.floor((so+90)/span), yb=Math.min(2**level-1,Math.ceil((n+90)/span)-1);
    for(let row=ya;row<=yb;row++) for(let x=xa;x<=xb;) {
      const tiles=Math.min(xb-x+1,16-x%16);
      out.push({source,level,row,x,tiles});x+=tiles;
    }
  }
  return out;
}
export function validateKey(key, naif, levels, prefix=`imagery/${naif}`) {
  if(!/^imagery\/(301|499)$/.test(prefix)&&!/^staging\/imagery-hd\/[a-z0-9-]+\/(301|499)$/.test(prefix)) throw Error('invalid publish prefix');
  if(!prefix.endsWith('/'+naif)) throw Error('prefix belongs to a different body');
  if(naif===499&&prefix.startsWith('imagery/')) throw Error('CTX requires staging until reader fallback is verified');
  const relative=key.slice(prefix.length+1);
  if(!key.startsWith(prefix+'/')||!/^\d+\/\d+_\d+\.dtts$/.test(relative)) throw Error('only explicitly selected HD tile files may be written');
  const l=Number(relative.split('/')[0]);
  if(!levels.includes(l)||l<({301:9,499:10}[naif])||l>({301:9,499:13}[naif])) throw Error('protected or unrequested level');
  return l;
}
