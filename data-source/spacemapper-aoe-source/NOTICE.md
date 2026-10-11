# Notice: data and software in `data-source/spacemapper-aoe-source`

## Data

| Source | Terms | In this module | Credit |
| --- | --- | --- | --- |
| SpaceMapper AOE catalog and orbital database (spacemapper.cn; Beijing Kaiyun United Information Technology) | No licence is stated. The pages are public; robots.txt disallows only `/_nuxt/`. The archive keeps the records for local use and never publishes or redistributes them. The repository's data licence audit has no entry yet (registry id `spacemapper-aoe`, reproduce: no). | **No SpaceMapper record.** The tests build synthetic records in the archive's record format (`tests/fixtures/aoe-format.mjs`); expected values are the numbers they are made of and the two-line element conventions. Real records stay on the archive host (`/opt/data/sdn-archive/hac/spacemapper-aoe`) and are read for local runs only. | SpaceMapper, https://spacemapper.cn/ |

## Software

| Component | Licence | Where |
| --- | --- | --- |
| nlohmann/json 3.11.3 (Niels Lohmann) | MIT | `propagator/sgp4/src/cpp/include/nlohmann/json.hpp`, compiled into the module |
| FlatBuffers (Google), generated SDS headers of spacedatastandards.org | Apache-2.0 | compiled into the module |
