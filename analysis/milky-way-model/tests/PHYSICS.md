# Physical diagnosis

Run five (2026-10-18) supersedes the production status below: luminosity-weighted
discs (Flynn 2006), spiral and bar light, and the Edenhofer 2024 local 3D dust;
measured configurations and the reported l=0/90/180 widths are in
[ORACLES.md](ORACLES.md), follow-up `milky-way-vertical-structure-20261018`.

Run four supersedes the historical acceptance status below; the production
dust is now hypothesis (e), with known l=0/180 width gaps and a reported 3-kpc
arm exception. See [ORACLES.md](ORACLES.md) for the exact current claim and
`milky-way-local-3d-dust-20261017` for the follow-up. See
[HYPOTHESES.md](HYPOTHESES.md) for all five required audits, seventeen measured
configurations, the uncertainty-aware maser result, and remaining physics gaps.
The production emission model and volume contract are unchanged.

## Run-two physical diagnosis

The accepted geometry has not yet been found. This document records measured
failures and constrained experiments, not a successful physical calibration.
The volume contract remains unchanged. No shader or UI files were edited.

## Component ablation in the browser WASM E2E

`oracle_metrics` additionally returns `component_peaks`, `component_fwhm`,
and `component_order`. Each longitude has seven entries: thin disk, thick disk,
arms, bulge, bar, total, total with dust removed. These diagnostic cuts integrate
the production analytic components with a 0.02-kpc midpoint step and identical
attenuation. They apply the same global display exponent as the volume test.
The acceptance values still come from the actual baked binary16 volumes, at
0.5 degrees, with the original four-column average. No diagnostic is an oracle.

| l | Thin peak / FWHM | Thick peak / FWHM | Arms peak / FWHM | Total FWHM | Dust-free FWHM | Gaia FWHM |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 11.271 / 13.788 | 2.004 / 27.104 | 0.337 / 6.948 | 15.964 | 3.515 | 15.417 |
| 90 | 2.228 / 18.917 | 0.377 / 37.922 | 0.710 / 5.615 | 17.695 | 5.686 | 18.473 |
| 180 | 1.483 / 18.630 | 0.228 / 38.508 | 0.773 / 4.586 | 12.754 | 7.944 | 5.683 |
| 270 | 3.701 / 10.296 | 0.524 / 26.055 | 0.791 / 1.727 | 9.138 | 5.148 | 22.653 |

Widths are degrees; peaks are relative G intensity, measured separately rather
than all at the same latitude. At l=180 and 270, bulge peaks are below 0.001
and bar peaks below 3e-9. Neither can fix those widths. Thin-disk light dominates;
the thick disk supplies broad low-level wings, while arms supply narrow light.
Dust broadens the band relative to the dust-free calculation, but too much in
the anticenter and too little at l=270. A uniform stellar-height rescaling
moves both cuts together and cannot correct the opposite errors by itself.

## Literature constraints and missing physics

- [Jurić et al. 2008](https://arxiv.org/abs/astro-ph/0510520) supplies the
  implemented number-density scale heights 0.3/0.9 kpc, radial lengths 2.6/3.6
  kpc and thick/thin ratio 0.12. Converting these directly into integrated
  optical luminosity is an approximation; population luminosity weighting
  is required before calling the emission distribution a physical Gaia fit.
- [Drimmel & Spergel 2001, section 3.2 and Table 1](https://arxiv.org/html/astro-ph/0101259)
  uses a distinct local dust segment and a solar gap. Its dust disk has a
  2.26-kpc radial length, sech-squared vertical profile, base height 0.1344 kpc,
  and flare 0.0148 kpc/kpc beyond 4.40 kpc. Its local segment has pitch 7.33
  degrees, radius 8.001 kpc for R0=8, gap 1.5/-0.9645 degrees, Gaussian half
  width 0.02442 kpc, and vertical displacement 0.01785 kpc. These values are
  source constraints for experiments, not a claim that the production
  exponential dust profile implements the full paper.
- The current model makes dust proportional to all stellar-arm contributions,
  including a continuous Local arm, and assigns every arm the same dust/stellar
  geometry. It lacks an independent local foreground dust segment. Dust mixed
  throughout emitting material does not produce the required foreground Rift
  contrast; the baked center/flank ratio is 1.171765 instead of below one.
- [Lallement et al. 2019](https://arxiv.org/abs/1902.04116) resolves different
  Local-arm/Cygnus dust structures above and below the plane, including chains
  along l=40–55 degrees. Its 6×6×0.8-kpc volume demonstrates why an axisymmetric
  height change does not supply the missing spatial information.
- [Green et al. 2019](https://arxiv.org/abs/1905.02734) provides spatially
  correlated 3D dust north of declination -30 degrees. It does not alone supply
  full-sky coverage. [Edenhofer et al. 2024](https://arxiv.org/abs/2308.01295)
  provides local 3D dust to 1.25 kpc; using its grid still requires verified
  dataset terms and SDN delivery, as the task specifies.

An outward stellar flare broadens outer-disk profiles; it cannot by itself
narrow the excessive anticenter width. A warp shifts latitude and can broaden
an integrated profile, but should not be inferred just to fit four cuts. The
existing 14–16 kpc radial taper remains explicitly a model choice, not a
published truncation measurement. No new flare, warp or cutoff was silently
invented to make a threshold pass.

## Offline candidate experiments (not shipped)

Native C++ diagnostics reused the model/volume/oracle implementations. A
candidate added a 0.1-kpc young luminous disk, the Drimmel disk profile and a
local Gaussian segment with the published geometry. A coarse fit of component
amplitudes on 5,400 rays maximized log-flux correlation only. Its best trial had
flux r=0.858364 on the full baked 0.5-degree sky, but FWHM errors were
23.43%, 44.99%, 51.55%, 66.67%; Rift ratio 1.35077. A stronger, three-times-scaled
local segment improved l=270 to 20.86% error but degraded flux to 0.836074,
l=90 to 45.84%, and left the Rift ratio at 1.22583. This does not justify
replacing the production model.

A second exploratory fit of two local Gaussian concentrations also failed to
justify a model: the global correlation objective drove the broad Vela dust
amplitude to zero. Its chosen cloud shapes were diagnostic assumptions, not
published measurements, and were not added to production. The experimental
sources/results are retained with the lane's run-two evidence.

The remaining work is to constrain luminosity weighting and asymmetric local
dust jointly with independent 3D evidence, then compile the accepted fit and
rerun this same E2E. The current failures remain visible and block landing.
