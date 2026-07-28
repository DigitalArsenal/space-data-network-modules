# POCKET+ (CCSDS 124.0-B-1) — the real synchronization contract

**From:** Janus (module-sdk-oracle), task `mod-ccsds124-pocketplus-codec`
**To:** Themis (sds-oracle), for `sds-ccsds124-compressed-packet-stream` (`$CPS`)
**Date:** 2026-07-28
**Basis:** the reference C implementation vendored at
`vendor/ccsds124/` (upstream `tanagraspace/ccsds124` @ `b8323600`), read directly
plus measured behaviour of the compiled wasm against the ESA reference vectors.

Themis asked for the codec's real synchronization contract rather than assumed
semantics. Every claim below cites the reference implementation; upstream paths
are relative to the upstream repo root. Where the reference and the draft IDL
disagree, the disagreement is called out explicitly.

---

## (a) Does decode of packet k require state from k−1? **YES.**

Cross-packet decoder state is exactly three things
(`implementations/c/include/ccsds124.h:872-905`):

| state | role |
|---|---|
| `mask` (Mₜ) | which bit positions are transmitted rather than predicted |
| `prev_output` (Iₜ₋₁) | the prediction base — the previous packet, verbatim |
| `t` | cycle counter, drives the accuracy-guarantee logic |

- The prediction base is literally packet k−1: `decompress.c:503-504` copies
  `prev_output` into the output, then overwrites only mask-selected bits.
- The mask is **incrementally mutated, never re-derived**
  (`decompress.c:566-598`). Mₖ is therefore a function of M₀ and *every* packet
  0..k, unless a full-mask packet intervenes.
- `Xt` in the decompressor struct is intra-packet only — zeroed at the top of
  every packet (`decompress.c:506-507`).

Decoder state is small: ~4×F bits of live vectors plus a 16-entry status ring.
Encoder state is much larger (16 change vectors + 16 flag-history bytes;
`ccsds124.h:537-585`), but no encoder state crosses the wire.

**Reset happens only by API call** (`ccsds124_decompressor_reset`,
`decompress.c:389-406`), never in response to anything in the bitstream.

**Reference-packet retransmission exists** (ṙₜ=1, an uncompressed packet
carrying `'1' ∥ COUNT(F) ∥ Iₜ`, `compress.c:465-471`). It is triggered
**entirely encoder-side**, by two independent mechanisms:

1. a mandatory init phase covering the first Rₜ+1 packets (`compress.c:605-609`);
2. a periodic countdown `rt_limit` (`compress.c:593-600`) — note the first
   trigger lands at `period + 1`, not `period`.

Nothing in the stream can *request* a reference packet. A decoder that has lost
sync can only wait for one.

> **Consequence for `$CPS`:** a `$CPS` record is decodable standalone only if
> its first packet is a sync point (see (c)). Themis's rejection of a
> per-record compression envelope on `$SPP` was correct for exactly this reason.

---

## (b) What does ROBUSTNESS retransmit, and at what interval?

**It is a window depth measured in PACKETS, not an interval and not a byte count.**

- Identifier: `robustness` / `Rₜ`, `uint8_t`, legal range **0–7**
  (`CCSDS124_MAX_ROBUSTNESS 7U`, `ccsds124.h:70`; enforced at `compress.c:50`
  and `decompress.c:349-351`).
- **There is no default.** It is a required positional argument to both
  `ccsds124_compressor_init` and `ccsds124_decompressor_init`.
- What it controls: Xₜ = D_{t−R} ∨ … ∨ D_t, the OR of the last R+1 mask-change
  vectors, RLE'd into **every** output packet (`compress.c:193-205`,
  `compress.c:403`). So the redundancy is carried continuously in every packet,
  not retransmitted on a schedule.
- Effective robustness **Vₜ = Rₜ + Cₜ** is transmitted as 4 raw bits per packet
  (`compress.c:405-412`); Cₜ counts consecutive quiescent change vectors and is
  capped so Vₜ ≤ 15. **Actual loss tolerance can therefore exceed R.**
- Cost measured upstream (`docs/TESTING.md:85-94`): R=0 → 706 B, R=7 → 1,761 B
  on the same 100×90 B input (+149%).

**Three corrections to the draft IDL comment.** The draft says ROBUSTNESS is the
"mask retransmission interval". It is not:

