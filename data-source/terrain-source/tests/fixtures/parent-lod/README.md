# Native parent fixtures

These small, synthetic `$DTT` streams are emitted by the existing native
`tile` method. They are not real coastal terrain or publication inputs.

Run `node tests/fixtures/parent-lod/generate.mjs` from `terrain-source` after
its normal SDK build. `inputs.json` records each resulting stream's hash.
The analytic case uses a known height plane and a north-water/south-land
classification; the ocean case records native HTTP-404 source observations.
The missing-child case removes one complete record from the analytic input.

`parent-lod.test.mjs` independently checks the analytic heights, mask
orientation and coverage, inherited error bound, sibling lineage, shared
edges, invalid inputs, and exact permutation determinism. It also compares
the shipped and bridge-free diagnostic artifacts on these frozen inputs.

`parity.json` uses the SDK's normal command fixture protocol. All three cases
exit WASI successfully: missing children produce a **PIV status 400** with
`invalid-parent-children` and no outputs, not a failed WASI process. The
behavioral test verifies that refusal explicitly; equal process exits alone
do not prove it.

The bridge-free artifact is only a diagnostic. Acceptance requires the same
shipped artifact in a real browser and native/container WasmEdge hosts that
register its existing host imports. Real-source coastal validation and
native shallow-tile visibility checks are separate requirements.
