# Supplemental OMM OD node

This independently signed WASM node consumes bounded FSB chunks containing
complete provider-native response bytes. It reassembles and verifies each
logical response, parses MEME, SP3, ECF, CPF, or CCSDS OEM KVN inside the node,
then passes canonical in-memory OEM records to the existing threaded OD core.

Outputs are canonical size-prefixed OMM, OCM, and OBD records wrapped in paired
canonical/aligned FSB record-stream ports. Native ephemerides never leave the
node as mislabeled OEM frames and are never persisted.

Every successful fit batch also emits one paired canonical/aligned FSO
`CONFIGURE_INDEX` control. It carries the recursively flattened canonical SDS
result IDL and exact `$OMM`/`$OCM`/`$OBD` table bindings, allowing the
independent FlatSQL node to configure and append the batch atomically.

## SGP4-XP beside SGP4

Every ephemeris is also fitted with SGP4-XP, the US Space Force's perturbation model with a fitted ballistic term
(BTERM) and solar-radiation term (AGOM). A window is a day to fit (two thirds of an ephemeris shorter than a day and a
half) and up to a day after it to score the fit; the next window starts where the last fit ended, while the ephemeris
lasts. An ephemeris too short to hold a fit and three hours to score it gets no XP set. The OD core's sets are
unchanged either way.

Each window is one `$OMM` (MEAN_ELEMENT_THEORY SGP4XP, BTERM in BSTAR, AGOM in MEAN_MOTION_DDOT; epoch the first state of
the fit) and one `$OBD`, appended to the `omm` and `obd` record streams the OD core's records go in, and each names its
source:

| Provider | ORIGINATOR | Axes, time |
| --- | --- | --- |
| `starlink` | SpaceX | EME2000, UTC |
| `glonass` | CODE (Astronomical Institute, University of Bern) | Earth-fixed, GPS time, positions |
| `intelsat` | Intelsat | Earth-fixed, UTC, positions |
| `cpf` | ILRS (EDC, DGFI-TUM) | Earth-fixed or EME2000, UTC, positions |
| `iss` | NASA/JSC/FOD/TOPO | EME2000, UTC |

The OMM's COMMENT holds `SOURCE <provider node plugin ID>`, the fit interval and the fit and held-out statistics (N,
RMS, maximum and radial, along-track and cross-track RMS, km, in TEME); the OBD's sensor is the provider node. A set
whose NORAD number the source does not give has 99999, as the core's. When XP sets were made the object's completion
status says how many (`OD fit complete: ISS (NORAD 25544); SGP4-XP: 14 sets`).

The engine is [`propagator/sgp4-xp`](../../../../propagator/sgp4-xp/README.md)'s: its sources compile as one object
with no SDS record in it (this node's SDS pin is not that module's), and the Space Force Sgp4Prop build is joined to
the linked node in WebAssembly by `wasm-merge` (`build.mjs`, `propagator/sgp4-xp/join-ussf.mjs`): the node's memory
stays memory 0, the library's becomes memory 1, and the node imports what it imported before. The node's set for an
ephemeris is that module's set for the same states. Earth-fixed positions are rotated with UT1 = UTC and the mean pole,
as the OD core does, so a source's two sets stand on the same axes.

The Space Force library is distributed under its [Agreement](../../../../propagator/sgp4-xp/third_party/ussf-sgp4/AGREEMENT.txt),
which travels with the node as the custom section `ussf-sgp4-notice`; the US Space Force does not endorse this node.

`SUPPLEMENTAL_OD_VERIFY_OUT=<dir> node build.mjs` writes a development-signed node to `<dir>` and changes nothing in the
tree; `tests/od-node-sgp4-xp.test.mjs` builds the node that way.

