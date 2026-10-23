# Sea-state module interface — UI and FFT ocean

Module: `com.digitalarsenal.analysis.sea-state`, version 0.1.0.
Package: `@digitalarsenal/sdn-module-analysis-sea-state`.
Artifact: `analysis/sea-state/dist/isomorphic/module.wasm`.
Method: `sea_state`. One required `request` input and one `result` output,
both canonical `PCE.fbs` / `$PCE` / root `PCE`, one frame per invocation.
Manifest-embedded bytes are the runtime authority. Invoke through the SDK;
all physics runs inside WASM. JS `codec.js` only encodes/decodes FlatBuffers.

PCE values use `PROVIDER_DEFINED` parameter names, real scalar values (except
result strings `regime` and `model`), and OK status. The result carries a PCE
catalog with scalar types and unit symbols. Both ports have min/maxStreams=1.
Requests use one EVALUATION_RESULT/SAMPLES entry, matching the existing
body-appearance codec convention. No JSON is passed into WASM.

## Inputs

| Name | Units | Meaning/default |
| --- | --- | --- |
| `wind_speed_10m_mps` | m/s | Required wind speed at 10 m over water, clamped to [0,70]. Positive values below 1e-6 are refused. |
| `fetch_m` | m | Straight-line fetch along steady wind. Omitted/0 = unlimited; otherwise [1e-6,1e12]. |
| `duration_s` | s | Duration of steady wind. Omitted/0 = unlimited; otherwise [1e-6,1e12]. |
| `wind_from_deg` | degrees | Coming-from bearing, clockwise from true north; default 0. |
| `wave_height_m` | m | Optional marine significant-height override; positive values override engine height only. |
| `wave_period_s` | s | Optional marine dominant-period override; positive values override engine period only. |
| `wave_from_deg` | degrees | Optional marine coming-from bearing; defaults to wind bearing. |

Every supplied value must be a finite real scalar; unknown fields fail.
Optional nonpositive height/period values fall back to wind sea, matching the
old console policy. NaN, Infinity, strings, vectors, and JS coercions are not
part of this typed API. Errors return a nonzero SDK status and no result frame.
The caller owns weather retrieval, time stamps, location and flow composition.
There is no epoch or time scale: duration is elapsed SI seconds in a stationary
uniform wind model. Gravity is 9.80665 m/s²; frame is the local mean sea surface.

## Outputs

| Names | Units | Meaning |
| --- | --- | --- |
| `hs_m`, `tp_s`, `fp_hz`, `m0_m2` | m, s, Hz, m² | Wind-sea spectral height Hm0=4√m0, peak period/frequency, variance. These have no engine floor or upper render clamp. |
| `alpha`, `gamma`, `sigma_a`, `sigma_b` | 1 | Effective JONSWAP spectrum parameters; use returned alpha after energy saturation. |
| `hs_uncapped_m`, `alpha_uncapped`, `energy_scale` | m, 1, 1 | Raw relation and explicit PM energy cap diagnostics. |
| `wind_speed_19_5m_mps` | m/s | PM wind after SPM height conversion, based on the clamped U10. |
| `effective_fetch_m`, `dimensionless_fetch` | m, 1 | Minimum of physical fetch, duration-equivalent fetch, and PM frequency-limit fetch. Finite even when inputs are unlimited. |
| `regime` | text | `calm`, `fetch-limited`, `duration-limited`, or `fully-developed`; equal finite constraints favor fetch. |
| `model` | text | `jonswap1973-pm1964-spm-height-v1`. |
| `windSpeedMps`, `windFromDeg` | m/s, degrees | Ready for the existing engine; wind [0,70], bearing [0,360). |
| `swellHeightM`, `swellPeriodS`, `swellFromDeg` | m, s, degrees | Ready for the existing engine; marine overrides if supplied, height [0.4,30], period [2,30], bearing [0,360). |
| `chop` | 1 | Existing render policy, 0.6 + 0.6 min(1,U10/17). |

At calm the physical hs/tp/fp/m0/alpha/effective fetch are zero, gamma=1,
sigma=0.07/0.09 and energy_scale=1. fp=0 means no physical peak. Render fields
retain the old 0.4 m / 2 s floor; this is not predicted residual wave energy.
Marine overrides do not alter the wind-sea spectrum or its regime. A marine
swell spectrum or wind/swell energy partition is outside this contract.

