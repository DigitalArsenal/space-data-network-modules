# Space Data Network Modules

Private super-repo for DigitalArsenal Space Data Network modules. This
repository is the canonical home for SDK-compliant module implementations,
including migrated module families and Basilisk-derived module families.

## Structure

- `foundation/`, `analysis/`, `propagator/`, `shaders/`, `licensing/`,
  `delivery/`: migrated and parity-oriented SDK-compliant module families
- `basilisk/`: Basilisk-derived module plans and runtime seed modules
- `packages/<domain>`: pending legacy migration targets when a package has not
  yet been moved into a family folder
- `README.md`: migration catalog and package status board
- `AGENTS.md`: repo-level Codex entry point for module migration and build work

## Naming Convention

- Source repo: `Friends-Of-Lobsternaut/<domain>-sdn-plugin`
- Historical split target repo: `DigitalArsenal/space-data-network-plugin-<domain>`
- Package path: `packages/<domain>`

## Migration Catalog

| Package | Target Repo | Source Repo | Status | Notes |
| --- | --- | --- | --- | --- |
| `packages/acled` | `DigitalArsenal/space-data-network-plugin-acled` | `Friends-Of-Lobsternaut/acled-sdn-plugin` | Pending | Not migrated yet. |
| `packages/adsb` | `DigitalArsenal/space-data-network-plugin-adsb` | `Friends-Of-Lobsternaut/adsb-sdn-plugin` | Pending | Not migrated yet. |
| `packages/ais` | `DigitalArsenal/space-data-network-plugin-ais` | `Friends-Of-Lobsternaut/ais-sdn-plugin` | Pending | Not migrated yet. |
| `packages/ascent-reconstruct` | `DigitalArsenal/space-data-network-plugin-ascent-reconstruct` | `Friends-Of-Lobsternaut/ascent-reconstruct-sdn-plugin` | Pending | Not migrated yet. |
| `propagator/atmosphere` | `DigitalArsenal/space-data-network-plugin-atmosphere` | `Friends-Of-Lobsternaut/atmosphere-sdn-plugin` | Completed | Isomorphic: Emscripten browser + standalone WASI builds, SDK compliance, browser shim, WasmEdge smoke, native tests, flow example. |
| `packages/atmospheric-wind` | `DigitalArsenal/space-data-network-plugin-atmospheric-wind` | `Friends-Of-Lobsternaut/atmospheric-wind-sdn-plugin` | Pending | Not migrated yet. |
| `packages/autoresearch-astro` | `DigitalArsenal/space-data-network-plugin-autoresearch-astro` | `Friends-Of-Lobsternaut/autoresearch-astro-sdn-plugin` | Pending | Not migrated yet. |
| `packages/bls` | `DigitalArsenal/space-data-network-plugin-bls` | `Friends-Of-Lobsternaut/bls-sdn-plugin` | Pending | Not migrated yet. |
| `packages/bolide` | `DigitalArsenal/space-data-network-plugin-bolide` | `Friends-Of-Lobsternaut/bolide-sdn-plugin` | Pending | Not migrated yet. |
| `packages/cell-towers-worldwide` | `DigitalArsenal/space-data-network-plugin-cell-towers-worldwide` | `Friends-Of-Lobsternaut/cell-towers-worldwide-sdn-plugin` | Pending | Not migrated yet. |
| `propagator/cislunar` | `DigitalArsenal/space-data-network-plugin-cislunar` | `Friends-Of-Lobsternaut/cislunar-sdn-plugin` | Completed | Isomorphic: Emscripten browser + standalone WASI builds, SDK compliance, browser shim, WasmEdge smoke, hosted-runtime example, native CR3BP coverage. |
| `packages/comtrade` | `DigitalArsenal/space-data-network-plugin-comtrade` | `Friends-Of-Lobsternaut/comtrade-sdn-plugin` | Pending | Not migrated yet. |
| `analysis/conjunction-assessment` | `DigitalArsenal/space-data-network-plugin-conjunction-assessment` | Migrated legacy source | Completed | Isomorphic plugin: Emscripten browser + standalone WASI builds, SDK compliance, browser shim, WasmEdge smoke. |
| `packages/da-asat-predictor` | `DigitalArsenal/space-data-network-plugin-da-asat-predictor` | `Friends-Of-Lobsternaut/da-asat-predictor-sdn-plugin` | Pending | Not migrated yet. |
| `packages/dimos-bridge` | `DigitalArsenal/space-data-network-plugin-dimos-bridge` | `Friends-Of-Lobsternaut/dimos-bridge-sdn-plugin` | Pending | Not migrated yet. |
| `packages/domain-awareness-pipeline` | `DigitalArsenal/space-data-network-plugin-domain-awareness-pipeline` | `Friends-Of-Lobsternaut/domain-awareness-pipeline-sdn-plugin` | Pending | Not migrated yet. |
| `packages/drama` | `DigitalArsenal/space-data-network-plugin-drama` | `Friends-Of-Lobsternaut/drama-sdn-plugin` | Pending | Not migrated yet. |
| `packages/earthquake` | `DigitalArsenal/space-data-network-plugin-earthquake` | `Friends-Of-Lobsternaut/earthquake-sdn-plugin` | Pending | Not migrated yet. |
| `packages/ecmwf` | `DigitalArsenal/space-data-network-plugin-ecmwf` | `Friends-Of-Lobsternaut/ecmwf-sdn-plugin` | Pending | Not migrated yet. |
| `packages/eia` | `DigitalArsenal/space-data-network-plugin-eia` | `Friends-Of-Lobsternaut/eia-sdn-plugin` | Pending | Not migrated yet. |
| `packages/exclusion-zone-tle-correlator` | `DigitalArsenal/space-data-network-plugin-exclusion-zone-tle-correlator` | `Friends-Of-Lobsternaut/exclusion-zone-tle-correlator-sdn-plugin` | Pending | Not migrated yet. |
| `packages/fcc` | `DigitalArsenal/space-data-network-plugin-fcc` | `Friends-Of-Lobsternaut/fcc-sdn-plugin` | Pending | Not migrated yet. |
| `packages/firms` | `DigitalArsenal/space-data-network-plugin-firms` | `Friends-Of-Lobsternaut/firms-sdn-plugin` | Pending | Not migrated yet. |
| `packages/flipper` | `DigitalArsenal/space-data-network-plugin-flipper` | `Friends-Of-Lobsternaut/flipper-sdn-plugin` | Pending | Not migrated yet. |
| `analysis/fred` | `DigitalArsenal/space-data-network-plugin-fred` | `Friends-Of-Lobsternaut/fred-sdn-plugin` | Completed | Isomorphic: Emscripten browser + standalone WASI builds, SDK compliance, browser shim, WasmEdge smoke, native FRED tests, flow example. |
| `packages/gdelt` | `DigitalArsenal/space-data-network-plugin-gdelt` | `Friends-Of-Lobsternaut/gdelt-sdn-plugin` | Pending | Not migrated yet. |
| `packages/gencast` | `DigitalArsenal/space-data-network-plugin-gencast` | `Friends-Of-Lobsternaut/gencast-sdn-plugin` | Pending | Not migrated yet. |
| `packages/gps-jamming-detection` | `DigitalArsenal/space-data-network-plugin-gps-jamming-detection` | `Friends-Of-Lobsternaut/gps-jamming-detection-sdn-plugin` | Pending | Not migrated yet. |
| `packages/gscpi` | `DigitalArsenal/space-data-network-plugin-gscpi` | `Friends-Of-Lobsternaut/gscpi-sdn-plugin` | Pending | Not migrated yet. |
| `packages/gunter-scraper` | `DigitalArsenal/space-data-network-plugin-gunter-scraper` | `Friends-Of-Lobsternaut/gunter-scraper-sdn-plugin` | Pending | Not migrated yet. |
| `propagator/hpop` | `DigitalArsenal/space-data-network-plugin-hpop` | `Friends-Of-Lobsternaut/hpop-sdn-plugin` | Completed | Isomorphic: Emscripten browser + standalone WASI builds, SDK compliance, browser shim, WasmEdge smoke, numerical propagation with configurable force models, SDK-routed resident-state binary stream methods, and SGP4-to-HPOP aligned-binary `PropagatorState` handoff coverage. |
| `packages/iridium` | `DigitalArsenal/space-data-network-plugin-iridium` | `Friends-Of-Lobsternaut/iridium-sdn-plugin` | Pending | Not migrated yet. |
| `packages/kiwisdr` | `DigitalArsenal/space-data-network-plugin-kiwisdr` | `Friends-Of-Lobsternaut/kiwisdr-sdn-plugin` | Pending | Not migrated yet. |
| `packages/launch-predict` | `DigitalArsenal/space-data-network-plugin-launch-predict` | `Friends-Of-Lobsternaut/launch-predict-sdn-plugin` | Pending | Not migrated yet. |
| `packages/link-analysis` | `DigitalArsenal/space-data-network-plugin-link-analysis` | `Friends-Of-Lobsternaut/link-analysis-sdn-plugin` | Pending | Not migrated yet. |
| `packages/linkanalysis` | `DigitalArsenal/space-data-network-plugin-linkanalysis` | `Friends-Of-Lobsternaut/linkanalysis-sdn-plugin` | Pending | Not migrated yet. |
| `packages/lst` | `DigitalArsenal/space-data-network-plugin-lst` | `Friends-Of-Lobsternaut/lst-sdn-plugin` | Pending | Not migrated yet. |
| `analysis/maneuver` | `DigitalArsenal/space-data-network-plugin-maneuver` | `Friends-Of-Lobsternaut/maneuver-sdn-plugin` | Completed | Isomorphic: Emscripten browser + standalone WASI builds, SDK compliance, browser shim, WasmEdge smoke, hosted-runtime example. |
| `packages/mediameta` | `DigitalArsenal/space-data-network-plugin-mediameta` | `Friends-Of-Lobsternaut/mediameta-sdn-plugin` | Pending | Not migrated yet. |
| `packages/meteorite-falls` | `DigitalArsenal/space-data-network-plugin-meteorite-falls` | `Friends-Of-Lobsternaut/meteorite-falls-sdn-plugin` | Pending | Not migrated yet. |
| `packages/missile` | `DigitalArsenal/space-data-network-plugin-missile` | `Friends-Of-Lobsternaut/missile-sdn-plugin` | Pending | Not migrated yet. |
| `packages/ml-inference` | `DigitalArsenal/space-data-network-plugin-ml-inference` | `Friends-Of-Lobsternaut/ml-inference-sdn-plugin` | Pending | Not migrated yet. |
| `packages/ml-train` | `DigitalArsenal/space-data-network-plugin-ml-train` | `Friends-Of-Lobsternaut/ml-train-sdn-plugin` | Pending | Not migrated yet. |
| `packages/netrecon` | `DigitalArsenal/space-data-network-plugin-netrecon` | `Friends-Of-Lobsternaut/netrecon-sdn-plugin` | Pending | Not migrated yet. |
| `packages/nexrad` | `DigitalArsenal/space-data-network-plugin-nexrad` | `Friends-Of-Lobsternaut/nexrad-sdn-plugin` | Pending | Not migrated yet. |
| `packages/notam-archive` | `DigitalArsenal/space-data-network-plugin-notam-archive` | `Friends-Of-Lobsternaut/notam-archive-sdn-plugin` | Pending | Not migrated yet. |
| `packages/ntm-scraper` | `DigitalArsenal/space-data-network-plugin-ntm-scraper` | `Friends-Of-Lobsternaut/ntm-scraper-sdn-plugin` | Pending | Not migrated yet. |
| `packages/numerical-propagator` | `DigitalArsenal/space-data-network-plugin-numerical-propagator` | `Friends-Of-Lobsternaut/numerical-propagator-sdn-plugin` | Pending | Not migrated yet. |
| `packages/nws` | `DigitalArsenal/space-data-network-plugin-nws` | `Friends-Of-Lobsternaut/nws-sdn-plugin` | Pending | Not migrated yet. |
| `analysis/od` | `DigitalArsenal/space-data-network-plugin-od` | `Friends-Of-Lobsternaut/od-sdn-plugin` | Completed | Isomorphic: Emscripten browser + standalone WASI builds, SDK compliance, browser shim, WasmEdge smoke, command-surface OD MEME fit bridge. |
| `packages/ofac` | `DigitalArsenal/space-data-network-plugin-ofac` | `Friends-Of-Lobsternaut/ofac-sdn-plugin` | Pending | Not migrated yet. |
| `packages/opensanctions` | `DigitalArsenal/space-data-network-plugin-opensanctions` | `Friends-Of-Lobsternaut/opensanctions-sdn-plugin` | Pending | Not migrated yet. |
| `packages/patents` | `DigitalArsenal/space-data-network-plugin-patents` | `Friends-Of-Lobsternaut/patents-sdn-plugin` | Pending | Not migrated yet. |
| `packages/photogrammetry` | `DigitalArsenal/space-data-network-plugin-photogrammetry` | `Friends-Of-Lobsternaut/photogrammetry-sdn-plugin` | Pending | Not migrated yet. |
| `packages/planet-ephemeris` | `DigitalArsenal/space-data-network-plugin-planet-ephemeris` | `Friends-Of-Lobsternaut/planet-ephemeris-sdn-plugin` | Pending | Not migrated yet. |
| `packages/precipitation` | `DigitalArsenal/space-data-network-plugin-precipitation` | `Friends-Of-Lobsternaut/precipitation-sdn-plugin` | Pending | Not migrated yet. |
| `packages/radnet` | `DigitalArsenal/space-data-network-plugin-radnet` | `Friends-Of-Lobsternaut/radnet-sdn-plugin` | Pending | Not migrated yet. |
| `packages/reliefweb` | `DigitalArsenal/space-data-network-plugin-reliefweb` | `Friends-Of-Lobsternaut/reliefweb-sdn-plugin` | Pending | Not migrated yet. |
| `packages/safecast` | `DigitalArsenal/space-data-network-plugin-safecast` | `Friends-Of-Lobsternaut/safecast-sdn-plugin` | Pending | Not migrated yet. |
| `packages/satfoot` | `DigitalArsenal/space-data-network-plugin-satfoot` | `Friends-Of-Lobsternaut/satfoot-sdn-plugin` | Pending | Not migrated yet. |
| `packages/satobs` | `DigitalArsenal/space-data-network-plugin-satobs` | `Friends-Of-Lobsternaut/satobs-sdn-plugin` | Pending | Not migrated yet. |
| `packages/sda-visualization` | `DigitalArsenal/space-data-network-plugin-sda-visualization` | `Friends-Of-Lobsternaut/sda-visualization-sdn-plugin` | Pending | Not migrated yet. |
| `propagator/sgp4` | `DigitalArsenal/space-data-network-module-propagator-sgp4` | `Friends-Of-Lobsternaut/propagator-sgp4-sdn-module` | Completed | Isomorphic: Emscripten browser + standalone WASI builds, SDK compliance, browser shim, WasmEdge smoke, native SGP4 tests, flow example. |
| `packages/small-bodies` | `DigitalArsenal/space-data-network-plugin-small-bodies` | `Friends-Of-Lobsternaut/small-bodies-sdn-plugin` | Pending | Not migrated yet. |
| `packages/socmint` | `DigitalArsenal/space-data-network-plugin-socmint` | `Friends-Of-Lobsternaut/socmint-sdn-plugin` | Pending | Not migrated yet. |
| `packages/space-weather-forecast` | `DigitalArsenal/space-data-network-plugin-space-weather-forecast` | `Friends-Of-Lobsternaut/space-weather-forecast-sdn-plugin` | Pending | Not migrated yet. |
| `packages/spacecraft-geometry` | `DigitalArsenal/space-data-network-plugin-spacecraft-geometry` | `Friends-Of-Lobsternaut/spacecraft-geometry-sdn-plugin` | Pending | Not migrated yet. |
| `packages/srp-shadow` | `DigitalArsenal/space-data-network-plugin-srp-shadow` | `Friends-Of-Lobsternaut/srp-shadow-sdn-plugin` | Pending | Not migrated yet. |
| `packages/sst` | `DigitalArsenal/space-data-network-plugin-sst` | `Friends-Of-Lobsternaut/sst-sdn-plugin` | Pending | Not migrated yet. |
| `packages/starfield` | `DigitalArsenal/space-data-network-plugin-starfield` | `Friends-Of-Lobsternaut/starfield-sdn-plugin` | Pending | Not migrated yet. |
| `packages/stereo-wind` | `DigitalArsenal/space-data-network-plugin-stereo-wind` | `Friends-Of-Lobsternaut/stereo-wind-sdn-plugin` | Pending | Not migrated yet. |
| `packages/terra-imagery` | `DigitalArsenal/space-data-network-plugin-terra-imagery` | `Friends-Of-Lobsternaut/terra-imagery-sdn-plugin` | Pending | Not migrated yet. |
| `packages/tornado` | `DigitalArsenal/space-data-network-plugin-tornado` | `Friends-Of-Lobsternaut/tornado-sdn-plugin` | Pending | Not migrated yet. |
| `packages/treasury` | `DigitalArsenal/space-data-network-plugin-treasury` | `Friends-Of-Lobsternaut/treasury-sdn-plugin` | Pending | Not migrated yet. |
| `packages/undersea-cables` | `DigitalArsenal/space-data-network-plugin-undersea-cables` | `Friends-Of-Lobsternaut/undersea-cables-sdn-plugin` | Pending | Not migrated yet. |
| `packages/usaspending` | `DigitalArsenal/space-data-network-plugin-usaspending` | `Friends-Of-Lobsternaut/usaspending-sdn-plugin` | Pending | Not migrated yet. |
| `packages/webarchive` | `DigitalArsenal/space-data-network-plugin-webarchive` | `Friends-Of-Lobsternaut/webarchive-sdn-plugin` | Pending | Not migrated yet. |
| `packages/who-health` | `DigitalArsenal/space-data-network-plugin-who-health` | `Friends-Of-Lobsternaut/who-health-sdn-plugin` | Pending | Not migrated yet. |
| `packages/yfinance` | `DigitalArsenal/space-data-network-plugin-yfinance` | `Friends-Of-Lobsternaut/yfinance-sdn-plugin` | Pending | Not migrated yet. |

