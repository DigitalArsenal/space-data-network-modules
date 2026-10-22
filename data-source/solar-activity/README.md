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
node --test data-source/solar-activity/tests/evidence.test.mjs
node data-source/solar-activity/tests/source-evidence.mjs
node data-source/solar-activity/tests/solar-activity.e2e.mjs
```

Run from the repository root. The first command verifies retained primary-source
evidence offline. The second captures new live source evidence. The third is the
task's acceptance entry point: it currently captures evidence and exits **2** for
the unresolved schema/publication gate; source checks alone are not an E2E pass.
