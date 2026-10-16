#include "conjunction/pc_method.h"
#include "conjunction/pc_maximum.h"
#include <limits>
#include <cstdint>
#include <cstring>

namespace conjunction {

std::unique_ptr<PcMethod> create_pc_method(const std::string& name) {
    if (name == "alfano" || name == "ALFANO-MAXPROB" || name == "ALFANO-SPHERICAL-SMALL-HBR-MAX") return std::make_unique<AlfanoMaxPc>();
    if (name == "foster" || name == "FOSTER-2D") return std::make_unique<Foster2D>();
    if (name == "patera" || name == "PATERA-2001") return std::make_unique<Patera2001>(512);
    if (name == "chan" || name == "CHAN-1997" || name == "CHAN-2008") {
        return std::make_unique<Chan1997>();
    }
    if (name == "alfriend1999" || name == "alfriend-1999" ||
        name == "ALFRIEND-1999" || name == "ALFRIEND_1999") {
        return std::make_unique<Alfriend1999>();
    }
    if (name == "alfriend1999max" || name == "alfriend-1999-max" ||
        name == "ALFRIEND-1999-MAX" || name == "ALFRIEND_1999_MAX") {
        return std::make_unique<Alfriend1999Max>();
    }
    if (name == "alfano2005" || name == "alfano-2005" ||
        name == "ALFANO-2005" || name == "ALFANO_2005") {
        return std::make_unique<Alfano2005>();
    }
    if (name == "laas2015" || name == "laas-2015" ||
        name == "LAAS-2015" || name == "LAAS_2015") {
        return std::make_unique<Laas2015>();
    }
    if (name == "alfriend" || name == "ALFRIEND-2D") return std::make_unique<Alfriend2D>();
    if (name == "PC2D-SMALL-HBR-APPROX") return std::make_unique<SmallHbrApprox>();
    if (name == "PC2D-SHAPE-SCALED-MAX") return std::make_unique<ShapeScaledMaxPc>();
    if (name == "FRISBEE-SINGLE-COV-MAX") return std::make_unique<FrisbeeMaxPc>();
    if (name == "FRISBEE-SINGLE-COV-EQUAL-AREA-SQUARE")
        return std::make_unique<FrisbeeMaxPc>(FrisbeeRegion::EqualAreaSquare);
    if (name == "FRISBEE-SINGLE-COV-CIRCUMSCRIBED-SQUARE")
        return std::make_unique<FrisbeeMaxPc>(FrisbeeRegion::CircumscribedSquare);
    // Default: true adaptive Foster disk integral
    return std::make_unique<Foster2D>();
}

} // namespace conjunction
