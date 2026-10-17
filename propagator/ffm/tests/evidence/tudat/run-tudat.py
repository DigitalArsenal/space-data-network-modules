#!/usr/bin/env python3
"""Offline Tudat 1.0.0 evidence on the neutral 72-case export.

Run with the pinned environment's python -I. Python wires native Tudat models,
serializes inputs/results, and schedules one job at a time. All physics, frame
transforms, variational integration and numerical reductions execute in C++.
No environment HOME changes, downloads, or writes to the installed resources.

  python -I run-tudat.py [--only TEXT] [--resume] [--no-stm]

The support library is a small C++ numeric adapter, not a Tudat rebuild. The
base and 2x finer trajectories are retained, so convergence is independently
reduced again by check-tudat.mjs. Values are SI, hourly UTC, TT integration.
"""
import argparse
import ctypes
import datetime
import hashlib
import json
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
EXPORT = HERE.parent / 'cases/ffm-reference-cases.json'
D = json.loads(EXPORT.read_text())
K = D['constants']
P = K['spacecraft']
WORK = HERE / '.work'
WORK.mkdir(exist_ok=True)
for key in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[key] = '1'
try:
    os.nice(10)
except OSError:
    pass
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--only')
parser.add_argument('--resume', action='store_true')
parser.add_argument('--no-stm', action='store_true')
parser.add_argument('--legacy-shadow', action='store_true', help='diagnostic: use ellipsoid mean radius as old fixture')
parser.add_argument('--out', type=Path, default=HERE / 'tudatpy-1.0.0.json')
args = parser.parse_args()

def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def save(p, d):
    p.write_text(json.dumps(d, separators=(',', ':'), allow_nan=False) + '\n')

# Compile only this adapter. Never rebuild the Tudat WASM package.
libfile = WORK / 'tudat-support.dylib'
subprocess.run(['c++', '-std=c++17', '-O2', '-dynamiclib', str(HERE / 'tudat-support.cpp'), '-o', str(libfile)],
               check=True, cwd=WORK, env=dict(os.environ, TMPDIR=str(WORK)))
lib = ctypes.CDLL(str(libfile))
ptr = ctypes.POINTER(ctypes.c_double)
lib.quotient.argtypes = [ctypes.c_double, ctypes.c_double]
lib.quotient.restype = ctypes.c_double
lib.transform_state.argtypes = [ptr, ptr, ctypes.c_int]
lib.transform_phi.argtypes = [ptr, ptr, ctypes.c_int]
lib.scale_column.argtypes = [ptr, ptr, ctypes.c_double, ctypes.c_int]
lib.worst_positions.argtypes = [ptr, ptr, ctypes.c_int]
lib.worst_positions.restype = ctypes.c_double
lib.ballistic_coefficient.argtypes = [ctypes.c_double]*3
lib.ballistic_coefficient.restype = ctypes.c_double
lib.drag_from_ballistic.argtypes = [ctypes.c_double]*6
lib.drag_from_ballistic.restype = ctypes.c_double
lib.ballistic_partial.argtypes = [ptr,ptr,ctypes.c_double,ctypes.c_double,ctypes.c_double,ctypes.c_double,ctypes.c_int]

def arr(values):
    return (ctypes.c_double * len(values))(*values)

def rotate(values, to_gcrf):
    x, y = arr(values), arr([0.0] * 6)
    lib.transform_state(x, y, to_gcrf)
    return list(y)

