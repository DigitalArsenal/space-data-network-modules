# Catalog Source

An SDK module that transforms complete GCAT or McCants editions into
canonical, size-prefixed SDS CAT records.
The same parser artifact runs in the browser and WasmEdge without host calls.
The companion `fetch/` module prepares requests, validates original downloads
and ZIP members, and prepares publication requests. An SDK flow connects these
modules to the existing HTTP and storage capability modules; the SDN host
contains no GCAT or McCants parser.

`parse_gcat` takes the TSV edition on `source` and returns `catalog` plus a
JSON control `report`. An optional `meta` frame passes through only after the
entire edition parses successfully and its text hash matches. This keeps a
failed parse from leaving metadata queued for a later storage operation.
The report contains source-native keys in exactly the
same order as the records, the upstream update text, and counts of values
that cannot be represented faithfully. A host must preserve this report
alongside the edition before presenting native-key catalog composition.
The report is control metadata, not an SDS dataset offered in the Store.

`parse_mccants_tle_catalog` reads a decompressed `classfd.tle` or
`inttles.tle` edition and returns the same two ports. It accepts two-line
elements and optional name lines, verifies line lengths, checksums and
paired IDs, and supports Space-Track Alpha-5 numbers. It emits catalog
names and identifiers only. The host must keep classified and integrated
editions separate and retain their source URL, hash and retrieval time.
McCants' analyst numbers in 90000–99999 remain source-native keys:
`NORAD_CAT_ID` and `OBJECT_ID` stay unset for those entries. This prevents
analyst numbers and synthetic designators from joining unrelated catalogs.
McCants input lines are bounded to 1 KiB.

These CAT outputs contain no propagated states. In particular, McCants'
integrated products include model assumptions that cannot be replaced by
an arbitrary SGP4 run while retaining the original product's meaning.

Identity uses explicit SATCAT numbers only. `NNA` leaves `NORAD_CAT_ID`
unset; its GCAT key remains in the report. A JCAT sequence number is never
substituted for a missing NORAD number. Auxiliary catalogs that can assign
one SATCAT number to several distinct objects are rejected. Supporting
those catalogs requires a durable source-native identity contract first.

The parser maps names, valid modern COSPAR designators, precise UTC launch
dates, object classes and central bodies. It maps unflagged descriptive
perigee/apogee heights in km and inclination in degrees. These catalog
orbits describe early operations; they are not current orbital states.
Estimated orbit values, vague launch dates and historical pseudo-designators
are omitted. GCAT phase status, organization codes and bus names are not
coerced into incompatible CAT enums or foreign keys.

Input and output are each bounded to 128 MiB, editions to 250,000 records,
and individual input lines to 1 MiB. Damaged rows, duplicate identifiers or
disagreeing IDs reject the entire edition before any output is emitted.

Build both modules with `npm ci && npm run build`; then run `npm test`. Set
`SPACE_DATA_STANDARDS_ROOT` only to override the installed SDS package used
for SDK contract checks. `GCAT_TEST_EDITION=/path/to/satcat.tsv npm test`
also validates every row of a downloaded edition. Run
`MCCANTS_TEST_EDITION=/path/to/classfd.tle npm test` for a McCants edition.
Run
`SDN_RUN_CATALOG_PARITY=1 node --test tests/parity.test.mjs` with the SDK's
Chromium and native/container WasmEdge test lanes available.
`MCCANTS_TEST_ZIP=/path/to/classfd.zip npm test` also checks the original ZIP
through the fetch module and then through the parser. The stack's
`deployment/catalog-nodes/build-flows.mjs` composes four independent product
flows; `verify-flows.mjs` checks complete downloaded editions and recovery
after malformed responses, HTTP errors, unchanged responses and storage errors.

The current build still uses SDS 1.212.0. Do not enable native-identity feeds
until SDS 1.213.0 has completed its release gates and these modules consume
its generated bindings. The diagnostic report is not durable CAT identity.

Source and mapping authority: Jonathan C. McDowell,
[General Catalog of Artificial Space Objects](https://planet4589.org/space/gcat/),
[column definitions](https://planet4589.org/space/gcat/web/cat/cols.html).
GCAT data is CC BY 4.0; host publication must retain the provider attribution,
edition and license. Tests use published values from the 2026-09-06 edition;
the numerical checks test parsing precision, not orbit propagation.

McCants sources: [element archives](https://mmccants.org/tles/) and
[integration methods](https://mmccants.org/tles/discussion.html).
The 2026-09-07 fixtures cover 407 classified entries (131 analyst IDs)
and 63 integrated entries (14 analyst IDs). The
[SatNOGS Optical analyst-band analysis](https://gitlab.com/librespacefoundation/satnogs-optical/satnogs-optical/-/blob/main/CHANGELOG.md)
documents the same source numbering convention. McCants' source terms and
attribution must accompany publication; a parser build does not establish
redistribution rights or create an operational provider node.
