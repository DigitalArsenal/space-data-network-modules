# Supplemental OMM isomorphic flow

This package is the zero-Go source of the Supplemental OMM application.
`flow.json` composes ten independently signed isomorphic WASM nodes: timer
policy, five complete native-data providers, orbit determination, FlatSQL,
publication, and status. The exact same signed child artifacts are embedded in
the browser/WasmEdge flow bundle at `dist/isomorphic/module.wasm`.

Production release artifacts use WasmEdge universal AOT custom sections built
with optimization and interruptibility using
`scripts/compile-universal-aot.sh`. Its `parent` profile omits statistics
instrumentation because the flow host has no WasmEdge statistics context; its
`child` profile enables gas measurement because child hosts enforce cost
limits. Browsers ignore the AOT custom section and execute the portable WASM in
the same signed file; WasmEdge executes its native payload. The artifact
contract rejects a release unless the outer runtime and every exact signed
child are browser-valid, contain one nonempty universal-AOT section, and retain
these host-compatible profiles.

The timer node owns hourly policy and asks hosts only for a clock reading and a
generic wakeup. Its typed tick fans out to the five provider nodes. Providers
fetch complete provider-native responses and emit bounded paired canonical or
aligned FSB chunks. Canonical FSB remains the durable and cross-runtime
fallback. The OD node reassembles and validates the complete response, parses
MEME, SP3, ECF, CPF, or CCSDS OEM KVN internally, fits the complete arc, and
emits multiple epoch-specific OMM, OCM, and OBD record streams.

Each successful fit batch also emits an idempotent FlatSQL `CONFIGURE_INDEX`
control containing the complete canonical result schema and the `$OMM`, `$OCM`,
and `$OBD` table bindings. Only fitted result records reach the independent
FlatSQL and publication nodes; provider-native ephemerides remain transient.

`app/app.json` and `app/ui/index.html` are bundle-owned APP source and UI. The
APP installs only the composed flow and reads opaque runtime status routes. It
does not fetch providers, schedule runs, interpret database records, or control
application policy in the host.

Those routes carry the signed status node's canonical, non-size-prefixed `$FSB`
transport envelope. Its `DATA` vector contains one canonical size-prefixed
`$DSS` record. Accordingly, APP dataflow entries declare the on-wire `FSB`
schema while the application data catalog retains `DSS` as the inner status
identity.

Commands:

```sh
npm test
npm run check
npm run build
```

Production builds require one shared release signing seed and key ID through
`SUPPLEMENTAL_OMM_SIGNING_SEED_HEX` and
`SUPPLEMENTAL_OMM_SIGNING_KEY_ID`. The package rejects development publishers
and mixed child signing keys in production mode.
