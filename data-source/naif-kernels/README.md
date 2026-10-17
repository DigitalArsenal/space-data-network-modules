# Solar-system ephemerides and orientation (NAIF)

SDN data retrieval module for the kernels `propagator/solar-system-bodies`
reads, run on a provider node by the flow
`com.digitalarsenal.flows.naif-kernels-ingest`
(stack `deployment/solar-system-provider-node`). Each built file is added to
the node's IPFS (pinned) and announced as one `$PNM` (FILE_NAME, CID,
`/ipfs/` address, FILE_ID `naif:ssb-kernels:<file>:<sha256>`), auto-published
as `PNM.fbs`, provider `naif`, source `ssb-kernels`. It replaces
`propagator/solar-system-bodies/tools/build_kernels.py` and the dataset CID.

Sources: DE440s; mar099s, jup365, sat441, ura184_part-3, nep097, plu060;
SSD sb441-n16 (Ceres, Vesta); the DE440 lunar PA binary PCK; pck00011,
gm_de440 and the lunar frame kernel; the OSIRIS-REx Bennu and Hayabusa2 Ryugu
mission PCKs:

- `bennu_v17.tpc`: https://naif.jpl.nasa.gov/pub/naif/ORX/kernels/pck/bennu_v17.tpc
- `ryugu_v10.tpc`: https://naif.jpl.nasa.gov/pub/naif/pds/pds4/hyb2/hyb2_spice/spice_kernels/pck/ryugu_v10.tpc

The mission PCKs supply each asteroid's radii and rotation model, including
Bennu's quadratic prime-meridian term. Each is published unchanged as its own
text-kernel file through the same retrieval lane.

| Stage | Asks for (HTTP ranges) |
| --- | --- |
| `plan_kernels` | the 1 KiB DAF file record of each binary kernel |
| `advance` 1 | the first and last summary records, each with its name record |
| `advance` 2 | middle summary records, and the type-2 directory (INIT, INTLEN, RSIZE, N) of every needed segment |
| `advance` 3 | directories found in middle records, and the text kernels |
| `advance` 4 | one Chebyshev record window per needed segment (the union of its decades) |
| `build_kernels` | nothing: cuts the decade shards (`core-1950.bsp` … `moon-pa-2040.bpc`, satellite systems from 2000) |
| `announce_kernels` | nothing: one `$PNM` per file from the host adapter's IPFS add results |

- Nothing is downloaded whole (jup365.bsp is 1.1 GB): a full run reads about
  160 MB of ranges. Records are copied unchanged, with CSPICE spksub (SPK) and
  pckw02 (lunar PCK) semantics; the original 53 files matched the SpiceyPy-built
  Phase-1 shards in every segment descriptor, name and data word. The two
  mission PCKs bring the published file count to 55.
- Each range has its own URL and states its own validator (see the source
  header for why).
- The host adapter (`host-adapter/`, wasmedge only) reads the flow
  configuration and adds files through the node's `ipfs` capability.

License: NASA/JPL NAIF generic kernels, JPL SSD small-body ephemerides, and
OSIRIS-REx and Hayabusa2 mission kernels are distributed freely by NASA/JPL
NAIF and the NAIF node of the Planetary Data System. The credit names both
missions and rides in the ingest meta.

```sh
npm install && npm run build && npm test
```
