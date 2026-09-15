# Lane 05 authoritative numerical cases

Second-pass nonlinear UKF, Orekit orbital comparisons, GNSS and adaptive-noise
authorities are documented in [DEPTH.md](DEPTH.md). Its nonlinear Monte Carlo
protocol supersedes the first-pass affine description below.

These are test-only providers and references. Production physics remains in
C++ WASM. No filter output is used to manufacture expected values. Epochs are
elapsed seconds with JD 2451545 **TAI** as the invoke label (the current report
wire's convention). None of these cases needs a UTC/TAI conversion. Cartesian
units are m and m/s; covariance blocks are m², m²/s and m²/s². Angles are rad.

## Exact Gaussian conditioning

[Boyd, EE363 lecture 8](https://ee363.stanford.edu/archive/lectures/kf.pdf),
measurement conditioning and covariance/time-update formulas. A zero-mean,
inertial Cartesian prior has position covariance
`[[4,3,0],[3,9,0],[0,0,16]] m²`, unit velocity variances and no position/velocity
cross terms. The position observation is `[2,-1,3] m`, with independent
variances `[1,4,9] m²`. The time transition is identity; process noise is zero.

Direct rational conditioning gives:

- Posterior position `[83/56, -3/14, 48/25] m`.
- Posterior position covariance `[[43/56,3/14,0],[3/14,18/7,0],[0,0,144/25]] m²`.
- NIS `2229/1400` (dimensionless).
- Postfit residuals `[29/56,-11/14,27/25] m`; RMS is the square root of their
  mean square. The same conditioned solution is the batch WLS/MAP optimum.

The native maximum absolute tolerance is **2e-14** in each stated quantity,
allowing double-precision operation ordering on a well-conditioned rational
problem. WASM invoke comparisons decoded through flatc JSON use **2e-12**:
flatc rounds doubles to 12 decimals. The OCM's 21 packed covariance entries
are decoded as binary doubles and retain the **2e-14** bound.

A last-component outlier must restore the *whole* prior, including covariance.
Sixteen malformed-input probes test explicit rejection, including descending
and mismatched epochs, invalid sigmas/kinds/counts, singular STM and bad noise.

## Published Hipparchus smoother scenario

Source: **Hipparchus 4.0.3**, Apache-2.0:

- [SmootherTest.java](https://github.com/Hipparchus-Math/hipparchus/blob/4.0.3/hipparchus-filtering/src/test/java/org/hipparchus/filtering/kalman/SmootherTest.java),
  `testExtendedSmootherObserver` / `testUnscentedSmootherObserver`.
- [cv-smoother.txt](https://github.com/Hipparchus-Math/hipparchus/blob/4.0.3/hipparchus-filtering/src/test/resources/org/hipparchus/filtering/kalman/cv-smoother.txt),
  copied verbatim with license and notice alongside it.

The source's abstract 1D model is interpreted in m, m/s and s, embedded in the
independent Cartesian x/vx subspace. Initial mean `[0,-0.5]`, covariance
`diag(0.01,0.25)`, position measurement variance `0.001`, acceleration PSD
`0.1 m²/s³`, and `Q=q[[dt³/3,dt²/2],[dt²/2,dt]]`. Other Cartesian axes are
independent and do not affect the reference subspace. No gravitational frame
is implied; it is a constant-velocity inertial reference problem.

All **50 measured epochs** (0.1 through 5 s) are compared with the published
smoothed mean and covariance. The source also includes the initial smoothed
state; our public history starts with the first observation, so that one row
is excluded explicitly. Native tolerance **1e-12** in state/covariance units
allows six-state embedding and operation-order differences. WASM JSON decoding
uses **2e-12** for the rounding reason above. The linear-dynamics legacy UKF
special case passes this reference; this does not validate nonlinear UKF
propagation. No claim is made that this is Orekit's full orbital scenario.

`generate-cv-inputs.py` reproduces the test provider input JSON from the
published measurements and the analytic constant-velocity transition.

## Asynchronous radar / co-orbiting spacecraft fusion

Authority: [Battin, MIT 16.346 lecture 26](https://ocw.mit.edu/courses/16-346-astrodynamics-fall-2008/e4f0632a9f1c98f7e9b25492e1a30eb1_lec_26.pdf),
exact CW variational solution. The independent C++ provider transforms its
rotating radial/along-track/cross-track STM to inertial Cartesian at both
endpoints, including the angular-velocity velocity terms. The nominal circular
orbit uses radius **7,000,000 m**, mu **3.986004418e14 m³/s²**, inclination
**0.6 rad**, and initial phase **0.2 rad**, in an Earth-centered inertial frame.

The test uses 40 chronological observations with 7/13/0/13-second spacing
(including simultaneous sensors), interleaving range (10 m sigma), az/el
(1e-5 rad each), and spacecraft crosslink range (3 m sigma). Radar geometry is
an idealized platform fixed at `[6378137,0,0] m` in the reference frame, with
E/N/U axes +y/+z/+x; it is not a rotating-Earth ground-station simulation. The
spacecraft sensor is on the same orbit, advanced by 120 seconds. The existing
crosslink ABI represents that observing spacecraft in `station_position_m` /
`station_velocity_mps`. Light time, Sagnac and media are off to isolate the
sequential filter. Truth measurements use direct analytic geometry, never
`predict_measurement` or `simulate_measurements`.

**500 independent runs**, fixed mt19937_64 seed `0x15e57`, correlated Gaussian
initial errors and independent observation noise. The lower prior factor has
diagonal `[100,100,100,0.1,0.1,0.1]`, with `L(y,x)=60`, `L(z,x)=-20`,
`L(vx,y)=0.03`. Process noise is zero. The port nominal is the initial prior
perturbation propagated with the independent CW transition. Thus the test
validates nominal-trajectory error-state filtering, not arbitrary nonlinear
repropagation after measurement updates.

[NIST chi-square definition](https://www.itl.nist.gov/div898/handbook/eda/section3/eda3666.htm)
supplies the consistency law. Independent SciPy `chi2.ppf([.005,.995], df)`
quantiles give two-sided **99%** intervals (rounded outward):

- Final six-state ANEES: df=500×6=3000, divide by 500:
  **[5.60846959, 6.40655574]**.
- Summed NIS per degree of freedom: df=500×53=26500, divide by 26500:
  **[0.97776439, 1.02251913]**.

The confidence levels allow rare stochastic failures without relaxing state
accuracy into an arbitrary numerical tolerance. They are approximate for
nonlinear measurement models; initial perturbations are small relative to
orbital radius. RTS must reduce ensemble position MSE and every reported
covariance diagonal (1e-7 absolute arithmetic allowance). It need not improve
every individual realized error.

The deterministic WASM fusion case starts with `[120,-80,60] m` and
`[.12,-.08,.05] m/s` prior error and exact measurements. Final position must be
inside three times the posterior position sigma RSS; native Monte Carlo supplies
the stronger consistency check. The C++ test can regenerate its independent
port fixture (third CLI argument):

```sh
c++ -std=c++17 -O2 -Wall -Wextra -Werror -Isrc src/estimation.cpp tests/sequential_validation.cpp -o /tmp/lane05-sequential
/tmp/lane05-sequential tests/fixtures/hipparchus-cv-smoother.txt tests/fixtures/circular-fusion.json
python3 tests/fixtures/generate-cv-inputs.py
```
