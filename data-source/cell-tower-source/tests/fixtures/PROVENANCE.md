# Fixture provenance

`opencellid.sample.csv` is a HAND-WRITTEN fixture in the OpenCelliD CSV column
contract (`radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal`),
not a cut of live provider data. It is written that way deliberately:

- The parity gate needs cases that a real extract would only contain by luck —
  in particular TWO reports of the SAME cell (310/260/40495/17811) from two
  different providers, differing in position, sample count and observation
  time, so `HIGHEST_SAMPLE_COUNT` and `MOST_RECENT` provably select different
  winners.
- No provider's terms are engaged by a synthetic five-row file, so this fixture
  carries no licence obligation of its own. Real provider bytes are fetched at
  runtime by the flow's http connector and carry their own attribution through
  `$TBS.SOURCES`.

The first two rows are the same cell; rows 3-5 are distinct cells.

## Captured live responses

The two JSON fixtures are the opposite kind and exist for the opposite reason.
They are VERBATIM BODIES of successful live requests, captured 2026-08-08, kept
because `cell-tower-provider-endpoints-are-download-pages` was caused by URLs
written from documentation rather than from a fetch that actually worked. A
hand-written fixture cannot catch that class of defect: it agrees with whatever
the author believed the service returns. These disagree with the author.

| fixture | request | rows |
|---|---|---|
| `overpass-berlin.sample.json` | `GET overpass.kumi.systems/api/interpreter?data=` the compiled Overpass program, bbox `52.45,13.30,52.55,13.45` | 15 elements |
| `fcc-uls-3650-houston.sample.json` | `GET opendata.fcc.gov/resource/euz5-46g2.json?$where=` the compiled bbox filter, `$limit=12`, bbox `29.60,-95.70,30.10,-95.20` | 12 rows |

`overpass-berlin.sample.json` is Berlin rather than the demo's Houston box for
one reason: 7 of its 15 masts carry an `operator` tag and 8 do not. That mix is
what makes the element-locality test able to fail. The Houston capture was all
untagged, so it would have passed the same test while the decoder attributed
every mast to its neighbour — a fixture that cannot detect the bug it is there
to guard is worse than none, because it reports safety.

Licences: OSM data is ODbL 1.0 (© OpenStreetMap contributors); the FCC rows are
US Government public domain. Both attributions ride on every `$TBS.SOURCES`
entry derived from them, which is where the obligation is actually discharged.
