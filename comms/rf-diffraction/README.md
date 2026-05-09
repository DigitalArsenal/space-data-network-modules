# rf-diffraction

Knife-edge diffraction primitives per ITU-R P.526-15 §4.1
(Vogler approximation `J(v)`) plus Earth-curvature correction. Phase 4
Wave C of the RF audit.

## Exported kernels

| C entry | Purpose |
| --- | --- |
| `rf_curvature_drop_m(d, k)` | Earth-bulge drop `d²/(2·k·R_E)`; `k = 0` disables |
| `rf_fresnel_kirchhoff_v(h, d1, d2, λ)` | `v = h·√(2·(d1+d2)/(λ·d1·d2))` from explicit clearance |
| `rf_knife_edge_parameter_v(...)` | `v` from path-profile coordinates with Earth-curvature correction |
| `rf_knife_edge_loss_db(v)` | `J(v) ≈ 6.9 + 20·log10(√((v−0.1)²+1) + v − 0.1)` for `v > −0.78` |

The JS host orchestrates **multi-knife-edge Deygout recursion** by
recursively picking the dominant obstacle and calling these scalar
primitives — there is no numerical advantage to passing variable-length
obstacle arrays across the WASM boundary, and the host's recursion is
trivial.

## Authority

| Form | Authority |
| --- | --- |
| Knife-edge `J(v)` | ITU-R P.526-15 §4.1 Eq. (31), Vogler approximation |
| Single knife-edge geometry | ITU-R P.526-15 §4.2 |
| Multi-knife-edge Deygout | ITU-R P.526-15 §4.5.1 (host-side) |
| Earth-curvature 4/3-rule | ITU-R P.530-18 §2.1.2 |

## Status

Skeleton complete; build verification, fixture vectors (ITU-R P.526-15
Annex 1 worked examples are the target), and orbpro-integration
registration pending.
