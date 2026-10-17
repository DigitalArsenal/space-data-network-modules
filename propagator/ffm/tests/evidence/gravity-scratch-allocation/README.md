# Allocation-only release provenance

`equivalence.json` records all 72 reference cases at the suite, 30 s and finest
settings. The same request returns identical complete response bytes through
FFM 1.4.1 and the authenticated pre-allocation source built at version 1.4.1.
The equal version keeps the producer label equal; no response is normalized.
The original 1.4.0 artifact and source are authenticated from the pinned Git
commit. The fixture recipe and compiler pins are in
[`base.json`](../../gravity-scratch-alloc/base.json).

From the repository root, `node propagator/ffm/tests/evidence/gravity-scratch-allocation/verify.mjs`
reproduces the proof. `refresh-provenance.mjs` in this directory authenticates it,
requires the exact allocation-only source diff, and updates release identities
and their dependent file pins. It refuses unrelated candidate edits and
preserves every previously recorded numerical field. Each refreshed document
retains its previous commit and SHA-256 beside the proof reference.

The existing `propagator/ffm/tests/evidence/check-all.mjs` remains the E2E.
Its oracle, numerical reductions, replay tolerances and acceptance rules are
unchanged. The current Vallado check still names the pre-rename header directory;
provision `CPLUS_INCLUDE_PATH` with this checkout's
`propagator/ffm/src/cpp/include` when running it, until its owning lane repairs
that source path. This evidence change does not edit the SGP4 check.
