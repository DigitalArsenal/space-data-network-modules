# @orbpro/plugin-fastest-path

OrbPro Fastest Path Solver Plugin.

Computes optimal orbital routing and fastest-path solutions between space objects, ground stations, and relay nodes. Accounts for orbital mechanics, link budgets, and coverage windows. Distributed as a compiled ES module.

## Installation

```bash
npm install @orbpro/plugin-fastest-path
```

This package is intended to be used within an OrbPro workspace or alongside the OrbPro engine. Standalone use requires the OrbPro plugin-sdk.

## Building

Build the module using the OrbPro plugin-sdk:

```bash
# From within the OrbPro plugin-sdk workspace:
npm run build:fastest-path
# Output: dist/fastest-path.mjs
```

## Usage

### Via SDN Plugin Delivery (ecies-decrypted bytes)

```javascript
import { createFastestPathSolver } from "@orbpro/plugin-fastest-path";

// wasmBytes are delivered pre-decrypted by the SDN plugin-delivery system
// (ecies-x25519-hkdf-sha256-aes-256-gcm)
const solver = await createFastestPathSolver({ wasmBytes });
```

### Direct / Development

```javascript
import { createFastestPathSolver } from "@orbpro/plugin-fastest-path";

// Without wasmBytes, loads raw module from dist/fastest-path.mjs
const solver = await createFastestPathSolver();
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `wasmBytes` | `Uint8Array` | Pre-decrypted module bytes from the SDN delivery system. |
| `decryptFn` | `Function` | Legacy AES-256-GCM decrypt function (protection-runtime). |
| `lowMemory` | `boolean` | Use reduced memory configuration. |

## License

UNLICENSED — Proprietary. All rights reserved by DigitalArsenal.io, Inc.
