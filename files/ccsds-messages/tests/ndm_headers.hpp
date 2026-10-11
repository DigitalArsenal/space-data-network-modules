#define FLATBUFFERS_NAN_DEFAULTS
// The generated SDS object-API headers the NDM engine binds, in dependency order,
// included by the native harness the way build.mjs concatenates them for the module.
#include <cmath>
// macOS math.h defines these as macros; two SDS enumerations have members of the
// same names (legacyCountryCode::SING). build.mjs puts the same lines before the
// generated headers.
#undef DOMAIN
#undef SING
#undef OVERFLOW
#undef UNDERFLOW
#undef TLOSS
#undef PLOSS
#include "NCD_generated.h"
#include "RFM_generated.h"
#include "TIM_generated.h"
#include "MET_generated.h"
#include "OMM_generated.h"
#include "OEM_generated.h"
#include "OPM_generated.h"
#include "CDM_generated.h"
#include "APM_generated.h"
#include "ACM_generated.h"
#include "RDM_generated.h"
#include "OCM_generated.h"
