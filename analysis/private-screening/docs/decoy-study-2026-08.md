# Decoys for private screening: principle and measurement

An owner screening a satellite that the public catalog lacks can submit N
candidate orbits: one real and N − 1 decoys. Only the owner's key says which
answers matter. This note covers:
- the bound decoys give;
- the conditions the bound needs;
- what we measured on real histories: GP element sets and HPOP ephemeris
  windows, from August 2026.

Status: **principle stated, generators measured; no generator is ready to
hide an orbit.**

## Principle

**The game.**
- The owner holds the real orbit x\*.
- It draws N − 1 decoys from a distribution q.
- It places x\* at a secret index J, chosen uniformly from its key.
- The adversary sees everything about the N candidates and guesses J: the
  answers it probed for, any leaked ephemeris, and anything else it knows.

**The bound.**
- Let p be the adversary's belief about real orbits, given everything it
  knows.
- The best guesser weighs candidate k by L(x_k) = p(x_k)/q(x_k):
  P(J = k | view) = L(x_k) / Σⱼ L(x_j).
- If e^(−ε) ≤ p/q ≤ e^(ε) everywhere, no adversary finds the real orbit with
  probability above e^(2ε)/N.
- With q = p, the probability is exactly 1/N, for any computing power.

**Time.**
- The ratio is taken over whole histories, so it multiplies across windows.
- Decoys redrawn each window leak up to e^(Tε) after T windows.
- So a decoy must be persistent: drawn once, then evolved by the same process
  as a real orbit. Its ratio then stays at the single draw's ε.

**Observations.**
- An adversary's own observation y of the satellite (radar, optical) gives
  each candidate a factor p(y | x_k).
- The real orbit explains y and decoys do not. So decoys hide an orbit only
  from adversaries who cannot observe it.

**Pipeline equivalence.**
- In practice, q = p means the real and decoy ephemerides come out of the
  same process: the same tracking model with fresh noise, the same orbit
  determination and the same propagator. Only the true orbit differs.
- ε is then the mismatch between the decoy truths and the adversary's prior
  for the true orbit, and nothing else.
- The measurement below shows why shortcuts fail:
  - noise invented by a simple model is recognised by its statistics;
  - noise copied from public histories is recognised by correlation with
    them.

**Composition.**
- Encryption hides the inputs (semantic security). The protocol reveals only
  its answers.
- Laplace noise bounds what each answer reveals. A budget of k answers per
  window bounds the total at kε_q.
- Decoys dilute whatever still leaks, or everything if the answer gate fails.
- A confirmed real alert tells that one counterpart which candidate is real,
  by design.

## Measurement

ε cannot be computed from first principles, but it can be bounded from
below. A classifier tries to tell real histories from decoys; how well it does
is a lower bound on ε. It also gives the number that matters directly:
- the probability that the real history scores highest of N, P₁(N);
- the effective count N_eff = 1/P₁(N).

Ideal decoys give N_eff = N.

### Setup

**Population.**
- 3,000 LEO payloads (perigee below 2,000 km, e below 0.1), a seeded random
  sample of the 16,329 with element sets throughout 2 to 29 August 2026:
  1,949 Starlink, 131 OneWeb, 920 others.
- Each is a target in turn, and the other 2,999 are the public catalog its
  decoys come from.
- Real histories stand in for hidden satellites: a hidden satellite is
  assumed to look like the public population.

**Views.** Both cover the same 14 days, 9 to 22 August.
- **GP view:** the element sets themselves.
- **HPOP view:** what an owner would publish. Each day's window starts from
  the latest element set: the `analysis/epoch-state` GCRF state, propagated
  by the `propagator/hpop` resident (point mass and degree/order 20 field).
  Each window is reduced to 8 states over one orbit and the state at the
  next window's start.

**Generators.** One decoy per target each:

| Generator | How a decoy is made |
| --- | --- |
| independent | n, e and i from three different objects, B\* 0, uniform node and phase, SGP4 secular motion |
| rotated | One object's history, node and mean anomaly shifted by constants |
| resampled | One object's orbit, offset by a real nearest-neighbour difference in a, i and e; its decay following the daily drag common mode; its manoeuvre steps at random times; cadence and per-element noise resampled |
| chained | The same offset start; then the object's real consecutive-set changes in mean elements beyond SGP4's secular motion, in order from a random start, with fresh dither on each published set |
| aligned | Chained, with the changes in the object's own time order and epochs |

**Adversary.**
- Gradient-boosted trees on rotation-invariant features, cross-validated by
  target.
- Shared features: orbit, decay, scatter, manoeuvre steps, node-rate
  residual and correlation with the daily drag common mode.
- GP view only: consecutive-set agreement, cadence and B\*.
- HPOP view only: window-to-window jumps.
- Two catalog searches:
  - the distance to the nearest public object;
  - the best lagged correlation of the history's changes with the 30 most
    similar public objects, to catch a replayed sequence.
- ε is bounded below at 95 %: a threshold chosen on half the targets is
  tested on the other half.

### Results

N_eff of N: the ideal is N. Above about 3,000 it is limited by the number of
test decoys.

**GP view** (element sets, 14 days)

