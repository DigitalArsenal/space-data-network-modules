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
| Orekit 13.1 (CS GROUP) | Apache-2.0 | `propagator/hpop/tests/fixtures/orekit/` (reference outputs, `OrekitReference.java`, `OrekitGnssSrpReference.java`), `files/orbit-products/fixtures/stk_02674_*.e` and the Orekit cross-check dumps, Orekit values in `analysis/*/vectors` and fixtures | [LICENSES/Apache-2.0-Orekit.txt](LICENSES/Apache-2.0-Orekit.txt), [NOTICE-Orekit.txt](LICENSES/NOTICE-Orekit.txt) |
| Hipparchus | Apache-2.0 | `analysis/estimation/tests/fixtures/hipparchus-*` | in that directory (`hipparchus-LICENSE.txt`, `hipparchus-NOTICE.txt`) |
| NASA GMAT (R2026a) | Apache-2.0, Copyright United States Government as represented by the Administrator of NASA | `propagator/hpop/tests/fixtures/gmat/`, `propagator/hpop/tests/fixtures/atmosphere/jacchia-roberts-gmat.json` (GMAT outputs), parameter names in `analysis/parameters/fixtures/reference-parameter-roster.json`; the Code-500 and STK record layouts in `files/orbit-products` were read from GMAT's sources | [LICENSES/Apache-2.0-Orekit.txt](LICENSES/Apache-2.0-Orekit.txt) (the Apache-2.0 text) |
| Tudat and tudatpy, Delft University of Technology | BSD-3-Clause | `propagator/hpop/tests/fixtures/tudat/`, `analysis/maneuver/vectors/tudat-extract.json` | [LICENSES/BSD-3-Clause-Tudat.txt](LICENSES/BSD-3-Clause-Tudat.txt) |
| hapsira (poliastro) | MIT | `analysis/maneuver/vectors/hapsira-extract.json` | [LICENSES/MIT-hapsira.txt](LICENSES/MIT-hapsira.txt) |
| Nyx Space | AGPL-3.0 for the code; its outputs are not covered | `propagator/hpop/tests/fixtures/nyx/nyx-reference.json` (outputs) | none needed |
| ERFA | BSD-3-Clause | `higherpop/third_party/erfa/` | in that directory |
| Vallado et al., Revisiting Spacetrack Report #3 (AIAA 2006-6753) | free use with citation | `SGP4-VER.TLE` and verification vectors | citation: Vallado, Crawford, Hujsak, Kelso (2006) |

## Data

| Source | Terms | Where | Credit |
| --- | --- | --- | --- |
| SpaceX Starlink public ephemerides | Open (owner determination 2026-10-10) | `analysis/od/tests/data/supgp-reference/starlink*/meme/` (the real files are in `starlink/`), `analysis/od/tests/data/meme`, `analysis/od/src/cpp/tests/data/test_meme.txt`, `data-source/spacex-starlink-source/test/fixtures/` | SpaceX, https://api.starlink.com/public-files/ephemerides/ |
| NASA ISS trajectory (`ISS.OEM_J2K_EPH`) | U.S. Government work, public domain | `analysis/od/tests/data/supgp-reference/iss/`, `data-source/iss-source/test/fixtures/` | NASA JSC Flight Operations Directorate (TOPO), https://www.nasa.gov/spot-the-station/ |
| Space-Track element sets (and states computed from them) | Space-Track User Agreement; USSPACECOM's blanket approval to redistribute basic SSA data with citation | `analysis/launch-trajectory/tests/fixtures/{crs14,crs16,paz}.json` ("catalog" blocks), `iss-teme-crew13.json` | Source: USSPACECOM / 18th Space Defense Squadron, via Space-Track.org (https://www.space-track.org) |
| IERS Earth orientation (EOP 20 C04, finals2000A) | IERS; finals2000A is U.S. Government, approved for public release | EOP excerpts in `data-source/eop-parser`, `propagator/hpop/tests/fixtures/orekit/eop-*.json`, `data/space-data-loaders/fixtures` | IERS Earth Orientation Centre, Observatoire de Paris; IERS Rapid Service/Prediction Centre, U.S. Naval Observatory |
| NAIF SPK kernels | NAIF rules: unmodified kernels may be redistributed, a modified kernel names its modifier | `files/orbit-products/fixtures/*.bsp`, `de440-2026.bsp` (an excerpt made by DigitalArsenal with spksub_c) | JPL planetary ephemeris DE440 (Park et al. 2021), NASA/JPL NAIF |
| NOAA GOES-19 ABI, GFS/GEFS | open, no restrictions (NOAA NODD) | `data-source/imager-observation-parser`, `nwp-*` fixtures | GOES-19 ABI and GFS/GEFS data courtesy of NOAA via NOAA Open Data Dissemination |
| OpenStreetMap | ODbL 1.0 | `data-source/cell-tower-source/tests/fixtures/overpass-berlin.sample.json` | (c) OpenStreetMap contributors |
| FCC ULS, ACMA RRL, ANFR, BAKOM | public domain; ACMA RRL licence; Licence Ouverte 2.0; opendata.swiss open use | `data-source/cell-tower-source/tests/fixtures/` | see `PROVENANCE.md` there |
| GeoNames | CC BY 4.0 | `data-source/geonames-source/tests/fixtures/` | GeoNames, www.geonames.org |
| M-Lab NDT | CC0 | `data-source/mlab-starlink-connectivity/tests/fixtures/` | The M-Lab NDT Data Set |
| shahar603 Telemetry-Data | The Unlicense | `analysis/launch-trajectory/tests/fixtures/` ("telemetry") | shahar603/Telemetry-Data |
| TraCSS IVV dataset | CC0 1.0 | `analysis/conjunction-assessment/tests/fixtures/aerospace-real-window/` | The Aerospace Corporation / NOAA Office of Space Commerce |
| NIST/SEMATECH e-Handbook | U.S. Government, public information | `analysis/association/tests/fixtures/nist-chi-square.json` | NIST/SEMATECH e-Handbook of Statistical Methods, 1.3.6.7.4 |
| SatNOGS DB | CC BY-SA 4.0 | `data-source/satnogs-source/tests/fixtures/` | SatNOGS (Libre Space Foundation) |
| The Space Devs Launch Library 2 | free use, with attribution | `data-source/launch-schedule/tests/fixtures/` | Launch Library 2, The Space Devs |

## Open questions

- HWM14 winds data in `third_party/hwm14`: the repository treats it as a U.S.
  Government work; the publisher lists CC BY-NC-ND for the article and its
  supporting information. Unresolved; see the follow-up on an optional runtime
  data input.
- The Orekit-derived CCSDS CDM example embedded in
  `analysis/conjunction-assessment/tests/wasmedgeStandaloneHarness.test.mjs`
  (CDMExample1, from Orekit's test resources, Apache-2.0).
