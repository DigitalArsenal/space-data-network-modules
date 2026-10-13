# NASA GIBS layer catalog

SDN data retrieval module for the console's IMAGERY catalog, run on a provider
node by the flow `com.digitalarsenal.flows.gibs-layer-catalog-ingest`
(`flow.mjs`, every 12 h). It merges every NASA Global Imagery Browse Services
(GIBS) visualization layer into one OGC WMTS 1.0.0 Capabilities document, adds
it to the node's IPFS (pinned) and announces it as one `$PNM` (FILE_NAME
`gibs-wmts-capabilities.xml`, CID, `/ipfs/` address, FILE_ID
`nasa-gibs:layer-catalog:<file>:<sha256>`), auto-published as `PNM.fbs`,
provider `nasa-gibs`, source `layer-catalog`. The console
(`spaceaware-ui src/orbital-console/data/imageryCatalog.ts`) discovers the lane,
verifies the shard against its signed `$DPM` and reads the document by the CID
the `$PNM` names. Tiles stream from GIBS's public WMTS and WMS endpoints.

| Stage | Asks for |
| --- | --- |
| `plan_capabilities` | the EPSG:3857, EPSG:3413 and EPSG:3031 WMTS Capabilities documents |
| `plan_details` | (parses them) the first of 30 batches: `layer-metadata/v1.0/<id>.json` for every layer, DescribeDomains for each daily or longer layer whose Capabilities time list stops at 100 values |
| `advance` ×29 | absorbs a batch, asks for the next |
| `build_catalog` | nothing: absorbs the last batch and writes the merged document |
| `announce_catalog` | nothing: one `$PNM` from the host adapter's IPFS add result |

The merged document is the EPSG:3857 service (every layer the globe can draw)
plus the polar-only layers with their own renamed TileMatrixSets and literal
polar templates. What GIBS states outside the WMTS vocabulary rides in
`ows:Keywords` (codeSpace = its source: GIBS layer metadata, or
`https://spacedatanetwork.org/def/gibs-catalog` for the derived role, time kind,
analysis kind and polar marks) and `ows:Metadata` (xlink:role = licence,
attribution, citation, CMR collection, the WMS endpoint that draws a vector
layer as PNG). Subdaily layers keep the 100 newest values GIBS lists.

Live run 2026-10-13: 1,356 layers (1,330 drawable on the globe, 26 polar-only),
1,352 with metadata, 21 time domains extended, 6.4 MB, about 1,415 requests.

Licence: NASA Earth science data and imagery are open with no restrictions on
use, sale or redistribution; GIBS asks for its acknowledgment ("We acknowledge
the use of imagery provided by services from NASA's Global Imagery Browse
Services (GIBS), part of NASA's Earth Science Data and Information System
(ESDIS)."), carried on every layer and in the ingest meta. Layers derived from
OpenStreetMap state ODbL 1.0 with "© OpenStreetMap contributors". The catalog is
built only from GIBS's own documents; nothing is taken from NASA Worldview's
configuration.

```sh
npm install && npm run build && npm test
```
