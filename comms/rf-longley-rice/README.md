# rf-longley-rice

> **STUB STATUS.** This module reserves the API surface for the
> NTIA-ITS Longley-Rice (Irregular Terrain Model). The C++ kernel is
> a deliberate stub — `rf_longley_rice_path_loss_db` returns `0.0` and
> `rf_longley_rice_is_stub()` returns `1`. Until the native port lands,
> hosts should branch on `isStub` and fall back to the JS-side
> `RfCommsCore.computeLongleyRicePathLoss` external WASM (already
> present at `RfCommsCore.js:2423`).

The audit plan ([RF_AUDIT_REPORT.md](../../../../../RF_AUDIT_REPORT.md))
specifies fixture-only validation for this model — a native port of the
NTIA-ITS reference C implementation (~3 kloc) is out of scope for the
modular WASM migration and will be a separate effort:

1. Vendor the NTIA-ITS Longley-Rice v1.2.2 source under
   `vendor/longley-rice/` (the NTIA public-domain release).
2. Compile alongside `rf_longley_rice_plugin.cpp` and wire the
   `point_to_point` / `area` entry points.
3. Replace the stub.

## Authority

NTIA-ITS Tech Memo 82-100 (Hufford, Longley, Kissick); NTIA-ITS
reference algorithm v1.2.2; ITU-R P.1546-6 for the related
land-mobile point-to-area model.

## Frozen API surface

```c
int32_t rf_longley_rice_is_stub(void);                     // returns 1 today

double rf_longley_rice_path_loss_db(
    double distance_km,
    double frequency_mhz,
    double tx_height_m,
    double rx_height_m,
    double terrain_irregularity_m,    // ITM "delta_h"
    int32_t climate_code,             // 1..7, default 5 (continental temperate)
    int32_t polarization_code,        // 0 = horizontal, 1 = vertical
    double surface_refractivity_n_units,
    double ground_dielectric_constant,
    double ground_conductivity_s_per_m,
    double time_percent,
    double location_percent,
    double situation_percent);
```

The signature was chosen to match the canonical NTIA-ITS
`point_to_point` entry plus the four ITM environment parameters
(climate, polarization, refractivity, ground constants) and three
reliability targets (time / location / situation), all of which the
reference code consumes as scalars.