## Current State

- Packages are organized by family under top-level subfolders:
  - `foundation/` — `time`, `math-bspline`, `numerics`, `attitude-math`,
    `frames`, `orbits`
  - `propagator/` — `sgp4`, `hpop`, `atmosphere`, `cislunar`
  - `analysis/` — `conjunction-assessment`, `maneuver`, `od`, `fastest-path`
  - `basilisk/` — runtime seed package plus generated Basilisk module plan
  - `shaders/` — `sensor-shaders`, `viewshed-shader`
  - `licensing/` — `core`, `client-decrypt`, `protection-key-server`, `protection-license-client`
  - `delivery/` — legacy `plugin-delivery` compatibility fixture
- Completed packages publish the shared isomorphic SDK artifact at
  `dist/isomorphic/module.wasm`.
- Optional browser adapters may live under `dist/browser/`, but they are not the
  canonical module contract.
- The isomorphic artifact is the contract. It must load unchanged in the SDK
  browser harness and WasmEdge, with embedded manifest exports as the runtime
  source of truth.
- Protected module delivery must use `licensing/core`. The older
  `delivery/plugin-delivery` package is retained only for legacy
  client-decrypt compatibility tests and must not be used for new publication or
  grant issuance flows because it performs one-off bundle encryption and does
  not emit provider-signed grants.