# Explicit private EOP and weather paths, with all surrounding resource files
# read in place. The settings expose eop_file even though its factory does not.
installed = Path.home() / '.tudat/resource'
source_eop = installed / 'earth_orientation/eopc04_14_IAU2000.62-now.txt'
lines = source_eop.read_text(encoding='latin-1').splitlines()
rows = {r['mjd']: r for e in D['earthOrientation'].values() for r in e['rows']}
kept = [l for l in lines if not (re.match(r'^\s*\d{4}\s+\d+\s+\d+\s+\d{5}\s', l) and int(l.split()[3]) in rows)]
for mjd, r in sorted(rows.items()):
    day = datetime.date(1858, 11, 17) + datetime.timedelta(days=mjd)
    kept.append('%4d%4d%4d%7d%11.6f%11.6f%12.7f%12.7f%11.6f%11.6f%11.6f%11.6f%11.7f%11.7f%12.6f%12.6f' % (
        day.year, day.month, day.day, mjd, r['xPoleArcsec'], r['yPoleArcsec'], r['ut1MinusUtcS'],
        lib.quotient(r['lodMs'], 1000), lib.quotient(r['dXMas'], 1000), lib.quotient(r['dYMas'], 1000), 0, 0, 0, 0, 0, 0))
eop_file = WORK / 'eopc04_14_IAU2000.62-now.txt'
eop_file.write_text('\n'.join(kept) + '\n')

def weather_file(kind):
    const = D['spaceWeather']['constant']
    cssi = {r['DATE']: r for r in D['spaceWeather']['cssi']['rows']} if kind == 'cssi' else {}
    rows = []
    for i in range(214):
        d = datetime.date(2026, 4, 1) + datetime.timedelta(days=i)
        f, fa, ap = const['f107'], const['f107a'], const['ap']
        r = cssi.get(d.isoformat())
        if r:
            kp = [r['KP'+str(j)] for j in range(1,9)]
            aps = [r['AP'+str(j)] for j in range(1,9)]
            values = (r['BSRN'],r['ND'],kp,r['KP_SUM'],aps,r['AP_AVG'],r['CP'],r['C9'],r['ISN'],r['F107_ADJ'],r['F107_DATA_TYPE'],r['F107_ADJ_CENTER81'],r['F107_ADJ_LAST81'],r['F107_OBS'],r['F107_OBS_CENTER81'],r['F107_OBS_LAST81'])
        else:
            values = (0,0,[30]*8,240,[ap]*8,ap,0,0,0,f,0,fa,fa,f,fa,fa)
        br,nd,kp,ks,aps,aa,cp,c9,isn,fadj,qual,ac,al,fobs,oc,ol = values
        rows.append('%4d%3d%3d%5d%3d%s%4d%s%4d%4.1f%2d%4d%6.1f%2d%6.1f%6.1f%6.1f%6.1f%6.1f' % (
            d.year,d.month,d.day,br,nd,''.join('%3d'%x for x in kp),ks,''.join('%4d'%x for x in aps),aa,cp,c9,isn,fadj,qual,ac,al,fobs,oc,ol))
    out = WORK / ('weather-' + kind + '.txt')
    out.write_text('\n'.join(['DATATYPE CssiSpaceWeather','VERSION 1.2',f'NUM_OBSERVED_POINTS {len(rows)}','BEGIN OBSERVED',*rows,'END OBSERVED','NUM_DAILY_PREDICTED_POINTS 0','BEGIN DAILY_PREDICTED','END DAILY_PREDICTED','NUM_MONTHLY_PREDICTED_POINTS 0','BEGIN MONTHLY_PREDICTED','END MONTHLY_PREDICTED','']))
    return out
weather = {kind: weather_file(kind) for kind in ('constant','cssi')}

# Build a CPython settings bridge against the installed native Tudat headers.
# No propagator implementation is compiled or replaced.
prefix = Path(sys.prefix)
settings_file=WORK/'tudat_settings.so'
subprocess.run(['c++','-std=c++17','-O2','-bundle','-undefined','dynamic_lookup',
                '-I'+str(prefix/'include/python3.11'),'-I'+str(prefix/'include'),
                '-I/opt/homebrew/include/eigen3',str(HERE/'tudat-settings.cpp'),'-o',str(settings_file)],
               check=True,cwd=WORK,env=dict(os.environ,TMPDIR=str(WORK)))
