# SP3 Precise Orbit Source

An SDK module that reads precise orbit products in SP3-c and SP3-d (the IGS, its analysis centres, BKG, ESA/ESOC) into one canonical
SDS `$OEM` per satellite. It serves three sources of the catalog paper's inventory, one format: the IGS and BKG GPS orbits
(`gps-precise`), ESA's GLONASS orbits (`glonass-precise`) and ESA's precise orbits of its Earth-observation satellites
(`esa-pod`: CryoSat-2, Swarm). It is their entry of the per-source products (`flows/source-products`, catalog pipeline C2): the
flow takes the `$OEM` on `ephemeris` and the SGP4 element set `analysis/od` fits to it on `fit_omm`, and gives the source's `$OMM`,
`$OCM` (covariance and its label) and `$MNV`.

The same artifact runs in the browser and WasmEdge, byte for byte. Retrieval belongs to the SDN host flow: the download from BKG, the
IGS data centres or ESA's Navigation Support Office, the gunzip the data centres' `.sp3.gz` need, the schedule and the archive.

## Method

`read_sp3` (typed contracts 1.0, FlatBuffers only): input `source`, the `HttpResponse` (HRSP) hostcap/http-request answers with BODY
one decompressed file (up to 128 MiB); outputs `oem` (one `$OEM` frame per satellite with a position, up to 1,024) and `report`, one
`FlowNotice` (FNTC, KIND Info) whose ITEMS are the header facts and per-satellite counts as `name=value`. A 304 gives one `FlowNotice`
(Unchanged) and no `$OEM`; another status or a transport error is refused.

The reader is `files/orbit-products/src/sp3.hpp`, the one SP3 reader of this repository (it is also what that module's
`read_container` runs, against the IGS specification and Orekit's parser); `data-source/glonass-source` keeps its own, for IAC's files,
inside its provider scaffold. This module adds the shape of the product:

- **One `$OEM` per satellite**, named for the file's vehicle id (`G01`, `R05`, `E11`, `C07`, `J02`, `L51`). A PRN slot is
  reassigned over time, so the id names a satellite only within the file; no NORAD number is made of it.
- **The frame as the header states it.** SP3 positions are Earth-fixed: `REFERENCE_FRAME.NAME` is the header's coordinate system
  (`IGS05`, `IGS20`, `IGb14`, `ITRF`…) and the frame is Earth-fixed (`ECEF`); a header that names an inertial frame (`GCRF`, `ICRF`,
  `J2000`, `EME2000`) gives that frame. **The time system is the `%c` line's** (GPS, GLONASS, Galileo, BeiDou, QZSS, NavIC, TAI, UTC);
  one that has no standard is refused rather than read on a guessed scale. Nothing is converted: no frame rotation and no leap second
  is applied here (`foundation/frames` and `foundation/time` own those). `ORIGINATOR` is the header's agency.
- **States as the file has them.** A position-only file (`P`, no velocity records) stays position-only: `STATE_VECTOR_SIZE` 3, the
  shape `analysis/od` reads as "fit the initial velocity from the positions"; no velocity is made of positions. A file with velocity
  records (`V`; decimetres per second in the file) gives full states (6) in kilometres per second. A run of evenly spaced epochs is one
  block (`START_TIME`, `STEP_SIZE`, `EPHEMERIS_DATA`); an epoch the file marks absent (a `0.000000` position) starts the next block.
- **Not carried:** the clock columns and the accuracy exponents (an orbit product's `$OEM` is the orbit). The report states, per
  satellite, its states, blocks, velocity, accuracy exponent (the `++` line: 2^n mm), whether clocks were present, the predicted
  and maneuver flags, with the header's facts and the SHA-256 of the file.

The OD fit of these orbits is `analysis/od` `fit`, taking the OEM on `oem`. `analysis/od` gives an OEM that names no NORAD number the
placeholder NORAD 99999 and designator `99999A` on its `$OMM`; the satellite is the one the OEM names, and the integrator joins an id
to a catalog object only through a link. The IGS orbit of GPS week 1500, three epochs of G01 (30 minutes), fits in the flow test to a GPS mean
motion (within 0.05 rev/day of the 2.0057 a semimajor axis of 26,560 km gives).

A file that is not SP3, is cut short, names a time system with no standard, or has no satellite with a position, is refused whole
with no partial output. Errors are flags, never exceptions.

## Build and test

```sh
npm ci
npm run build          # dist/isomorphic/module.wasm and dist/guest-link (single thread, SDK 0.8.27, SDS 1.245.0)
npm test               # the module through the SDK's browser harness
npm run test:parity    # headless Chrome, native WasmEdge, Docker WasmEdge: byte-identical
```

The tests read two real IGS products already in the tree (`files/orbit-products/fixtures`): the IGS final combined orbit of GPS week 1500
(SP3-c, 32 satellites, IGS05) and the CODE multi-GNSS final of 2025-01-19 (SP3-d, 122 satellites, IGS20); expected positions are the
numbers printed in those files. Synthetic SP3-d files (`tests/fixtures/sp3-format.mjs`) stand for what is not ours to reproduce: velocity
records, an absent position, other time systems and frames, damaged files.
`flows/source-products/tests/source-chain.test.mjs` runs the IGS file through the module, `analysis/od` and the compiled flow.

## Licence and data

| Source | Terms | In this module |
| --- | --- | --- |
| IGS products (IGS0OPSFIN, IGS0OPSULT, analysis-centre products offered through the IGS), audit id `igs` | IGS Data and Product Disclaimer and Terms of Use (2020): open use without restriction, citation requested; reproduce: yes | Two real files, three epochs each, with their provenance in `files/orbit-products/fixtures/PROVENANCE.md` |
| ESA/ESOC Navigation Support Office GNSS orbits, audit id `esa-navigation-office` | Navigation Support Office terms; ESA grants no redistribution right of its own; reproduce: no | **None.** Synthetic files stand for them |
| ESA/ESOC precise orbits of ESA Earth-observation satellites (CryoSat-2, Swarm), audit id `esa-navigation-office-pod` | No open licence; the IGS terms do not apply; reproduce: no | **None.** Synthetic files stand for them |

`NOTICE.md` records the terms and credit lines. Obtain the data from BKG (https://igs.bkg.bund.de), the IGS data centres, and ESA's
Navigation Support Office (https://navigation-office.esa.int/products/).
