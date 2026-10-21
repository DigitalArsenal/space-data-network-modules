# Object-store modules

Owner 2026-10-21: nodes update R2 and any other store with modules loaded into the node and credentials sealed to it. Storage modules are separate; flows compose them.

| Module | Holds | Does |
| --- | --- | --- |
| `storage/object-s3` | `secrets:storage_<store>` READ, `clock` | SigV4-signs put / get / head / delete / list / multipart for any S3-compatible store (R2, S3, B2, MinIO, Wasabi, GCS interop) as `HttpRequest`s for `hostcap/http-request`, reads the `HttpResponse`s back into `$APR` results and `$FIL` listings. No network, no write grant. |
| `storage/credentials` | `wallet_sign`, `secrets:storage_<store>` read + WRITE | Opens a browser-sealed `{username: access key id, secret}` with `keyslot.unwrap` and stores it with `secrets.put`; clear; status. Never signs, never reads a value back. |

Flows (`../flows`): `storage-credentials` (the only flow with the write grant), `storage-object-s3-api` (admin object API under `/api/v1/storage/objects/`, the only flow with read + http), `storage-object-s3` (the typed building block other flows copy: `$APR` tasks in, results out). Every HTTP route is NOT anonymous.

Lanes: `storage_r2`, `storage_s3`, `storage_b2`, `storage_wasabi`, `storage_minio`, `storage_gcs`, `storage_custom`. Another store needs its lane added to both manifests.

Store config (endpoint, region, bucket) is the task's: `endpoint=https://<account>.r2.cloudflarestorage.com`, `region=auto`, `bucket`, `style=path|virtual`.

E2E: `npm run e2e` (the harness in `support/` runs the built flows on the SDK WasmEdge-leg host against a SigV4-verifying mock; `r2-live` and `node-r2` need `~/.config/spacedatanetwork/r2.env`, and `node-r2` a node at `SDN_NODE_URL`).

Traps measured on the Go node: its http connector (1) fails a HEAD answered with a non-zero Content-Length as a short read, so `head` is a one-byte ranged GET (`headVia=head` asks for the real HEAD); (2) presents remembered ETag / Last-Modified as `If-None-Match` / `If-Modified-Since` on the next GET of a URL, so every read names a validator no object carries (`freshRead=false` drops it).
