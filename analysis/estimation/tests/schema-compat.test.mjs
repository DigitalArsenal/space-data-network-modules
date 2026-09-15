import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const old=fs.readFileSync(new URL('../node_modules/space-data-module-sdk/schemas/orbpro/Estimation.fbs',import.meta.url),'utf8');
const current=fs.readFileSync(new URL('../schemas/Estimation.fbs',import.meta.url),'utf8');
const clean=s=>s.replace(/\/\/[^\n]*/g,'').replace(/\s+/g,'').replace(/,$/,'');
function definitions(s) {return [...s.matchAll(/\b(struct|table|enum)\s+(\w+)[^{]*\{([^}]+)\}/g)].map(m=>({kind:m[1],name:m[2],body:clean(m[3])}));}
test('module-local contract preserves every old struct, enum ordinal and table field prefix',()=>{
 const additions=new Map(definitions(current).map(d=>[d.name,d]));
 for(const d of definitions(old)){const next=additions.get(d.name);assert.ok(next,d.name);assert.equal(next.kind,d.kind);if(d.kind==='struct')assert.equal(next.body,d.body,d.name);else assert.ok(next.body===d.body || next.body.startsWith(d.body+(d.kind==='enum'?',':'')),d.name);}
 assert.match(current,/file_identifier "\$EST"/);
});
