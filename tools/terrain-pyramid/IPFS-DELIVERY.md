# The pyramid is an IPFS directory

**Owner, 2026-08-27:** *terrain files are requested over IPFS.* One
content-addressed directory per tileset epoch, added and pinned through the
node's IPFS API by this off-fleet builder, served at `<node>/ipfs/<cid>/`.
Clients point a native `CesiumTerrainProvider` at the gateway path of the
CURRENT CID, which they resolve from the node. The owner refused a static asset
hostname in the same breath, and nothing here creates one: every path a client
learns is relative to the node it is already talking to.

This file states what is published, what the gateway does with it (measured,
not assumed), and the $DTT field mapping the catalogue record uses.

## The directory

    <cid>/layer.json                 the tileset index, rendered by the module
    <cid>/{z}/{x}/{y}.terrain        one quantized-mesh-1.0 tile, mask inside

`{y}` is TMS — row 0 at the SOUTH edge — which is the row direction the records
carry and the direction a native client sends, so no flip happens anywhere.

Three properties the mount used to provide at request time are now properties
of the FILES, because a gateway does none of them:

1. **The bytes are decoded.** The stored `$DTT` payload is gzipped and the
   mount decompresses per `Accept-Encoding`; a file has ONE representation.
   Every `.terrain` file is the identity mesh. A file holding the gzipped
   payload would reach the browser as an unparseable tile — asserted against,
   in `tests/ipfs-layout.test.mjs`.
2. **The water mask is in the file, unconditionally.** No negotiation, no
   `extensions` query, no serve-time append. Every file is walked to its
   extension region before it is written and refused if extension id 2 is not
   there.
3. **Every address `layer.json` promises exists.** `respond()` synthesizes an
   available-but-unstored address (the encoder never stores an all-ocean tile);
   a gateway returns 404, and Atlas set the browser-4xx bound at zero. So the
   publisher asks the MODULE for the same bytes it would have synthesized and
   writes them as files. That includes both level-0 roots — without them a
   native provider's first request is a 404 and the globe never leaves the
   ellipsoid.

## The ocean has to be DECLARED, or it is served as land

The encoder does not store an all-ocean tile: at a built level it measures the
address as all water and skips it, and `terrain_ocean_synth_min_level` tells
the mount that a miss at or above that level means *"measured all-ocean"* and
must be synthesized as `UNIFORM_WATER` — while a miss below it is a structural
ancestor and fails safe to flat `UNIFORM_LAND`, because fabricated water paints
every continent as specular ocean and that was this lane's worst prior defect.

**That lever could never fire.** The skipped addresses were dropped: the
encoder reported them per tile, `run.mjs` kept only the COUNT, and `verify.mjs`
derived `available` from STORED tiles — so a skipped address was not in the
published index at all. A client over open water refined until availability ran
out and then rendered the shallowest ANCESTOR, which is below the authoritative
floor and therefore flat land with a `UNIFORM_LAND` mask. Measured on the
regional pyramid: **24.3% of the ocean inside the tileset's own extent came
back as land** (1,711 of 7,051 sampled ocean points, 660 at z6 and 1,050 at
z7), on the one lane that chose a coastal region precisely to exercise the
water mask. Every synthesized file in the published directory was
`UNIFORM_LAND`; not one was water.

A skipped address is a MEASUREMENT, not a gap. So:

    run.mjs      writes <out>/ocean-skipped.json — every address, not the count
    verify.mjs   declares them alongside the stored ones, and REFUSES any that
                 sits below the authoritative floor (there the module would
                 answer land, which is the defect)
    ipfs-publish materializes them through the module, counts what each one
                 states, and refuses to publish if an address the encoder
                 measured as water comes out as land

### DECLARED RESIDUE: the shallow band outside the built extent

The fix is real INSIDE THE BUILT FOOTPRINT and only there. Every position
inside the tileset's own extent now answers from a level at or below the
authoritative floor, so the 989 addresses the encoder measured as all-water
come back `UNIFORM_WATER` and nothing inside the footprint is served as
fabricated land.

