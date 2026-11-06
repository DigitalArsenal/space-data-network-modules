# Private screening protocol: registration

Registered 2026-11-06, before any row was read. This document fixes the
protocol, its parameters per step, the known-answer plan, the cost plan and the
reading rule for every figure. The rows appear in `results/` after the run and
the figures in the tables at the end of this document; nothing above the
results section changes once a row exists.

The design is `../docs/private-screening.md` with the owner's 2026-10-07
changes: no decoys; screening against another encrypted orbit, with no public
track on either side; the responder squares the requester's x, y, z itself; an
anchor-free physics check. The primitive is the FlatBuffers fork's homomorphic
batching API (`he_encryption.h` at fork commit 55a0ca86: BFV, three 60-bit CRT
plaintext moduli, every slot |v| <= 2^178 - 1, bound tracking, refusals; n 8192
or 16384). The protocol functions are pure: no network, no node. The exchange
is a separate record.

## 1. Parties, keys and inputs

- A (requester) holds a trajectory a(t) sampled on the protocol grid: UTC
  windows, step dt = 1 s, slot j of block w is t0 + (w n + j) dt. Coordinates
  are integer metres with declared bound 24 bits (|coordinate| < 2^24 m).
- B (responder) holds b(t) in the clear, sampled on the same grid.
- Requester-held keys. A generates one BFV key pair per window and per
  parameter set (n 8192 and n 16384) and sends B the public key and the
  relinearization keys. B's context is a server context: it holds no key that
  decrypts anything it receives, and the driver checks `HasSecretKey() ==
  false` on every B context. Per-window keys are the commitment: B keeps the
  ciphertexts it answered, A opens a window by handing over that window's
  secret key after the window, and nothing can be swapped. No hash commitment.
- B's own trajectory enters only encrypted under A's public key (B encrypts
  it), so the screening arithmetic is the same whether B's orbit is public or
  private: an encrypted orbit on each side, no public track needed on either.
- The fork API's plaintext operands are scalars applied to every slot
  (`AddPlain`, `SubPlain`, `MultiplyPlain` with one int64); it has no
  slot-wise plaintext vector. Every per-step value B contributes (its
  coordinates, its masks, its constants) is therefore encrypted under A's
  public key and combined ciphertext by ciphertext. The ct x ct multiplies of
  each step are listed below and counted in the run; there are no others.

## 2. Steps and their parameters

| Step | Depth | n | Ciphertext ops per block | Output |
| --- | ---: | ---: | --- | --- |
| S1 tube check | 1 | 8192 | 3 Sub, 3 Multiply (ct x ct), 2 Add, 1 Add (mask) | masked |a - p|^2 - D0^2 per step against A's declared public track p |
| S2 screening | 1 | 8192 | 3 Sub, 3 Multiply (ct x ct), 2 Add, 1 Add (mask) | masked |a - b|^2 - R'^2 per step |
| S3 physics check | 3 | 16384 | see below | masked E and F per step |
| S4 comparison | - | - | not built | one bit per step |

S1 and S2 are the same function with different operands and thresholds. B
squares A's coordinates itself: A sends Enc(x), Enc(y), Enc(z) only, never
|a|^2, so the false-|a|^2 hole of the first design (a requester declaring an
|a|^2 that is not x^2 + y^2 + z^2) does not exist. One ct x ct multiply per
coordinate per block: (Enc(a_k) - Enc(b_k))^2, three per block; the sum, less
the encrypted threshold, plus the encrypted mask, is the response.

S2 threshold: R' = sqrt(R^2 + (v_max dt / 2)^2) with R = 5 km, v_max =
15.5 km/s, dt = 1 s: R' = 9222.9 m, R'^2 = 85,061,864 m^2 (ceiling). S1
threshold D0 = 1 km (no declared burn in the known-answer set, so no
widening).

S3, the anchor-free physics check, needs no public track. A sends three
slot-aligned copies of its trajectory at n 16384: a(t - D), a(t), a(t + D) with
stride D = 60 s (the copies are A's declaration; their agreement with the n
8192 submission is checked when the window is opened, not in real time: the
API has no slot rotation). B computes the central second difference
d2 = a(t - D) - 2 a(t) + a(t + D) and two polynomial identities of two-body
motion, both free of |a|^3:

