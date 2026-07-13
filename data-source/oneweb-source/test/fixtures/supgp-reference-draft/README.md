# OneWeb — A2.4 CelesTrak SupGP reference-pair (DRAFT / seed)

Seeds **A2.4** (OD parity gate vs CelesTrak) for OneWeb. DRAFT: the CelesTrak
SupGP capture is **missing** (CelesTrak unreachable from the build env), and the
hard-RMS gate is additionally **blocked on the LTEF decode** (see below).

## Status: two blockers

1. **CelesTrak unreachable** — direct HTTPS to `celestrak.org` fails with
   `ECONNREFUSED` from this environment (matches A2.1; A2.1 succeeded only via a
   reader proxy). Per M2M policy no retries were made.
2. **LTEF decode unresolved** — the operator-side raw data (`ltef.csv`) is a
   proprietary compact encoding with no public column spec, so no Cartesian state
   vectors can be fit yet. The hard RMS gate (OrbPro fit vs source ephemeris ≤
   CelesTrak SupGP RMS) is **impossible** until OneWeb's LTEF spec is obtained
   (OWNER-ASSIST). See `../PROVENANCE.md` and `../../README.md`.

## Exact CelesTrak query for A2.4

```
https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=OneWeb-E&FORMAT=JSON
```

- Also grab `FORMAT=KVN` (OMM KVN). Capture within the same 2-hour SupGP update
  window; respect the >2h cadence and ≤50-error / IP-block rules.
- OneWeb fleet ~520–578; expect one OMM per catalogued object.

## Interim (non-parity) check A2.4 can run before the decode lands

Until raw LTEF state vectors exist, only an element-space **sanity** check vs
CelesTrak's `OneWeb-E` OMM is possible, and it MUST be labeled **non-independent**
(not parity) per the A2.4 directive — CelesTrak's SupGP is itself derived from the
same LTEF we cannot yet decode.

## provider.json (DRAFT)

`provider.json` here is the A2.4 manifest seed (source `OneWeb-E`, gate
`beatsCelestrak`) with `inputDecode: "blocked-ltef-spec"` flagging the hard-gate
blocker and `celestrakKvn` awaiting the SupGP capture.
