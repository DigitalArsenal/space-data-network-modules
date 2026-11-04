# Native LVDB readback, 2026-11-04

Task `modules-lvdb-native-readback-20261104`.

The defect was in the E2E: the auto-publisher logs the first signed part's
manifest CID alongside the complete series count. Reading that manifest alone
returned its 235 records. The node had correctly published eight parts.

The corrected test walks every page of the public typed `list-published`
protocol for the exact schema/provider/source/batch. Two parts per page
exercise pagination. Every listed manifest and shard is fetched by CID;
byte lengths, hashes, contiguous offsets, per-part counts and unique SSY IDs
are asserted before rerunning the full release oracle. The 1 MiB shard budget
is unchanged. No node code or policy is changed.

`open-manifest` is a raw-table operation, subject to private-read authorization;
publication discovery uses the public publication protocol directly.

The native E2E is required whenever SDN_NODE_BINARY is set, with no additional
opt-in needed. The successful command set only SDN_NODE_BINARY (not
LVDB_NODE_READBACK). Binary supplied by the coordinator: sdn main with SSY,
SDS 1.275.0; executable SHA-256:
`c077a348884f088e91d364cf3a0fdc117af469882cd923da5f185cdeb287b6eb`.

```text
PASS SSY shard CID=bafybeiejf36pyct3334hsm53txtueckt7ga4wq6xyvaxdzgtkseq6vscfq records=235
PASS SSY shard CID=bafybeic3bcc2zebvvisr5rpdlxhdjtx77q4acujlhbgtcje4nebme35vl4 records=219
PASS SSY shard CID=bafybeidcuz3i4zafatt5topk6qded7rpn6s5wak6mwzwcj2tqo7d2zhzem records=223
PASS SSY shard CID=bafybeiayfocuscka4iyljbgby7lwhhvdxysvtlg6wlttmjyzfhasvm7mge records=226
PASS SSY shard CID=bafybeibk7jofrykwufrvykbrw2qk3k6zbi2d4igyabaj3vt2wlewdotgi4 records=213
PASS SSY shard CID=bafybeicvgbjyvx2wx7hj33vda6zrx66ky4qoeazkcfvurchqjw3v6ytkqu records=213
PASS SSY shard CID=bafybeibj6zgl4dsa72vau4vefrtbngfdxscwdn2sdfnfcqbdrcxwcunt7m records=237
PASS SSY shard CID=bafybeihgjydwblb2l7qntjgadao4yshxqeoggo2uprn6xapjkayfvexcv4 records=161
PASS SSY native CID readback manifest=bafkreiatqd6okxgjh3uc77jvjp6pg3z2xl6adsvriqnbqdtv6kizqpauiy shards=8 uniqueRecords=1727
```

The readback also passed all eleven source table counts, 790 PM measurements,
622 J factors, 122-column equality and all six named ALTERNATES, including the
two literal zero upper limits. The complete record identity set has size 1,727.
Signed manifests differ across isolated node identities; shard CIDs are stable
for this release fixture. The PASS manifest CID identifies the logged first
signed part of the series, not a single manifest containing the entire batch.

Scratch evidence for this run:
`/var/folders/t7/fmn19zvs3h5968_nc0484bz00000gn/T/space-weather-node-qV7h42/sdn.log`.
The scratch node and client were stopped by the E2E. No provider was installed.
