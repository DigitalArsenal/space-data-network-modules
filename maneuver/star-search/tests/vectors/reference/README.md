# Reference vectors — the parity oracle

These are **outputs of the upstream Python program, run unmodified**. They are a
derived work of an MIT codebase (see `../../../vendor/star-search/PROVENANCE.md`)
and carry the same notice.

## Why these are a valid oracle

Both problems reproduce the row counts upstream publishes in its own README's
"Reference runtimes" table, on this machine, with the kernels pinned below:

| problem | upstream README says | this run produced |
| --- | ---: | ---: |
| `test2_EMEJ` | 33 trajectories (post-tfilter) | **33** |
| `test1_DVEGA` | 5,952 trajectories (post-tfilter) | **5,952** |

An oracle that did not reproduce upstream's published numbers would not be worth
diffing against. These do.

## Files

| file | what |
| --- | --- |
| `test2_EMEJ.jsonl` | **Phase 1 oracle, committed in full** (33 rows, 26 KB). Ballistic Earth-Mars-Earth-Jupiter, no DSM — exactly the Phase 1 scope. |
| `test2_EMEJ.summary.json` | Counts, full-file SHA-256, delta-V/TOF extrema, first and last row. |
| `test1_DVEGA.summary.json` | **Phase 2 oracle.** The full JSONL is 3.9 MB (5,952 rows) and is NOT committed — regenerate it with the script below and check it against `sha256_full_jsonl`. DVEGA exercises the DSM-leveraging path that `test2_EMEJ` does not. |

## Stage-level intermediates for `test2_EMEJ`

These localize a port bug far faster than the final rows, so match them in order
before comparing delta-Vs:

```
EncounterDB entries: 6227
  leg 0: 114294 rows
  leg 1: 301979 rows
  flyby 1: 20111 entries
  leg 2: 52289 rows
  flyby 2: 90 entries
Final filter convergence: pass 1 removed=0, fixpoint in 1 pass
Combo: flyby stage 1 -> 10 candidates; flyby stage 2 -> 90 candidates
num_final_trajectories = 90
TFilter: num_in=90, num_valid=90, num_bins=33, num_out=33, num_skipped_invalid=0
```

## Row schema

```
traj_id, t_et_s[nE], body_ids[nE], vinfD_km_s[nL][3], vinfA_km_s[nL][3],
dv_lev_km_s[nL], eta_lev[nL], dv_patch_km_s[nF], leg_ils[nL], flyby_ifs[nF],
dv_total_km_s, tof_total_days, dv_escape_km_s, dv_insertion_km_s
```

`nE` = encounters, `nL = nE-1` legs, `nF` = interior flybys. Times are **ET
seconds past J2000** (what SPICE `str2et` returns). See
`../../../vendor/star-search/NOTATION.md` for `IL`/`IF`/`dv_lev`/`eta_lev`.

## Parity criterion

- identical solution count;
- identical `body_ids` and `t_et_s` — these are exact grid points, so any
  deviation is a grid or TOF-bound bug, not a numerical one;
- identical `leg_ils` / `flyby_ifs` index sets;
- delta-V quantities to tight numerical tolerance — **report the measured
  maximum deviation, never assert an unmeasured tolerance**;
- and all of the above **identical at 1 thread and at N threads**.

## Regenerating

```sh
sh generate-reference.sh /path/to/output/dir
```

Requires the upstream clone, `uv`, and the exact NAIF kernels below. The script
pins the upstream commit and verifies kernel hashes before running, because a
different DE ephemeris changes every number in these files.

## Pinned SPICE kernels

Upstream calls only `furnsh`, `str2et`, `spkezr`; GM and radii come from tables
in `star/constants/`, never from a PCK. `de440s.bsp` (short-span, 1550-2650) is
used instead of the full `de440.bsp`: the test problems' epochs fall well inside
that span, and it is 33 MB instead of 114 MB. Mars (499) and Jupiter (599) are
addressed by their own NAIF IDs, so the satellite SPKs are required — the
planetary barycenters in DE are not the same bodies.

```
678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b         5257  lsk/naif0012.tls
c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2     32726016  spk/planets/de440s.bsp
9991e57b196bae1a096acc6e2afc6718102ee420d684695de0f0333064c046bc   1227574272  spk/satellites/mar099.bsp
dbf016c01ba4d022154838000cf3f06962cf958ddc503a366f7fe8f81495c5cb   1136581632  spk/satellites/jup365.bsp
```

Mirror: <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/>
