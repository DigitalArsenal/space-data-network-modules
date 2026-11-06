# Noise channel of the private screening response: registration

Registered 2026-11-06 (task modules-private-screening-noise-channel-20261106),
before any row. It measures the gate filed in `PROTOCOL-19.md` section 2d. It
is report-only: no protocol change is made here. Nothing above the results
section changes once a row exists. The protocol, the fork commit (55a0ca86),
SEAL 4.1.1, the parameters (S2: n 8192, depth 1) and the response form (the
shipped one: the noise term eta and the mask rho, each added as a fresh
encryption) are those of record 19.

## 1. Attack model: what A reads

A is the requester. It holds the secret key of every lane (the fork runs three
SEAL BFV instances, one per 60-bit plaintext modulus t0, t1, t2), its own
plaintext trajectory a, its own encryption randomness, the public catalog, and
every ciphertext B returns. Under the rule of 2a B returns one S2 response per
block; the reads below are of that response.

What the fork API gives A: `NoiseBudget(ct)`, one integer in bits per
ciphertext, the minimum over the three lanes of SEAL's invariant noise budget.
It is not per slot: the noise is a polynomial in the coefficient domain, and
slot batching maps slots to coefficients, so no per-slot noise read exists.
The task wording "per slot" is read as "per returned block" (8192 steps).

What a key holder can read beyond the API (the registered finest read): per
lane, the invariant noise polynomial d = [t (c0 + c1 s)]_q, centered, n
integers (SEAL's own quantity; its max-norm is the budget). A obtains it with
its own key from the same library (the driver compiles with
`-fno-access-control` to reach the decryptor's phase routine; no fork file or
protocol file is changed). The driver computes d from the lane's RNS residues
in long double (about 30 bits of precision on a quantity of 120 to 160 bits);
two responses are also dumped as residues and recomputed exactly with big
integers in the E2E, and the exact and long double log2 L-infinity must agree
within 0.001.

Registered readings per response (19 numbers): R1 the API budget; R2 the three
lane budgets; R3 per lane the log2 of L-infinity, of the root mean square, the
mean of log2 |d_i|, and the 50th and 90th percentiles of log2 |d_i|.

Known to A besides the readings (the "known A operand and returned masked
value"): the block index w; the block means of a_x, a_y, a_z and of |a|; the
mean of log2 of the magnitude of the decrypted masked slots (mask dominated).

## 2. Mechanism (the claim under test)

The noise of a ct x ct product contains plaintext-polynomial x noise terms,
v ~ sum_k (m_ak - m_bk)(vA_k - vB_k) with m the coefficient-domain plaintext
polynomials and vA, vB the fresh-encryption noises. B's coordinates enter
through m_bk and vB. Adding a fresh encryption of the mask adds an independent
small term and does not flood it. Two observations bound what to expect, both
tested here and not assumed: (a) a batched vector of 24-bit slots has
coefficient-domain polynomial coefficients spread over the whole 60-bit
plaintext modulus, so the product's noise size is set by the modulus and not
by the slot values; the noise size should then not vary with B's operand, only
with B's encryption randomness; (b) a structured operand (all slots equal to a
constant c, so the polynomial is the single coefficient c) does change it. The
positive control (section 4, P1) measures (b) so that a flat reading on real
orbits is a measured absence, not an insensitive reading.

S1 has no secret on B's side (A's declared public track). S3's B-side inputs
are the constant mu^2 D^4 and the mask only, never B's coordinates; its
response is a function of A's own data. The channel of B's coordinates is
therefore S2 only, and S2 is what is measured.

## 3. The attempt and its estimators

Population (all with the shipped S2 response, eta and rho on, fixed test
keys: A's key from `CreateClientSeeded`, a fixed 32-byte seed; B's encryption
randomness is the library's and differs run to run, so rows vary and the
registered gates are statistical with fixed permutation seeds):

- the record 19 pairs (seed 1, A-B1..A-B8), every block of the day in time
  order: 8 x 11 = 88 responses (the "series over a pair-day");
