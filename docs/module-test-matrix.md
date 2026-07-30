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

Excluded package directories:

- `delivery/plugin-delivery`

Closed-tier modules are verified in the private
`space-data-network-closed-modules` repo, not here: the whole `comms/` RF
family, `shaders/sensor-shaders`, `shaders/viewshed-shader`,
`analysis/fastest-path`, `analysis/sensor-coverage` and
`analysis/sensor-model` now live at `packages/<name>` there and run under that
repo's `npm test`.

`delivery/plugin-delivery` is intentionally excluded from the default matrix.
It is a legacy compatibility fixture for client-decrypt round-trip tests. New
protected module publication and grant issuance must use `licensing/core`,
which publishes encrypted content once and returns provider-signed grants with
recipient-specific wrapped keys.
