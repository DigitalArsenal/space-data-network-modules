# Catalog nodes and composition

Owner request, 2026-09-07. This is the implementation plan; unchecked work is not a shipped capability.

## Intended result

Four independent provider nodes offer canonical SDS CAT records: CelesTrak, Jonathan McDowell GCAT, Mike McCants, and Vimpel. A customer installs the Catalog Editor module and opens its embedded SDS APP UI from Modules. The editor creates a reproducible composite catalog without changing provider records. It separately selects orbital-state sources per object, with an ordered fallback list, maximum age, and explicit missing/stale status.

## Implementation sequence

1. Preserve source identity. Identify each lane by node peer ID, provider, dataset, immutable publication head and original object key. Retain citations and license metadata. Use exact confirmed identifiers for joins; never merge by name, orbital proximity, or an invented NORAD number. Flag conflicting identifiers for user review. GCAT JCAT and Vimpel identifiers must remain namespaced, including objects without NORAD IDs.
2. Build the SDK module. Consume size-prefixed CAT FlatBuffers through the existing typed invocation contract. Keep composition, conflict decisions and state-source selection inside the module. Return canonical CAT records with retained provenance; persist the recipe separately from provider catalogs. Evaluate the schema coverage for recipes/provenance before introducing or extending any standard. Do not overload OBJECT_ID with a provider's non-COSPAR key.
3. Embed the editor as APP in the module's existing REC/MBL bundle. Verify the bundle and APP-to-WASM content hash before loading. Add a generic module UI launcher to the installed Modules tab. Load same-origin/inline assets with the existing APP runtime, cancellation and capability controls. Show layers, field conflicts, object overrides, and orbital-state source priority. Persist edits, support reload and export, and require explicit publication of a derived catalog.
4. Provider ingestion. Reuse the CelesTrak CAT flow. Add bounded WASM parsers/adapters for GCAT and the supported McCants element products; derive only CAT fields actually present in those products. Vimpel uses its original feed when reachable and configured. Do not label McDowell's vimcat mirror as a direct Vimpel node. Keep unavailable feeds visible as unconfigured, not empty or fabricated. Poll within provider cadence, preserve source hashes/terms, and avoid downloading full history at every start.
5. Node placement. Use a separate process, identity, data directory, journal, ports and resource budget per catalog node. Inventory remote RAM/disk/CPU and existing services before choosing placement. The owner's explicit multiple-node request supersedes the old one-daemon-per-box policy for these nodes. Build locally; stage and verify SDK artifacts and AOT cache before launch. Use existing signed updates and retain rollback. Do not share writable FlatSQL/Kubo directories across daemons.
6. Full-text search in every data table. Search the complete selected datastore before pagination, not the browser page. Use FlatSQL's supported indexed search facilities; prove availability against the actual pinned engine. Bind query text to cursor/snapshot identity, reset pagination on changes, cancel obsolete requests, and report index-warming separately from zero matches. Cover local/remote tables and editor tables, numeric IDs, punctuation, Unicode, clear, and no-match behavior. Keep FlatBuffers as transport and avoid a separate handwritten host search engine.
7. Store snapshot cache. Existing PMM/PLG, STF, DPM and DSS describe catalog/module/service offerings; no new standard is needed merely for cache policy. Persist the existing records per current node and provider identity. Restore before initial empty-state rendering, then refresh in the background. Replace only after a complete validated response, atomically; failed/partial refresh keeps the previous snapshot. Do not accumulate manifest versions or expose a retention toggle. Catalog cache does not confer an entitlement, installed status, live service health, or signature validity. Reverify signed records before use. Never cache grants, auth cookies, private keys or decrypted paid modules in this public listing cache.

## Verification and rollout gates

