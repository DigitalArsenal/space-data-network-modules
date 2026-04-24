# @orbpro/plugin-sensor-shaders

OrbPro Sensor Shaders Plugin.

Provides a collection of GPU shaders for rendering sensor volumes, coverage cones, and field-of-view geometries in the OrbPro/CesiumJS visualization engine. Distributed as a compiled ES module.

## Installation

```bash
npm install @orbpro/plugin-sensor-shaders
```

This package is intended to be used within an OrbPro workspace or alongside the OrbPro engine. Standalone use requires the module SDK.

## Building

Build the module using the module SDK:

```bash
# From within the module SDK workspace:
npm run build:sensor-shaders
# Output: dist/sensor-shaders.mjs
```

## Usage

### Via SDN Plugin Delivery (ecies-decrypted bytes)

```javascript
import { loadSensorShaders } from "@orbpro/plugin-sensor-shaders";

// wasmBytes are delivered pre-decrypted by the SDN plugin-delivery system
// (ecies-x25519-hkdf-sha256-aes-256-gcm)
const shaders = await loadSensorShaders({ wasmBytes });
```

### Direct / Development

```javascript
import { loadSensorShaders } from "@orbpro/plugin-sensor-shaders";

// Without wasmBytes, loads raw module from dist/sensor-shaders.mjs
const shaders = await loadSensorShaders();
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `wasmBytes` | `Uint8Array` | Pre-decrypted module bytes from the SDN delivery system. |
| `recipientPrivateKey` | `string` | Optional SDK 0.8 recipient key override for encrypted module envelopes. |
| `lowMemory` | `boolean` | Use reduced memory configuration. |

## License

UNLICENSED — Proprietary. All rights reserved by DigitalArsenal.io, Inc.
