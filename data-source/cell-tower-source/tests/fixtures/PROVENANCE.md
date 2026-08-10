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

## 2026-08-10 — `bakom-mobile-sites.sample.json`

Captured by ranged GET from the live national file, before a single byte of the
adapter was written:

```
GET https://data.geo.admin.ch/ch.bakom.standorte-mobilfunkanlagen/
      standorte-mobilfunkanlagen/standorte-mobilfunkanlagen_2056.json
Range: bytes=0-60000
-> 206  application/geo+json  content-range: bytes 0-60000/27261289
   last-modified: Sun, 09 Aug 2026 21:09:01 GMT
```

The fixture is the first **14 complete features** of that response, re-wrapped
in the same `FeatureCollection` envelope (`crs` preserved verbatim — it is the
load-bearing field, see below). Nothing was edited.

**Chosen for its ability to FAIL**, which is the only property that makes a
fixture worth keeping:

- `techno_en` spans four distinct values across the 14 — `Technology 2G`,
  `Technology 4G`, `Technology 4G,5G`, `Technology 3G,4G,5G`. A decoder that
  returned a constant radio class, or that took the FIRST generation listed
  instead of the highest, passes a uniform sample and fails this one.
- Three different operators appear in `station` (Swisscom, Salt, Sunrise), so an
  attribution that leaked across features — the exact defect the Overpass
  decoder shipped with — is visible rather than invisible.
- The coordinates are EPSG:2056 metres, so the fixture also pins the LV95
  transform. A decoder that reads them as degrees drops all 14 rows.

**Why the CRS matters more than it looks.** These are easting/northing in
metres (e.g. `[2732413, 1219730]`), not degrees. Fed to a lat/lon reader they
fail the module's own -90/-180 range guard and every row is silently dropped —
a provider that fetches 27 MB perfectly and contributes nothing, which is
indistinguishable from a country that has no masts. That is the same class of
failure this whole task was filed about.

The transform was verified against known points BEFORE being compiled in, not
after: the LV95 origin `(2600000, 1200000)` transforms to `46.95108, 7.43864`,
which is the Bern reference point to five decimals. And one fixture feature's
`station` carries the canton code `GE_`, which lands in Geneva under the
transform — an independent check, because a swapped or rotated axis would still
put a point inside Switzerland but not inside the right canton.

Licence: opendata.swiss terms. The obligation rides into republication through
`$TBS.SOURCES`, like every other provider's.
