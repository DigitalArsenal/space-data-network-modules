# SpaceMapper AOE Source

An SDK module that reads the records of SpaceMapper's AOE catalog (spacemapper.cn, channel KY among others) into canonical SDS
`$OMM` records and an id crosswalk. AOE is the second element-set lineage of the catalog paper (section 11): SGP4 mean elements
from SpaceMapper's own ground and space sensors, beside sets it relays from other catalogs. It is the AOE entry of the per-source
products (`flows/source-products`, catalog pipeline C2): the flow takes its `$OMM` on `element_sets` and gives the source's `$OMM`,
`$OCM` (covariance and its label) and `$MNV`.

The same artifact runs in the browser and WasmEdge, byte for byte. Retrieval belongs to the SDN host flow: the pages are server
rendered with their records in the page state, which the host decodes as data (nothing from a page is executed), splits by box to
stay under the site's 1,000-record answers, and stores. The module reads the records the host extracted: JSON lines, as the archive's
`records.jsonl`, or one JSON array.

## Method

`parse_aoe`, input `source` (up to 128 MiB), outputs `omm`, `crosswalk` and `report`.

- **The set.** The record's two-line set is the element set. Its fixed columns are decoded into the OMM fields SGP4 takes, without
  computing anything: eccentricity and B* are written with an implied decimal point, the epoch as a year and a day of year (the
  digits' own resolution, 0.864 ms, kept as microseconds). A catalog number above 99999 is Alpha-5 in the set (`A0000` = 100000,
  `common/alpha5.hpp`). `MEAN_ELEMENT_THEORY` is SGP4, the frame TEME of date, the time system UTC.
- **Checks.** The record also gives its epoch (on China Standard Time, `+0800`), its NORAD number and the elements rounded to 3 to 6
  decimals. A record whose rounded fields, epoch (to a millisecond) or NORAD number disagree with its set is dropped and counted,
  with the reason (orbit-accuracy-experiments E15's rule, which reads the same records). A set that is not SGP4 (ephemeris type
  other than 0), or a line that is not 69 columns, is dropped. AOE writes a zero checksum on most lines (99 % of the 2026-10-11
  records), so a checksum that does not match is counted, never a reason to drop a set.
- **Identity.** The NORAD number AOE gives (`noradId`) is the set's `NORAD_CAT_ID`. Where AOE gives none the object is named
  `aoe:<catId>` (`USER_DEFINED_OBJECT_DESIGNATOR`) and no NORAD number is invented. AOE's own ids ride in
  `USER_DEFINED_PARAMETERS`: `AOE_CHANNEL` (KY), `AOE_RECORD_ID`, `AOE_CAT_ID`, `AOE_SAT_ID`, `AOE_LAST_UPDATE_ID`,
  `AOE_OBJECT_TYPE`. `OBJECT_ID` is the international designator AOE gives when it is one. Names and bare numbers never join.
  AOE's ids above 99999 are not AOE's own: in the 2026-10-11 KY snapshot 271 of the 273 objects with `catId` above 99999 are in
  Space-Track under the same number with the same designator.
- **Time.** `CREATION_DATE` is the record's `ctime` (AOE's write time, hh:04 UTC every three hours) in UTC: the moment the set was
  available. A record id seen twice in one input (the listing shifts while it is paged) is dropped and counted.
- **Crosswalk.** What AOE states about each object, from its newest set, as candidates (`status: candidate`): `native` (`aoe:<id>`),
  the AOE catalog id, the NORAD number it gives (null when none), its satellite id, the designator, name, class and channel. Two sets
  that state different numbers for one AOE id are listed in `conflicts`. The `$CAT` integrator binds an identity only through a link
  tested on normalized ephemerides.
- **Report.** Records read, emitted, dropped (by reason, first 20 examples), duplicates, Alpha-5 numbers, checksum mismatches, objects
  with no NORAD number.

A record that cannot be read is dropped and counted; an input that is not JSON lines or a JSON array of objects, or that gives
nothing readable, is refused whole with no partial output. Errors are flags, never exceptions.

Read for this module (local run, nothing committed): the 2026-10-11 KY snapshot, 19,129 records of 19,100 objects, 17.7 MB, converts in
0.8 s: none dropped, 273 Alpha-5 numbers, 18,938 zero-checksum lines.

## Build and test

```sh
npm ci
npm run build          # dist/isomorphic/module.wasm and dist/guest-link (single thread, SDK 0.8.27, SDS 1.245.0)
npm test               # the module through the SDK's browser harness
npm run test:parity    # headless Chrome, native WasmEdge, Docker WasmEdge: byte-identical
```

`flows/source-products/tests/source-chain.test.mjs` runs AOE-format records through the module and the compiled flow.

## Licence and data

SpaceMapper states no licence for the AOE catalog (robots.txt disallows only `/_nuxt/`); the archive keeps it for local use and
never publishes or redistributes it, and the catalog paper cites it and copies nothing. The data licence audit
(`orbit-accuracy-experiments` `data/licenses.json`) lists it as `spacemapper-aoe`, reproduce: no. **No SpaceMapper record is in this module, its tests or its fixtures**: they are synthetic, in the archive's record format
(`tests/fixtures/aoe-format.mjs`). Real records stay under `/opt/data/sdn-archive/hac/spacemapper-aoe`. `NOTICE.md` records the
terms. Credit line: SpaceMapper, https://spacemapper.cn/.
