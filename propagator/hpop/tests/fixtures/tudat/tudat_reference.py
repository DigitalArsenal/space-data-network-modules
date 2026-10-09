"""Tudat (tudatpy) reference trajectories for propagator/hpop.

Tudat (TU Delft, BSD-3-Clause), through the official tudatpy package from the
tudat-team conda channel, propagates the cross-validation cases
(../xval/xval-cases.json) from the Orekit file's initial GCRF states with the
Orekit file's constants and writes the states every hour for a day. HPOP's
tests replay the same initial states; nothing in the test run regenerates
this file.

    python tudat_reference.py <work dir> <out.json> [only]

Tudat reads its Earth orientation and space weather from fixed file names
under $HOME/.tudat/resource. This script builds such a tree in <work dir>
(links to the installed resources, except two directories it writes) and
points HOME there before tudatpy is imported:
  - earth_orientation/eopc04_14_IAU2000.62-now.txt: the installed file with
    the rows Orekit and HPOP read (../orekit/eop-2026-08.json: pole, UT1-UTC,
    LOD, dX, dY) in its IERS C04 layout, in place of rows it lacks (the
    installed file ends before 2026);
  - space_weather/sw19571001.txt: a CelesTrak-format file holding the
    Orekit file's constant space weather on every day (F10.7, its averages,
    observed and adjusted, 150; every Ap 15; every Kp 3o).
Everything else is set on the bodies:
  - Earth: GM 3.986004415e14 m^3/s^2 and the 20x20 field HPOP embeds
    (lib/egm2008_data.h, the numbers Orekit was given) at 6378136.3 m in ITRS,
    rotation IERS 2010 GCRS to ITRS (IAU 2006/2000A, CIO based) with those
    EOP; shape a sphere of 6378137 m (the shadow body), or for drag the WGS84
    ellipsoid (Tudat has one Earth shape, and occultation then uses its mean
    radius, 6371.0 km: see ../../../docs/cross-validation.md);
  - Sun and Moon: JPL DE440 (the repo's de440-2026.bsp) read through SPICE
    and tabulated every 60 s in GCRS axes (Tudat's "J2000" is the
    frame-biased EME2000 and would rotate DE440's ICRF axes by the bias), GM
    from the DE440 header as Orekit reads it, Sun radius 695 700 km,
    luminosity giving 1361 W/m^2 at 1 au;
  - spacecraft: 1000 kg, cannonball 20 m^2 with Cr 1.3, Cd 2.2, NRLMSISE-00.
The global frame is GCRS about the Earth, as Orekit's GCRF. Integration is
RKDP 8(7) with fixed steps on a TT clock (below); each UTC sample epoch is
converted by Tudat and the state there interpolated (Lagrange, 8 points)
from the steps.
"""
import datetime
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORK, OUT = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
ONLY = sys.argv[3] if len(sys.argv) > 3 else None
OREKIT = json.load(open(os.path.join(HERE, '../orekit/orekit-reference.json')))
EOP = json.load(open(os.path.join(HERE, '../orekit/eop-2026-08.json')))
LIST = json.load(open(os.path.join(HERE, '../xval/xval-cases.json')))['cases']
KERNEL = os.path.normpath(os.path.join(HERE, '../../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp'))
K = OREKIT['constants']
AU = 149597870700.0
AU3_DAY2 = AU ** 3 / 86400.0 ** 2
GM_SUN = 2.9591220828411951e-04 * AU3_DAY2
GM_MOON = 8.9970116036316091e-10 * AU3_DAY2 / (1 + 81.3005682214972154)
# Fixed steps: 10 s, or 1 s with radiation pressure, whose force has a kink
# at each penumbra boundary that fixed steps straddle (10 s left LEO400 F5
# 7 mm from its 5 s run, 1 s leaves it within 0.1 mm of 0.5 s).
STEP, STEP_SRP, OVERSAMPLE = float(os.environ.get('TUDAT_XVAL_STEP', '10')), float(os.environ.get('TUDAT_XVAL_STEP_SRP', '1')), 8


