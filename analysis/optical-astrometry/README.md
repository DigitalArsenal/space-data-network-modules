# analysis/optical-astrometry

Optical frames to angles and an orbit, in WASM. One method, `reduce`: frames (FITS or PGM), element sets, Earth
orientation and the GP error model in; CCSDS TDM angles, `$EOO` observations, `$SKI` plate solutions, the orbit
(`$OCM`) and its trajectory (`$OEM`) out. The module holds no propagator and no star catalog: it asks for element-set
trajectories on a propagator query port (`$PRW` window requests, the contract of analysis/maneuver-detection and
analysis/rpo-history, answered by analysis/epoch-state or any provider) and for reference stars as catalog cones
(`$SKQ`, answered by any star service). Each call recomputes from its inputs and either asks for what is missing or
finishes, so it is stateless and every runtime gives the same bytes.

## Pipeline

| stage | method |
|---|---|
| frame times | FITS `DATE-OBS` (`time_reference` start, mid or end), or the burnt-in UTC overlay: a fixed-font digit matcher whose templates are built from the frames themselves, checked against a robust cadence line (outliers and duplicates refused) |
| sources | background and noise by median and MAD, segmentation, trail midpoints (a star trail's centroid is its mid-exposure place), a persistence mask for burnt-in text (video frames only) |
| plate solution | blind quad-hash solving of a reference frame (Lang, Hogg, Mierle, Blanton & Roweis 2010, AJ 139, 1782), then each frame from its neighbor; TAN projection (Calabretta & Greisen 2002, A&A 395, 1077) with a linear or quadratic plate, weighted least squares with outlier rejection |
| star places | catalog place to the epoch by proper motion and parallax, light deflection by the Sun and aberration by the observer's velocity (ERFA `eraPmpx`, `eraLdsun`, `eraAb`; the eraAtciq sequence in GCRS axes) |
| site and timing | when the site is not given: a site ridge from the field's drift rate along the calibrator's pass, candidate fields solved blind, then the site's latitude, longitude, height and the time-tag bias by weighted Gauss-Newton on the calibrator's directions with priors, its ephemeris error (R, T, N) estimated with them |
| identification | the tracked object is the calibrator; each target is the track among the bright persistent ones that a single orbit fits best (chi-square per degree of freedom with the prior), not the nearest prediction |
| orbit | Gooding's angles-only method (Gooding 1997, CeMDA 66, 387) on Izzo's Lambert solver (Izzo 2015, CeMDA 121, 1; analysis/lambert-izzo), then batch least squares with a priori information (Tapley, Schutz & Born 2004, ch. 4) on the prior set's trajectory through the two-body + J2 transition matrix; the site and timing as consider parameters (ibid. sec. 6.3); five-robust-sigma data editing |
| prior | the GP error model (`$ERM`, analysis/gp-error-model): the 6x6 RTN covariance of the target's prior set at its age at the arc (clipped stratum covariance, times the stratum's scale factors) |

Directions are geometric topocentric RA and declination in GCRF axes at the receive time (light time not removed, the
site's aberration removed). Time scales and frames are ERFA and the foundation/frames axis engine (IAU 2006/2000A CIO
chain, `$EOP` for UT1 and polar motion).

## Ports and options

