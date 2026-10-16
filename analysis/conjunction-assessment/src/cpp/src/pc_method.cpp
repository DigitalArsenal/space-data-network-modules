#include "conjunction/pc_method.h"
#include "conjunction/pc_maximum.h"
#include <limits>
#include <cstdint>
#include <cstring>
#include <array>

namespace conjunction {

PcResult screening_foster_2d(const BPlaneGeometry& bp) {
    // Positive disk quadrature: three Gauss-Legendre nodes in s=r^2/R^2
    // and sixteen equispaced angles. It integrates every polynomial of total
    // degree <= 8 exactly (the surviving angular averages have s-degree <= 4).
    // For a Gaussian, write density(x)=density(0)*exp(L(x)+Q(x)). If |L+Q|
    // <= T, the fourth Taylor polynomial is degree 8. Positivity of the rule
    // bounds relative quadrature error by 2*exp(2T)*T^5/5!, <8e-6 at T<=0.2.
    // This is the Foster disk integral with a bounded cheaper quadrature, not
    // a constant-density small-HBR probability or a replacement tier gate.
    const double radius=bp.combined_radius;
    for(double value:{bp.xi,bp.zeta,bp.sigma_xx,bp.sigma_xz,bp.sigma_zz,radius})
        if(!std::isfinite(value))return Foster2D().compute(bp);
    if(!(radius>0))return Foster2D().compute(bp);
    double high=0,low=0;bp.eigenvalues(high,low);
    if(!std::isfinite(high)||!std::isfinite(low))return Foster2D().compute(bp);
    const double floor=(1e-4*radius)*(1e-4*radius);
    const bool remediated=high<floor||low<floor;
    high=std::max(high,floor);low=std::max(low,floor);
    if(!(low>0))return Foster2D().compute(bp);
    double mx=0,my=0;bp.rotated_miss(mx,my);
    const double sx=std::sqrt(high),sy=std::sqrt(low),rho=radius/sy;
    const double variation=radius*std::hypot(mx/high,my/low)+0.5*rho*rho;
    const bool tail_recovery=!(variation<=0.2);
    if(tail_recovery) {
        auto reference=Foster2D().compute(bp);
        if(reference.converged || !(variation<=4.0) ||
           reference.failure_reason!="Disk quadrature error exceeds relative budget")return reference;
    }
    constexpr double nodes[]={0.11270166537925831148,0.5,0.88729833462074168852};
    constexpr double weights[]={5.0/18,4.0/9,5.0/18};
    constexpr double cosine[]={1,0.92387953251128675613,0.70710678118654752440,
        0.38268343236508977173,0,-0.38268343236508977173,-0.70710678118654752440,
        -0.92387953251128675613,-1,-0.92387953251128675613,-0.70710678118654752440,
        -0.38268343236508977173,0,0.38268343236508977173,0.70710678118654752440,
        0.92387953251128675613};
    const double ux=mx/sx,uy=my/sy;
    const double logscale=2*std::log(radius)-std::log(2.0)-std::log(sx)-std::log(sy)-
        0.5*(ux*ux+uy*uy);
    PcResult result;result.method="FOSTER-2D";
    if(tail_recovery) {
        // The Reference integrator's absolute stopping floor can dominate an
        // otherwise representable far-tail probability. A positive 12x48
        // disk rule integrates every polynomial of total degree <=46 exactly:
        // 12-point Gauss-Legendre integrates s-degree <=23, and 48 angles
        // integrate every nonconstant harmonic of order <48 to zero.
        // Thus the degree-23 Taylor polynomial of exp(L+Q) is exact, and the
        // relative remainder is <=2*exp(2*T)*T^24/24! <2.71e-6 for T<=4.
        constexpr double radial_nodes[]={0.12523340851146891547,0.36783149899818019375,
            0.58731795428661744730,0.76990267419430468704,0.90411725637047485668,
            0.98156063424671925069};
        constexpr double radial_weights[]={0.24914704581340278500,0.23349253653835480876,
            0.20316742672306592175,0.16007832854334622633,0.10693932599531843096,
            0.04717533638651182719};
        static const auto tail_cosine=[] {
            std::array<double,48> values{};
            for(unsigned i=0;i<values.size();++i)
                values[i]=std::cos(6.28318530717958647693*i/values.size());
            return values;
        }();
        for(unsigned radial=0;radial<6;++radial)for(double sign:{-1.,1.}) {
            const double distance=radius*std::sqrt((1+sign*radial_nodes[radial])/2);
            for(unsigned angle=0;angle<48;++angle) {
                const double x=distance*tail_cosine[angle]/sx,y=distance*tail_cosine[(angle+36)%48]/sy;
                result.probability+=radial_weights[radial]/96*
                    std::exp(logscale+x*ux+y*uy-0.5*(x*x+y*y));
            }
        }
        result.iterations=576;
        result.usage_reason="Foster positive disk quadrature tail recovery; relative error bound=2.71e-6";
    } else {
        for(unsigned radial=0;radial<3;++radial) {
            const double distance=radius*std::sqrt(nodes[radial]);
            for(unsigned angle=0;angle<16;++angle) {
                const double x=distance*cosine[angle]/sx,y=distance*cosine[(angle+12)%16]/sy;
                // Combine logs before exponentiation to retain subnormal tails.
                result.probability+=weights[radial]/16*std::exp(logscale+x*ux+y*uy-0.5*(x*x+y*y));
            }
        }
        result.iterations=48;
    }
    result.probability=std::clamp(result.probability,0.0,1.0);
    result.mahalanobis_2d=std::hypot(ux,uy);
    result.covariance_remediated=remediated;
    result.max_probability=AlfanoMaxPc().compute(bp).probability;
    return result;
}

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
