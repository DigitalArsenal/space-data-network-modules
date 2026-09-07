# Catalog Source

An SDK module that transforms one complete GCAT `satcat.tsv` or
`satcat100k.tsv` edition into canonical, size-prefixed SDS CAT records.
The same artifact runs in the browser and WasmEdge. HTTP retrieval,
scheduling, provenance publication and storage belong to the SDN host flow.

`parse_gcat` takes the TSV edition on `source` and returns `catalog` plus a
JSON control `report`. The report contains source-native keys in exactly the
same order as the records, the upstream update text, and counts of values
that cannot be represented faithfully. A host must preserve this report
alongside the edition before presenting native-key catalog composition.
The report is control metadata, not an SDS dataset offered in the Store.

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

Build with `npm ci && npm run build`; then run `npm test`. Set
`SPACE_DATA_STANDARDS_ROOT` when the canonical standards checkout is not
the sibling repository. `GCAT_TEST_EDITION=/path/to/satcat.tsv npm test`
also validates every row of a downloaded edition. Run
`SDN_RUN_CATALOG_PARITY=1 node --test tests/parity.test.mjs` with the SDK's
Chromium and native/container WasmEdge test lanes available.

Source and mapping authority: Jonathan C. McDowell,
[General Catalog of Artificial Space Objects](https://planet4589.org/space/gcat/),
[column definitions](https://planet4589.org/space/gcat/web/cat/cols.html).
GCAT data is CC BY 4.0; host publication must retain the provider attribution,
edition and license. Tests use published values from the 2026-09-06 edition;
the numerical checks test parsing precision, not orbit propagation.