sys.setdlopenflags(os.RTLD_NOW | os.RTLD_GLOBAL)
import tudatpy.kernel
settings_spec=importlib.util.spec_from_file_location('tudat_settings',settings_file)
settings_adapter=importlib.util.module_from_spec(settings_spec)
settings_spec.loader.exec_module(settings_adapter)

import numpy as np
import tudatpy
from tudatpy.interface import spice
from tudatpy.astro import time_representation as tr
from tudatpy.dynamics import environment_setup as es, propagation_setup as ps, simulator, parameters_setup as par
from tudatpy.math import interpolators

prefix = Path(sys.prefix)
metadata = json.loads((prefix / 'conda-meta/tudatpy-1.0.0-py311h2196d89_3.json').read_text())
resources_meta = prefix / 'conda-meta/tudat-resources-2.4-h947b425_5.json'
if metadata['version'] != '1.0.0' or metadata['build'] != 'py311h2196d89_3':
    raise RuntimeError('wrong Tudat package identity')
if json.loads(resources_meta.read_text())['version'] != '2.4':
    raise RuntimeError('wrong Tudat resources identity')
kernel = REPO / D['models']['ephemeris']['path']
if digest(kernel) != D['models']['ephemeris']['sha256']:
    raise RuntimeError('DE440 hash mismatch')
spice.load_kernel(str(kernel))
spice.load_kernel(str(installed / 'spice_kernels/naif0012.tls'))
converter = tr.default_time_scale_converter()

def clock(iso):
    return converter.convert_time(tr.utc_scale, tr.tt_scale, tr.iso_string_to_epoch(iso))

def tdb(t):
    return converter.convert_time(tr.tt_scale, tr.tdb_scale, t)

fields = {}
for name, model in D['models']['gravityFields'].items():
    file = REPO / model['path']
    if digest(file) != model['sha256']:
        raise RuntimeError('gravity field hash mismatch')
    fields[name] = [tuple(map(float,m)) for m in re.findall(r'\{\s*(\d+),\s*(\d+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\}',file.read_text())]

def skip_reason(c):
    f=c['forces']; reasons=[]
    if f['solidTides']:
        reasons.append('Tudatpy exposes basic Love-number solid tides, but no factory for the full IERS 2010 section 6.2 frequency-dependent Earth model (including degree-4 induced terms and no pole tide) requested by the export; substituting the basic model would change the case.')
    if f['oceanTides']:
        reasons.append('No exposed FES2004 ocean tide model with the exported degree/order and IERS conventions; periodic coefficient variations are not that model.')
    if f['earthRadiation']:
        reasons.append('Tudat has native Knocke albedo/emissivity laws, but its equal projected-area panels cannot reproduce the export\'s fixed 15-degree cap/crown/sector quadrature and inertial-z latitude.')
    if f['drag'] and f['drag']['atmosphere']!='NRLMSISE00':
        reasons.append('No built-in JB2008 atmosphere in tudatpy 1.0.0; NRLMSISE-00 is a different model.')
    return ' '.join(reasons) or None

# Tables are shared across the same epoch; values come from native SPICE.
ephem_cache={}
def ephemerides(c):
    key=c['epochUtc']
    if key not in ephem_cache:
        t0=clock(key); end=clock(c['sampleEpochsUtc'][-1])
        grid=np.arange(t0-7200,end+7260,60.0)
        ephem_cache[key]={body:{float(t):spice.get_body_cartesian_state_at_epoch(body,origin,'J2000','NONE',tdb(t)) for t in grid}
                          for body,origin in [('Earth','SSB'),('Sun','Earth'),('Moon','Earth')]}
    return ephem_cache[key]

