# Open density calibration provider

Local scheduled-node verification is described below. Production acceptance
requires the owner's rollout and independent SDN live check.

The node retrieves Planet's public daily orbit-determination states for local
processing. The states and per-satellite arc fits are never published. The
published product is the fleet's aggregate common-mode log-density correction
against NRLMSISE-00, using E13's frozen solver.

SDS 1.259.0 carries the result in `$DCL`:
`CORRECTION.FORM = LogDensityNodes`, `NODE_TIMES_MS` in UTC milliseconds,
`NODE_LOG_DENSITY_SCALE_DIMENSIONLESS`, and `PROVENANCE`. Drag density is
NRLMSISE-00 multiplied by `exp(s(t))`; interpolate s linearly between nodes,
hold the endpoints outside, and apply no decay. The producer holds the last
solved value through a final node 48 hours after the last solve epoch.

A run reads what was public at its issue time: the file of the issue's own UTC
day and the 31 before it, each by its own `Last-Modified`, with a 403 or 404
meaning not published yet. No hour of day is assumed. The timer's phase decides
what this gains: a run shortly after the day's last file gains that file, and at
other hours the rule selects what the flat rule it replaced selected, so it is
inert live until the phase is set. The phase comes from the node's retrieval
ledger, and setting it is the owner's rollout step
(`deployment/space-weather-provider-node`).

`open_dca_lag_hours`, `open_dca_noise_sigma` and `open_dca_shrink_window_hours`
in the flow's config set the method parameters, off by default, and
`PROVENANCE.LINEAGE` states them by value.

Reference: orbit-accuracy-experiments `experiments/e13-open-dca`, including
PLAN amendments S3/R1/R2, `steps/74-planet-live-arcs.mjs`, and
`results/e13/selection.json`: 24-hour nodes, random-walk baseline sigma
0.005, smoothing sigma 0.05, Huber threshold 1.5. All physics and the fit run
in WASM. The publication uses the licensed GFZ/NOAA space-weather drivers.

Planet states are CC BY-NC 4.0 and stay local. GFZ F10.7/Kp/ap/Ap are CC BY
4.0; NOAA SWPC products are public domain. Never publish SET indices,
CSSI/CelesTrak space-weather files, sunspot numbers, or raw operator states.

Acceptance requires headless-browser/native WasmEdge parity, an independent
offline E13-method comparison on identical inputs, and a signed scheduled
scratch-node publication read back by CID. Docker is waived by owner ruling
2026-10-22. Owner installation will share `deployment/space-weather-provider-node`.

## Local verification, 2026-10-22/23

The EH-free module and composed flow pass native WasmEdge 0.16.4 AOT.
The method's 742 archived E13 arcs give maximum common-mode error
`6.94e-18`, with headless-browser/native byte parity. The complete independent
energy comparison on 29 current operator series gives 363 accepted arcs,
exact ballistic coefficients and maximum relative uncertainty difference
`8.38e-12` (required below `1e-9`). Pair identities and the complete inclusive
20–28-hour selection are checked; UTC milliseconds avoid floating-point MJD
subtraction dropping exactly 20-hour arcs.

The signed, prewarmed scratch node's daily timer published one aggregate on
2026-10-22 at 23:55:56Z. A separate SDN client read its manifest and shard by
CID. All 78 correction nodes agree with the offline E13 solve on the same
source files (344 causal accepted arcs), maximum log-density difference
`9.55e-14` (required below `2e-9`). Both lane configurations come from the
actual owner installer merger; the weather lane also published 43 rows.
Raw operator states and per-object estimates are absent from the publication.

Run `node flows/open-dca/tests/open-dca.e2e.mjs` with the private capture,
rebuilt local SDN binary/client, frozen E13 checkout and foundation artifacts
named by its environment variables. The replay must be under 24 hours old,
answer every URL in the current request window as the source did, a 403 for
a day not yet published included, and produce a correction during this
scheduled run. The independent reference cache is bound to the
module bytes and every typed input; captures and private derived fits stay
outside the repository. No IERS/USNO fetch is needed for this local replay.
