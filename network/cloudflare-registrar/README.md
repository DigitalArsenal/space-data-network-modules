# Cloudflare peer routing

This SDK module implements the deterministic reconciliation core of peer-ID DNS
routing on typed contracts 1.0 (FlatBuffers only between modules). `plan`
reads a complete DNS listing, the node's known peers and its verifications,
plus operator choices, and emits the exact Cloudflare API calls and per-peer
status. It supports full base58 libp2p IDs and their lossless base36 CIDv1
form, proxied IPv4 A records, and explicit inclusion/exclusion. The module
never receives credentials and never changes DNS itself.

## Ports

| Port | Type | Carries |
| --- | --- | --- |
| in `dns_records` (1..64) | HttpResponse (HRSP) | Every page of `GET /zones/<zone>/dns_records`. BODY is Cloudflare's JSON listing, an external API body parsed here. Pages 1..`total_pages` must each arrive once and add up to `total_count`, else the call fails. The latest `RETRIEVED_MS` is the snapshot time. |
| in `peers` | `$NST` | The peers the node knows. Discovery alone never creates a route. |
| in `verifications` | `$PNV` | The node's verdicts on peers' signed publication notices. |
| out `requests` | HttpRequest (HREQ) | `POST`/`PUT`/`DELETE <api>/zones/<zone>/dns_records[/<id>]`. POST/PUT BODY is the Cloudflare JSON record (external client rendering). There is no authorization header. CONTEXT is one size-prefixed `$APR` (METHOD, PATH, ROUTE `cloudflare-dns-record`, PARAMETERS `peerId`, `label`, `hostname`, `recordId`). |
| out `status` | FlowNotice (FNTC) | One per peer: SOURCE_NAME is the hostname, BATCH_ID the peer ID, REASON the status (`included`, `excluded`, `blocked`, `conflict`, `pending-inclusion`, `pending-exclusion`). ITEMS holds the message and `cache-purge-required`. |

## Node config

The module reads one `plugin.getConfig` hostcall (`sdm_piv::get_config()`):

- `cloudflare_zone_id` and `cloudflare_zone_name`.
- `cloudflare_api_base`, default `https://api.cloudflare.com/client/v4`.
- `request_timeout_ms`, default 30000.
- `peers`: one entry `{peer_id, included, origin_ipv4, origin_verified, public_artifacts_only}` per declared peer.
- `managed_records`: entries `{label, record_id}`, keyed by the base36 peer label.

## Rules

- **Peer verification comes from `$PNV`.** The peer must have published a
  notice with `SIGNATURE_VERIFIED` and a `KEY_SOURCE` of `IdentityRecord`,
  `PeerIdentifier` or `OperatorTrust`. A self-asserted key is not identity.
  The latest such `RECEIVED_AT_MS` must be within 900 seconds of the snapshot
  time.
- **Origin facts are operator-attested.** `origin_ipv4`, `origin_verified` and
  `public_artifacts_only` have no field in `$NST` or `$PNV`, so they come from
  config. The authenticated operator host must actually verify them before
  writing them there.
- **Only public IPv4 origins are routed.** The module rejects private,
  reserved and documentation IPv4 ranges. IPv6 origin support is not
  implemented yet.
- **Unlisted peers are excluded.** Peers in `$NST` but not in `peers` are
  reported as excluded, and so are declared peers without an `included`
  choice.
- **Only owned records change.** A record is mutable only when both the stored
  managed record ID and the `sdn-peer:<base36-label>` comment match. Foreign
  records, changed types and duplicate names are preserved as conflicts.
- **Only explicit exclusion deletes.** A peer disappearing from the inputs
  does not delete its route. Deletion does not prove that cached bytes have
  been purged.

## Build and test

```sh
SPACE_DATA_STANDARDS_ROOT=<sds> npm run build
npm test
```

The SDK compiles one `dist/isomorphic/module.wasm`. The tests run the
artifact in the SDK browser harness, with config served through
`plugin.getConfig`.

## Remaining integration

This is not yet a published or installed registrar.

- **A credentialed runner is still needed.** It must:
  - send these requests with the node's sealed Cloudflare token;
  - revalidate before each mutation;
  - persist only confirmed record IDs into `managed_records`;
  - honor bounded Retry-After handling;
  - re-read actual DNS state afterward.
- **Keep credentials out of the wrong places.** Do not give a browser APP the
  token, and do not turn the Go host into a Cloudflare client.
- **The inclusion/exclusion APP and its authenticated config bridge are
  missing.**
- **Release gates remain.** Verify the identical artifact on WasmEdge, then
  sign, publish and install it through normal module delivery.

No Workers, Tunnel, wildcard DNS or zone-wide security changes are involved.
See Cloudflare's API documentation for
[List DNS Records](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/)
and
[Create DNS Record](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/).
