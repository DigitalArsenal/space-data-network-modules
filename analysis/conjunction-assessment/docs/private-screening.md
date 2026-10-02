# Private screening

How two operators can learn whether their objects come close without
either seeing the other's trajectory, what it costs, what it reveals, and how
it can be abused.

Status: **designed and measured, not built.**

Files:
- benchmark: `bench/private-screening/`;
- results: `private-screening-bench-1s-2026-10-02.json` and
  `private-screening-bench-10s-2026-10-02.json`;
- exposure counts: `private-screening-exposure-2026-10-01.json`.

## Protocol

A (the requester) and B (the responder) each hold a trajectory, sampled on a
common time grid. A wants to know when B's object passes within R of its own.

1. **A encrypts its own trajectory.**
   - Under its own BFV key, A encrypts x, y, z and |a|² in integer metres.
   - 8192 grid steps are packed per ciphertext.
   - Three 60-bit plaintext moduli are combined by CRT, so no value wraps.
2. **B computes on ciphertext.** It uses plaintext-ciphertext operations only,
   since |a − b|² = |a|² − 2 a·b + |b|²:

   Enc(|a − b|² − R′²) = Enc(|a|²) + Σₖ (−2 bₖ) Enc(aₖ) + (|b|² − R′²)

3. **A decrypts.** A recovers, per step, whether B is within R′.

R′ = √(R² + (v_max Δt / 2)²) guarantees the grid misses no approach within R.
It covers a pair that comes within R between two samples. With
v_max = 15.5 km/s and R = 5 km, R′ is 9.2 km at Δt = 1 s and 77.7 km at 10 s.

Key custody:
- **Only A decrypts.** No key leaves A, and B computes only on ciphertext.
- **No assessor.** No third party is needed.
- **Why not an assessor.** A party holding the key that decrypts the result
  can also decrypt every input it receives under that key. An assessor that
  decrypts adds trust without adding privacy.

## Cost

The benchmark is `private_screening_bench`:
- Microsoft SEAL 4.1.1, BFV;
- n = 8192 with a 218-bit q, 128-bit security;
- plaintext moduli 1152921504606683137, …748673 and …830593;
- one core of an Apple M3 Ultra, on a host shared with other work (load
  about 22).

| Step | R′ | A: encrypt (per object-day) | A: upload (per object-day) | B: compute (per pair-day) | B: response (per pair-day) | A: decrypt (per pair-day) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 s | 9.2 km | 179 ms | 34.6 MB | 169 ms | 8.7 MB | 163 ms |
| 10 s | 77.7 km | 22 ms | 4.2 MB | 21 ms | 1.0 MB | 20 ms |

- **Correctness.** Over 86,400 one-second steps × 8 pairs, every step's
  result matched the plaintext distance.
- **Detection.** The seven designed encounters with a 2 km miss raised 3–6
  alert steps each at 1 s. The 60 km control raised none at 1 s; at 10 s it
  raised 2, because R′ = 77.7 km.
- **Noise.** After B's response is reduced to the last modulus level, 18 bits
  of noise budget remain.
- **Size.** A batched ciphertext costs about 32 bytes per step, per value,
  per modulus.
- **Scale.** One private object against 1,000 objects for 3 days at 1 s
  steps needs about 510 core-seconds at B and 26 GB of responses. At 10 s
  steps, 62 core-seconds and 3.1 GB, with more alerts to resolve. Private
  screening suits operator-to-operator subsets; the open screen covers the
  catalog.

## What the result reveals

The intended output is the set of steps at which B is within R′.

**Multiplicative blinding is not enough.**
- The first design blinds each step's result by a random r > 0
  (log-uniform below 2¹²⁰) and lets A read the sign.
- One step's value then bounds |d² − R′²| only loosely. Neighbouring steps,
  however, have nearly the same distance. Intersecting the bounds of 64
  neighbouring steps, A recovered the distance:

  | Step | Within a factor of 2 | Within a factor of 10 |
  | --- | ---: | ---: |
  | 1 s | 87 % of steps | 99.8 % |
  | 10 s | 78 % | 95 % |

  That is enough for range-only orbit determination of B's object.
- The output must therefore be one bit per step. B adds a random additive
  mask, and A and B run a two-party secure comparison (a garbled-circuit or
  homomorphic comparison, for example DGK) that reveals only the sign. This
  step is not built, and its cost is not measured here.

