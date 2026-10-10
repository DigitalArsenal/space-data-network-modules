# TEAG and the Epistemic Support-Point Filter: implementation specification

This module implements the Theory of Epistemic Abductive Geometry (TEAG)
primitives and the Epistemic Support-Point Filter (ESPF) from their published
papers, independently of the authors' code (none is public:
github.com/gaiaverseltd/espf holds a README and a licence only). This file maps
every step to its paper, section and equation; lists every gap or ambiguity
with the choice made; and gives every parameter with its value and source.
The papers' texts are not reproduced here; cite them.

## 0. Sources

| Key | Paper | Version read |
| --- | --- | --- |
| **E25** | M. K. Jah and V. Haslett, "The Epistemic Support-Point Filter (ESPF): A Bounded Possibilistic Framework for Ordinal State Estimation", arXiv:2508.20806 | v1 source, 2025-08-27 |
| **OPT** | M. K. Jah, "The Epistemic Support-Point Filter: Jaynesian Maximum Entropy Meets Popperian Falsification. A Possibilistic Minimax-Entropy Optimality Proof", arXiv:2603.10065 | source dated 2026-03-09 (`ESPF_Optimality_v5.tex`) |
| **HJ** | M. K. Jah, "The Epistemic Support-Point Filter as a Tropical Hamilton–Jacobi System: Wavefront Propagation and Possibilistic Inference", Preprints 202603.2110 | v1 full text; v3 abstract |
| **TEAG** | M. K. Jah, "Theory of Epistemic Abductive Geometry (TEAG): A Unified Theory of Admissibility-Driven Inference Across Dynamical Systems, Measure Theory, and Language", Preprints 202603.2010 | v2 full text (and v1 for comparison); v3 abstract |
| **PCRB** | M. K. Jah, "Rank, Fibers, and Falsifiability: A Rank-Aware Possibilistic Cramér–Rao Bound for Evidence-Driven Contraction", Preprints 202607.2165 | abstract only (full text not retrievable) |

E25's display equations are unnumbered; it is cited by section (1
Introduction, ..., 4 Problem Formulation, 5 Possibility Theory Fundamentals,
6 Support-Point Generation, 7 Prediction Step, 8 Measurement Update, 9 Mode
Extraction via Weights, 10 Support-Point Regeneration, 11 Numerical
Implementation Details, 12 ESPF Algorithm, 13 Testing Configuration, 14
Results, Appendix B Recovery of UKF in the Gaussian Limit). HJ and TEAG are
cited by equation, definition and proposition number. OPT is cited by section
and statement name.

The v3 versions (TEAG v3, HJ v3) were available as abstracts only. Their core
equations agree with v1/v2: Φ⁺ = max(Φ⁻, ψ), ψ = −log κ; the surprisal field
½‖L_e⁻¹(y − g(h))‖² in MVEE-whitened measurement space; survivors in the PCRB
basin {Φ⁺ ≤ c*_k}; the whitened minimax medioid as commitment point.

## 1. Notation

n state dimension (6: GCRF position and velocity, SI); m measurement
dimension; {χᵢ} the support (M points); πᵢ ∈ (0, 1] possibility; Φᵢ = −log πᵢ
impossibility; γᵢ = h(χᵢ) predicted measurement; eᵢ = y − γᵢ innovation (angles
wrapped to [−π, π]); Π_e innovation shape, qᵢ = eᵢᵀ Π_e⁻¹ eᵢ whitened squared
innovation, ψᵢ = ½qᵢ surprisal; R = diag(σ²) from the observation sigmas; Q the
module's process-noise covariance (state-noise or dynamic-model compensation)
over the step; MVEE(X) the minimum-volume enclosing ellipsoid {x : (x − c)ᵀ S⁻¹
(x − c) ≤ 1} with shape S.

## 2. TEAG primitives (`src/teag.hpp`, method `evaluate_teag`)

