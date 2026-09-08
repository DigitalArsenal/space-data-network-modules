import { initFlatSQL } from 'flatsql/wasm';
import FlatSQLModule from 'catalog-search-wasm-factory';
import { createCatalogSearch } from './catalog-search.js';

let pending;
export function catalogSearch() {
  // The APP's verified content hash covers these embedded engine bytes and
  // their matching factory. No external WASM or integrity-file fetch occurs.
  return pending ??= initFlatSQL({ skipIntegrityCheck:true,
    moduleFactory: options => FlatSQLModule({ ...options, wasmBinary:Uint8Array.from(atob(__SEARCH_WASM__), char => char.charCodeAt(0)) }),
  }).then(engine => createCatalogSearch(engine));
}
