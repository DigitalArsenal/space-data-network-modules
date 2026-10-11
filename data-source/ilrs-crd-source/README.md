# ILRS CRD Source

An SDK module that reads ILRS normal points in the Consolidated Laser Ranging Data format (CRD, version 2) into one canonical SDS
`$TDM` per pass: laser ranges for `analysis/estimation`. It is the observation source of the catalog paper's inventory and its entry
of the per-source products (`flows/source-products`, catalog pipeline C2). The host runs `analysis/estimation` `run_estimation` on the
`$TDM` (`tracking_data`), the station's coordinates (`laser_tracking`) and the propagator's answers; the estimate's `$OCM` enters the
flow on `fit` and the SGP4 set fitted to the estimated arc on `fit_omm`, and the flow gives the source's `$OMM`, `$OCM` (the fit's
formal covariance times the factor measured for laser-range fits, labelled) and `$MNV`.

The same artifact runs in the browser and WasmEdge, byte for byte. Retrieval belongs to the SDN host flow: the download of the daily
files from EDC or CDDIS, the schedule, the archive, and the station coordinates a CRD file does not hold.

## Method

`read_crd`, input `source` (one CRD version 2 file as text, up to 64 MiB), outputs `observations` (one `$TDM` per pass, up to 4,096)
and `report`.

The authority is the ILRS Consolidated Laser Ranging Data Format, version 2.01 (https://ilrs.gsfc.nasa.gov/docs/2022/crd_v2.01e3.pdf).
Record types are read in either case (stations write `h1` and `H1`). A file is a stream of passes, each `H2` station, `H3` target and
`H4` session with its `C0` configuration, `11` normal point and `20` meteorology records, closed by `H8`; one `H9` ends the file.

- **A normal point is a laser range.** Record `11` gives the two-way time of flight in seconds with the station's system delay applied
  and no refraction or centre-of-mass correction. The observation is the one-way range c x time of flight / 2 in metres
  (c = 299,792,458 m/s, exact), keyword `LASER_RANGE`, the keyword and unit `analysis/estimation` reads. The refraction and
  centre-of-mass flags the session states are in the `$TDM` comment; the estimator's error model owns those corrections.
- **Epochs are UTC, to the digit the station wrote.** The seconds of day become an ISO epoch on the pass's start date (a time before
  the pass's start, beyond a minute of slack, is the next day's), with nine fraction digits kept. `TIMETAG_REF` follows the CRD epoch
  event: ground transmit (2) is `TRANSMIT`, ground receive (0) is `RECEIVE`. Spacecraft bounce time (1) and the one-way events have no
  `$TDM` time-tag reference, so a pass with them is not read.
- **Which passes are read.** Normal point sessions (H4 data type 1) of two-way ranging on a UTC station clock (CRD time scale 3, 4 or
  7) with the system delay applied, and good or suspect quality (a suspect pass says so in `DATA_QUALITY`). Full-rate and engineering
  sessions, one-way ranging, local clocks, a delay not applied, poor quality and mixed epoch events are not read; the report counts
  each by reason.
- **One segment per system configuration.** A pass with two wavelengths (`C0`) has two segments; `TRANSMIT_FREQ_1` is c / wavelength.
  `OBSERVER_ID` is the station occupancy designator (the SOD): the CDP pad (4 digits), system (2) and occupancy (2). The meteorological
  records (`20`) ride on the first segment as `PRESSURE` (hPa), `TEMPERATURE` (K) and `RHUMIDITY` (%), the CCSDS 503.0-B-2 keywords.
- **What the `$TDM` does not hold.** The raw range count, bin RMS and window of each normal point are in the report (a host takes the
  range's sigma from them), and the station's coordinates are not in a CRD file at all: the host supplies the pad's SLRF/ITRF
  coordinates (`$CRD`, `laser_tracking`).
- **Refused whole, with no partial output:** a file that is not CRD, is not version 2, has no `H9` (it is truncated), has records after
  `H9`, holds a NUL, has a normal point without a time of flight, or has no pass that can be read as laser ranges.

Errors are flags (an invoke error code and message), never exceptions.

## In `flows/source-products`

`sources.json` registers the source as `ilrs-crd` (kind `observation`, licence class `reproducible`, audit id `ilrs`, provider the
plugin id of this module). The `$TDM` goes to the lane's estimator, `analysis/estimation` `run_estimation`, on `tracking_data`. The
fit's covariance is rule 2 of `analysis/gp-error-model`: the formal covariance times the realism factor measured on held-out ILRS ranges,
17.04 (orbit-accuracy-experiments E6, test window 2026-07-16 to 2026-08-29, Starlette, Stella, LARETS, WESTPAC and LARES, 206 fits at
cutoff 0 d: mean d²/3 17.04, 95 % coverage 0.17; 16.0 to 21.2 over cutoffs 0 to 7 d). The rows are `UNCALIBRATED`: the scaled covariance
has not itself been tested.

`analysis/estimation` turns a `$TDM` epoch into seconds from its request epoch in one double (about 0.24 microseconds at present-day
Unix time) and its sequential filter takes a precomputed propagator sample only within 1e-8 s of that epoch. A host that precomputes
samples builds their epochs the same way, or runs the propagation round trip at the epochs the estimator asks for;
`flows/source-products/tests/source-chain.test.mjs` shows the first.

## Build and test

```sh
npm ci
npm run build          # dist/isomorphic/module.wasm and dist/guest-link (single thread, SDK 0.8.27, SDS 1.245.0)
npm test               # the module through the SDK's browser harness
npm run test:parity    # headless Chrome, native WasmEdge, Docker WasmEdge: byte-identical
```

The tests read a real file, the first two passes of the ILRS daily LAGEOS-1 normal points of 2026-10-08 from EDC (`tests/fixtures`,
provenance in `PROVENANCE.md`); expected values are the numbers printed in it and arithmetic worked by hand. Synthetic passes
(`tests/fixtures/crd-format.mjs`) stand for what a real day does not hold: a pass across midnight, the receive epoch event, two
wavelengths, the sessions that are not read, damaged files.
`flows/source-products/tests/source-chain.test.mjs` runs the real pass through the module and `analysis/estimation`, which reads it as
nine laser ranges; `flows/source-products/tests/sources.test.mjs` runs the flow with the source's recipe.

## Licence and data

| Source | Terms | In this module |
| --- | --- | --- |
| ILRS normal points (CRD v2) via EDC (DGFI-TUM) and CDDIS, audit id `ilrs` | The ILRS states its data and products are not copyrighted and asks to be cited (https://ilrs.gsfc.nasa.gov/about/cite.html); EDC adds no data terms; reproduce: yes | One real file excerpt of 15 normal points, with its provenance in `tests/fixtures/PROVENANCE.md` |

`NOTICE.md` records the terms and credit lines. Obtain the data from the EUROLAS Data Center
(https://edc.dgfi.tum.de/pub/slr/data/npt_crd_v2/) or the NASA CDDIS.