**Circuit privacy.** The noise in B's response ciphertext can carry
information about b. B must flood it with fresh noise before replying. That
needs larger parameters (n = 16384) and is not measured here.

**Real conjunctions.** These reveal what any safe protocol must reveal. Each
alert places the other object within R′ of a known object at a known time.

From the 3-day full-catalog SGP4 screen (32,514 objects, 5 km, 292,516
conjunctions):
- 27,187 objects had at least one conjunction (median 9 per object).

| Constellation | Members in conjunctions | Outside objects with ≥ 1 conjunction | Per outside object (median, p90, max) | ≥ 3 | ≥ 10 | Within 1 km |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| Starlink | 10,978 | 2,532 | 3, 62, 207 | 1,304 | 668 | 613 |
| Kuiper | 377 | 857 | 1, 4, 24 | 182 | 17 | 61 |
| OneWeb | 589 | 452 | 1, 4, 18 | 86 | 9 | 42 |
| Qianfan | 226 | 571 | 1, 2, 11 | 40 | 2 | 26 |

These counts are at 5 km. At R′ = 9.2 km there would be more.

**Interpretation.** A private object in a crowded shell gives its densest
neighbour three or more position fixes in three days in about half the cases,
and that is enough for a coarse orbit. Private screening hides an orbit from
operators it does not approach. It cannot hide one from those it does.

## Orbit guessing

The probing attack: A submits invented trajectories, not its real object, to
learn where B's object is. Each step answers one question: is B within R′ of
point p at time t?

**Cost without defenses.**
- LEO (200–2000 km) holds about 1.27 × 10¹² km³. A 9.2 km ball is
  3,290 km³.
- With no prior, a first hit takes about 3.9 × 10⁸ steps, or about 47,000
  window queries. At the measured rates, B pays about 760 core-seconds and
  39 GB of responses.
- If A already knows the shell (±25 km at 700 km, 3.2 × 10¹⁰ km³), the first
  hit takes about 1,200 queries: 20 core-seconds and 1 GB.
- After a first hit, orbital dynamics shrink the search sharply.

Unbounded querying is therefore affordable for a determined adversary.

**Probing in reverse.** B can probe A through A's reactions. A disclosure
request or a maneuver after an alert tells B that A was near B's invented
trajectory.

**Defenses, strongest first.**

1. **Bind queries to real objects.**
   - With each query, the requester commits to its plaintext trajectory (a
     hash).
   - After the window has passed, it reveals the trajectory. Past positions
     matter far less than planned maneuvers.
   - An auditor checks the revealed trajectory against independent tracking
     of the declared object, using the reference and GP comparisons of the
     uncertainty program.
   - An invented trajectory is caught after the fact. The same binding
     applies to the responder.
2. **Identity cost.** Queries come only from identities with stake or
   reputation. A failed audit forfeits the stake and suspends screening.
3. **Rate limits.** Per window, an identity may query no more than its
   registered objects.
4. **Plausibility.** At audit, a committed trajectory must obey orbital
   dynamics. Grid-like or non-Keplerian ephemerides are flagged.
5. **One-sided noise.** Noise may add false alerts but must never remove a
   true one, because safety comes first. It slows a prober by a constant
   factor and costs false-alert resolution.
   - Two-sided noise before the comparison (Laplace noise on the distance)
     would drop real conjunctions near the threshold.
   - Repeated queries average independent noise away unless it is fixed per
     query.

Direct, authenticated streams protect integrity and metadata. The ciphertexts
are protected by A's key either way. A published Enc_A(a) lets others
compute, but only A can decrypt.

With binding, a prober learns only what its real objects' real close
approaches reveal: the exposure measured above.

## What exists today

| Piece | State |
| --- | --- |
| Homomorphic fields in FlatBuffers (SEAL BFV/BGV, `he_encrypted`, client and server contexts) | Built. It encrypts one value per ciphertext, in slot 0, with a 20-bit plaintext modulus, so metre-scale coordinates wrap silently. It needs batched vectors and CRT moduli, as in the benchmark, before it can carry this protocol. |
| SDN request surface (`/api/v1/conjunction/screen`: encrypted, grant, channel, assessor) | Built. It returns no result (`pending-module-execution`). |
| The protocol's arithmetic | Measured here (benchmark). |
| Screening module; bit-only comparison; noise flooding; commitments and audit; staking; rate limits; plausibility checks | Not built. |