- Remaining packages stay pending until they are migrated into matching `DigitalArsenal/space-data-network-plugin-<domain>` repos and added under the appropriate family subfolder.

## Basilisk Modules

Basilisk-derived module work lives under `basilisk/` in this repository. The
checked-in planning artifacts are:

- `docs/basilisk-module-plan.json`
- `docs/basilisk-message-standards.json`
- `docs/basilisk-unit-test-port-index.json`
- `docs/basilisk-inventory.md`
- `docs/basilisk-standards-map.md`

Orekit and Basilisk parity planning is tracked in:

- `docs/orekit-basilisk-gap-analysis.md`
- `docs/orekit-basilisk-module-todos.md`
- `docs/orekit-source-test-index.json`
- `docs/basilisk-source-test-index.json`
- `docs/current-module-parity-index.json`
- `docs/module-import-descriptors.json`
- `docs/test-vector-extraction-index.json`
- `docs/sds-schema-audit.json`

Regenerate and verify Basilisk planning with:

```bash
npm run generate:basilisk-plan
npm run check:basilisk-plan
npm run generate:basilisk-unit-test-ports
npm run check:basilisk-unit-test-ports
```

Regenerate and verify Orekit/Basilisk source-test inventory indices with:

```bash
npm run generate:source-indices
npm run check:source-indices
```