Outside the built extent the 37 structural ancestors at z0–z7 are still flat
`h=0` with a `UNIFORM_LAND` mask, and z0 is both roots — so a camera whose
screen-space error is satisfied at a shallow level, which includes every global
view and the first frames of every load, is served flat land with a positive
land mask over the whole planet. That is a **DECLARED RESIDUE of a REGIONAL
pyramid, not a correct answer.** The earlier text here called it correct on the
grounds that the tileset "has no measurement of anything" outside its footprint;
that argument does not hold, because `UNIFORM_LAND` is a positive claim about
water cover and "no measurement" is what `dttWaterMask.NONE` ("the tile states
nothing about water cover") is for. It is also false for the in-footprint part
of an overhanging ancestor: 6/66/47 spans 5.625–8.4375 E / 42.1875–45.0 N, and
its overlap with this tileset's extent is open Ligurian Sea that the encoder
MEASURED as water at z11.

It is bounded and it is owned:

- **Bounded** because a regional pyramid only ever states the region it built;
  the residue is entirely at levels the run did not build.
- **Resolved by** `terrain-pyramid-global-build-tooling` — the global z0–z10
  land pyramid. With a global build there is no ancestor band below the
  authoritative floor, so the residue disappears rather than being patched.
- **Not patched here** because the two local options both make the record less
  honest than the gap: emitting no watermask chunk on the ancestors makes those
  tiles disagree with `layer.json`'s `extensions:["watermask"]`, and
  rasterising a WBM into them would state a measurement this run did not make.

What changed this round is that a client now refines PAST the ancestors
everywhere the pyramid was actually built.

`layer.json` is rendered by the module's own `layer_json` method, driven
through `route()` so the plan is the mount's plan. The ONLY difference from
what the mount serves is the tiles template: the mount states
`{z}/{x}/{y}.terrain?v={version}` because its tiles are not content-addressed
and that query is what keys them; inside a CID the template is bare
`{z}/{x}/{y}.terrain`, because the CID is already the cache key. That template
is now a plan field (`terrain_tiles_template`), not a constant, so there is
still exactly one renderer.

## What the gateway does — MEASURED 2026-08-27 on host-01

> **SUPERSEDED, NOT YET REPUBLISHED.** The CID below is the PRE-FIX directory
> (4,652 files: 4,615 stored + 36 synthesized, every synthesized tile
> `UNIFORM_LAND`, no ocean address declared). The candidate directory this
> round produces is 5,641 files (4,615 stored + 989 `UNIFORM_WATER` ocean +
> 37 ancestors). The stored tile BYTES did not move — only the declared and
> synthesized set differs — but the pinned epoch still serves the sea as land
> and must not be the CID a catalogue names. `ipfs-publish.mjs --add` has to
> run before the anonymous allowlist lands, or both clients will discover and
> mount exactly the directory this round's blocker was filed against. Owned by
> the ship lane; the gateway measurements below are unaffected and stand.

Published: `bafybeidr3l5zoi6gxui3vuuvfc5sadl3zlkotonukuxysw7fws54s2npmy`
(the Liguria regional pyramid, 4,652 files, 358.38 MiB), added and pinned
through host-01's kubo 0.39.0 RPC on loopback `127.0.0.1:5002` over an ssh
tunnel, read back at `https://sdn.spaceaware.io/ipfs/<cid>/`.

| property | measured |
| --- | --- |
| status | `200` on `layer.json` and every tile probed |
| bytes | byte-identical to the local file (`same=true` on all four probes) |
| `cache-control` | `public, max-age=29030400, immutable` |
| `etag` | the file's own CIDv1 — strong (`"bafkrei…"`) on tiles; WEAK (`W/"bafkrei…"`) on `layer.json`, because the edge recompressed it |
| `access-control-allow-origin` | `*` |
| `content-type` | `application/octet-stream` for tiles, `application/json` for layer.json |
| latency | 99–159 ms per file, cold |
| **compression** | **none on tiles**; `br` on `layer.json` |
| `If-None-Match` | **200 through the public path, 304 at kubo** |

Two of those need saying plainly.

**The gateway does not compress the tiles** — which is the number that
matters, because tiles are 4,651 of the 4,652 files. It does compress
`layer.json`: `application/json` is on Cloudflare's compressible list and the
index came back `content-encoding: br`, which also WEAKENS its ETag (an edge
that transforms a body may no longer claim byte equality). That costs nothing —
`layer.json` is fetched once per client and its 304 is not on the hot path —
but it is why the table has two rows instead of one, and why a reader comparing
the evidence file against this page finds `br` there and should not read it as
a contradiction. For everything under `application/octet-stream`:
kubo serves the stored bytes verbatim and
Cloudflare does not compress `application/octet-stream`. Asked with
`Accept-Encoding: gzip, br`, a 75,140-byte tile came back 75,140 bytes with no
`content-encoding`. So the wire size of a tile is its UNCOMPRESSED size, and
for this pyramid that is:

| | p50 | p99 | max |
| --- | --- | --- | --- |
| identity (what IPFS serves) | 66,132 B | 327,267 B | — |
| gzipped (what the mount served) | 3,555 B | 28,627 B | 30,799 B |

The difference is almost entirely the water mask: a raster mask is 256×256 =
65,536 bytes of near-constant data that gzip erases and a static file cannot.
49% of this pyramid's tiles carry one.

**That breaks two of Atlas's byte bounds** (2026-08-26: median ≤ 25 KB,
p99 ≤ 120 KB, hard cap 256 KB uncompressed, gzip on the wire). They were set
for a mount that gzips; under static delivery the uncompressed number IS the
wire number and p50 66 KB / p99 327 KB miss them. **This is a coordinator
question, not something this lane decided**, and the fact that decides it is:
the engine sizes the mask texture as `Math.sqrt(waterMask.length)`
(`GlobeSurfaceTile.js:1077`), so any square mask renders — a 64×64 mask is
4,096 bytes and would put the median back around 5 KB. Atlas fixed N=256 across
levels in the seam ruling, so changing it is Atlas's call. The alternative
lever is compression at the node's `/ipfs` proxy, which is Hermes/Hephaestus
territory and outside this lane's components.

