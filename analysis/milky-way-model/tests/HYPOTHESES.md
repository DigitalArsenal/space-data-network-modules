# Run-three hypothesis evidence

The final browser E2E passes 59/63 checks: l=180/270 FWHM, the Rift, and the
3-kpc arm chi-square fail. No configuration passes the fixed Gaia requirements. This is a physical-model
investigation, not approval to land. The production bake is unchanged. It still
uses the inherited Gaia-fitted dust normalization, which is not independent
physics. None of the new candidate values was fitted to the Gaia oracle.

`literature-hypotheses.cpp` evaluates seventeen fixed configurations using the
same RGBA16F volumes, ray integrator, Hammer projection, 0.5-degree sampling,
display conversion, and acceptance statistics as the browser E2E. It is native
independent evidence, not another E2E or a unit test. All results, including
failures, are in `hypotheses-run3.csv`; definitions and citations are in
`literature-hypotheses.hpp`. The only E2E remains `band-vs-gaia.e2e.mjs`.

## Requested before/after table

Widths are degrees in the order l=0/90/180/270. Every individual hypothesis
starts from the same run-two baseline; combined trials are separately labeled
in the CSV. The e row uses the complete published disk/arm/local dust candidate.

| Hypothesis | FWHM before | FWHM after | Rift before -> after |
| --- | --- | --- | --- |
| (a) Same measurement, audited without alteration | 16.280 / 17.884 / 12.927 / 9.257 | 16.280 / 17.884 / 12.927 / 9.257 | 1.171765 -> 1.171765 |
| (b) Local grid: replace local samples with interpolated global samples | 16.280 / 17.884 / 12.927 / 9.257 | 16.242 / 17.815 / 12.883 / 9.211 | 1.171765 -> 1.172709 |
| (c) BHG2016 thin/thick disk parameters | 16.280 / 17.884 / 12.927 / 9.257 | 16.978 / 16.680 / 12.450 / 8.896 | 1.171765 -> 1.200719 |
| (d) Chen2019 warp with LC2002 flare and BHG disk | 16.280 / 17.884 / 12.927 / 9.257 | 16.606 / 19.099 / 17.962 / 13.317 | 1.171765 -> 1.162364 |
| (e) DS2001 disk, separate arm dust and local segment | 16.280 / 17.884 / 12.927 / 9.257 | 19.812 / 16.459 / 9.651 / 24.052 | 1.171765 -> 0.986841 |
| Gaia oracle | 15.417 / 18.473 / 5.683 / 22.653 | same | 0.849495 |

The unchanged width tolerance is 25%, flux r >=0.85, density r >=0.75, and
Rift ratio strictly between zero and one. No rounded value votes in acceptance.

## (a) Measurement consistency

Both maps use the same linear-display-luminance profile, four longitude columns,
60<=|b|<80-degree mean floor, and outer half-height crossings. The source routine
was extracted unchanged into `src/sky_morphology.hpp` before behavior changes.
Adding a constant floor to both maps changes widths by less than 0.000002 degrees
(float storage). Therefore a missing *constant* halo floor cannot explain these
failures. A spatially varying halo would require independent population evidence.

For comparison only, using log profiles on both maps gives model widths
33.860/35.373/28.730/26.660 versus Gaia 31.563/43.765/41.312/48.831. The failed
outer cuts remain; this alternative is not adopted. The global display exponent
is 1.041106 for the baseline. Gaia's published 8-bit display stretch is not an
invertible photometric calibration, and its bright-source fluctuations remain.

## (b) Solar neighborhood and luminosity weighting

At R0,z=0 the analytic/global/local G emissivities are 1.370802/1.353631/1.312963;
at the actual Sun they are 1.249394/1.251608/1.251343. The local grid has no
extra normalization. Its missing exact midplane center slightly underestimates
the cusp; it does not overproduce nearby light. Across cube faces, the maximum
unblended G difference is 3.709%; the blended +/-1e-6-kpc seam is 4.89e-6
relative. Eliminating the local grid changes every width by less than 0.07 deg.

