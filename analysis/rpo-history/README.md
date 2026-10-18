# RPO history

Rendezvous and proximity operations (RPO) characterization for any chaser and
target, from their element-set history. C++ compiled to WASM; no propagator
inside (the propagator is a pluggable port); SDS records at every boundary.

## `characterize`

| Port | Direction | Content |
| --- | --- | --- |
| `element_sets` | in | `$OMM` sets of the chaser and the target (`rpo.chaser`, `rpo.target`) |
| `propagation` | in | Answers to `propagation_requests`: one `$OEM` block per query, in order |
| `maneuvers` | in | `$MNV` from `analysis/maneuver-detection` (optional): the brackets |
| `error_model` | in | One `$ERM` model from `analysis/gp-error-model` (optional): the bands |
| `propagation_requests` | out | First pass: one `$PRW` `WINDOW_REQUEST`, one query per element set |
| `relative` | out | `$OCM` per segment: the chaser about the target, CCSDS RTN |
| `geometry` | out | `$OCM` per segment, extended type `RPO_GEOMETRY`: the derived series |
| `realism` | out | `$CVR`: the hindcast of the projection bands |

The first call, without answers, asks for each set's trajectory on a grid of
`step_seconds` (whole multiples since 1970-01-01 UTC). The host routes the
queries to any propagator: `analysis/epoch-state answer_propagation_requests`
(SGP4), FFM, or another provider. The second call, with the answers, makes the
records. Both objects' answers must be in the same axes (inertial, or
Earth-fixed and turned to TEME).

### Series

At each grid time, each object's state comes from **its** element set in force
(the latest epoch at or before that time). Nothing is interpolated or smoothed
across an element update. A segment, one record, is a run of samples with the
same pair of sets.

The geometry is the RIC box's (OrbPro `OrbitalState.cpp`, through the shared
`foundation/frames/include/rtn_curvilinear.hpp`):

- **RTN:** CCSDS RTN of the target from its inertial r and v.
- **Rectilinear RIC:** the chaser's offset in those axes. The velocity is as
  seen in the rotating frame.
- **Curvilinear RIC:**
  - R = |p| − r0;
  - I = r0·atan2(y, r0 + x), wrapped to ±π r0, and unwrapped within a segment;
  - C = r0·atan2(z, hypot(r0 + x, y)).
- **Separation and range rate.**
- **Orbital-plane angle:** between the two orbit normals.
- **Relative orbital elements:** D'Amico (2010), quasi-nonsingular, chief = the
  target, from osculating two-body elements.

### Maneuver brackets

A detected maneuver brackets its object's element sets around it, as the
`$MNV`'s `SOURCED_DATA` names them. Samples inside a bracket are left out:
shown, not propagated through. In `relative`, each bracket is an OCM
`MANEUVER_DATA` entry (`DETERMINED`) on the record after it.

A set issued within `settle_days` after a bracket is **settling**: its orbit
fit still spans observations from before the burn.

### Conditional coast projection

The newest set of each object at `stop` is held fixed for `projection_hours`.
It assumes no maneuvers after `stop`.

- **Model bands.** Each object's GP error-model covariance (6×6 RTN, by
  regime and age) is carried through the Jacobian of the geometry with
  respect to both states. A target error moves the frame's origin and axes.
- **Calibration.** At any time t, the bands are the model's times per-axis
  factors. The factors come from the pair's own predictions against the next
  element sets in the trailing `calibration_days`, before t:
  - 1 σ: the 68.27 % quantile of |error| / model σ;
  - 3 σ: a third of the 99.73 % quantile.
- **Hindcast.** It replays that over [start, stop) and counts the shares
  inside the bands, and d² against χ²(3). Predictions that span a bracket or
  involve a settling set are left out. A projection that starts from a
  settling set is flagged.
- **`$CVR` verdict.** It follows the CVR rule, which needs three objects. A
  single pair stays `Uncalibrated` whatever its shares.

### Options (`rpo.*`)

`chaser`, `target` (required), `start`, `stop`, `step_seconds` (60),
`projection_hours` (24), `hindcast`, `calibration_days` (14), `settle_days`
(1), `propagator_port_id`, `creation_date`.

## Build and E2E

```sh
npm ci && npm run build
node tests/cosmos2612-iceye-x36.e2e.mjs
```

The E2E reads the SDN GP archive (`SDN_GP_ARCHIVE`, the Space-Track
`gp_history` by-creation files) at run time. It runs maneuver detection and
this module through `analysis/epoch-state` for Cosmos 2612 / ICEYE-X36,
2026-09-28 – 10-17 12:00 UTC. It checks:

- the frames against the RIC box's case;
- the relative orbital elements against two-body pairs and the linear map;
- the series against Orbital Engineering Lab's published figures;
- the brackets against OEL's amber spans;
- the hindcast.

Space-Track element sets are never written to the repository. The figures
and evidence go to `tests/out/`, which git ignores.
