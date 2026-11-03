# Reference states

Precise orbits from outside the catalog, as GCRF states in UTC for each
catalogued object, with the product's stated accuracy as covariance. These are
the truth that orbit uncertainty is calibrated against: GP prediction errors,
covariance realism and conjunction probabilities are scored against them,
never against the catalog itself.

## Method `reference_states`

One SP3 file per call, read first by `files/orbit-products` `read_container`.

| Port | Type | Content |
| --- | --- | --- |
| `ephemeris` | `$OEM` | `read_container` output: one block per satellite, Earth-fixed, on the file's time scale |
| `descriptor` | `$NCD` | `read_container` output: the SP3 header and the file's SHA-256 |
| `earth_orientation` | `$EOP` | rows bracketing the file (one row, several frames, or a size-prefixed stream) |
| `reference` (out) | `$OEM` | one per identified satellite |

The identities are node config, read through `plugin.getConfig` (one
ModuleConfig, `sdm_piv::get_config`): `product`, `source`, optional
`statedSigmaM` with `statedSigmaBasis`, and `satellites.<SP3 id>` =
`{norad, objectId, name}`. One config per SP3 file.

- **Time:** GPS, Galileo and QZSS time are TAI − 19 s; BeiDou time is
  TAI − 33 s; GLONASS time is UTC + 3 h. TAI, TT and UTC are also accepted.
  Output epochs are UTC.
- **Frame:** the SP3 coordinate system must be an ITRF realization (IGS20,
  IGc20, SLRF2020, ITRF…). ITRS is rotated to GCRS by IAU 2006/2000A, CIO
  based (ERFA), using the supplied polar motion, UT1−UTC and dX/dY. The
  velocity transform includes ω×r, with ω scaled by LOD.
- **Velocity:** the product's own velocity when the file carries one.
  Otherwise, the derivative of the degree-9 Lagrange interpolant through the
  ten nearest epochs. An epoch whose window spans a gap (a missing record) is
  omitted.
- **Uncertainty:** the first available of:
  1. the record's standard deviations (base^n mm per axis);
  2. the satellite's header accuracy (2^n mm);
  3. the caller's `statedSigmaM` with its `statedSigmaBasis`.

  With none of these the call fails with `unstated-uncertainty`; there is no
  default. Velocity variance is the position variance passed through the
  derivative weights, plus the squared difference between the degree-9 and
  degree-7 derivatives. That difference covers interpolation error and shows
  an unflagged manoeuvre. The covariance is rotated to GCRF with the
  Earth-rotation term.
- **Provenance:** each block's `COMMENT` names the product, its URL, the
  file's SHA-256, the agency and orbit type, and the uncertainty basis.

## Method `sbas_reference_states` (0.4.0)

GEO truth from the WAAS (SBAS) broadcast: the geostationary navigation message
(type 9) of PRN 131, 133 and 135, as archived from CDDIS RINEX navigation files
(`/opt/data/sdn-archive/hac/cddis-sbas/<yyyy>/<doy>.json`, no fetch).

| Port | Type | Content |
| --- | --- | --- |
| `body` | `$FIL` | the archived file: `{url, sha256, retrieved, terms, records}`, a record `{prn, gpsMs, r, v, ura, health}`: position km and velocity km/s Earth-fixed (WGS 84, aligned with ITRF to about a centimetre), `ura` the broadcast user range accuracy in metres, `gpsMs` the epoch's calendar fields in GPS time as Unix milliseconds |
| `earth_orientation` | `$EOP` | rows bracketing the day, as `reference_states` |
| `config` | `MCFG` | optional node config (`plugin.getConfig`): `slotToleranceDeg`, default 2 |
| `reference` (out) | `$OEM` | one per table PRN present and on its slot: GCRF, UTC |
| `notice` (out) | `FNTC` | KIND Missing, one per reason a table PRN gives no state |

