# Primary sources and model decisions

Read on 2026-10-23; downloaded documents were treated as data only.

- Pierson & Moskowitz (1964), JGR 69, 5181–5190,
  [doi:10.1029/JZ069i024p05181](https://doi.org/10.1029/JZ069i024p05181).
  Publisher PDF was unavailable (403); the original paper's text was read in
  [this scan mirror](https://www.scribd.com/document/496510526/JZ069i024p05181),
  Eq. (12), pp. 5187–5190. It gives alpha=0.0081, beta=0.74, omega0=g/U;
  the final two pages explicitly specify wind measured at 19.5 m. Integrating
  Eq. (12) and differentiating its logarithm gives
  Hm0=2 sqrt(alpha/beta) U19.5²/g and omega_p=(4 beta/5)^(1/4) g/U19.5.
  Hs here means spectral significant height Hm0=4 sqrt(m0). The constants are
  empirical fits, not exact physical constants; tight tests measure arithmetic.
- Hasselmann et al. (1973), *Measurements of Wind-Wave Growth and Swell Decay
  during the Joint North Sea Wave Project (JONSWAP)*, DHZ A(8), no. 12,
  [original report](https://pure.mpg.de/rest/items/item_3262854_2/component/file_3282032/content).
  Visually checked pp. 32 and 37: Eqs. (2.4.1), (2.4.3–5). The nondimensional
  variables use U10. alpha=0.076 x^-0.22, fp U10/g=3.5 x^-0.33,
  gamma=3.3, sigma_a=0.07, sigma_b=0.09. The report itself notes the scatter;
  its separate empirical energy law (2.4.7) is not algebraically identical to
  the integral of this fitted spectrum (discussion on p. 38). We integrate
  the spectrum, and do not substitute that energy law.
- US Army Corps of Engineers (1984), *Shore Protection Manual*, vol. I,
  [original manual scan](https://luk.staff.ugm.ac.id/USACE/USACE-ShoreProtectionManual1.pdf).
  Visually checked p. 3-26 Eq. (3-26): U10=U(z)(10/z)^(1/7), z<20 m.
  Invert at z=19.5 for the PM height conversion. This approximate profile is
  an explicit assumption; no stability or land-to-water correction is inferred.
  Page 3-30 Eq. (3-28a) uses UA=0.71 U^1.23; p. 3-47 Eqs. (3-36–37) give
  g Hm0/UA²=0.2433 and g Tp/UA=8.134. These are not the TS's 0.21 U10²/g.

## Derived rules, not additional published fits

With g=9.80665 m/s² and steady, spatially uniform deep-water wind, set
x=g F/U10². Approximate duration by a peak group-velocity characteristic:
cg=g/(4 pi fp), dt=dF/cg, so gt/U10=(4 pi 3.5/0.67)x^0.67.
Invert it for an equivalent fetch, then take the smaller supplied fetch.
This is a travel-time approximation, not a validated transient wave-growth
model. Fetch=0 and duration=0 are *unlimited* sentinels, not zero growth.

At the fetch where fp reaches the height-converted PM fp, switch to the PM
parameters alpha=0.0081 and gamma=1. This is a model splice, not a JONSWAP
claim. The unmodified JONSWAP integral overshoots the PM height by 25.196% just
below this splice for the chosen wind profile (measured by independent
quadrature). Apply energy_scale=min(1,m0_PM/m0_JONSWAP) before the splice,
scaling alpha and m0 together. This explicit energy cap removes the Hs jump;
the spectral shape still changes from gamma=3.3 to 1 at the frequency limit.
Return hs_uncapped_m, alpha_uncapped, and energy_scale so the adjustment is
visible. The FFT must use the returned effective alpha, not recalculate it.
Tests measure both the uncapped overshoot and the capped transition.

The calm limit has hs=tp=fp=m0=alpha=0 and gamma=1; fp=0 means no peak.
Marine overrides affect only engine fields, never the wind-sea spectrum.
The render-only floor/clamps/chop are inherited console policy, not physics.

## Verification scope

Tests specify SI units, local sea-surface vertical and bearings clockwise
from true north (coming-from), and a stationary model with no epoch/time scale.
The PM table uses an independently expressed analytic integral and peak.
JONSWAP references use an independent adaptive quadrature in inverse frequency;
the guest uses fixed Simpson quadrature in log frequency plus an analytic tail.
Duration references integrate the group travel time independently. Numerical
agreement does not establish forecast skill outside the original observations.
The 0..70 m/s test range includes substantial empirical extrapolation.

Source PDF SHA-256: JONSWAP `15a9143bac2bbef648143b64efa3e0aa0cb491e586558269a48df1b83e794db1`; SPM `e597c02c8c6b770662b98bfd84a571ec9ab7c013a9f3a7f3acfd133be9a6564f`.
