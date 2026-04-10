# Module Test Matrix

This repository's SDK module verification is intentionally limited to packages
that publish canonical module artifacts and can be exercised through
`space-data-module-sdk` host surfaces only.

Run the full matrix with:

```bash
bash scripts/test-all-module-packages.sh
```

Included package tests:

- `packages/atmosphere`
- `packages/cislunar`
- `packages/conjunction-assessment`
- `packages/fred`
- `packages/hpop`
- `packages/maneuver`
- `packages/od`
- `packages/protection-key-server`
- `packages/protection-license-client`
- `packages/sgp4-propagator`
- `packages/plugin-delivery`
- `packages/client-decrypt`

Excluded package directories:

- `packages/fastest-path`
- `packages/sensor-shaders`
- `packages/sgp4`
- `packages/viewshed-shader`

These excluded directories do not currently ship a package-local
`plugin-manifest.json` plus canonical `dist/isomorphic/module.wasm` artifact, so
they cannot be truthfully exercised through the SDK browser harness or WasmEdge
loader in the same way as the authored module packages above.
