# Upstream provenance: Star broad-search (UzTak/star-search)

| | |
|---|---|
| Upstream | https://github.com/UzTak/star-search |
| Commit | `5c667064e8fc5816a94fc1124906997560fd6c55` (retrieved 2026-07-29) |
| License | MIT — Copyright (c) 2026 Yuji Takubo (`LICENSE`, verbatim) |
| Language | Python 3.10+ (`numpy`, `numba`, `spiceypy`, `scipy`), ~22.3 KLOC |
| Relationship | **PORT** — this module is a C++ re-expression of the algorithm |

## Vendor policy for this family: PORT, not verbatim copy

The sibling `codec/ccsds124-pocketplus` family vendors its upstream **verbatim**
because its acceptance criterion is byte-identity with a reference C
implementation, so re-expression would add divergence risk with no upside.

**This family is the opposite case.** The upstream is Python + `numba` + `numpy`
+ `spiceypy`; none of it cross-compiles to a single WASM translation unit, and
there is no C or C++ upstream to vendor. A port is therefore the only option,
and the licensing obligation is discharged by this file plus the verbatim
`LICENSE` next to it, plus the `attribution` block in `plugin-manifest.json`.

What IS preserved verbatim in `vendor/star-search/`:

- `LICENSE` — the upstream MIT text, unmodified.
- `NOTATION.md` — the upstream's own glossary of the paper's index vocabulary
  (`IE`/`IL`/`IF`, `dv_lev`, `eta_lev`, `tfilter`, "null leg", ...). Preserved
  because the port keeps upstream's names, so upstream's definitions remain the
  normative reference for reading the C++.

## Derived-from manifest (SHA-256 of every upstream source the port derives from)

Verified at commit `5c66706`. `scripts/verify-vendor.mjs` re-checks these
against a fresh clone; a mismatch means upstream moved and the port must be
re-reviewed against the new revision before any parity claim is renewed.

```
58b4ad33e7bc82b15f7d7d2f4079d5d9ac6a692ed0306bc4946ac7edde5c18a1  star/lambert.py
46800b2ff3ddacdf465614b528c0c16ee22cc487757730e0b2211f8f11420c47  star/encounter_database.py
9e81c5795fb6c867800fc276aac93bbfe8a5b7019d5e73a443eea5d4de453f29  star/leg_database.py
db98d4fe79b650911245bfc8de6d4c72092ad5321f19fcd48f0a5c8bc368909d  star/flyby_database.py
bb29ce7dbe68733e2361e90c4363f84716a71537855a1a3494540858a6d54624  star/combo.py
2b89a3f3f59502fd008e5f2945eb52fdcfeac58f1512632241f6d6a16b184b48  star/maneuver_placement.py
927dd58928d9f3d41ff87dacf924a652b8d010865634fbe5889a81504d4f8bab  star/resonant.py
2455aa2a171c4453787589a8df444e03672c846328a5997bcce4cf87e29baa1e  star/time_opt.py
ad882b274ab42de0d00e6fb9383d346173406bd4a5ae6998fcf55c517b3b8ce9  star/pipeline.py
54894cb349ce1aa08e109392fcb6836d56bed730e1a536bee6b53b7366cf6f12  star/constants/_get_gm.py
a2e958092fb011979058a66ac137a02d03608a6913ebab4f3be3fb03f99013b3  star/constants/_get_radii.py
ccf3e8d23226e95f2f2a13f1e57c6264c0ac7b96db6813292a650ae4978bbdf1  star/constants/_get_sma.py
d9befb1dcd48450f241d0ed42a020ed581cf580271c29d421e132c6f99a304b9  star/constants/time.py
1f2cd2d5658eaf1efd4b1e5dde2cc478de9dc3156bd4853f93935e43c2fe7769  star/constants/__init__.py
ac971e8a637971fb33890b32ea4a09128bb69759c1fe07592113ab7d31d6c6bf  LICENSE
```

## Algorithm attribution — the papers, which the upstream is itself an implementation of

The upstream README credits three separate published algorithms. The port
credits all three; the MIT notice above covers the *code*, these cover the
*method*.

1. **Landau, D., Campagnola, S., & Pellegrini, E. (2022).** "Star searches for
   patched-conic trajectories." *The Journal of the Astronautical Sciences*
   69(6), 1613-1648. https://doi.org/10.1007/s40295-022-00350-y
   — the broad-search logic (encounter discretization, pre-generated Lambert
   arcs patched by powered flyby, polynomial-time search).
2. **Landau, D. (2018).** "Efficient maneuver placement for automated trajectory
   design." *Journal of Guidance, Control, and Dynamics* 41(7), 1531-1541.
   — mid-arc deep-space-maneuver placement (primer-vector based).
3. **Arora, N. & Russell, R.P. (2013).** "A fast and robust multiple revolution
   Lambert algorithm using a cosine transformation." AAS/AIAA Astrodynamics
   Specialist Conference, AAS 13-728, Hilton Head, SC.
   — the Lambert solver. The port uses **this** formulation, not Izzo or
   Gooding: reproducing the reference Pareto set requires the same solver, since
   solver identity determines which arcs converge at grid edges.

The Star algorithm is originally due to **Damon Landau**. Upstream also
acknowledges Damon Landau, Stefano Campagnola, and Etienne Pellegrini for
discussions and cross-validation.

## Upstream's own disclaimer, carried forward

Upstream states that its codebase "is an independent re-implementation of the
method presented in [1]. Its performance may differ from, and potentially be
lower than, the results reported in the original paper."

That disclaimer propagates to this port with one addition: **this port's
fidelity target is the upstream Python implementation, not the original
paper.** Parity is measured against upstream's output. Any divergence between
upstream and Landau et al. (2022) is inherited, not corrected here.

## Reference vectors

The parity fixtures under `tests/vectors/` are **outputs of the upstream
program**, produced by running it unmodified. They are a derived work of an MIT
codebase and carry the same notice. The generation script and the exact SPICE
kernel set used are committed alongside them so the oracle is reproducible.