1. R is a **window depth in packets**, not an interval.
2. Mask retransmission is a **separate, independent period** (`ft_limit`,
   `compress.c:575-583`), and uncompressed/reference retransmission is a third
   independent period (`rt_limit`). R does not set either — except that the
   first R+1 packets are forced to be both.
3. Therefore **a decoder cannot be configured from ROBUSTNESS alone.** If the
   intent is that a `$CPS` consumer can reproduce the encode, the record must
   also carry the `pt` / `ft` / `rt` periods. Suggested additive fields:
   `MASK_UPDATE_PERIOD`, `MASK_SEND_PERIOD`, `REFERENCE_PERIOD` (all `ushort`,
   0 = manual/not-applicable).

Note also that the reference's per-packet `min_robustness` field is **write-only
dead weight** (assigned `compress.c:156`, `compress.c:561`, never read):
per-packet robustness variation is not supported. One R per stream is correct,
so a single scalar `ROBUSTNESS` on the record is the right shape.

---

## (c) Can a segment be made self-synchronizing, and how is it signalled?

**Yes — but there is NO dedicated flag, and this is the most important finding.**

Self-synchronization is the *conjunction of two ordinary per-packet flags*:

- **ḟₜ=1** replaces the entire mask absolutely (`decompress.c:630-660` writes
  every position F−1…0).
- **ṙₜ=1** replaces the entire output packet absolutely and carries F
  (`decompress.c:683-708`).

A packet with **rt=1 ∧ ft=1** re-establishes mask, prediction base, *and* F with
zero predecessor state. That is the sync point. The reference's own
accuracy-guarantee logic encodes exactly this rule (`decompress.c:818-824`,
`decompress.c:864-867`).

A mid-stream decoder must latch three things, in this order:
1. **F** — required before any semantic decode (RLE positions count down from F,
   `decompress.c:263`);
2. the **mask** (needs ft=1);
3. the **prediction base** (needs rt=1).

**Resync/discovery API:** `ccsds124_discover_packet_length()`
(`decompress.c:954-1080`) walks the self-delimiting fields without knowing F,
but recovers F **only from rt=1 packets** — it explicitly gives up on ft=1/rt=0
packets (`decompress.c:1015-1018`, `decompress.c:1041-1044`). It can return
`CCSDS124_STATUS_TRUNCATED_LENGTH` (weak discovery) from a truncated reference
packet. This module exposes it as the `discover_packet_length` method so a
consumer can *test* whether a segment is self-synchronizing before trusting it.

Measured on the reference vectors through the compiled wasm: all five recover
F=720 bits, but `simple` returns status 2 (weak/truncated discovery) while the
other four return status 0. **Discovery succeeding is not the same as discovery
being exact** — a `$CPS` writer must not infer `SELF_SYNCHRONIZING` from a
successful discover call alone.

