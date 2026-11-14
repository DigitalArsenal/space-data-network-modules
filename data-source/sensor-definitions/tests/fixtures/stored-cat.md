# Stored CAT identity fixture

`../stored-cat-fixture.mjs` encodes the identity columns of the existing recorded SATCAT cassette using published SDS CAT bindings, and tags the result as the local producer's `celestrak-satcat-csv` lane. The composed E2E returns those bytes through the real SDK `storage.query` hostcall. No provider is contacted.

`identity-equivalence.json` records SHA-256 of both sensor streams and their ingest metadata from the unmodified 0.1.1 artifact at modules commit `6eeff4b65`, using the same recorded source documents and `16Uiu2HAmTestProducer`. These hashes verify storage-input equivalence; the existing source-document E2E remains the scientific oracle. The SATCAT provenance byte count now measures the stored CAT records read, rather than CSV text that this flow no longer fetches.
