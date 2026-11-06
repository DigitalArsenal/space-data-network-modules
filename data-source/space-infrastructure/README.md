# Space infrastructure 0.1.1 (phase 1: sensor sites)

Worldwide space-surveillance and missile-warning sensor sites as SDS `$SIT` (spacedatastandards.org 1.279.0) and the sensors at them as
`$SNR`, read weekly from Wikidata, Wikipedia and OpenStreetMap. Every value carries its source, the retrieval time and the license; a
position is checked against a second source wherever the roster names one; every other value is a verbatim quote that must occur in the
document fetched in the run. Later phases (airfields, launch sites, factories, companies, the supply, operations and remote-sensing chain,
a console layer) are separate records.

**Unknown is absent.** A positive quantity with no source is 0, a signed one NaN, an enum `UNSPECIFIED`, a table absent. No value is
guessed, copied from a sibling sensor, taken from a standard's band edges, or computed from a value that has no source. A site whose
position cannot be read, or whose sources disagree by more than the roster's tolerance, is not published and is reported. A site whose
coordinate denotes the base or the island the radar stands in, and not the radar, says so in `DESCRIPTION`.

All parsing, cross-checking and record construction run in C++/WASM. The host HTTP connector moves request/response bytes. The module has
no network imports. Configuration is a typed FlatBuffer message (`ModuleConfig`) through `plugin.getConfig`: `producer_peer_id` (String,
required). The roster is data (`src/roster.json`, embedded by `build.mjs` into the generated `src/roster_data.hpp`); adding a site is an
entry in it, with the quotes it is read from.

## Methods and flow

| Method | In | Out |
| --- | --- | --- |
| `plan_sources` | `tick` (TICK) | `request` (HREQ x 48): the Wikidata entities of the roster (`wbgetentities`, 40 per request), the MediaWiki extracts and page coordinates of its Wikipedia articles (one per article), one Overpass request for its OpenStreetMap elements by id |
| `build_infrastructure` | `response` (HRSP, any order, matched by URL) | `site_records` (`$SIT`), `sensor_records` (`$SNR`) as size-prefixed streams, `site_meta`, `sensor_meta` (IngestRequest: one attribute per record id with the sha256 of its record, so two weeks are a diff of two lists), `provenance` (one `$PVN` per source system), `notice` (an Info `infrastructure-counts` and, when anything was refused, one Missing `refused` with every reason) |

`flow.mjs`: timer (weekly) -> `plan_sources` -> `hostcap/http-request` -> `build_infrastructure` -> `hostcap/storage-ingest` (ports
`sit_records` and `snr_records`) x 2 -> egress. A complete run is each lane's whole current set (`RECONCILE Current`). **A run in which any
request failed or was unreadable only adds** (`Duplicates`, `fetch.failures` in the report): an outage of one source never retires the
records that depend on it. A failed response removes only the values that need it; nothing is partial inside a record.

## Sources surveyed and decisions

Terms are the sources' own words. The owner's rulings apply: non-commercial data is published and shown signed out, SDN transfer is not
commercial use, CC BY-SA is allowed (`data-license-policy`). "Fetched" means this lane requested it from an automated client on 2026-11-05.