A smaller, independent lever sits on the SYNTHESIZED tiles: they are flat by
construction and cut on the mount's synth lattice (default 65×65 = 4,225
vertices), so `0/0/0.terrain` is 75,140 bytes of mesh describing a plane four
vertices would describe exactly. `terrain_synth_grid_size` already exists, and
the publisher now honours whatever the mount configures rather than defaulting
independently — a fallback that disagrees byte-for-byte with the primary is
worse than no fallback. Setting it small shrinks those files by two orders of
magnitude, but it changes what the MOUNT serves too, and here it is 36 files
against 4,615, so it is not the bound that matters. Named so it is not
rediscovered as a surprise on a global build, where the shallow levels are a
larger share.

**The 304 is lost in the legacy proxy, not in IPFS.** kubo at `127.0.0.1:8091`
answers `If-None-Match` with `304` on all four probes. The node's
`admin.ipfs_gateway_url` currently points at `127.0.0.1:8081` — the legacy
`spaceaware-terrain-cache.service` node script — which drops the conditional
and answers `200`. The ship plan already moves that key `:8081 → :8091` when
the terrain cache is retired; this measurement makes the move a CORRECTNESS
requirement of the IPFS lane rather than cleanup, because until it lands every
revalidation re-downloads the tile.

    # the measurement, on the box
    E=$(curl -s -D - -o /dev/null http://127.0.0.1:8091/ipfs/$CID/8/268/190.terrain \
        | grep -i '^etag:' | sed 's/^[Ee]tag: //')
    curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $E" \
        http://127.0.0.1:8091/ipfs/$CID/8/268/190.terrain   # 304
    curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $E" \
        http://127.0.0.1:8081/ipfs/$CID/8/268/190.terrain   # 200

## The catalogue record: the $DTT field mapping

A client must not hardcode a CID (it is pinned to a dead epoch the day the
dataset is recut) and must not learn one from a hostname. So the tileset epoch
is a RECORD, published through the same dataset lane the tiles' provenance
names, and the node serves the pointer from it.

**Themis: this mints nothing.** Every field below is a $DTT field carrying what
`schema/DTT/main.fbs` says it carries. `$DTT` is already CID-first — *"a tile
record addresses its bytes so an epoch can be verified rather than trusted"* —
and a tileset record is that sentence applied to the directory instead of one
tile. Rendered as JSON it uses IDL-EXACT KEYS.

