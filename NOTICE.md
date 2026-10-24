# Notices for data and derived material

Test fixtures, reference vectors and derived code in this repository come from
the sources below. Licence texts are in [LICENSES/](LICENSES/). Data this
repository may not redistribute is not in the tree; the tests that use it read
it from `$SDN_MODULES_PRIVATE_FIXTURES` (`tests/lib/privateFixtures.mjs`) and
skip without it. Synthetic fixtures say so in their `PROVENANCE.md` and are
written by scripts in the same directory.

## Software and reference outputs

| Source | Licence | Where | Copy of the licence |
| --- | --- | --- | --- |
| Orekit 13.1 (CS GROUP) | Apache-2.0 | `propagator/ffm/tests/fixtures/orekit/` (reference outputs, `OrekitReference.java`, `OrekitGnssSrpReference.java`), `files/orbit-products/fixtures/stk_02674_*.e` and the Orekit cross-check dumps, Orekit values in `analysis/*/vectors` and fixtures | [LICENSES/Apache-2.0-Orekit.txt](LICENSES/Apache-2.0-Orekit.txt), [NOTICE-Orekit.txt](LICENSES/NOTICE-Orekit.txt) |
| Hipparchus | Apache-2.0 | `analysis/estimation/tests/fixtures/hipparchus-*` | in that directory (`hipparchus-LICENSE.txt`, `hipparchus-NOTICE.txt`) |
| NASA GMAT (R2026a) | Apache-2.0, Copyright United States Government as represented by the Administrator of NASA | `propagator/ffm/tests/fixtures/gmat/`, `propagator/ffm/tests/fixtures/atmosphere/jacchia-roberts-gmat.json` (GMAT outputs), parameter names in `analysis/parameters/fixtures/reference-parameter-roster.json`; the Code-500 and STK record layouts in `files/orbit-products` were read from GMAT's sources | [LICENSES/Apache-2.0-Orekit.txt](LICENSES/Apache-2.0-Orekit.txt) (the Apache-2.0 text) |
| Tudat and tudatpy, Delft University of Technology | BSD-3-Clause | `propagator/ffm/tests/fixtures/tudat/`, `analysis/maneuver/vectors/tudat-extract.json` | [LICENSES/BSD-3-Clause-Tudat.txt](LICENSES/BSD-3-Clause-Tudat.txt) |
| hapsira (poliastro) | MIT | `analysis/maneuver/vectors/hapsira-extract.json` | [LICENSES/MIT-hapsira.txt](LICENSES/MIT-hapsira.txt) |
| Nyx Space | AGPL-3.0 for the code; its outputs are not covered | `propagator/ffm/tests/fixtures/nyx/nyx-reference.json` (outputs) | none needed |
| US Space Force SGP4 and SGP4-XP (Sgp4Prop WebAssembly 9.1.1.0, Astro Standards v9.1, XP build). Copyright 2015 United States Government as represented by the Administrator of US Space Force. All Rights Reserved. | US Space Force Open Source Agreement for SGP4: use for any purpose; redistribution in binary form with the copyright notice, the Agreement and its disclaimer; no endorsement by the US Space Force or its contributors; export of goods or technical data from the United States may require a license from the U.S. Government | `propagator/sgp4-xp/third_party/ussf-sgp4/` (the library, unmodified, and the JavaScript runtime the tests compare it with), joined into `propagator/sgp4-xp/dist/isomorphic/module.wasm` and into the OD node of `flows/supplemental-omm` (`nodes/od`) (the custom section `ussf-sgp4-notice` of each holds the notice and the Agreement) | [propagator/sgp4-xp/third_party/ussf-sgp4/AGREEMENT.txt](propagator/sgp4-xp/third_party/ussf-sgp4/AGREEMENT.txt), [NOTICE.md](propagator/sgp4-xp/third_party/ussf-sgp4/NOTICE.md) |
| HWM14, the Horizontal Wind Model 2014 (release HWM14.123114), by Douglas Drob and John Emmert, Naval Research Laboratory (the authors the NRL code header names) | a work of the US Government (17 U.S.C. § 105), not subject to copyright in the US (owner ruling 2026-10-24); the journal's CC BY-NC-ND covers the article, not the NRL code | `third_party/hwm14/` (`nrl/` is NRL's own release, from the Internet Archive capture of map.nrl.navy.mil; the C++ port and its data beside it) | citation: Drob et al. (2015), Earth and Space Science 2, 301-319; Emmert et al. (2008), J. Geophys. Res. 113 |
| ERFA | BSD-3-Clause | `higherpop/third_party/erfa/` (also compiled into `propagator/sdn-ap/dist/isomorphic/module.wasm`) | in that directory; `propagator/sdn-ap/LICENSES/ERFA.txt` |
| pugixml 1.15 (Arseny Kapoulkine) | MIT | `files/ccsds-messages/third_party/pugixml/` (compiled into the module) | in that directory (`LICENSE.md`, `PROVENANCE.md`) |
| SDN-AP spec vectors: element sets made for the specification and what the unmodified US Space Force Sgp4Prop library (9.9 native, 9.1.1.0 WebAssembly) returns for them, run as a black box | US Space Force Open Source Agreement for SGP4 (above); the library is not in `propagator/sdn-ap/` | `propagator/sdn-ap/spec-vectors/vectors.json`, the probe values of `propagator/sdn-ap/SPEC.md` | [propagator/sgp4-xp/third_party/ussf-sgp4/AGREEMENT.txt](propagator/sgp4-xp/third_party/ussf-sgp4/AGREEMENT.txt) |
| Jacchia (1970), SAO Special Report 313, Table 6 | published report, transcribed with citation | `propagator/sdn-ap/src/j70_table6.inc` | citation: L. G. Jacchia, SAO Special Report 313 (1970) |
| Vallado et al., Revisiting Spacetrack Report #3 (AIAA 2006-6753) | free use with citation | `SGP4-VER.TLE` and verification vectors | citation: Vallado, Crawford, Hujsak, Kelso (2006) |