def propagate(c, fine=False, variational=False):
    f=c['forces']; field=f['gravityField']; drag=f['drag']; srp=f['solarRadiationPressure']; eme=c['frame']=='EME2000'
    t0=clock(c['epochUtc']); end=clock(c['sampleEpochsUtc'][-1]); step=(0.5 if fine else 1.0) if srp else (5.0 if fine else 10.0)
    settings=es.BodyListSettings('Earth','GCRS')
    for body in ('Earth','Sun','Moon','Sat','EarthOccultor'):
        settings.add_empty_settings(body)
    earth=settings.get('Earth')
    earth.rotation_model_settings=settings_adapter.gcrs_to_itrs_tt(str(eop_file),t0,end,30.0 if fine else 60.0)
    if field:
        degree,order=field['degree'],field['order']; C=np.zeros((degree+1,degree+1)); S=np.zeros((degree+1,degree+1)); C[0,0]=1
        for n,m,a,b in fields[field['model']]:
            n,m=int(n),int(m)
            if n<=degree and m<=order and not (m>0 and n>field.get('tesseralDegree',degree)):
                C[n,m]=a; S[n,m]=b
        earth.gravity_field_settings=es.gravity_field.spherical_harmonic(f['centralBody']['gmM3S2'],field['radiusM'],C,S,'ITRS')
    else:
        earth.gravity_field_settings=es.gravity_field.central(f['centralBody']['gmM3S2'])
    earth.shape_settings=es.shape.oblate_spherical(K['wgs84']['equatorialRadiusM'],lib.quotient(1,K['wgs84']['inverseFlattening'])) if drag else es.shape.spherical(K['shadowBodyRadiusM'])
    if drag:
        earth.atmosphere_settings=es.atmosphere.nrlmsise00(str(weather[drag['spaceWeather']]),False,True)
    tables=ephemerides(c)
    for body in ('Earth','Sun','Moon'):
        settings.get(body).ephemeris_settings=es.ephemeris.tabulated(tables[body],'SSB' if body=='Earth' else 'Earth','GCRS')
    settings.get('Sun').gravity_field_settings=es.gravity_field.central(K['sunGmM3S2'])
    settings.get('Moon').gravity_field_settings=es.gravity_field.central(K['moonGmM3S2'])
    settings.get('Sun').shape_settings=es.shape.spherical(K['sunRadiusM'])
    settings.get('Sun').radiation_source_settings=es.radiation_pressure.isotropic_radiation_source(es.radiation_pressure.irradiance_based_constant_luminosity(K['solarIrradianceAt1AuWM2'],K['auM']))
    settings.get('EarthOccultor').ephemeris_settings=es.ephemeris.constant([0,0,0,0,0,0],'Earth','GCRS')
    settings.get('EarthOccultor').shape_settings=es.shape.spherical(K['shadowBodyRadiusM'])
    sat=settings.get('Sat'); sat.constant_mass=P['massKg']
    if srp:
        sat.radiation_pressure_target_settings=es.radiation_pressure.cannonball_radiation_target(srp['areaM2'],srp['cr'],{'Sun':['Earth' if args.legacy_shadow else 'EarthOccultor']})
    ballistic = [lib.ballistic_coefficient(drag['cd'],drag['areaM2'],drag['massKg']),drag.get('areaOverMassRateM2KgS',0)] if drag else None
    if drag:
        if drag.get('areaOverMassRateM2KgS'):
            def coefficients(values):
                return [lib.drag_from_ballistic(values[0],t0,ballistic[0],ballistic[1],drag['massKg'],drag['areaM2']),0,0]
            sat.aerodynamic_coefficient_settings=es.aerodynamic_coefficients.custom_aerodynamic_force_coefficients(coefficients,drag['areaM2'],[es.aerodynamic_coefficients.time_dependent])
        else:
            sat.aerodynamic_coefficient_settings=es.aerodynamic_coefficients.constant(drag['areaM2'],[drag['cd'],0,0])
    bodies=es.create_system_of_bodies(settings)
    earth_forces=[ps.acceleration.spherical_harmonic_gravity(field['degree'],field['order'])] if field else [ps.acceleration.point_mass_gravity()]
    if drag: earth_forces.append(ps.acceleration.aerodynamic())
    if f['relativity']=='schwarzschild': earth_forces.append(ps.acceleration.relativistic_correction(True,False,False))
    if f['relativity']=='iers2010': earth_forces.append(ps.acceleration.relativistic_correction(True,True,True,'Sun',[0,0,9.8e8]))
    if f['inTrackAccelerationMS2']: earth_forces.append(ps.acceleration.empirical([0,f['inTrackAccelerationMS2'],0]))
    accelerations={'Earth':earth_forces}
    for body in f['thirdBodies']: accelerations[body.title()]=[ps.acceleration.point_mass_gravity()]
    if srp: accelerations.setdefault('Sun',[]).append(ps.acceleration.radiation_pressure())
    models=ps.create_acceleration_models(bodies,{'Sat':accelerations},['Sat'],['Earth'])
    if f['relativity']=='iers2010':
        settings_adapter.configure_rotating_pole(models['Sat']['Earth'][-1],bodies)
    custom_drag=bool(drag and drag.get('areaOverMassRateM2KgS'))
    if custom_drag:
        # Keep Tudat's aerodynamic force; its supported custom wrapper admits
        # the B/Bdot partials that the native aero-partial factory rejects.
        original_aerodynamics=models['Sat']['Earth'][1]
        callback=settings_adapter.native_aerodynamic_callback(original_aerodynamics,bodies)
        state_partial=settings_adapter.native_aerodynamic_state_partial(original_aerodynamics,bodies)
        wrapped=ps.create_acceleration_models(bodies,{'Sat':{'Earth':[ps.acceleration.custom_acceleration(callback)]}},['Sat'],['Earth'])
        models['Sat']['Earth'][1]=wrapped['Sat']['Earth'][0]
    x0=c['initialState']['positionM']+c['initialState']['velocityMS']
    if eme: x0=rotate(x0,1)
    integrator=ps.integrator.runge_kutta_fixed_step(step,ps.integrator.rkdp_87)
    termination=ps.propagator.time_termination(end+8*step,terminate_exactly_on_final_condition=True)
    propagator=ps.propagator.translational(['Earth'],models,['Sat'],x0,t0,integrator,termination,ps.propagator.cowell)
    parameter_keys=[]
    if variational:
        pars=par.initial_states(propagator,bodies)
        if custom_drag:
            # Native central differences, restoring the nominal state and
            # caches before the B/Bdot parameter partials are evaluated.
            pars[0].custom_partial_settings=[par.custom_analytical_partial(state_partial,'Sat','Earth',ps.acceleration.custom_acceleration_type)]
        requested=c.get('sensitivities',{}).get('parameters',[])
        def add_parameter(setting,key,scale):
            pars.append(setting); parameter_keys.append((key,scale,setting.parameter_identifier))
        if srp: add_parameter(par.radiation_pressure_coefficient('Sat'),'srpAreaOverMass',lib.quotient(srp['massKg'],srp['areaM2']))
        if drag:
            if drag.get('areaOverMassRateM2KgS'):
                def custom_ballistic(index,key):
                    def getter(): return np.array([ballistic[index]])
                    def setter(value): ballistic[index]=float(value[0])
                    def partial(t,acceleration):
                        a=arr(acceleration.tolist()); out=arr([0]*3)
                        lib.ballistic_partial(a,out,t,t0,ballistic[0],ballistic[1],index)
                        return np.array(list(out)).reshape((3,1))
                    custom=par.custom_parameter(key,1,getter,setter)
                    custom.custom_partial_settings=[par.custom_analytical_partial(partial,'Sat','Earth',ps.acceleration.custom_acceleration_type)]
                    add_parameter(custom,key,1.0)
                custom_ballistic(0,'dragAreaOverMass')
                if 'DRAG_AREA_OVER_MASS_RATE' in requested: custom_ballistic(1,'dragAreaOverMassRate')
            else:
                add_parameter(par.constant_drag_coefficient('Sat'),'dragAreaOverMass',lib.quotient(drag['massKg'],drag['areaM2']))
        if 'IN_TRACK_ACCELERATION' in requested:
            add_parameter(par.empirical_accelerations('Sat','Earth',{par.along_track_empirical_acceleration_component:[par.constant_empirical]}),'inTrackAcceleration',1.0)
        parameters=par.create_parameter_set(pars,bodies,propagator)
        # Tudat groups scalar and vector parameters independently of input
        # order. Query the native identifiers rather than assuming positions.
        parameter_indices=[]
        for key,scale,identifier in parameter_keys:
            indices=parameters.indices_for_parameter_type(identifier)
            if len(indices)!=1 or indices[0][1]!=1: raise RuntimeError('Ambiguous native parameter '+key)
            parameter_indices.append((key,scale,indices[0][0]))
        solver=simulator.create_variational_equations_solver(bodies,propagator,parameters)
        history=solver.state_history
    else:
        solver=simulator.create_dynamics_simulator(bodies,propagator)
        history=solver.propagation_results.state_history
    interpolation=interpolators.create_one_dimensional_vector_interpolator(history,interpolators.lagrange_interpolation(8))
    samples=[]; stms=[]
    for offset,iso in zip(c['sampleOffsetsS'],c['sampleEpochsUtc']):
        t=clock(iso); state=list(interpolation.interpolate(t)) if offset else x0
        if eme: state=rotate(state,0)
        samples.append([offset,*map(float,state),iso])
        if variational:
            # Hourly epochs lie exactly on the fixed TT grid, so no STM
            # interpolation or reintegration is needed.
            combined=solver.state_transition_interface.full_state_transition_sensitivity_at_epoch(t)
            phi=combined[:6,:6]
            a=arr(phi.flatten().tolist()); b=arr([0]*36); lib.transform_phi(a,b,eme)
            item={'phi':list(b)}
            if parameter_keys:
                for key,scale,j in parameter_indices:
                    a=arr(combined[:6,j].tolist()); b=arr([0]*6); lib.scale_column(a,b,scale,eme); item[key]=list(b)
            stms.append(item)
    return samples,stms

