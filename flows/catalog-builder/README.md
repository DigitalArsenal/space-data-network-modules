# Catalog chain adapter

This package runs `sdn-ap`'s unchanged `ingest_omm`, `propagate`, and `fit`
methods with isolated inputs and outputs. It sets the OEM's usable interval
to the full requested flight before fitting. The caller supplies both PCF
records and the weather stream.

`run_chain` returns the original SGP4 record on `fallback`, an AP candidate
on `elements` after a successful fit, and a typed QRP outcome on `decision`.
A propagation or fit refusal returns the fallback and named error without a
partial candidate. An ingestion refusal has no fallback. A successful fit
is a candidate; catalog acceptance also requires its fit statistics and the
configured eligibility and validity rules.

The adapter copies inputs between method calls and bounds captured outputs
at 16 MiB. The compiled artifact includes the propagator implementation.
These costs are additional to the direct method calls. The source reader,
durable controller, population-covariance annotation, index replacement,
and publication service are absent from this package.

Build the unsigned `propagator/sdn-ap` package to prepare its generated C++
translation unit, then run `SDM_MODULE_UNSIGNED_BUILD=1 node build.mjs` in
this directory. `CATALOG_BUILD_DIR` selects an alternate output directory.
The build consumes the propagator translation unit without numerical edits.

Run `node --test tests/sdk_compat.test.mjs` against the adapter and propagator
artifacts. `CATALOG_CHAIN_WASM` and `SDNAP_WASM` select alternate artifacts.
The synthetic fixture checks byte equality to direct calls, named fit
refusal, recovery after refusal, and rejection of surplus inputs. It does
not establish orbit accuracy or production catalog throughput.
