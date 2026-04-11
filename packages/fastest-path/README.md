# Fastest Path

Fastest Path is the OrbPro single-source shortest-path analysis module.
It keeps the canonical plugin ID `com.orbpro.fastest-path` and the existing
OrbPro method IDs:

- `create_graph`
- `ingest_edges`
- `ingest_csr`
- `compute_shortest_paths`
- `reconstruct_path`

## Layout

- `plugin-manifest.json` is the authoring manifest.
- `dist/isomorphic/module.wasm` is the canonical shared runtime artifact.
- `dist/browser/module.js` and `dist/browser/module.wasm` are browser-side
  publication artifacts.
- `tests/sdk_compat.test.mjs` validates the package against the SDK contract.

## Build

```bash
bash build.sh
```

The build script uses the repo-local `deps/emsdk` checkout and compiles the
package-local C++ source into the canonical SDK browser and isomorphic paths.

## Verification

```bash
node --test tests/sdk_compat.test.mjs
```

## Notes

This package is a module package, not a JS wrapper API. Consumers should load
`dist/isomorphic/module.wasm` through the SDK host or browser harnesses.
The package entrypoint still exports `createFastestPathSolver` for OrbPro
bridge compatibility, alongside the canonical artifact paths.