package_root=Path(tudatpy.__file__).parent
inputs=[EXPORT,kernel,HERE/'run-tudat.py',HERE/'tudat-support.cpp',HERE/'tudat-settings.cpp',eop_file,*weather.values(),source_eop,
        installed/'spice_kernels/naif0012.tls',prefix/'conda-meta/tudatpy-1.0.0-py311h2196d89_3.json',resources_meta,
        package_root/'kernel.so',package_root/'__init__.py']
inputs.extend(REPO/m['path'] for m in D['models']['gravityFields'].values())
inputs.extend(p for p in (installed/'earth_orientation').iterdir() if p.is_file() and p!=source_eop)
inputs.extend(prefix/'include/tudat'/p for p in [
    'simulation/environment_setup/createRotationModel.h',
    'simulation/environment_setup/body.h',
    'astro/relativity/relativisticAccelerationCorrection.h',
    'simulation/estimation_setup/createAccelerationPartials.h',
    'astro/orbit_determination/acceleration_partials/radiationPressureAccelerationPartial.h',
    'astro/orbit_determination/acceleration_partials/aerodynamicAccelerationPartial.h',
    'astro/orbit_determination/estimatable_parameters/estimatableParameter.h',
    'astro/orbit_determination/acceleration_partials/relativisticAccelerationPartial.h'])
