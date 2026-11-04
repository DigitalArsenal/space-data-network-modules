# LVDB acceptance checkpoint, 2026-11-04 UTC

Implementation candidate: `8f84df56836337e1a37639dcd3668afa5d20ae30`.
SDS 1.275.0, RecordTypeExtended SSY = 295; SDK 0.9.12.
Unsigned standalone and production flow builds succeed. SDK compatibility:
3 checks pass (standards compliance, canonical exports/WASI imports, browser
harness loading).

The declared E2E ran inside the gauntlet against this candidate:

```text
PASS companion tables: 790 proper motions, 622 J factors, field equality
PASS SSY per-table counts dwarf_mw=68 dwarf_m31=43 dwarf_local_field=64 dwarf_local_field_distant=736 gc_harris=155 gc_mw_new=58 gc_ambiguous=22 gc_dwarf_hosted=313 gc_other=7 candidate=214 misc=47
PASS ALTERNATE (eso_383-087, FLUX_HI) value=0 LIMIT=+1
PASS ALTERNATE (ugc_02716, FLUX_HI) value=0 LIMIT=+1
PASS ALTERNATE (garro_1, VLOS_SIGMA) value=0.8 LIMIT=+1
PASS ALTERNATE (garro_1, DYNAMICAL_MASS_WOLF_LOG) value=3.8 LIMIT=+1
PASS ALTERNATE (sagittarius_2, ELLIPTICITY) value=0.08 LIMIT=+1
PASS ALTERNATE (fornax_1-gc6, METALLICITY_SPECTROSCOPIC_SIGMA) value=0.17 LIMIT=+1
PASS antlia_2 and aquarius_3 CSV field equality (all 122 columns covered across identity, measurements, errors, limits, references, profiles and placement)
PASS YAML supplemental measurements=822; six ALTERNATES across five records
PASS composed retrieval flow: 7 nodes, release marker + 4 sources, 1727 SSY records at typed storage boundary
PASS incomplete/corrupt input batches refuse all records
PASS typed MCFG on all three methods; malformed and unsupported settings refused
PASS committed trimmed fixture hashes: 11 files
DEFERRED native SSY CID readback: sdn-vendor-ssy-20261103; rerun with LVDB_NODE_READBACK=1 and SDN_NODE_BINARY
PASS lvdb-source E2E: 1727 decoded FlatBuffers
```

Source counts 790/622 were independently confirmed with Python csv.DictReader;
the study's 789/621 companion counts are one low. The eleven combined-table
counts agree with Q1 exactly. Companion key aliases are checked against names
and other_name in tagged YAML. No companion measurements are discarded.

## Gauntlet: FAIL

Stack gate revision `3229aa38b5a2293b920caf9234cad9edadc00f4b`.
PASS: lane policy, typed-port-coverage, json-boundary-modules,
flow-link-models, declared E2E. Unrelated physics checks skipped as not in diff;
nightly check skipped as nightly-only.

The sole failing check is typed-config:

```text
FAIL NEW modules yaml-config data-source/lvdb-source/src/module.cpp
```

`graph/checks/typed-config.mjs` defines YAML_PARSER to match any `ryml::`
reference and scanSource unconditionally labels it yaml-config (lines
269 and 323 in that gate revision). It does not distinguish catalog input
from configuration. Here YAML is the required LVDB source-data format; all
configuration ports are typed MCFG, and malformed/nonempty configs are refused.

No baseline or gate code was changed. The parser has not been renamed or
hidden from scanning. This requires a coordinator ruling and a scoped gate
fix for source-data parsing before a passing gauntlet and main push.

Native publication/CID readback remains intentionally deferred to the SSY node
refresh. Its executable path is retained in native-publication.mjs and the
E2E. Provider installation was not attempted. Marketing follow-up is filed
as `modules-lvdb-marketing-20261103` per repository landing rules.
