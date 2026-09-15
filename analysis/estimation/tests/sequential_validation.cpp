// Independent numerical validation. Full sources, units, frames, epochs and
// tolerance rationales are in fixtures/README.md. No module-generated goldens.
#include "estimation.hpp"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <random>
#include <sstream>
using namespace sdn::estimation;
namespace {
const char* fixture_path=nullptr;
Matrix6 diagonal(double p, double v) {
  Matrix6 a{}; for(int i=0;i<6;++i)a[7*i]=i<3?p:v; return a;
}
Matrix6 product(const Matrix6& a,const Matrix6& b) {
  Matrix6 c{};for(int i=0;i<6;++i)for(int j=0;j<6;++j)for(int k=0;k<6;++k)c[6*i+j]+=a[6*i+k]*b[6*k+j];return c;
}
Matrix6 transpose(const Matrix6& a) {
  Matrix6 b{};for(int i=0;i<6;++i)for(int j=0;j<6;++j)b[6*i+j]=a[6*j+i];return b;
}
Observation position(double t) {
  Observation o{};o.epoch_seconds=t;o.kind=MeasurementKind::POSITION_VECTOR;
  o.value_count=3;o.apply_light_time=false;o.apply_sagnac=false;return o;
}
PropagatorSample cv(double t) {
  PropagatorSample s{};s.state.epoch_seconds=t;s.stm=identity6();
  for(int i=0;i<3;++i)s.stm[6*i+i+3]=t;return s;
}
double correlated() {
  // Gaussian conditioning: S=[[5,3],[3,13]], det(S)=56; independent z lane.
  FilterConfig c{};c.initial_covariance=diagonal(1,1);c.sigma_edit_threshold=10;
  c.initial_covariance[0]=4;c.initial_covariance[7]=9;c.initial_covariance[14]=16;
  c.initial_covariance[1]=c.initial_covariance[6]=3;
  Observation o=position(0);o.value={2,-1,3,0};o.sigma={1,2,3,1};
  const auto f=sequential_filter(c,{o},{cv(0)},false);assert(f.valid);
  const auto& e=f.epochs[0];
  Vector6 x{83.0/56,-3.0/14,48.0/25,0,0,0};
  Matrix6 p=diagonal(1,1);p[0]=43.0/56;p[7]=18.0/7;p[14]=144.0/25;p[1]=p[6]=3.0/14;
  double error=std::abs(e.normalized_innovation_squared-2229.0/1400);
  for(int i=0;i<6;++i)error=std::max(error,std::abs(e.filtered.value[i]-x[i]));
  for(int i=0;i<36;++i)error=std::max(error,std::abs(e.filtered_covariance[i]-p[i]));
  assert(error<2e-14);
  BatchConfig batch_config{};batch_config.a_priori=c.initial;batch_config.a_priori_covariance=c.initial_covariance;
  batch_config.sigma_edit_threshold=10;batch_config.state_convergence_tolerance=1e-12;
  const auto batch=batch_weighted_least_squares(batch_config,{o},{cv(0)});assert(batch.converged);
  double be=0,bpe=0;
  for(int i=0;i<6;++i)be=std::max(be,std::abs(batch.estimate.value[i]-x[i]));
  for(int i=0;i<36;++i)bpe=std::max(bpe,std::abs(batch.covariance[i]-p[i]));
  const double expected_rms=std::sqrt(((29.0/56)*(29.0/56)+(11.0/14)*(11.0/14)+(27.0/25)*(27.0/25))/3);
  const double rms_error=std::abs(batch.residual_rms-expected_rms)/expected_rms;
  const double sigma_rss=std::sqrt(p[0]+p[7]+p[14]);
  const double sigma_error=std::abs(std::sqrt(batch.covariance[0]+batch.covariance[7]+batch.covariance[14])-sigma_rss)/sigma_rss;
  assert(be<2e-14 && bpe<2e-14 && rms_error<2e-14);
  for(const auto& covariance:batch.iteration_covariances)assert(covariance_is_symmetric_positive_definite(covariance));
  std::cout<<"BATCH_AUTHORITY {\"position_error_m\":"<<be<<",\"covariance_max_error\":"<<bpe<<",\"sigma_rss_m\":"<<sigma_rss<<",\"sigma_rss_relative_error\":"<<sigma_error<<",\"rms\":"<<batch.residual_rms<<",\"rms_relative_error\":"<<rms_error<<",\"iterations\":"<<batch.iterations.size()<<"}\n";
  // Rejection on the last component must roll back the first two updates.
  o.value[2]=1000;
  auto edited=sequential_filter(c,{o},{cv(0)},false);assert(edited.valid);
  assert(!edited.epochs[0].accepted && edited.rejected_indices==std::vector<std::size_t>{0});
  assert(edited.epochs[0].filtered.value==c.initial.value);
  assert(edited.epochs[0].filtered_covariance==c.initial_covariance);
  std::cout<<"PASS correlated Gaussian state/covariance/NIS max_error="<<error<<" tolerance=2e-14\n";
  return error;
}
void invalid_inputs() {
  FilterConfig c{};c.initial_covariance=diagonal(1,1);
  std::vector<Observation> o{position(1),position(2)};
  std::vector<PropagatorSample> s{cv(1),cv(2)};
  int count=0;
  auto check=[&](FilterConfig a,std::vector<Observation> b,std::vector<PropagatorSample> d) {
    assert(!sequential_filter(a,b,d,false).valid);++count;
  };
  auto b=o;b[1].epoch_seconds=.5;check(c,b,s);
  auto d=s;d[1].state.epoch_seconds=3;check(c,o,d);
  b=o;b[0].sigma[0]=0;check(c,b,s);
  b=o;b[0].sigma[0]=-1;check(c,b,s);
  b=o;b[0].value[0]=std::numeric_limits<double>::infinity();check(c,b,s);
  b=o;b[0].value_count=4;check(c,b,s);
  b=o;b[0].kind=static_cast<MeasurementKind>(500);check(c,b,s);
  d=s;d[0].stm[0]=std::numeric_limits<double>::quiet_NaN();check(c,o,d);
  d=s;d[0].stm.fill(0);check(c,o,d);
  auto a=c;a.initial_covariance[0]=-1;check(a,o,s);
  a=c;a.initial_covariance[1]=1;check(a,o,s);
  a=c;a.acceleration_psd[0]=-1;check(a,o,s);
  a=c;a.sigma_edit_threshold=0;check(a,o,s);
  a=c;a.estimator=static_cast<EstimatorKind>(99);check(a,o,s);
  a=c;a.process_noise=static_cast<ProcessNoiseKind>(99);check(a,o,s);
  a=c;a.process_noise=ProcessNoiseKind::DYNAMIC_MODEL_COMPENSATION;a.dmc_correlation_time_seconds=0;check(a,o,s);
  std::cout<<"PASS malformed sequential requests cases="<<count<<"\n";
}
void published_smoother(const char* filename) {
  std::ifstream input(filename);assert(input);
  struct Row{double t,z,x,v,pxx,pxv,pvv;};std::vector<Row> rows;
  std::string line;while(std::getline(input,line)) {
    if(line.empty() || line[0]=='#')continue;
    std::istringstream stream(line);Row r{};std::string z;
    stream>>r.t>>z>>r.x>>r.v>>r.pxx>>r.pxv>>r.pvv;
    assert(stream);r.z=std::stod(z);rows.push_back(r);
  }
  assert(rows.size()==51);
  FilterConfig c{};c.initial.value[3]=-.5;c.initial_covariance=diagonal(.01,.25);
  c.process_noise=ProcessNoiseKind::STATE_NOISE_COMPENSATION;c.acceleration_psd={.1,0,0};
  c.sigma_edit_threshold=1e9;
  std::vector<Observation> observations;std::vector<PropagatorSample> samples;
  // The public history begins at the first measurement; no initial-state row.
  for(std::size_t i=1;i<rows.size();++i) {
    Observation o=position(rows[i].t);o.value[0]=rows[i].z;o.sigma[0]=std::sqrt(.001);
    auto s=cv(o.epoch_seconds);s.state.value[0]=-.5*o.epoch_seconds;s.state.value[3]=-.5;
    observations.push_back(o);samples.push_back(s);
  }
  for(auto kind:{EstimatorKind::EXTENDED_KALMAN_FILTER_WITH_RTS,EstimatorKind::UNSCENTED_KALMAN_FILTER}) {
    c.estimator=kind;auto f=sequential_filter(c,observations,samples,true);assert(f.valid);
    double xe=0,pe=0;
    for(std::size_t i=0;i<f.epochs.size();++i) {
      const auto& e=f.epochs[i];const auto& r=rows[i+1];
      xe=std::max({xe,std::abs(e.smoothed.value[0]-r.x),std::abs(e.smoothed.value[3]-r.v)});
      pe=std::max({pe,std::abs(e.smoothed_covariance[0]-r.pxx),std::abs(e.smoothed_covariance[3]-r.pxv),std::abs(e.smoothed_covariance[21]-r.pvv)});
      for(int j=0;j<6;++j)assert(e.smoothed_covariance[7*j]<=e.filtered_covariance[7*j]+1e-13);
    }
    assert(xe<1e-12 && pe<1e-12);
    std::cout<<"PASS Hipparchus 4.0.3 CV smoother kind="<<static_cast<int>(kind)<<" epochs=50 state_max_error="<<xe<<" covariance_max_error="<<pe<<" tolerance=1e-12\n";
  }
}
// Battin/MIT lecture 26: exact circular CW transition, converted from rotating
// radial/along-track/cross-track to inertial Cartesian coordinates at BOTH ends.
constexpr double radius=7000000,mu=3.986004418e14;
Matrix6 rotating_to_inertial(double t) {
  const double n=std::sqrt(mu/(radius*radius*radius)),a=n*t+.2,ci=std::cos(.6),si=std::sin(.6);
  const double c=std::cos(a),s=std::sin(a);
  const double r[3][3]={{c,-s,0},{s*ci,c*ci,-si},{s*si,c*si,ci}};
  Matrix6 m{};for(int i=0;i<3;++i)for(int j=0;j<3;++j){m[6*i+j]=r[i][j];m[6*(i+3)+j+3]=r[i][j];}
  for(int i=0;i<3;++i){m[6*(i+3)]=n*r[i][1];m[6*(i+3)+1]=-n*r[i][0];}return m;
}
PropagatorSample orbit(double t) {
  const double n=std::sqrt(mu/(radius*radius*radius)),a=n*t,c=std::cos(a),s=std::sin(a);
  Matrix6 cw{};cw[0]=4-3*c;cw[3]=s/n;cw[4]=2*(1-c)/n;
  cw[6]=6*(s-a);cw[7]=1;cw[9]=-2*(1-c)/n;cw[10]=(4*s-3*a)/n;
  cw[14]=c;cw[17]=s/n;cw[18]=3*n*s;cw[21]=c;cw[22]=2*s;
  cw[24]=-6*n*(1-c);cw[27]=-2*s;cw[28]=4*c-3;cw[32]=-n*s;cw[35]=c;
  Matrix6 inv0{};assert(invert6(rotating_to_inertial(0),&inv0));
  auto transform=rotating_to_inertial(t);PropagatorSample sample{};
  sample.state.epoch_seconds=t;sample.stm=product(product(transform,cw),inv0);
  for(int i=0;i<3;++i){sample.state.value[i]=radius*transform[6*i];sample.state.value[i+3]=radius*transform[6*(i+3)];}
  return sample;
}
double nees(const CartesianState& a,const CartesianState& b,const Matrix6& p) {
  Matrix6 inv{};assert(invert6(p,&inv));double v=0;
  for(int i=0;i<6;++i)for(int j=0;j<6;++j)v+=(a.value[i]-b.value[i])*inv[6*i+j]*(a.value[j]-b.value[j]);return v;
}
void asynchronous_fusion() {
  std::vector<PropagatorSample> samples;std::vector<Observation> templates;int dimensions=0;
  double t=0;
  for(int k=0;k<40;++k) {
    t+=k%4==2?0:(k%4==0?7:13);auto sample=orbit(t);samples.push_back(sample);
    Observation o{};o.epoch_seconds=t;o.apply_light_time=false;o.apply_sagnac=false;
    o.station_position_m={6378137,0,0};o.station_east={0,1,0};o.station_north={0,0,1};o.station_up={1,0,0};
    if(k%3==0) {o.kind=MeasurementKind::RANGE;o.sigma[0]=10;}
    if(k%3==1) {o.kind=MeasurementKind::AZIMUTH_ELEVATION;o.value_count=2;o.sigma={1e-5,1e-5,1,1};}
    if(k%3==2) {o.kind=MeasurementKind::CROSSLINK_RANGE;o.sigma[0]=3;auto remote=orbit(t+120);
      o.remote_position_m={remote.state.value[0],remote.state.value[1],remote.state.value[2]};
      o.remote_velocity_mps={remote.state.value[3],remote.state.value[4],remote.state.value[5]};
      o.station_position_m=o.remote_position_m;o.station_velocity_mps=o.remote_velocity_mps;}
    // Independent truth geometry, not predict_measurement/simulate_measurements.
    const auto r=sample.state.value;
    const double x=r[0]-o.station_position_m.x,y=r[1],z=r[2];
    if(k%3==0)o.value[0]=std::sqrt(x*x+y*y+z*z);
    if(k%3==1){o.value[0]=std::atan2(y,z);if(o.value[0]<0)o.value[0]+=2*std::acos(-1.0);o.value[1]=std::atan2(x,std::hypot(y,z));}
    if(k%3==2){double dx=r[0]-o.remote_position_m.x,dy=r[1]-o.remote_position_m.y,dz=r[2]-o.remote_position_m.z;o.value[0]=std::sqrt(dx*dx+dy*dy+dz*dz);}
    dimensions+=o.value_count;templates.push_back(o);
  }
  Matrix6 l=diagonal(100,.1);l[6]=60;l[12]=-20;l[19]=.03;
  FilterConfig c{};c.initial_covariance=product(l,transpose(l));c.sigma_edit_threshold=1e9;
  if(fixture_path) {
    std::ofstream out(fixture_path);assert(out);out<<std::setprecision(17);
    auto array=[&](const auto& values){out<<"[";bool first=true;for(auto v:values){if(!first)out<<",";first=false;out<<v;}out<<"]";};
    auto vec=[&](Vec3 v){array(std::array<double,3>{v.x,v.y,v.z});};
    auto initial=orbit(0).state;Vector6 delta{120,-80,60,.12,-.08,.05};
    for(int i=0;i<6;++i)initial.value[i]+=delta[i];
    out<<"{\"initial\":";array(initial.value);out<<",\"covariance\":";array(c.initial_covariance);
    out<<",\"truth_final\":";array(samples.back().state.value);out<<",\"samples\":[";
    for(std::size_t k=0;k<samples.size();++k){if(k)out<<",";auto s=samples[k];
      for(int i=0;i<6;++i)for(int j=0;j<6;++j)s.state.value[i]+=s.stm[6*i+j]*delta[j];
      out<<"{\"t\":"<<s.state.epoch_seconds<<",\"state\":";array(s.state.value);out<<",\"stm\":";array(s.stm);out<<"}";
    }
    out<<"],\"observations\":[";
    for(std::size_t k=0;k<templates.size();++k){if(k)out<<",";const auto& o=templates[k];
      out<<"{\"t\":"<<o.epoch_seconds<<",\"kind\":"<<static_cast<int>(o.kind)<<",\"value_count\":"<<static_cast<int>(o.value_count)<<",\"value\":";array(o.value);
      out<<",\"sigma\":";array(o.sigma);out<<",\"station_position_m\":";vec(o.station_position_m);out<<",\"station_velocity_mps\":";vec(o.station_velocity_mps);out<<"}";
    }
    out<<"]}\n";
  }
  std::mt19937_64 rng(0x15e57);std::normal_distribution<double> gaussian;
  constexpr int runs=500;double sum_nees=0,sum_nis=0,filtered_squared=0,smoothed_squared=0;
  for(int run=0;run<runs;++run) {
    auto observations=templates;c.initial=orbit(0).state;
    Vector6 z{};for(double& v:z)v=gaussian(rng);
    for(int i=0;i<6;++i)for(int j=0;j<6;++j)c.initial.value[i]+=l[6*i+j]*z[j];
    // Port nominal must begin at the same supplied initial state. Independent
    // variational reference tracks that nominal perturbation on the exact orbit.
    auto nominal=samples;
    for(auto& s:nominal)for(int i=0;i<6;++i)for(int j=0;j<6;++j)s.state.value[i]+=s.stm[6*i+j]*(c.initial.value[j]-orbit(0).state.value[j]);
    for(auto& o:observations)for(int j=0;j<o.value_count;++j)o.value[j]+=o.sigma[j]*gaussian(rng);
    auto f=sequential_filter(c,observations,nominal,true);assert(f.valid);
    sum_nees+=nees(f.epochs.back().filtered,samples.back().state,f.epochs.back().filtered_covariance);
    for(std::size_t i=0;i<f.epochs.size();++i){const auto& e=f.epochs[i];sum_nis+=e.normalized_innovation_squared;
      for(int j=0;j<3;++j){double a=e.filtered.value[j]-samples[i].state.value[j],b=e.smoothed.value[j]-samples[i].state.value[j];filtered_squared+=a*a;smoothed_squared+=b*b;}
      for(int j=0;j<6;++j)assert(e.smoothed_covariance[7*j]<=e.filtered_covariance[7*j]+1e-7);
    }
  }
  double anees=sum_nees/runs,nis=sum_nis/(runs*dimensions);
  // Conservative outward rounding of scipy.stats.chi2.ppf([.005,.995], dof).
  assert(anees>5.60846959 && anees<6.40655574);assert(nis>.97776439 && nis<1.02251913);
  assert(smoothed_squared<=filtered_squared);
  std::cout<<"PASS asynchronous circular-orbit fusion runs="<<runs<<" observations="<<samples.size()<<" dimensions="<<dimensions<<" ANEES="<<anees<<" NIS_per_dof="<<nis
    <<" filter_position_RMSE_m="<<std::sqrt(filtered_squared/(runs*samples.size()))<<" smoother_position_RMSE_m="<<std::sqrt(smoothed_squared/(runs*samples.size()))<<"\n";
}
}
int main(int argc,char** argv) {
  assert(argc==2 || argc==3);if(argc==3)fixture_path=argv[2];std::cout<<std::setprecision(17);
  correlated();invalid_inputs();published_smoother(argv[1]);asynchronous_fusion();
  std::cout<<"PASS sequential validation failures=0\n";
}