- direction (central force): a x d2 = 0, tested as
  F = 256^2 |a x d2|^2 - |a|^2 |d2|^2 <= 0 (depth 2);
- magnitude (inverse square): (a . d2)^2 |a|^2 = mu^2 D^4, tested as
  |E| <= mu^2 D^4 / 128 with E = (a . d2)^2 |a|^2 - mu^2 D^4 (depth 3); the
  band is derived in 2b (first written as 1/256, widened to 1/128 for J2
  before any run).

mu = 398600.4418 km^3/s^2 = 3.986004418e14 m^3/s^2; mu^2 D^4 for D = 60 s is
encrypted by B under A's key as a 16384-slot constant (bound 122 bits) and
subtracted. Tolerance 1/256 covers the integer-metre rounding (about 1e-4
relative) and the central-difference truncation (n^2 D^2 / 12, about 3.4e-4
relative at 7078 km) with margin; a straight line (d2 = 0) and an orbit flown at
the wrong rate fail the magnitude test. Depth 3 sits inside the fork's measured
n 16384 table (fresh 320 bits; 247, 173, 99 after 1, 2, 3 multiplies; 25 at
depth 4). ct x ct multiplies per block: 3 for |a|^2, 3 for a . d2, 1 for its
square, 1 for the product with |a|^2, 6 for a x d2, 3 for its squared norm, 3
for |d2|^2, 1 for |a|^2 |d2|^2: 21.

Masks. Every response carries an additive mask: B draws rho per slot,
uniform in [2^100, 2^119), encrypts the vector under A's key and adds it.
A decrypts value + rho and learns nothing about the value until the comparison
step S4 reveals the sign of value (and only the sign). S4 is a two-party
comparison (DGK or a garbled circuit); it is not built here, and the
known-answer run evaluates the decision with an oracle that holds both rho and
A's decryption. Until S4 exists the feature is offered on no host and no
console. The output through a multiplicative mask is not private: the bench
measured that neighbouring steps recover the distance within a factor of 2 at
87 % of steps (1 s), and the run restates that leakage from the plaintext
values of its own pairs with the bench's method (log-uniform r below 2^120,
64-step runs) under `maskLeakage`.

Laplace noise with a safety offset (defense 5) is applied in squared metres:
B adds eta to |a - b|^2 before the comparison, eta Laplace with scale beta
truncated at +/- S, S = 2 R' s + s^2, and the threshold is raised from R'^2 to
(R' + s)^2. For every step with d <= R', d^2 + eta <= R'^2 + S = (R' + s)^2:
the noise never hides a real alert. eta is fixed per (requester, object,
step) by a seeded generator. The known-answer run uses s = 0 (identity with
plaintext screening) and a second pass with s = 1.25 km, beta = S / 4 in
squared metres, whose rule is below.

No decoys: the submission is one trajectory per declared object; the driver
has no decoy count and the protocol has no decoy step.

### 2a. What B returns (amendment 2026-11-06, SDN-AP, before any row)

