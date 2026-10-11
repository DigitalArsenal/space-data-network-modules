# Notice: data and software in `data-source/spacetrack-source`

## Data

| Source | Terms | In this module | Credit |
| --- | --- | --- | --- |
| Space-Track.org GP, GP history and SATCAT (USSPACECOM, 18th Space Defense Squadron) | Space-Track User Agreement (2019); USSPACECOM's blanket approval to redistribute basic SSA data (element sets, SATCAT, decay) with citation. The repository's data licence audit (`orbit-accuracy-experiments` `data/licenses.json`, id `space-track`) records reproduce: no. | **No Space-Track record.** The tests build synthetic element sets and catalog entries in Space-Track's exact format (`tests/fixtures/spacetrack-format.mjs`); every value comes from the numbers written there. Real files stay on the archive host (`/opt/data/sdn-archive/spacetrack`) and are read for local runs only. | Source: USSPACECOM / 18th Space Defense Squadron, via Space-Track.org (https://www.space-track.org) |

A publication of analysis based on Space-Track data carries the credit line. The data is obtained with a Space-Track.org account;
the module takes the bytes the host flow retrieved and holds no credential.

## Software

| Component | Licence | Where |
| --- | --- | --- |
| nlohmann/json 3.11.3 (Niels Lohmann) | MIT | `propagator/sgp4/src/cpp/include/nlohmann/json.hpp`, compiled into the module |
| FlatBuffers (Google), generated SDS headers of spacedatastandards.org | Apache-2.0 | compiled into the module |
