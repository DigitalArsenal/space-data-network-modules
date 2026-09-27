# GP Archive Records module

Builds the GP history archive's records for the SDN importer
(`spacedatanetwork import-gp-archive`):

- `build_mpe`: one `$MPE` element set per input object.
- `build_cat`: one `$CAT` catalog row per input object.

The records are built with the SDS C++ builders generated from the pinned
`spacedatastandards.org` package. Field names and vtable slots come only from
those generated headers.

## Archive encoding v1

The archive identifies every record by its content ID: sha256 over the record
bytes. FlatBuffers leaves the byte layout to the builder. The same values,
added in a different order or with default values left out, give different
bytes and so a different ID. The archive's ~101 million element sets were
written by the importer's original Go builder, so its layout is a compatibility
contract. This module reproduces it, and names it **archive encoding v1**.

`$MPE`:

1. Create the `ENTITY_ID` string.
2. Add `ENTITY_ID`, `EPOCH`, `MEAN_MOTION`, `ECCENTRICITY`, `INCLINATION`,
   `RA_OF_ASC_NODE`, `ARG_OF_PERICENTER`, `MEAN_ANOMALY`, `BSTAR` and
   `MEAN_ELEMENT_THEORY`, in that order.
3. Write every field, including values equal to the schema default. A zero
   eccentricity, a zero BSTAR and `MEAN_ELEMENT_THEORY` `SGP4` (enum value 0)
   are stored, not left out. Negative zero stays negative zero.
4. Finish size-prefixed with the `$MPE` identifier.

`$CAT`:

1. Create the `OBJECT_ID` string, then the `OBJECT_NAME` string.
2. Add `OBJECT_ID`, `NORAD_CAT_ID` and `OBJECT_NAME`, in that order.
3. Leave default values out: a `NORAD_CAT_ID` of 0 is not written.
4. Finish size-prefixed with the `$CAT` identifier.

This is not the layout `flatc` gives when it converts JSON. Its parser groups
fields by size (8-byte fields first, then 4-byte, then 1-byte), writes them in
reverse schema order, and leaves defaults out unless `--force-defaults` is set.
None of its options reproduces the archive's layout.

The contract is enforced by `tests/archive-v1-vectors.json`. Its expected bytes
were written by the original Go builders (space-data-network `70c9d4884`), not
by this module. The vectors cover:

- edge cases: defaults, negative zero, extreme doubles, every entity-id length
  that moves the alignment, escaped strings and strings that are not UTF-8,
  and `NORAD_CAT_ID` 0 and 2^32-1;
- records sampled from every source in the archive.

A change that alters any byte is a new encoding, not a fix.

## Input

One JSON frame on port `records`. The frame is an array with one object per
record, keyed by the SDS field names of the record being built.

- `build_mpe` requires `ENTITY_ID` (a string). It also requires `EPOCH` (Unix
  seconds, UTC), `MEAN_MOTION`, `ECCENTRICITY`, `INCLINATION`,
  `RA_OF_ASC_NODE`, `ARG_OF_PERICENTER`, `MEAN_ANOMALY` and `BSTAR` (numbers).
  `MEAN_ELEMENT_THEORY` is optional and must be `"SGP4"`.
- `build_cat` requires `OBJECT_ID`, `OBJECT_NAME` (strings) and `NORAD_CAT_ID`
  (an unsigned 32-bit integer).

Rules for the values:

- Numbers are parsed with correct rounding. A value written by a shortest
  round-trip formatter, such as Go's `strconv.FormatFloat(v, 'g', -1, 64)`,
  comes back as the same double.
- Strings are byte strings. Escapes are decoded and every other byte is kept as
  given, so a name that is not UTF-8 is stored with the same bytes the Go
  builder stored.
- A missing, unknown or repeated key refuses the whole batch. The error names
  the first bad record by its index.

## Output

Port `records`: an aligned, size-prefixed stream. Each record is written as
`[u32le length][buffer]` and padded to 8 bytes with zeros, in input order.

## Build and test

```sh
npm ci
SDM_MODULE_SIGNING_KEYPAIR_PATH=<keypair.json> npm run build
npm test
npm run test:parity   # headless Chrome, native WasmEdge 0.16.4, Docker WasmEdge
```
