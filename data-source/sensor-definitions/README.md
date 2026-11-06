# Sensor definitions 0.1.1

Real-world sensors as SDS `$SNR` sensor definitions (spacedatastandards.org 1.279.0), one record per sensor on a platform,
each value read from a named public source and carrying that source, its retrieval time, method and license. Seeded with the
Earth-observation and weather payloads of satellites in the CelesTrak SATCAT and with the ground space-surveillance sensors
listed in the curated space sites. Published weekly over SDN in two lanes: `space` (joined to a satellite by `NORAD_CAT_ID`
and `OBJECT_ID`) and `ground` (at a `$SIT` site by `SITE_ID`).

**Unknown is absent.** A positive quantity with no source is 0, a signed one NaN, an enum `UNSPECIFIED`, a table absent. No
value is guessed, copied from a sibling sensor or taken from a standard's band edges; a computed value says so in `NOTES`.

All parsing, joining and record construction run in C++/WASM. The host HTTP connector moves request/response bytes. The module
has no network imports. Configuration is a typed FlatBuffer message (`ModuleConfig`) through `plugin.getConfig`:
`producer_peer_id` (String, required). The roster is compiled in (`src/roster.hpp`), like `deep-space-spacecraft`'s.

## Methods and flow

| Method | In | Out |
| --- | --- | --- |
| `plan_sources` | `tick` (TICK) | `request` (HREQ x 62): the SATCAT, the OSCAR satellite documents and instrument pages of the roster, the MediaWiki extracts of the ground pages, each once |
| `build_sensors` | `response` (HRSP, any order, matched to the roster by URL) | `space_records`, `ground_records` (size-prefixed `$SNR` streams), `space_meta`, `ground_meta` (IngestRequest, SCHEMA `SNR.fbs`, RECONCILE Current, SOURCE_PEER, license, share-alike), `provenance` (one `$PVN` per source system), `notice` (an Info `sensor-counts` and, when anything was refused, one Missing `refused` with every reason) |

`flow.mjs`: timer (weekly) -> `plan_sources` -> `hostcap/http-request` -> `build_sensors` -> `hostcap/storage-ingest` (port
`snr_records`, added in storage-ingest 0.6.1) x 2 -> egress. A failed or non-200 response removes only the sensors that need it
and is reported; nothing is partial inside a record.

## Sources surveyed and decisions

Terms are the sources' own words. The owner's rulings apply: non-commercial data is published and shown signed out, SDN transfer
is not commercial use, CC BY-SA is allowed (`data-license-policy`). "Fetched" means this lane requested it from an automated
client on 2026-11-05.

