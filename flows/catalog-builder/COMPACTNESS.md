# Population annotation size

Population annotation adds several kilobytes to each fitted record. The standard's independent covariance blocks carry timestamped text rows, so seven symmetric matrices cannot occupy only the 1,176 bytes required by 147 binary doubles. Repacking the complete native object can also expand defaults and duplicate shared strings.

The annotation uses 21 lower-triangular values per matrix (`LTM`), decimal spellings that round-trip exactly, shared metadata strings, and absent fields for unstated NaN defaults. Each block retains its frame, units, model identity, age and uncalibrated realism label. Redundant explanatory comments are omitted. The input record remains embedded verbatim and the replacement root references its existing tables. The primary formal covariance, its propagation metadata, orbital elements, weather and fit statistics remain unchanged.

The annotation tests verify original byte ranges and pointer targets, identical AP states and formal covariance at ten epochs, identical SGP4 propagation, and agreement with the established population model. A comparison of 1,000 fitted products also verifies exact old/new population values and labels and identical browser/native compact output bytes.

## Serialized-size accounting

A synthetic initial fit occupies 4,540 framed bytes. Unpacking and repacking it through the native object API produces 5,088 bytes: 272 bytes of explicit NaN defaults, 88 bytes of empty-vector offsets, 88 bytes of vector headers, 78 bytes of vtables, 7 bytes of table padding, 20 bytes of other alignment, and 5 fewer bytes of default scalar fields.

For that 5,088-byte supplied record, the previous and compact annotations have these complete byte counts:

| Allocation | Previous | Compact |
| --- | ---: | ---: |
| Original record retained verbatim | 5,088 | 5,088 |
| New framing | 12 | 12 |
| Vtables | 278 | 212 |
| Table headers | 64 | 64 |
| Offsets | 540 | 512 |
| Vector headers | 64 | 64 |
| Strings, including covariance rows | 8,277 | 3,801 |
| Scalar fields | 248 | 241 |
| Explicit NaN defaults | 768 | 0 |
| Table padding | 96 | 67 |
| Other alignment | 133 | 43 |
| **Total** | **15,568** | **10,104** |

Covariance row strings account for 5,773 and 3,378 bytes, respectively. The previous annotation's native-object repack occupies 15,328 bytes; changing the history fixture's name and creation-date text adds 40 bytes, producing the separate 15,368-byte history-fixture measurement. These sizes describe different serialization steps.

## Compression sample

The sample comprises 1,000 actual native exact-W fits with distinct synthetic identities, 37 repeating near-circular orbital phases, and shared weather. Both encodings contain the same matrices and labels. Repeated orbital content especially favors zstd; these are synthetic comparisons rather than predictions of real catalog transfer sizes.

| Encoding, 1,000 records | Previous bytes | Compact bytes |
| --- | ---: | ---: |
| Raw framed stream | 15,318,712 | 9,857,952 |
| gzip default level 6 | 2,614,673 | 2,248,888 |
| zstd default level 3 | 159,343 | 113,293 |

Individual records range from 15,280–15,336 bytes before compaction and 9,840–9,880 after it. Arithmetic scaling of the exact sample gives these product payloads; indexes, sidecars and transport are excluded:

| Objects | Previous raw bytes | Compact raw bytes | Previous / compact gzip bytes | Previous / compact zstd bytes |
| --- | ---: | ---: | ---: | ---: |
| 33,000 | 505,517,496 | 325,312,416 | 86,284,209 / 74,213,304 | 5,258,319 / 3,738,669 |
| 100,000 | 1,531,871,200 | 985,795,200 | 261,467,300 / 224,888,800 | 15,934,300 / 11,329,300 |
