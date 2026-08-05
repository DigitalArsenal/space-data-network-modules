# Cell Towers Worldwide

This package is the canonical provider inventory and normalization seam for
cellular cells, radio sites, antenna structures, and regulator station data.
It deliberately keeps sources with login, API-key, attribution, share-alike,
non-commercial, or provider-specific terms in the inventory. Those conditions
are metadata for the caller to enforce; they are not reasons to hide a source.

The registry does not claim that every radio site is a cellular base station.
Each record keeps its provider and native identity so downstream classification
can distinguish observed cells from licensed stations, antenna structures,
coverage products, and operator-reference data.

## Browser and Node API

```js
import {
  ingestRecords,
  listProviders,
  parseCsv,
} from "@spacedatanetwork/cell-towers-worldwide";

const source = listProviders({ coverage: "global" })[0];
const rows = parseCsv(csvText);
const result = ingestRecords(source.id, rows, {
  retrievedAt: new Date().toISOString(),
  onInvalid: "skip",
});
```

The returned objects are schema-neutral ingestion values, not an invented SDS
record. Fields include a stable provider-qualified ID, location, radio/cell
identity when available, operator/frequency metadata, and a complete provenance
block carrying source URL, retrieval time, licence URL, and attribution.

Network I/O and credentials stay in the host. Adapters accept already fetched
records, so the same code runs in browsers, Node, workers, and tests without
shipping secrets or bypassing provider terms.

## Registry maintenance

- Add official authority/catalog URLs, not third-party mirrors, where available.
- Set `loginRequired` and `credentialEnv` honestly.
- Use `interactive-public` when there is no documented bulk/API endpoint; never
  encode an undocumented scraping endpoint.
- Retain retired sources with an explicit note when they matter for historical
  provenance.
- Update `verifiedAt` only after checking the authority page and access posture.
- Run `npm test` and `npm run check:registry`.

This registry is exhaustive against its stated inclusion policy as of
`reviewedAt`. It is designed for additions without adapter rewrites: unfamiliar
tabular exports use canonical aliases or a provider `fieldMap`, while genuinely
new formats get a named adapter and fixture.