| Source | What it gives | Access | License / terms | Decision |
| --- | --- | --- | --- | --- |
| **WMO OSCAR/Space** (`space.oscar.wmo.int`) | Satellites and the instruments each carries, with status and launch date (JSON API `/api/v1/satellites/<slug>`); per-instrument channel tables (central wavelength or frequency, bandwidth or interval) and descriptive fields (HTML `/instruments/view/<slug>`, class `frequencytable`); 1,063 satellites, 1,251 instruments. No NORAD or COSPAR ids, no frequency API. | JSON + HTML, no key, `robots.txt` absent. 62 requests a run, weekly. | "All information available on these pages may be used and redistributed freely, however, any publication using this information should acknowledge WMO." (`/pages/disclaimer`) | **Published** (`PVN` Reproducible), WMO acknowledged in every record's `ATTRIBUTION`. The core source: every imager, radiometer, altimeter and SAR record. |
| **CelesTrak SATCAT** (`celestrak.org/pub/satcat.csv`) | `NORAD_CAT_ID`, `OBJECT_ID`, name, type, launch and decay dates of every catalogued object: the authoritative join | CSV, one request a week (the 3-hour rule). Some addresses are refused by CelesTrak; the fixture was fetched through Tor | Public; redistributed with citation (the stack's CelesTrak authorization) | **Used for the join**, never republished beyond `NORAD_CAT_ID`/`OBJECT_ID`. The join is checked: the row exists and its launch date is within a day of OSCAR's (time zones; Sentinel-2C is 2024-09-05 in the SATCAT and 04 Sep 2024 in OSCAR). A constellation is the payloads named `ICEYE-`, `CAPELLA-`, `UMBRA-` still in orbit. |
| **Wikipedia** (MediaWiki API, `prop=extracts|revisions`) | Plain text of the pages of the AN/FPS-85, PARCS, Millstone Hill (MISA), ALTAIR, GLOBUS and the Maui complex, with revision id and timestamp; they cite the fact sheets below | JSON API, no key, one request per page | CC BY-SA 4.0 | **Published** (`PVN` ShareAlike, lane `ground` flagged share-alike), the revision named in `ATTRIBUTION` and `SOURCE_URL`. Only quoted facts (see "Facts"). |
| Government fact sheets: `spaceforce.mil`, `af.mil`, `smdc.army.mil` (Eglin, Cavalier, Kwajalein), Space Force Delta fact sheets | The authoritative ground-radar facts | Fetched: HTTP 403 or no answer for automated clients; no machine-readable export | US Government works (17 U.S.C. 105), unrestricted | **Not reachable.** The same facts reach us through Wikipedia, which cites them. When a fact sheet is reachable it replaces the Wikipedia quote. |
| MIT Haystack / Lincoln Laboratory (Millstone Hill, ALTAIR) | Radar parameters | Fetched `haystack.mit.edu`: pages name the radar and give no frequency or power | MIT copyright | **Not used**: no number to read. Millstone and ALTAIR therefore carry the band designation only. |
| **CEOS MIM database / EO Handbook** (`database.eohandbook.com`) | Missions, instruments, measurements; instrument "technical characteristics" as a one-line waveband summary | HTML (ASP.NET tables), sitemap, no export or API | "Data licence: CC BY 4.0" (page footer) | **Surveyed, not used in 0.1.1.** Summary text only ("VIS-SWIR: 12 channels between 0.41 um to 2.2 um"), no per-channel table: OSCAR is more detailed. Eligible as a cross-check. |
| **ESA eoPortal** (`eoportal.org`) | Mission articles with instrument parameters | HTML rendered by script; `api.eoportal.org` refuses; terms page empty without a browser | Not verifiable by an automated client | **Refused**: terms unverifiable, no export. |
| Copernicus Sentinel technical guides (`sentinels.copernicus.eu`, ESA) | Sentinel-1/2/3 instrument guides | Terms page not retrievable (404); documents are PDFs/HTML | ESA copyright; Copernicus open data policy applies to the data, not the guides | **Not used.** Sentinel-1/2/3 instruments come through OSCAR (which carries ESA's values); the CC BY-SA rule would allow ESA text after its terms are read. |
| NASA / USGS mission pages (Landsat OLI/TIRS bands) | Band tables | Not fetched (USGS copyrights page only) | US Government works; non-USGS images on those sites are copyrighted | **Not used**: OSCAR carries the OLI/TIRS tables. Eligible as a cross-check. |
| NOAA (GOES-R ABI, JPSS VIIRS/ATMS), EUMETSAT (SEVIRI, FCI), JMA (AHI) | Channel tables | NOAA not fetched. EUMETSAT: `user.eumetsat.int` terms page is empty without a browser. JMA: copyright page fetched, "Public Data License (Version 1.0)" | NOAA: US Government work; EUMETSAT: unverifiable; JMA: PDL 1.0 (CC BY compatible) | **Not used**: every one of these instruments is in OSCAR with the agency's table. |
| **Operator open data**: Capella, Umbra (CC BY 4.0), ICEYE (STAC catalogs) | Per-collect metadata (`sar:center_frequency`, polarizations, incidence angle) | S3 STAC, no key; Capella's catalog fetched | Capella and Umbra: CC BY 4.0 (AWS registry pages fetched); ICEYE: not verified | **Not used**: values are per collect, not per instrument. **Finding:** a Capella-13 collect states `sar:center_frequency` 9.6 GHz and OSCAR states 9.65 GHz for Capella; the record carries OSCAR's value and names it. |
| **FCC** (ICFS/IBFS, fcc.report) | Frequencies and EIRP of US commercial constellations in licence exhibits | Fetched: `licensing.fcc.gov` HTTP 403, `fcc.report` bot challenge; PDFs only | Public record | **Not reachable** by an automated client; no export. |
| **ITU** (Space Services Department, space network filings) | Satellite network filings: frequencies, beams | Landing page fetched; no public machine-readable export found there | Not verified | **Refused** until terms and an export are found. |
| Operator spec sheets (ICEYE, Capella, Umbra product pages) | Data sheets | Not fetched | No redistribution grant seen | **Not used**: OSCAR already states the frequency of each. |
| UCS Satellite Database, Gunter's Space Page, radartutorial.eu | Satellite and radar listings | Not fetched; the radartutorial pages the SIT records link to return 404 | Not verified | **Not used.** |

## Records (the recorded day, 2026-11-05)

| Lane | Source | `SensorType` | Records |
| --- | --- | --- | --- |
| space | WMO OSCAR | `MULTISPECTRAL_IMAGER` | 27: OLI x2, TIRS x2, MSI x3, OLCI x3, SLSTR x3, MODIS x2, VIIRS x3, ABI x4, AHI x2, SEVIRI x2, FCI x1 |
| space | WMO OSCAR | `SAR` | 86: Sentinel-1 x4, TerraSAR-X/TanDEM-X x2, PAZ x1, NISAR L and S x2, ICEYE x61, Capella x9, Umbra x7 |
| space | WMO OSCAR | `RADIOMETER` | 6: ATMS x3 (10 of its 22 channels), Sentinel-3 MWR x3 |
| space | WMO OSCAR | `ALTIMETER` | 3: Sentinel-3 SRAL x3 |
| ground | Wikipedia | `RADAR_AESA` 1 (AN/FPS-85), `RADAR_PESA` 1 (PARCS), `OPTICAL_TELESCOPE` 3 (AEOS, MOTIF, MSSS 1.6 m), `UNSPECIFIED` 4 (Millstone, ALTAIR, GLOBUS S and X) | 9 |

122 + 9 = 131 records, 567 bands, the largest 3,352 bytes (limit 8,191). Satellites: Landsat 8/9, Sentinel-1A/B/C/D, 2A/B/C,
3A/B/C, Terra, Aqua, Suomi NPP, NOAA-20/21, GOES-16/17/18/19, Himawari-8/9, Meteosat-10/11/12 (MTG-I1), TerraSAR-X, TanDEM-X,
PAZ, NISAR, and the on-orbit ICEYE (61), Capella (9) and Umbra (7) payloads. Not published, with the reason: Radarsat-2 (its
OSCAR instrument page states two frequencies for two satellites), MTG-S1 (no table), GOES lightning mapper and solar
instruments (no band table), `ais` receivers. Adding a platform is a line in `src/roster.hpp`.

## What a record holds

- `SENSOR_ID` `oscar:<instrument slug>:<NORAD_CAT_ID>` or `ground:<$SIT.ID>:<sensor>`; `NAME` the page's acronym and the SATCAT name
  (`MODIS on TERRA`); `NORAD_CAT_ID` and `OBJECT_ID` from the SATCAT row, `SITE_ID` the id of the site's record in
  `target-models-data-repo/data/sit_collection.json` (Eglin 3a24a663, Cavalier 76433a1e, Westford a9d2c4a0, Kwajalein 3c913198, Vardø a8fe5809, Maui 4b5cefa0).
- `TYPE` from OSCAR's own classification (`Moderate/High resolution optical imager` -> `MULTISPECTRAL_IMAGER`, `Imaging radar (SAR)` ->
  `SAR`, `Radar altimeter` -> `ALTIMETER`, `Passive microwave radiometer` -> `RADIOMETER`; any other classification is not
  published), or from a quote on the ground pages. `EMISSION` follows the type (radars, SAR, altimeter, lidar active; imagers,
  radiometers, telescopes passive) or a quote; a ground sensor whose page does not classify it is `UNSPECIFIED`, not guessed.
- `SPECTRAL_BANDS` in Hz. A stated wavelength interval ("433 - 453 nm") is converted with f = c/lambda (c = 299 792 458 m/s); a
  centre and a bandwidth give centre -/+ bandwidth/2 (in wavelength for optics, in frequency for microwave); a centre alone gives
  `FREQ_LOW_HZ` = `FREQ_HIGH_HZ`; a designation alone (`UHF`, `S`, `LWIR`) gives no edges. `NAME` is the table's own cell
  (`645 nm`, `Panchromatic`, `3.74 um (fire)`, `channel 5`); `DESIGNATION` only where a quote states one. `NOTES` says when edges are
  derived, and lists the channel rows not read.
- `FIELD_OF_VIEW`: a SAR's look angles when the page states them (`15-45 deg off-nadir`, `SAR_ANNULAR_SECTOR`; the clock angles are not
  stated and keep the SCV defaults 0 to 360), a cone half angle and range for the AN/FPS-85. Imagers carry none: OSCAR states swath
  widths in km, not field-of-view angles, and a derived angle would need an altitude the instrument does not own.
