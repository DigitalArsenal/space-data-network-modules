# Reproducible matching and identity review

Version 0.1.9 completes the APP workflow around `match_catalog`. Provider records
and CAT precedence are independent of the identity decision log.

`app/crosswalk.js` accepts at most 8 MiB / 100,000 datefirst rows. It retains raw
lines, original leading-zero identifiers, normalized decimal IDs, detection dates,
edition references and SHA-256. Unknown dates stay absent; impossible dates are
invalid attributed rows. Duplicate and conflicting declarations are not silently
selected. Products must have distinct candidate IDs and immutable references.

`app/common-grid.js` is an APP host adapter. Epoch products pass through the
native public-format Vimpel normalizer when necessary, `foundation/frames` for
explicit GCRF normalization, `foundation/time` for UTC-to-TDB conversion, and the
selected PRW implementation for propagation. It serializes canonical SDS binary
requests and outputs, without implementing dynamics. The packaged HPOP choice is
replaceable with a PRW WASM artifact. Its hash is part of the review.

The automatic profile accepts 5–10,000 samples over at most seven days, starting
within seven days after the state epoch. Output is Earth-centered GCRF/UTC OEM,
km and km/s. It checks returned sample count, epoch, frame and finite components.
Model controls declare point-mass gravity, optional J2–J4 and analytical Sun/Moon;
drag and SRP are disabled. Area/mass and provider uncertainty do not become assumed
force coefficients or covariance. Prepared OEM uploads retain their own grids and
are refused by the matcher if the grids differ.

Reviews bind thresholds, crosswalk row evidence, input and trajectory hashes,
normalized-state hashes, module hashes, grid, model and numerical diagnostics.
Changing inputs invalidates a pending review. Only a compatible and unambiguous
result can be explicitly accepted with a reason. A connected identity group may
contain only one native ID per provider. A new association that contradicts a
previous accepted edge, including transitively through a third provider, is refused.
Revocation releases the binding while retaining its history. The node/app-scoped
host configuration stores at most 256 decisions / 768 KiB; export history before
reaching this bound. It is a user's review record, not a signed identity authority.

## Verification

- `npm test`: malformed/bounded input, duplicate and conflicting crosswalks,
  immutable reviews, persisted decisions, transitive conflicts, closed-form
  dynamics and existing composition/matching/epoch suites.
- `npm run test:parity`: same Catalog artifact in headless Chromium, native
  WasmEdge and container WasmEdge; byte-identical outputs for six numerical/error
  cases, 30 comparisons.
- `PLAYWRIGHT_MODULE=<playwright/index.mjs> SDN_APP_BRIDGE_MODULE=<host/module-app.js>
  node tools/verify-editor.mjs`: actual embedded APP with the host's existing
  sandbox/MessagePort bridge. Checks automatic preparation, explicit acceptance,
  reload persistence, zero external-origin requests and browser errors; emits a
  screenshot and JSON receipt. It hosts candidate artifacts temporarily and
  proxies discovery to the already-running local daemon. It does not install
  artifacts into the daemon.
- `node tools/screen-node-crosswalk.mjs GATEWAY ORBITS_CID DATEFIRST_CID`: bounded
  reads from an existing node's immutable IPFS publication, full native
  normalization, candidate selection and explicit missing-counterproduct report.
- `node tests/vimpel-live.mjs ELEMENTS_FILE EPHEMERIS_RAR`: independently held-out
  position validation/refinement against the provider's original ephemerides.

The independent circular case uses r=7000 km, mu=398600.4418 km³/s², GCRF and the
UTC epoch 2026-09-21T00:00:00Z over 120 seconds. Tolerances are 1 m in a position
component and 0.001 m/s in a velocity component, allowing double-Julian-date
quantization and native integration error. Its finite-difference threshold is
0.1 m/s because timestamp quantization is amplified by differentiation. These
are test bounds, not provider-identity calibration.

See `verification-workflow-20260927.json` for measured hashes and results. The
local daemon's discovery failure and missing independent counterproducts are
recorded as limitations. Successful provider-product consistency does not establish
absolute accuracy, identity truth, independent corroboration or a collision risk.