| Primitive | Function | Source |
| --- | --- | --- |
| Impossibility field Φ = −log π | `impossibility`, `possibility` | TEAG Def. 3.10; HJ Def. 1, eq. 3 |
| Conjunctive (max-plus) update Φ⁺ = max(Φ⁻, ψ) | `conjoin` | TEAG §3.4.2, Prop. 3.12; HJ Def. 3, eqs. 5–6 |
| Max-rescaling π′ = π̂ / sup π̂, i.e. Φ′ = Φ⁺ − min Φ⁺ | `rescale` (returns the shift −log sup π̂) | TEAG eq. 1 |
| Active deformation front {Φ⁻ = ψ} and the history- and evidence-governed regions | `zones` | HJ Def. 4, eq. 7; TEAG Thm. 3.13 |
| α-cut H_α = {Φ ≤ −log α} | `alpha_cut` | TEAG Def. 1.1 (iii), §3.4.4 |
| Possibility Π(A) = sup_{h∈A} π(h); necessity N(A) = 1 − Π(Aᶜ) | `possibility_of`, `necessity_of` | E25 §5.2; TEAG Remark 3.7 |
| Choquet surprisal S̄ = sup min(½qᵢ, πᵢ); information I = 1 − e^{−S̄} | `choquet_surprisal`, `information_content` | TEAG Def. 4.4; HJ Def. 7, eq. 30; OPT §2 |
| PCRB floor (n/2) log(1 − I) | `pcrb_floor` | TEAG Thm. 4.5, eq. 8; OPT §3 (PCRB lemma); HJ eq. 31 |
| PCRB basin r* = r⁻((1 − I)M/M_surv)^{1/n}, c* = ½r*² | `pcrb_basin` | TEAG Def. 3.15; HJ Remark 4 |
| MVEE | `mvee` (Khachiyan 1996 with Todd–Yıldırım 2007 away steps) | TEAG §3.5, eqs. 2–4; OPT §2 |
| Minimax medoid argmin_i max_j ρ(hᵢ, hⱼ) | `minimax_medoid` | TEAG Axiom 3.5, Prop. 3.21; HJ Def. 9, eq. 49 |
| Smolyak Clenshaw–Curtis grid | `smolyak_clenshaw_curtis` | E25 §6.4 |
| Outer bound of a Minkowski sum of ellipsoids | `minkowski_outer` (minimum-trace member (1 + 1/p)A + (1 + p)B, p = √(tr A / tr B); Kurzhanski and Vályi 1997) | E25 §8.1 "bound(E_h ⊕ E_v)", §7.3 |
| Possibilistic entropy ∫₀¹ log V_α dα | `possibilistic_entropy` (truncated, G12) | TEAG Def. 4.1; OPT §2 |
| VFI eigenvalue floor | `clamp_eigenvalues` | TEAG Def. 2.1 (A4) |

The MVEE runs in coordinates whitened by the sample covariance (it is affine
equivariant, so this conditions the arithmetic only), stops when both
optimality gaps are below the tolerance, then scales the shape by the largest
normalized distance of any point so that every point lies inside.

## 3. ESPF 2026 (`EstimatorKind::ESPF_2026`, `espf.cpp` `step_2026`)

The canonical recursion of TEAG §5.1 with HJ Thm. 1 (predict, update,
regenerate), OPT's selection and controller, and the v3 statements.