| $DTT field | the tileset catalogue record carries |
| --- | --- |
| `TILESET_ID` | the pyramid's publisher-stable id, identical to the tiles' — **required** |
| `TILESET_NAME` | its display name |
| `TILING_SCHEME` | `UNSPECIFIED`. The catalogue is the DIRECTORY, not a tile: it has no address in any scheme |
| `LEVEL/X/Y` | NOT STATED. Without a scheme they are not an address |
| `WEST/SOUTH/EAST/NORTH_DEG` | the tileset's own bounding extent, as `verify.mjs` measured it from the addresses actually built |
| `PAYLOAD_FORMAT` | `QUANTIZED_MESH` — what the directory contains |
| `PAYLOAD_FORMAT_VERSION` | `1.0` |
| `PAYLOAD` | **required.** Present and EMPTY when there is no directory to name |
| `PAYLOAD.CID` | **the directory CID.** The one field that names the epoch |
| `PAYLOAD.SIZE_BYTES` | the directory's total bytes, so a consumer can budget |
| `PAYLOAD.MEDIA_TYPE` | `application/vnd.ipld.dag-pb` |
| `PAYLOAD.BYTES` | ABSENT. Themis: never a pyramid blob inline |
| `MAX_LEVEL` | the deepest level the tileset serves |
| `WATER_MASK_KIND` | `NONE` — a tileset states nothing about water; its tiles do |
| `VERTICAL_DATUM` | `GEOID` — the same datum every tile record states, never dropped |
| `VERTICAL_DATUM_NAME` | the source's own datum name, verbatim (`EGM2008`) |
| `REMARKS` | the encoder's bounded-offset warning, so a reader of the catalogue ALONE learns the cost of rendering these heights as above-ellipsoid |
| `PROVENANCE` | **required.** The tiles' own lineage and licence, verbatim |
| `PROVENANCE.DATASET_ID` | **required** |
| `PROVENANCE.DATASET_EPOCH` | **required** |
| `PROVENANCE.RETRIEVED_AT` | **required** |
| `PROVENANCE.LICENSE` | **required** |
| `PROVENANCE.DATASET_CID` | the SOURCE dataset artifact, when the publisher distributes one. **NEVER the tileset directory** — see below. Absent here: this lane distributes no source artifact |
| `PROVENANCE.GENERATED_AT` | when the directory was cut (builder only; the mount states none) |
| `PROVENANCE.PROCESSOR` | `tools/terrain-pyramid/ipfs-publish.mjs` (builder only) |

### ONE FIELD NAMES THE TILESET DIRECTORY, AND IT IS `PAYLOAD.CID`

Both clients read `PAYLOAD.CID` and only that field. Nothing else may be read
as the tileset epoch.

`PROVENANCE.DATASET_CID` used to be a COPY of the same value, and that copy is
the whole reason two clients reading two different fields appeared to work: the
agreement was a coincidence of one implementation, pinned by no test and stated
as a contract nowhere. The IDL defines `DATASET_CID` as *"content identifier of
the exact dataset artifact, when the publisher distributes one"* — the SOURCE
DEM. The day a provenance-complete record puts the real Copernicus artifact
there, which is the literal reading and the natural cleanup, a reader of that
field points a terrain provider at a DEM archive and 404s every tile from a
record that is still perfectly valid.

So the module and the builder both stopped writing it. `DATASET_CID` is now its
own config key (`terrain_source_dataset_cid`) and is emitted only when an
operator names an actual source artifact — a different CID from the tileset's.
A record that states `DATASET_CID` and no `PAYLOAD.CID` names NO TILESET and is
refused by both clients rather than mounted.

### THE DATUM IS CARRIED, NOT DROPPED

Every per-tile `$DTT` states `VERTICAL_DATUM` `GEOID` and `VERTICAL_DATUM_NAME`
`EGM2008`. The published directory is `layer.json` plus the `.terrain` bytes —
**the per-tile records are not in it** — so the catalogue record and
`layer.json` are the only two documents a client on this delivery path ever
reads, and both used to drop the datum. That left it wire-defaulted to
`UNSPECIFIED`, which the IDL defines as *"the datum is not stated. Heights are
not comparable across tiles"*, on the exact path the owner directive made
primary.

