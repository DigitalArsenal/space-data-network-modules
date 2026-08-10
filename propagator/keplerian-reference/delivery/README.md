# Delivering the reference propagator to an SDN node

`modules-catalog.entry.json` is this module's entry for a node's
`<storage>/modules/modules-catalog.json`. It is committed here because the
catalog is DATA — the node's `internal/pmm` package is explicit that it is a
connector, not an application, and that every policy decision (which module is
CORE, which is browsable, which is entitled) arrives as data rather than as Go
code. So the module ships the row it wants; the node operator decides whether
to admit it.

## Why these values

| Field | Value | Reason |
|---|---|---|
| `PLUGIN_TYPE` | `Propagator` | `pluginCategory` ordinal 1. **Never leave this empty** — ordinal 0 is `Sensor`, not "unknown", so an omitted type silently publishes a propagator as a sensor. |
| `ACCESS_POLICY` | `ANONYMOUS` | A reference implementation exists to be read and copied. Serving it without auth is the point. |
| `TRUST_TIER` | `OPTIONAL` | Deliberately not `CORE`. Only a CORE entry may load before a user session exists and only CORE is pre-selected at first sign-in; a two-body teaching propagator has no business in either position. |
| `DEFAULT_ENABLED` | `false` | Same reasoning. |
| `ARTIFACT_PATH` | plaintext `.wasm` | ANONYMOUS entries are served from a plaintext artifact path. This module is unencrypted on purpose — it is the one artifact whose source everyone is invited to read. |
| `CONTENT_HASH` | sha256 of the artifact | The node RECOMPUTES this from the bytes on disk and refuses a declared hash that disagrees. It is recorded here so a reviewer can check it without a node. |

`CONTENT_HASH` is `d6b7044766ad268aad407180abcc8ab5c47901e9ce177d2e20200e1d76c49645`,
which is the same digest the tri-runtime parity gate reported for the artifact
it exercised.

## Publishing

```bash
# 1. Assemble a plugin root: catalog.json plus the artifacts it names.
#    (For open, unencrypted modules the artifact is copied in as-is.)

# 2. Publish over libp2p from an admin HD-wallet identity.
spacedatanetwork -c <node config> plugins publish-orbpro \
  --plugin-root <root> \
  --module com.orbpro.keplerian.reference \
  --grant-policy open
```

## Status — read this before claiming it is live

**This module has NOT been published to a production node from this task.**

The publish verb requires a node config, an admin HD-wallet identity and a
reachable target peer. None of those were verified available in the session
that built this module, and a prod publish is a deploy-law operation: local
full-stack verify first, then full deploy plus live verification. Recording a
publish that did not happen is exactly the "pushed-but-unmerged is
indistinguishable from work that never happened" failure in reverse.

What IS verified here:

- the artifact builds reproducibly through the SDK compiler lane
- `parity-gate PASS` on all three real runtimes, `sha256=d6b7044766ad268a`
- 17/17 module tests, including the lifecycle leak test with its negative
  control
- the catalog row above is well-formed against `internal/pmm`'s `Entry` schema
  and its enum validation (`validTiers` / `validAccess` / `validStates` /
  `validPluginTypes`)

The remaining step is an operator action.
