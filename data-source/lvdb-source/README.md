# LVDB source — evidence checkpoint

Task: `modules-lvdb-source-20261103`. This directory currently contains source
fixtures only. No importer, WASM artifact, retrieval flow or passing E2E exists.
Implementation stopped under the owner's instruction to report ambiguities.

The v1.1.1 release fetched on 2026-11-04 UTC has 1,727 combined records and all
Q1 table counts match:

| Table | Records |
| --- | ---: |
| dwarf_mw | 68 |
| dwarf_m31 | 43 |
| dwarf_local_field | 64 |
| dwarf_local_field_distant | 736 |
| gc_harris | 155 |
| gc_mw_new | 58 |
| gc_ambiguous | 22 |
| gc_dwarf_hosted | 313 |
| gc_other | 7 |
| candidate | 214 |
| misc | 47 |

## Acceptance ambiguity

The brief requires “the 6 rows that have both a value and a limit”. The actual
release contains six quantity pairs across five distinct source rows:

| Source key | Quantity | Value | Upper limit |
| --- | --- | ---: | ---: |
| eso_383-087 | flux_HI | 27.7 | 0.0 |
| ugc_02716 | flux_HI | 4.92 | 0.0 |
| garro_1 | vlos_sigma | 0.4 | 0.8 |
| garro_1 | mass_dynamical_wolf | 3.2 | 3.8 |
| sagittarius_2 | ellipticity | 0.03 | 0.08 |
| fornax_1-gc6 | metallicity_spectroscopic_sigma | 0.03 | 0.17 |

Clarification needed: should the E2E require six ALTERNATES distributed across
these five records, preserving the two literal zero limits? Nothing has been
silently dropped or interpreted as a missing value.

## Fixtures and provenance

`tests/fixtures` contains those five systems plus `antlia_2` and `aquarius_3`,
trimmed from the fetched ECSV and companion PM/J-factor CSVs. ECSV metadata is
retained. YAML files are byte-identical excerpts of the tagged source archive.
`provenance.tsv` records the upstream file URL, fetch completion time, full
source file SHA-256 and committed fixture SHA-256. CSV/ECSV trimming changes
serialization; source and fixture hashes are intentionally separate.

The YAML files and `code/release_version.txt` were retrieved through
https://api.github.com/repos/apace7/local_volume_database/tarball/v1.1.1
(commit prefix `72dabf7`). Archive SHA-256:
`1daa9ffb5f2705b9819e13dbc5557f78546ede33892dbd371f2067a02fbbf628`.
The raw file URLs identify the corresponding tagged files. The release marker
reads `v1.1.1`. Dataset license: CC0-1.0; citation: Pace 2025, OJAp 8, 142.

The released SDS 1.275.0 SSY schema was inspected: all quantities, including
placement, correlations and J-factor percentiles, use EXOParameter. ERR2 must
be negative. The module-local package pin pattern in swpc-realtime permits
consuming this release without changing the modules root dependency.

The local SDN checkout has no `sdn-server/internal/sds/schemas/SSY.fbs`.
Node publication/readback therefore needs the separately assigned SSY vendor
task. No node was launched and no CID readback was attempted.

No gauntlet or E2E PASS is claimed for this evidence checkpoint.
