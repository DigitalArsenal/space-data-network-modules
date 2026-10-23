# Sea state

Work in progress for `sea-state-wasm-20261022`.

This package moves the console's wind-to-sea-state calculation into an SDK
C++/WASM module with one `dist/isomorphic/module.wasm` artifact for browser and
native WasmEdge. Docker verification is waived by the owner (2026-10-22).

The existing console identifies the relation as Pierson–Moskowitz (1964),
DOI https://doi.org/10.1029/JZ069i024p05181. Its use of 10 m wind with the
original wind-height convention needs correction; source verification is in
progress. Engine clamps, marine overrides, bearing normalization, and the
empirical rendering chop mapping will remain within the module.

The UI worktree is read-only in this lane. Console wiring, its no-JS-physics
gate, and actual console pixel comparison belong to the Claude lane. This
module's tests will measure numerical agreement and explicitly report the
source correction rather than claim an unmeasured pixel result.

Checkpoint (2026-10-23): read the lane handoff, task, ocean study, console
implementation/tests, stack design principles, and canonical SDK contract.
The module will separate the numerical sea-state kernel, binary PCE adapter,
and SDK build/runtime verification. Primary-source verification precedes
choosing the wind-height conversion and fetch/duration equations.
