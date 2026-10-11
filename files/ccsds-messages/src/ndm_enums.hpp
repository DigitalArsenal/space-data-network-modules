/*
 * files/ccsds-messages — enumerations several messages share, by the identifier
 * the SDS schema gives their members. A message's own enumerations are declared
 * in its header.
 */

#ifndef CCSDS_MESSAGES_NDM_ENUMS_HPP
#define CCSDS_MESSAGES_NDM_ENUMS_HPP

#include "ndm_core.hpp"

namespace ndm {

/* TIME_SYSTEM: UTC, TAI, TT, GPS, ... */
NDM_ENUM(timingStandard);

}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_ENUMS_HPP
