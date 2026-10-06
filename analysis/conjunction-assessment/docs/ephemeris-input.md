# Ephemeris input

`parse_ephemeris` parses OEM **KVN**, Modified ITC (SpaceX MEME), JSpOC,
UTC and NASA text in C++. Autodetection checks, in order: `CCSDS_OEM_VERS`,
`CCSDS_OCM_VERS`, the `time` / `pos.x` / `vel.x` field headers, the JSpOC
report header, an initial NASA `yyDOYhhmmss.sss` state, then Modified ITC.
OCM text returns `unsupported-format` (handled by S2); XML is unsupported.
Two-digit years use 57–99 → 1957–1999, 00–56 → 2000–2056.

Ports (ordinary SDS FlatBuffers inside SDK PIV/TAB frames):

- Required `ephemeris`: `$CQR.NATIVE_DOCUMENT.CONTENT` UTF-8 bytes, with
  `SERIALIZATION=UNSPECIFIED`; maximum 16 MiB.
- Required `reference_epoch`: `$TIM.INSTANT`, explicit UTC. This is the
  caller's “now”; the guest never reads a wall clock.
- Optional `object`: `$CAT.OBJECT_ID` / `OBJECT_NAME` override file identity.
- Optional `format`: `$CQR.NATIVE_DOCUMENT.CONTENT` containing `AUTO`, `OEM`,
  `MODIFIED_ITC` (also `ITC`, `MEME`, `Modified ITC`), `JSPOC`, `UTC` or `NASA`.
- Outputs `oem`: one `$OEM` (SDS 1.231.0), preserving state/covariance frames
  and units (km, km/s, covariance km² / km²/s / km²/s²); `validation`:
  `$CQR.NATIVE_DOCUMENT.CONTENT` text `valid; format=…; states=…; future_states=…`.
  Failures return status 400 with the SDK error code/message and no outputs.

Validation requires six states strictly after the reference epoch, a span
of at least 42 seconds and less than 21 days, increasing finite UTC states,
positions outside/on the WGS-84 ellipsoid, speed ≤70 km/s, and EME2000 or
ITRF state axes. Modified ITC covariance is UVW or EME2000; OEM covariance
is RTN/RSW, ITRF or EME2000. If any covariance is present, every state needs
one PSD matrix. Covariance epochs match states 1:1; extra epochs are ignored.
If any OEM covariance block declares `COV_REF_FRAME`, all blocks must do so.
RTN/RSW/UVW aliases retain their label and use the canonical RSW axes.

Rule errors: `insufficient-future-states`, `span-too-short`, `span-too-long`,
`below-earth-surface`, `speed-limit`, `unsupported-frame`,
`unsupported-time-system`, `missing-covariance`, `covariance-not-psd`,
`covariance-frame-required`, `unsupported-covariance-frame`,
`duplicate-covariance`, `non-increasing-epochs`, `invalid-state`,
`invalid-epoch`, `invalid-covariance`, `invalid-native-document`,
`reference-epoch-required`, `unsupported-format`. Upload errors name the
rule and input line or epoch; malformed envelopes use the existing SDK errors.

For ITRF `$OEM` screening, supply `earth_orientation` with `$EOP` records
on the pair/catalog or index-preparation method. The guest converts sample
states and Earth-fixed covariance to GCRF/ICRF or EME2000 **before Hermite
interpolation**, using ERFA IAU 2006/2000A CIO rotation, UTC→TAI→TT,
UTC→UT1, polar motion and optional dX/dY. The 6×6 covariance Jacobian includes
Earth-rotation velocity coupling. Text/compact-grid epoch rounding remainders
are retained for ERFA two-part dates, including leap-day UTC quasi-JD; the
existing screening/interpolation clock remains binary64 nominal UTC JD.
Literal leap-second timestamps (`:60`) retain the existing CA `invalid-epoch`
restriction; ordinary UTC timestamps on leap days are converted correctly.
Missing EOP returns `eop-required`;
there is no UT1=UTC screening fallback. ITRF resident indexes normalize to GCRF.

EOP must explicitly encode UT1−UTC (seconds) and x/y polar motion (radians);
force default scalar fields when encoding explicit zeros. `_HP` fields win
when present, including explicit zero. dX/dY (radians) and LOD correction
(seconds) are optional. One row supplies a constant solution over the upload;
a table uses strictly increasing UTC MJD, matching dataset provenance, and
must bracket all samples/covariances (`eop-coverage` otherwise). Interpolation
uses UT1−TAI across leap seconds; incompatible/invalid EOP gives `invalid-eop`.
Surface validation of inertial uploads uses the IAU pole and WGS-84 axes;
Earth-fixed uploads are checked directly in their declared ITRF realization.

Offline synthetic fixtures and their independent native ERFA producer live in
`tests/fixtures/ephemeris-upload` and `scripts/generate-ephemeris-fixtures.*`.
Run `node --test tests/ephemerisUpload.test.mjs` for browser/SDK and WasmEdge
E2E, including ≤1 mm frame/state agreement and covariance/Pc parity.

