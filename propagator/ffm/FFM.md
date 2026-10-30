# FFM (Full Force Model)

## What FFM means

FFM means the full force model, never a reduced model. FFM-1 specifies the catalog execution request, its applied defaults and its supported alternatives; an alternative is active only when selected.

## Profile FFM-1

| term | value | reference standard |
| --- | --- | --- |
| profile | FFM-1 | Code contract (profile sources) |
| module | com.orbpro.ffm | Code contract (profile sources) |
| moduleVersion | 2.0.4 | Code contract (profile sources) |
| gravity | field: EGM2008; degree: 70; order: 70; gm_m3_s2: 398600441500000; tideSystem: tide-free; frame: ITRF (Earth-fixed), IERS EOP; pointMass: true; legacyZonalFlags: (j2: false; j3: false; j4: false; higherZonals: false); degreeSpecified: true; orderSpecified: true; maximumTesseralDegree: 0; maximumTesseralDegreeSpecified: false; centralBodyNaifId: 399; centralBody: Earth | EGM2008 (Pavlis et al. 2012); IERS Conventions 2010 ch. 6 |
| thirdBodies | enabled: true; bodies: naifId: 10; name: Sun, naifId: 301; name: Moon, naifId: 2; name: Venus barycenter, naifId: 4; name: Mars barycenter, naifId: 5; name: Jupiter barycenter; ephemeris: JPL DE440 (SPK); ephemerisSource: JPL_SPK; ephemerisKind: UNSPECIFIED; ephemerisBinding: DE440 is supplied by the full-force fixtures; the request selects JPL_SPK and does not enforce a DE release.; fieldMaximumDegree: 0; fieldMaximumOrder: 0; fieldNote: THIRD_BODY_MAXIMUM_DEGREE and _ORDER: 0 keeps every third body a point mass; two and up adds the harmonics of the Moon's GRGM660PRIM (to degree 150), listed as a third body, about the Earth. | Park et al. 2021, DE440 |
| srp | enabled: true; model: cannonball; shadow: conical (umbra, penumbra, antumbra; Montenbruck &amp; Gill); shadowModel: UNSPECIFIED; crAreaOverMass_m2_kg: 0.02; initialMass_kg: 1; area_m2: 1; gnss: Supported with ENABLE_SRP=true, RADIATION_PRESSURE_MODEL=GNSS_BOX_WING and GNSS_BLOCK=GPS_IIR, GPS_IIR_M or GPS_IIF; an ECOM2 record enables its 11 coefficients independently. FFM-1 selects cannonball for every object, with no GNSS block or ECOM2 record.; gnssBlock: UNSPECIFIED; ecom2: null | Montenbruck &amp; Gill 2000 §3.4 |
| drag | enabled: true; model: NRLMSISE-00; alternatives: JB2008 (SET indices), Jacchia-Roberts, Harris-Priester, USSA1976, Exponential; spaceWeather: Daily F10.7/F10.7a/Ap, 3-h Kp (CSSI layout, read as Orekit's CssiSpaceWeatherData): previous-day observed F10.7, current-day centered 81-day observed F10.7 average and daily Ap, current 3-hour Kp.; weather: null; winds: HWM14 when DragForceConfig.includeWinds is enabled; false by default and not selectable in PCFForceModel.; densityCorrection: NONE; densityCorrectionRelaxationHours: 0; densityCorrectionRelaxationSpecified: false; neutralWind: NONE; weatherSource: UNSPECIFIED; weatherExtension: UNSPECIFIED; cdAreaOverMass_m2_kg: 0.01; bstarRule: The C++ export plugin_drag_area_over_mass_from_bstar returns 2 * B* / 0.15696615 for finite positive B* (1/Earth radii), in m²/kg; zero, negative or nonfinite B* uses cdAreaOverMass_m2_kg.; areaOverMassRate_m2_kg_s: 0; areaOverMassRateSpecified: false | Picone et al. 2002; Bowman et al. 2008; Spacetrack Report No. 3 §§8–9 |
| solidTides | model: IERS 2010 (Step 1 + frequency-dependent Step 2, Sun and Moon); selection: IERS_2010 | IERS Conventions 2010 §6.2 |
| oceanTides | model: FES2004; degree: 30; order: 30; oceanPoleTide: false | Lyard et al. 2006; IERS 2010 §6.3 |
| relativity | terms: Schwarzschild, Lense-Thirring, de Sitter; selection: IERS_2010 | IERS Conventions 2010 §10.3 |
| earthRadiation | model: Knocke; resolutionDeg: 15; areaOverMass_m2_kg: 0; areaOverMassSpecified: false; coefficient: Shares the cannonball SRP crAreaOverMass_m2_kg when the explicit Earth-radiation coefficient is absent. | Knocke, Ries &amp; Tapley 1988 |
| frames | inertial: GCRF; earthFixed: ITRF; chain: IAU 2006/2000A CIO-based with EOP dX/dY, polar motion, ERA (ERFA); eop: IERS finals (PRW.EARTH_ORIENTATION rows) | IERS Conventions 2010 ch. 5 |
| time | input: UTC; integration: TT; ephemeris: TDB (TT + periodic terms); leapSeconds: Built-in IERS Bulletin C table through 2017-01-01 for PRW UTC/TT and drag; ERFA table for EOP conversion. | IERS 2010 ch. 10; SOFA/ERFA; IERS Bulletin C |
| integrator | catalog: (algorithm: RK78; relativeTolerance: 1e-14; absoluteTolerance_m: 1e-11; absoluteToleranceComponents: 6; absoluteToleranceUnits: m for position; m/s for velocity; initialStep_s: 30; minStep_s: 0.01; maxStep_s: 120; maxSteps: 1000000; residentPolicy: Automatic GJ8 PEC for low-eccentricity forward arcs; Sundman RK78 for eccentric arcs; RK startup, backward propagation and physical reentry handoff.); fit: (scope: OD test bridge defaults; analysis/estimation accepts a caller-provided propagator and does not select an integrator itself.; algorithm: RK78; relativeTolerance: 1e-13; absoluteTolerance_m: 1e-10; absoluteToleranceComponents: 6; absoluteToleranceUnits: m for position; m/s for velocity; initialStep_s: 30; minStep_s: 0.001; maxStep_s: 300; maxSteps: 1000000; forceScope: The OD test bridge FULL_FORCE preset is not FFM-1: it selects only Sun/Moon third bodies and omits ocean tides and Earth radiation.) | Code contract (profile sources) |
| stm | technique: ANALYTIC; densityTreatment: FINITE_DIFFERENCE; include: false | Code contract (profile sources) |
| reentry | Every state, STM and finite-burn propagation path stops at the first evaluated state below 100 km geodetic altitude with the named reentry flag (propagator/ffm/lib/reentry.h:11,31,83-85); height is measured about the GCRF pole rather than the ITRF pole (line 20). | Code contract (profile sources) |
| poleTide | enabled: false; selection: ForceModelSet.usePoleTide remains false; PCFForceModel has no pole-tide selector. The separate CreateHighFidelityForceModel helper enables it. | Code contract (profile sources) |
| inTrackAcceleration | value_m_s2: 0; specified: false | Code contract (profile sources) |

## How to cite

Cite “FFM-1” and the `FFM-1 sha256=<hex>` printed by the check. The SHA-256 covers UTF-8 JSON with recursively sorted object keys, preserved array order and no whitespace, including sources.

## Conforming implementations

FFM-1 is the force model: the force, frame and time rows above. The sole implementation is `propagator/ffm`, module `com.orbpro.ffm` version 2.0.4. Forward resident propagation automatically selects GJ8 PEC or eccentric-orbit Sundman RK78; RK also supplies startup, backward propagation and physical reentry handoff. The integrator rows encode its PRW configuration. Numerical reports cite this policy together with the profile. Test-only reference artifacts are never product modes.

## Where it is enforced

Run `node tests/ffm-profile-check.mjs`. It compares decoded PRW defaults and module identity with [the profile](ffm-1.profile.json), checks C++ defaults, and verifies this table. The end-to-end gate is `node scripts/e2e-ffm.mjs`.

## Versioning

Any force, frame or time change requires a new profile id; an implementation's integrator change is its own version, not a new profile. The implementation version replaces its predecessor.
