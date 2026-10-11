# Notice: data and software in `data-source/ilrs-crd-source`

## Data

| Source | Terms | In this module | Credit |
| --- | --- | --- | --- |
| ILRS normal points in CRD version 2, via the EUROLAS Data Center (EDC, DGFI-TUM) and the NASA CDDIS, audit id `ilrs` | The ILRS states its data and products are not copyrighted and requests citation of the ILRS and of the data centre (https://ilrs.gsfc.nasa.gov/about/cite.html, https://ilrs.gsfc.nasa.gov/data_and_products/data_centers/index.html, checked 2026-10-10); EDC adds no data terms of its own; reproduce: yes | The first two passes of `lageos1_20261008.np2` (stations SVEL and TKBL, 15 normal points), kept in `tests/fixtures` (provenance in `tests/fixtures/PROVENANCE.md`), read by the tests | ILRS data and products (Pearlman, M.R., Noll, C.E., Pavlis, E.C. et al. (2019), The ILRS: approaching 20 years and planning for the future, J Geod 93:2161-2180, doi:10.1007/s00190-019-01241-1), from the EUROLAS Data Center, DGFI-TUM (Noll, C.E. et al. (2019), J Geod 93:2211-2225, doi:10.1007/s00190-018-1207-2). Observations of the stations SVEL (Svetloe) and TKBL |

The format authority is the ILRS Consolidated Laser Ranging Data Format, version 2.01
(https://ilrs.gsfc.nasa.gov/docs/2022/crd_v2.01e3.pdf). The synthetic passes in `tests/fixtures/crd-format.mjs` are built to that layout
and hold no station data.

## Software

| Component | Licence | Where |
| --- | --- | --- |
| nlohmann/json 3.11.3 (Niels Lohmann) | MIT | `propagator/sgp4/src/cpp/include/nlohmann/json.hpp`, compiled into the module |
| FlatBuffers (Google), generated SDS headers of spacedatastandards.org | Apache-2.0 | compiled into the module |
| `common/alpha5.hpp`, `common/civil_time.hpp` | this repository | compiled into the module as headers |