Regenerate and verify current module parity/readiness inventory with:

```bash
npm run generate:module-index
npm run check:module-index
```

Verify import descriptors, selected source-library test-vector mappings, and
the SDS schema audit with:

```bash
npm run check:module-imports
npm run check:test-vectors
npm run check:sds-schema-audit
```

The runtime seed module is `basilisk/runtime` and follows the same
`dist/isomorphic/module.wasm` SDK artifact contract as the migrated modules.

## Working With Packages

```bash
git submodule update --init --recursive
```

## Build Migrated Packages

Build every migrated package, or pass one or more package names to build a subset:

```bash
./scripts/build-migrated-packages.sh
./scripts/build-migrated-packages.sh atmosphere maneuver
```

## Run SDK Compatibility Tests

The compatibility tests install the SDK into each package and then verify:

- artifact compliance
- pure `wasi_snapshot_preview1` imports on `*_standalone.wasm`
- browser JS wrapper smoke
- SDK browser harness loading the standalone artifact
- WasmEdge command invoke smoke using the same standalone artifact

When the SDK repo lives next to this repo:

```bash
SPACE_DATA_MODULE_SDK_ROOT=../space-data-module-sdk ./scripts/test-sdk-compat.sh
```

You can also pass a subset of package names:

```bash
SPACE_DATA_MODULE_SDK_ROOT=../space-data-module-sdk ./scripts/test-sdk-compat.sh atmosphere od
```

These checks require the `wasmedge` CLI.

## Cross-Repo Signing And Encryption Regression

The SDK repo owns the real-plugin signing and encrypted-delivery regression. Run
this from `space-data-module-sdk` after building the migrated packages here:

```bash
SPACE_DATA_NETWORK_PLUGINS_ROOT=../space-data-network-modules \
node --test test/isomorphic-plugin-loading.test.js
```

That test loads the real standalone plugin artifacts, validates them, and
round-trips them through publication signing and encrypted delivery.
