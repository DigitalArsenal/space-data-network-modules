# RF phased-array beamforming

This pure transform consumes three SDS records: a `$PAP` array configuration,
a `$PAP` sampled element pattern, and a `$BEM` beam/hop schedule. It emits a
synthesized `$PAP`, hop samples as `$RFL`, and demand-ranked footprints as
`$CVP`. The browser and WasmEdge load the same `dist/isomorphic/module.wasm`.

All array-factor, steering, taper, scan-loss, grating-lobe, white-covariance
MVDR/LCMV, and footprint calculations run in the WASM guest. JavaScript may
decode the resulting sampled pattern but never synthesizes it.

`PAP.TAPER_PARAMETERS` is the explicit execution/configuration vector:
`[target sidelobe level dB, Taylor n-bar, thread count]`. Thread count is
clamped to 1, 2, 4, or 8. Workers own fixed contiguous sample ranges and the
caller reduces in index order, so output bytes do not depend on scheduling.

The sampled element pattern uses one `PAPGainCut` per clock angle. Each cut has
`AXIS=CONE`, `FIXED_ANGLE_DEG=<clock>`, and matching cone-angle/gain vectors.
The guest interpolates first in cone and then between adjacent clock cuts.

Build and test:

```sh
npm install
npm run build
npm test
```
