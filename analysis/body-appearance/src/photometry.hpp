#pragma once
#include "models.hpp"

namespace appearance {
// Clamped cubic spline through Muinonen et al. Tables 3/4. The tridiagonal
// system solves for second derivatives; knots are SI radians. No fitted
// correction, oracle training, or phase polynomial from Mallama is used here.
inline double hg_basis(int basis,double angle) {
  const std::string model="hg1g2:phi"+std::to_string(basis);
  if(basis<3 && angle<=7.5*pi/180)return 1+parameter(model,"derivative_left")*angle;
  if(basis==3 && angle>=30*pi/180)return 0;
  const int n=basis==3?9:6;
  std::array<double,9>x{},y{},a{},b{},c{},d{},m{};
  for(int i=0;i<n;++i) {x[i]=parameter(model,"x"+std::to_string(i))*pi/180;y[i]=parameter(model,"y"+std::to_string(i));}
  b[0]=2*(x[1]-x[0]);c[0]=x[1]-x[0];
  d[0]=6*((y[1]-y[0])/(x[1]-x[0])-parameter(model,"derivative_left"));
  for(int i=1;i<n-1;++i) {
    a[i]=x[i]-x[i-1];c[i]=x[i+1]-x[i];b[i]=2*(a[i]+c[i]);
    d[i]=6*((y[i+1]-y[i])/c[i]-(y[i]-y[i-1])/a[i]);
  }
  a[n-1]=x[n-1]-x[n-2];b[n-1]=2*a[n-1];
  d[n-1]=6*(parameter(model,"derivative_right")-(y[n-1]-y[n-2])/a[n-1]);
  for(int i=1;i<n;++i) {const double k=a[i]/b[i-1];b[i]-=k*c[i-1];d[i]-=k*d[i-1];}
  m[n-1]=d[n-1]/b[n-1];for(int i=n-2;i>=0;--i)m[i]=(d[i]-c[i]*m[i+1])/b[i];
  int j=0;while(j<n-2 && angle>x[j+1])++j;
  const double h=x[j+1]-x[j],l=(x[j+1]-angle)/h,r=(angle-x[j])/h;
  return l*y[j]+r*y[j+1]+((l*l*l-l)*m[j]+(r*r*r-r)*m[j+1])*h*h/6;
}
inline double hg_flux(double phase,double g1,double g2) {
  return g1*hg_basis(1,phase)+g2*hg_basis(2,phase)+(1-g1-g2)*hg_basis(3,phase);
}

}
