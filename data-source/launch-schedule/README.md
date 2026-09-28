# Upcoming launch notices

SDK module that turns one page of a public launch registry
([Launch Library 2](https://ll.thespacedevs.com/2.3.0/), `launches/upcoming`,
`mode=normal`) into size-prefixed **LDM** records, one per launch. The module
makes no host calls: `plan_launches` emits the GET for the generic HTTP host,
and `parse_launches` validates the complete response before emitting anything,
so a bad page never replaces the previous notices.

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
`meta` output carries attribution for storage and publication. Only
`access: "anonymous"` is accepted. A keyed tier needs a credential adapter
first.

## Build and test

```sh
npm install
npm run build
npm test
```

The LDM header is generated from the pinned `spacedatastandards.org` schema
with flatc-wasm (`../../analysis/launch-cola/sds-header.mjs`).
`SPACE_DATA_STANDARDS_ROOT` overrides the standards root and says so. Tests
use a recorded slice of the real upstream response (2026-09-28), with one
launch per precision class.
