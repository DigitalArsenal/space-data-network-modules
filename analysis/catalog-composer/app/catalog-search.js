import { encodeFlatSqlQuery, decodeFlatSqlResult } from 'space-data-module-sdk/runtime-host';
import { compositionSearchRecords } from './xmt.js';
const terms = query => {
  if (query.length > 1024) throw new Error('Search is limited to 1,024 characters.');
  const words = query.trim().split(/\s+/u).filter(Boolean);
  if (words.length > 64) throw new Error('Search is limited to 64 terms.');
  return words.map(word => `"${word.replaceAll('"', '""')}"`).join(' AND ');
};
const query = async (db, sql, params = []) => decodeFlatSqlResult(await db.execute(encodeFlatSqlQuery(sql, params)));
const join = parts => { const bytes=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}return bytes; };

/** Index canonical XMT composition objects; SQL returns their report positions.
 * The engine owns FTS and record identity. All conversion uses SDS bindings. */
export function createCatalogSearch({ openDatabase, bfbs, yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0)) }) {
  let current, generation=0;
  return {
    async replace(reportBytes) {
      const ticket=++generation, db=await openDatabase(), positions=new Map();
      try {
        await db.registerSchema({name:'XMT',fileIdentifier:'$XMT',bfbs,fullText:true});
        let frames=[], indices=[], source, bytes=0;
        const flush=async()=>{
          if(!frames.length)return;
          const receipt=decodeFlatSqlResult(await db.ingest('XMT',join(frames),{source}));
          if(receipt.rows.length!==frames.length || receipt.rows.some(row=>row[1]!==1))throw new Error('Search index rejected or deduplicated a composition object');
          for(const [index,,seq] of receipt.rows)positions.set(Number(seq),indices[Number(index)]);
          frames=[];indices=[];bytes=0;await yieldFrame();
        };
        for(const record of compositionSearchRecords(reportBytes)) {
          if(frames.length && (record.source!==source || bytes+record.bytes.length>2*1024*1024 || frames.length===512))await flush();
          if(record.bytes.length>2*1024*1024)throw new Error('Composition object exceeds the search record limit');
          source=record.source;frames.push(record.bytes);indices.push(record.index);bytes+=record.bytes.length;
        }
        await flush();
        if(positions.size) {
          const until=Date.now()+10000;
          for(;;) {
            try { await query(db,'SELECT count(*) FROM XMT WHERE _search MATCH ?1',['"__sdn_index_ready__"']);break; }
            catch(error) { if(![-6,-9].includes(error.status)||Date.now()>until)throw error;await yieldFrame(); }
          }
        }
        if(ticket!==generation)throw new Error('Search index replacement was superseded');
        const previous=current;current={db,positions};await previous?.db.close();
      } catch(error) { await db.close();throw error; }
    },
    async page(text='',page=1,pageSize=100,overlapsOnly=false) {
      const match=terms(text),state=current;
      if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>1000)throw new Error('Invalid search page size');
      if(!state)return {total:0,page:1,pages:1,indices:[]};
      const params=match?[match]:[];
      const clauses=[...(match?['_search MATCH ?1']:[]),...(overlapsOnly?["_source = 'XMT@overlap'"]:[])];
      const where=clauses.length?` WHERE ${clauses.join(' AND ')}`:'';
      const total=Number((await query(state.db,`SELECT count(*) FROM XMT${where}`,params)).rows[0][0]);
      const pages=Math.max(1,Math.ceil(total/pageSize));page=Math.max(1,Math.min(Math.floor(page)||1,pages));
      const result=await query(state.db,`SELECT _rowid FROM XMT${where} ORDER BY _rowid LIMIT ?${params.length+1} OFFSET ?${params.length+2}`,[...params,pageSize,(page-1)*pageSize]);
      const indices=result.rows.map(([seq])=>{const index=state.positions.get(Number(seq));if(index===undefined)throw new Error('Search result has no report position');return index;});
      return {total,page,pages,indices};
    },
    async clear() { ++generation;const old=current;current=undefined;await old?.db.close(); },
  };
}
