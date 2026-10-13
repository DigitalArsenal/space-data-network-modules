# Fixture provenance

Recorded 2026-10-13 from a live run of the stage chain (`tools/run-native.mjs`)
and cut down by `tools/make-fixtures.mjs` to a dozen named sites plus every
item the registers name.

| File | Source | Licence |
| --- | --- | --- |
| `classes.json`, `settlements.json`, `entities.json`, `parties.json`, `countries.json`, `labels.json` | Wikidata (query service and `wbgetentities`), statements the module reads only | CC0 1.0 |
| `articles.json` | Wikipedia: the infobox template of the named sites' articles (no prose), each with its revision id | CC BY-SA 4.0, Wikipedia contributors; each entry names its article and revision |
| `gem.geojson` | Global Energy Monitor, Global Nuclear Power Tracker, August 2026 release (map GeoJSON), the units of the named plants and of the register's placemark joins | CC BY 4.0, Global Energy Monitor |
| `ror-slice.csv` | Research Organization Registry data dump v2.14 (2026-10-06), the rows of the fixture's items | CC0 1.0 |

The test builds the ROR zip from `ror-slice.csv` at run time.
