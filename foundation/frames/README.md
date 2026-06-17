# Foundation Frames

`foundation/frames` provides a standalone SDK-compliant C++/WASM module for SDS `FRM` frame and geodetic transform requests. The first supported surface ports Basilisk `geodeticConversion` utility tests for PCI/PCPF position transforms, ellipsoid-based LLA/PCPF conversion, and Basilisk's negative-polar-radius spherical LLA/PCPF branch.

## Build

```sh
npm install
npm run build
npm test
npm run test:sdk-compat
```

The module accepts `FRMFrameTransformRequest` envelopes on the `request` port and emits `FRMFrameTransformResult` envelopes on the `result` port.
