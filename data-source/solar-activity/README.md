# Solar activity source qualification

Task: `solar-activity-data-sources-20261022`; owner lane: `codex-solar`.

**Blocked on SDS schema approval. This directory is not a completed module.**
It contains source qualification evidence and a proposed contract for the SDS
oracle. No schema, manifest, compiled artifact, or publication record is invented
here. See [REPORT.md](REPORT.md).

The intended implementation follows `../eop-request` and `../eop-parser`: typed
request construction and parsing in C++/WASM, with HTTP, scheduling, storage,
and publication owned by the host. The closed Helioviewer provider supplies the
endpoint-planning pattern, but its `HELIOVIEWER_*` JavaScript labels are not SDS
record identifiers. Its default source IDs 14 and 4 are not the requested channels.

Source qualification scripts under `tests/` are test-only: they inspect public
source data, never compute production solar geometry or emit SDS records.

```sh
node --test data-source/solar-activity/tests/*.test.mjs
node data-source/solar-activity/tests/source-evidence.mjs
node data-source/solar-activity/tests/solar-activity.e2e.mjs
```

Run from the repository root. The first command verifies retained primary-source
evidence offline. The second captures new live source evidence. The third is the
task's acceptance entry point: it currently captures evidence and exits **2** for
the unresolved schema/publication gate; source checks alone are not an E2E pass.

`node data-source/solar-activity/tests/image-freshness.mjs` diagnoses delivery
latency separately: it compares the current 15-minute slot with a fixed
three-hour backfill slot, retains full JP2/header evidence and the published
cadence reference, and probes JSOC availability. A source-only exit 0 never
means module acceptance. The 2026-10-22 capture has 0/4 current-slot cadence
matches and 4/4 backfill matches. Docker parity is waived by the owner;
browser and native WasmEdge parity remain gated on the approved SDK artifact.

`tests/source-cid-roundtrip.mjs` checks the raw source files against a real
native SDN node, using `SDN_NODE_BINARY` and `SOLAR_NODE_WORK` (a durable,
lane-owned directory). The 2026-10-22 run read back 44/44 files exactly and
stopped its node. This is source transport evidence; typed-record publication
and signed announcements remain gated on SDS approval.
