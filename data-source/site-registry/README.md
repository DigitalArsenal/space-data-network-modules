# SDN site registry

SDN data retrieval module for every site the SpaceAware console shows (owner
2026-10-13: "It should all load over SDN, that's the whole point"), run on a
provider node by the flow `com.digitalarsenal.flows.site-registry-ingest`
(`flow.mjs`, weekly; stack `deployment/site-registry-provider-node`) and
auto-published as two lanes of provider `sdn-site-registry`:

| Lane | Schema | Records |
| --- | --- | --- |
| `sites` | `SIT.fbs` ($SIT 1.1.0) | every site, with its cited lifecycle, description, references, parties and quantities |
| `site-places` | `GNP.fbs` | the search projection of the sites in the current and prospective views |

The console (`spaceaware-ui src/orbital-console/sources/siteRegistry.ts`)
discovers both lanes, verifies each shard against its signed $DPM and reads
them over bitswap; it ships no facility, status or reference data.

## What is in it

| Network | From |
| --- | --- |
| Nuclear labs, Storage sites, Nuclear power plants, Nuclear facilities, Chemical plants, Research facilities | Wikidata class membership (`register/classes.json`, the audit's classes in its order, nuclear power plants before nuclear facilities) |
| Nuclear power plants | also the Global Energy Monitor tracker's plants no Wikidata row stands for (`gem:<project id>`) |
| Nuclear power plants | the GeoNames nuclear power placemarks (`geonames:<id>`, `register/placemarks.json`) with their reviewed item and tracker joins |
| Bio labs, Chemical labs, Storage sites | the curated register (`register/curated.json`) |
| Space sites | the curated register (`register/space-sites.json`): 168 rows, 105 with a reviewed Wikidata item, 36 more with their English Wikipedia article as their page (`page`), and the GeoNames space-centre, satellite-station and launch placemarks the console had bundled (`geonames`) |

Run of 2026-10-14 (live sources, provider node): 7,365 sites; 6,793 search
rows; lane 10.2 MB. The module computes on wasi-threads: four pthreads over
its shared memory parse the answers and read the articles
(`src/parallel.hpp`; each item writes its own slot and the stage merges them
in order, so the bytes do not depend on the thread count). CPU on the
recorded run: native 4.7 s on four threads (articles_b 1.6 s) against 11.0 s on one; the WASM
module 12.2 s in Node at machine load 40 (one thread 13.7 s;
`site-registry-cpu-size-20261013` carries the 5 s gate). On a provider
node the run takes about 6 minutes, most of it the spaced requests.

The provider flow links the one-thread build of the same source
(`flow-host/`, `node build.mjs --flow-host`, the same output bytes, tested):
the SDN flow runtime bounds a threaded guest's call at 30 s when its caller
gives no budget, and this flow's linked drain carries its HTTP requests
(follow-up `sdn-flow-threaded-drain-budget-20261013`).

## Stages

| Stage | Reads | Asks for |
| --- | --- | --- |
| `plan` | configuration (access, run time, producer) | the class SPARQL queries and the register items' settlement check |
| `entities_a` | class membership | the first third of the items (`wbgetentities`, 50 a request) |
| `entities_b`, `entities_c` | items | the next third |
| `parties` | the last items | operator, owner and regulator labels and websites; the country of rows no item places; any label of unnamed items; the GEM tracker; the newest ROR release |
| `articles_a` | parties, tracker units, the ROR release | the first third of the Wikipedia articles and the ROR dump |
| `articles_b`, `articles_c` | articles (and the dump) | the next third |
| `finish` | the last articles | nothing: the lanes, their ingest meta and the run report |

- The state between stages is the `$SIT` stream itself (no other frame type
  crosses a stage); working entries (prose statements, unit-date markers,
  unresolved parties) are dropped before publishing. The HTTP descriptors,
  the ingest meta and the run report are the host connectors' current
  contracts until `modules-hostcap-typed-20261013` types them.
- Every stage asks at most 60 times; every request names its own URL and
  states its own validator. A non-2xx answer, a MediaWiki maxlag (Wikipedia)
  or a continued answer fails the stage, so nothing is published from a
  partial read. Wikidata reads carry no maxlag: wikidata.org counts the
  query service's lag in it, which would fail most runs.
- Output is sorted by ID and determined by the answers and the run time.

## The rules

Ported from the site-status audit's reviewed tools (SpaceAware-UI
`src/tools/facility-status`, verified 2026-10-13 rounds 1-5); every
Wikidata rule and every infobox, date and prose rule gives the same result as
the JavaScript on all 6,259 items and 3,467 articles of the audit's cache
(`tools/native`). A reviewed fact (`register/reviewed.json`) decides when one
exists; otherwise the most advanced stated state, unless a dated return to
service follows every dated stop; a state's date is the earliest stated; a
date after the run's day is dropped; an organisation renamed or merged stays
operating; a station follows its tracker units. Prose statements of a started
or completed dismantling never decide: the run report lists the ones the
decided status leaves open (the review queue), and the reviewed facts whose
article has a newer revision.

Round-6 corrections (2026-10-14): descriptions are read in every language
the item has (nl "voormalig", pl "dawny", ru "бывший"; "GDR"); an item whose
own description calls it former or defunct is closed under its name even when
a successor carries the work on ("now called" keeps it open, "now part of"
does not); a station item filed as a nuclear facility follows its tracker
units unless its own statements close it (Tokai Power Station); reviewed
facts for the US chemical depots, JACADS, the Russian destruction facilities,
Philippine Research Reactor-1 and the resumed Ninh Thuận plants.

Against the audit (`tools/equivalence.mjs`, oracle SpaceAware-UI e0d053f):
27 rows on the other side of the current / not-current split, every one a
round-6 correction of the oracle; no date difference; two status changes
(Santa María de Garoña and Hinkley Point B are decommissioning, by reviewed
facts); seven register items that are towns, not sites, are rows of their
own.

## Sources and terms

`register/sources.json`. Published: Wikidata (CC0), Wikipedia infobox facts,
titles and links only (CC BY-SA 4.0, credited per record), Global Energy
Monitor's tracker (CC BY 4.0), ROR (CC0), GeoNames positions (CC BY 4.0), the
SDN site register (CC BY 4.0). Never fetched: IAEA PRIS/RRDB, BASE, ASNR,
CNSC, OpenStreetMap (check-only, `tools/check-only.mjs` is a follow-up) and
nrc.gov (refuses automated fetches; dockets are entered by hand in
`register/nrc-dockets.json`). Each citation carries its source's `$PVN`;
a record's `PROVENANCE` gives the terms of the content it reproduces.

```sh
npm install && npm run build && npm test
SPACE_DATA_STANDARDS_ROOT=<SDS 1.249.0 checkout>   # until 1.249.0 is on npm
```

Tools: `tools/run-native.mjs` (a development run against live sources with
the native build), `tools/run-wasm.mjs` (a recorded run replayed through the
WASM module, timed per stage), `tools/make-fixtures.mjs` (the e2e fixtures from a recorded
run), `tools/equivalence.mjs` (a lane against the audit's oracle),
`tools/match-register-qids.mjs` and `tools/import-audit-registers.mjs` (how
the registers were made).