- **Satellites** (the module's data table, by the longitude the records sit at):
  PRN 131 is EUTE 117W B (NORAD 41589, 2016-038B, 116.8 W), PRN 133 SES 15
  (42709, 2017-026A, 129 W), PRN 135 GALAXY 30 (46114, 2020-056C, 125 W). The
  records' own Earth-fixed longitudes on 2026-10-01 are -117.0, -129.1 and
  -125.0 degrees. A PRN whose mean record longitude is more than 2 degrees from its
  slot gives no state (`slot-mismatch`); a table PRN with no records gives none
  (`prn-absent`); fewer than 10 records, none (`too-few-records`). Nothing is
  taken for a PRN outside the table.
- **Time:** the records' times of applicability, GPS time to UTC by the leap-second
  table; one state per record.
- **Frame:** the Earth-fixed position to GCRF by the same IAU 2006/2000A (CIO)
  chain and EOP rows as `reference_states`; `emit_block` is the one conversion
  both methods use (SP3 conversions are byte-identical to before).
- **Velocity:** the derivative of the degree-9 Lagrange interpolant of the
  positions, as for an SP3 file without velocities. The message velocity (a
  0.625 mm/s grid) is not used: against the same derivative of the records' own
  positions it differs by up to 10 mm/s on 2026-10-01 (median 2 to 3 mm/s), more
  than two derivative stencils differ from each other (median 0.5, 95th
  percentile 1.0, maximum 1.5 mm/s).
- **Uncertainty:** each record's URA, in metres, on every position axis. It is a
  protection bound on the user range error, not a realized orbit error, and the
  block's `COMMENT` says so; a bound that broadcasts 2 m is not a measurement
  of 2 m. Velocity variance as for `reference_states`. The message's acceleration
  is not in the archived records.
- **Provenance:** `COMMENT` names the archive file's SHA-256, the upstream URL and
  SHA-256 and the retrieval time.

## Method `compare_to_reference` (0.2.0)

An ephemeris, with its covariance when it carries one, against reference
states at the reference's own epochs: how a covariance product (COMSPOC's
SynCoPate files, read by `files/orbit-products` 0.1.4) is scored for realism.

| Port | Type | Content |
| --- | --- | --- |
| `ephemeris` | `$OEM` | block 0: TEME (`TEMEOFDATE`) or GCRF, UTC; uniform or line states; covariance lines optional, in the block's frame |
| `reference` | `$OEM` | block 0: GCRF or EME2000, UTC, line states |
| `residuals` (out) | `$OEM` | one GCRF/UTC block: per reference epoch inside the ephemeris span, the position error (reference minus ephemeris, km) as X/Y/Z, and with covariance the ephemeris's GCRF position covariance (km²) as a covariance line; `d2` and the sigmas follow from the two |
| `report` (out) | `$CVR` | `MEAN_D2_OVER_3`, `COVERAGE_95` (d² ≤ 7.8147, the 0.95 point of χ² with 3 degrees of freedom) over `SAMPLES` epochs with covariance (NaN / 0 without); `TEST_WINDOW` the compared span; `MEASURED_LINEAGE` the frames; `EVIDENCE` the degree and the compared / outside-span counts |

- **Interpolation:** the block's `INTERPOLATION_DEGREE` (5 when absent) Lagrange
  interpolant through the nearest degree + 1 states; the same interpolant through
  the nearest covariance rows for each position-block element.
- **Frames:** TEME → GCRF by the `foundation/frames` IAU 2006/2000A chain with the
  equation of the equinoxes (UT1 does not enter); the covariance as M P Mᵀ. EME2000
  → GCRF by the IAU 2006 frame bias.
- **Check:** the TEME state of Vallado, Crawford, Hujsak and Kelso (2006,
  AIAA 2006-6753) at 2004-04-06 07:51:28.386009 UTC maps to their GCRF state within
  0.11 m. Browser and WasmEdge agree byte for byte
  (`tests/parity.mjs`; the Docker leg is waived by the owner, 2026-10-22).

## Products

`scripts/fetch-reference-products.mjs --from YYYY-MM-DD --to YYYY-MM-DD
[--products gps,slr,slr-daily,sentinel1,swarm,doris,gfz-rso,cosmic2,sbas]
[--local-archive DIR] [--out DIR]` downloads and converts these products.
`doris`, `gfz-rso`, `cosmic2` and `sbas` (WAAS MT9, with `--eop finals` for recent days) read copies already downloaded under
`--local-archive` (default `/opt/data/sdn-archive/hac`). Each copy is checked
against the SHA-256 in its `.provenance.json`, whose URL is recorded as the
source, and every arc that meets the days `--from` to `--to` is converted.
Output goes outside the repository, by default `~/.cache/sdn-reference-states`.

