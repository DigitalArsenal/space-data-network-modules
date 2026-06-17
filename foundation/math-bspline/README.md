# Foundation Math B-Spline

`foundation/math-bspline` is the shared SDS BSP interpolation module for
Basilisk-compatible three-axis B-spline waypoint interpolation. It consumes a
`BSP.fbs` envelope carrying `BSPInterpolationRequest` and emits a `BSP.fbs`
envelope carrying `BSPInterpolationResult`.

The current surface covers Basilisk `BSpline.interpolate()` behavior for
time-tagged 3D waypoints, polynomial orders up to the supported waypoint plus
endpoint-constraint rank, and optional first- and second-derivative endpoint
constraints. The numerical test vector is the upstream Basilisk
`src/architecture/utilitiesSelfCheck/_UnitTest/test_BSpline.py` parameter sweep
for orders 5 and 6 with 1e-6 absolute tolerance.

```bash
npm install
npm run build
npm test
```
