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
| `identities` | JSON | `{product, source, statedSigmaM?, statedSigmaBasis?, satellites: {"G01": {norad, objectId, name}}}` |
| `reference` (out) | `$OEM` | one per identified satellite |

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

## Products

`scripts/fetch-reference-products.mjs --from YYYY-MM-DD --to YYYY-MM-DD
[--products gps,slr,slr-daily,sentinel1,swarm] [--out DIR]` downloads and converts these
products. Output goes outside the repository, by default
`~/.cache/sdn-reference-states`.

| Product | Objects | Spacing | Uncertainty |
| --- | --- | --- | --- |
| IGS final orbits (`IGS0OPSFIN`; ESA's `ESA0OPSFIN`, 5 min, for days BKG no longer holds) | GPS, identified from the IGS satellite metadata SINEX (PRN → SVN → COSPAR, catalog number) at the file's midpoint | 15 min | SP3 record standard deviations |
| ILRS combined weekly arcs (`ilrsa`) | LAGEOS-1/2, ETALON-1/2 | 2 / 15 min | per-axis RMS of the analysis centres' orbits about the combination over the arc (precision; a lower bound, because the centres share data) |
| ILRS analysis-centre 4-day fitted arcs (NSGF), one every 4 days, non-overlapping | Ajisai, Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2 | 2–3 min | per-axis RMS of the arc's 3-day overlap with the next day's arc |
| Sentinel-1 `AUX_POEORB`, transcribed to SP3-c | Sentinel-1C/1D (1A when published) | 10 s | the mission's 5 cm 3D RMS precise-orbit requirement, as 2.9 cm per axis |
| Swarm reduced-dynamic precise orbits (ESA Swarm dissemination server) | Swarm A, B, C | 10 s | per-axis RMS of the kinematic minus the reduced-dynamic orbit over the day (kinematic outliers beyond 1 m excluded) |

Earth orientation comes from IERS EOP 20 C04, parsed by
`data-source/eop-parser`. Two changes are made to products, and only these:
- ILRS comment lines (`%/*`) are read as SP3 `/*`;
- the NSGF arcs' coordinate system "ECF" is read as ITRF, as their own
  comment states.

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