[Flynn et al. 2006 Table 5](https://arxiv.org/abs/astro-ph/0608193) independently
gives V-band thin/thick local luminosities 0.054/0.002 Lsun pc^-3 and column
luminosities 19.92/4.43 Lsun pc^-2. Their ratio supplies effective exponential
heights 0.18444/1.1075 kpc. This moment-matched proxy is not their full dynamical
profile and V is not Gaia G. The I-band moments provide a separate proxy.
Both narrow the anticenter but lose l=90/270 and the Rift, even with DS dust.
The production relative G channel cannot be assigned an absolute local G
luminosity without population/passband modeling; a uniform rescaling alone
cancels from the display-normalized width.

## (c) Outer disk

[Bland-Hawthorn & Gerhard 2016](https://arxiv.org/html/1602.07702#S5) gives the
same thin-disk length/height 2.6/0.3 kpc as the baseline, but a preferred thick
disk with length 2.0 kpc, height 0.9 kpc and local ratio 0.04. Its distinction
from Jurić's photometric population is material; these are alternative tracers,
not evidence that either ratio can be tuned continuously. It fails the widths.

Removing the illustrative 14-16-kpc taper, motivated by
[López-Corredoira et al. 2002](https://arxiv.org/abs/astro-ph/0208236), changes
l=180 from 12.927 to 12.752 degrees. The fixed global volume still clips at
16 kpc, so this is not evidence for an infinite physical disk.
[Natale et al. 2021 Table 2](https://arxiv.org/html/2111.02180#S3) supplies an
independent 3.10-kpc V-band radial length; combining it with Flynn V and DS dust
also fails (six Gaia conditions). No numerical radial value was optimized.

## (d) Flare and warp

[Chen et al. 2019 Table 1](https://arxiv.org/abs/1902.00998) supplies
z_w=0.060 max(R-7.72,0)^1.33 sin(beta-17.5 degrees), in kpc. The experiment
translates disk, arm and dust heights together; central bar/bulge stay fixed.
Applying the young-star/gas warp to all disk light is an explicit approximation.
Warp alone gives widths 16.370/17.716/14.029/11.600, flux r=0.844607.

LC2002 Eqs.3,25,26 supplies an outer flare length 5.0 kpc, local height
0.285 kpc and radial surface-density length 3.3 kpc. Its vertical factor is
divided by the flare to conserve the surface density. Flare alone gives
15.801/20.003/17.133/11.381, flux r=0.856240. It broadens the anticenter.
[Momany et al. 2006](https://arxiv.org/html/astro-ph/0603385#S4) describes tracer
mixing and defers a quantitative flare parameterization; no new numbers were
invented from its qualitative trend. Neither warp nor flare solves the mismatch.

## (e) Dust and remaining foreground structure

[Drimmel & Spergel 2001](https://arxiv.org/html/astro-ph/0101259#S3.SS2) supplies
the sech-squared disk, 2.26-kpc radial length, 0.1344-kpc base height, flare,
arm profiles, and narrow local segment with its solar gap. Tables 1/2 supply
the density/opacity normalization. Reid arm centers replace their HII centers
as required by this task; this adaptation is not an exact reproduction of DS.
[Wang & Chen 2019 Table 3](https://arxiv.org/html/1904.04575#S3.SS4) supplies
A_G/A_V=0.789, an average red-clump approximation, not a universal passband law.

DS dust plus the baseline emissivity and no outer taper is the most useful
independent dust candidate: flux/density r=0.849693/0.938654, FWHM
19.818/16.424/9.498/23.943 and Rift=0.986208. It passes l=90, l=270 and the
Rift, but fails flux and l=0/180. Its largest width error is 67.12% at l=180.
It is retained as an experiment, not shipped as an accepted model.

Integrating only the first 2 kpc at l=10/30/50, b=0 gives baseline optical
depths 0.830/0.719/0.298 versus DS 1.613/1.485/1.139. Almost none comes from
DS's narrow local segment in those directions (<5e-11 optical depth). At l=75
the segment supplies 0.127, and at l=270 it supplies 0.271. Thus it repairs
the tangential dip without resolving the independently structured Aquila/Rift
foreground at l=10-50. Acceptance still measures its original l=60-90 region.

A real spatial extinction grid and a consistent G-band population luminosity
model are the remaining physical inputs. Increasing a cloud amplitude or moving
a cloud to match these maps would be test-set fitting. No such tuning, extra
source exclusion, oracle bundling, threshold change, or contract change was made.

## Reproduction

Decode the two hash-checked PNG caches to raw RGBA8 using an image decoder;
the diagnostic expects 4000x2000 and 1500x750 pixels. From the module directory:

```sh
clang++ -std=c++17 -O3 -pthread tests/literature-hypotheses.cpp -o .build/hypotheses
.build/hypotheses /path/to/flux.rgba /path/to/density.rgba
```

The optional third argument is the first case index, for continuing a recorded
batch without repeating earlier whole-sky evaluations. No random search occurs.
