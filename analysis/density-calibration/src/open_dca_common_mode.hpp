#pragma once
// E13 PLAN R1/R2, selection.json, and common-mode.mjs at OAE 3e0ff003.
// The single-fleet random-walk solve, re-expressed in C++ for the WASM module.
// Units: UTC milliseconds and dimensionless ln(B). The level is unidentifiable;
// the mean over supported nodes is zero, exactly as in E13. The caller hands the
// solve only arcs whose states were public at the issue time.
#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace open_dca {
constexpr double hour=3600000.0, day=86400000.0;
struct Arc { std::string id; double start=0,end=0,y=0; };
struct Weight { int node; double w; };
struct Result {
  std::vector<double> times,s,residuals;
  std::vector<bool> supported;
  double sigma=0,change=0,anchor=0;
  int iterations=0,arcs=0,fleet=0;
  bool converged=false;
};
inline double median(std::vector<double> v) {
  std::sort(v.begin(),v.end());
  const size_t m=v.size()/2;
  return v.size()%2?v[m]:(v[m-1]+v[m])/2;
}
inline double hat(double x,double h) {
  if(x<=-h)return 0;
  if(x<=0)return (x+h)*(x+h)/(2*h);
  if(x<=h)return h-(h-x)*(h-x)/(2*h);
  return h;
}
struct Tridiagonal {
  std::vector<double> e,cp,dp;
  bool factor(std::vector<double> d,std::vector<double> off) {
    e=std::move(off);dp=std::move(d);cp.assign(dp.size(),0);
    if(!(dp[0]>0))return false;
    for(size_t j=1;j<dp.size();++j){cp[j-1]=e[j-1]/dp[j-1];dp[j]-=e[j-1]*cp[j-1];if(!(dp[j]>0))return false;}
    return true;
  }
  std::vector<double> solve(const std::vector<double>& b) const {
    std::vector<double> x(b.size());x[0]=b[0]/dp[0];
    for(size_t j=1;j<x.size();++j)x[j]=(b[j]-e[j-1]*x[j-1])/dp[j];
    for(int j=int(x.size())-2;j>=0;--j)x[j]-=cp[j]*x[j+1];
    return x;
  }
};
inline bool cholesky(std::vector<double> a,const std::vector<double>& b,std::vector<double>& x,int n) {
  std::vector<double> l(n*n,0),y(n);
  for(int i=0;i<n;++i)for(int j=0;j<=i;++j){
    double v=a[i*n+j];for(int k=0;k<j;++k)v-=l[i*n+k]*l[j*n+k];
    if(i==j){if(!(v>0)||!std::isfinite(v))return false;l[i*n+i]=std::sqrt(v);}
    else l[i*n+j]=v/l[j*n+j];
  }
  x.assign(n,0);
  for(int i=0;i<n;++i){double v=b[i];for(int k=0;k<i;++k)v-=l[i*n+k]*y[k];y[i]=v/l[i*n+i];}
  for(int i=n-1;i>=0;--i){double v=y[i];for(int k=i+1;k<n;++k)v-=l[k*n+i]*x[k];x[i]=v/l[i*n+i];}
  return true;
}
inline bool solve(const std::vector<Arc>& input,double issue,Result& out,std::string& error) {
  constexpr double step=day,stepSigma=0.005,smoothSigma=0.05,huber=1.5,tolerance=1e-5;
  constexpr int maxIterations=60,scaleSweeps=8,minDoves=6;
  std::vector<Arc> arcs;
  for(const auto& a:input){
    if(a.id.empty()||!std::isfinite(a.start)||!std::isfinite(a.end)||!std::isfinite(a.y)||!(a.end>a.start)){
      error="invalid fleet arc";return false;
    }
    if(a.end>issue){error="an arc ends after the issue time";return false;}
    if(a.start>=issue-30*day)arcs.push_back(a);
  }
  if(arcs.empty()||arcs.size()>4096){error="no arcs in the history window, or arc budget exceeded";return false;}
  double csum=0,ssum=0,lo=arcs[0].start,hi=arcs[0].end;
  for(const auto& a:arcs){double phase=std::fmod((a.start+a.end)/2,day)/day*2*3.14159265358979323846;csum+=std::cos(phase);ssum+=std::sin(phase);lo=std::min(lo,a.start);hi=std::max(hi,a.end);}
  // SDS timestamps are int64 milliseconds. Round the E13 circular-mean anchor
  // once; the offline oracle receives this same quantized anchor.
  const double offset=std::fmod(std::atan2(ssum,csum)/(2*3.14159265358979323846)+1,1)*day;
  const double anchor=std::round(std::floor(issue/day)*day+offset);
  const int nMin=int(std::floor((lo-anchor)/step)),nMax=int(std::ceil((hi-anchor)/step)),n=nMax-nMin+1;
  if(n<2||n>40){error="invalid nowcast node span";return false;}
  struct Row { Arc arc; size_t index; std::vector<Weight> weights; };
  std::vector<std::vector<Row>> doves;
  std::map<std::string,size_t> indexById;
  std::vector<std::set<std::string>> support(n);
  std::vector<double> info(n,0);
  for(size_t j=0;j<arcs.size();++j){
    const auto& a=arcs[j];auto at=indexById.find(a.id);
    if(at==indexById.end()){at=indexById.emplace(a.id,doves.size()).first;doves.emplace_back();}
    Row row{a,j,{}};
    const int first=std::max(nMin,int(std::floor((a.start-anchor)/step))),last=std::min(nMax,int(std::ceil((a.end-anchor)/step)));
    for(int k=first;k<=last;++k){double t=anchor+k*step,w=(hat(a.end-t,step)-hat(a.start-t,step))/(a.end-a.start);if(w>0){row.weights.push_back({k-nMin,w});support[k-nMin].insert(a.id);info[k-nMin]+=w*w;}}
    doves[at->second].push_back(std::move(row));
  }
  std::vector<int> active;
  out=Result{};out.anchor=anchor;out.arcs=int(arcs.size());out.fleet=int(doves.size());
  for(int i=0;i<n;++i){out.times.push_back(anchor+(i+nMin)*step);out.supported.push_back(support[i].size()>=minDoves&&info[i]>=1.5);if(out.supported[i])active.push_back(i);}
  if(active.size()<2){error="insufficient independently supported fleet nodes";return false;}
  const auto project=[&](std::vector<double>& v){double mean=0;for(int i:active)mean+=v[i];mean/=active.size();for(int i:active)v[i]-=mean;};
  std::vector<std::vector<double>> nu,dt,beta;
  for(auto& list:doves){
    std::stable_sort(list.begin(),list.end(),[](const Row& a,const Row& b){return a.arc.start+a.arc.end<b.arc.start+b.arc.end;});
    nu.emplace_back(list.size(),1);dt.emplace_back(list.size(),1);beta.emplace_back(list.size(),0);
    for(size_t j=1;j<list.size();++j)dt.back()[j]=std::max(1e-3,((list[j].arc.start+list[j].arc.end)-(list[j-1].arc.start+list[j-1].arc.end))/2/day);
  }
  std::vector<double> omega(arcs.size(),1),s(n,0);
  double sigma=std::numeric_limits<double>::quiet_NaN();
  for(int it=0;it<maxIterations;++it){
    out.iterations=it+1;
    const double scale=std::isfinite(sigma)?sigma:0.09,lambda=(scale/stepSigma)*(scale/stepSigma);
    std::vector<double> a(n*n,0),rhs(n,0);
    std::vector<Tridiagonal> factors;
    for(size_t i=0;i<doves.size();++i){
      const auto& list=doves[i];const size_t m=list.size();std::vector<double> d(m,0),e(m-1,0),oy(m);
      for(size_t j=0;j<m;++j){d[j]=omega[list[j].index];oy[j]=omega[list[j].index]*list[j].arc.y;}
      for(size_t j=1;j<m;++j){double k=nu[i][j]*lambda/dt[i][j];d[j-1]+=k;d[j]+=k;e[j-1]=-k;}
      Tridiagonal f;if(!f.factor(d,e)){error="baseline matrix is not positive definite";return false;}
      factors.push_back(f);auto z=f.solve(oy);
      std::map<int,std::vector<double>> cols,x;
      for(size_t j=0;j<m;++j)for(const auto& w:list[j].weights){if(!cols.count(w.node))cols[w.node].assign(m,0);cols[w.node][j]=omega[list[j].index]*w.w;}
      for(const auto& [node,col]:cols)x[node]=f.solve(col);
      for(const auto& row:list)for(const auto& p:row.weights){rhs[p.node]+=omega[row.index]*p.w*row.arc.y;for(const auto& q:row.weights)a[p.node*n+q.node]+=omega[row.index]*p.w*q.w;}
      for(const auto& [node,col]:cols){double v=0;for(size_t j=0;j<m;++j)v+=col[j]*z[j];rhs[node]-=v;for(const auto& [node2,x2]:x){double w=0;for(size_t j=0;j<m;++j)w+=col[j]*x2[j];a[node*n+node2]-=w;}}
    }
    const double smoothing=scale*scale/(smoothSigma*smoothSigma);
    for(int i=0;i+1<n;++i)if(out.supported[i]&&out.supported[i+1]){a[i*n+i]+=smoothing;a[(i+1)*n+i+1]+=smoothing;a[i*n+i+1]-=smoothing;a[(i+1)*n+i]-=smoothing;}
    for(int i=0;i<n;++i)if(!out.supported[i]){for(int k=0;k<n;++k){a[i*n+k]=0;a[k*n+i]=0;}rhs[i]=0;}
    std::vector<double> pap(n*n,0),v(n);
    for(int k=0;k<n;++k){for(int i=0;i<n;++i)v[i]=a[i*n+k];project(v);for(int i=0;i<n;++i)pap[i*n+k]=v[i];}
    for(int i=0;i<n;++i){for(int k=0;k<n;++k)v[k]=pap[i*n+k];project(v);for(int k=0;k<n;++k)pap[i*n+k]=v[k];}
    double trace=0;for(int i:active)trace+=pap[i*n+i];const double ridge=1e-9*trace/active.size()+1e-12;
    for(int i:active)for(int k:active)pap[i*n+k]+=1.0/active.size();
    for(int i=0;i<n;++i)pap[i*n+i]+=out.supported[i]?ridge:1;
    project(rhs);std::vector<double> next;
    if(!cholesky(pap,rhs,next,n)){error="common-mode matrix is not positive definite";return false;}
    double change=0;for(int i=0;i<n;++i)change=std::max(change,std::abs(next[i]-s[i]));s=std::move(next);
    std::vector<double> residuals(arcs.size(),0);
    for(size_t i=0;i<doves.size();++i){
      const auto& list=doves[i];std::vector<double> b(list.size());
      for(size_t j=0;j<list.size();++j){const auto& r=list[j];double model=0;for(const auto& p:r.weights)model+=p.w*s[p.node];b[j]=omega[r.index]*(r.arc.y-model);}
      beta[i]=factors[i].solve(b);
      for(size_t j=0;j<list.size();++j){const auto& r=list[j];double model=0;for(const auto& p:r.weights)model+=p.w*s[p.node];residuals[r.index]=r.arc.y-beta[i][j]-model;}
    }
    if(it<scaleSweeps){double med=median(residuals);std::vector<double> absolute;for(double r:residuals)absolute.push_back(std::abs(r-med));sigma=std::max(1e-3,1.4826*median(absolute));}
    for(size_t j=0;j<arcs.size();++j)omega[j]=std::min(1.0,huber*sigma/std::max(std::abs(residuals[j]),1e-12));
    for(size_t i=0;i<doves.size();++i)for(size_t j=1;j<doves[i].size();++j)nu[i][j]=std::min(1.0,huber*stepSigma*std::sqrt(dt[i][j])/std::max(std::abs(beta[i][j]-beta[i][j-1]),1e-12));
    out.change=change;out.residuals=std::move(residuals);
    if(change<tolerance){out.converged=true;break;}
  }
  out.s=std::move(s);out.sigma=sigma;
  return true;
}
// What a record does with a solve, by the flow's typed config; all off by default.
// lagHours moves every node earlier. noiseSigma and shrinkWindowHours shrink each
// supported node toward the mean of the supported nodes in its trailing window, by
// the share of that window's variance the noise does not explain (empirical Bayes).
struct Publication { double lagHours=0,noiseSigma=0,shrinkWindowHours=0; };
inline std::vector<double> shrunk(const Result& r,const Publication& p) {
  std::vector<double> out=r.s;
  if(!(p.noiseSigma>0&&p.shrinkWindowHours>0))return out;
  const double noise=p.noiseSigma*p.noiseSigma,window=p.shrinkWindowHours*hour;
  for(size_t i=0;i<r.s.size();++i){
    if(!r.supported[i])continue;
    double sum=0,squares=0;int n=0;
    for(size_t j=0;j<=i;++j)if(r.supported[j]&&r.times[i]-r.times[j]<=window){sum+=r.s[j];squares+=r.s[j]*r.s[j];++n;}
    if(n<3)continue;
    const double mean=sum/n,variance=(squares-n*mean*mean)/(n-1);
    out[i]=mean+(variance>noise?1-noise/variance:0)*(r.s[i]-mean);
  }
  return out;
}
} // namespace open_dca
