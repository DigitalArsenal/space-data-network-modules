# Module Test Matrix

This repository's SDK module verification is intentionally limited to packages
that publish canonical module artifacts and can be exercised through
`space-data-module-sdk` host surfaces only.

Run the full matrix with:

```bash
bash scripts/test-all-module-packages.sh
```

Included package tests:

- `propagator/atmosphere`
- `propagator/cislunar`
- `propagator/hpop`
- `propagator/sgp4`
- `analysis/conjunction-assessment`
- `analysis/maneuver`
- `analysis/od`
- `licensing/core`
- `licensing/client-decrypt`
- `licensing/protection-key-server`
- `licensing/protection-license-client`
- `delivery/plugin-delivery`
- `shaders/sensor-shaders`

Excluded package directories:

- `analysis/fastest-path`
- `shaders/viewshed-shader`

These excluded directories do not currently ship a package-local
`plugin-manifest.json` plus canonical `dist/isomorphic/module.wasm` artifact, so
they cannot be truthfully exercised through the SDK browser harness or WasmEdge
loader in the same way as the authored module packages above.
