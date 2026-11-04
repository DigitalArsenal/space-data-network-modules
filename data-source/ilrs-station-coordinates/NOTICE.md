# Notice: data and software in `data-source/ilrs-station-coordinates`

## Data

| Source | Terms | In this module | Credit |
| --- | --- | --- | --- |
| ILRS weekly station coordinate solution (SINEX pos+eop) via the EUROLAS Data Center (EDC, DGFI-TUM), audit id `ilrs` | The ILRS states its data and products are not copyrighted and requests citation of the ILRS and of the data centre (https://ilrs.gsfc.nasa.gov/about/cite.html); EDC adds no data terms of its own; reproduce: yes | `ilrsa.pos+eop.260718.v90.snx` without its covariance block, in `tests/fixtures` (provenance in `tests/fixtures/PROVENANCE.md`), read by the E2E | ILRS data and products (Pearlman, M.R., Noll, C.E., Pavlis, E.C. et al. (2019), J Geod 93:2161-2180, doi:10.1007/s00190-019-01241-1); combination by ASI, CGS Matera; from the EUROLAS Data Center, DGFI-TUM (Noll, C.E. et al. (2019), J Geod 93:2211-2225, doi:10.1007/s00190-018-1207-2) |

The format authority is the SINEX format, version 2.02 (IERS).

## Software

| Component | Licence | Where |
| --- | --- | --- |
| nlohmann/json 3.11.3 (Niels Lohmann) | MIT | `propagator/sgp4/src/cpp/include/nlohmann/json.hpp`, compiled into the module |
| FlatBuffers (Google), generated SDS headers of spacedatastandards.org | Apache-2.0 | compiled into the module |
| `common/civil_time.hpp` | this repository | compiled into the module as a header |
