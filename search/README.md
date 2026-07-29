# `search/` — catalog semantic search

Own semantic search for the catalog: **"japanese satellites"**, **"international space station"**
and **"japanese space station"** answered correctly, entirely in the browser, with no
external-origin bytes.

## Shape

```
search/
  tools/              offline pipeline (Node) — runs at dataset publish time
  catalog-embedding/  the WASM module — runs in the browser and under WasmEdge
```

The split is the architecture: **the catalog is embedded once, server-side, by a full
transformer; only the QUERY is encoded in the browser, by a distilled static model.** The
expensive half runs where cost is paid once; the cheap half runs where latency is felt.

## Why a static encoder

The obvious approach — ship MiniLM to the browser — is what the node dashboard already does, and
it costs 23 MB of weights plus an 11 MB onnxruntime whose session-create measurably froze a main
thread for nine seconds (see `sdn-js/dashboard/src/semantic.worker.js`). That is unusable in
front of a search box.

The student here is a token-embedding table and nothing else:

```
encode(text) = L2normalise( Σ idf[t]·W[t] / Σ idf[t] )
```

A gather, a weighted sum, a normalise. No attention, no layers, no runtime. It is trained to
**regress the teacher's sentence vector**, so its output lands in the teacher's space and can be
dot-producted directly against the catalog table the teacher produced.

It does not lose to its teacher. Measured on 292 graded queries over 33,814 real objects, the
1.45 MB student scores nDCG@10 **0.417** against the teacher's **0.410** — because it was
distilled on OUR domain, and the teacher was not.

## Why hybrid

Semantics alone is not enough, and neither is filtering.

All four systems on the SAME 292 queries and the same graded judgements:

| system | recall@10 | nDCG@10 | MRR | top-1 |
|---|---|---|---|---|
| substring index (what /beta ships today) | 0.006 | 0.007 | 0.007 | 0.007 |
| teacher, full MiniLM query encoding | 0.474 | 0.410 | 0.577 | 0.391 |
| student, 1.45 MB static encoder | 0.495 | 0.417 | 0.573 | 0.388 |
| **hybrid — student + query planner** | **0.882** | **0.857** | **0.901** | **0.830** |

"launched in 2023" is a range predicate, not a similarity question. The planner
(`tools/lib/queryplan.mjs`) pulls that structure out and hands it to FlatSQL as a WHERE clause;
the embedding ranks what survives. Doubling nDCG is what that separation is worth.

## The part that is easy to get wrong

Retrieval quality here is **mostly a data problem, not a model problem.** Four bugs found during
the spike each silently destroyed a whole query family, and none of them would have shown up as
an error:

- SATCAT's trailing numeric columns are one field right of the published spec — 80% of apogees
  were dropped, and with them every orbital regime.
- `opStatus` was reading the payload flag, so operational status never reached a document at all.
- Constellation classification matched only the SATCAT name, so the real Hubble (named `HST`) had
  no mission, and the planner's own "telescope" filter excluded it from its own query.
- The Japanese ISS segment (Kibo) has no NORAD entry, so "japanese space station" could not be
  answered by any amount of similarity search until `nations[]` made partner countries explicit.

The eval set exists to catch exactly this class of failure, which is why its judgements are
recomputed from live catalog fields rather than frozen as a list of NORAD ids.

## Running it

```sh
node tools/build-corpus.mjs        --out data --on-orbit-only
node tools/embed-catalog.mjs       --corpus data --out data
node tools/distill-encoder.mjs     --data data --epochs 10
node tools/quantize-catalog.mjs    --data data
node tools/eval.mjs                --data data
node tools/demo.mjs                --data data "japanese space station"
node tools/export-browser-bundle.mjs --data data --out tools/browser-harness/assets
node tools/browser-harness/serve.mjs   # http://127.0.0.1:8199
```

Everything is offline: the teacher is the node's own staged `/embedding/model.onnx`, tokenized by
the node's own `wordpieceTokenize`, so there is no network dependency and no tokenizer drift
between the offline table and any runtime.

## In-browser measurements (Chrome, real page)

| | |
|---|---|
| encoder model | **1.45 MB** (3,832-token pruned vocab) |
| catalog table | **12.64 MB** int8, 33,814 × 384 |
| total ready | **46 ms** (24 ms fetch, 22 ms parse/init) |
| encode latency | **0.013 – 0.04 ms** |
| search latency | 0.01 – 5.9 ms filtered; **~10.2 ms** full 33,814-row scan (JS reference) |

The full-scan figure is the plain-JS reference; the WASM module's SIMD path exists to beat it.
