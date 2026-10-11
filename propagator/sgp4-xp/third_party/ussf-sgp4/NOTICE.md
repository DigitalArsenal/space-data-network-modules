# USSF SGP4 (Sgp4Prop WebAssembly, XP build)

Copyright 2015 United States Government as represented by the Administrator of US Space Force. All Rights Reserved.

This directory holds the US Space Force SGP4 propagator, unmodified, as released by
the Government Agency, and the agreement it is released under.

| File | What | SHA-256 |
| --- | --- | --- |
| `Sgp4Prop.xp.wasm` | `build/Sgp4Prop.xp.wasm` of `v9.1.1.0_C_Sgp4Prop_Wasm.zip` (Astro Standards v9.1 C library, XP release): SGP4 and SGP4-XP | `9f061110f12ac85a76ad80dc76cdb8a33ddad64e54d8dab3b6778602e16cbeb7` |
| `Sgp4Prop.xp.js` | `build/Sgp4Prop.xp.js` of the same package: the Emscripten JavaScript runtime of that wasm. The tests use it, and only it, as the reference the module is compared with; the module does not contain it | `0d9848bb0ed7ce6eadd85e22f5325e81492ef03355bab85a580eb421c7f22707` |
| `AGREEMENT.txt` | US Space Force Open Source Agreement for SGP4, as distributed with the package | `5716a47b0601ee9d6190c566367a869a4fefcd3b70ec871adac91d08e223d608` |
| `ReleaseNotes-v9.1.1.0.md` | the package's release notes | `5727a5bcececbc326444316d14dc35446711cc89c23d911156e1df835d4fe9b7` |

The package, `v9.1.1.0_C_Sgp4Prop_Wasm.zip` (SHA-256
`269230005164064b6bdd04f35b2c1aee3eaef3b899da65f16fa879e6e564e3e8`, Space-Track
documentation download 19505655, retrieved 2026-10-10), also holds a Doxygen reference
of the exported functions and an HTML example. They are not redistributed here.

## Terms observed

- **Use.** The Agreement defines "Use" as the application or employment of the Subject
  Software for any purpose (section 1.L). Its introduction states the intended purpose
  of the propagator, to propagate 18 SDS two-line element sets to agree with 18 SDS's
  positions. This module also fits element sets to ephemerides and propagates sets that
  are not 18 SDS's; the owner decided that section 1.L governs.
- **Binary redistribution (2.C.1).** The copyright notice above, the Agreement
  (`AGREEMENT.txt`, which carries the conditions and the disclaimer) travel with the
  wasm in this directory, with the module's README, and inside
  `dist/isomorphic/module.wasm` and the OD node of `flows/supplemental-omm` (`nodes/od`)
  as the custom section `ussf-sgp4-notice`.
- **No endorsement (2.C.2, 3.D).** Neither the name of the US Space Force nor the names
  of its contributors endorse or promote this module or anything derived from it. The
  module is SDN's; it was not written, reviewed or approved by the US Space Force or by
  18 SDS.
- **Larger Work (3.G).** The module combines the Subject Software with software that
  is not governed by the Agreement (the SDN module code). The Subject Software in it,
  `Sgp4Prop.xp.wasm`, is subject to the Agreement. `wasm-merge` joins it to that code by
  re-encoding its functions into the merged module (their numbering changes, their
  behaviour does not); `tests/ussf_parity.test.mjs` requires the merged module's positions
  and velocities to equal those of the library's own JavaScript runtime to the last bit.
  The README describes the join.
- **Warranty.** The software is provided "AS IS", without warranty of any kind
  (Agreement, introduction).
- **Registration (3.E).** Requested, not obligatory, at astrodynamicStandards.org (the Agreement's spelling).
- **Export (3.H).** Export of any goods or technical data from the United States may
  require an export license from the U.S. Government. Failure to obtain necessary export
  licenses may result in criminal liability under U.S. laws. The Government Agency neither
  represents that a license shall not be required nor that, if required, it shall be
  issued, and nothing in the Agreement or in this repository provides one. Whoever
  exports or redistributes this module from the United States is responsible for that
  determination.
