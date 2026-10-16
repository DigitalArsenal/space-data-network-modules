#pragma once

#include "conjunction/pc_method.h"

namespace conjunction {
// Independent principal normal coordinates: means/stddevs and radius in km.
// The narrower axis is integrated adaptively; the other is integrated exactly
// with a normal CDF. Both methods compute the same Gaussian disk integral.
PcResult gaussian_disk_integral(const BPlaneGeometry& geometry, bool remediate = true);
}
