"""Tudat (tudatpy, TU Delft, BSD-3-Clause) on the engine benchmark plan.

The COMMON-tier cases of plan.json (tests/evidence/engines/plan.mjs), timed. Each case
is propagated for 1 day and for 3 days; the cost per object-day is the
difference of the two propagations' process CPU times over two days, so body
creation and simulator set-up cancel.

    python -I run-tudat.py <work dir> [--only TEXT] [--reps 1] [--out tudat.json] [--home dir]

Settings follow tests/fixtures/tudat/tudat_reference.py (its header gives each
one): Earth GM 3.986004415e14 and FFM's embedded EGM2008 to 70x70 in ITRS,
Tudat's IERS 2010 GCRS-to-ITRS rotation (IAU 2006/2000A, CIO based) with the
plan's EOP rows written into a private resource tree, the Sun and Moon from
the plan's DE440 kernel through SPICE tabulated every 60 s in GCRS (Tudat's
interpolated-ephemeris practice; Lagrange interpolation in Tudat), cannonball
radiation pressure at 1361 W/m^2 occulted by a 6378137 m sphere, NRLMSISE-00
on constant space weather (a CelesTrak-layout file), TT as the integration
clock. Integrator: rkdp_87 (RK8(7)13M, FFM's RKDP87 tableau), fixed steps, or
variable steps with element-wise scalar tolerances (largest component of
err/(abs + rel |y|), as FFM) and step limits.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('work')
parser.add_argument('--only')
parser.add_argument('--reps', type=int, default=1)
parser.add_argument('--out')
parser.add_argument('--home', help='private resource tree (default <work>/tudat-home)')
args = parser.parse_args()
WORK = os.path.abspath(args.work)
PLAN = json.load(open(os.path.join(WORK, 'plan.json')))
K, SC, SW = PLAN['constants'], PLAN['spacecraft'], PLAN['spaceWeather']
HERE = os.path.dirname(os.path.abspath(__file__))
EGM = os.path.join(HERE, '..', '..', '..', 'lib', 'egm2008_data.h')
for key in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[key] = '1'
AU3_DAY2 = K['auM'] ** 3 / 86400.0 ** 2
GM_SUN = 2.9591220828411951e-04 * AU3_DAY2
GM_MOON = 8.9970116036316091e-10 * AU3_DAY2 / (1 + 81.3005682214972154)


def resource_tree():
    """$HOME/.tudat/resource for this run: the installed resources, Earth orientation and space weather replaced."""
    installed = os.path.join(os.path.expanduser('~'), '.tudat', 'resource')
    home = os.path.abspath(args.home) if args.home else os.path.join(WORK, 'tudat-home')
    tree = os.path.join(home, '.tudat', 'resource')
    os.makedirs(tree, exist_ok=True)
    for name in os.listdir(installed):
        link = os.path.join(tree, name)
        if name in ('earth_orientation', 'space_weather') or os.path.lexists(link):
            continue
        os.symlink(os.path.join(installed, name), link)
    eop_dir = os.path.join(tree, 'earth_orientation')
    os.makedirs(eop_dir, exist_ok=True)
    for name in os.listdir(os.path.join(installed, 'earth_orientation')):
        if name != 'eopc04_14_IAU2000.62-now.txt' and not os.path.lexists(os.path.join(eop_dir, name)):
            os.symlink(os.path.join(installed, 'earth_orientation', name), os.path.join(eop_dir, name))
    rows = {r['mjd']: r for r in json.load(open(PLAN['data']['eop']['path']))['rows']}
    lines = open(os.path.join(installed, 'earth_orientation', 'eopc04_14_IAU2000.62-now.txt'), encoding='latin-1').read().split('\n')
    kept = [l for l in lines if not (re.match(r'^\s*\d{4}\s+\d+\s+\d+\s+(\d{5})\s', l) and int(l.split()[3]) >= min(rows))]
    for mjd in sorted(rows):
        r, d = rows[mjd], datetime.date(1858, 11, 17) + datetime.timedelta(days=mjd)
        kept.append('%4d%4d%4d%7d%11.6f%11.6f%12.7f%12.7f%11.6f%11.6f%11.6f%11.6f%11.7f%11.7f%12.6f%12.6f' % (
            d.year, d.month, d.day, mjd, r['xPoleArcsec'], r['yPoleArcsec'], r['ut1MinusUtcS'], r['lodMs'] / 1000,
            r['dXMas'] / 1000, r['dYMas'] / 1000, 0, 0, 0, 0, 0, 0))
    open(os.path.join(eop_dir, 'eopc04_14_IAU2000.62-now.txt'), 'w').write('\n'.join(l for l in kept if l.strip() or l is kept[0]) + '\n')
    sw_dir = os.path.join(tree, 'space_weather')
    os.makedirs(sw_dir, exist_ok=True)
    days = [datetime.date(2026, 4, 1) + datetime.timedelta(days=i) for i in range(214)]
    kp, ap, f = 30, int(SW['ap']), SW['f107']
    body = ['%4d%3d%3d%5d%3d%s%4d%s%4d%4.1f%2d%4d%6.1f%2d%6.1f%6.1f%6.1f%6.1f%6.1f' % (
        d.year, d.month, d.day, 0, 0, '%3d' % kp * 8, kp * 8, '%4d' % ap * 8, ap, 0.0, 0, 0, f, 0, SW['f107a'], SW['f107a'], f, SW['f107a'], SW['f107a']) for d in days]
    open(os.path.join(sw_dir, 'sw19571001.txt'), 'w').write('\n'.join([
        'DATATYPE CssiSpaceWeather', 'VERSION 1.2', '# Constant space weather (tests/evidence/engines/run-tudat.py)',
        'NUM_OBSERVED_POINTS %d' % len(body), 'BEGIN OBSERVED', *body, 'END OBSERVED', '',
        'NUM_DAILY_PREDICTED_POINTS 0', 'BEGIN DAILY_PREDICTED', 'END DAILY_PREDICTED', '',
        'NUM_MONTHLY_PREDICTED_POINTS 0', 'BEGIN MONTHLY_PREDICTED', 'END MONTHLY_PREDICTED', '']))
    return home


os.environ['HOME'] = resource_tree()
import numpy as np  # noqa: E402
import tudatpy  # noqa: E402
from tudatpy.interface import spice  # noqa: E402
from tudatpy.astro import time_representation as tr  # noqa: E402
from tudatpy.dynamics import environment_setup as es, propagation_setup as ps, simulator  # noqa: E402
from tudatpy.math import interpolators  # noqa: E402

spice.load_kernel(PLAN['data']['kernel']['path'])
spice.load_kernel(os.path.join(os.environ['HOME'], '.tudat', 'resource', 'spice_kernels', 'naif0012.tls'))
coefficients = [tuple(map(float, m)) for m in re.findall(r'\{\s*(\d+),\s*(\d+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\}', open(EGM).read())]
converter = tr.default_time_scale_converter()


def tt(iso):
    return converter.convert_time(tr.utc_scale, tr.tt_scale, tr.iso_string_to_epoch(iso))


def to_tdb(t):
    return converter.convert_time(tr.tt_scale, tr.tdb_scale, t)


T0 = tt(PLAN['epochUtc'])
GRID = np.arange(T0 - 7200, T0 + PLAN['days'] * 86400 + 7200 + 60, 60.0)
TABLES = {(target, observer): {float(t): np.array(spice.get_body_cartesian_state_at_epoch(target, observer, 'J2000', 'NONE', to_tdb(t))) for t in GRID}
          for target, observer in (('Earth', 'SSB'), ('Sun', 'Earth'), ('Moon', 'Earth'))}


def bodies_for(c):
    f = c['forces']
    degree, order = f['gravity']['degree'], f['gravity']['order']
    C, S = np.zeros((degree + 1, degree + 1)), np.zeros((degree + 1, degree + 1))
    C[0, 0] = 1.0
    for n, m, cc, ss in coefficients:
        if n <= degree and m <= order:
            C[int(n), int(m)], S[int(n), int(m)] = cc, ss
    settings = es.BodyListSettings('Earth', 'GCRS')
    for body in ('Earth', 'Sun', 'Moon', 'Sat', 'EarthOccultor'):
        settings.add_empty_settings(body)
    earth = settings.get('Earth')
    earth.rotation_model_settings = es.rotation_model.gcrs_to_itrs(es.rotation_model.iau_2006, 'GCRS')
    earth.gravity_field_settings = es.gravity_field.spherical_harmonic(K['earthGmM3S2'], K['fieldRadiusM'], C, S, 'ITRS')
    earth.shape_settings = es.shape.oblate_spherical(K['wgs84']['equatorialRadiusM'], 1 / K['wgs84']['inverseFlattening']) if f['drag'] else es.shape.spherical(K['shadowBodyRadiusM'])
    if f['drag']:
        earth.atmosphere_settings = es.atmosphere.nrlmsise00()
    earth.ephemeris_settings = es.ephemeris.tabulated(TABLES[('Earth', 'SSB')], 'SSB', 'GCRS')
    for body in ('Sun', 'Moon'):
        settings.get(body).ephemeris_settings = es.ephemeris.tabulated(TABLES[(body, 'Earth')], 'Earth', 'GCRS')
    settings.get('Sun').gravity_field_settings = es.gravity_field.central(GM_SUN)
    settings.get('Moon').gravity_field_settings = es.gravity_field.central(GM_MOON)
    settings.get('Sun').shape_settings = es.shape.spherical(K['sunRadiusM'])
    settings.get('Sun').radiation_source_settings = es.radiation_pressure.isotropic_radiation_source(
        es.radiation_pressure.irradiance_based_constant_luminosity(K['solarIrradianceAt1AuWM2'], K['auM']))
    # The shadow body: a 6378137 m sphere at the Earth's center (Tudat would otherwise take the drag ellipsoid's mean radius).
    settings.get('EarthOccultor').ephemeris_settings = es.ephemeris.constant([0, 0, 0, 0, 0, 0], 'Earth', 'GCRS')
    settings.get('EarthOccultor').shape_settings = es.shape.spherical(K['shadowBodyRadiusM'])
    sat = settings.get('Sat')
    sat.constant_mass = SC['massKg']
    if f['srp']:
        sat.radiation_pressure_target_settings = es.radiation_pressure.cannonball_radiation_target(SC['areaM2'], SC['cr'], {'Sun': ['EarthOccultor']})
    if f['drag']:
        sat.aerodynamic_coefficient_settings = es.aerodynamic_coefficients.constant(SC['areaM2'], [SC['cd'], 0.0, 0.0])
    return es.create_system_of_bodies(settings)


def propagate(c, bodies, days):
    f, s = c['forces'], c['settings']
    earth_forces = [ps.acceleration.spherical_harmonic_gravity(f['gravity']['degree'], f['gravity']['order'])]
    if f['drag']:
        earth_forces.append(ps.acceleration.aerodynamic())
    accelerations = {'Earth': earth_forces, 'Moon': [ps.acceleration.point_mass_gravity()], 'Sun': [ps.acceleration.point_mass_gravity()]}
    if f['srp']:
        accelerations['Sun'].append(ps.acceleration.radiation_pressure())
    models = ps.create_acceleration_models(bodies, {'Sat': accelerations}, ['Sat'], ['Earth'])
    if s['kind'] == 'fixed':
        integrator = ps.integrator.runge_kutta_fixed_step(s['stepS'], ps.integrator.rkdp_87)
        margin = 8 * s['stepS']
    else:
        integrator = ps.integrator.runge_kutta_variable_step(
            s['initialStepS'], ps.integrator.rkdp_87,
            ps.integrator.step_size_control_elementwise_scalar_tolerance(s['relativeTolerance'], s['absoluteTolerance']),
            ps.integrator.step_size_validation(s['minStepS'], s['maxStepS']))
        margin = 8 * s['maxStepS']
    end = T0 + days * 86400
    termination = ps.propagator.time_termination(end + margin, terminate_exactly_on_final_condition=True)
    x0 = np.array(c['positionM'] + c['velocityMS'], dtype=float)
    propagator = ps.propagator.translational(['Earth'], models, ['Sat'], x0, T0, integrator, termination, ps.propagator.cowell)
    propagator.print_settings.print_dependent_variable_indices = False
    c0, w0 = time.process_time(), time.perf_counter()
    result = simulator.create_dynamics_simulator(bodies, propagator).propagation_results
    cpu, wall = time.process_time() - c0, time.perf_counter() - w0
    evaluations = None
    try:
        evaluations = int(list(result.cumulative_number_of_function_evaluations.values())[-1])
    except Exception:
        pass
    return cpu, wall, result.state_history, evaluations


results = []
for c in PLAN['cases']:
    if c['tier'] != 'COMMON' or (args.only and args.only not in c['id']):
        continue
    bodies = bodies_for(c)
    runs = {}
    for days in (1, PLAN['days']):
        best = None
        for _ in range(args.reps):
            r = propagate(c, bodies, days)
            if best is None or r[0] < best[0]:
                best = r
        runs[days] = best
    cpu1, cpu3 = runs[1][0], runs[PLAN['days']][0]
    per_day = (cpu3 - cpu1) / (PLAN['days'] - 1)
    history, evaluations = runs[PLAN['days']][2], runs[PLAN['days']][3]
    interpolation = interpolators.create_one_dimensional_vector_interpolator(history, interpolators.lagrange_interpolation(8))
    samples = []
    for offset in PLAN['sampleOffsetsS']:
        x = interpolation.interpolate(T0 + offset) if offset > 0 else np.array(c['positionM'] + c['velocityMS'])
        samples.append([offset, *[float(v) for v in x[:3]]])
    s = c['settings']
    method = ('rkdp_87 (RK8(7)13M) fixed %g s' % s['stepS']) if s['kind'] == 'fixed' else \
        ('rkdp_87 (RK8(7)13M) rel %g abs %g m, m/s, max step %g s; element-wise scalar tolerance (largest component of err/(abs + rel |y|))' % (s['relativeTolerance'], s['absoluteTolerance'], s['maxStepS']))
    row = {'engine': 'Tudat', 'id': c['id'], 'orbit': c['orbit'], 'regime': c['regime'], 'tier': c['tier'], 'integrator': c['integrator'], 'method': method,
           'cpuS1d': cpu1, 'cpuS3d': cpu3, 'wallS3d': runs[PLAN['days']][1], 'cpuSPerObjectDay': per_day, 'evaluations3d': evaluations, 'samples': samples}
    results.append(row)
    print('%s: %.4f CPU-s/object-day (1 d %.2f s, 3 d %.2f s, %s evaluations)' % (c['id'], per_day, cpu1, cpu3, evaluations), file=sys.stderr, flush=True)

doc = {'engine': 'Tudat', 'version': 'tudatpy %s' % tudatpy.__version__, 'runtime': 'Python %s, tudatpy native kernel, one thread' % sys.version.split()[0],
       'planSha256': hashlib.sha256(open(os.path.join(WORK, 'plan.json'), 'rb').read()).hexdigest(), 'reps': args.reps, 'results': results}
out = args.out or os.path.join(WORK, 'tudat.json')
open(out, 'w').write(json.dumps(doc) + '\n')
print('->', out, file=sys.stderr)
