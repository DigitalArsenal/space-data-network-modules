# Cloudflare peer routing

This SDK module implements the deterministic reconciliation core. `plan`
consumes authenticated operator choices, a fresh verified peer/origin snapshot,
and a complete DNS listing, then emits exact API actions and per-node status.
It supports full base58 libp2p IDs and their lossless base36 CIDv1 form, proxied
IPv4 A records, and explicit inclusion/exclusion. Undeclared peers are excluded.
The method never receives credentials or changes DNS itself.

The snapshot contains `zoneId`, `zoneName`, Unix-seconds `now`, `nodes`,
`recordsComplete`, Cloudflare `records`, and `managedRecordIds` keyed by the
derived base36 peer label. Each included node needs `peerId`, `included`,
`profileVerified`, `verifiedAt`, `originVerified`, `publicArtifactsOnly` and
`originIpv4`. The authenticated host must actually verify those facts; boolean
flags supplied by an untrusted APP or remote discovery event are not proof.
Verification expires after 900 seconds. The module rejects private, reserved
and documentation IPv4 ranges. IPv6 origin support is not implemented yet.

Existing records are mutable only when both the stored managed record ID and
the `sdn-peer:<base36-label>` comment match. Foreign records, changed types and
duplicate names are preserved as conflicts. A peer disappearing from a snapshot
does not delete its route. Only explicit exclusion proposes deletion. Deletion
does not prove cached bytes have been purged.

Build with `npm ci && npm run build`, then `npm test`. The SDK compiles one
`dist/isomorphic/module.wasm` through its canonical wasi-sequential profile.
Browser serving therefore requires cross-origin isolation. No network or secret
capabilities are requested by this planning method. Inputs and outputs are
intra-flow JSON control frames; dataset observations remain canonical SDS bytes.

This is not yet a published or installed registrar. Remaining integration:

- A credentialed runner must enumerate every DNS page, invoke the planner,
  revalidate before applying each mutation, persist only confirmed record IDs,
  honor bounded Retry-After handling, and re-read actual DNS state afterward.
- Use the node's existing sealed-secret and HTTP capabilities. Do not give a
  browser APP the Cloudflare token or turn the Go host into a Cloudflare client.
- Add the inclusion/exclusion APP and its generic authenticated host bridge.
  The existing catalog APP bridge cannot execute credentialed module commands.
- Verify the identical artifact in browser/WasmEdge, then sign, publish and
  install through normal module delivery. These gates are not replaced by the
  direct SDK harness tests.

No Workers, Tunnel, wildcard DNS or zone-wide security changes are involved.
The normal Cloudflare DNS API schema is documented at
[Create DNS Record](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/).