identity=[{'path':str(p),'sha256':digest(p)} for p in inputs]
base={'tool':{'name':'Tudat via tudatpy (TU Delft, BSD-3-Clause)','tudatpy':tudatpy.__version__,'version':'1.0.0','build':metadata['build'],'channel':metadata.get('channel'),'tudatResources':'2.4','kernelSha256':digest(package_root/'kernel.so'),'python':sys.version.split()[0]},
      'caseExportSha256':digest(EXPORT),'inputFiles':identity,
      'settings':{'integrator':'RKDP 8(7), fixed step','stepS':10,'srpStepS':1,'orientationInterpolationS':60,'fineOrientationInterpolationS':30,'fineStepS':5,'fineSrpStepS':0.5,'clock':'TT; SPICE ephemerides tabulated at corresponding TDB','frame':'GCRS (GCRF), EME2000 output through IERS frame bias','earthOrientation':'native IERS2010 with private C04 EOP file; default subdaily corrections; explicit native TT input clock','shadow':'ellipsoid mean radius (legacy diagnostic)' if args.legacy_shadow else 'separate spherical EarthOccultor, radius 6378137 m; WGS84 Earth for drag','atmosphere':'native NRLMSISE-00, daily Ap, anomalous oxygen, mean local solar time; private constant/CSSI files','stm':'native variational equations; 6x6 orbit block, Cr/Cd per-unit coefficient*area/mass, and exported C1 ballistic-rate/in-track columns. Custom ballistic parameter partials are exact C++ a/b and elapsed*a/b. R2 partials unavailable in native Tudat.'},'cases':[],'skipped':[]}