1. **Initial support.** χ_j = x₀ + L₀ ξ̂_j, L₀L₀ᵀ = r₀²P₀, ξ̂ the Smolyak grid of
   level 3 scaled into the unit ball (G4, G20); π_j = 1 ("initialized
   uniform", TEAG §5.1); σ = σ₀ = 1.
2. **Predict** (HJ Thm. 1 (i), eq. 26: transport with π unchanged). Each χ_j is
   propagated to the observation epoch through the inverted port (the caller
   answers with propagator/hpop at full force).
3. **Jaynesian expansion** (TEAG §3.1; E25 §7.2–7.3; OPT §1.1): the cloud's
   MVEE shape S_f is replaced by the outer bound of S_f ⊕ k_w²Q by an affine
   stretch about its centre (G5).
4. **Innovation geometry** (OPT §2, innovation geometry; TEAG §3.5): Π_e =
   bound(MVEE({γ_j}) ⊕ Π_y), Π_y = k_y²R (G6); qⱼ, ψⱼ = ½qⱼ (HJ Def. 2, eq. 4;
   TEAG Remark 3.24).
5. **Information content** (TEAG Def. 4.4): S̄ = sup min(½qⱼ, πⱼ), I = 1 − e^{−S̄}.
6. **Conjunctive update** Φ⁺ = max(Φ⁻, ψ) (HJ eq. 27), then rescaling (TEAG
   eq. 1). The shift −log sup π̂ is reported (G1).
7. **Survivors** (TEAG Def. 3.15, Def. 3.17; v3): {Φ′ ≤ c*} with r⁻ = 1 and
   M_surv = #{Φ′ ≤ ½} (G7); at least N_min = 2n + 1 survivors, the smallest Φ′
   (OPT §2, definition of the admissible class; TEAG §5.1). The selection
   depends on q alone because π = 1 before every update (Def. 2.1 A5).
8. **Commitment**: the minimax medoid of the survivors in the metric of their
   MVEE (TEAG §5.1, Remark 3.6; v3 "MVEE-whitened metric"); the innovation
   metric of HJ eq. 48 is an option (G11).
9. **σ controller** (HJ §6: r₊ = 1.15, r₋ = 0.97; TEAG Remark 3.25): expand
   σ ← min(σ_max, 1.15σ) when the realised support contraction ½Δ log det MVEE
   reaches the PCRB floor (n/2) log(1 − I), otherwise σ ← max(σ_min, 0.97σ)
   (G18).
10. **Regeneration** (HJ Thm. 1 (iii), Remark 15): χ_j = h* + L ξ̂_j with LLᵀ =
    σ² MVEE(survivors), eigenvalues floored at 10⁻¹² of the largest (VFI,
    G4); π_j = 1 (Φ reset to zero, G19).

Reported per observation (`SupportEpoch`): the posterior set (MVEE of the
survivors), the carried set (σ² of it), the predicted set, support and
survivor counts, the medoid index, S̄, I, the rescaling shift, min q, the basin
radius and threshold, the PCRB floor, the realised log-volume change, σ, the
regime indicator log det(Π_y⁻¹ MVEE(h(X))) (G26), optionally the truncated
entropy and the survivors themselves.

## 4. ESPF 2025 (`EstimatorKind::ESPF_2025`, `step_2025`)

The Algorithm of E25 §12 with the details of §§6–11.

1. **Initial support** (§6.1, §6.4.3): the box x₀ ± r₀√P₀ᵢᵢ (G20), Smolyak level 2
   points mapped into it (2n + 1 points: centre and axis points); π = 1.
2. **Predict** (§7.1): each point propagated through the port.
3. **Minkowski expansion** (§7.2–7.3, §11.2): the spread
   Π_F = (1/2n) Σ_{i≥1} (χᵢ − χ₀)(χᵢ − χ₀)ᵀ replaced by bound(Π_F ⊕ k_w²Q) by an
   affine stretch about χ₀ (G5).
4. **Joint epistemic spread** (§8.1): Π_h = (1/2n) Σ_{i≥1} (γᵢ − γ₀)(γᵢ − γ₀)ᵀ (G24),
   Π_v = k_y²R, Π_e = bound(Π_h ⊕ Π_v).
5. **Uniform compatibility** (§8.1): Compᵢ = 1 if eᵢᵀΠ_e⁻¹eᵢ ≤ r², else 0;
   r = √(−2 log(1 − η)) = 3 (G13; η = 1 − e^{−4.5}).
6. **Surprisal pruning** (§8.2): Sᵢ = −log(Compᵢ + ε_c), pruned when Sᵢ >
   S_threshold.
7. **Sup–min fusion** (§8.3): πᵢ ← min(πᵢ, Compᵢ) on the survivors. If every
   point is falsified the evidence is not applied (G9).
8. **Mode** (§9): x̂ = Σ wᵢχᵢ, wᵢ ∝ πᵢ Nᵢ, Nᵢ = exp(−½ eᵢᵀΠ_e⁻¹eᵢ) (G14).
9. **Spread** (§10.1, §11.3.1): Π_k = (1/2n) Σ_{retained} (χᵢ − x̂)(χᵢ − x̂)ᵀ +
   ε diag(Π_k) (G17; G10 when singular).
10. **Radius** (§10.2): D_k = log det Π_k; r_k ← r_k(1 + λ₊ΔD) or r_k(1 − λ₋|ΔD|).
11. **Spread scale** (§10.3): S̄_k = mean of Sᵢ over all points (G15);
    S_k = S₀(1 + λ_s(S̄_k − S_ref)); σ_raw = σ₀ exp(−λ_d D_k + λ_s(S_k − S_ref));
    σ_k = clamp(σ_raw, σ_min, σ_max) exp(−λ_t τ), τ the number of assimilated
    observations.
12. **Kernel and regeneration** (§10.4–10.5): χ₀ = x̂, χ_{±i} = x̂ ± σ_k L_{:,i}
    (ζᵢ = 1, G16), LLᵀ = Π_k; possibilities exp(−σ_k²/(2r_k²)) from the
    kernel π(x) = exp(−(x − x̂)ᵀΠ_k⁻¹(x − x̂)/(2r_k²)).

**Gaussian limit** (`gaussian_limit`, `step_gaussian`; E25 Appendix B): the
unscented transform's points and weights (α, β, κ as the UKF's options),
kernels read as densities, additive Q (B.2) and R and product fusion (B.3):
the Kalman update with unscented moments. It is written independently of the
module's UKF so that agreement tests the reduction claim (T2).

