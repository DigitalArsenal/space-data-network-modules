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

- No usable leak: no gate fires on the unflooded response.
- Leak mitigated by flooding at the stated cost: a gate fires unflooded and
  none fires flooded.
- Leak unmitigated: a gate fires flooded too; the gate stays beside S4.

The E2E `tests/privateScreeningNoiseChannel.e2e.mjs` runs the driver, applies
the gates above and prints PASS when the verdict is "no usable leak" or
"leak mitigated" with the numbers; it prints FAIL for "leak unmitigated".
`results/noise-channel.json` is written only with `PRIVATE_SCREENING_WRITE=1`.
