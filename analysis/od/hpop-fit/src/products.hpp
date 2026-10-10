// The stored products of one operator fit, as size-prefixed SDS records:
//   $OMM  the SGP4 fit (with its exact statistics in COMMENT);
//   $OCM  the full-force HPOP solution: GCRF epoch state, covariance, the
//         estimated force parameters, PERTURBATIONS, ORBIT_DETERMINATION and
//         every exact, reference and closure statistic;
//   $OBD  one per fit (SGP4, HPOP).
// And the reference OMM reader ($OMM in, elements and exact epoch out).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "operator_fit.hpp"

namespace odhpop {

struct Products {
  std::vector<uint8_t> omm;
  std::vector<uint8_t> ocm;
  std::vector<uint8_t> obd_sgp4;
  std::vector<uint8_t> obd_hpop;
};

Products build_products(const OperatorFitResult& r, const OperatorFitOptions& o, const std::string& creation_date);

// A size-prefixed or plain $OMM. false (with a reason) on anything else.
bool read_reference_omm(const uint8_t* bytes, std::size_t size, Reference* out, std::string* error);

}  // namespace odhpop