| Source | What it gives | Access | License / terms | Decision |
| --- | --- | --- | --- | --- |
| **Wikidata** (`wbgetentities`, `query.wikidata.org`) | Coordinates (P625 with the stated precision), elevation (P2044), labels and descriptions of the radar, station or base items; 42 items read | JSON API, no key; fetched. SPARQL fetched: a class query over radar-station instances returns 214 rows, mostly WWII Chain Home and Air Force Stations, and a label scan times out; the radar classes are used inconsistently, so the roster names items and the flow reads them by id | CC0 1.0 ("structured data in the main, Property and Lexeme namespaces is available under the Creative Commons CC0 License") | **Published** (`PVN` Reproducible). Primary position of 34 sites; the stated precision is in `DESCRIPTION`. |
| **Wikipedia** (MediaWiki API, `prop=extracts|revisions|coordinates`) | Article text (quotes), the revision id, the page coordinate tags; 45 articles | JSON API, no key, one request per article, `robots.txt` fetched | CC BY-SA 4.0 | **Published** (`PVN` ShareAlike; lanes flagged share-alike), the revision named in `SOURCE_URL`/`SOURCE_VERSION` of every citation. Only quoted facts; the quote must occur in the fetched text. Position of 6 sites (one page coordinate; five Voronezh sites from the coordinate tags of the Voronezh radar article, each the single tag within a stated distance of the named town). |
| **OpenStreetMap** (Overpass API, one by-id request) | Position and name tags of 12 elements (LPAR stations tagged `military=radar`, the Fylingdales array, the Don-2N and Don-2NP radars) | JSON; the public instance is capacity limited (502/429 observed) and refused every connection from this address after the survey queries of this lane, so the recorded OSM response is assembled from the survey responses of the same day, elements verbatim (`tests/fixtures/provenance.json`, `assembledFrom`); `node tests/record-cassette.mjs` replaces it when the server answers | ODbL 1.0 ("(c) OpenStreetMap contributors") | **Published** (`PVN` ShareAlike, attribution in every record). Primary position of 10 sites. The Chinese LPAR elements carry `source=GOVPrivGEODB`, an import of an unnamed database: they are single-source and the record says so. One request a week, by element id only; the survey sweeps are not part of the flow. |
| Government fact sheets: `spaceforce.mil`, `mda.mil`, `af.mil`, Air University CASI | Authoritative radar facts; CASI has the 2024 PLA LPAR report cited by Wikipedia | Fetched: `spaceforce.mil` and `airuniversity.af.edu` HTTP 403, `mda.mil` no answer | US Government works, unrestricted | **Not reachable** by an automated client. The same facts reach us through Wikipedia, which cites them. Replace the Wikipedia quote when a fact sheet is reachable. |
| **LeoLabs** (`leolabs.space/radars/`) | Radar families and the countries of their sites (Texas, Alaska, Australia, Azores, Costa Rica, New Zealand, Arizona) | HTML fetched, `robots.txt` allows, crawl-delay 10 | No grant to republish; no coordinates in the page | **Not used.** No site position is published by the operator or by Wikidata/Wikipedia/OSM tags found; named under "not sourced". |
| CSIS Missile Threat, FAS (Federation of American Scientists), SWF Global Counterspace, radartutorial.eu | Think-tank and reference descriptions of radars | `missilethreat.csis.org` and `fas.org` fetched (HTML); the SWF report address returned 404; radartutorial.eu `robots.txt` fetched | No machine-readable export; no license grant stated | **Not used.** Quotes would need terms the pages do not give. |
| **ExoAnalytic**, Slingshot, Numerica, NorthStar | Commercial optical networks | ExoAnalytic home page fetched | Sites not published | **Not used.** No site list found. |
| UCS Satellite Database, Gunter's Space Page, GlobalSecurity | Listings | Not fetched | Not verified | **Not used.** |

## Records (the recorded day, 2026-11-05)

51 sites and 64 sensors. 291 claims verified, 0 refused; 21 positions are corroborated by a second source, 30 are single-source
(`DESCRIPTION` says which).

| Country (ISO 3166) | Sites | Sensors |
| --- | --- | --- |
| Russia (643) | 14 | 16 |
| United States (840) | 9 (+ the SBX platform, no site) | 15 |
| China (156) | 8 | 9 |
| Norway (578), Marshall Islands (584), Australia (036), Ukraine (804) | 3, 2, 2, 2 | 5, 2, 2, 2 |
| Azerbaijan, Belarus, Germany, Greenland, Japan, Kazakhstan, Spain, Taiwan, Tajikistan, Turkey, United Kingdom | 1 each | 1 each, Germany 2, Japan 2 |

| `SensorType` | Sensors |
| --- | --- |
| `PHASED_ARRAY_EARLY_WARNING` | 28 (UEWR/SSPARS 5, AN/FPS-115 Leshan, Voronezh 8, Dnepr 2, Daryal at Gabala, LPAR 8, SBX) |
| `RADAR_AESA` 4, `RADAR_PESA` 3 | AN/FPS-85, Volga, AN/TPY-2, LRDR as AESA; COBRA DANE, PARCS, Pechora as PESA |
| `OPTICAL_TELESCOPE` | 10 (AEOS, MOTIF, MSSS 1.6 m, GEODSS Maui, SST, Krona, Okno, ESA OGS, Bisei x2) |
| `UNSPECIFIED` | 19: radars whose sources state that they are radars (`EMISSION` ACTIVE) but not their kind (ALTAIR, Haystack, TIRA, EISCAT, Don-2N, GLOBUS, Space Fence, Krona radars, the C-band radar at Holt) |

