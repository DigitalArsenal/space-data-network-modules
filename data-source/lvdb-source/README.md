# Local Volume Database source

Task `modules-lvdb-source-20261103`. This unsigned SDK module retrieves the
CC0 Local Volume Database and produces size-prefixed SDS 1.275.0 `$SSY`
FlatBuffers on `SSY.fbs / lvdb / comb-all`.

The composed flow is in `../../flows/lvdb-source`. Its seven nodes fetch the
upstream `code/release_version.txt`, plan the named release, fetch
`comb_all.ecsv`, `pm_overview.csv`, `j_factor.csv` and the tagged source archive,
parse them, and pass records plus typed ingest metadata to generic storage.
The archive's own release marker must agree with the requested release.

All table, gzip/tar and YAML parsing runs in C++ WASM. Configuration is an
optional **empty MCFG** on every method; unknown settings are refused. There
is no JSON record output. HTTP and durable storage remain host capabilities.
The module pins SDS 1.275.0 and SDK 0.9.12 locally; the flow also pins the SDK.
Every measured/derived quantity uses EXOParameter, including correlations,
placement and J-factor percentiles. No coordinates or physical quantities are
computed in JavaScript.

## Mapping and source fidelity

The published combined table takes precedence for its columns. Tagged YAML
supplies location errors, other names, morphology, discovery information,
proper-motion correlations, SFH, HI kinematics and extra profile fits. YAML
is joined by its declared key, because `ngc_0185_gc_PA-N185` has a lowercase
filename. Duplicate YAML keys follow the upstream Python loader's last-value
behavior, including duplicate sections. Empty YAML references remain absent.
Missing numbers remain absent/NaN; source infinities are retained.

Errors preserve magnitude and asymmetry: `_ep` becomes positive ERR1 and
`_em` becomes negative ERR2. An upper/lower bound has LIMIT +1/−1. When a
combined quantity has both a measurement and a bound, the measurement stays
in its field and the bound is an ALTERNATE. The coordinator ruled that the
six pairs span five systems, with two on `garro_1`; the two literal zero
bounds are retained unchanged. The E2E names all six pairs.

The fetched companion files contain 790 PM rows and 622 J-factor rows (the
study reported 789/621). All are retained. Nine historical key spellings are
joined to canonical keys verified in the tagged YAML; record NOTES retain
the original companion keys. Unknown companion keys refuse the batch.

PM and J-factor measurements preserve their individual citations, methods,
selection/use and comments. LVDB J-factor interval widths are converted in
WASM to the percentile coordinates named by SSY's P05/P95 fields. Profile
radii retain the source unit; King/Sersic columns from the combined table use
its normalized arcmin unit.

SOURCE_SHA256 contains, in order, SHA-256 of the complete ECSV, PM CSV,
J-factor CSV, tagged gzip archive, and that record's exact YAML bytes. Every
record includes its release, YAML URL, source key/table, CC0-1.0 license,
retrieval time and Pace 2025 citation. Gzip CRC/length and tar checksums are
validated. The module emits nothing until the complete batch validates.

## Build and acceptance

From this directory:

```sh
npm ci --ignore-scripts
node build.mjs --unsigned
node --test tests/sdk_compat.test.mjs
node tests/lvdb-source.e2e.mjs
```

From the modules root, build the production flow:

```sh
npm ci --ignore-scripts --prefix flows/lvdb-source
node flows/lvdb-source/build.mjs --unsigned
```

Builds use the SDK compiler's WASI sequential toolchain and the shared
`dist/isomorphic/module.wasm` contract. No signing key is embedded or used.
The vendor directory pins RapidYAML's MIT-licensed source and verifies its
SHA-256. The build adapts only WASI platform detection; miniz and SHA-256 are
reused from existing modules.

The E2E fetches and hash-verifies v1.1.1 inputs (ignored `tests/cache`), checks
1,727 decoded records and all eleven Q1 table counts, verifies all 122 combined
columns including the named rows, checks YAML additions and the companion
tables, and asserts the six exact value/limit pairs. It compiles a replay flow
that substitutes captured HTTP response bytes at the HTTP boundary, drives
all seven nodes and asserts byte-for-byte equality at typed storage ingress.
Invalid batches are refused. Committed trimmed fixture hashes are verified.
These are catalog equality tests: no astronomical model or tolerance is used.

## Native publication and complete-series readback

Whenever `SDN_NODE_BINARY` is set, native verification is required; a failure
fails the E2E. Without a binary the runner explicitly reports a skip. From the
modules root:

```sh
SDN_NODE_BINARY=/absolute/path/to/spacedatanetwork \
  node data-source/lvdb-source/tests/lvdb-source.e2e.mjs
```

The node must embed SDS 1.275.0 / SSY. The test uses the built sdn-js client at
`../space-data-network/sdn-js` relative to the modules root; `SDN_JS` can name
another built sdn-js checkout. It boots an isolated scratch node, signs the
replay artifact with that node's temporary identity and schedules it.

An auto-publication log's manifest CID names only the first signed part.
The reader therefore requests the complete batch segment plan through the
typed `open-manifest` protocol. It fetches every listed signed manifest and
shard by CID, verifies hashes, byte lengths, per-segment counts and unique
SSY identities, then reruns the complete source oracle. The 1 MiB shard
budget is retained and the E2E requires multiple shards. The final PASS line
includes the summary manifest CID, shard count and unique-record count;
each shard's CID and count is also printed. No provider installation or
revoked development signing key is used.

## Fixture provenance

`tests/fixtures` contains the five alternate-bearing systems plus
`antlia_2` and `aquarius_3`, trimmed from the real v1.1.1 ECSV/PM/J-factor
fetch. ECSV metadata is retained. YAML files are byte-identical excerpts.
`provenance.tsv` records each upstream file URL, fetch completion time,
full-source SHA-256 and fixture SHA-256. Trimming reserializes CSV/ECSV, so
source and fixture hashes are separate.

YAML and the release marker were retrieved through
https://api.github.com/repos/apace7/local_volume_database/tarball/v1.1.1
(commit prefix `72dabf7`). Archive SHA-256:
`1daa9ffb5f2705b9819e13dbc5557f78546ede33892dbd371f2067a02fbbf628`.
The raw file URLs identify the corresponding tagged files. License CC0-1.0;
citation Pace 2025, OJAp 8, 142.
