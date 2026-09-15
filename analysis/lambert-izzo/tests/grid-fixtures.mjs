// Test-only independent physics fixtures. Production JavaScript only packs bytes.
import fs from 'node:fs';
export const mu = 3.986004418e14;
export const metadata = {referenceFrame:'GCRF', timeScale:'TT', epochOrigin:'2000-01-01T12:00:00', mu};
export function circular(radius, epochs, phase = 0, direction = 1) {
  const rate = direction*Math.sqrt(mu/radius**3), speed = rate*radius;
  return {epochs, positions:epochs.map(t => [radius*Math.cos(phase+rate*t), radius*Math.sin(phase+rate*t),0]),
    velocities:epochs.map(t => [-speed*Math.sin(phase+rate*t), speed*Math.cos(phase+rate*t),0])};
}
export function hohmann(step = 60) {
  const r1=6678137, r2=42164000, a=(r1+r2)/2, tof=Math.PI*Math.sqrt(a**3/mu);
  const dv1=Math.sqrt(mu/r1)*(Math.sqrt(2*r2/(r1+r2))-1);
  const dv2=Math.sqrt(mu/r2)*(1-Math.sqrt(2*r1/(r1+r2)));
  const departures=Array.from({length:13}, (_,i)=>-360+i*60);
  const arrivals=Array.from({length:13},(_,i)=>tof-360+i*60);
  return {...metadata, departure:circular(r1,departures), arrival:circular(r2,arrivals,Math.PI-Math.sqrt(mu/r2**3)*tof),
    departureStart:-360, departureEnd:360, arrivalStart:tof-360, arrivalEnd:tof+360, step,
    expected:{dv1,dv2,total:dv1+dv2,tof}};
}
export function antipodalMulti(branch = 1) {
  const r=7e6, v=Math.sqrt(mu/r), tof=3*Math.PI*Math.sqrt(r**3/mu);
  // Independently bracket Izzo Eq.18 lambda=0, M=1 on its right branch.
  // Left root is exactly x=0, T=3*pi/2 (paper Eq.19). No new-kernel golden.
  let lo=.2, hi=.9;
  for(let i=0;i<70;i++) {
    const x=(lo+hi)/2, y=1-x*x;
    const T=((Math.acos(x)+Math.PI)/Math.sqrt(y)-x)/y;
    if(T>1.5*Math.PI) hi=x; else lo=x;
  }
  const x=branch===1?0:(lo+hi)/2;
  return {...metadata, departure:{epochs:[0],positions:[[r,0,0]],velocities:[[-v*x,v,0]]},
    arrival:{epochs:[tof],positions:[[-r,0,0]],velocities:[[-v*x,-v,0]]},
    departureStart:0, departureEnd:0, arrivalStart:tof, arrivalEnd:tof, step:1,
    maxRevolutions:3, expected:{branch,x}};
}
export function earthMars() {
  const states=JSON.parse(fs.readFileSync(new URL('./fixtures/earth-mars-2005.json',import.meta.url)));
  return {...metadata,...states,mu:1.32712440018e20,referenceFrame:'EME2000',timeScale:'TDB',
    departureStart:states.departure.epochs[0],departureEnd:states.departure.epochs.at(-1),
    arrivalStart:states.arrival.epochs[0],arrivalEnd:states.arrival.epochs.at(-1),step:86400};
}