def resource_tree():
    """$HOME/.tudat/resource for this run: installed resources, two replaced."""
    installed = os.path.join(os.path.expanduser('~'), '.tudat', 'resource')
    home = os.path.join(WORK, 'home')
    tree = os.path.join(home, '.tudat', 'resource')
    os.makedirs(tree, exist_ok=True)
    for name in os.listdir(installed):
        link = os.path.join(tree, name)
        if name in ('earth_orientation', 'space_weather') or os.path.lexists(link):
            continue
        os.symlink(os.path.join(installed, name), link)
    # Earth orientation: the installed C04 file, the arc's rows replaced.
    eop_dir = os.path.join(tree, 'earth_orientation')
    os.makedirs(eop_dir, exist_ok=True)
    for name in os.listdir(os.path.join(installed, 'earth_orientation')):
        if name != 'eopc04_14_IAU2000.62-now.txt' and not os.path.lexists(os.path.join(eop_dir, name)):
            os.symlink(os.path.join(installed, 'earth_orientation', name), os.path.join(eop_dir, name))
    lines = open(os.path.join(installed, 'earth_orientation', 'eopc04_14_IAU2000.62-now.txt'), encoding='latin-1').read().split('\n')
    rows = {r['mjd']: r for r in EOP['rows']}
    kept = [l for l in lines if not (re.match(r'^\s*\d{4}\s+\d+\s+\d+\s+(\d{5})\s', l) and int(l.split()[3]) >= min(rows))]
    for mjd in sorted(rows):
        r, d = rows[mjd], datetime.date(1858, 11, 17) + datetime.timedelta(days=mjd)
        kept.append('%4d%4d%4d%7d%11.6f%11.6f%12.7f%12.7f%11.6f%11.6f%11.6f%11.6f%11.7f%11.7f%12.6f%12.6f' % (
            d.year, d.month, d.day, mjd, r['xPoleArcsec'], r['yPoleArcsec'], r['ut1MinusUtcS'], r['lodMs'] / 1000,
            r['dXMas'] / 1000, r['dYMas'] / 1000, 0, 0, 0, 0, 0, 0))
    open(os.path.join(eop_dir, 'eopc04_14_IAU2000.62-now.txt'), 'w').write('\n'.join(l for l in kept if l.strip() or l is kept[0]) + '\n')
    # Space weather: constant, CelesTrak layout (FORMAT(I4,I3,I3,I5,I3,8I3,I4,8I4,I4,F4.1,I2,I4,F6.1,I2,5F6.1)).
    sw_dir = os.path.join(tree, 'space_weather')
    os.makedirs(sw_dir, exist_ok=True)
    days = [datetime.date(2026, 4, 1) + datetime.timedelta(days=i) for i in range(214)]
    kp, ap, f = 30, int(K['ap']), K['f107']
    body = ['%4d%3d%3d%5d%3d%s%4d%s%4d%4.1f%2d%4d%6.1f%2d%6.1f%6.1f%6.1f%6.1f%6.1f' % (
        d.year, d.month, d.day, 0, 0, '%3d' % kp * 8, kp * 8, '%4d' % ap * 8, ap, 0.0, 0, 0, f, 0, K['f107a'], K['f107a'], f, K['f107a'], K['f107a']) for d in days]
    open(os.path.join(sw_dir, 'sw19571001.txt'), 'w').write('\n'.join([
        'DATATYPE CssiSpaceWeather', 'VERSION 1.2', '# Constant space weather of ../orekit/orekit-reference.json (tudat_reference.py)',
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

spice.load_kernel(KERNEL)
spice.load_kernel(os.path.join(os.environ['HOME'], '.tudat', 'resource', 'spice_kernels', 'naif0012.tls'))

coefficients = [tuple(map(float, m)) for m in re.findall(r'\{\s*(\d+),\s*(\d+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\}', open(os.path.join(HERE, '../../../lib/egm2008_data.h')).read())]
C, S = np.zeros((21, 21)), np.zeros((21, 21))
C[0, 0] = 1.0
for n, m, c, s in coefficients:
    if n <= 20:
        C[int(n), int(m)], S[int(n), int(m)] = c, s

converter = tr.default_time_scale_converter()


# Tudat's independent variable is TDB; Orekit, GMAT and HPOP integrate
# geocentric motion on TT (TAI). The rates differ by d(TDB-TT)/dt, 2.9e-10
# in August 2026, which alone moves LEO400 by 19 cm over the day (measured,
# TIME_ARGUMENT=TDB). So by default Tudat's clock is given TT: each UTC epoch
# becomes TT seconds since J2000. Tudat then reads the ephemerides and Earth
# rotation at TT instead of TDB, 0.75 ms apart on this arc (under 1 mm here;
# see ../../../docs/cross-validation.md).
TIME_ARGUMENT = os.environ.get('TIME_ARGUMENT', 'TT')


def tdb(iso):
    utc = tr.iso_string_to_epoch(iso)  # seconds since J2000, read as UTC
    return converter.convert_time(tr.utc_scale, tr.tt_scale if TIME_ARGUMENT == 'TT' else tr.tdb_scale, utc)


def clock_to_tdb(t):
    return converter.convert_time(tr.tt_scale, tr.tdb_scale, t) if TIME_ARGUMENT == 'TT' else t


def propagate(c):
    degree, drag = c['degree'], c['drag']
    t0 = tdb(c['samples'][0][7])
    t_end = tdb(c['samples'][-1][7])
    settings = es.BodyListSettings('Earth', 'GCRS')
    for body in ('Earth', 'Sun', 'Moon', 'Sat'):
        settings.add_empty_settings(body)
    earth = settings.get('Earth')
    earth.rotation_model_settings = es.rotation_model.gcrs_to_itrs(es.rotation_model.iau_2006, 'GCRS')
    earth.gravity_field_settings = (es.gravity_field.spherical_harmonic(K['gm'], K['fieldRadiusM'], C[:degree + 1, :degree + 1], S[:degree + 1, :degree + 1], 'ITRS')
                                    if degree > 0 else es.gravity_field.central(K['gm']))
    earth.shape_settings = es.shape.oblate_spherical(6378137.0, 1 / 298.257223563) if drag else es.shape.spherical(K['shadowRadiusM'])
    if drag:
        earth.atmosphere_settings = es.atmosphere.nrlmsise00()
    # DE440 tabulated every 60 s in GCRS axes (SPICE's J2000 is DE440's ICRF;
    # Tudat would rotate it by the frame bias if it were labelled J2000),
    # read at the true TDB of each point of Tudat's clock.
    grid = np.arange(t0 - 7200, t_end + 7200 + 60, 60.0)
    def table(target, observer):
        return {float(t): np.array(spice.get_body_cartesian_state_at_epoch(target, observer, 'J2000', 'NONE', clock_to_tdb(t))) for t in grid}
    earth.ephemeris_settings = es.ephemeris.tabulated(table('Earth', 'SSB'), 'SSB', 'GCRS')
    for body in ('Sun', 'Moon'):
        settings.get(body).ephemeris_settings = es.ephemeris.tabulated(table(body, 'Earth'), 'Earth', 'GCRS')
    settings.get('Sun').gravity_field_settings = es.gravity_field.central(GM_SUN)
    settings.get('Moon').gravity_field_settings = es.gravity_field.central(GM_MOON)
    settings.get('Sun').shape_settings = es.shape.spherical(695700e3)
    settings.get('Sun').radiation_source_settings = es.radiation_pressure.isotropic_radiation_source(
        es.radiation_pressure.irradiance_based_constant_luminosity(1361.0, AU))
    settings.get('Sat').constant_mass = K['massKg']
    if c['srp']:
        settings.get('Sat').radiation_pressure_target_settings = es.radiation_pressure.cannonball_radiation_target(K['areaM2'], K['cr'], {'Sun': ['Earth']})
    if drag:
        settings.get('Sat').aerodynamic_coefficient_settings = es.aerodynamic_coefficients.constant(K['areaM2'], [K['cd'], 0.0, 0.0])
    bodies = es.create_system_of_bodies(settings)

    earth_forces = [ps.acceleration.spherical_harmonic_gravity(degree, c['order'])] if degree > 0 else [ps.acceleration.point_mass_gravity()]
    if drag:
        earth_forces.append(ps.acceleration.aerodynamic())
    accelerations = {'Earth': earth_forces}
    if c['thirdBodies']:
        accelerations['Sun'] = [ps.acceleration.point_mass_gravity()]
        accelerations['Moon'] = [ps.acceleration.point_mass_gravity()]
    if c['srp']:
        accelerations.setdefault('Sun', []).append(ps.acceleration.radiation_pressure())
    models = ps.create_acceleration_models(bodies, {'Sat': accelerations}, ['Sat'], ['Earth'])
    x0 = np.array(c['samples'][0][1:7], dtype=float)
    step = STEP_SRP if c['srp'] else STEP
    integrator = ps.integrator.runge_kutta_fixed_step(step, ps.integrator.rkdp_87)
    termination = ps.propagator.time_termination(t_end + OVERSAMPLE * step, terminate_exactly_on_final_condition=True)
    propagator = ps.propagator.translational(['Earth'], models, ['Sat'], x0, t0, integrator, termination, ps.propagator.cowell)
    history = simulator.create_dynamics_simulator(bodies, propagator).propagation_results.state_history
    interpolator = interpolators.create_one_dimensional_vector_interpolator(history, interpolators.lagrange_interpolation(OVERSAMPLE))
    samples = []
    for s in c['samples']:
        x = interpolator.interpolate(tdb(s[7])) if s[0] > 0 else x0
        samples.append([s[0], *[round(float(v), 6) for v in x[:3]], *[round(float(v), 9) for v in x[3:]], s[7]])
    return samples


cases = []
for name in LIST:
    if ONLY and ONLY not in name:
        continue
    c = next(x for x in OREKIT['cases'] if f"{x['orbit']} {x['forces']}" == name)
    cases.append({k: c[k] for k in ('orbit', 'forces', 'degree', 'order', 'thirdBodies', 'srp', 'drag')} | {'samples': propagate(c)})
    print(name, 'done', file=sys.stderr)
doc = {
    'source': f'Tudat via tudatpy {tudatpy.__version__} (TU Delft, BSD-3-Clause; tudat-team conda channel), RKDP 8(7) fixed steps (10 s; 1 s with '
              'radiation pressure) on a TT clock, Lagrange-8 to the samples, GCRS axes about the Earth; Earth orientation IERS 2010 (IAU 2006/2000A, '
              'CIO) with the rows of ../orekit/eop-2026-08.json; Sun and Moon from DE440 (SPICE, tabulated in GCRS); NRLMSISE-00 with constant space weather',
    'epochUtc': OREKIT['epochUtc'],
    'constants': K | {'gmSunM3S2': GM_SUN, 'gmMoonM3S2': GM_MOON, 'sunRadiusM': 695700e3},
    'data': {name: hashlib.sha256(open(path, 'rb').read()).hexdigest() for name, path in (
        ('de440-2026.bsp', KERNEL),
        ('eopc04_14_IAU2000.62-now.txt (written)', os.path.join(os.environ['HOME'], '.tudat/resource/earth_orientation/eopc04_14_IAU2000.62-now.txt')),
        ('sw19571001.txt (written)', os.path.join(os.environ['HOME'], '.tudat/resource/space_weather/sw19571001.txt')))},
    'cases': cases,
}
text = json.dumps(doc, indent=1)
text = re.sub(r'\[\n\s+([^\[\]{}]*?)\n\s+\]', lambda m: '[' + re.sub(r'\n\s+', ' ', m.group(1)) + ']', text)
open(OUT, 'w').write(text + '\n')
