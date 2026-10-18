# Local 3D dust (Edenhofer et al. 2024)

SDN data retrieval module for the local 3D interstellar dust that
`analysis/milky-way-model` bakes (`load_dust_map`), run on a provider node by
the flow `com.digitalarsenal.flows.dust-map-3d-ingest` (`flow.mjs`) and stored
as 61 SDS `$PCE` rows, provider `edenhofer2024`, source `local-dust-1250pc`.

Source: the posterior mean of Edenhofer, Zucker, Frank et al. (2024), A&A 685,
A82, doi:10.1051/0004-6361/202347628, Zenodo record 10658339 (v1.0.2)
`mean_and_std_healpix.fits`: NSIDE 256 NESTED HEALPix spheres at 516
logarithmic distances, 69 to 1248 pc, plus the integrated inner 68.8 pc.
Licence CC BY 4.0; the credit and licence ride in every row and the ingest meta.

| Stage | Asks for (HTTP ranges) |
| --- | --- |
| `plan_dust` | the primary and MEAN FITS headers (23 KiB) |
| `advance_dust` 1 | the STD header, which locates the tables after its data |
| `advance_dust` 2 | the radial tables and the inner sphere (6.3 MB) |
| `advance_dust` 3-12 | 48 MEAN shells per stage, 24 ranges of 6 MiB (each inside the node's 5-minute http.request ceiling) |
| `build_dust` | the last 36 shells; then the rows, meta and report |

- 1.63 GB of the 3.25 GB file is read; the STD data never is.
- Each 20 pc voxel of the heliocentric Galactic grid (125 x 125 x 61:
  |X|, |Y| <= 1250 pc, |Z| <= 610 pc) is the volume-weighted (r^2 dr dOmega)
  mean of the HEALPix samples whose centres fall in it, so the integrated
  extinction is conserved. Voxel centres beyond 1248 pc carry NaN (no data).
- Units stay the map's: E of Zhang, Green & Rix (2023) per pc;
  A_V(540 nm) = 2.8 E (Edenhofer et al. 2024, section 5), carried as
  `a_v_per_unit`.
- The report compares 16 sightlines (|b| < 27 deg) integrated natively against
  the resampled grid; the median ratio is 0.978.
- Host capabilities on typed contracts 1.0: each range is an `HttpRequest`
  (HREQ: GET, the range in the URL and the `Range` header, `MAX_BYTES`) for
  `hostcap/http-request`, each answer its `HttpResponse` (HRSP), and the ingest
  meta an `IngestRequest` (INGQ: `PCE.fbs`, the provider, source, batch,
  producer peer, license and credit, `RECONCILE` Current) for
  `hostcap/storage-ingest`, whose `pce_records` port takes the rows. The stage
  state, configuration, receipt, status and report are intra-flow control
  frames.
- Host adapter (`host-adapter/`, wasmedge): `prepare_scheduled` reads the flow
  configuration (`dust_map_3d_enabled`, `dust_map_3d_producer_peer_id`,
  `dust_map_3d_source.access = anonymous`); `receipt_scheduled` stamps the
  retrieval.

Row fields (`$PCE`, provider-defined): `dataset`, `plane`, `shape`, `first_center`
(kpc), `spacing` (kpc), `max_radius` (kpc), `unit`, `a_v_per_unit`, `density`
(row-major x fastest, NaN = no data), `frame`, `source`, `license`, `credit`,
`retrieved_at`.

```sh
npm install && npm run build
```

The E2E, `node tests/typed-retrieval.e2e.mjs`, checks that the flow's edges
match the host capabilities' declared ports and types, then runs every stage
against an offline copy of the published file in `.source-cache/` (gitignored;
`tests/offline-retrieval.mjs` answers each HttpRequest as hostcap/http-request
would) and checks the requests, the 61 rows, the IngestRequest and the
extinction the resampling conserves. The Milky Way model's E2E
(`analysis/milky-way-model/tests/band-vs-gaia.e2e.mjs`) loads the same rows.
