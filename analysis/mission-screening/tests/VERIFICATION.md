# Ballistic flow evidence — 2026-10-17

The single declared E2E exercises committed WASM through typed SDS boundaries:
DE440 → Lambert PCE → mission-screening PCE, and signed SLP + OEM → native
WasmEdge Star → signed PSS. Unit suites are not part of this evidence.

| Measurement | Result |
| --- | --- |
| 2026 mesh | 51,714 solved cells; minimum departure C3 9.183497471505385 km²/s² |
| 2028 mesh | 60,970 solved cells; minimum departure C3 8.99537552596813 km²/s² |
| Star upstream E–M–E–J | 33/33 rows; maximum patch-cost residual 7.0964e-14 km/s |
| CSPICE, all 1,008 grid states | Maximum position difference 4.2147e-8 km; velocity 7.1054e-15 km/s |
| PyKEP selected C3 cells | Maximum C3 difference 5.1515e-14 km²/s² |
| Independent circular parking budgets | Maximum difference 3.6380e-12 m/s |

The grids use solar GM 1.3271244004127942e20 m³/s², Sun-centered ICRF,
TDB seconds from J2000, Earth 399, and Mars **barycenter 4**. They use
daily samples and prograde, zero-revolution Lambert transfers. Epoch windows
and 0.001 km²/s² acceptance tolerance are explicit in the E2E. Invalid-cell
status, a different selected objective, paging and cancellation are checked.

Independent evidence used CSPICE 67 / SpiceyPy 8.3.0 and PyKEP 2.6.4 in an
external Python 3.11 environment. PyKEP is an oracle only; no oracle code,
environment, scratch prototype, or generated trajectory golden is shipped.
The committed Star reference is the existing MIT upstream fixture at
`UzTak/star-search` revision `5c667064e8fc5816a94fc1124906997560fd6c55`.

[NASA/TM–2010-216764](https://ntrs.nasa.gov/api/citations/20100037210/downloads/20100037210.pdf),
Tables 2 and 3, gives minimum C3 9.144 and 8.928 km²/s². This flow differs by
+0.03949747 and +0.06737553 km²/s²; departure/arrival date offsets are (0,+1)
and (−2,−5) days. These are screening envelopes, not exact MIDAS replication.
The handbook uses a different search formulation and sampling convention.

The E2E verifies both actual PSS Ed25519 signatures with Node's independent
crypto implementation, checks stable trajectory IDs and epoch agreement within
1 microsecond, and compares Star patch costs within 1e-8 km/s. Its temporary
native host uses the SDK runner and the installed WasmEdge 0.16.4 AOT compiler
and library. It adds only typed keyslot signing/verification over pipes.
Production signer trust is an ingress responsibility, separate from numerical
agreement. No production keys or deployments are used.

Limits: one Star worker in this E2E; no new threading scalability claim,
continuous optimization, DSM, null/resonant legs, propagation refinement,
dominance-ranking proof, or browser support for server keyslots. A running
synchronous search is cancelled by terminating its dedicated host process.
