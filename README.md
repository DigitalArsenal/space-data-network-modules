# Space Data Network Plugins

Private super-repo for DigitalArsenal Space Data Network plugins. Each package is added as a git submodule under `packages/` and tracks a migrated plugin repo named `space-data-network-plugin-<domain>`.

## Structure

- `packages/<domain>`: git submodule for one migrated plugin repo
- `README.md`: migration catalog and package status board

## Naming Convention

- Source repo: `Friends-Of-Lobsternaut/<domain>-sdn-plugin`
- Target repo: `DigitalArsenal/space-data-network-plugin-<domain>`
- Package path: `packages/<domain>`

## Migration Catalog

| Package | Target Repo | Source Repo | Status | Notes |
| --- | --- | --- | --- | --- |
| `packages/acled` | `DigitalArsenal/space-data-network-plugin-acled` | `Friends-Of-Lobsternaut/acled-sdn-plugin` | Pending | Not migrated yet. |
| `packages/adsb` | `DigitalArsenal/space-data-network-plugin-adsb` | `Friends-Of-Lobsternaut/adsb-sdn-plugin` | Pending | Not migrated yet. |
| `packages/ais` | `DigitalArsenal/space-data-network-plugin-ais` | `Friends-Of-Lobsternaut/ais-sdn-plugin` | Pending | Not migrated yet. |
| `packages/ascent-reconstruct` | `DigitalArsenal/space-data-network-plugin-ascent-reconstruct` | `Friends-Of-Lobsternaut/ascent-reconstruct-sdn-plugin` | Pending | Not migrated yet. |
| `packages/atmosphere` | `DigitalArsenal/space-data-network-plugin-atmosphere` | `Friends-Of-Lobsternaut/atmosphere-sdn-plugin` | Completed | SDK compliance, browser shim, WasmEdge smoke, native atmosphere tests, and flow example committed. |
| `packages/atmospheric-wind` | `DigitalArsenal/space-data-network-plugin-atmospheric-wind` | `Friends-Of-Lobsternaut/atmospheric-wind-sdn-plugin` | Pending | Not migrated yet. |
| `packages/autoresearch-astro` | `DigitalArsenal/space-data-network-plugin-autoresearch-astro` | `Friends-Of-Lobsternaut/autoresearch-astro-sdn-plugin` | Pending | Not migrated yet. |
| `packages/bls` | `DigitalArsenal/space-data-network-plugin-bls` | `Friends-Of-Lobsternaut/bls-sdn-plugin` | Pending | Not migrated yet. |
| `packages/bolide` | `DigitalArsenal/space-data-network-plugin-bolide` | `Friends-Of-Lobsternaut/bolide-sdn-plugin` | Pending | Not migrated yet. |
| `packages/cell-towers-worldwide` | `DigitalArsenal/space-data-network-plugin-cell-towers-worldwide` | `Friends-Of-Lobsternaut/cell-towers-worldwide-sdn-plugin` | Pending | Not migrated yet. |
| `packages/cislunar` | `DigitalArsenal/space-data-network-plugin-cislunar` | `Friends-Of-Lobsternaut/cislunar-sdn-plugin` | Completed | SDK compliance, browser shim, WasmEdge smoke, sdn-flow example, and native CR3BP coverage committed. |
| `packages/comtrade` | `DigitalArsenal/space-data-network-plugin-comtrade` | `Friends-Of-Lobsternaut/comtrade-sdn-plugin` | Pending | Not migrated yet. |
| `packages/conjunction-assessment` | `DigitalArsenal/space-data-network-plugin-conjunction-assessment` | `Friends-Of-Lobsternaut/conjunction-assessment-sdn-plugin` | Pending | Not migrated yet. |
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
| `packages/fred` | `DigitalArsenal/space-data-network-plugin-fred` | `Friends-Of-Lobsternaut/fred-sdn-plugin` | Completed | SDK compliance, browser shim, WasmEdge smoke, native FRED tests, and flow example committed. |
| `packages/gdelt` | `DigitalArsenal/space-data-network-plugin-gdelt` | `Friends-Of-Lobsternaut/gdelt-sdn-plugin` | Pending | Not migrated yet. |
| `packages/gencast` | `DigitalArsenal/space-data-network-plugin-gencast` | `Friends-Of-Lobsternaut/gencast-sdn-plugin` | Pending | Not migrated yet. |
| `packages/gps-jamming-detection` | `DigitalArsenal/space-data-network-plugin-gps-jamming-detection` | `Friends-Of-Lobsternaut/gps-jamming-detection-sdn-plugin` | Pending | Not migrated yet. |
| `packages/gscpi` | `DigitalArsenal/space-data-network-plugin-gscpi` | `Friends-Of-Lobsternaut/gscpi-sdn-plugin` | Pending | Not migrated yet. |
| `packages/gunter-scraper` | `DigitalArsenal/space-data-network-plugin-gunter-scraper` | `Friends-Of-Lobsternaut/gunter-scraper-sdn-plugin` | Pending | Not migrated yet. |
| `packages/hpop` | `DigitalArsenal/space-data-network-plugin-hpop` | `Friends-Of-Lobsternaut/hpop-sdn-plugin` | Pending | Not migrated yet. |
| `packages/iridium` | `DigitalArsenal/space-data-network-plugin-iridium` | `Friends-Of-Lobsternaut/iridium-sdn-plugin` | Pending | Not migrated yet. |
| `packages/kiwisdr` | `DigitalArsenal/space-data-network-plugin-kiwisdr` | `Friends-Of-Lobsternaut/kiwisdr-sdn-plugin` | Pending | Not migrated yet. |
| `packages/launch-predict` | `DigitalArsenal/space-data-network-plugin-launch-predict` | `Friends-Of-Lobsternaut/launch-predict-sdn-plugin` | Pending | Not migrated yet. |
| `packages/link-analysis` | `DigitalArsenal/space-data-network-plugin-link-analysis` | `Friends-Of-Lobsternaut/link-analysis-sdn-plugin` | Pending | Not migrated yet. |
| `packages/linkanalysis` | `DigitalArsenal/space-data-network-plugin-linkanalysis` | `Friends-Of-Lobsternaut/linkanalysis-sdn-plugin` | Pending | Not migrated yet. |
| `packages/lst` | `DigitalArsenal/space-data-network-plugin-lst` | `Friends-Of-Lobsternaut/lst-sdn-plugin` | Pending | Not migrated yet. |
| `packages/maneuver` | `DigitalArsenal/space-data-network-plugin-maneuver` | `Friends-Of-Lobsternaut/maneuver-sdn-plugin` | Completed | SDK compliance, browser shim, WasmEdge smoke, sdn-flow example committed. |
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
| `packages/od` | `DigitalArsenal/space-data-network-plugin-od` | `Friends-Of-Lobsternaut/od-sdn-plugin` | Completed | SDK compliance, browser shim, WasmEdge smoke, and command-surface OD MEME fit bridge committed. |
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
| `packages/sgp4-propagator` | `DigitalArsenal/space-data-network-plugin-sgp4-propagator` | `Friends-Of-Lobsternaut/sgp4-propagator-sdn-plugin` | Completed | SDK compliance, browser shim, WasmEdge smoke, native SGP4 tests, and flow example committed. |
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

- `packages/maneuver`, `packages/cislunar`, `packages/od`, `packages/sgp4-propagator`, `packages/atmosphere`, and `packages/fred` are migrated and tracked as submodules in this repo.
- `maneuver`, `cislunar`, `od`, `sgp4-propagator`, `atmosphere`, and `fred` each pass the SDK compliance harness, the browser shim smoke, and the WasmEdge command smoke in their target repos.
- Remaining packages stay pending until they are migrated into matching `DigitalArsenal/space-data-network-plugin-<domain>` repos and added under `packages/`.

## Working With Packages

```bash
git submodule update --init --recursive
```