The cost is not theoretical: quantized-mesh heights are interpreted as WGS84
ELLIPSOIDAL by every consumer that does not know better, so EGM2008 orthometric
heights sit low by the local undulation (~48 m in Liguria; the encoder bounds it
at `<~100 m`), and this stack feeds those heights to sensor viewshed and RF
terrain analysis. Both documents now carry it: the record as `VERTICAL_DATUM` /
`VERTICAL_DATUM_NAME` / `REMARKS`, and `layer.json` as `verticalDatum` /
`verticalDatumName`, rendered from the same plan by the same `layer_json`
method, so the tileset and its own index cannot disagree.

**IDL-exact keys is only half of it: the document has to BE a record.** Both
projections of this mapping — the builder's `tileset-catalogue.json` and the
serving mount's `/tileset.json` — spelled every key the way the IDL spells it
and NEITHER could be serialized. The mount's omitted `RETRIEVED_AT`, which
`DTTProvenance` marks `required` (`FlatBuffers: field 18 must be set`), and
dropped `PAYLOAD` entirely when no CID was configured, which `DTT` marks
`required` (`field 34 must be set`). Nothing in either suite had ever built a
projection through the published builder, so an unbuildable document answered
200 and passed 100 tests. A canonical-JSON form that cannot become the
FlatBuffer form is not a record in two forms, which is the premise the
dual-format signing law rests on.

`tools/terrain-pyramid/dtt-projection.mjs` is now the ONE place a projection
becomes a record: it refuses any key the IDL does not define, maps enum names
to their wire ordinals, and hands the result to `writeFB`, which is what
enforces `required`. The builder writes `tileset-catalogue.dttstream` through
it on every run and reads it back; `data-source/terrain-source/tests/
catalogue.test.mjs` puts the MOUNT's `/tileset.json` body through the same
projector. A mount that is not configured with the four required provenance
fields answers **503** naming the missing config keys rather than 200 with
something that is not a record.

**The address and the extent used to contradict each other.** The record stated
`GEOGRAPHIC_WGS84` with `LEVEL/X/Y` 0/0/0 and `WEST/EAST` -180/180 — and the
IDL defines that scheme's level 0 as TWO root tiles covering [-180,0] and
[0,180], so the stated address named HALF the stated extent. A consumer doing
the ordinary thing with a $DTT (derive the extent from the address and the
scheme) got a different answer from the record's own fields. `TILING_SCHEME` is
`UNSPECIFIED` — ordinal 0, which the IDL reserves so *"an unset field can never
be read as a real scheme"* — the address is not stated, and the extent stands
on its own. **The scheme of the tiles INSIDE is declared by the `layer.json` in
the directory**, which is where a terrain provider reads it from anyway.

**The discriminator between a catalogue record and a tile record is
`PAYLOAD.MEDIA_TYPE`.** A tile's payload is one mesh
(`application/vnd.quantized-mesh`); the catalogue's is the DIRECTORY those
tiles live in (`application/vnd.ipld.dag-pb`). It is a stated field carrying a
real difference, not a sentinel.

`PROVENANCE.SOURCE_URL`, `SOURCE_QUERY` and `NATIVE_ID` are deliberately
DROPPED from the catalogue record. They name the ONE granule a tile was cut
from; a pyramid is cut from thousands, and a record naming one of them as its
source is not imprecise, it is false.

The builder writes both forms:

    <out>/tileset-catalogue.json         the mapping above, IDL-exact keys
    <out>/tileset-catalogue.dttstream    the same record as SDS wire bytes,
                                         size-prefixed exactly like tiles.dttstream

**Signing.** A tileset-epoch ANNOUNCE is a signed record and is NOT in v1
(Themis, carried forward). This record is published through the dataset lane
like the tiles; the tiles themselves are unsigned and verified by the
CID/DIGEST/ETAG chain, and the catalogue record's authority is the same chain —
its `PAYLOAD.CID` either resolves to the directory a client fetched or it does
not.

## The catalogue endpoint: how a client resolves the CID

The mount answers the epoch question at three paths, in two shapes:

| path | shape | who reads it |
| --- | --- | --- |
| `/api/v1/terrain/tileset.json` | the **$DTT catalogue record**, IDL-exact keys | **the clients** — they pull `PAYLOAD.CID` |
| `/api/v1/terrain/` | the camelCase discovery document | anything wanting the serving hints in one fetch |
| `/api/v1/terrain/catalogue.json` | identical to the root, under a filename | caches and clients preferring a named document |

