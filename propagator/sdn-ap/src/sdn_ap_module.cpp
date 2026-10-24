// =============================================================================
// SDN-AP PROPAGATOR
// =============================================================================
//
// General-perturbations propagation of whole catalogs, one isomorphic WASM
// module (clang wasm32-wasip1-threads through the module SDK; no WebAssembly
// exception handling), carrying:
//   - SGP4    the public SGP4/SDP4 (STR#3, Vallado et al. 2006), type 0 sets;
//   - SGP4XP  the US Space Force SGP4-XP theory, type 4 sets, written clean
//             room (side B) from the public change list and SPEC.md;
//   - SDN-AP  SDN's own theory (labelled as its own, never "SGP4-XP").
//
// Parts (inlined in this order by build.mjs):
//   constants.inc  gravity models, theory identifiers
//   sgp4_core.inc  the SDP4 lunar-solar and resonance terms
//   model.inc      SGP4 ingest and propagation of one object; checkpoints
//   fastmath.inc   sincos from one range reduction
//   drag.inc       SGP4XP drag: flux model, J70 temperature and density table
//   sdnap_terms.inc SDN-AP: NRLMSISE-00 drag, environment (DESIGN 2)
//   density_kernel.inc SDN-AP 2a.4: the catalog-shared density kernel
//   xp_theory.inc  SGP4XP and SDN-AP: the SPEC.md semi-analytic theory, its node grid
//   store.inc      the element store, frames
//   pool.inc       the batch thread pool
//   fit.inc        fit: ephemeris to element set (Levenberg-Marquardt)
//   abi.inc        the propagator ABI and the sdnap_* batch entries
//   omm.inc        the ingest_omm invoke method ($OMM FlatBuffers)
//   oem.inc        the propagate invoke method ($OMM in, $OEM out)
//   fit_oem.inc    the fit invoke method ($OEM in, $OMM out)
//   environment.inc the load_environment invoke method ($SPW rows)
// =============================================================================

#include "space_data_module_invoke.h"
#include "orbpro/orbpro_propagator_abi.h"
#include "omm_slots.h"

#include <pthread.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "constants.inc"
#include "sgp4_core.inc"
#include "model.inc"
#include "fastmath.inc"
#include "drag.inc"
#include "sdnap_terms.inc"
#include "density_kernel.inc"
#include "xp_theory.inc"
#include "store.inc"
#include "gcrf.inc"
#include "pool.inc"
#include "fit.inc"
#include "abi.inc"
#include "lunar.inc"
#include "segment.inc"
#include "helio.inc"
#include "cislunar.inc"
#include "nrho.inc"
#include "events.inc"
#include "omm.inc"
#include "pcf.inc"
#include "environment.inc"
#include "oem.inc"
#include "osculating.inc"
#include "fit_oem.inc"
#include "events_method.inc"
#include "reentry.inc"
#include "launch.inc"
#include "launch_batch.inc"
