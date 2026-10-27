import { FlatSQL } from 'flatsql';
import { createCatalogSearch } from './catalog-search.js';
const bytes = base64 => Uint8Array.from(atob(base64), char => char.charCodeAt(0));
let search;
export function catalogSearch() {
  // The verified APP content hash covers the engine, binary schema and generic
  // workers together. Every runtime uses these identical engine bytes.
  return search ??= (() => {
    const wasm=bytes(__SEARCH_WASM__), bfbs=bytes(__SEARCH_BFBS__);
    const urls=Object.fromEntries(Object.entries(__SEARCH_WORKERS__).map(([name,source])=>[name,URL.createObjectURL(new Blob([source],{type:'text/javascript'}))]));
    const options={backend:'memory',wasmBytes:wasm,verify:actual=>{
      if(actual.length!==wasm.length||!actual.every((byte,i)=>byte===wasm[i]))throw new Error('Search engine differs from the verified APP');
    },workerUrl:urls['browser-guest.mjs'],threadWorkerUrl:urls['wasiThreadBrowserWorker.mjs'],ioWorkerUrl:urls['opfsIoWorker.mjs']};
    return createCatalogSearch({bfbs,openDatabase:()=>FlatSQL.open(options)});
  })();
}
