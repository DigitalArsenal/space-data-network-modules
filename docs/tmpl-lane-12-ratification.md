# TMPL lane 12: PRW extension and CQR ratification

This branch is the SDS 1.220.0 candidate. The coordinator owns integration and
publication. No tag, release, registry publication, downstream dependency update,
or stack pin update is part of this lane.

## Source and compatibility

- Baseline: `f95c2cf8b1b1357e7e4a1fc4617682bcecc992af` (fresh `origin/main`,
  package 1.219.0).
- Source: modules lane 11, `docs/tmpl-lane-11-proposal.md`, sections 5.1–5.4,
  6.1 and 10. The two fenced IDLs are the declaration baseline for this change.
- Collision sweep: all 248 baseline `schema/*/main.fbs` files, CQR directory,
  `$CQR` identifier, and all 63 new declarations (37 PRW, 26 CQR), including
  case-insensitive declaration matches: no collisions.
- PRW retains its root type, identifier, every existing field's position,
  type/default/attributes, and every existing enum declaration/member. All 16
  new root fields follow its three legacy slots. New tables are additive.
- The sole declaration change from the proposal is
  `cqrDataOrigin.FLATSQL_SELECTION` → `QUERY_SELECTION`, keeping value 5. The
  capability class is independent of a particular query engine. No existing
  standard was renamed to make room for this family.
- New descriptions use capability language and the spelling “catalog”. Added
  comments make the semantics below part of the distributed IDL. Other draft
  field names, types, defaults and enum values are retained.

Optional scalars from the draft became value + HAS_<FIELD> bool pairs (the SDS convention; the JSON Schema generator rejects FlatBuffers optional scalars). Repeat the old/new declaration proof with:

```sh
node scripts/checkPrwAppendOnly.mjs f95c2cf8b1b1357e7e4a1fc4617682bcecc992af
```

The proof compares declaration attributes and complete normalized field/member
prefixes, including explicit defaults and enum assignments. Retaining enum
prefixes and their underlying type/bit flags also retains implicit wire values.

## Resolved semantic decisions

### Envelope and wire formats

PRW's first three arena-oriented arms remain wire-compatible. Migrated portable
methods use the appended arms; CQR owns conjunction queries/results rather than
a new invoke ABI. Exactly one payload arm must agree with `PIV.METHOD_ID`.
Errors are PIV errors, not successful empty scientific results.

The proposal's canonical-only-port exemption is not adopted. Port manifests
retain FLATBUFFER and ALIGNED_BINARY peers with the same logical schema name,
identifier, root, version and hash. An aligned peer needs an actual portable
layout, alignment metadata and codec. Pointer-aligned FlatBuffer bytes do not
define a second codec. GCT's header/section-directory twin demonstrates that a
variable-length record can have a declared aligned layout. PRW/CQR IDL defines
the canonical representation; this lane does not claim downstream dual-format
codec implementation or runtime conformance. See `schema/TAB/main.fbs`,
`schema/PLG/main.fbs` and `schema/GCT/main.fbs`.

### State, time and legacy mappings

Portable PRW states are Cartesian SI position/velocity, with matching FRM and
RFM coordinate-system names and explicit time scale, axes and origin. Earth
ICRF-axis states require an Earth origin; a bare ECI/ECEF label is insufficient.
UTC/TDB conversion uses the required time/Earth-orientation data and refuses
missing or out-of-coverage data rather than relabeling epochs. Existing
OMM/OEM/OCM/PPE units remain unchanged. Precedents: FRM, RFM and TIM.

Matrices use 6D position/velocity or 7D position/velocity/mass and exactly N²
row-major values. Covariance conversions are `D P Dᵀ`; STM conversions are
`D_out Phi D_in⁻¹`, with `D = diag(1000,1000,1000,1000,1000,1000,1)` for
kilometres to metres and unchanged kilograms. Duplicate 6D initial covariance
sources fail. Independent 6D/7D covariance may coexist; an explicit resident
initial mass takes precedence over the force-configuration fallback. Requested
STMs are cumulative from the initial epoch. Absent drag/SRP area-over-mass
coefficients remain absent, never inferred from ignored legacy scalars.

Burn conditions reuse PCE. Legacy radius, speed, radial velocity, node and mass
map to `POSITION_MAGNITUDE`, `VELOCITY_MAGNITUDE`, `RADIAL_VELOCITY`,
`POSITION_Z` and `TOTAL_MASS`, respectively, in the request's state/frame/time
context. Direction -1/0/+1 maps to decreasing/any/increasing crossings. PRW's
explicit RTN and VNC formulas govern steering: legacy LVLH→RTN is an adapter
mapping, not a claim that all RFM LVLH/VNC axis conventions are interchangeable.
Throttle and steering clocks do not restart at output samples. Optional burn
times preserve absence separately from a real zero-time event.

Existing degree-12 trajectory segments map to PPE with 13 coefficients, unhalved
`c0`, midpoint epoch, half-span in seconds, and explicit velocity coefficients.
Coverage is independent of fit quality. Unmeasured legacy zero residuals never
become measured zero-error claims. Native SPK input is wholly inside the typed
record, with matching NCD format, byte length and SHA-256; no trailer is needed.

### Provider profiles and conjunction results

The host chooses a provider; schema enum availability is not a claim that every
provider implements every algorithm or model. Unknown profiles and unsupported
controls fail explicitly. Empty profile selects a documented provider default.
The initial numerical adapter's scalar tolerance must be expanded with SI unit
scaling; unequal/unrepresentable tolerance vectors need a provider enhancement.
Existing finite-burn limits and unsupported combinations remain validated by
the consumer. No module physics or codec implementation is certified here.

CQR supports pair/catalog/index/window queries, encounter-plane probability and
typed CDM KVN/XML. Pair radii must sum to the shared screening radius. Sampled
indexes consume OEM samples; polynomial indexes consume PPE segments. All
instance handles validate identity/generation and are not process addresses.

Encounter-plane displacement and covariance share an orthonormal xi/zeta basis
normal to relative velocity. Mahalanobis fields mean squared distances. Maximum
probability is explicitly discriminated: with `MAXIMUM_PROBABILITY_ONLY`, the
maximum field applies and the scalar `PROBABILITY` default is ignored. Existing
CSM writer units are preserved; explicit SI/TIM event summaries remove ambiguity
without changing CSM. Chunks sort by TCA, identities, then original input-pair
order, and use PIV backpressure.

## Registration and version precedent

Inspected `f95c2cf8b1` (ACW/RFM, 1.219.0) and `b76da41467` (GCT, 1.217.0).
Schema-directory discovery generates bindings, archives, JSON schemas, manifest,
embeddings, explorer and website registration. The root-table description is
the public description source. The README conjunction category also names CQR.

REC appends CQR at 248 after GCT at 247. The CLM guard already accepts
`frozen_through >= 246`, so it needs no edit. `generateVersion.py` supplies hash
and version headers and advances the package to 1.220.0 with build metadata;
`generatePackageJSON.py` mirrors that version to `lib/js/package.json`. These
are the only package version manifests bumped by the 1.219.0 precedent.

## Verification

Final build, proof, test, integrity and binding-count results are recorded below
after generation. Build command: `npm run build:mac` (the repository's Python 3
macOS recipe). Generated artifacts belong to this same candidate commit.
