"""Independent reference from primary equations; never loads the module.
Run with Python 3 stdlib; outputs checked-in reference-vectors.json.
SI, local vertical/true-north from bearings; steady model, no epoch/time scale.
Adaptive integration in inverse frequency z=fp/f differs from the guest's
fixed Simpson integration in ln(f/fp). Error target 1e-13 absolute for I.
"""
import json
import math as m
from pathlib import Path
G = 9.80665

def quad(f, a, b, tol=1e-13, depth=30):
    c = (a+b)/2
    fa, fb, fc = f(a), f(b), f(c)
    whole = (b-a)*(fa+4*fc+fb)/6
    def step(a,b,fa,fb,fc,whole,tol,depth):
        c=(a+b)/2
        fd,fe=f((a+c)/2),f((c+b)/2)
        left=(c-a)*(fa+4*fd+fc)/6
        right=(b-c)*(fc+4*fe+fb)/6
        delta=left+right-whole
        if abs(delta)<=15*tol: return left+right+delta/15
        if depth==0: raise RuntimeError('quadrature did not converge')
        return step(a,c,fa,fc,fd,left,tol/2,depth-1)+step(c,b,fc,fb,fe,right,tol/2,depth-1)
    return step(a,b,fa,fb,fc,whole,tol,depth)

def shape(z, gamma):
    if z==0: return 0
    sigma=.07 if z>=1 else .09
    return z**3*m.exp(-1.25*z**4)*gamma**m.exp(-.5*((1/z-1)/sigma)**2)
# Tail above z=8 is < exp(-5120); subdivisions resolve the narrow peak.
I=sum(quad(lambda z:shape(z,3.3),a,b) for a,b in zip([0,.5,.8,1,1.2,2],[.5,.8,1,1.2,2,8]))
I_PM=quad(lambda z:shape(z,1),0,8)
assert abs(I_PM-.2)<1e-13

def pm(u):
    u19=u/(10/19.5)**(1/7)
    variance=.0081*u19**4/(4*.74*G**2)
    fp=G/u19/(5/(4*.74))**.25/(2*m.pi)
    return dict(hs_m=4*m.sqrt(variance),m0_m2=variance,fp_hz=fp,tp_s=1/fp,alpha=.0081,gamma=1,hs_uncapped_m=4*m.sqrt(variance),alpha_uncapped=.0081,energy_scale=1)

def ref(u,fetch=0,duration=0):
    if u==0: return dict(hs_m=0,m0_m2=0,fp_hz=0,tp_s=0,alpha=0,gamma=1,regime='calm',hs_uncapped_m=0,alpha_uncapped=0,energy_scale=1)
    p=pm(u)
    xf=G*fetch/u**2 if fetch else m.inf
    # Independent duration inversion via bisection of group-velocity travel
    # integral. Substitute x=y^12 to remove the singularity at zero fetch.
    def travel(x):
        return 4*m.pi*3.5*x**.67*quad(lambda y:12*y**7.04,0,1)*u/G
    xt=m.inf
    if duration:
        lo,hi=0,1e8
        for _ in range(70):
            mid=(lo+hi)/2
            if travel(mid)<duration: lo=mid
            else: hi=mid
        xt=(lo+hi)/2
    x=min(xf,xt)
    if x==m.inf or 3.5*G/u*x**(-.33)<=p['fp_hz']:
        return dict(**p,regime='fully-developed')
    alpha=.076*x**(-.22)
    fp=3.5*G/u*x**(-.33)
    variance=alpha*G**2/(2*m.pi)**4/fp**4*I
    scale=min(1,p['m0_m2']/variance)
    return dict(hs_m=4*m.sqrt(variance*scale),m0_m2=variance*scale,fp_hz=fp,tp_s=1/fp,alpha=alpha*scale,gamma=3.3,
                hs_uncapped_m=4*m.sqrt(variance),alpha_uncapped=alpha,energy_scale=scale,
                regime='duration-limited' if xt<xf else 'fetch-limited')

winds=[0,2,5,8,10,12,15,20,25,30,70]
cases=[]
for label,fetch,duration in [('pm',0,0),('fetch10km',10000,0),('duration1h',0,3600),('both',10000,3600)]:
    for u in winds:
        cases.append(dict(name=f'{label}-{u}',method='sea_state',values=dict(wind_speed_10m_mps=u,fetch_m=fetch,duration_s=duration,wind_from_deg=270),expected=ref(u,fetch,duration)))
p=pm(10)
xpm=(3.5*G/(10*p['fp_hz']))**(1/.33)
for factor in [.999999,1.000001]:
    fetch=xpm*100/G*factor
    cases.append(dict(name=f'transition-{factor}',method='sea_state',values=dict(wind_speed_10m_mps=10,fetch_m=fetch),expected=ref(10,fetch)))
report=dict(source='PM1964 Eq12; SPM1984 Eq3-26; JONSWAP1973 Eq2.4.1,3,4,5; derived travel time (SOURCES.md)',
    units='wind m/s; fetch m; duration/period s; Hs m; m0 m2; fp Hz; coefficients dimensionless',
    frame='local mean sea surface; bearings come from, clockwise from true north',
    epoch='none; stationary uniform deep-water wind',
    tolerance=dict(relative=2e-9,absolute=1e-11,rationale='Numerical quadrature/IEEE-754 allowance, not observational accuracy. References use adaptive inverse-frequency integration; guest fixed log-frequency quadrature.'),
    shape_integral=I,pm_integral_error=abs(I_PM-.2),pm_transition_fetch_at_10mps_m=xpm*100/G,cases=cases)
Path(__file__).with_suffix('.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='cases'},indent=2))