- `MOUNTING`, `RF`, `OPTICAL` only for values a quote states (the AN/FPS-85: south 180 deg azimuth, 45 deg elevation, fixed, 32 MW,
  10 MHz; Umbra: 1200 MHz bandwidth; telescopes: aperture). A single stated beamwidth is not copied to both axes; it stays in `NOTES`.
- `PROVENANCE`: `SOURCE`, `SOURCE_RECORD_ID`, `SOURCE_URL`, `RETRIEVED_AT` (the fetch), `SOURCE_VERSION` (the page's last update, or the
  Wikipedia revision), `METHOD` `UNSPECIFIED` (the sources publish values without stating how they were obtained), `LICENSE`,
  `ATTRIBUTION`, `SOURCE_SHA256` of the body parsed. `NOTES` carries what the page says about scanning and resolution, the join, and every
  quote a value was read from.

## Facts and quotes

A value that is not in a channel table is a roster `Fact`: a verbatim quote, the number in it, a unit scale. The module publishes it
only when the quote is in the fetched document and the number is in the quote, so a page edited after the roster was written stops that
value (reported as Missing, `claims.refused`), not the run. Azimuth "pointing south" is 180 deg (clockwise from north, `LOCAL_ENU`);
the elevation "from the horizon" is 0 deg; "UHF radar antenna" makes the sensor an active radar. Those words are the only conversions.
The AN/FPS-85 is `RADAR_AESA` because "each antenna element receives power from a separate transmitter module".

