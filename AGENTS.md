# Space Data Network Modules Agent Rules

## Upstream Authority

The canonical module contract lives in
[`../space-data-module-sdk/AGENTS.md`](../space-data-module-sdk/AGENTS.md).
The canonical schemas live in
[`../spacedatastandards.org/schema`](../spacedatastandards.org/schema).

If a manifest, invoke, artifact, host capability, or schema rule here disagrees
with the SDK or SDS, the upstream repo wins.

## Module Rules

- Build every package as an SDK-compliant SDN module.
- Use `dist/isomorphic/module.wasm` as the primary artifact.
- Embed a standards-backed `PLG` manifest.
- Use SDS `PIV` request/response envelopes and `TAB` payload frames.
- Do not add repo-local durable `.fbs` schemas. Add or update SDS first.
- Use XTCE through SDS `XTC` for telemetry/command dictionaries.
- Include FlatBuffer fallback for any aligned-binary port.
- Fail closed for missing kernels, tables, models, schemas, or host
  capabilities.

## Authoritative Tests Are Required

Do not mark a module complete unless it has authoritative tests based on public
standards examples, published numerical values, upstream Basilisk expected
values, or closed-form physics cases with independently calculated results.

Every numerical test must state:

- source of expected value;
- units;
- reference frame;
- epoch or time scale;
- tolerance and rationale.

Golden outputs generated only by the new module do not count.

## Required Verification

For each module package:

```sh
bash build.sh
node --test tests/*.test.mjs
SPACE_DATA_MODULE_SDK_ROOT=../../space-data-module-sdk ../../scripts/test-sdk-compat.sh <family>/<package>
```

Also verify browser harness loading and WasmEdge invocation for the same
`dist/isomorphic/module.wasm` artifact.

For Basilisk-wide planning or standards-map changes:

```sh
npm run generate:basilisk-plan
npm run check:basilisk-plan
```

## Basilisk Work

Basilisk-derived modules must keep `../basilisk` as the upstream source of truth
and may not copy Basilisk source wholesale into this repo. Prefer thin wrappers,
build integration, manifests, standards mappings, authoritative fixtures, and
SDK compatibility tests here.
