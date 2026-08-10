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

## Publishing — the recipe below this line was WRONG, and here is the right one

The first version of this file said to publish with `plugins publish-orbpro
--grant-policy open`. That verb cannot publish this module, and it never could:

- `buildModulePublishRequestFromPluginRoot` refuses an entry that is not
  encrypted (`catalog entry %q is not encrypted`); the wire struct carries only
  `EncryptedBundle` + `KeyMaterial`. This module is plaintext ON PURPOSE — it is
  the one artifact everyone is invited to read.
- that lane writes into the licensing plugin registry at
  `<storage>/license/plugins`. It never touches `modules-catalog.json` and never
  creates a `/modules/<id>/<version>/module.wasm` path, so nothing it publishes
  is reachable by an anonymous browser.

The lane that serves an ANONYMOUS plaintext wasm to a cold browser is the $PMM
lane, and it has **no CLI verb and no HTTP endpoint**. It is deployed DATA:
the artifact on disk plus a row in the catalog the node reads. That is not an
oversight — `internal/pmm` is explicit that it is a connector and that every
policy decision arrives as data.

```bash
SHA=d6b7044766ad268aad407180abcc8ab5c47901e9ce177d2e20200e1d76c49645
ROOT=/opt/data/sdn-module-delivery/modules      # <storage.path>/modules

# 1. the artifact, content-addressed (the convention every other row uses)
scp dist/isomorphic/module.wasm "$HOST:$ROOT/artifacts/$SHA.wasm"
ssh "$HOST" "chown sdn:sdn $ROOT/artifacts/$SHA.wasm && chmod 0644 $ROOT/artifacts/$SHA.wasm"

# 2. the row: append modules-catalog.entry.json to entries[], and a browse hint
#    to browse[]. Back up first; write atomically (install + mv), never in place.

# 3. nothing else. pmmRefreshInterval is 6 h and rebuild() re-reads the catalog
#    and re-hashes every artifact from disk, so a staged row goes live with NO
#    daemon restart.
```

**Validate before you write.** `pmmPlugin.Start` fails CLOSED: a catalog it
cannot load means `RegisterRoutes` mounts nothing and the ENTIRE
`/.well-known/sdn/modules.pmm` + `/modules/` surface 404s until someone
notices. On host-01 that daemon also terminates TLS on :443. Run the daemon's
own code over your candidate file rather than eyeballing it — a temporary test
in `internal/pmm` calling `LoadCatalog` + `Manifest.Validate()` + `HashArtifact`
takes two minutes and is the difference between a data edit and an outage.

## Status — PUBLISHED AND LIVE 2026-08-10

Published to `sdn.spaceaware.io` (host-01) by the wave-1 closeout lane.
Staged **04:36Z** under `/run/sdn-deploy.lock` holder `w1-closeout` (released
after staging, ledgered in `/var/log/sdn-deploy-lock.ledger`); **live 06:13Z**,
on the plugin's own 6-hourly rebuild. **No daemon roll.** The 95-minute wait was
the point: this box terminates TLS on :443 itself and `pmmPlugin.Start` fails
CLOSED on a bad catalog, so restarting to save an hour and a half would have
risked the whole storefront for a change the lane applies by itself.

Evidence, measured against the public origin.

**The signed manifest** — `GET /.well-known/sdn/modules.pmm`, `Accept:
application/json`: **67 -> 68 MODULES**, ed25519 signature present,
`PROVIDER_DOMAIN sdn.spaceaware.io`. The entry reads back exactly as declared:

```
VERSION 1.0.0 · PLUGIN_TYPE Propagator · ACCESS_POLICY ANONYMOUS
TRUST_TIER OPTIONAL · DEFAULT_ENABLED false · ENTRY_STATE ACTIVE
RUNTIME_TARGETS [browser, wasmedge] · LICENSE MIT
CONTENT_HASH d6b7044766ad268aad407180abcc8ab5c47901e9ce177d2e20200e1d76c49645
ARTIFACT_SIZE_BYTES 82923
ARTIFACT_PATH /modules/com.orbpro.keplerian.reference/1.0.0/module.wasm
```

**The artifact** — 404 before, after:

```
HTTP/2 200 · content-type: application/wasm · x-content-type-options: nosniff
access-control-allow-origin: * · cache-control: public, max-age=31536000, immutable
etag: "d6b7044766ad268aad407180abcc8ab5c47901e9ce177d2e20200e1d76c49645"
```

**Cold load in a real browser, first attempt.** A fresh Playwright context with
no cache and no storage, from a DIFFERENT origin, given nothing but the provider
domain: it read the manifest, took `ARTIFACT_PATH` from the signed record,
fetched the bytes cross-origin, hashed them with SubtleCrypto and compiled them.

```
byteLength 82923 · sha256 d6b7044766ad268a…c49645 (== declared) · wasm magic ok
imports  [wasi_snapshot_preview1]        <- pure WASI, no host-specific shim
exports  plugin_init, plugin_init_omm, plugin_ingest_omm_one, plugin_propagate,
         plugin_propagate_batch, plugin_entity_count, plugin_destroy,
         plugin_alloc, plugin_free, plugin_invoke_stream,
         plugin_get_manifest_flatbuffer(_size)
```

**The demo, installing from this node.** `gallery/keplerian-reference-propagator`
(OrbPro `07e914025a`) now resolves the artifact from the live `$PMM` manifest
instead of a repo-relative copy, and publishes where the bytes came from:

```
deliveredFromProvider  true
deliveredArtifactUrl   https://sdn.spaceaware.io/modules/com.orbpro.keplerian.reference/1.0.0/module.wasm
deliveredContentHash   d6b7044766ad268a…c49645
referenceFrameValue    3 (ECEF)      validStateVectors 25/25
reference (KEPLER)     831127.46 m   period 101.409 min
baseline  (SGP4)       417058.46 m   period  93.003 min
```

and the port is real, not a label — forcing the reference lane onto SGP4 moves
its altitude to **826133.57 m**, a ~5 km two-body-vs-SGP4 difference on the same
element set.

Pre-write validation, against the daemon's own code rather than by inspection:
`pmm.LoadCatalog` + `Manifest.Validate()` over all 68 entries PASS, and
`pmm.HashArtifact` — which strips the publication trailer and hashes the
PORTABLE bytes — returned exactly the declared digest at exactly 82,923 bytes.

Unchanged from before this task, and still true:

- the artifact builds reproducibly through the SDK compiler lane
- `parity-gate PASS` on all three real runtimes, `sha256=d6b7044766ad268a`
- 17/17 module tests, including the lifecycle leak test with its negative
  control

`TRUST_TIER: OPTIONAL` is deliberately unusual here — every other OPTIONAL row
on this node is ENTITLED. It means the module is anonymous and readable but
never pre-selected at first sign-in, which is the correct position for a
two-body teaching propagator.
