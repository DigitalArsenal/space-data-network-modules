# @orbpro/plugin-hpop

OrbPro High-Precision Orbital Propagator (HPOP) Plugin.

Implements a high-fidelity numerical orbit propagator accounting for full geopotential models, atmospheric drag, solar radiation pressure, and third-body perturbations. Compiled to WebAssembly for high-performance, cross-platform use.

## Installation

```bash
npm install @orbpro/plugin-hpop
```

This package is intended to be used within an OrbPro workspace or alongside the OrbPro engine. Standalone use requires the OrbPro plugin-sdk.

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
| `decryptFn` | `Function` | Legacy AES-256-GCM decrypt function (protection-runtime). |
| `lowMemory` | `boolean` | Use reduced memory configuration. |

## Verification

Run the full package suite:

```bash
npm test
```

That covers:

- SDK artifact compliance and harness loading in `tests/sdk_compat.test.mjs`
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
