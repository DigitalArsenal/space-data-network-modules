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

## 2026-08-14 — `bakom-mobile-sites.slice-1200.json.gz`

Captured by full GET of the same live national asset, for
`graph/tasks/mod-cell-tower-bakom-decode-loss.md`:

```
GET https://data.geo.admin.ch/ch.bakom.standorte-mobilfunkanlagen/
      standorte-mobilfunkanlagen/standorte-mobilfunkanlagen_2056.json
-> 200  27,273,745 bytes
   sha256 852b82d7a1e484ee269e99a0c878e5949f0bb7a049a7432b8f2058c23e1736a3
   features: 22,347 (exact)
```

The fixture is the first **1,200 complete features** of that body, **verbatim** —
the leading bytes are the file's own, byte for byte, and only the array
terminator `\n]}\n` is appended to close the envelope. Nothing was edited,
reformatted or re-serialized. It is gzipped (63 KB vs 1.48 MB) purely to keep
that much upstream JSON out of the tree; `zlib.gunzipSync` returns the captured
bytes exactly.

**Chosen for its ability to FAIL.** 1,200 is deliberately *above* the
1,000-row anonymous per-provider cap. A slice that fit under the cap could not
distinguish a lifted cap from an unlifted one, which is the entire question
`tests/bakom-full-population.test.mjs` exists to answer — the lane reported ~364
of 22,347 Swiss sites and the cause was three silent caps, not a decode fault.

Why the sibling 14-feature `bakom-mobile-sites.sample.json` stays: it is the
adapter's semantic fixture (four `techno_en` generations, the GE canton check on
the LV95 transform). This one is the *population* fixture. They fail for
different reasons and neither replaces the other.

## The four national bulk archives (2026-08-14)

`cell-tower-bulk-archive-adapters`. Four registers were verified live and then
carried as `lane: "unavailable"` because the module decoded no ZIP and no
protobuf. These fixtures are what unblocked them, and each is cut from a body
fetched on 2026-08-14.

| fixture | upstream | live body | contains | rows |
|---|---|---|---|---|
| `acma-rrl.slice.zip` | `cdn.acma.gov.au/rrl/spectra_rrl.zip` | 69,940,117 B, 31 members | `site.csv` header + first 200 data rows, verbatim | 200 |
| `ised-sms-tafl.slice.zip` | `ic.gc.ca/engineering/SMS_TAFL_Files/TAFL_LTAF.zip` | 64,197,105 B, 1 member | `TAFL_LTAF.csv` first 200 rows incl. the UTF-8 BOM, verbatim | 200 |
| `anfr-cartoradio.slice.zip` | `static.data.gouv.fr/.../20260630-export-etalab-data.zip` | 65,696,863 B, 5 members | `SUP_SUPPORT.txt` header + first 200 rows, verbatim | 200 |
| `comreg-siteviewer.sample.pb` | `POST api-siteviewer.comreg.ie/mobile-masts/point` `{}` | 401,836 B, unauthenticated | first 250 complete protobuf records, byte-exact prefix | 250 |

**Repacked containers, verbatim contents.** The three ZIPs are *re-packed* (the
upstream archives are 64–70 MB and cannot live in the tree), but every CSV byte
inside them is the upstream file's own — headers, quoting, delimiters, BOM and
all. The ComReg fixture is not repacked at all: it is a byte-exact prefix of the
live response, cut at a record boundary.

**The two decoy members are deliberate.** `acma-rrl.slice.zip` carries a
`device_details.csv` and `anfr-cartoradio.slice.zip` a `SUP_BANDE.txt`, both
filled with junk rows. They stand in for the real siblings the decoders must
never touch — 383,353,349 B and 203,638,089 B respectively — so that a decoder
which starts extracting members it does not need fails a test instead of
quietly exceeding the memory ceiling in production.

**Why 200 rows and not more.** These fixtures exist to pin the COLUMN CONTRACTS,
which is a per-row property; the population question is answered against the
live archives instead (below). 200 is under the 1,000-row anonymous cap on
purpose, so the cap tests can set a small `LIMIT` and observe it without the
fixture's own size confounding the result.

**Verified at real scale, 2026-08-14.** The fixtures pin the contracts; the full
archives prove the streaming design holds. Each complete body was decoded
through the compiled `dist/isomorphic/module.wasm`:

| provider | compressed in | decoded out | wall |
|---|---|---|---|
| `acma-rrl` | 69,940,117 B | 129,334 sites | 5.4 s |
| `ised-sms-tafl` | 64,197,105 B | 795,495 records | 25.4 s |
| `anfr-cartoradio` | 65,696,863 B | 198,524 supports | 4.6 s |
| `comreg-siteviewer` | 401,836 B | 9,646 masts | 0.1 s |

The ANFR number is the corroboration worth keeping: `SUP_SUPPORT.txt` has
198,525 lines including its header, so 198,524 is every support in the file and
none invented. The ISED run is the one that justifies the whole streaming
design — its single member inflates to 428,229,263 B, more than three times the
flow's 128 MB linear-memory ceiling, and it is never materialised.

**Licences.** ACMA's `LICENCE.TXT` was re-read from inside the live archive:
Intellectual Property in the Register is retained by the ACMA, granting a
non-transferable, non-exclusive licence to use, reproduce and adapt. It is NOT
CC BY 4.0, and the registry string says so. ISED is the Open Government Licence
– Canada; ANFR is Licence Ouverte 2.0; ComReg SiteViewer is CC BY 4.0. The
fixtures are small extracts kept for regression testing; the full bodies are
fetched at runtime and carry their attribution through `$TBS.SOURCES`.