## Data

| Source | Terms | Where | Credit |
| --- | --- | --- | --- |
| SpaceX Starlink public ephemerides | Open (owner determination 2026-10-10) | `analysis/od/tests/data/supgp-reference/starlink*/meme/` (the real files are in `starlink/`), `analysis/od/tests/data/meme`, `analysis/od/src/cpp/tests/data/test_meme.txt`, `data-source/spacex-starlink-source/test/fixtures/` | SpaceX, https://api.starlink.com/public-files/ephemerides/ |
| NASA ISS trajectory (`ISS.OEM_J2K_EPH`) | U.S. Government work, public domain | `analysis/od/tests/data/supgp-reference/iss/`, `data-source/iss-source/test/fixtures/`, `files/ccsds-messages/fixtures/real/nasa-iss.oem` | NASA JSC Flight Operations Directorate (TOPO), https://www.nasa.gov/spot-the-station/ |
| IGS final orbit `igs15000` and CODE multi-GNSS final `COD0MGXFIN_20250190000_01D_05M_ORB` (SP3 excerpts, three epochs) | IGS Data and Product Disclaimer: free use with citation of the IGS and the analysis centre | `files/orbit-products/fixtures/`, read by `data-source/sp3-precise-source` tests | International GNSS Service; Center for Orbit Determination in Europe (AIUB) |
| ILRS normal points, LAGEOS-1 2026-10-08 (CRD v2 excerpt, first two passes) | ILRS data are not copyrighted; citation requested | `data-source/ilrs-crd-source/tests/fixtures/` (`PROVENANCE.md` there) | International Laser Ranging Service; EUROLAS Data Center (DGFI-TUM) |
| Space-Track element sets (and states computed from them) | Space-Track User Agreement; USSPACECOM's blanket approval to redistribute basic SSA data with citation | `analysis/launch-trajectory/tests/fixtures/{crs14,crs16,paz}.json` ("catalog" blocks), `iss-teme-crew13.json` | Source: USSPACECOM / 18th Space Defense Squadron, via Space-Track.org (https://www.space-track.org) |
| IERS Earth orientation (EOP 20 C04, finals2000A) | IERS; finals2000A is U.S. Government, approved for public release | EOP excerpts in `data-source/eop-parser`, `propagator/ffm/tests/fixtures/orekit/eop-*.json`, `data/space-data-loaders/fixtures` | IERS Earth Orientation Center, Observatoire de Paris; IERS Rapid Service/Prediction Center, U.S. Naval Observatory |
| NAIF SPK kernels | NAIF rules: unmodified kernels may be redistributed, a modified kernel names its modifier | `files/orbit-products/fixtures/*.bsp`, `de440-2026.bsp` (an excerpt made by DigitalArsenal with spksub_c) | JPL planetary ephemeris DE440 (Park et al. 2021), NASA/JPL NAIF |
| GRAIL GRGM660PRIM lunar gravity (NASA GSFC, PDS Geosciences Node) and the NAIF kernels `moon_pa_de440_200625.bpc` and `de440s.bsp` | NASA PDS public data, no restrictions; NAIF rules | not in the tree: `propagator/sdn-ap` reads them at build time (`SDNAP_HAC_ROOT`, pinned by SHA-256; `tools/fetch-build-data.mjs` fetches and verifies them) and compiles refitted tables into its `dist/isomorphic/module.wasm` | Lemoine et al. (2013), GRGM660PRIM; JPL DE440 (Park et al. 2021), NASA/JPL NAIF |
| NOAA GOES-19 ABI, GFS/GEFS | open, no restrictions (NOAA NODD) | `data-source/imager-observation-parser`, `nwp-*` fixtures | GOES-19 ABI and GFS/GEFS data courtesy of NOAA via NOAA Open Data Dissemination |
| OpenStreetMap | ODbL 1.0 | `data-source/cell-tower-source/tests/fixtures/overpass-berlin.sample.json` | (c) OpenStreetMap contributors |
| FCC ULS, ACMA RRL, ANFR, BAKOM | public domain; ACMA RRL licence; Licence Ouverte 2.0; opendata.swiss open use | `data-source/cell-tower-source/tests/fixtures/` | see `PROVENANCE.md` there |
| GeoNames | CC BY 4.0 | `data-source/geonames-source/tests/fixtures/` | GeoNames, www.geonames.org |
| M-Lab NDT | CC0 | `data-source/mlab-starlink-connectivity/tests/fixtures/` | The M-Lab NDT Data Set |
| shahar603 Telemetry-Data | The Unlicense | `analysis/launch-trajectory/tests/fixtures/` ("telemetry") | shahar603/Telemetry-Data |
| TraCSS IVV dataset | CC0 1.0 | `analysis/conjunction-assessment/tests/fixtures/aerospace-real-window/`, `files/ccsds-messages/fixtures/real/tracss-*.ocm` | The Aerospace Corporation / NOAA Office of Space Commerce |
| NIST/SEMATECH e-Handbook | U.S. Government, public information | `analysis/association/tests/fixtures/nist-chi-square.json` | NIST/SEMATECH e-Handbook of Statistical Methods, 1.3.6.7.4 |
| SatNOGS DB | CC BY-SA 4.0 | `data-source/satnogs-source/tests/fixtures/` | SatNOGS (Libre Space Foundation) |
| The Space Devs Launch Library 2 | free use, with attribution | `data-source/launch-schedule/tests/fixtures/` | Launch Library 2, The Space Devs |

## Open questions

- The Orekit-derived CCSDS CDM example embedded in
  `analysis/conjunction-assessment/tests/wasmedgeStandaloneHarness.test.mjs`
  (CDMExample1, from Orekit's test resources, Apache-2.0).