fine_doc={'caseExportSha256':digest(EXPORT),'cases':[]}; stm_doc={'caseExportSha256':digest(EXPORT),'cases':[]}
for c in D['cases']:
    reason=skip_reason(c)
    if reason: base['skipped'].append({'id':c['id'],'reason':reason}); continue
    if args.only and args.only not in c['id']: continue
    cache=WORK/(re.sub('[^A-Za-z0-9_-]','_',c['id'])+('-legacy' if args.legacy_shadow else '')+'.json')
    recipe={'caseExportSha256':base['caseExportSha256'],'inputFiles':identity,'settings':base['settings'],'stmEnabled':not args.no_stm and c['forces']['relativity']!='iers2010'}
    if args.resume and cache.exists():
        item=json.loads(cache.read_text())
        if item.get('recipe')!=recipe: raise RuntimeError('Stale native cache identity: '+str(cache))
    else:
        stm_enabled=not args.no_stm and c['forces']['relativity']!='iers2010'
        samples,stms=propagate(c,variational=stm_enabled)
        fine_samples,_=propagate(c,fine=True)
        a=arr([v for s in samples for v in s[1:7]]); b=arr([v for s in fine_samples for v in s[1:7]])
        worst=lib.worst_positions(a,b,len(samples))
        item={'recipe':recipe,'samples':samples,'fineSamples':fine_samples,'stm':stms,'convergence':{'worstM':worst,'coarseStepS':1 if c['forces']['solarRadiationPressure'] else 10,'fineStepS':0.5 if c['forces']['solarRadiationPressure'] else 5,'limitM':0.0003,'met':worst<0.0003}}
        if not stm_enabled: item['stmSkipped']='Native RelativisticAccelerationPartial throws for Lense-Thirring/de Sitter: only Schwarzschild variational equations implemented. R2 trajectory uses the full native force.' if c['forces']['relativity']=='iers2010' else 'Disabled by explicit --no-stm diagnostic option.'
        save(cache,item)
    result={k:c[k] for k in ('id','orbit','forceSet','row','toleranceClass')}
    result.update({k:item[k] for k in ('samples','convergence')})
    if 'stmSkipped' in item: result['stmSkipped']=item['stmSkipped']
    base['cases'].append(result)
    fine_doc['cases'].append({'id':c['id'],'samples':item['fineSamples']})
    if item['stm']: stm_doc['cases'].append({'id':c['id'],'stm':item['stm']})
    print(c['id']+': step-halving '+str(item['convergence']['worstM'])+' m',flush=True)
    save(args.out,base); save(args.out.with_name(args.out.stem+'-fine.json'),fine_doc); save(args.out.with_name(args.out.stem+'-stm.json'),stm_doc)
if not args.only and len(base['cases'])+len(base['skipped'])!=len(D['cases']): raise RuntimeError('case coverage incomplete')
save(args.out,base)
save(args.out.with_name(args.out.stem+'-fine.json'),fine_doc)
save(args.out.with_name(args.out.stem+'-stm.json'),stm_doc)
print('Wrote '+str(args.out),flush=True)