| Generator | AUC | ε ≥ | N_eff of 10 | of 100 | of 1,000 | Leading features |
| --- | --- | --- | --- | --- | --- | --- |
| independent | 1.000 | 6.2 | 1.0 | 1.0 | 1.0 | replay search, scatter |
| rotated | 1.000 | 6.2 | 1.0 | 1.0 | 1.0 | replay search, catalog distance (0: an exact copy) |
| resampled | 0.999 | 6.0 | 1.0 | 1.0 | 1.1 | node-rate residual, consecutive-set agreement |
| chained | 0.926 | 4.2 | 1.5 | 4.3 | 11.1 | catalog distance, drag common mode |
| aligned | 0.972 | 4.6 | 1.2 | 2.9 | 10.2 | replay search, catalog distance |

**HPOP view** (daily ephemeris windows, 14 days)

| Generator | AUC | ε ≥ | N_eff of 10 | of 100 | of 1,000 | Leading features |
| --- | --- | --- | --- | --- | --- | --- |
| independent | 0.997 | 5.2 | 1.0 | 1.1 | 1.3 | catalog distance, decay |
| rotated | 0.863 | 3.2 | 1.9 | 5.2 | 13.7 | catalog distance, a, along-track jump |
| resampled | 0.986 | 4.6 | 1.1 | 1.6 | 3.2 | catalog distance, normal and radial jumps |
| chained | 0.897 | 3.4 | 1.6 | 3.3 | 9.1 | catalog distance, along-track jump |
| aligned | 0.864 | 2.6 | 1.8 | 4.2 | 14.3 | catalog distance, a, along-track jump |

**Longer histories leak more.** Over 28 days of element sets, chained decoys
reach AUC 0.968 and N_eff 2.6 of 100. The replayed sequence now stands out
(the replay search leads). Without the replay search, AUC is 0.933.

**Decoys drawn from the target's own regime** (its 50 nearest objects in a
and i, GP view) change little: chained AUC 0.923, N_eff 3.8 of 100. The
other three generators are still found every time.

**By class** (chained, HPOP view): N_eff of 100 is 1.1 for OneWeb, 2.9 for
Starlink and 8.0 for other satellites. A satellite in a tight shell has
neighbours closer than any decoy.

### Findings

1. **Simple decoys are found every time.**
   - Independent draws break the joint structure of real orbits and carry no
     estimation noise.
   - Rotated copies match a public object exactly.
2. **Invented noise is recognised by its statistics.** Resampled histories
   have per-element noise of the right size, but real element sets drift
   from SGP4's node rate (median 0.0012°/day) and consecutive sets agree
   more closely than independent noise allows.
3. **Copied noise is recognised by correlation.** Chained histories match
   real ones on decay, scatter, node drift and consecutive-set agreement.
   They remain distinguishable for two reasons:
   - **They leave their shell.** Real satellites sit close to neighbours that
     move with them (median catalog distance 0.56 against 2.8 for decoys,
     HPOP view).
   - **Their replayed sequence shows** once histories are long enough.

   Keeping the donor's own timing (aligned) brings decoys nearer the public
   objects in the HPOP view (median 2.1). In element sets, however, it makes
   them too close (0.15 against 0.30 for real objects) and makes the
   replayed sequence plain (correlation 0.94 against 0.70).
4. **The published ephemeris hides more than element sets.** Every
   generator is harder to find in the HPOP view: it shows daily windows
   rather than every set, and propagation smooths away exact copies. The
   protocol exposes only this view.
5. **The worst case decides ε.** Even at AUC 0.90, 105 of 1,520 held-out
   real histories (7 %) scored above a threshold that none of 1,520 held-out
   decoys reached (chained, HPOP view).
   - Those satellites are found almost whatever N is. The 95 % lower bound
     on ε is 3.4, so no guarantee better than about e^(6.8)/N ≈ 900/N holds.
   - Decoys must cover every region where a real orbit can be (the bound
     needs p/q bounded everywhere), not just match on average.

### What a working generator needs

- **Pipeline equivalence.** Decoy ephemerides should come out of the
  owner's own pipeline:
  - a decoy truth propagated with the full force model;
  - simulated tracking with fresh measurement noise;
  - the same orbit determination and prediction as the real satellite.
- **Population behaviour.** Decoys must sit inside real shells and respond
  to the same space weather and station-keeping as their neighbours.
- **No public noise.** Noise must be generated fresh, never copied from
  public histories.
- **Measure before use.** Run this study against the generator, with these
  attacks and stronger ones, and require N_eff near N and a small ε before
  relying on it.

Until such a generator measures well, decoys can dilute what leaks but
cannot carry the protection alone. The gate (tube check, audit, budgets) has
to.

### Limits

- **Proxy for owner ephemeris.** Real histories are GP sets propagated by the
  HPOP resident (no drag, Sun or Moon), not an owner's own orbit
  determination.
- **Scope.** LEO payloads only, 14 days, one decoy per target per generator:
  17,993 histories and 251,770 HPOP windows (none refused, 1,447 s on 12
  workers).
- **One adversary.** A classifier gives a lower bound on distinguishability;
  a stronger adversary can only do better.
- **Prior.** The population of public LEO payloads, not the unknown
  population of hidden satellites.

Reproduce: `node scripts/decoy-study.mjs` (README). Aggregates:
`decoy-study-2026-08.json`.
