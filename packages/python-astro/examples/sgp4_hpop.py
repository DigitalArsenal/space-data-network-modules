import numpy as np
from spacedatanetwork_astro import sgp4, hpop
# Vallado verification satellite; OMM angles are degrees, motion rev/day.
omm = dict(NORAD_CAT_ID=5, OBJECT_NAME="Vallado", OBJECT_ID="1958-002B",
           EPOCH="2000-06-27T18:50:19.733568", MEAN_MOTION=10.82419157,
           ECCENTRICITY=0.1859667, INCLINATION=34.2682,
           RA_OF_ASC_NODE=348.7242, ARG_OF_PERICENTER=331.7664,
           MEAN_ANOMALY=19.3264, BSTAR=0.000028098,
           MEAN_MOTION_DOT=0.00000023, MEAN_MOTION_DDOT=0.0)
# SGP4 returns ECEF metres and metres/second.
ecef = sgp4(omm, [2451726.28495062])
print("SGP4 ECEF [m, m/s]:", ecef[0])
# Separate inertial state from the Tudat fixture; HPOP epoch is JD TDB.
r_km = np.array([6993.000000000001, 0., 0.])
v_km_s = np.array([0., 5.3412039886853915, 5.341203988685391])
epoch_jd = 2451545.0
state = hpop(r_km, v_km_s, epoch_jd, epoch_jd + 1170. / 86400.)
print("HPOP inertial [km]:", state.position)
print("HPOP inertial [km/s]:", state.velocity)
assert np.isfinite(state.position).all()