- the breadth geometries of 2c, seeds 2 and 3, the block holding the crossing:
  400 responses;
- a third set, seed 4: 1600 geometries, designed miss uniform in [0, 2 R'], the
  crossing block: 1600 responses.

Total 2088. Targets per response (what A would want): T1 log2 of the minimum
distance over the block; T2 the mean of log2 distance over the block; T3 the
close flag (minimum distance < R'); T4..T6 the block means of b_x, b_y, b_z
(B's coordinates); T7 the mean |b|.

E1, regression. Features: the 19 readings plus the known A features (section
1). Ridge (lambda 1, features and targets standardized on the training folds),
5-fold cross-validation with a fixed fold assignment. Per target j the
statistic is delta R2_j = CV R2 (readings + known A) minus CV R2 (known A
only). Null: the reading rows (all 19 columns together) permuted among the
responses of the same block index w (the readings may depend on A's own
operand, which A knows, so the shuffle holds that fixed), 2000 permutations,
seed 20261106; p_j = (1 + number of permuted delta R2 >= observed) / 2001.
Per-step estimate for the record 19 criterion: d_hat = 2^(T2 prediction);
C1 is the share of the steps of the population within a factor of 2 of d_hat
(histogram of log2 distance in 1/16 octave bins; window edges rounded to the
bin, error at most 1/16 octave).

E2, nearest neighbour against a dictionary of candidate B states. Dictionary:
K = 64 candidate B orbits crossing A's track inside block 3 (seed 5, designed
miss uniform [0, 2 R']), the catalog-neighbourhood stand-in. A simulates each
candidate through the protocol with its own randomness R = 5 times and keeps
the mean of the 19 readings as the candidate's fingerprint (features
standardized by the pooled within-candidate standard deviation). Targets: T =
200 fresh responses of dictionary members (3 or 4 per candidate, own
randomness, not in any fingerprint). A picks the candidate with the nearest
fingerprint. Statistics: the top-1 rate against chance 1/64 (exact one-sided
binomial); and C1 of the picked candidate's per-step distance series against
the target's, against the C1 of a uniformly random pick (the dictionary mean;
paired sign test). Null: the random pick (the shuffled assignment).

Gates (registered before any row):

- E1 fires if for any of the 7 targets delta R2_j >= 0.01 and p_j <= 0.05 / 7
  (Bonferroni, so the family pass chance under the null is at most 0.05).
- E2 fires if the top-1 rate has binomial p <= 0.001 and the rate is at least
  2 / 64 above chance level in absolute share (rate >= 1/64 + 0.03), and the
  paired C1 sign test has p <= 0.001.
- The record 19 criterion C1: an attack passes it when more than 0.1 % of
  steps are within a factor of 2. For a dictionary or a block-level estimate
  this is passed at the chance level by construction (a random orbit of the
  neighbourhood is within a factor of 2 at some share of steps far above 0.1
  %); the pass chance of C1 under the null is therefore measured and reported
  (the null estimators of both arms), and the attack counts as successful only
  if a gate above fires, which is the comparison against the null.
- The minimum detectable delta R2 of E1 is reported (the 99th percentile of the
  permutation distribution) beside the observed values.

## 4. Controls

P1, mechanism and sensitivity: A and B each encrypt slot-constant vectors
(every slot c_a, every slot c_b) and the S2 pipeline runs on one block; the
difference |c_a - c_b| takes 0, 1, 2^4, 2^8, 2^12, 2^16, 2^20, 2^23; the
registered expectation is a budget that falls from large to the saturated
level as |c_a - c_b| rises (a reading that does depend on a structured
operand). P2, noise size on real orbits: the spread (standard deviation) of
the R1 budget and of log2 L-infinity per lane over the 2088 responses, stated
with the fresh-encryption jitter alone (the same A, B operands run 30 times).

## 5. Flooding arm (run only if a gate fires)

B adds a fresh encryption of zero multiplied by a plaintext scalar 2^f (noise
scaled by 2^f, plaintext unchanged at zero) to each returned block. The flood
must exceed the operand-dependent spread of d by 40 bits (statistical distance
2^-40). Cost per block (ms, bytes) is measured. Budget consequence: S2 has
32 bits left at n 8192, so a 40-bit flood on top of the existing noise does
not close at n 8192; it is run at n 16384 (S2 at depth 1 leaves 247 bits
there, per the fork table), and the cost of the n 16384 S2 block and the
doubled bytes are measured. Whether the depth-4 chain (S3) still closes is
unchanged by an S2 flood (S3 has no B operand); stated. A flooded response is
read by the same estimators; the gate must then not fire. A protocol change
is its own record; this record only measures the arm.

## 6. Verdict (three-way)

- No usable leak (the registered estimator verdict label; the gate line is in
  the Results section): no gate fires on the unflooded response.
- Leak mitigated by flooding at the stated cost: a gate fires unflooded and
  none fires flooded.
- Leak unmitigated: a gate fires flooded too; the gate stays beside S4.

The E2E `tests/privateScreeningNoiseChannel.e2e.mjs` runs the driver, applies
the gates above and prints PASS when the verdict is "no usable leak" or
"leak mitigated" with the numbers; it prints FAIL for "leak unmitigated".
`results/noise-channel.json` is written only with `PRIVATE_SCREENING_WRITE=1`.

## 7. Amendment 2026-11-06 13:55Z (SDN-AP ruling), registered before any row of it

What sections 1 to 6 read: 19 numbers per response, all norm summaries of the
noise polynomial (section 1). A norm cannot see a coefficient-wise dependence
on B's operands, so sections 1 to 6 close the scalar and norm channel only.
This amendment registers the coefficient-level read; the verdict of section 6
is the conjunction of both.

Exact noise polynomial. Per lane, A computes w, the integer polynomial with
phase = Delta m + w (Delta = floor(q/t), m the decrypted plaintext polynomial
with coefficients in [0, t)): w = (d + r m) / t exactly, with d as in section
1 and r = q mod t, evaluated in the first two RNS limbs and recovered as a
centered 128-bit integer (|w| < 2^81 < q0 q1 / 2). A's own fresh block
ciphertexts give its own noise eA_k the same way (m known). Two domains: the
coefficient domain (w_i) and the slot image (w mod t decoded with the lane's
batch encoder).

Mechanism written down. For the squared difference, w is about 2 sum_k (m_ak
- m_bk) * (eA_k - eB_k) (negacyclic products, m as integers in [0, t)), plus a
rounding term. A knows m_a and eA exactly. Hence 2 sum_k m_ak * eA_k is
removable, and -2 sum_k m_b'k * eA_k is a known function of any candidate b':
a matched filter on the full vector can discriminate candidates although the
norms are flat.

Tests, on the dictionary arm (64 candidates in block 3; 5 simulations each;
200 targets; 30 repeats of one operand), per lane, aggregated over the 3 lanes
by summing z = sqrt(8192) x correlation:

- E3, replicate correlation: after removing the grand mean over the 320
  simulation vectors, the mean correlation of pairs of simulations of the same
  candidate against pairs of different candidates, in the coefficient domain
  and in the slot image; null: 2000 random regroupings of the 320 vectors
  into groups of 5 (seed 20261106); p = (1 + count of null >= observed) /
  2001. Fires if p <= 0.05 / 2 in either domain.
- E3-NN, full-vector nearest neighbour: the fingerprint of a candidate is the
  mean of its 5 grand-mean-centered vectors; a target picks the candidate of
  largest summed z. Statistics as E2 (top-1 against 1/64, exact binomial).
  Coefficient domain and slot image.
- E4, matched filter: the target's coefficient vector minus 2 sum m_ak * eA_k
  against -2 sum m_b'k * eA_k of each candidate; the largest summed z picks.
  Statistics as E2.
- Gates: E3-NN and E4 fire as E2 does (binomial p <= 0.001/3, top-1 rate >=
  1/64 + 0.03); E3 as above. Multiple-comparison correction: Bonferroni over
  the three tests (E3, E3-NN, E4) and the two domains, stated at each p.
  Mass-univariate regression of single coefficients on the block-mean targets
  is not run: the dependence is bilinear in B's plaintext polynomial, not
  linear in the targets, and E4 is that dependence's direct test.

Power of E1 (the size of real dependence the gate would detect). A synthetic
dependence of known size is injected into the 2088-response series: reading
column 4 (lane 0 log2 L-infinity) is replaced by sqrt(1 - s) z(column) + sqrt(s)
z(T2 residual to A's features), with s the injected R2 in {0.005, 0.01, 0.02,
0.05}; 200 replicates per s (a fresh seeded noise draw each); detection means
delta R2 for T2 >= 0.01 and above the 0.05 / 7 quantile of the stored
permutation null. The detection rate per s is reported; the gate line states
the smallest s detected at a rate of 0.9 or more. The same injection is
reported for E2/E3-type tests only if a coefficient-level gate fires.

Verdict (replaces the verdict rule of section 6): the label "no usable leak" only if E1,
E2, E3, E3-NN and E4 all stay below their gates; a gate firing at the
coefficient level triggers the flooding arm of section 5.

### 7b. Corrections and a repeated-query test (2026-11-06 14:35Z, before the rows of 7)

Corrections found on a 6-second smoke run of the driver (64 candidates, 5
simulations each; its outputs were read only for sizes and for the artifact
named here, not for any gate): (i) SEAL scales a fresh plaintext by round(q m
/ t), not by floor(q/t) m, so the coefficient-domain noise polynomial that is
registered as "w" is the invariant noise d = [t (c0 + c1 s)]_q itself (about
2^140 on a response, 2^66 on a fresh ciphertext) and the mechanism reads
d_resp ~ 2 sum_k (m_ak - m_bk)(dA_k - dB_k) + t (I terms) + rounding, where I
is the q-wraparound polynomial of <ct, s>; E4 uses d with eA taken as d of A's
fresh ciphertexts (exact). The coefficient-domain vectors of E3, E3-NN and E4
are d. (ii) The slot image of d mod t is the decrypted message (d = -(q mod
t) m mod t), a trivially perfect replicate correlation that reads the masked
output, not noise; the slot image is therefore taken of w = (d + (q mod t) m)
/ t, exact in two RNS limbs, which carries the noise. (iii) Size estimate to
be tested: the term t I1 dB + t I2 dA (I of size 2^6 from the wraparound of a
ternary key) is about 100 times the amplitude of the operand-dependent term
m_b dA, so the deterministic operand-dependent share s of the noise variance
is expected near 1e-4. One response then yields a matched-filter z of about
sqrt(n s) = 0.9 per lane (not significant), and N responses to the same
operand with fresh B randomness, averaged, yield z of about sqrt(n N s):
a z of about 5 near N = 30.

Repeated-query test (the amplification an adversary can run; the keyed eta
and mask are fixed per (requester, object, step), the B encryption randomness
is fresh per query): the operand of candidate 0 is queried N_max = 200 times;
the first N responses (N in 1, 5, 25, 50, 100, 200) are averaged after
removing A's known part, and the matched filter of E4 is applied against all
64 candidates' signals; reported per N: the summed z of the true candidate,
the mean and sd of the summed z of the other 63, the standardized gap, and
whether the true candidate ranks first. Gate (E5): a standardized gap of 4 or
more at some N <= 200 fires E5 (a repeated-query leak); the smallest such N
is the queries-per-block cost. The P2 jitter statistic uses the first 30 of
the 200 repeats as before.

Verdict rule of 7 extends: E5 firing triggers the flooding arm as the others.

## Results (run of 2026-11-06, `results/noise-channel.json`)

Gate line: No leak detected by the registered estimators at the stated limits. Circuit privacy is not established. The gate stays open beside S4.

Registered estimator verdict label: "no usable leak", scalar and coefficient
level, read only with the gate line above and the detection limits below.
No gate fires on the unflooded
response; the flooding arm (section 5) is therefore not run and its cost is
not measured. Flooding stays a stated option. All figures are from the run
stored in the results file; B's encryption randomness is the library's, so a
rerun changes the rows and not the outcome (the gates are statistical with
fixed permutation seeds). Two earlier runs of the same procedure (the
single-threaded driver; and a run of the coefficient-level arm before the
calibration shares were added) gave the same verdict.

### Scalar and norm readings (sections 1 to 6; 2088 responses)

Readings: 19 numbers per response, all computed from the full noise
polynomial of each lane: the API budget (one integer per returned block), the
three lane budgets, and per lane the log2 L-infinity, the log2 root mean
square, the mean of log2 |d_i|, and the 50th and 90th percentiles. The API
budget is 32 bits at all but about 0.4 % of responses (mean 32.005, sd
0.072). Log2 L-infinity: mean 140.09 to 140.10 per lane, sd 0.111, 0.107,
0.111 across the population against 0.094, 0.119, 0.127 for 30 repeated
encryptions of identical operands. The long double reading agrees with the
big-integer reading (140.2321 against 140.2321), and the budget from the
polynomial equals SEAL's (32). Cause of the flat norm: one multiply costs 73
bits whatever the operands (a scratch probe: fresh 106 bits; the square of a
zero difference 33; a zero operand times a fresh ciphertext 34; two fresh
ciphertexts 34); the rounding term of the multiply sets the floor.

E1 (regression, 2000 permutations within block index). Change in
cross-validated R2 from adding the 19 readings to A's own operand features,
and its permutation p, per target: log2 minimum distance -0.0086 (p 0.271);
mean log2 distance -0.0163 (0.864); close flag -0.0116 (0.513); mean b_x
-0.0122 (0.983); mean b_y -0.0136 (0.694); mean b_z -0.0082 (0.628); mean
|b| -0.0145 (0.753). No change is positive (best -0.0082); the gate (change
>= 0.01 and p <= 0.05/7) fires for none. Per-step estimate (record 19
criterion C1): 0.531 with the readings, 0.532 with A's features only, 0.532
for the null; the criterion is passed by the null in 2000 of 2000
permutations, so as registered it carries no information on its own.

E2 (nearest neighbour on the 19 readings, 64 candidates, 5 simulations each,
200 targets): top-1 4 of 200 (0.020) against chance 0.0156, binomial p 0.38;
mean rank of the truth 31.4 against 32.5; C1 of the pick 0.436 against 0.433
for a random pick, sign test p 1.0. Fires: no.

Power of E1 (7, c; injected share s of one reading's variance carried by T2,
200 replicates each, detection = change >= 0.01 and above the null quantile):
s = 0.005 detected 0.0 %; 0.01 0.5 %; 0.02 27.5 %; 0.05 100 %. The smallest
injected share detected at a rate of 0.9 or more is 0.05. E1 at the +0.01
gate is a coarse detector: it would miss a dependence below about a 2 to 5 %
share of one summary's variance. The coefficient-level tests below are the
sensitive ones.

### Coefficient level (7 and 7b)

Sizes (log2 of the L-infinity norm, lane 0): the response noise polynomial
d 2^140.0; A's known part 2 sum m_a eA 2^134.4; a candidate's signal -2 sum
m_b' eA 2^134.4; A's fresh noise eA 2^66.2.

E3, replicate correlation (320 simulations, 64 candidates x 5, grand mean
removed; 2000 regroupings): coefficient domain mean same-candidate
correlation -0.00373 against a null of -0.00314 +/- 0.00070 (p 0.80); slot
image of w -0.00273 against -0.00313 +/- 0.00026 (p 0.0625); gate p <= 0.025.
Fires: no. A replicate correlation equals the share of the noise variance
that is a deterministic function of the operand; the observed values bound it
at 2 sd of the null: about 1.4e-3 (coefficient) and 5e-4 (slot).

E3-NN, full-vector nearest neighbour on the fingerprint (mean of 5 simulation
vectors): coefficient domain top-1 4 of 200 (p 0.38, mean rank 32.4); slot
image 3 of 200 (p 0.61, mean rank 33.7); chance 3.1. Fires: no.

E4, matched filter (target minus A's known part against each candidate's
-2 sum m_b' eA): top-1 2 of 200 (p 0.82), mean rank 31.9 of 64. Fires: no.

E5, repeated queries to one operand with fresh B randomness (N = 1, 5, 25,
50, 100, 200 averaged; standardized gap of the true candidate's summed z to
the other 63): -0.84, -0.27, -0.83, -0.03, -0.35, -1.01. Gate (gap >= 4):
no. Calibration by injection of a known operand-dependent share s into the
same averaged vectors (smallest N with gap >= 4; gap at N = 200): s = 1e-6:
none (-0.6); 1e-5: none (0.4); 1e-4: none at N <= 200 (3.3; 4.4 in a repeat
run); 1e-3: N = 25 (12.5). So E5 at 200 queries per block detects a
deterministic operand-dependent share of the noise variance of about 1e-4 to
2e-4 and above, and the measured gap corresponds to a share below that. A
single response (N = 1) does not detect even 1e-3 (gap 0.2 to 1.3).

E5 is a required regression on any protocol change, not the gate. Its limit
improves with more queries, and an attacker is not held to 200 queries unless
the protocol holds them there; each response carries fresh randomness to
average over.

Mechanism, as found: the cross term t I1 dB + t I2 dA of a ct x ct product
(I the q-wraparound polynomial of <ct, s>, about 2^6 per coefficient)
dominates the operand-dependent term m_b dA by about 100 in amplitude, so the
share of the noise variance that depends on B's operand is expected near
1e-4 (7b); the measurement puts it below the detection limits above.

Controls. P1 (registered expectation: the budget falls as |c_a - c_b| rises)
is NOT met and is reported as a failed expectation: the API budget is 32 at
all eight differences from 0 to 2^23, and the log2 L-infinity spreads over
0.48 bits across them (jitter sd 0.1). The cause is the floor above: even a
zero difference squared costs the full 73 bits, so a slot-constant operand
does not lower the noise. This is an absence for the norm readings and not a
sensitivity proof; the sensitivity statements are the injected calibrations
above. The injected calibrations carry the sensitivity claim and test only
the injected forms; a dependence unlike the injections is not bounded by them.

What the verdict does and does not say. The label "no usable leak" holds only
beside the gate line (No leak detected by the registered estimators at the
stated limits. Circuit privacy is not established. The gate stays open beside
S4.) and for the registered estimators at the stated detection limits: operand-dependent
noise share below about 1e-4 to 2e-4 against a 200-query adversary, below
about 1e-3 against a single response, and no coefficient-wise replicate
structure above 1.4e-3. It is not a proof of circuit privacy: a share under
those limits, an adversary with more than 200 queries per block (the keyed
eta and mask are fixed per object and step, so extra queries only add fresh
B encryption randomness), or an estimator outside the registered list is not
covered. A flood on S2 would be a protocol change and its own record (it
needs n 16384, section 5).

## S4 design decision (SDN-AP ruling 2026-11-06 14:12Z)

Closing the gate beside S4 takes one of:

(a) Noise flooding with a stated statistical security parameter and its cost
measured: S2 at n 16384, the expected construction (section 5 states 40 bits,
statistical distance 2^-40, as the starting value; the parameter is stated and
the time and bytes per block are measured in the S4 record).

(b) A written argument with a protocol-enforced query cap per (requester,
object, block), set far enough below E5's detection limit scaled for the cap.
The scaling law of E5's limit with the number of queries is measured, not
assumed.

Decision recorded for the S4 record: (a). This does not hold records 20 to 22.