`tileset.json` is the one that matters, and it is the record form — the SAME
projection this builder writes to `tileset-catalogue.json` and publishes
through the dataset lane, so the document a client reads off the mount and the
record the dataset lane carries are the same fields under the same names.

**This nearly shipped broken.** The module served the epoch only at the root
and `catalogue.json`, in camelCase; the console fetches `tileset.json` and
reads `PAYLOAD.CID`. Against the real node that fetch fell through to the tile
parser and 404'd, so the console would have reported "terrain catalogue
answered HTTP 404", kept the ellipsoid by its never-halt rule and rendered no
terrain at all — while every tile under `/ipfs/` answered perfectly and every
test on both sides stayed green, because the console was verified against its
own `terrain-node.mjs` stand-in and the module against its own fixtures. The
two lanes met nowhere until a live node. `tests/catalogue.test.mjs` now
transcribes the console's actual CID reader and asserts it resolves the epoch
from this endpoint, and the flow suite asserts the same through the compiled
artifact the host mounts.


`GET <node>/api/v1/terrain/` (and `/api/v1/terrain/catalogue.json`) answers:

```json
{
  "tilesetId": "spaceaware-terrain",
  "delivery": "ipfs",
  "cid": "bafybei…",
  "datasetEpoch": "2023-04-01T00:00:00.000Z",
  "version": "1.0.0",
  "terrainBasePath": "/ipfs/bafybei…/",
  "layerJsonPath": "/ipfs/bafybei…/layer.json",
  "format": "quantized-mesh-1.0",
  "scheme": "tms",
  "projection": "EPSG:4326",
  "extensions": ["watermask"],
  "maxzoom": 13,
  "attribution": "…"
}
```

Keys are lowercase/camelCase: this is an API-synthesized discovery document,
not a $DTT rendered as JSON. `terrainBasePath` is RELATIVE, so a client joins
it against the node origin it already knows and learns no hostname;
`terrainBaseUrl` appears only when the mount configures a gateway origin.
`cache-control` is `public, max-age=60` with a strong ETag — everything under a
CID is immutable, and this is the lane's one mutable pointer, so a minute
bounds how long a client can miss a recut while every revalidation after the
first is a 304.

**Both spellings are DECLARED routes, and that is load-bearing.** The host
builds its anonymous allowlist from the flow manifest and nothing else
(`sdn-server/internal/gateway/anonymous.go`: a mounted route is served without
a session iff `api.routes[].anonymous` is true and config does not veto it).
The module answered the catalogue before the manifest declared it, which left
the endpoint reachable ONLY through an operator's `gateway.anonymous.allow`
prefix entry — so narrowing that entry to the declared set, the obvious tidy-up
for anyone reading a config with two documented routes and a broad allow, would
have 401'd the catalogue and taken the whole delivery path down with it while
every tile under `/ipfs/` kept answering. A silent, prod-only break of the one
document clients cannot proceed without. `/` and `/catalogue.json` are now
declared `anonymous: true` alongside `layer.json` and the tile route, so the
allowlist entry is defence in depth rather than the mechanism, and
`flows/terrain-serving/tests/flow.test.mjs` asserts every path the module
answers is a declared route.

**A node with no CID configured is not an error.** It answers
`"delivery": "mount"`, `"cid": null` and its own mount path, which is what
makes a development node with no IPFS daemon work unchanged and gives every
client ONE document to read either way.

The flow-mounted tile and `layer.json` routes still answer. They are no longer
the delivery path; they are the same-origin fallback and the local-development
path.

## Running it

    # 1. cut and verify the pyramid (unchanged)
    node tools/terrain-pyramid/run.mjs --config <region.json> --docker
    node tools/terrain-pyramid/verify.mjs --out <out>

    # 2. materialize the directory, add + pin, read it back through the gateway
    ssh -N -L 5002:127.0.0.1:5002 sdn.spaceaware.io &
    node tools/terrain-pyramid/ipfs-publish.mjs --out <out> \
         --api http://127.0.0.1:5002 --gateway https://sdn.spaceaware.io

    # variants
    ... --no-add                 materialize only; no network at all
    ... --cid <cid>              re-emit the catalogue for an already-published
                                 directory without pushing the bytes again

