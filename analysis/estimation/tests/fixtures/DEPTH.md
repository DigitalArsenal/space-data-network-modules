# Estimation depth: numerical authority

All physics/estimator computations are C++; JavaScript routes binary messages
and compares results. None of the expected states or covariances comes from the
new estimator. The legacy fixture document retains the Gaussian, media, IOD and
Hipparchus sources. This document supersedes its first-pass statements that UKF
propagation and nonlinear recentering were untested.

## Independent Orekit EKF and UKF PV scenario

Sources:

- [Orekit 13.1 sequential UKF tests](https://www.orekit.org/site-orekit-13.1/xref-test/org/orekit/estimation/sequential/UnscentedKalmanEstimatorTest.html),
  documented PV measurement estimation pattern.
- [Orekit 13.1 KeplerianPropagatorBuilder](https://www.orekit.org/site-orekit-13.1/apidocs/org/orekit/propagation/conversion/KeplerianPropagatorBuilder.html).
- Released `org.orekit:orekit:13.1` and `org.hipparchus:hipparchus-*:4.0.1` from
  [Maven Central](https://repo.maven.apache.org/maven2/org/orekit/orekit/13.1/).

`OrekitReference.java` executes the real Orekit `KalmanEstimator` and
`UnscentedKalmanEstimator` against the same ten six-component PV observations.
This is a reproducible **adaptation** of the documented PV scenario, not a claim
to reproduce the upstream ground-station/range test suite. It uses Cartesian
parameters, GCRF, epoch **2000-01-01 12:00:00 TAI** (JD 2451545 label), mu
**3.986004418e14 m³/s²**, and two-body motion. No Earth orientation or UTC data
are needed. The UKF uses alpha=1, beta=2, kappa=0 in six dimensions.

Truth initial state: `[7000000,0,0,0,7500,1000]` in m and m/s.
Prior: `[7000100,-80,60,.1,7499.92,1000.05]`.
Prior covariance: `diag(10000,10000,10000,.01,.01,.01)` in matching SI units.
Q=0. Observations occur every 60 seconds through 600 seconds; Orekit analytic
truth PV is offset by `[2,-1,3] m` and `[.002,-.001,.003] m/s`. Observation sigmas
are `[10,10,10,.01,.01,.01]`. The exact measurement values and Orekit posterior
are stored in `orekit-pv-reference.txt`, 20 rows, with columns:

`estimator ordinal, elapsed seconds, measurement[6], posterior[6], covariance[36]`.

Native and WASM tests compare **every element at all ten epochs** for each
estimator. Tolerances: position **1e-6 m**, velocity **1e-8 m/s**, each covariance
entry **1e-6 in its corresponding SI units**. These allow the independent
C++ RK4 propagation/variational integration (steps <=1 s) to differ from
Orekit's analytic Keplerian propagation and operation ordering. Measured errors
are orders of magnitude below those bounds. The RK4 provider's equation is
Newtonian `r''=-mu*r/|r|³`; its STM integrates the analytic gravity gradient.
This provider is test-only, never the production estimator's dynamics.

The WASM test uses a separately SDK-built C++ WASM provider. It invokes the
estimator ten times for propagation and once for completion, returning 10 EKF
or 130 UKF propagated seeds. Binary object bindings preserve seed bits; a changed
seed is tested for explicit protocol rejection. Query, intermediate and final
replay inputs also pass tri-runtime parity.

### Regeneration

Download Orekit 13.1 and Hipparchus 4.0.1 core, geometry, ode, filtering, optim,
stat and fitting JARs to a temporary directory from their Maven paths. Then:

```sh
javac -cp '/tmp/lane05-orekit/*' -d /tmp/lane05-orekit tests/fixtures/OrekitReference.java
java -cp '/tmp/lane05-orekit/*:/tmp/lane05-orekit' OrekitReference > tests/fixtures/orekit-pv-reference.txt
```

SHA-256 checks:

| Input | SHA-256 |
| --- | --- |
| Orekit 13.1 JAR | `bbda7dae7ddaf6b5b4464548ee2519c545b59f24117ef790fc34d5bbef3f7407` |
| Hipparchus core 4.0.1 | `944a55c3a1b13b0a0c9c4db6dbb79c33b1b49511ab7430b6cdc69dc046154a87` |
| Hipparchus filtering 4.0.1 | `d15bf8a00f9b2b434028b498ed7c453b1f1c9fe5109e33475a49cac786fadc6c` |
| Reference text | `2f9d748cb3931224a9db0388bff6180cd26c5291274b78f3445a1e0110b750bb` |

## Nonlinear transform and recentering

Authority: Wan and van der Merwe, *The Unscented Kalman Filter for Nonlinear
Estimation*, IEEE AS-SPCC 2000,
[DOI 10.1109/ASSPCC.2000.882463](https://doi.org/10.1109/ASSPCC.2000.882463),
and [Hipparchus MerweUnscentedTransform](https://www.hipparchus.org/apidocs/org/hipparchus/util/MerweUnscentedTransform.html).

A test port maps x to x²; other five coordinates pass through. This abstract
inertial Cartesian test assigns the coefficient implicit units of 1/m.
Prior mean x=2 m, variance .25 m², beta=2, kappa=0. The independent weighted
sigma formulas give mean 4.25 m and variance
`4 + (5 alpha² + 2)/16 m²` for alpha=1 and .5. This is the **scaled UT moment**,
not a claim that the finite cloud reproduces every true Gaussian fourth moment.
Absolute error bound **2e-14** allows double rounding. EKF predicts x=4 m and
variance 4 m²; UKF therefore cannot be an alias. At the next epoch the provider's
central seed must equal the preceding posterior exactly. The test checks all
26 callbacks and exercises RTS with the nonlinear cross-covariance.

## Linear, PV and GNSS exact conditioning

Authority: [Boyd EE363 lecture 8](https://ee363.stanford.edu/archive/lectures/kf.pdf)
and [ESA GNSS basic observables](https://gssc.esa.int/navipedia/index.php/GNSS_Basic_Observables).
These are closed-form Cartesian Gaussian cases, elapsed TAI seconds, SI units:

- Unit P/R, six-component PV observation `[2,4,6,8,10,12]`: all three estimators
  give half the observation and covariance `.5 I`. Bound **1e-14** for native
  and binary-decoded WASM.
- Eight-state unit prior, linear H observing `x+b`, z=4 m, R=1 m²: posterior x
  and b are 4/3 m, their cross covariance is -1/3 m². Bound **1e-14**.
- Receiver at origin, transmitter `[-20000000,0,0] m`, b0=100 m, drift=2 m/s,
  elapsed 10 s, satellite bias=7 m: corrected pseudorange is **20000113 m**.
  Innovation is zero, bias remains 120 m and drift 2 m/s; posterior drift
  variance is **3/103 m²/s²**. Bound **1e-12**, allowing the 20-million-metre
  subtraction and covariance operations. Generic tracking light-time/Sagnac
  flags are disabled because transmitter coordinates are already corrected.

## Adaptive controls

Authority: Mehra, *On the identification of variances and adaptive Kalman
filtering*, IEEE TAC 15(2), 175–184 (1970),
[DOI 10.1109/TAC.1970.1099422](https://doi.org/10.1109/TAC.1970.1099422).
The implemented **scalar covariance-matching restriction** and clipping are
explicit in the README; this is not the paper's unrestricted matrix identifier.

Exact linear test: unit initial x/vx covariance, CV dt=1 s, acceleration PSD
3 m²/s³, hence Qxx=1 m², S=4 m², innovation=3 m. Covariance matching yields
q_target=1+(9-4)/1=6; with rate .25, q_next=**2.25**. The second epoch reports
that scale and larger predicted covariance. Bound **1e-14**. Disabling the
control leaves the scale exactly one.

R inflation test: unit P/R, innovation=10 m, three-sigma edit. Minimum passing
R scale is **100/9-1**, within **1e-10** for the bounded bisection. With cap=2
the vector is rejected. Both controls default off. These test mathematical
updates and gating, not broad empirical adaptive-noise performance claims.

## Nonlinear asynchronous fusion and statistical consistency

The original [Battin/MIT CW circular truth](README.md) scenario is retained,
including 40 range/az-el/co-orbiting range observations, equal epochs, covariance,
seed, frames, sigmas and direct truth geometry. **Both EKF and UKF now call the
independent nonlinear two-body/STM provider after each update**, rather than
using a once-linearized nominal trajectory. Each has 500 independent runs using
identical prior and measurement noise draws. No filter output generates truth.

The original NIST/SciPy 99% chi-square intervals remain unchanged:
ANEES `[5.60846959,6.40655574]` (df=3000), summed NIS per degree of freedom
`[.97776439,1.02251913]` (df=26500). RTS must reduce ensemble position MSE and
all covariance diagonals (1e-7 arithmetic allowance). Improvement for each
individual noisy realization is not guaranteed.

Detailed measured errors and ensemble statistics are recorded in
`conformance/estimation-evidence.json` and the lane handoff.
