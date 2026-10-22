# Acceptance status, 2026-10-22

Module SDK 0.9.9, SDS 1.258.0; one WASI sequential artifact. Build and flow
contract checks passed. The declared E2E independently compared all emitted
fields needed by FFM, including both 81-day observed-flux averages, against
live GFZ/NOAA source files: 43 days, including 2026-10-22. A corrupt GFZ input
was refused without records. These are source-module checks, not acceptance.

The native node booted in a new temp directory, signed the compiled flow,
approved its portable hash for HTTP and storage ingest before reboot, and
prewarmed AOT. It loaded the flow with `aot true` and fired `hourly`, but its
retrieval ledger reported:

> run completed but landed no batch; node(s) never ran: plan, fetch, parse, ingest, egress

The runtime source `sdn-server/internal/flowrt/cronmount.go:500-525` emits JSON
`{trigger,firedAt}` with no typed identity. The module's port expects the SDK
runtime `TimerTick.fbs` / `TICK`. No cron publication or CID readback passed.
No host code or guard was changed to evade this boundary. The generic host
must produce the typed cron contract before this task can complete.

Local evidence is in `tests/evidence-kYdLnJ/` (ignored; source files, receipt),
and `/var/folders/t7/fmn19zvs3h5968_nc0484bz00000gn/T/space-weather-node-qDqzgx/`
(node and AOT logs). The node process belongs to the E2E and is stopped by its
finally handler. No production node or owner node data was changed.