B's operands travel as ciphertexts under A's key, and A decrypts anything
under its key. Rule: B returns to A no ciphertext that is a function of B's
operands other than the registered masked outputs (one S1 response, one S2
response, the E and F responses of S3, per block). Every intermediate product
(B's encrypted coordinates, differences, squares, cross products, constants)
is consumed on B's side and never serialized toward A; the driver counts the
ciphertexts B returns per block (`returnedCiphertextsPerBlock`: S1 1, S2 1,
S3 2). Reconstruction attempt: over one full window A decrypts everything it
received (the masked S2 response), takes each decrypted slot as its best
estimate of |a - b|^2 - R'^2 and recovers B's distance per step
d = sqrt(max(v + R'^2, 0)); the position recovery of the bench's analysis
starts from these distances. The attempt must fail: the recovered distance is
within a factor of 2 of the true distance at no more than 0.1 % of steps (the
chance level of a uniform 2^119 mask is far below), and the median error in
log2 distance is reported. A recovered position or distance is a defect, not
a limit.

### 2b. Physics-check tolerance band (registered before any run)

Two-body identities fail on a real orbit by the perturbations. At altitude h
over Earth's radius R_E = 6378.137 km, the J2 acceleration relative to the
central one is about (3/2) J2 (R_E / r)^2 with J2 = 1.0826e-3: 1.32e-3 at
7078 km (A's orbit), 1.41e-3 at 6850 km (Swarm), 1.27e-3 at 7170 km
(Sentinel-1), 1.3e-4 at 26,560 km (GPS). Drag is below 1e-6 relative above
400 km. E = (a . d2)^2 |a|^2 - mu^2 D^4 carries twice the acceleration's
relative error plus the central-difference truncation (n^2 D^2 / 12, 3.4e-4 at
7078 km for D = 60 s) and the integer-metre rounding (about 1e-4): about 3.2e-3
in low orbit. Band: |E| <= mu^2 D^4 / 128 (7.8e-3; margin 2.4 at Swarm's
altitude). The direction test F uses the non-radial share of the J2
acceleration (at most the J2 ratio itself, 1.4e-3): |a x d2| <= |a| |d2| / 256
(3.9e-3; margin 2.8). The fabricated probes fall outside both bands by
construction: a constant-velocity segment (d2 = 0, E = -mu^2 D^4), a teleport
between two real points (d2 at the jump is the jump itself, kilometres against
tens of metres), and a track scaled by 1.01 (E scales by 1.01^6 - 1 = 6.2 %).
Known answers both ways: real precise-orbit tracks pass (Swarm before
2026-11-01, Sentinel-1, one GPS satellite, from the archive, with J2 and drag
in them); the fabricated probes fail at every step they touch. If a real track
is not read inside this record's box, its line is reported as not measured,
never as passed, and real tracks passing the physics check is then a gate
beside S4 before the feature is offered on any host or the console: a check
that rejects real orbits would block every real user, so it cannot ship
unmeasured.

### 2c. Known-answer breadth (registered before any run)

The bench's 8 pairs cannot support "never missed". Added set: 200 geometries,
seed 2, each a B orbit crossing A's at a designed miss distance spread
uniformly over [0.5 R', 2 R'] (4611 m to 18,446 m) at the plane angles of the
bench's generator, screened over the one n 8192 block (8192 steps at dt = 1 s)
that holds the crossing. Registered outcomes: misses = 0, where a miss is a
geometry with designed miss d_min < R' whose protocol alert set is empty or
differs from the plaintext set; and the false-alert rate at the truncated-noise
threshold (s = 1.25 km) = the share of steps with d > R' that alert, reported
with a 95 % Wilson interval over the steps of the 200 geometries, and the
share of extra alerts beyond R' + s (registered 0).

## 3. Known-answer plan

Pairs (the bench's set, seed 1): A on a circular orbit at r = 7078.137 km,
i = 98 deg; seven B orbits crossing A's at 2 km miss at times spread over the
day, and one control at 60 km. Each A, B sampled every 1 s for 1 day (86,400
steps; 11 blocks at n 8192, 6 at n 16384). Encrypted-on-both-sides runs use
the same pairs (the arithmetic is the same function; the test is that no
public track is read). Physics check cases: A's track (passes), each B's track
(passes), a straight line at A's start with A's velocity (fails), and A's orbit
flown at 1.2 times its mean motion (fails).

Plaintext conjunction-assessment screening on the same pairs: for every step,
alert iff |a - b|^2 < R'^2 on the integer-metre samples (the protocol's
decision in the clear, the per-step form of the module's conjunction decision
at threshold R'). The module's conjunction decision on the same grids is the
0.18.4 pair search; the per-step comparison is what the protocol computes, and
it is the registered reference for this record.

Acceptance (each line measured by `tests/privateScreeningKnownAnswer.e2e.mjs`):

1. Alert steps identical: for each of the 8 pairs the protocol's alert-step
   set (S2 output, s = 0, decision through the oracle) equals the plaintext
   set exactly; `signMismatches` = 0 over 8 x 86,400 steps.
2. The true conjunction is not missed: each of the 7 designed encounters has
   at least one alert step; the 60 km control has none.
3. Encrypted on both sides: identical alert sets (the same acceptance, with
   B's coordinates entering only as ciphertexts under A's key); `publicTracksRead` = 0.
4. B squares itself: the decrypted S2 values equal |a - b|^2 - R'^2 exactly
   (`valueMismatches` = 0), with `ctxCtMultipliesPerBlock` = 3 and no |a|^2
   submitted (`submittedVectorsPerBlock` = 3).
5. Anchor-free physics check: the decrypted E and F equal their plaintext big
   integers exactly at every step with both neighbours; A and the seven B
   tracks pass at every step; the straight line and the wrong-rate orbit fail
   at every step (`physicsMismatches` = 0).
6. Tube check: A's track against its own declared track displaced by 100 m
   passes every step at D0 = 1 km; the straight line fails from its first step
   outside the tube.
7. Requester-held keys: every B context reports `HasSecretKey() == false`;
   `ctxCtMultiplies` equals the stated count (3 per block in S1 and S2, 21 in
   S3) and no other ct x ct multiply runs.
8. Laplace noise: with s = 1.25 km, every plaintext alert step is an alert
   (`noiseMissedAlerts` = 0) and every extra alert has d <= R' + s.
9. No decoys: the driver's report carries `decoys: 0` and no decoy parameter.
10. maskLeakage reported (within a factor of 2 and of 10 in distance), with
    the sentence that the multiplicative output is not private.
11. What B returns (2a): `returnedCiphertextsPerBlock` S1 1, S2 1, S3 2; the
    reconstruction attempt over one window recovers B's distance within a
    factor of 2 at <= 0.1 % of steps; median log2 error reported.
12. Tolerance band (2b): E within mu^2 D^4 / 128 and F within 1/256 on every
    checked step of A and the seven B tracks; the constant-velocity segment,
    the teleport and the 1.01-scaled track fail; the real tracks (Swarm,
    Sentinel-1, GPS) pass or are reported as not measured.
13. Breadth (2c): 200 geometries, misses 0, false-alert rate at the
    truncated-noise threshold with its Wilson interval, extra alerts beyond
    R' + s = 0.

The E2E prints PASS only when every line holds; the known-answer table is
written to `results/known-answer.json` by the E2E from the driver's output.

## 4. Cost plan

Measured on one core of the owner's Mac Studio (M3 Ultra, host shared with
other work), SEAL 4.1.1 through the fork API, 1 day at 1 s, 8 pairs. The
driver times every step with a steady clock and sums the serialized ciphertext
bytes that cross between A and B; `tests/privateScreeningCost.e2e.mjs` prints
the table and writes `results/cost.json`.

| Figure | Definition |
| --- | --- |
| A encrypt per object-day | key generation plus the encryption of A's three coordinate vectors (S2, n 8192) and three shifted copies (S3, n 16384), per day |
| A upload per object-day | bytes of A's ciphertexts, S2 and S3 |
| B compute per pair-day | B's encryption of its own operands plus the ciphertext arithmetic of S2 for one pair |
| B response per pair-day | bytes of B's S2 response for one pair |
| B physics check per object-day | B's S3 arithmetic for one submitted object |
| A decrypt per pair-day | A's decryption of the S2 response |
| bytes exchanged per pair-day | A's S2 upload (counted once per object) amortized over the 8 pairs, plus B's S2 response; stated with and without the S3 bytes |

Reading rule: every figure is the measured value of this run, stated with the
bench's 1 s row beside it (B compute 169 ms, response 8.7 MB per pair-day,
A upload 34.6 MB and encrypt 179 ms per object-day). A protocol figure above
the bench is expected and reported as the ratio: the bench used plaintext
vector operands and modulus switching, which the fork API does not expose,
and no ct x ct multiply. The physics check figures are reported on their own
line; they may dominate. No figure is extrapolated from fewer steps than the
full day.

## 5. Security requirements and where each is addressed

1. Output leakage: section 2 (masks); acceptance 10; S4 not built, the
   limit stated, the feature offered nowhere until it exists.
2. The owner's 2026-10-07 changes, each with a test: no decoys (9);
   encrypted on both sides (3); B squares itself (4); anchor-free physics
   check at depth 3 on n 16384 (5).
3. Requester-held keys, plaintext x ciphertext apart from the stated ct x ct
   steps, per-window keys instead of a hash commitment: section 1;
   acceptance 7.
4. Known answers within R', the true conjunction never missed, Laplace noise
   that never hides a real alert: acceptances 1, 2, 8.
5. Cost per pair-day, per step and per parameter set against the bench:
   section 4.
6. SDN-AP additions of 2026-11-06: what B returns and the reconstruction
   attempt (2a, acceptance 11); the J2-derived tolerance band with real
   tracks passing and fabricated probes failing (2b, 12); the 200-geometry
   breadth set with the miss count and the false-alert interval (2c, 13).

## Results

Filled after the run; see `results/known-answer.json` and `results/cost.json`.