## Tests

`tests/sensor-definitions.e2e.mjs` (the module's end-to-end): the recorded real documents (`tests/fixtures/cassette.json.gz`: 33 OSCAR
satellite documents, 22 instrument pages, 6 MediaWiki extracts, the SATCAT rows of the roster, trimmed to whole rows; URL, fetch time and
sha256 of each in `provenance.json`) through both methods, every `$SNR` read back from the lane streams with the published bindings. It
reads every OSCAR channel table with its own code and requires the module's bands to equal it, on every platform; decodes a SAR
(Sentinel-1C), an imager (MODIS on Terra, 36 bands) and a radar (AN/FPS-85) field by field; requires every number of a ground record
to appear in a quote of its `NOTES`; and checks that a stale quote, a SATCAT launch date that disagrees with OSCAR, a failed OSCAR
page and a missing SATCAT each stop exactly the values that depend on them. `tests/composed-flow.e2e.test.mjs` compiles `flow.mjs` with the
SDK and runs it through the real HTTP and ingest guests with only the host boundary substituted: the stored bytes equal the standalone
streams. `node tests/record-cassette.mjs` re-records (OSCAR and Wikipedia live; the SATCAT from `SATCAT_FILE`).

## Install on a node

The node needs the module and the flow (`flow.mjs`, program `com.digitalarsenal.flows.sensor-definitions-ingest`), `hostcap/storage-ingest` 0.6.1
(port `snr_records`), the capability approvals of the module and storage-ingest, node `producer_peer_id` configuration, and an SDN
node that stores `$SNR` at SDS 1.279.0 (the node's embedded catalog still carries the earlier `$SNR`).
