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

## Reference-frame conventions

The shared C++ axis engine includes selectable IERS1996 and IERS2003 Earth
chains, VNC and named SEZ/ENU/NED rotations, and full built-in IAU body models
for Moon, Mars, Venus, Mercury, Jupiter, Saturn, and Sun. Existing FRM
`BODY_FIXED` requests use those models, including periodic terms. The new
Earth/local names require an SDS `rfmAxisType` extension before they can be
selected through FRM.

See [conventions, schema limitations, and authoritative tests](docs/reference-frames.md)
for time scales, correction handling, lunar model provenance, and reproduction
commands.