- Tests: exact-ID merge, source precedence, absent values, conflicts, unnumbered objects, round-trip recipes, per-object override/fallback/age checks; upstream format fixtures and canonical SDS decode.
- SDK: manifest/artifact compliance plus identical artifact invocation in browser, native WasmEdge and container WasmEdge. No JavaScript substitute for the module's composition logic.
- UI: real module launch; edit/save/reload; search match on an unloaded page; Next/Previous under a fixed snapshot; zero external requests, console errors or local-data fallback for remote tables.
- Cache: cold start, browser reload, node switch, offline refresh, invalid signature, withdrawn listing, older response arriving late, and overwrite semantics.
- Operational: each source node publishes actual CAT data with original source attribution; clean restart resumes persisted state; recovery does not block healthy peer admission; one busy node does not stop sibling APIs.
- Record exact component commits and artifact hashes. Land dependencies before consumers. Do not advertise unconfigured feeds, unverified composition results or source-only packages as operational.

## Source findings

- GCAT: https://planet4589.org/space/gcat/ — CC BY 4.0; multiple catalogs and JCAT identities; satcat100k contains extended Space Force numbers.
- McCants: https://mmccants.org/tles/ — current classified and integrated element archives; mcnames/vsnames removed. Element propagation provenance must distinguish integrated from observed/fitted solutions.
- Vimpel: https://spacedata.vimpel.ru/ — direct probe timed out; owner feed clarification requested. GCAT vimcat is a separate derived source.
- Existing UI bundle example: flows/supplemental-omm/scripts/package-bundle.mjs embeds APP.fbs in auxiliary entry app.app using the SDK createSingleFileBundle API.

## Status — 2026-09-08

The installed Catalog Editor 0.1.3 previously combined 70,587 objects from the
two CelesTrak publications on the existing remote provider, found
`norad:100087` beyond the first page through FTS5, and restored its recipe after
reopening. It has not yet completed a four-provider rollout. Orbital-state
preferences exist; live state fetching is unfinished.

Four new owner-local representative SDN instances are running at ports
7181–7184, each with its own SDN and Kubo identity, keys, data, journal and ports.
The GCAT, McCants and Vimpel instances retained their identities through a
controlled restart. All four Kubo blockstores connect to the customer's Kubo;
the customer trusts the four publisher peer IDs without granting admin access.
The stack's `deployment/catalog-nodes` scripts and README record lifecycle,
verified bundle staging, capabilities, loopback connections and rollout gates.

The dedicated CelesTrak node is importing an original SATCAT edition through
its existing SDK flow. Original HTTPS fetch works through an owner-local SSH
SOCKS tunnel to the existing VPS; TLS remains verified. Repeated datastore
writes dominate ingestion. Completion, immutable publication and customer
retrieval still require live verification. Its daily cadence is saved for
restart; no history was erased or timestamps fabricated to bypass retry logic.

Catalog Source 0.3.0 separates the pure parser from Catalog Fetch 0.1.0.
The final parser artifact passed 19 checks, including complete original GCAT
and McCants editions and byte parity in Chromium, native WasmEdge and container
WasmEdge. Four candidate product flows passed eight recovery scenarios each
against complete real downloads: GCAT 69,999/642 and McCants 407/63 records.
These flow checks used stub HTTP/storage capabilities, not live publication.

SDS 1.213.0 adds original catalog namespace and object ID fields, including
edition scoping for reassignable identifiers. Its schema/generated bindings
landed at `2a13500d07788f1233b422214daef3f4041b0022`; all 289 SDS tests passed.
The release remains incomplete because PyPI's legacy version ordering blocked
publication. The GitHub Packages consumer lookup also needs unavailable
`read:packages` scope. Do not advance consumers until the documented SDS
release gates are met. Current parser artifacts still use SDS 1.212.0 and
return native keys only in diagnostic metadata; GCAT/McCants feeds therefore
remain disabled rather than publishing records with lost identities.

Vimpel's instance is running without a configured feed. No original login or
export was found in the bounded local checks; the owner was asked for its
file path. The inspected original portal failed HTTPS hostname validation.
No credentials were sent over HTTP, and McDowell's Vimpel-derived catalog was
not substituted.

Remaining work: finish SDS visibility and the required SDN dependency refresh,
consume its native identity fields in both modules, enable GCAT/McCants feeds,
connect the original Vimpel export/HTTPS source, and repeat the installed-editor
checks against the independent nodes. The separately claimed SDN/UI source has
not been edited for this rollout. The earlier 15 stale graph tasks were cleared;
they are not current work.