`--dry-run` prints, as JSON, the plan of the run and exits: every file it would
request (name, URL, whether `--out` already holds it) or read from the local
archive, for the given days and products, including `kp` (GFZ Kp, fetched by the
space-weather collector and only named here). It opens no connection and writes
nothing. `--offline` runs the conversion with the network shut: files already
under `--out/products` (or the local archive) are converted, any other is skipped.
The script needs only this module's install (`npm ci`: the SDK and the standards
its `package.json` declares); `scripts/product-sources.mjs` holds the URLs and file
names, and `tests/fetch-offline.e2e.mjs` checks the install, a fixed range's plan
and one spent day (ESA0OPSFIN 2024-09-24, 77 objects) converted offline, byte for
byte against `/opt/data/sdn-archive/reference-states`.

| Product | Objects | Spacing | Uncertainty |
| --- | --- | --- | --- |
| IGS final orbits (`IGS0OPSFIN`; ESA's `ESA0OPSFIN`, 5 min, for days BKG no longer holds) | GPS, identified from the IGS satellite metadata SINEX (PRN → SVN → COSPAR, catalog number) at the file's midpoint | 15 min | SP3 record standard deviations |
| ILRS combined weekly arcs (`ilrsa`) | LAGEOS-1/2, ETALON-1/2 | 2 / 15 min | per-axis RMS of the analysis centres' orbits about the combination over the arc (precision; a lower bound, because the centres share data) |
| ILRS analysis-centre 4-day fitted arcs (NSGF), one every 4 days, non-overlapping | Ajisai, Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2 | 2–3 min | per-axis RMS of the arc's 3-day overlap with the next day's arc |
| Sentinel-1 `AUX_POEORB`, transcribed to SP3-c | Sentinel-1C/1D (1A when published) | 10 s | the mission's 5 cm 3D RMS precise-orbit requirement, as 2.9 cm per axis |
| Swarm reduced-dynamic precise orbits (ESA Swarm dissemination server) | Swarm A, B, C | 10 s | per-axis RMS of the kinematic minus the reduced-dynamic orbit over the day (kinematic outliers beyond 1 m excluded) |
| IDS DORIS precise orbits from CNES SSALTO (`ssa`), 7- to 9-day arcs, each overlapping the next by 2.5–3 h; local copies | CryoSat-2, SARAL, Sentinel-3A/3B, SWOT | 60 s | per-axis RMS of the arc's overlap with the adjacent arc it overlaps longest |
| GFZ rapid science orbits (ISDC `RSO`, codes L64/L65), 14-hour arcs every 12 hours; local copies | GRACE-FO 1 and 2 | 30 s | per-axis RMS of the arc's 2-hour overlap with the adjacent arc |
| UCAR CDAAC COSMIC-2 near-real-time orbits (`leoOrb`), overlapping arcs of about 2 hours in daily tarballs; local copies | COSMIC-2 FM1–FM6, as present | 60 s | per-axis RMS of the arc's overlap (at least 1 h) with the adjacent arc it overlaps longest |

The last three files state no accuracy, and no published figure for them is in
the local archive. Their overlap RMS is the precision of consecutive fits,
not an accuracy.

Earth orientation comes from IERS EOP 20 C04, parsed by
`data-source/eop-parser`. Three changes are made to products, and only these:
- ILRS comment lines (`%/*`) are read as SP3 `/*`;
- the NSGF arcs' coordinate system "ECF" is read as ITRF, as their own
  comment states;
- the GFZ rapid science orbits' coordinate system "CTS", the conventional
  terrestrial system, is read as ITRF.

C04 runs about 30 days behind. `--eop finals` uses the observed rows of IERS
finals2000A instead (`parse_finals2000a`), so reference states can be made for
recent days; delete the cached `finals2000A.all` under `--out` to refresh it.

Each product gets `DIR/reference/<product>/<norad>.oem` (a size-prefixed
`$OEM`) and an `index.json` recording the URL, SHA-256, stated sigma and basis.
Products are public. Catalog element sets are not used here.

## Build and test

```sh
npm ci
node build.mjs
node --test tests/*.test.mjs
```

The end-to-end test writes an SP3 around Vallado Example 3-15 (ITRF→GCRF,
2004-04-06 07:51:28.386009 UTC). It reads the file through
`files/orbit-products` and checks the GCRF state against two references:
Vallado's printed result (2 cm, 1e-8 km/s) and SOFA/ERFA (1 mm, 2e-9 km/s).
It also checks each source of uncertainty and that a product with no stated
accuracy is refused.
