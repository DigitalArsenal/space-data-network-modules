# Notice: data and software in `data-source/sp3-precise-source`

## Data

| Source | Terms | In this module | Credit |
| --- | --- | --- | --- |
| IGS products: the IGS final combined orbit `igs15000.sp3` (week 1500) and the CODE multi-GNSS final `COD0MGXFIN_20250190000_01D_05M_ORB.SP3` (AIUB), audit id `igs` | IGS Data and Product Disclaimer and Terms of Use (2020-08-05): open use without restriction, citation requested; the IGS warranty disclaimer goes with mirrored files; reproduce: yes | Three epochs of each, kept in `files/orbit-products/fixtures` (provenance there), read by the tests by path | International GNSS Service (IGS) products, courtesy of the IGS and its analysis and data centres. Johnston, G., Riddell, A., Hausler, G. (2017), The International GNSS Service, in Springer Handbook of Global Navigation Satellite Systems, pp. 967-982, doi:10.1007/978-3-319-42928-1 |
| ESA/ESOC Navigation Support Office GNSS orbits (ESA0OPSFIN, ESA0OPSRAP, ESA0OPSULT), audit id `esa-navigation-office` | Navigation Support Office terms; ESA's web-portal terms grant no right to redistribute or derive; reproduce: no (owner, 2026-10-10) | **No ESA file.** Synthetic SP3-d files (`tests/fixtures/sp3-format.mjs`) | © Navigation Support Office at ESA/ESOC |
| ESA/ESOC precise orbits of CryoSat-2 and Swarm, audit id `esa-navigation-office-pod` | No open licence; the IGS terms do not apply; reproduce: no | **No ESA file.** Synthetic SP3-d files | © Navigation Support Office at ESA/ESOC |

The SP3 format authority is "The Extended Standard Product 3 Orbit Format (SP3-d)", S. Hilla, National Geodetic Survey, 2016
(https://files.igs.org/pub/data/format/sp3d.pdf), with SP3-c (https://files.igs.org/pub/data/format/sp3c.txt).

## Software

| Component | Licence | Where |
| --- | --- | --- |
| nlohmann/json 3.11.3 (Niels Lohmann) | MIT | `propagator/sgp4/src/cpp/include/nlohmann/json.hpp`, compiled into the module |
| FlatBuffers (Google), generated SDS headers of spacedatastandards.org | Apache-2.0 | compiled into the module |
| `files/orbit-products` SP3 reader and SHA-256 | this repository | compiled into the module as headers |
