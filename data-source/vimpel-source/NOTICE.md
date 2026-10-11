# Notice: data and software in `data-source/vimpel-source`

## Data

| Source | Terms | In this module | Credit |
| --- | --- | --- | --- |
| JSC Vimpel public orbit data (spacedata.vimpel.ru): the osculating-element table, the rectangular ephemerides, the datefirst file | User agreement for registered users; no public licence ("Information will be available to registered users after confirming of User Agreement"). The repository's data licence audit (`orbit-accuracy-experiments` `data/licenses.json`, id `vimpel`) records reproduce: no. | **No Vimpel record.** The tests build synthetic objects in the provider's exact formats (`tests/fixtures/vimpel-format.mjs`); expected values are two-body relations. Real files stay on the archive host (`/opt/data/sdn-archive/vimpel-e3`) and are read for local runs only. | JSC Vimpel, http://spacedata.vimpel.ru/ ("Site reference is mandatory if using provided data in any publications") |

## Software

| Component | Licence | Where |
| --- | --- | --- |
| nlohmann/json 3.11.3 (Niels Lohmann) | MIT | `propagator/sgp4/src/cpp/include/nlohmann/json.hpp`, compiled into the module |
| FlatBuffers (Google), generated SDS headers of spacedatastandards.org | Apache-2.0 | compiled into the module |
| `foundation/orbits` state representations, `files/orbit-products` SHA-256 and Vimpel reader | this repository | compiled into the module as headers |