The manifest describes every port. Options are the `optical` config table: `calibrator` (required), `targets`,
`site_latitude_deg` / `site_longitude_deg` / `site_height_m` (a known site), `search_latitude_deg` /
`search_longitude_deg` (the estimated site's box), `catalog_mag_limit`, `catalog_band`, `time_reference`,
`overlay_format`, `calibrator_sigma_rtn_km`, `prior_sigma_rtn` (without an error model), `prior_created_before`,
`trajectory_minutes`, `trajectory_step_seconds`, `sensor_id`, `originator`, `image_set_id`, `creation_date`,
`propagator_port_id`, `min_elevation_deg`, `max_site_candidates`.

The `$OCM` on `orbit` holds the fit in typed `ORBIT_DETERMINATION` fields (`OBS_AVAILABLE`, `OD_OBSERVATIONS_USED`,
`OD_APRIORI_DATA`, `OD_RESIDUAL_RMS` in arcsec, `WEIGHTED_RMS`); RTN sigmas follow from `COVARIANCE_DATA`. The report
holds the diagnostics: iterations, OD minus prior, the IOD, the separation from the calibrator, the later-set checks.

## initial_orbit

Gooding's angles-only method alone, with no element set and no frames: RA/Dec `$TDM` records on `angles` (`ANGLE_TYPE`
RADEC, UTC, degrees, geometric topocentric GCRF at the time tag; the site as `OBSERVER_X/Y/Z`, Earth-fixed WGS-84 m, as
data-source/satnogs-optical-source writes it) and `$EOP` on `earth_orientation` (required) -> one Cartesian `$OCM` on
`orbit`: the GCRF state (km, km/s) at the middle sight, `OD_METHOD` INITIAL_ORBIT, the middle-sight miss (arcsec) as
`OD_RESIDUAL_RMS`, no covariance; and a `report`. The three sights are the first, middle and last observation by epoch;
they must lie within one revolution (one pass): the Lambert arc is the short way. With config (`ModuleConfig`)
`revolutions` N > 0 and `branch` (0 long-period, 1 short-period), the sights are the first observation, the first pass's
last (the last before a 30 min gap) and the last observation, the Lambert arc between the first and last makes N full
revolutions, and its first velocity is shot onto the last sight under two-body + J2 (RK4, Newton): the initial orbit of
one candidate revolution count across nights. Refused by name:
`too-few-observations`, `no-initial-orbit`, `invalid-angles`.

## Video versus FITS

A video is the weakest input this module reads: H.264 at 8 bits, rescaled, with times only as burnt-in text and no
site. The reduction then has to estimate the site and the time bias from a calibrator, and the calibrator's own
ephemeris error enters every target's orbit (in the s2a run the along-track 1-sigma of the orbit is the calibrator's
1 km). Raw FITS frames remove each of those terms:

- 16-bit linear pixels at native resolution: centroids limited by photon noise and seeing (typically 0.05 to 0.2 px)
  instead of codec blocks; 1920x1284 at the same optics halves the plate scale;
- `DATE-OBS` at exposure start from a GPS/PPS-disciplined clock and `EXPTIME`: the time bias, 0.13 s 1-sigma from the
  video (about 1 km along track), drops to milliseconds;
- `SITELAT`, `SITELONG`, `SITEELEV` (or `OBSGEO-X/Y/Z`): no site estimate, so the calibrator is a check instead of
  the reference, and every object's orbit is absolute.

What a sensor operator should send: raw FITS at the native sensor format; `DATE-OBS` (exposure start) with its time
source; `EXPTIME`; the site; mount type and tracking mode; filter or band; gain and saturation level; shutter (rolling
or global, with the row time); focal length and pixel size; darks and flats; the frame cadence; every frame of the pass,
including those lost to cloud.

## Build and E2E

`npm run build` compiles `dist/isomorphic/module.wasm` (one translation unit, `build.mjs`). The E2E,
`tests/s2a-video-od.e2e.mjs`, runs s2a systems' video of ICEYE-X36 and COSMOS 2612 (2026-10-18) through
analysis/epoch-state, data-source/eop-parser, this module, analysis/od and analysis/rpo-history, and checks the
COSMOS 2612 orbit against the next Space-Track element set. Space-Track data are read from the SDN archive at run time
and never stored here; Gaia DR3 cones come from the ESA archive (credit: ESA/Gaia/DPAC) and are cached outside the
repository.

`tests/typed-od.e2e.mjs` runs the same video offline on the archive through 2026-11-03 and reads each value of the
recorded OD summary (`tests/fixtures/od-summary.json`, from `tests/record-od-summary.mjs`) from its typed `$OCM` field.