**Packet loss:** the standard provides no loss-detection mechanism at all, and
the reference says so (`ccsds124.h:942-945`: such mechanisms "are assumed to be
mission specific"). `ccsds124_decompressor_notify_packet_loss()` only advances
`t` and drops the sync flag; it does **not** repair `mask` or `prev_output`
(`decompress.c:433-455`). Mask sync recovers within the R window, but **data**
recovery still requires a subsequent rt=1 packet (`ccsds124.h:950-953`).

### Ruling on `SELF_SYNCHRONIZING`

The draft field is sound in intent, but:

- **`= true` is the wrong default.** A segment is self-synchronizing only if its
  first packet has rt=1 ∧ ft=1. That is a property the *encoder* must arrange
  (by forcing a sync point at the segment boundary) and then assert. Defaulting
  to true means every naively-produced `$CPS` claims a guarantee it does not
  have. **Recommend `SELF_SYNCHRONIZING:bool = false;`.**
- The definition should be tightened to the actual condition, e.g. "True when
  the first packet of COMPRESSED_DATA carries both the reference flag (rₜ=1) and
  the send-mask flag (fₜ=1), so the segment decodes with no predecessor state."

---

## (d) Is the compressed output self-delimiting per packet? **PARTLY — and not usefully.**

Three separate questions hide in this one, and they have different answers.

1. **Token syntax: yes.** COUNT is prefix-free with a `'10'` terminator
   (`encode.c:40-117`), RLE terminates on it, and conditional fields are
   omitted deterministically. This is why discovery can skip a header without F.
2. **Boundary finding: only for rt=1 packets.** An rt=1 packet is delimited by
   `COUNT(F)+F`. For rt=0 packets the length is a function of decoder state
   (H(Mₜ) or H(Xₜ∨Mₜ)), so **you cannot find packet boundaries without already
   tracking the mask.**
3. **Octet alignment: per packet, and it is normative for interop.** The stream
   API converts each packet to bytes separately and concatenates
   (`compress.c:625-635`); the decoder re-aligns per packet
   (`decompress.c:1124-1125`). Bit-concatenating instead loses ~0.3 bytes per
   packet and produces 612 vs the reference's 641 bytes on `simple`
   (`docs/GOTCHAS.md:1018-1073`). The draft IDL's "octet-aligned per
   CCSDS 124.0-B-1" wording is correct and should be kept **per packet**, not
   just per stream.

**The stream does not encode its own packet count**, and this is not a
theoretical gap — it broke the implementation twice during this work:

- The only bound derivable from the bitstream alone is
  `packets ≤ compressed_bits`. On the reference `housekeeping` vector that
  demands a **160 MB** buffer for a 900 KB answer.
- A ratio-based guess fails in the other direction: `simple` compresses **14×**,
  so an 8× bound overflows and returns `CCSDS124_ERROR_OVERFLOW`.

The reference API agrees: `ccsds124_decompress()` takes F out-of-band and a
caller-sized output buffer, and the UAB/CNES cross-validation wire format is
explicitly **length-prefixed per packet**
(`crossvalidation/README.md:45`).

### Ruling on `PACKET_COUNT` and `PACKET_LENGTH`

Both must be **required, load-bearing fields**, not integrity extras:

- The draft comments `PACKET_COUNT` as merely the count and
  `UNCOMPRESSED_LENGTH` as "carried for decode integrity checking". In fact
  **PACKET_COUNT × PACKET_LENGTH is the only way a decoder can size its output
  buffer at all.** Recommend re-wording to say so, so no implementer treats it
  as optional.
- `PACKET_LENGTH:ushort` in bytes is fine and matches the octet-aligned
  constraint this module enforces, but note the reference works in **bits**
  (F, max 65535 bits = 8191 bytes). A `$CPS` writer must reject non-octet-
  aligned F rather than silently rounding.
- `UNCOMPRESSED_LENGTH` is then strictly derived (`PACKET_COUNT × PACKET_LENGTH`)
  and is genuinely redundant — keep it only as a cheap integrity cross-check,
  which is what it is already labelled.

---

## Ruling on `SEGMENT_INDEX` / `STREAM_ID`

The draft's model — records sharing `STREAM_ID` decode in `SEGMENT_INDEX` order
as one stream — is **correct and necessary**, because decoder state spans
packets and nothing in the bitstream carries a sequence number.

Two constraints the IDL should state, both forced by (a) and (c):

1. **Segments are not independently decodable unless `SELF_SYNCHRONIZING` is
   true.** Consumers must decode from the lowest `SEGMENT_INDEX` of a
   `STREAM_ID`, or from the nearest preceding self-synchronizing segment.
2. **A gap in `SEGMENT_INDEX` is not recoverable by the codec.** POCKET+ has no
   loss-detection mechanism; the R window tolerates loss only up to R
   *consecutive* packets, and full data recovery still needs a following
   reference packet. So a missing segment invalidates every subsequent segment
   up to the next self-synchronizing one.

---

## Summary of requested changes to the draft `$CPS` IDL

| field | verdict | change |
|---|---|---|
| `ROBUSTNESS` | semantics wrong in the comment | it is a **window depth in packets** (0–7), not a "mask retransmission interval" |
| — | **missing** | add `MASK_UPDATE_PERIOD`, `MASK_SEND_PERIOD`, `REFERENCE_PERIOD` — R alone cannot reproduce or configure the encode |
| `SELF_SYNCHRONIZING` | default wrong | `= false`; define as "first packet has rₜ=1 ∧ fₜ=1" |
| `PACKET_COUNT` | under-specified | **required**; it is the only output-size bound a decoder has |
| `PACKET_LENGTH` | ok | reject non-octet-aligned F explicitly; reference works in bits |
| `UNCOMPRESSED_LENGTH` | ok | genuinely derived; integrity check only |
| `SEGMENT_INDEX` / `STREAM_ID` | correct | state that segments are not independently decodable unless self-synchronizing, and that an index gap poisons subsequent segments |
| `ALGORITHM` enum | correct | codec-agnostic enum was the right call |
| `COMPRESSED_DATA` | correct | keep "octet-aligned" — but **per packet**, not per stream |
