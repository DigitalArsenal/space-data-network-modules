#ifndef CONJUNCTION_PC_SPHERE_QUADRATURE_H
#define CONJUNCTION_PC_SPHERE_QUADRATURE_H
#include "pc_math.h"
#include <vector>
namespace conjunction::pc_detail {
struct SurfacePoint {V3 normal;double weight;};
// Weights integrate solid angle in steradians (sum 4*pi), not its average.
std::vector<SurfacePoint> product_sphere(unsigned order,const V3& velocity);
std::vector<SurfacePoint> lebedev_sphere(unsigned point_count,const V3& velocity);
}
#endif
