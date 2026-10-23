#pragma once
// GJ8 coefficients generated from the corrected integration-study core.
// Coefficients from exact generating functions. Binary64 state and fixed
// nine-point storage replace long double, runtime rationals, and std::deque.
// The coefficient generator lives in scripts/generate-gj-coefficients.py.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include "reentry.h"
namespace ffm_fast::gj {
using Real = double;
using Row = std::array<Real, 9>;
struct Coefficients {
    Row ac = {{3250433.0 / 53222400.0, 572741.0 / 5702400.0, -8701681.0 / 39916800.0, 4026311.0 / 13305600.0, -917039.0 / 3193344.0, 7370669.0 / 39916800.0, -1025779.0 / 13305600.0, 754331.0 / 39916800.0, -330157.0 / 159667200.0}};
    Row bc = {{-19087.0 / 89600.0, 427487.0 / 725760.0, -3498217.0 / 3628800.0, 500327.0 / 403200.0, -6467.0 / 5670.0, 2616161.0 / 3628800.0, -24019.0 / 80640.0, 263077.0 / 3628800.0, -8183.0 / 1036800.0}};
    Row apc = {{103798439.0 / 159667200.0, -24115843.0 / 9979200.0, 18071351.0 / 3326400.0, -159314453.0 / 19958400.0, 25162927.0 / 3193344.0, -8660609.0 / 1663200.0, 6322573.0 / 2851200.0, -11011481.0 / 19958400.0, 3250433.0 / 53222400.0}};
    Row bpc = {{3288521.0 / 1036800.0, -40987771.0 / 3628800.0, 10219841.0 / 403200.0, -135352319.0 / 3628800.0, 167287.0 / 4536.0, -9839609.0 / 403200.0, 5393233.0 / 518400.0, -9401029.0 / 3628800.0, 25713.0 / 89600.0}};
    std::array<Row, 9> startupA = {{
        {{3250433.0 / 53222400.0, 572741.0 / 5702400.0, -8701681.0 / 39916800.0, 4026311.0 / 13305600.0, -917039.0 / 3193344.0, 7370669.0 / 39916800.0, -1025779.0 / 13305600.0, 754331.0 / 39916800.0, -330157.0 / 159667200.0}},
        {{-330157.0 / 159667200.0, 530113.0 / 6652800.0, 518887.0 / 19958400.0, -27631.0 / 623700.0, 44773.0 / 1064448.0, -531521.0 / 19958400.0, 109343.0 / 9979200.0, -1261.0 / 475200.0, 45911.0 / 159667200.0}},
        {{45911.0 / 159667200.0, -185839.0 / 39916800.0, 171137.0 / 1900800.0, 73643.0 / 39916800.0, -25775.0 / 3193344.0, 77597.0 / 13305600.0, -98911.0 / 39916800.0, 24173.0 / 39916800.0, -3499.0 / 53222400.0}},
        {{-3499.0 / 53222400.0, 4387.0 / 4989600.0, -35039.0 / 4989600.0, 90817.0 / 950400.0, -20561.0 / 3193344.0, 2117.0 / 9979200.0, 2059.0 / 6652800.0, -317.0 / 2851200.0, 317.0 / 22809600.0}},
        {{317.0 / 22809600.0, -2539.0 / 13305600.0, 55067.0 / 39916800.0, -326911.0 / 39916800.0, 14797.0 / 152064.0, -326911.0 / 39916800.0, 55067.0 / 39916800.0, -2539.0 / 13305600.0, 317.0 / 22809600.0}},
        {{317.0 / 22809600.0, -317.0 / 2851200.0, 2059.0 / 6652800.0, 2117.0 / 9979200.0, -20561.0 / 3193344.0, 90817.0 / 950400.0, -35039.0 / 4989600.0, 4387.0 / 4989600.0, -3499.0 / 53222400.0}},
        {{-3499.0 / 53222400.0, 24173.0 / 39916800.0, -98911.0 / 39916800.0, 77597.0 / 13305600.0, -25775.0 / 3193344.0, 73643.0 / 39916800.0, 171137.0 / 1900800.0, -185839.0 / 39916800.0, 45911.0 / 159667200.0}},
        {{45911.0 / 159667200.0, -1261.0 / 475200.0, 109343.0 / 9979200.0, -531521.0 / 19958400.0, 44773.0 / 1064448.0, -27631.0 / 623700.0, 518887.0 / 19958400.0, 530113.0 / 6652800.0, -330157.0 / 159667200.0}},
        {{-330157.0 / 159667200.0, 754331.0 / 39916800.0, -1025779.0 / 13305600.0, 7370669.0 / 39916800.0, -917039.0 / 3193344.0, 4026311.0 / 13305600.0, -8701681.0 / 39916800.0, 572741.0 / 5702400.0, 3250433.0 / 53222400.0}}
    }};
    std::array<Row, 9> startupB = {{
        {{19087.0 / 89600.0, -427487.0 / 725760.0, 3498217.0 / 3628800.0, -500327.0 / 403200.0, 6467.0 / 5670.0, -2616161.0 / 3628800.0, 24019.0 / 80640.0, -263077.0 / 3628800.0, 8183.0 / 1036800.0}},
        {{8183.0 / 1036800.0, 57251.0 / 403200.0, -1106377.0 / 3628800.0, 218483.0 / 725760.0, -69.0 / 280.0, 530177.0 / 3628800.0, -210359.0 / 3628800.0, 5533.0 / 403200.0, -425.0 / 290304.0}},
        {{-425.0 / 290304.0, 76453.0 / 3628800.0, 5143.0 / 57600.0, -660127.0 / 3628800.0, 661.0 / 5670.0, -4997.0 / 80640.0, 83927.0 / 3628800.0, -19109.0 / 3628800.0, 7.0 / 12800.0}},
        {{7.0 / 12800.0, -23173.0 / 3628800.0, 29579.0 / 725760.0, 2497.0 / 57600.0, -2563.0 / 22680.0, 172993.0 / 3628800.0, -6463.0 / 403200.0, 2497.0 / 725760.0, -2497.0 / 7257600.0}},
        {{-2497.0 / 7257600.0, 1469.0 / 403200.0, -68119.0 / 3628800.0, 252769.0 / 3628800.0, 0.0 / 1.0, -252769.0 / 3628800.0, 68119.0 / 3628800.0, -1469.0 / 403200.0, 2497.0 / 7257600.0}},
        {{2497.0 / 7257600.0, -2497.0 / 725760.0, 6463.0 / 403200.0, -172993.0 / 3628800.0, 2563.0 / 22680.0, -2497.0 / 57600.0, -29579.0 / 725760.0, 23173.0 / 3628800.0, -7.0 / 12800.0}},
        {{-7.0 / 12800.0, 19109.0 / 3628800.0, -83927.0 / 3628800.0, 4997.0 / 80640.0, -661.0 / 5670.0, 660127.0 / 3628800.0, -5143.0 / 57600.0, -76453.0 / 3628800.0, 425.0 / 290304.0}},
        {{425.0 / 290304.0, -5533.0 / 403200.0, 210359.0 / 3628800.0, -530177.0 / 3628800.0, 69.0 / 280.0, -218483.0 / 725760.0, 1106377.0 / 3628800.0, -57251.0 / 403200.0, -8183.0 / 1036800.0}},
        {{-8183.0 / 1036800.0, 263077.0 / 3628800.0, -24019.0 / 80640.0, 2616161.0 / 3628800.0, -6467.0 / 5670.0, 500327.0 / 403200.0, -3498217.0 / 3628800.0, 427487.0 / 725760.0, -19087.0 / 89600.0}}
    }};
};
inline constexpr Coefficients generatedCoefficients{};
inline constexpr const Coefficients& coefficients() { return generatedCoefficients; }
template<size_t D> using Vector=std::array<Real,D>;
template<size_t D> struct Point {Real x=0;Vector<D> r{},v{},a{};};
template<size_t D> class Integrator {
    Vector<D> sum1{},sum2{};
    static Real dotHistory(const Row&c,const std::array<Point<D>,9>&p,size_t d){Real s=0;for(size_t i=0;i<9;++i)s+=Real(c[i])*p[p.size()-1-i].a[d];return s;}
public:
    Real h;
    std::array<Point<D>,9> history;
    int startupIterations=0;
    bool startupConverged=false;
    explicit Integrator(Real step):h(step){if(!(h>0))astro::flagIntegrationFailure("GJ step must be positive");}
    const Point<D>& current()const{return history.back();}
    Point<D>& current(){return history.back();}
    void resetSums(){static_assert(std::tuple_size<decltype(history)>::value==9,"GJ needs nine history points");const auto& c=coefficients();for(size_t d=0;d<D;++d){sum1[d]=current().v[d]/h-dotHistory(c.bc,history,d);sum2[d]=current().r[d]/(h*h)-dotHistory(c.ac,history,d);}}
    template<class Eval> int initialize(const std::array<Point<D>,9>&seed,Eval&&eval,Real tolerance=2e-15L,int maxIterations=24){
        const auto&c=coefficients();auto p=seed;const auto anchor=seed[4];startupConverged=false;
        for(startupIterations=1;startupIterations<=maxIterations;++startupIterations){
            std::array<Vector<D>,9> s{},dd{};
            for(size_t d=0;d<D;++d){Real ca=0,cb=0;for(int i=0;i<9;++i){ca+=Real(c.startupA[4][i])*p[i].a[d];cb+=Real(c.startupB[4][i])*p[i].a[d];}s[4][d]=anchor.v[d]/h-cb;dd[4][d]=anchor.r[d]/(h*h)-ca;}
            for(int i=5;i<9;++i)for(size_t d=0;d<D;++d){s[i][d]=s[i-1][d]+(p[i-1].a[d]+p[i].a[d])/2;dd[i][d]=dd[i-1][d]+s[i-1][d]+p[i-1].a[d]/2;}
            for(int i=3;i>=0;--i)for(size_t d=0;d<D;++d){s[i][d]=s[i+1][d]-(p[i].a[d]+p[i+1].a[d])/2;dd[i][d]=dd[i+1][d]-s[i+1][d]+p[i+1].a[d]/2;}
            auto next=p;Real change=0;
            for(int i=0;i<9;++i)if(i!=4){for(size_t d=0;d<D;++d){Real ca=0,cb=0;for(int j=0;j<9;++j){ca+=Real(c.startupA[i][j])*p[j].a[d];cb+=Real(c.startupB[i][j])*p[j].a[d];}next[i].r[d]=h*h*(dd[i][d]+ca);next[i].v[d]=h*(s[i][d]+cb);change=std::max(change,std::abs(next[i].r[d]-p[i].r[d])/std::max(Real(1),std::abs(next[i].r[d])));change=std::max(change,std::abs(next[i].v[d]-p[i].v[d])/std::max(Real(1),std::abs(next[i].v[d])));}next[i].a=eval(next[i]);}
            p=next;if(change<tolerance){startupConverged=true;break;}
        }
        if(startupIterations>maxIterations)startupIterations=maxIterations;
        history=p;resetSums();return startupIterations;
    }
    Point<D> predict()const{
        const auto& c=coefficients();Point<D> p;p.x=current().x+h;
        for(size_t d=0;d<D;++d){const Real dn=sum2[d]+sum1[d]+current().a[d]/2;p.r[d]=h*h*(dn+dotHistory(c.apc,history,d));p.v[d]=h*(sum1[d]+current().a[d]/2+dotHistory(c.bpc,history,d));}return p;
    }
    template<class Eval> Point<D> step(Eval&&eval,bool pece,int correctorIters=1){
        const auto&c=coefficients();Point<D> p=predict();Vector<D> dn{};const auto old=current();
        for(size_t d=0;d<D;++d)dn[d]=sum2[d]+sum1[d]+old.a[d]/2;
        for(int it=0;it<std::max(1,correctorIters);++it){p.a=eval(p);for(size_t d=0;d<D;++d){Real ca=Real(c.ac[0])*p.a[d],cb=(Real(c.bc[0])+Real(.5))*p.a[d];for(int j=1;j<9;++j){ca+=Real(c.ac[j])*history[9-j].a[d];cb+=Real(c.bc[j])*history[9-j].a[d];}p.r[d]=h*h*(dn[d]+ca);p.v[d]=h*(sum1[d]+old.a[d]/2+cb);}}
        if(pece)p.a=eval(p);
        for(size_t d=0;d<D;++d){sum2[d]=dn[d];sum1[d]+=(old.a[d]+p.a[d])/2;}
        for(size_t i=0;i<8;++i)history[i]=history[i+1];history.back()=p;return p;
    }
    template<class Eval> void rebase(Eval&&eval){for(auto&p:history)p.a=eval(p);resetSums();}
};
} // namespace ffm_fast::gj
