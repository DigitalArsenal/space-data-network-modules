#ifndef CONJUNCTION_PC_HALL_INTERNAL_H
#define CONJUNCTION_PC_HALL_INTERNAL_H
#include "pc_math.h"

namespace conjunction::pc_detail {
// Hall (2021) Gaussian equinoctial uncertainty, linearized iteratively at
// the peak-overlap position. Equations independently implemented from the
// NASA CARA Analysis Tools mathematical reference (NOSA).
class HallModel {
public:
    explicit HallModel(const PcEncounter&);
    bool valid()const{return valid_;}
    bool at(double seconds,V6& relative,M6& covariance,bool& repaired)const;
private:
    PcEncounter encounter_;
    V6 mean1_{},mean2_{};
    M6 equinoctial1_{},equinoctial2_{},cross_{};
    bool valid_=false;
};
bool cartesian_to_equinoctial(const V6&,double,V6&);
bool equinoctial_state(const V6&,double,double,V6&,M6* jacobian=nullptr);
bool inverse6(const M6&,M6&);
M6 covariance_transform(const M6&,const M6&,const M6&);
} // namespace conjunction::pc_detail
#endif