Sites by position source: Wikidata 34, OpenStreetMap 10, Wikipedia 6 (one coordinate tag, five Voronezh sites), the coordinate text of an
article 1.

## What a record holds

- `$SIT`: `ID` `sdn-infra:<slug>`; `NAME`, `ABBREVIATION`, `SITE_TYPE`, `CTR_ID` (ISO 3166 numeric); `LATITUDE`/`LONGITUDE` with
  `POSITION_CITATION` (the source record, its URL and revision, `SOURCE_FIELD` `P625` / `coordinates` / `osm:center` / `description`, the
  `PVN` of the source with its license); `DESCRIPTION` (what the coordinate denotes, how many sources agree, Wikidata's stated precision);
  `PARTIES` (operator, quoted); `SITE_KIND`, `NETWORK`, `ESTABLISHMENT_DATE` (quoted); `LIFECYCLE_STATUS` with `STATUS_EVIDENCE` only where a
  quote states it (Cape Cod, Fylingdales, Space Fence, SST, the 2017 Voronezh stations: OPERATING; Gabala: PERMANENT_SHUTDOWN);
  `QUANTITIES` ELEVATION where Wikidata states metres; `EXTERNAL_REFERENCES` (Wikidata, English Wikipedia, OpenStreetMap); `PROVENANCE`
  (the `PVN` of the record: the licenses of every source it used, joined, share-alike when any is).
- `$SNR`: `SENSOR_ID` `infra:<site-slug>:<sensor>` (a platform: `infra:platform:<slug>` with `ENTITY_ID`), `SITE_ID` the `$SIT.ID`; `TYPE`,
  `EMISSION`; `SPECTRAL_BANDS` in Hz (a designation alone, `UHF`, gives no edges; edges only from a quoted interval, or centre -/+ half a quoted
  width, which `NOTES` says is derived); `FIELD_OF_VIEW` only for a quoted cone half angle; `MOUNTING` only for quoted boresight or limits;
  `RF` (peak power, bandwidth) and `OPTICAL` (aperture, limiting magnitude) only for quoted values; a stated range travels in `NOTES`
  (`Stated range: N km.`), never as a field of view. `PROVENANCE`: `SOURCE`, `SOURCE_RECORD_ID`, `SOURCE_URL`, `RETRIEVED_AT`, `SOURCE_VERSION`
  (the Wikipedia revision), `METHOD` `UNSPECIFIED` (the sources publish values without stating how they were obtained), `LICENSE`,
  `ATTRIBUTION`, `SOURCE_SHA256`; a section read from another document than the record's first carries its own `PROVENANCE`. `NOTES` lists
  every quote with its document.

## Decoded examples

- **US UEWR** `infra:cape-cod-sfs:an-fps-132`: `PHASED_ARRAY_EARLY_WARNING`, active, one band `UHF` (no edges), at `sdn-infra:cape-cod-sfs`
  (41.7532, -70.5385, Wikidata Q5034670, precision 0.0001 deg; operator 6th Space Warning Squadron; operational 1980-04-04; network SSPARS).
  Quoted: SSPARS "network of fixed-position, solid-state phased array radar systems used for long-range early warning and space
  surveillance"; "The radars operate at ultra high frequency (UHF) and can detect objects out to 3,000 miles (4,800 km)".
- **Russian Voronezh** `infra:lekhtusi:voronezh-m`: `PHASED_ARRAY_EARLY_WARNING`, one band `VHF` (no edges), "Voronezh-M, a VHF radar with a
  stated range of 4,200 kilometres" (`Stated range: 4200.0 km.`), at `sdn-infra:lekhtusi` (60.27546, 30.54602, Wikidata Q6520615, precision about
  1 m; Russian Space Forces; combat duty 2012-02-11).