## Method and source correction

JONSWAP: Hasselmann et al. 1973, Eqs. (2.4.1), (2.4.3–5),
x=gF/U10²; alpha_raw=0.076 x^-0.22; fp=3.5(g/U10)x^-0.33;
gamma=3.3, sigma_a=0.07, sigma_b=0.09. The spectral convention is

```
S_f(f) = alpha g² / ((2π)^4 f^5)
         × exp[-1.25 (fp/f)^4]
         × gamma^exp[-(f/fp - 1)^2 / (2 sigma²)]     [m²/Hz]
```

sigma_a applies at f<=fp, sigma_b above. The module integrates this spectrum
for variance. The FFT lane must implement any spectrum sampling in WASM, using
these parameters, with its own declared direction/spreading and phase rules.
Do not treat `swellHeightM` as the physical wind-sea normalization.

Duration is an explicit approximation: integrating dt=dF/cg with
cg=g/(4πfp) along the JONSWAP peak gives
gt/U10=(4π·3.5/0.67)x^0.67. Use the smaller supplied/equivalent fetch. This
is a derived travel-time closure, not a measured transient-growth relation.

PM: Pierson & Moskowitz 1964, doi:10.1029/JZ069i024p05181, Eq. (12),
alpha=0.0081, beta=0.74. The original wind height is 19.5 m. SPM 1984
Eq. (3-26) gives U19.5=U10(19.5/10)^(1/7), an explicit approximate profile.
The PM limit has Hm0=2√(alpha/beta)U19.5²/g and
fp=(4beta/5)^(1/4)g/(2πU19.5), gamma=1. Switch to it when the developing
fp reaches PM fp. Before that switch, cap JONSWAP energy at PM energy by
multiplying alpha and m0 by min(1,m0_PM/m0_raw). The unmodified spectrum
overshoots PM Hs by about 25.196% immediately below this switch; the exposed
scale makes the correction explicit. Height is continuous, but the spectral
shape changes at the switch. There is no invented smooth blending law.

The original console fed U10 into the U19.5 relation and rounded the height
coefficient to 0.21 and peak coefficient to 0.877. Its SPM attribution is
inaccurate: SPM Eqs. (3-36–37) instead use adjusted wind stress UA. This changes
wind-only heights/periods; the E2E reports the exact differences. Unchanged
marine overrides, directions, chop and clamps are tested for exact equality.
[Primary-source details and limitations](SOURCES.md) accompany the package.

## Example

```js
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeRequest, decodeResult} from './codec.js';

// Serve with COOP: same-origin + COEP: require-corp (wasi-sequential profile).
const wasm = new Uint8Array(await (await fetch('/modules/sea-state/module.wasm')).arrayBuffer());
const module = await createBrowserModuleHarness({wasmSource: wasm, surface: 'direct'});
try {
  const response = await module.invoke(encodeRequest('sea_state', {
    wind_speed_10m_mps: 10, wind_from_deg: 270, fetch_m: 0, duration_s: 0,
  }));
  if (response.statusCode !== 0) throw new Error(response.errorMessage);
  const state = decodeResult(response.outputs[0].payload);
  const {windSpeedMps, windFromDeg, swellHeightM, swellPeriodS, swellFromDeg, chop} = state;
  globe.oceanState = {windSpeedMps, windFromDeg, swellHeightM, swellPeriodS, swellFromDeg, chop};
  // FFT input: state.alpha/gamma/sigma_a/sigma_b/fp_hz, in the stated convention.
} finally {
  await module.destroy();
}
```

Measured example result: `hs_m=2.582278037108178`, `tp_s=8.035488465237414`,
`regime="fully-developed"`, `gamma=1`. The original TS gives 2.1414040472536495 m
and 7.305662402366851 s for the same wind: corrections +0.4408739898545284 m
and +0.7298260628705631 s before any marine override.

Keep a harness alive across weather updates in production; teardown on owner
shutdown. Native WasmEdge uses the SDK isomorphic loader against the exact
same artifact. Docker parity is waived by the owner, not executed.

UI lane follow-up: replace the original TS numerical mapping with SDK invoke,
cover removal with the console no-JS-physics gate, and measure actual console
pixel differences. This module lane keeps the UI worktree read-only; it does
not claim a pixel-diff result from matching scalar inputs.
