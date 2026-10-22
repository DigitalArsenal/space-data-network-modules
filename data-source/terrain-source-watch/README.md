# Terrain source watch

The monthly terrain check probes public source files with a one-byte ranged
GET, compares their metadata with the `raw/<naif>/` mirror, and checks Mars
insets directly from the mirror listing. It emits a FlatBuffer QRP report and
FlowNotice. The terrain-refresh flow stores reports at
`watch/<naif>/<yyyy-mm-dd>.qrp`. It does not re-encode terrain.

`tools/generate-sources.mjs` reads terrain-ingest's `src/body_plan.hpp`:
`bodies()` supplies the global products, while `body_insets()` and
`append_mars_insets()` supply inset sizes, mirror paths, and serving levels.
The generated `src/watch_sources.hpp` contains 93 files: 34 Moon and 59 Mars.
Mars includes 20 HRSC HMC-30 files, six Gale files, and six Jezero/MSR files.

The insets' only source is the R2 `raw/499/` mirror. There is no public source
URL for them, and they are never probed over HTTP. Their products match the
folders `hrsc_hmc30_dt5`, `msl_gale_dem_1m_v3`, and
`msr_trn_hirise_dtm_1m_v003`. The file field retains `ovr/` when present, so
`raw/499/<product>/<file>` identifies the actual object. Overview names are
not separate product folders.

For each inset, a missing object is `not-mirrored`, a mirror size different
from the byte-size pin is `size-changed`, and an exact match is `current`.
The report retains the same columns for every row; inset `source_url`,
`source_etag`, `source_size`, `source_last_modified`, and `probe_error` cells
are null. `pinned_size` holds the inset's exact byte count. Public sources
retain their ETag pins. `pins=off` disables public-source pin comparisons and
uses mirror size and Last-Modified instead; inset size pins always apply
because there is no independent source metadata to compare.

Configure `bodies=moon,mars` for one monthly run, or `body=moon` / `body=mars`
for a single body, plus storage `endpoint`, `bucket`, `store` (default `r2`),
and `region` (default `auto`). The combined run uses 61 probes (34 Moon and
27 Mars) plus two listings: 63 input frames, within the node's limit of 64.
Separate runs are unnecessary. Each list request covers the entire
`raw/<naif>/` prefix without a delimiter, including nested `<product>/ovr/`
keys. The existing list leg requests one page of up to 1,000 keys, enough for
the current mirror; it does not follow continuation tokens.

The node needs the read grant on `secrets:storage_r2` to obtain credentials
for listing and storing the report. An unreadable mirror still produces a
report and a `mirror unreadable` notice but stores nothing. In that report,
inset state is null because its only source could not be read.

With dependencies already installed, set `SPACE_DATA_STANDARDS_ROOT` to the
local standards checkout (including `lib/ts` and dependencies). If the shared
storage harness has no SDK installed, set `NODE_PATH` to this package's
absolute `node_modules` path. Build and verify from this package:

```sh
node tools/generate-sources.mjs --check
node build.mjs
(cd ../../flows/terrain-refresh && npm run build)
node --test tests/*.mjs
```

The module build uses the shared `scripts/lib/build-module.mjs` and the
SDK's bundled compiler. It emits `dist/isomorphic/module.wasm` and the
`dist/guest-link/` object used by the flow compiler. The flow build refreshes
the embedded module bytes in `flows/terrain-refresh/dist`.

The e2e tests run the built flow with simulated publishers and a local
SigV4-verifying S3 server. They cover all 32 Mars inset rows, nested mirror
keys, exact and changed size pins, missing objects, and a combined Moon/Mars
run. They require no live publisher or R2 access. Run tests directly as above
to use existing dependencies; `npm run e2e` also provisions storage dependencies
and runs `npm ci`.
