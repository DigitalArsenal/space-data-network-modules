# @orbpro/plugin-hpop

OrbPro High-Precision Orbital Propagator (HPOP) Plugin.

Implements a high-fidelity numerical orbit propagator accounting for full geopotential models, atmospheric drag, solar radiation pressure, and third-body perturbations. Compiled to WebAssembly for high-performance, cross-platform use.

## Atmosphere models (honest labeling)

| Model name | Status |
| --- | --- |
| `NRLMSISE00` | **Full model.** The real NRLMSISE-00 (Picone/Hedin/Drob, JGR 2002) via the public-domain Brodowski C port vendored in `third_party/nrlmsise00/`. Drag uses the gtd7d "effective mass density" (includes anomalous oxygen). Verified against the canonical 17-case output table shipped with the reference package. |
| `USSA1976` | **Full lower-atmosphere model (0-86 km geometric).** US Standard Atmosphere 1976 with the proper geopotential-altitude layer formulation. Above 86 km it hands off to the Vallado exponential table (documented in code). |
| `Exponential` | Piecewise-exponential model, Vallado *Fundamentals of Astrodynamics and Applications* 4th ed., Table 8-4. |
| `JB2008` | **Simplified approximation only** — mimics the Jacchia-Bowman 2008 exospheric-temperature response to S10.7/M10.7/Y10.7 with a single-species barometric profile. NOT the published JB2008 coefficient model. |
| `DTM2020` | **Simplified approximation only** — mimics the DTM2020 F30/Hp temperature response. NOT the published DTM2020 spherical-harmonic model. |
| `GOST2004` / `HarrisPriester` | Enum placeholders; dispatch falls through to `NRLMSISE00`. |

The JSON `atmosphere` operation exposes only the honestly-implemented models
(`NRLMSISE00`, `USSA1976`, `EXPONENTIAL`).

## Installation

```bash
npm install @orbpro/plugin-hpop
```

This package is intended to be used within an OrbPro workspace or alongside the OrbPro engine. Standalone use requires the module SDK.

## Building

Build the canonical browser/WasmEdge artifact with the repo-local toolchain:

```bash
bash build.sh
```

Artifacts:

- `dist/isomorphic/module.wasm`
- `dist/browser/module.js`
- `dist/browser/module.wasm`

## Usage

### Via SDN Plugin Delivery (ecies-decrypted bytes)

```javascript
import { createHPOPPropagator } from "@orbpro/plugin-hpop";

// wasmBytes are delivered pre-decrypted by the SDN plugin-delivery system
// (ecies-x25519-hkdf-sha256-aes-256-gcm)
const propagator = await createHPOPPropagator({ wasmBytes });
```

### Direct / Development

```javascript
import { createHPOPPropagator } from "@orbpro/plugin-hpop";

// Without wasmBytes, loads the canonical artifact from dist/isomorphic/module.wasm
const propagator = await createHPOPPropagator();
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `wasmBytes` | `Uint8Array` | Pre-decrypted WASM bytes from the SDN delivery system. |
| `recipientPrivateKey` | `string` | Optional SDK 0.8 recipient key override for encrypted module envelopes. |
| `lowMemory` | `boolean` | Use reduced memory configuration. |

## Verification

Run the full package suite:

```bash
npm test
```

That covers:

- SDK artifact compliance and harness loading in `tests/sdk_compat.test.mjs`
- Resident-state binary stream method declarations in `tests/sdk_compat.test.mjs`
- Inter-module aligned-binary `PropagatorState` handoff from SGP4 to HPOP in
  `tests/intermodule_sgp4_import.test.mjs`
- Tudat-derived propagation regressions in `tests/tudat_wasm_derived.test.mjs`
- Stored Tudat reference vectors in `tests/fixtures/tudat.reference.json`

The Tudat-derived cases are copied from:

- `testTwoBodyPropagation` and `testHighFidelityPropagation` in
  `https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/test_propagation_node.cjs`

The local test preserves the same orbital scenarios and pass/fail thresholds,
adapted to this package's JSON command ABI and run through both the SDK browser
and WasmEdge harnesses. The checked-in fixture captures the sampled Tudat state
histories used by the package-local suite, so ordinary verification does not
need a live `../tudat-wasm` checkout.

## License

UNLICENSED — Proprietary. All rights reserved by DigitalArsenal.io, Inc.
