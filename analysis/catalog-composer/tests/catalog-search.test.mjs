import test from 'node:test';
import assert from 'node:assert/strict';
import { initFlatSQL } from 'flatsql/wasm';
import { createCatalogSearch } from '../app/catalog-search.js';

test('FTS searches the complete composition before pagination and atomically replaces it', async () => {
  const engine = await initFlatSQL({skipIntegrityCheck:true});
  const search = createCatalogSearch(engine,{yieldFrame:async()=>{}});
  try {
    const rows = Array.from({length:1501},(_,index)=>({key:`norad:${index+1}`,name:`Orbit object ${index+1}`,candidates:[]}));
    rows[1500]={key:'norad:25544',name:'München optical payload',candidates:[{nativeKey:'S25544',designator:'1998-067A',name:'Alternate name'}]};
    await search.replace(rows);
    assert.deepEqual(search.page('optical munchen').indices,[1500]);
    assert.deepEqual(search.page('S25544 1998-067A').indices,[1500]);
    assert.equal(search.page('orb').total,0); // token search, not a page substring filter
    assert.equal(search.page('orbit',15).indices[0],1400);
    assert.equal(search.page('missing').total,0);
    assert.equal(search.page('',16).indices[0],1500);
    assert.throws(()=>search.page('x'.repeat(1025)),/limited/);
    assert.doesNotThrow(()=>search.page('" OR - *'));
    await search.replace([{key:'norad:42',name:'Replacement',candidates:[]}]);
    assert.equal(search.page('optical').total,0);
    assert.deepEqual(search.page('replacement').indices,[0]);
    search.clear();assert.equal(search.page('').total,0);
  } finally { search.clear(); }
});
