# Notice: data and software in `data-source/satnogs-optical-source`

## Data

| Source | Terms | In this module | Credit |
| --- | --- | --- | --- |
| SatNOGS Optical nightly dump, session 2026-09-21 (https://optical.satnogs.org/data) | CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/): reuse with credit; a database built from a substantial part shares alike | `tests/fixtures/satnogs-optical-2026-09-21-66514.parquet` (the 423 rows of NORAD 66514, cut) and `tests/fixtures/station-11.json`, read by the E2E; both remain CC BY-SA 4.0 | SatNOGS Optical contributors - https://optical.satnogs.org - CC BY-SA 4.0 |

The format authorities are CCSDS 503.0-B-2 (Tracking Data Message) and the Apache Parquet format specification.

## Software

| Component | Licence | Where |
| --- | --- | --- |
| nlohmann/json 3.11.3 (Niels Lohmann) | MIT | `propagator/sgp4/src/cpp/include/nlohmann/json.hpp`, compiled into the module |
| FlatBuffers (Google), generated SDS headers of spacedatastandards.org | Apache-2.0 | compiled into the module |
| `common/civil_time.hpp` | this repository | compiled into the module as a header |