## 5. Ellipsoidal set-membership filter (`ELLIPSOIDAL_SET_MEMBERSHIP`)

Bounded-set baseline (F. C. Schweppe, IEEE TAC 13(1), 1968; D. P. Bertsekas and
I. B. Rhodes, IEEE TAC 16(2), 1971; the optimal bounding ellipsoids of E.
Fogel and Y. F. Huang, Automatica 18(2), 1982):

- initial set {(x − x₀)ᵀ(r₀²P₀)⁻¹(x − x₀) ≤ 1};
- predict: centre by the propagator, shape F S Fᵀ ⊕ k_w²Q (minimum-trace outer
  bound), F the propagator's STM;
- update: the outer family {(1 − ρ) δxᵀS⁻¹δx + ρ (e − Hδx)ᵀR_b⁻¹(e − Hδx) ≤ 1},
  R_b = k_v²R, H the measurement Jacobian at the propagated centre; the member
  of minimum trace (or log det) over ρ ∈ [0, 1) by a 200-point grid and
  golden-section refinement;
- an observation whose set misses the predicted set (β(ρ) < 0 for some ρ, by
  the S-lemma) is flagged inconsistent and leaves the set unchanged.

The linearization error is not bounded (B1): the set is guaranteed only for
linear dynamics and measurements with the noise inside its bound.

## 6. Screening admissible trajectories (conjunction-assessment `possibility_of_collision`)

ASO catalog whitepaper §12; TEAG Remark 3.7. Finite supports: a pair (i, j)
collides when its rectilinear closest approach within ±T of the common epoch
is within the combined hard-body radius R; the joint possibility of a pair is
min(πᵢ, πⱼ) (non-interactive objects: correlated errors need a joint
support); Π(C) is the largest joint possibility of a colliding pair and
N(C) = 1 − Π(Cᶜ). Ellipsoidal kernels π(x) = exp(−d²/2): the relative kernel is
bounded from outside by the minimum-trace outer bound of the two shapes'
Minkowski sum (a conservative possibility), and the event is evaluated in the
encounter plane at the nominal closest approach, the short-term assumptions
of Foster's probability: Π(C) = exp(−m²/2), m the shape distance from the
mean miss to the disk; N(C) = 1 − exp(−m_out²/2) when the mean miss lies in the
disk (m_out its distance to the circle), else 0. Possibility and necessity are
not collision probabilities; finite supports screen only what they sample.

## 7. Gaps and the choices made

