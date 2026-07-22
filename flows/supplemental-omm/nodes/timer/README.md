# Supplemental OMM Timer Node

This independently signed WASM node owns the Supplemental OMM hourly UTC
schedule. The host exposes only `clock.now` and the application-blind
`wakeup.request` primitive. Cron/schedule calculation, coalescing after a
delayed wakeup, the correlation token, and tick emission remain in the node.

The optional control boundary is canonical SDS `$FSO`; emitted ticks use
canonical SDS `$FSB`. Both declare their real FlatBuffer and generated aligned
layouts. No local `.fbs` schema is owned here.
