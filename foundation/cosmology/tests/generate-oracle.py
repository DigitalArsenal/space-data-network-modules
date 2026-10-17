"""Independent E2E fixtures. Run with Astropy 7.2.0 + SciPy 1.17.0 in a scratch venv.

No module code is loaded. Distances are Planck18, measured today (a0=1), in Mpc
and Gyr; sky coordinates are the static Galactic/Supergalactic frames, radians.
Relative distance tolerance 1e-6 is the task requirement; angular 1e-9 rad is
well above floating point rotation error. CMB absolute tolerance 2e-12 tests
the published Lorentz law, not the uncertainty of the measured solar dipole.
"""
import json
from pathlib import Path
import numpy as np
import scipy
from scipy.optimize import brentq
import astropy
from astropy import units as u, constants as const
from astropy.coordinates import SkyCoord
from astropy.cosmology import Planck18


def distance_values(z):
    return {
        "comoving_distance_mpc": Planck18.comoving_distance(z).value.tolist(),
        "lookback_time_gyr": Planck18.lookback_time(z).value.tolist(),
        "light_travel_distance_mpc": (Planck18.lookback_time(z) * const.c).to_value(u.Mpc).tolist(),
        "luminosity_distance_mpc": Planck18.luminosity_distance(z).value.tolist(),
    }


def sky_values(l, b, d):
    sky = SkyCoord(l=l * u.rad, b=b * u.rad, distance=d * u.Mpc, frame="galactic").supergalactic
    # Direction is a separate input even at the origin; Astropy's zero-length
    # Cartesian representation otherwise discards its angles.
    direction = SkyCoord(l=l * u.rad, b=b * u.rad, frame="galactic").supergalactic
    return {
        "supergalactic_longitude_rad": direction.sgl.rad.tolist(),
        "supergalactic_latitude_rad": direction.sgb.rad.tolist(),
        "sgx_comoving_mpc": sky.cartesian.x.value.tolist(),
        "sgy_comoving_mpc": sky.cartesian.y.value.tolist(),
        "sgz_comoving_mpc": sky.cartesian.z.value.tolist(),
    }


z = np.unique(np.r_[0, np.geomspace(1e-10, 1100, 257), .004, .023, .048, .07804, .1, 1, 10, 100, 1100])
rng = np.random.default_rng(2018)
l = np.r_[np.deg2rad([0, 90, 180, 270, 137.37, 47.37]), rng.uniform(0, 2 * np.pi, 256)]
b = np.r_[np.deg2rad([90, -90, 0, 0, 0, 0]), np.arcsin(rng.uniform(-1, 1, 256))]
d = np.linspace(0, 14000, len(l))
apex = SkyCoord(l=264.021*u.deg, b=48.253*u.deg, frame="galactic")
cl = np.r_[apex.l.rad, (apex.l.rad + np.pi) % (2*np.pi), (apex.l.rad + np.pi/2) % (2*np.pi), l[:32]]
cb = np.r_[apex.b.rad, -apex.b.rad, 0, b[:32]]
cz = np.r_[0, 0, 0, np.linspace(-.001, 4, 32)]
directions = SkyCoord(l=cl*u.rad, b=cb*u.rad, frame="galactic")
beta = (369.82*u.km/u.s / const.c).decompose().value
factor = np.sqrt(1-beta**2) / (1-beta*np.cos(directions.separation(apex).rad))

# Published Tempel 2017 group 1, first five GalID rows from CDS J/A+A/602/A100.
group_l = np.deg2rad([206.201398985,206.193544660,206.116528794,206.043831309,206.129839415])
group_b = np.deg2rad([24.164140163,24.125508179,24.118609310,24.135811281,24.073488887])
group_z = [.101669636,.101815006,.102299513,.101154935,.099765387]
# CF4 table2: PGC 41361 (M87), DM=31.134, Vcmb=1608 km/s; PGC 44717,
# DM=35.016, Vcmb=7025 km/s, T17=1539. Values queried 2026-10-17.
cf4_dl = 10**((np.array([31.134,35.016])-25)/5)
cf4_z = [brentq(lambda zz: Planck18.luminosity_distance(zz).value-dl, 0, 2,
                xtol=1e-15) for dl in cf4_dl]
pl = np.r_[group_l, np.deg2rad([283.7775,61.8076]), 0, 0, 0]
pb = np.r_[group_b, np.deg2rad([74.4912,87.8069]), 0, 0, 0]
pz = np.r_[group_z, np.array([1608,7025])/const.c.to_value(u.km/u.s), .02, -.001, -.001]
pd = np.r_[np.zeros(5), cf4_dl, 0, cf4_dl[0], 0]
pid = [1]*5 + [0,1539,0,0,1]
pgz = [.10154690]*5 + [0,.024,0,0,.10154690]
selected_z = np.r_[[.10154690]*5, cf4_z, .02, cf4_z[0], .10154690]
placement_expected = distance_values(selected_z)
placement_expected.update(sky_values(pl,pb,Planck18.comoving_distance(selected_z).value))
placement_expected.update(placement_redshift_cmb=selected_z.tolist(),distance_source=[1]*5+[2,2,0,2,1])

result = {
    "oracle": {"astropy": astropy.__version__, "scipy": scipy.__version__, "cosmology": str(Planck18),
               "epoch": "a0=1; lookback from present; static Galactic and Supergalactic axes",
               "tolerance": {"distance_relative": 1e-6, "angle_rad": 1e-9, "cmb_absolute": 2e-12}},
    "cases": [
        {"name":"Planck18 grid", "method":"distances", "input":{"redshift_cmb":z.tolist()}, "expected":distance_values(z)},
        {"name":"SkyCoord supergalactic", "method":"supergalactic", "input":{"galactic_longitude_rad":l.tolist(),"galactic_latitude_rad":b.tolist(),"comoving_distance_mpc":d.tolist()}, "expected":sky_values(l,b,d)},
        {"name":"Planck solar dipole", "method":"cmb_redshift", "input":{"redshift_heliocentric":cz.tolist(),"galactic_longitude_rad":cl.tolist(),"galactic_latitude_rad":cb.tolist()}, "expected":{"redshift_cmb":((1+cz)*factor-1).tolist()}},
        {"name":"CF4 precedence and Tempel group collapse", "method":"place", "input":{"redshift_cmb":pz.tolist(),"galactic_longitude_rad":pl.tolist(),"galactic_latitude_rad":pb.tolist(),"cf4_luminosity_distance_mpc":pd.tolist(),"tempel2017_group_id":pid,"tempel2017_group_redshift_cmb":pgz}, "expected":placement_expected},
    ],
    "sources": [
        "https://docs.astropy.org/en/stable/api/astropy.cosmology.realizations.Planck18.html",
        "https://arxiv.org/abs/1807.06209",
        "https://arxiv.org/abs/1807.06205",
        "https://doi.org/10.1051/0004-6361/201321556",
        "https://cdsarc.cds.unistra.fr/ftp/J/A+A/602/A100/ReadMe",
        "https://cdsarc.cds.unistra.fr/ftp/J/ApJ/944/94/ReadMe",
    ],
}
Path(__file__).with_name("astropy-oracle.json").write_text(json.dumps(result,indent=2)+"\n")
print(f"Generated {len(z)} redshifts, {len(l)} directions, {len(cz)} dipole cases, {len(pz)} placements")
