# Foundation Attitude Math

`foundation/attitude-math` provides a standalone SDK-compliant C++/WASM module for SDS `RBK` rigid-body kinematics requests. The first supported surface ports the Basilisk AVS self-check vectors for Modified Rodrigues Parameter, Gibbs-vector, principal-rotation-vector, and sequence-aware Euler-angle algebra; scalar-first Euler-parameter and direction-cosine-matrix conversions; first/second-order MRP plus first-order Gibbs/PRV/Euler differential kinematics; and the Basilisk `avsEigenSupport` elementary rotation-matrix and tilde-matrix utilities.

## Build

```sh
npm install
npm run build
npm test
npm run test:sdk-compat
```

The module accepts `RBKRigidBodyKinematicsRequest` envelopes on the `request` port and emits `RBKRigidBodyKinematicsResult` envelopes on the `result` port.
