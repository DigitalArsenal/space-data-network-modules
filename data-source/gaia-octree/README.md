# data-source/gaia-octree

Gaia DR3 to G 13.5 as two SDN layers, made on a provider node from ESA's
Gaia archive. Distances are Bailer-Jones et al. 2021, not 1/parallax.

| Layer | Publication (schema, provider, source) | Tiles |
| --- | --- | --- |
| Angular | `SKT.fbs`, `gaia-dr3`, `angular-g13.5` | HEALPix NESTED order 4 (3,072), the IVOA HiPS numbering: `ORDER` is HiPS `Norder`, `PIXEL` is `Npix` |
| 3D octree | `SKT.fbs`, `gaia-dr3`, `octree-g13.5` | `OCTREE_HELIO_ICRS` nodes, 4,096 stars each, after Sagrista et al. 2019 |

- **Angular.** Every star to G 13.5, in the tile its J2016.0 place lies in,
  brightest first. `ROW_COLLECTION_CID` holds the `$STR` rows (position,
  proper motion, parallax, radial velocity, G/BP/RP, distance fields).
  `PAYLOAD_CID` holds the `SKTPoint`s.
- **Octree.** The stars with (r_hi - r_lo) / r_med <= 0.5, sorted by M_G.
  M_G is de-reddened with milky-way-model's analytic dust (Drimmel & Spergel
  2001; no dust-map rows are loaded). The march is tabulated per HEALPix
  order-6 direction. `PAYLOAD_CID` holds the `SKTPoint3D`s and
  `ROW_COLLECTION_CID` minimal `$STR` rows (G, BP and RP to 1 mmag).
- **Bright stars.** A Gaia star brighter than G 4 with a Hipparcos match
  takes the EDSD distance on its Hipparcos 2007 parallax. A Hipparcos star
  with no Gaia counterpart is a Hipparcos-only row: J1991.25 astrometry, and
  G from V by Riello et al. 2021, flagged as modeled.
- **Consumers.** `com.digitalarsenal.data-source.gaia-octree-cones`
  (`cones/`, browser and WasmEdge, no capabilities) answers `$SKQ` cones.
  `cone_tiles` names the tiles a cone may touch. `cone_rows` keeps the rows
  inside it at its epoch.

The flow `com.digitalarsenal.flows.gaia-octree-ingest` runs every 30 days.
Its configuration (`plugin.getConfig`):
- `gaia_octree_enabled`, `gaia_octree_producer_peer_id`;
- `gaia_octree_g_limit` (13.5), `gaia_octree_tap_url` (ESA's TAP);
- `gaia_octree_sky` (order-3 pixels; empty is all 768);
- `gaia_octree_range_rows` (30,000 rows per answer).

ESA's sync service ends long queries with 408 and long answers early. Each
range is checked against the archive's own count, and a short range is split.

## Build and test

```sh
npm install && node build.mjs
SDN_NODE_BINARY=<sdn main at or after 90e522de0> node --test tests/gaia-octree.e2e.test.mjs
```

The E2E runs a local provider node and checks four things:
- the octree invariants;
- 20 SIMBAD-named stars, within 1 mas at J2000, and their distances
  against CDS I/352;
- the s2a field's 41 ESA cones;
- two tiles against the CDS Gaia DR3 HiPS catalog.

It also logs the node's peak RSS, which must be 2 GB or less.
`GAIA_OCTREE_FULL_SKY=1` runs the whole sky.

Credits and licenses: `NOTICE`. Gaia DR3 is CC BY-NC 3.0 IGO (ESA/Gaia/DPAC).
