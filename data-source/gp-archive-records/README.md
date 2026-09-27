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

One field batch frame on port `records`. All integers are little-endian.

```
"GPAF" | u16 version (1) | u16 field_count
field_count x { u8 name_length | name }   SDS field names, in any order
u32 record_count
record_count x, one value per header field, in header order:
  string: u32 byte_length | bytes
  double: 8 bytes, IEEE-754 binary64
  uint32: 4 bytes
```

- `build_mpe` fields:
  - `ENTITY_ID` (string);
  - `EPOCH` (Unix seconds, UTC);
  - `MEAN_MOTION`, `ECCENTRICITY`, `INCLINATION`, `RA_OF_ASC_NODE`,
    `ARG_OF_PERICENTER`, `MEAN_ANOMALY` and `BSTAR` (doubles).
- `build_cat` fields: `OBJECT_ID` and `OBJECT_NAME` (strings) and
  `NORAD_CAT_ID` (uint32).

Rules for the batch:

- The header must name every field of the record exactly once. The module
  matches each name against the generated SDS accessor of that name.
- Values travel as their exact bytes and bits. Nothing is formatted or parsed
  on the way in, so negative zero, subnormal doubles and names that are not
  UTF-8 reach the builder unchanged.
- An unknown, repeated or missing field, a truncated record or trailing bytes
  refuses the whole batch.

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

The module is built on the `wasi-sequential` toolchain (clang
wasm32-wasip1-threads, no thread spawn). Under an interpreted WasmEdge host it
builds a record in about 15 µs.
