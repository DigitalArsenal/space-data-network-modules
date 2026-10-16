#include "pc_hall.h"

namespace conjunction::pc_detail {
namespace {
M3 product(const M3& a,const M3& b) {
    M3 c{};for(int i=0;i<3;++i)for(int j=0;j<3;++j)for(int k=0;k<3;++k)c[i*3+j]+=a[i*3+k]*b[k*3+j];return c;
}
bool retrograde(const V6& x) {
    auto r=position(x),v=velocity(x);V3 h={r[1]*v[2]-r[2]*v[1],r[2]*v[0]-r[0]*v[2],r[0]*v[1]-r[1]*v[0]};
    return 1+h[2]/norm(h)<1e-6;
}
void reorient(PcEncounter& e) {
    if(!retrograde(e.primary)&&!retrograde(e.secondary))return;
    const int permutation[6]={1,2,0,4,5,3};
    for(auto* x:{&e.primary,&e.secondary}){V6 old=*x;for(int i=0;i<6;++i)(*x)[i]=old[permutation[i]];}
    for(auto* c:{&e.covariance_primary,&e.covariance_secondary,&e.cross_covariance}){
        M6 old=*c;for(int i=0;i<6;++i)for(int j=0;j<6;++j)(*c)[i*6+j]=old[permutation[i]*6+permutation[j]];
    }
}
V6 offset_state(const V6& center,const M6& jacobian,const V6& mean,const V6& expansion) {
    V6 d{},x=center;for(int i=0;i<6;++i)d[i]=mean[i]-expansion[i];d[5]=std::asin(std::sin(d[5]));
    for(int i=0;i<6;++i)for(int j=0;j<6;++j)x[i]+=jacobian[i*6+j]*d[j];return x;
}
double energy(const V6& x,double mu) {return dot(velocity(x),velocity(x))/2-mu/norm(position(x));}
V6 conditional_state(const V3& r,const V6& offset,const M3& beta) {
    V6 x=offset;V3 v=mul(beta,sub(r,position(offset)));
    for(int i=0;i<3;++i){x[i]=r[i];x[i+3]+=v[i];}return x;
}
V6 adjusted_state(const V3& target,const V6& previous,const V6& offset,const M3& beta,double mu) {
    V6 next=conditional_state(target,offset,beta);double original=energy(previous,mu);
    if(original>=0)return next;
    if(std::abs(energy(next,mu)/original-1)<=0.1)return next;
    double lo=0,hi=1;V3 old=position(previous),r{};
    for(int i=0;i<40;++i){double fraction=(lo+hi)/2;for(int j=0;j<3;++j)r[j]=old[j]+fraction*(target[j]-old[j]);
        if(std::abs(energy(conditional_state(r,offset,beta),mu)/original-1)>0.1)hi=fraction;else lo=fraction;}
    for(int j=0;j<3;++j)r[j]=old[j]+lo*(target[j]-old[j]);return conditional_state(r,offset,beta);
}
}
HallModel::HallModel(const PcEncounter& e):encounter_(e) {
    reorient(encounter_);double mu=e.gravitational_parameter;
    M6 j1{},j2{},k1{},k2{};V6 x{};
    if(!cartesian_to_equinoctial(encounter_.primary,mu,mean1_)||!cartesian_to_equinoctial(encounter_.secondary,mu,mean2_)||
       !equinoctial_state(mean1_,0,mu,x,&j1)||!equinoctial_state(mean2_,0,mu,x,&j2)||!inverse6(j1,k1)||!inverse6(j2,k2))return;
    equinoctial1_=covariance_transform(k1,encounter_.covariance_primary,k1);
    equinoctial2_=covariance_transform(k2,encounter_.covariance_secondary,k2);
    if(e.apply_cross_correlation)cross_=covariance_transform(k1,encounter_.cross_covariance,k2);
    valid_=true;
}
bool HallModel::at(double t,V6& relative,M6& covariance,bool& repaired)const {
    if(!valid_)return false;
    V6 expansion1=mean1_,expansion2=mean2_,center1{},center2{},offset1{},offset2{};
    M6 j1{},j2{},p1{},p2{};V3 old_peak{},older_peak{};
    double radius=encounter_.combined_radius,mu=encounter_.gravitational_parameter;
    bool converged=false;
    for(int iter=0;iter<100;++iter) {
        if(!equinoctial_state(expansion1,t,mu,center1,&j1)||!equinoctial_state(expansion2,t,mu,center2,&j2))return false;
        offset1=offset_state(center1,j1,mean1_,expansion1);offset2=offset_state(center2,j2,mean2_,expansion2);
        p1=covariance_transform(j1,equinoctial1_,j1);p2=covariance_transform(j2,equinoctial2_,j2);
        M3 inverse1{},inverse2{},sum_inverse{},overlap{},regularized_inverse{};double determinant=0;
        if(!inverse_position(block(p1),radius,inverse1,determinant,repaired)||!inverse_position(block(p2),radius,inverse2,determinant,repaired))return false;
        for(int i=0;i<9;++i)sum_inverse[i]=inverse1[i]+inverse2[i];
        if(!inverse_position(sum_inverse,radius,overlap,determinant,repaired))return false;
        V3 weighted1=mul(inverse1,position(offset1)),weighted2=mul(inverse2,position(offset2));
        for(int i=0;i<3;++i)weighted1[i]+=weighted2[i];V3 peak=mul(overlap,weighted1);
        if(iter>35)for(int i=0;i<3;++i)peak[i]=(peak[i]+old_peak[i])/2;
        M3 regularized=overlap;for(int i=0;i<3;++i)regularized[i*3+i]+=radius*radius;
        if(!inverse_position(regularized,radius,regularized_inverse,determinant,repaired))return false;
        if(iter>0) {
            V3 delta=sub(peak,old_peak),oscillation=sub(peak,older_peak);
            double tolerance=iter>35?1e-6:1e-12;
            if(dot(delta,mul(regularized_inverse,delta))<=tolerance||
               (iter>15&&dot(oscillation,mul(regularized_inverse,oscillation))<=1e-12)){converged=true;break;}
        }
        M3 beta1=product(block(p1,3,0),inverse1),beta2=product(block(p2,3,0),inverse2);
        V6 next1=adjusted_state(peak,center1,offset1,beta1,mu),next2=adjusted_state(peak,center2,offset2,beta2,mu);
        if(!cartesian_to_equinoctial(next1,mu,expansion1)||!cartesian_to_equinoctial(next2,mu,expansion2))return false;
        expansion1[5]-=expansion1[0]*t;expansion2[5]-=expansion2[0]*t;
        older_peak=old_peak;old_peak=peak;
    }
    if(!converged)return false;
    for(int i=0;i<6;++i)relative[i]=offset2[i]-offset1[i];
    for(int i=0;i<36;++i)covariance[i]=p1[i]+p2[i];
    if(encounter_.apply_cross_correlation){M6 cross=covariance_transform(j1,cross_,j2);
        for(int i=0;i<6;++i)for(int j=0;j<6;++j)covariance[i*6+j]-=cross[i*6+j]+cross[j*6+i];}
    return true;
}
} // namespace conjunction::pc_detail
