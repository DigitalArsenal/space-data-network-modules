# @orbpro/plugin-viewshed-shader

OrbPro Viewshed Shader Plugin.

Provides GPU-accelerated viewshed and line-of-sight rendering for ground-based sensor coverage visualization. Integrates with the OrbPro/CesiumJS rendering pipeline via custom GLSL shaders compiled to WebAssembly.

## Installation

```bash
npm install @orbpro/plugin-viewshed-shader
```

This package is intended to be used within an OrbPro workspace or alongside the OrbPro engine. Standalone use requires the module SDK.

## Building

Build the WASM artifact using the module SDK:

```bash
# From within the module SDK workspace:
npm run build:viewshed-shader
# Output: dist/viewshed-shader.wasm
```

## Usage

### Via SDN Plugin Delivery (ecies-decrypted bytes)

```javascript
import { createViewshedShaderPlugin } from "@orbpro/plugin-viewshed-shader";

// wasmBytes are delivered pre-decrypted by the SDN plugin-delivery system
// (ecies-x25519-hkdf-sha256-aes-256-gcm)
const plugin = await createViewshedShaderPlugin({ wasmBytes });
```

### Direct / Development

```javascript
import { createViewshedShaderPlugin } from "@orbpro/plugin-viewshed-shader";

// Without wasmBytes, loads raw WASM from dist/viewshed-shader.wasm
const plugin = await createViewshedShaderPlugin();
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `wasmBytes` | `Uint8Array` | Pre-decrypted WASM bytes from the SDN delivery system. |
| `recipientPrivateKey` | `string` | Optional SDK 0.8 recipient key override for encrypted module envelopes. |
| `lowMemory` | `boolean` | Use reduced memory configuration. |

## License

UNLICENSED — Proprietary. All rights reserved by DigitalArsenal.io, Inc.