It REFUSES a pyramid `verify.mjs` has not passed, and refuses one whose report
lists unmet bounds. A CID is permanent: an unverified pyramid published under
one cannot be withdrawn from anyone who has already resolved it.

Outputs, beside the ones `run.mjs` and `verify.mjs` already write:

    <out>/ipfs/                       the directory as published
    <out>/ipfs-publication.json       CID, file counts, byte distributions,
                                      the gateway read-back, the mount keys
    <out>/tileset-catalogue.json      the $DTT catalogue record, IDL-exact keys
    <out>/tileset-catalogue.dttstream the same record as SDS wire bytes
    <out>/serving-config-ipfs.json    the complete `config:` block for the mount

A local kubo works identically and is what a development run should use; the
only thing host-01's API gives you is a pin on the box that serves the public
gateway.

### Global publication safety

The publisher frames `$DTT` records one at a time, materializes the directory
incrementally, walks it into a backpressured multipart stream, and consumes
Kubo's NDJSON add receipt incrementally. It must not allocate a full store or
full directory multipart buffer. It preflights `/api/v0/version`, requires a
recursive pin proof plus public gateway readback, and removes only the new
root's pin if that proof fails.

IPFS serves terrain identity bytes. The enforced delivery budget is p50 <= 96
KiB, p99 <= 384 KiB, hard <= 512 KiB per `.terrain` file. This is deliberately
separate from the gzipped record-store budget; publication may not bypass it.

### THE DEPLOY CONFIG IS COMPLETE BEFORE THE PUBLISH RUNS

`verify.mjs` writes `<out>/layer-json-config.json`, and `mount-entry.json`
names it as THE source of the module config keys that go INSIDE `config:`. It
used to carry eight keys — maxzoom, the ocean floor, the mount path,
availability and the four extent degrees — and NONE of the four
`DTTProvenance` fields the module requires. So an operator who followed the
ship step exactly installed a mount that answered
`GET /api/v1/terrain/tileset.json` with **503 `terrain catalogue not
configured`** — measured, not inferred — while `/api/v1/terrain/` answered 200
with `"cid": null`. Discovery failed for both clients and the 401 the ship step
was closing became a 503.

It now carries every key the module requires, read OFF A TILE (the tileset must
redistribute under the same terms its own contents carry) and refused rather
than defaulted when the store cannot state one:

    terrain_tileset_id  terrain_dataset_id  terrain_dataset_name
    terrain_dataset_epoch  terrain_dataset_retrieved_at
    terrain_license  terrain_license_url  terrain_attribution
    terrain_vertical_datum_name
    terrain_maxzoom  terrain_ocean_synth_min_level  terrain_mount_path
    terrain_available  terrain_{west,south,east,north}_deg

The publish step adds exactly TWO keys, and only two, because they name a
directory that does not exist until the add has run:
`terrain_tileset_cid` and `terrain_tileset_size_bytes` (plus
`terrain_gateway_path`, which defaults to `/ipfs/`). That is
`ipfs-publication.json`'s `mountConfig`, and `serving-config-ipfs.json` is the
merge of the two.

The proof is a test, not a claim:
`data-source/terrain-source/tests/catalogue.test.mjs` boots a mount from the
COMMITTED `evidence/liguria-z11/layer-json-config.json` verbatim, adds only
those two keys, and asserts `/api/v1/terrain/tileset.json` answers **200** with
a body that `writeFB` accepts as a `$DTT`.

## Why this talks to kubo directly, and not through the node's ipfs hook

The node HAS an IPFS capability — `io.spacedatanetwork.ipfs:add` in both
`sdn-server/internal/flowrt/capabilities/ipfs.go` and
`internal/modulert/caps/ipfs.go` — and it is the right hook for what it does.
It is not usable here: both implementations post ONE multipart part named
`data` and return that blob's CID. A pyramid is a directory of 4,652 files
whose identity is the directory's CID, which kubo builds from the multipart
FILENAMES; there is no arity of single-blob adds that produces it.

So the off-fleet builder speaks to the kubo RPC directly, which it is entitled
to do — it is a build machine, not a node, and the API endpoint is
configuration. If a pyramid publish should ever move INTO a flow, the hook
needs a directory-capable add (or a `wrap-with-directory` multipart form) and
that is a module-SDK/host change, not something to work around from a guest.
