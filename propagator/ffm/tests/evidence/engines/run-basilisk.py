"""Basilisk (AVS Lab, ISC) on the engine benchmark plan's COMMON tier.

Basilisk's own simulation loop, configured the way its examples run a
full-force orbit: one task whose rate is the plan's step (fixed tier) or
maximum step (adaptive tiers), and every module native C++:
  - SpiceInterface: Sun, Moon and the Earth from the plan's DE440 kernel, the
    Earth's orientation from NAIF's ITRF93 high-precision BPC;
  - Spacecraft with svIntegratorRKF78 (Fehlberg 7(8), FFM's RK78 tableau);
    Basilisk adapts the step inside each task interval;
  - gravityEffector: FFM's EGM2008 70x70 (Basilisk's JPL CSV layout), Sun and
    Moon point masses with the DE440 header GMs;
  - RadiationPressure (cannonball) with Eclipse (conical shadow of a
    6378137 m sphere), the plan's Cr converted to Basilisk's irradiance and
    AU constants (tests/evidence/basilisk/basilisk-backend.py);
  - MsisAtmosphere (NRLMSISE-00) on constant space weather, ZeroWindModel
    (co-rotating air), DragDynamicEffector.
Environment messages (ephemerides, orientation, shadow, density, wind) are
Basilisk's: computed at the task rate and held across it. That is Basilisk's
design and part of what is measured; tests/evidence/basilisk documents the
accuracy-oriented adapter used for cross-validation instead.

    python -I run-basilisk.py <work dir> [--only TEXT] [--reps 1] [--out basilisk.json] [--scratch dir]

Timing: process CPU time over ExecuteSimulation for 1 day and for 3 days;
the cost per object-day is their difference over two days.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('work')
parser.add_argument('--only')
parser.add_argument('--reps', type=int, default=1)
parser.add_argument('--out')
parser.add_argument('--scratch', help='directory for the written field file (default <work>)')
parser.add_argument('--fixed-task', type=float, help='fixed tier: run at this task rate (s) instead of the plan step, labeled fixed-<s>s')
parser.add_argument('--support', default='/Users/tj/software/tools/xval/bsk-data/supportData')
parser.add_argument('--bpc', default='/Users/tj/software/tools/xval/naif-kernels/earth_latest_high_prec.bpc')
args = parser.parse_args()
for key in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[key] = '1'
WORK = Path(args.work).resolve()
PLAN = json.loads((WORK / 'plan.json').read_text())
K, SC, SW = PLAN['constants'], PLAN['spacecraft'], PLAN['spaceWeather']
HERE = Path(__file__).resolve().parent

from Basilisk.architecture import messaging, astroConstants  # noqa: E402
from Basilisk.utilities import SimulationBaseClass, macros  # noqa: E402
from Basilisk.simulation import (spacecraft, gravityEffector, svIntegrators, spiceInterface, radiationPressure,  # noqa: E402
                                 eclipse, msisAtmosphere, dragDynamicEffector, zeroWindModel)
import Basilisk  # noqa: E402

AU3_DAY2 = K['auM'] ** 3 / 86400.0 ** 2
GM_SUN = 2.9591220828411951e-04 * AU3_DAY2
GM_MOON = 8.9970116036316091e-10 * AU3_DAY2 / (1 + 81.3005682214972154)


def gravity_file(degree):
    coefficients = {(int(n), int(m)): (a, b) for n, m, a, b in re.findall(
        r'\{\s*(\d+),\s*(\d+),\s*([-+\d.eE]+),\s*([-+\d.eE]+)\s*\}', (HERE / '../../../lib/egm2008_data.h').read_text())}
    out = (Path(args.scratch) if args.scratch else WORK) / f'basilisk-EGM2008-{degree}.csv'
    out.parent.mkdir(parents=True, exist_ok=True)
    rows = [f"{K['fieldRadiusM']:.17g},{K['earthGmM3S2']:.17g},0,{degree},{degree},1,0,0"]
    for n in range(degree + 1):
        for m in range(n + 1):
            a, b = coefficients.get((n, m), ('1' if n == 0 else '0', '0'))
            rows.append(f'{n},{m},{a},{b},0,0')
    out.write_text('\n'.join(rows) + '\n')
    return str(out)


def run(c, days):
    f, s = c['forces'], c['settings']
    task_s = (args.fixed_task or s['stepS']) if s['kind'] == 'fixed' else s['maxStepS']
    sim = SimulationBaseClass.SimBaseClass()
    process = sim.CreateNewProcess('dynamics')
    process.addTask(sim.CreateNewTask('task', macros.sec2nano(task_s)))
    keep = []
    spice = spiceInterface.SpiceInterface()
    spice.ModelTag = 'spice'
    spice.addKernelPaths([PLAN['data']['kernel']['path'], str(Path(args.support) / 'EphemerisData/naif0012.tls'), args.bpc])
    spice.addPlanetNames(['earth', 'sun', 'moon'])
    spice.planetFrames = ['ITRF93', '', '']
    spice.referenceBase, spice.zeroBase = 'J2000', 'earth'
    spice.UTCCalInit = PLAN['epochUtc']
    sim.AddModelToTask('task', spice, 100)
    earth_msg, sun_msg, moon_msg = spice.planetStateOutMsgs[0], spice.planetStateOutMsgs[1], spice.planetStateOutMsgs[2]

    earth = gravityEffector.GravBodyData()
    earth.planetName = 'earth'
    earth.isCentralBody = True
    earth.mu = K['earthGmM3S2']
    earth.radEquator = K['fieldRadiusM']
    earth.useSphericalHarmonicsGravityModel(gravity_file(f['gravity']['degree']), f['gravity']['degree'])
    earth.planetBodyInMsg.subscribeTo(earth_msg)
    bodies = [earth]
    for name, mu, msg in (('sun', GM_SUN, sun_msg), ('moon', GM_MOON, moon_msg)):
        body = gravityEffector.GravBodyData()
        body.planetName = name
        body.mu = mu
        body.planetBodyInMsg.subscribeTo(msg)
        bodies.append(body)

    sc = spacecraft.Spacecraft()
    sc.ModelTag = 'sat'
    sc.pointMassTranslationalOnly = True
    sc.hub.mHub = SC['massKg']
    sc.hub.r_CN_NInit = c['positionM']
    sc.hub.v_CN_NInit = c['velocityMS']
    sc.gravField.gravBodies = gravityEffector.GravBodyVector(bodies)
    integrator = svIntegrators.svIntegratorRKF78(sc)
    if s['kind'] == 'fixed':
        integrator.relTol, integrator.absTol = 1e3, 1e3
    else:
        integrator.relTol, integrator.absTol = s['relativeTolerance'], s['absoluteTolerance']
    sc.setIntegrator(integrator)
    keep.append(integrator)

    if f['srp']:
        srp = radiationPressure.RadiationPressure()
        srp.ModelTag = 'srp'
        srp.setUseCannonballModel()
        srp.area = SC['areaM2']
        srp.coefficientReflection = (SC['cr'] * K['solarPressureAt1AuNm2'] / (astroConstants.SOLAR_FLUX_EARTH / astroConstants.SPEED_LIGHT)
                                     * (K['auM'] / (astroConstants.AU * 1000)) ** 2)
        srp.sunEphmInMsg.subscribeTo(sun_msg)
        shadow = eclipse.Eclipse()
        shadow.ModelTag = 'eclipse'
        shadow.rEqCustom = K['shadowBodyRadiusM']
        shadow.sunInMsg.subscribeTo(sun_msg)
        shadow.addPlanetToModel(earth_msg)
        shadow.addSpacecraftToModel(sc.scStateOutMsg)
        srp.sunEclipseInMsg.subscribeTo(shadow.eclipseOutMsgs[0])
        sc.addDynamicEffector(srp)
        sim.AddModelToTask('task', shadow, 90)
        sim.AddModelToTask('task', srp, 80)
        keep += [srp, shadow]
    if f['drag']:
        atmosphere = msisAtmosphere.MsisAtmosphere()
        atmosphere.ModelTag = 'msis'
        atmosphere.planetRadius = K['wgs84']['equatorialRadiusM']
        atmosphere.planetPosInMsg.subscribeTo(earth_msg)
        atmosphere.addSpacecraftToModel(sc.scStateOutMsg)
        epoch = messaging.EpochMsgPayload()
        epoch.year, epoch.month, epoch.day, epoch.hours, epoch.minutes, epoch.seconds = 2026, 8, 2, 0, 0, 0.0
        epoch_msg = messaging.EpochMsg().write(epoch)
        atmosphere.epochInMsg.subscribeTo(epoch_msg)
        weather = [SW['ap']] * 21 + [SW['f107a'], SW['f107']]
        sw_msgs = []
        for index, value in enumerate(weather):
            payload = messaging.SwDataMsgPayload()
            payload.dataValue = value
            msg = messaging.SwDataMsg().write(payload)
            atmosphere.swDataInMsgs[index].subscribeTo(msg)
            sw_msgs.append(msg)
        wind = zeroWindModel.ZeroWindModel()
        wind.ModelTag = 'wind'
        wind.planetPosInMsg.subscribeTo(earth_msg)
        wind.addSpacecraftToModel(sc.scStateOutMsg)
        drag = dragDynamicEffector.DragDynamicEffector()
        drag.ModelTag = 'drag'
        drag.coreParams.projectedArea = SC['areaM2']
        drag.coreParams.dragCoeff = SC['cd']
        drag.atmoDensInMsg.subscribeTo(atmosphere.envOutMsgs[0])
        drag.windVelInMsg.subscribeTo(wind.envOutMsgs[0])
        sc.addDynamicEffector(drag)
        sim.AddModelToTask('task', atmosphere, 70)
        sim.AddModelToTask('task', wind, 60)
        sim.AddModelToTask('task', drag, 50)
        keep += [atmosphere, wind, drag, epoch_msg, sw_msgs]
    sim.AddModelToTask('task', sc, 10)
    recorder = sc.scStateOutMsg.recorder(macros.sec2nano(PLAN['sampleStepS']))
    sim.AddModelToTask('task', recorder)
    sim.InitializeSimulation()
    sim.ConfigureStopTime(macros.sec2nano(days * 86400))
    c0, w0 = time.process_time(), time.perf_counter()
    sim.ExecuteSimulation()
    cpu, wall = time.process_time() - c0, time.perf_counter() - w0
    t = [x * 1e-9 for x in recorder.times()]
    r = recorder.r_BN_N
    return cpu, wall, [[float(t[i]), *[float(v) for v in r[i]]] for i in range(len(t))]


results = []
for c in PLAN['cases']:
    if c['tier'] != 'COMMON' or (args.only and args.only not in c['id']):
        continue
    runs = {}
    for days in (1, PLAN['days']):
        best = None
        for _ in range(args.reps):
            r = run(c, days)
            if best is None or r[0] < best[0]:
                best = r
        runs[days] = best
    cpu1, cpu3 = runs[1][0], runs[PLAN['days']][0]
    per_day = (cpu3 - cpu1) / (PLAN['days'] - 1)
    samples = runs[PLAN['days']][2]
    if [round(x[0]) for x in samples] != PLAN['sampleOffsetsS']:
        raise RuntimeError(f"{c['id']}: sample times {[x[0] for x in samples[:3]]}...")
    s = c['settings']
    task = args.fixed_task or s.get('stepS')
    method = (f"svIntegratorRKF78 (Fehlberg 7(8)) one step per {task:g} s task; Earth orientation, ephemerides, shadow and density held or linearly extrapolated across the task" if s['kind'] == 'fixed' else
              f"svIntegratorRKF78 (Fehlberg 7(8)) rel {s['relativeTolerance']:g} abs {s['absoluteTolerance']:g}, task (environment and maximum step) {s['maxStepS']:g} s")
    label = f"fixed-{args.fixed_task:g}s" if (s['kind'] == 'fixed' and args.fixed_task) else c['integrator']
    results.append({'engine': 'Basilisk', 'id': c['id'].replace(c['integrator'], label), 'orbit': c['orbit'], 'regime': c['regime'], 'tier': c['tier'], 'integrator': label,
                    'method': method, 'cpuS1d': cpu1, 'cpuS3d': cpu3, 'wallS3d': runs[PLAN['days']][1], 'cpuSPerObjectDay': per_day, 'samples': samples})
    print(f"{c['id']}: {per_day:.4f} CPU-s/object-day (1 d {cpu1:.2f} s, 3 d {cpu3:.2f} s)", file=sys.stderr, flush=True)

doc = {'engine': 'Basilisk', 'version': f'Basilisk {Basilisk.__version__}', 'runtime': f'Python {sys.version.split()[0]}, Basilisk native modules, one thread',
       'planSha256': hashlib.sha256((WORK / 'plan.json').read_bytes()).hexdigest(), 'reps': args.reps, 'results': results}
out = Path(args.out) if args.out else WORK / 'basilisk.json'
out.write_text(json.dumps(doc) + '\n')
print('->', out, file=sys.stderr)
