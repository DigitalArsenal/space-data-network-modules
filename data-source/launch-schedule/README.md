# Upcoming launch notices

SDK module that turns one page of a public launch registry
([Launch Library 2](https://ll.thespacedevs.com/2.3.0/), `launches/upcoming`,
`mode=normal`) into size-prefixed **LDM** records, one per launch. It speaks the
typed contracts (1.0) only: every port names one FlatBuffer type and nothing
between modules is JSON (the registry body is the one JSON document, parsed in
the core).

- `plan_launches` takes a `TimerTick`, reads node CONFIG through the builtin
  `plugin.getConfig` hostcall (an SDS `$PIV` invocation answering one `ModuleConfig`;
  paths `launch_schedule_source.access`, `launch_schedule_source.limit`,
  `launch_schedule_producer_peer_id`) and emits one `HttpRequest` whose
  `CONTEXT` is the plan: one size-prefixed `IngestRequest` (schema, provider
  `launch-schedule`, source `upcoming`, the canonical URL, the producer peer id,
  terms URL and citation, reconcile Current).
- `parse_launches` takes the `HttpResponse` (the plan echoed in `CONTEXT`,
  `RETRIEVED_MS` the host's retrieval time), requires the plan to be canonical
  for its URL, validates the complete response before emitting anything (so a
  bad page never replaces the previous notices) and emits the `$LDM` stream,
  one `IngestRequest` for `hostcap/storage-ingest` and one `FlowNotice` report
  (Info: records, retrieval time, `registry-count:<n>`,
  `skipped-imprecise:<launch id>`). It makes no host call.
- The host adapter (`host-adapter/`) gates scheduling on node CONFIG
  (`launch_schedule_enabled`; the `TimerTick` forwarded, or a `FlowNotice`
  Skipped) and turns a 304 into a `FlowNotice` Unchanged.

| Registry field | LDM |
| --- | --- |
| `id` | `ID` (SDS 1.227.0) |
| `net`, `window_start`, `window_end` | `NET`, `EARLIEST_LAUNCH_TIMES[0]`, `LATEST_LAUNCH_TIMES[0]` |
| `status.name` | `LAUNCH_STATUS` |
| `launch_service_provider.name` | `AGENCY_NAME` |
| `rocket.configuration` | `ROCKET_CONFIGURATION` (`NAME`, `FAMILY`, `VARIANT`) |
| `mission` | `MISSION_NAME`, `MISSION_DESCRIPTION`, `MISSION_TYPE`, `ORBIT_TYPE`, `WEBCAST_URL` |
| `pad` | `SITE` (`ID`, `NAME`, `DESCRIPTION`, `LATITUDE`, `LONGITUDE`) |
| `url` | `REFERENCES` |

## NET precision

The registry states how precisely each NET is known. For calendar precisions
it places NET at the end of the period (a July launch reads "July 31"). The
notice carries the whole period instead:

- NET and the earliest time at the period start;
- the latest time at the period's last second.

Hour, day, month, quarter, half-year and year are supported. Second and
minute precision keep the published window. Any other precision (for example
decade) skips that launch and counts it in the report.

## Access

Anonymous access allows 15 requests per hour; plan one pull per hour. The
`meta` output (an `IngestRequest`) carries attribution for storage and
publication. Only `access: "anonymous"` is accepted. A keyed tier needs a credential adapter
first.

## Build and test

```sh
npm install
npm run build
npm test
```

Tests (`node --test tests/*.test.mjs`) run both artifacts through the SDK
harness with the typed hostcall, including the adapter -> plan -> HTTP ->
receipt -> parse chain. A stack flow composing these modules must wire the typed
ports (no job, config or receipt frames remain).

The LDM header is generated from the pinned `spacedatastandards.org` schema
with flatc-wasm (`../../analysis/launch-cola/sds-header.mjs`).
`SPACE_DATA_STANDARDS_ROOT` overrides the standards root and says so. Tests
use a recorded slice of the real upstream response (2026-09-28), with one
launch per precision class.
