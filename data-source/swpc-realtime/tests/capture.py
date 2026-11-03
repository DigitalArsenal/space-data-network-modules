"""Capture verbatim trimmed NOAA arrays. No production parsing or physics."""
import concurrent.futures,datetime,hashlib,json,pathlib,urllib.request
ROOT=pathlib.Path(__file__).parent/'fixtures'
paths=['json/rtsw/rtsw_mag_1m','json/rtsw/rtsw_wind_1m','json/rtsw/rtsw_ephemerides_1h','products/geospace/propagated-solar-wind-1-hour','json/planetary_k_index_1m','products/noaa-planetary-k-index-forecast','json/goes/primary/xrays-7-day','json/goes/primary/integral-protons-7-day','json/goes/primary/integral-electrons-7-day','products/alerts','json/goes/primary/xray-flares-7-day']
def capture(p):
 url='https://services.swpc.noaa.gov/'+p+'.json'
 with urllib.request.urlopen(url,timeout=90) as r: raw=r.read()
 text=raw.decode(); decoder=json.JSONDecoder(); pos=text.index('[')+1; objects=[]
 while True:
  while text[pos].isspace() or text[pos]==',': pos+=1
  if text[pos]==']': break
  obj,n=decoder.raw_decode(text[pos:]); objects.append((obj,text[pos:pos+n])); pos+=n
 # first/last two per platform/channel/status, plus first null-containing row per group.
 groups={}
 for i,(obj,_) in enumerate(objects):
  key=tuple(str(obj.get(k,'')) for k in ['source','satellite','energy','observed','product_id']) if isinstance(obj,dict) else ('table',)
  groups.setdefault(key,[]).append(i)
 selected=set()
 for indices in groups.values():
  selected.update(indices[:2]+indices[-2:])
  for i in indices:
   if isinstance(objects[i][0],dict) and None in objects[i][0].values(): selected.add(i); break
 if isinstance(objects[0][0],list): selected.add(0)
 # Retain both occurrences of the first two repeated-epoch groups, including conflicts.
 repeated={}
 for i,(obj,_) in enumerate(objects):
  if isinstance(obj,dict) and 'time_tag' in obj:
   key=tuple(str(obj.get(k,'')) for k in ['time_tag','source','satellite','energy'])
   repeated.setdefault(key,[]).append(i)
 for indices in [v for v in repeated.values() if len(v)>1][:2]: selected.update(indices)
 chosen=sorted(selected); excerpt=('['+','.join(objects[i][1] for i in chosen)+']\n').encode()
 name=p.split('/')[-1]+'.json'; (ROOT/name).write_bytes(excerpt)
 print(name,len(objects),'->',len(chosen),str(objects[0][0])[:220])
 return dict(file=name,url=url,retrieved_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),full_sha256=hashlib.sha256(raw).hexdigest(),sha256=hashlib.sha256(excerpt).hexdigest(),full_rows=len(objects),source_indices=chosen,rows=len(chosen),selection='Verbatim elements; first/last two per platform/channel/status/product, first null row per group; first two repeated-epoch groups; original order')
if __name__=='__main__':
 ROOT.mkdir(exist_ok=True)
 with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool: records=list(pool.map(capture,paths))
 (ROOT/'provenance.json').write_text(json.dumps(records,indent=2)+'\n')
