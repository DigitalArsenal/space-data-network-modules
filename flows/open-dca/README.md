# Open density calibration provider

Implementation in progress; no production acceptance is claimed.

The node retrieves Planet's public daily orbit-determination states for local
processing. The states and per-satellite arc fits are never published. The
published product is the fleet's aggregate common-mode log-density correction
against NRLMSISE-00, using E13's frozen method and settings.

SDS 1.259.0 carries the result in `$DCL`:
`CORRECTION.FORM = LogDensityNodes`, `NODE_TIMES_MS` in UTC milliseconds,
`NODE_LOG_DENSITY_SCALE_DIMENSIONLESS`, and `PROVENANCE`. Drag density is
NRLMSISE-00 multiplied by `exp(s(t))`; interpolate s linearly between nodes,
hold the endpoints outside, and do not apply another forecast decay. The
producer includes forecast nodes using E13's 48-hour time constant.

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