- **Chinese LPAR** `infra:cn-lpar-yiyuan:lpar`: `PHASED_ARRAY_EARLY_WARNING`, no band, no RF, no mounting (no source states one), at
  `sdn-infra:cn-lpar-yiyuan` (36.0247, 118.0917; OpenStreetMap node 13987986039, `name=沂源 大型相控阵雷达站(LPAR)`, 0.04 km from Wikidata Q141393987
  "first radar station with LPAR in China"; network from the Wikipedia statement of "four large ground-based phased array early warning radars in
  Xinjiang, Shandong, Heilongjiang, and Zhejiang"). Licenses CC0 AND CC-BY-SA-4.0 AND ODbL-1.0, share-alike.

## Not sourced in 0.1.1

Named, with what is missing; a site enters the roster when a position source (Wikidata item with P625, an article coordinate, an OSM element
or an article's coordinate text) and a quote for its sensor exist.

- **US and allied**: GEODSS Socorro and Diego Garcia (the articles give no coordinates; Wikidata has the island/range, not the station), TRADEX,
  ALCOR and MMW at Roi-Namur (no article text), Ascension Island radar, AN/TPY-2 at Shariki, Kyogamisaki, the Israeli site and Qatar (Wikidata
  holds a base item for Kyogamisaki with no radar statement; no article text for the others), the SSPARS radar at Umm Dahal (Qatar; no
  coordinate), MOSS (closed), the Taegu GEODSS (closed).
- **Russia and former Soviet**: Krona-N at Nakhodka (coordinate text exists; no sensor quote beyond Krona), Dunay-3, Skrunda, Balkhash and
  Gantsevichi beyond Baranavichy, Daryal-U sites never completed (Yeniseysk-15, Balkhash, Mishelevka Daryal-U): no operating sensor.
- **China**: the 2024 Air University report and the Shuangyashan and Lin'an (Zhejiang) names: the OSM nodes at 30.2866 N 119.1286 E and
  46.5280 N 130.7553 E are published as unnamed LPAR elements without a province, because no reachable source attributes them to a place
  name. Space surveillance stations (Purple Mountain Observatory, Xuyi): no reachable source with coordinates.
- **Europe**: GRAVES (the article and Wikidata give no coordinates for the transmitter or receiver), GESTRA, S3T (no article), Chilbolton (the
  article names no space-surveillance sensor), EISCAT Kiruna and Sodankylae (receivers; no coordinates in the sources read).
- **Others**: Israel Green Pine sites (the article names no site), India LRTR/Swordfish (no site coordinates), Japan J/FPS-5 and J/FPS-3 sites (the
  article lists none), South Korea, Iran Ghadir (no coordinates), Kamisaibara (no article).
- **Commercial**: LeoLabs (sites by country only), ExoAnalytic, Slingshot, Numerica, NorthStar.

## Overlap with `data-source/sensor-definitions`

Its `ground` lane (9 Wikipedia-sourced ground sensors, `SITE_ID` of the target-models SIT collection) overlaps this module's AN/FPS-85, PARCS,
Millstone, ALTAIR, GLOBUS and Maui sensors. This module owns ground sensors and their sites (one `$SIT` per place, `sdn-infra:<slug>`); the
proposal is that `sensor-definitions` keeps the `space` lane (payloads) and drops its `ground` lane, so one sensor has one record. This module
does not edit that one.

## Tests

`tests/space-infrastructure.e2e.mjs` (the module's end-to-end): the recorded real documents (`tests/fixtures/cassette.json.gz`: 42 Wikidata
items in 2 requests, 45 MediaWiki extracts, one Overpass response; URL, fetch time and sha256 of each in `provenance.json`) through both
methods, every `$SIT` and `$SNR` read back from the lane streams with the published bindings. It re-derives every site position from the fixture
documents with its own readers and recomputes every cross-check distance; reads every claim of the roster and requires its quote in its
document and its number in the quote, every number of every record to be a claim's number times its scale, and every quote to be in `NOTES`;
decodes a US UEWR, a Russian Voronezh and a Chinese LPAR; and checks that a stale quote, a failed article, a moved position and a failed OSM
request each stop exactly the values that depend on them (the failed fetch also turns the batch into an add-only one), the lane metadata (one
sha256 per record), the three provenance records and byte-identical reruns. `tests/composed-flow.e2e.test.mjs` compiles `flow.mjs` with the SDK
and runs it through the real HTTP and ingest guests with only the host boundary substituted: the stored bytes equal the standalone streams.
`node tests/record-cassette.mjs` records what the cassette lacks (`REFRESH=1` records everything).

## Install on a node

The node needs the module and the flow (`flow.mjs`, program `com.digitalarsenal.flows.space-infrastructure-ingest`), `hostcap/storage-ingest`
0.6.1 (ports `sit_records`, `snr_records`), the capability approvals of the module and storage-ingest, node `producer_peer_id` configuration, and
an SDN node that stores `$SIT` and `$SNR` at SDS 1.279.0 (the node's embedded catalog still carries the earlier `$SNR`).