| ID | Gap or inconsistency | Choice |
| --- | --- | --- |
| G1 | TEAG eq. 1 max-rescales π̂ to sup 1 and states that the update satisfies Popperian contraction (Axiom 3.2). Rescaling raises every possibility when the evidence conflicts with all hypotheses (sup π̂ < 1): prior (1, e⁻¹), compatibility (e⁻², e^{−1.5}) gives π′ = (e^{−0.5}, 1). | The conjunctive update is computed unnormalized (monotone, idempotent: tests T3); rescaling is a separate step whose shift is reported. Survivor selection uses the rescaled field. |
| G2 | E25 §6.4.1 gives m_i = 2^{i−1} + 1 for every level i; at i = 1 that is two nodes and the level-1 grid is the 2ⁿ corners. | The standard nested rule m₁ = 1 (node 0), m_i = 2^{i−1} + 1 for i ≥ 2. Level 2 gives the stated 2n + 1 points. |
| G3 | Level-3 support counts disagree: TEAG §5.1 M = 2n² + 1; OPT §6 M = 106 for n = 7 (2n² + n + 1). The standard Clenshaw–Curtis Smolyak count is 2n² + 2n + 1. | The standard grid: 85 points for n = 6 (113 for n = 7). |
| G4 | How grid nodes map into an ellipsoidal support is not stated. | The grid is scaled into the unit ball (its MVEE, by symmetry), so the regenerated cloud's MVEE is exactly σ²·MVEE(survivors). |
| G5 | The prediction is a Minkowski sum F ⊕ W (E25 §7.2–7.3); E25 §11.2 samples w⁽ⁱ⁾ from supp(π_w); TEAG and OPT call it Jaynesian expansion. How points move is not given. | A deterministic affine stretch of the propagated cloud from its MVEE (2025: its spread) to the minimum-trace outer bound of the sum with the process set k_w²Q. |
| G6 | OPT: Π_e is "formed from the MVEE of the predicted measurement support and the sensor imprecision matrix Π_y"; the rule is not stated. | Π_e = bound(MVEE(h(X)) ⊕ Π_y), as E25 §8.1's joint spread; Π_y = k_y²R, k_y = 1. |
| G7 | TEAG Def. 3.15: r⁻ "the whitened MVEE radius of the prior support" and M_surv are not defined operationally. | r⁻ = 1 (Zone II at ‖z‖ = 1, TEAG Def. 3.14); M_surv = #{Φ′ ≤ ½}, the survivors at the prior radius. |
| G8 | OPT Thm. 4.1 sets N_target = ⌊(1 − I)M⌋ survivors; TEAG and the v3 abstracts select by the basin. | The basin (v3). N_target is not used. |
| G9 | E25 does not say what happens when every point is falsified. | No update; the observation is flagged inconsistent; the mode uses the prior possibilities only. |
| G10 | E25's spread is singular with fewer retained points than dimensions. | Fall back to the predicted spread. |
| G11 | Medoid metric: HJ eq. 48 uses the innovation metric (measurement space, S_k), TEAG §5.1 and Remark 3.6 the MVEE metric of the surviving support, the v3 abstract "the MVEE-whitened metric". The innovation metric is degenerate when m < n. | The MVEE of the survivors (state space); the innovation metric is the option `medoid_metric = 1`. |
| G12 | V_α = 0 for cuts with fewer than 2n + 1 points (OPT §2) makes E_π = −∞ for every non-uniform possibility on a finite support. | The entropy is the integral over the cuts with at least 2n + 1 points, with that truncation level reported; diagnostic only. The σ controller uses the support-volume term. |
| G13 | E25 gives no values for λ_d, λ_s, S_ref, S₀, λ±, σ₀, σ_min, σ_max, η, ε_c or S_threshold, and gives λ_t = 0.05 with τ the measurement count (§10.3.4; Appendix A: γ_t = exp(−0.05τ)). With τ the count, σ_k → 0 within about 100 observations and the support collapses. | Stated values as stated; the unstated gains neutral (0, σ₀ = 1, no clamp); r = 3 (the ±3σ bands of §14.1, η = 1 − e^{−4.5}). With these the recursion contracts by σ_k² and by pruning at every step and has no stated re-expansion (observed in `tests/espf.test.mjs`: 2.1 km to 2 mm in 12 steps). E10 pre-registers a tuned variant. |
| G14 | §9: wᵢ = πᵢNᵢ / Σ πⱼNⱼ with Nᵢ undefined; the singleton necessity 1 − max_{j≠i} πⱼ gives zero weights whenever two points have π = 1. | Nᵢ = exp(−½ eᵢᵀΠ_e⁻¹eᵢ), the graded residual possibility π_e of §8.3 ("centered on ... measurement alignment"); the singleton necessity (argmax) and the compatibility are options. |
| G15 | §10.3.3: S̄_k "average surprisal across retained points"; retained points have Comp = 1, so S̄ ≈ 0 always. | The mean over all predicted points. |
| G16 | §10.5: χ = x̂ ± σ_k L_{k,i} ∘ ζᵢ with ζᵢ undefined. | ζᵢ = 1: column i of the Cholesky factor. |
| G17 | §11.3.1: Π + εI, ε = 10⁻⁶, is dimensionally inconsistent for position and velocity (in the paper's km and km/s it is 1 m² and 1 (m/s)², the latter not small). | Π + ε diag(Π), ε = 10⁻⁶; the absolute form is an option. |
| G18 | HJ §6: the σ controller "triggers expansion" as contraction approaches the PCRB floor, with rates r₊ = 1.15, r₋ = 0.97; trigger and bounds are not given. Because S̄ ≤ 1 (the capacity π is at most 1), I saturates at 1 − e⁻¹ as soon as one fully possible hypothesis has q ≥ 2, and the floor is then fixed at −n/2. | Expand when ½Δ log det MVEE ≤ κ (n/2) log(1 − I), else contract; κ = `pcrb_trigger` (1: reaching the floor; "approaching" is a fraction κ < 1); σ ∈ [0.1, 1], σ₀ = 1. OPT's Table 1 shows exactly 0.97 per step in nominal tracking. |
| G19 | Regenerated possibilities: HJ Thm. 1 (iii) resets Φ = 0; OPT §2 extends possibilities by a max–min kernel with an unspecified proximity kernel κ. | Reset (HJ, v3). |
| G20 | Initial support: a hyperrectangle (E25 §6.1) or "a constrained admissible region" (E25 §15). | 2025: the box x₀ ± r₀√P₀ᵢᵢ; 2026: the ellipsoid r₀²P₀; r₀ = 3. |
| G21 | The rank-aware PCRB (m/2 in place of n/2) is known from an abstract only. | n (TEAG Thm. 4.5) by default; m as option `pcrb_rank = 1`. |
| G22 | TEAG v1 Thm. 6 falsifies h when ψ(h) > Φ⁻(h); v2 Remark 3.19 replaces this with basin exit. With Φ⁻ = 0 after regeneration the v1 rule would falsify almost every point. | v2/v3 basin exit. |
| G23 | E25 Table 1's "Necessity Retention" and "Avg Surprisal" are not defined. | Not reproduced. |
| G24 | E25 §8.1 does not give the formula for Π_h(X). | (1/2n) Σ_{i≥1}(γᵢ − γ₀)(γᵢ − γ₀)ᵀ, as §10.1 for the state. |
| G25 | Angle wrap-around of the measurement support is not discussed. | Angles unwrapped about point 0, as the module's UKF. |
| G26 | OPT's regime indicator "log det(MVEE) < 0 in innovation-normalized coordinates". | log det(Π_y⁻¹ MVEE(h(X))). |
| G27 | HJ eqs. 15–16 and 47 (Thm. 2) state −T log(e^{−a/T} + e^{−b/T}) → max(a, b) as T → 0. The limit is min(a, b) (log-sum-exp is a soft minimum here); the Bayesian posterior adds the fields, a + b. | Not used. The module's update is the max-plus rule itself. |
| G28 | HJ §4.3: for σ_n > σ₀ the "surviving well" {Φ∅ ≤ Φ_S} is where the surprisal governs (region (ii) of §3). Its medioid, eq. 14, lies on the far side of h₀ from y; the posterior impossibility max(Φ∅, Φ_S) is smallest at the inner root h₋. | Test T1 reproduces eqs. 11–14 as published. |
| G29 | E25 §13.2 gives Arecibo's RA bias as 0.00016 arcsec; §14.2 as 10 arcsec. The GEO arc is 180 min at one measurement per 15 s (720 measurements), but the area change reverts at measurement #5492. | Resolved in E10's plan. |
| G30 | Compatibility is binary in E25 (§8.1) and graded, exp(−q/2), in OPT, TEAG §5.1 and HJ. | Each variant as its papers state. |

## 8. Parameters

| Parameter | Value | Source |
| --- | --- | --- |
| Smolyak level (2026) | 3 (85 points, n = 6) | OPT §7 ("Level 3 is the minimum resolution"); G3 |
| Smolyak level (2025, initial) | 2 (13 points) | E25 §6.1, §12 ("support points 2n + 1") |
| N_min | 2n + 1 = 13 | OPT §2 (definition of α-cuts), TEAG §5.1 |
| r₀ initial bound | 3 | choice (G20) |
| k_w process set scale | 1 (ESPF), 3 (set-membership) | choice: the ESPF shapes are spreads; the set-membership set is a bound |
| k_y sensor set scale | 1 (ESPF), 3 (set-membership) | as k_w |
| σ₀, σ_min, σ_max (2026) | 1, 0.1, 1 | choice (G18); OPT Table 1 starts at 0.970 after one contraction |
| r₊, r₋ | 1.15, 0.97 | HJ §6; TEAG §1.4, Remark 3.25, Remark 4.6 |
| κ (`pcrb_trigger`) | 1 | choice (G18) |
| r⁻ | 1 | choice (G7) |
| PCRB dimension | n | TEAG Thm. 4.5 (G21) |
| Medoid metric | MVEE of survivors | TEAG §5.1 (G11) |
| VFI floor | 10⁻¹² λ_max | choice; TEAG Def. 2.1 (A4) states only ε > 0 |
| MVEE tolerance | 10⁻⁷ (filter), 10⁻⁹ (evaluate_teag default) | choice |
| r (2025) | 3 (η = 0.98889) | choice (G13) |
| ε_c, S_threshold (2025) | 10⁻⁶, 1 | choice; with binary compatibility any S_threshold in (0, 13.8) prunes the same points |
| ε regularization (2025) | 10⁻⁶ relative | E25 §11.3.1 value, relative form (G17) |
| λ_t (2025) | 0.05 | E25 §10.3.4 and Appendix A |
| σ₀, σ_min, σ_max, λ_d, λ_s, S_ref, S₀, λ₊, λ₋ (2025) | 1, 0, ∞, 0, 0, 0, 1, 0, 0 | unstated; neutral (G13) |
| Mode weights (2025) | πᵢ exp(−½dᵢ²) | choice (G14) |
| UKF α, β, κ (Gaussian limit) | 1, 2, 0 | the module's UKF defaults |

## 9. Tests (independent references)

| ID | Claim | Reference | Where | Result |
| --- | --- | --- | --- | --- |
| T1 (a) | Scalar front, well width and medioid | HJ §4 eqs. 8–14 | `tests/teag.test.mjs` | exact on dyadic cases; one grid step otherwise |
| T2 (b) | E25 Appendix B: the Gaussian limit reproduces the UKF | the module's UKF (itself against Orekit 13.1), full-force HPOP answers | `tests/espf.test.mjs` | state 1.6e-14, covariance 1.9e-11 relative over 12 epochs |
| T3 (c) | Idempotence, Popperian monotonicity, α-cut intersection (TEAG Prop. 3.8), N(A) = 1 − Π(Aᶜ), maxitivity; the G1 counterexample | possibility-theory identities | `tests/teag.test.mjs` | exact |
| T4 (d) | MVEE | analytic (box, simplex, ellipse, Smolyak grids) and an independent numpy implementation | `tests/teag.test.mjs`, `tests/mvee.test.mjs`, `tests/fixtures/mvee_numpy_reference.py` | about 1e-12 against numpy |
| T5 (e) | SDK compliance; tri-runtime byte parity | SDK validators; Chrome, native WasmEdge, Docker WasmEdge | `tests/sdk_compat.test.mjs`, `tests/parity.mjs` | see `conformance/` |
| T6 | Set-membership filter: the truth stays inside the bound when the noise bound holds; an impossible observation is flagged | Schweppe 1968 | `tests/espf.test.mjs` | pass |
| T7 | Screening: Π, N and α-cut ranges by definition; the encounter-plane closed forms; brute force | definitions; closed forms | conjunction-assessment `tests/possibilityScreening.test.mjs` | exact / 1e-12 / 1e-8 |
| T8 | Measurements: `LINEAR` records (y = H x + offset, H value_count × 6) take the core filters' measurement model; H = [I 0] reproduces `POSITION_VECTOR` | identity | `tests/espf.test.mjs` | byte-identical in ESPF 2026, ESPF 2025 and the set-membership filter |

## 10. What needs the authors' implementation or the v3 full texts

- Every G-item marked as a choice above, especially G5 (how process noise
  enters a finite cloud), G7 (r⁻ and M_surv), G13 (the 2025 gains and the
  temporal decay), G14 (Nᵢ), G18 (the σ controller's trigger) and G19 (reset
  versus kernel extension).
- The rank-aware PCRB (Preprints 202607.2165): its basin radius and its
  "falsifiable prediction about previously reported over-pruning".
- The exact Smolyak construction behind OPT's M = 106 and TEAG's 2n² + 1.
- The noise levels, measurement types and run settings of E25's Table 1 (E10
  Part A states its own by rule).
- Whether the v3 texts change the medoid metric, the basin inputs or the
  zero-temperature statement (G27).
