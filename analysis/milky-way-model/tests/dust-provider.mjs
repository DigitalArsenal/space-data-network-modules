// The provider-node side of the E2E, IO only: data-source/dust-map-3d's own
// offline retrieval (its stages answered from the offline copy of the
// published Zenodo file as hostcap/http-request would, typed contracts 1.0),
// returning the $PCE rows the node would publish over SDN. No dust physics
// here: every number is WASM.
export {dustSource, deliverDustRows} from '../../../data-source/dust-map-3d/tests/offline-retrieval.mjs';
