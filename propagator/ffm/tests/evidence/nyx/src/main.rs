//! Nyx Space on the FFM reference cases (run-nyx.mjs writes the input, builds
//! and runs this program; make-itrf-bpc.mjs uses its "et" and "rotation"
//! modes, check-density.mjs its "density" mode). A test oracle only.
//!
//! stdin {"mode": "propagate" | "et" | "rotation" | "density", ...}
//!
//! propagate: {"kernel", "pca", "bpc", "gmKm3S2", "occultingRadiusKm",
//!   "sunRadiusKm", "sunGmKm3S2", "moonGmKm3S2", "fluxWm2", "tolerance",
//!   "maxStepS", "cases": [{"id", "state": [km, km/s], "epochs": [UTC ISO],
//!   "offsets": [s], "massKg", "field": null | {"cof", "degree", "order",
//!   "radiusKm"}, "thirdBodies": bool, "srp": null | {"cr", "areaM2"},
//!   "drag": null | {"cd", "areaM2", "weather": {"f107", "ap", "kp"} |
//!   {"csv"}, "rateM2KgS": null | x}, "inTrackMS2": null | x, "relativity":
//!   "none" | "schwarzschild" | "iers2010", "stm": bool}]}
//!   -> {"cases": [{"id", "samples": [[t, x, y, z, vx, vy, vz]], "stm":
//!   [9x9 row-major per sample] | null}]} in km, km/s.
//! et: {"utc": [ISO]} -> {"et": [hifitime ET seconds past J2000]}
//! rotation: {"pca", "bpc", "et": [s]} -> {"c2t": [J2000 -> ITRF93 row-major]}
//! geodetic: {"kernel", "pca", "bpc", "states": [{"utc", "state": [km, km/s]}]}
//!   -> {"rows": [{"latDeg", "lonDeg", "altKm", "r", "v" (ITRF93), "semiMajorKm",
//!   "polarKm"}]}: the ITRF93 state and ellipsoid the drag model sees
//! density: {"points": [{"utc", "latDeg", "lonDeg", "altKm", "f107", "f107a",
//!   "ap"}]} -> {"density": [{"rho" kg/m^3, "tExo", "tAlt" K, number densities
//!   per cm^3 by species}]} (Nyx's NRLMSISE-00 on mean solar time)
use std::fmt;
use std::io::Read;
use std::str::FromStr;
use std::sync::Arc;

use anise::constants::celestial_objects::{EARTH, MOON, SUN};
use anise::constants::frames::{EARTH_ITRF93, EARTH_J2000};
use anise::prelude::Almanac;
use anise::structure::planetocentric::ellipsoid::Ellipsoid;
use hifitime::{Epoch, TimeScale, Unit};
use nyx_space::cosmic::eclipse::ShadowModel;
use nyx_space::cosmic::{DragData, Mass, Orbit, SRPData, Spacecraft};
use nyx_space::dynamics::nrlmsise00::{Nrlmsise00Flags, msise00_density};
use nyx_space::dynamics::{AccelModel, AtmDensity, Drag, DynamicsError, ForceModel, GravityField, OrbitalDynamics, SolarPressure, SpacecraftDynamics};
use nyx_space::io::gravity::GravityFieldData;
use nyx_space::io::space_weather::{Msise00DailyWeather, SpaceWeatherData, StaticSpaceWeather};
use nyx_space::linalg::{Matrix3, Matrix4x3, Vector3};
use nyx_space::propagators::{ErrorControl, IntegratorOptions, Propagator};
use nyx_space::State;
use serde_json::{Value, json};

const C_KM_S: f64 = 299_792.458;
/// IERS 2010 section 10.3: the Earth's angular momentum per unit mass, km^2/s.
const EARTH_J_KM2_S: f64 = 9.8e2;

/// Central differences of an acceleration in position (for the STM).
fn position_gradient(osc: &Orbit, f: impl Fn(&Orbit) -> Result<Vector3<f64>, DynamicsError>) -> Result<Matrix3<f64>, DynamicsError> {
    let mut grad = Matrix3::zeros();
    for j in 0..3 {
        let h = 6.0e-6 * osc.radius_km[j].abs().max(1.0);
        let (mut p, mut m) = (*osc, *osc);
        p.radius_km[j] += h;
        m.radius_km[j] -= h;
        let d = (f(&p)? - f(&m)?) / (2.0 * h);
        for i in 0..3 {
            grad[(i, j)] = d[i];
        }
    }
    Ok(grad)
}

/// IERS Conventions 2010 eq. 10.12 with beta = gamma = 1: Schwarzschild and,
/// with `full`, Lense-Thirring about the Earth-fixed z axis (ITRF93 from the
/// loaded BPC) and de Sitter with the Earth's heliocentric state from DE440.
/// Written here because Nyx 2.6.0 has no relativistic terms.
struct Relativity {
    gm: f64,
    sun_gm: f64,
    full: bool,
}
impl fmt::Display for Relativity {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "IERS 2010 relativity (full: {})", self.full)
    }
}
impl AccelModel for Relativity {
    fn eom(&self, osc: &Orbit, almanac: &Almanac) -> Result<Vector3<f64>, DynamicsError> {
        let (r, v) = (osc.radius_km, osc.velocity_km_s);
        let rm = r.norm();
        let c2 = C_KM_S * C_KM_S;
        let k = self.gm / (c2 * rm.powi(3));
        let mut a = r * ((4.0 * self.gm / rm - v.norm_squared()) * k) + v * (4.0 * r.dot(&v) * k);
        if self.full {
            let dcm = almanac.rotate(osc.frame.with_orient(EARTH_ITRF93.orientation_id), osc.frame, osc.epoch)
                .map_err(|_| DynamicsError::MasslessSpacecraft)?;
            let spin = dcm.rot_mat * Vector3::new(0.0, 0.0, 1.0);
            a += (r.cross(&v) * (3.0 * r.dot(&spin) / (rm * rm)) + v.cross(&spin)) * (2.0 * self.gm * EARTH_J_KM2_S / (c2 * rm.powi(3)));
            let sun = almanac.translate(osc.frame.with_ephem(SUN), osc.frame, osc.epoch, None)
                .map_err(|_| DynamicsError::MasslessSpacecraft)?;
            let (rs, vs) = (sun.radius_km, sun.velocity_km_s);
            let a_earth = rs * (self.sun_gm / rs.norm().powi(3));
            a += (-vs).cross(&a_earth).cross(&v) * (3.0 / c2);
        }
        Ok(a)
    }
    fn gradient(&self, osc: &Orbit, almanac: &Almanac) -> Result<(Vector3<f64>, Matrix3<f64>), DynamicsError> {
        Ok((self.eom(osc, almanac)?, position_gradient(osc, |o| self.eom(o, almanac))?))
    }
}

/// A constant acceleration along QSW's S axis (N x r-hat), as the Orekit
/// reference's ParametricAcceleration on a QSW attitude. Not in Nyx 2.6.0.
struct InTrack {
    a_km_s2: f64,
}
impl fmt::Display for InTrack {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "in-track {} km/s^2", self.a_km_s2)
    }
}
impl AccelModel for InTrack {
    fn eom(&self, osc: &Orbit, _: &Almanac) -> Result<Vector3<f64>, DynamicsError> {
        let (r, v) = (osc.radius_km, osc.velocity_km_s);
        let n = r.cross(&v).normalize();
        Ok(n.cross(&r.normalize()) * self.a_km_s2)
    }
    fn gradient(&self, osc: &Orbit, almanac: &Almanac) -> Result<(Vector3<f64>, Matrix3<f64>), DynamicsError> {
        Ok((self.eom(osc, almanac)?, position_gradient(osc, |o| self.eom(o, almanac))?))
    }
}

/// Nyx's drag with Cd*A/m growing at a constant rate from the epoch, as the
/// Orekit reference's RateDrag (b = Cd*A/m + rate * (t - t0)). Drag is linear
/// in Cd*A/m, so Nyx's acceleration is scaled by b(t) / b(t0).
struct RateDrag {
    drag: Drag,
    t0: Epoch,
    rate: f64,
    b0: f64,
}
impl fmt::Display for RateDrag {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{} with Cd*A/m rate {}", self.drag, self.rate)
    }
}
impl RateDrag {
    fn scale(&self, ctx: &Spacecraft) -> f64 {
        1.0 + self.rate * (ctx.orbit.epoch - self.t0).to_seconds() / self.b0
    }
}
impl ForceModel for RateDrag {
    fn estimation_index(&self) -> Option<usize> {
        self.drag.estimation_index()
    }
    fn eom(&self, ctx: &Spacecraft, almanac: &Almanac) -> Result<Vector3<f64>, DynamicsError> {
        Ok(self.drag.eom(ctx, almanac)? * self.scale(ctx))
    }
    fn gradient(&self, ctx: &Spacecraft, almanac: &Almanac) -> Result<(Vector3<f64>, Matrix4x3<f64>), DynamicsError> {
        // Position partials scale with b(t); the Cd partial is d(b)/d(Cd) =
        // A/m times the rest, which is Nyx's unscaled Cd partial.
        let (f, mut g) = self.drag.gradient(ctx, almanac)?;
        let k = self.scale(ctx);
        for i in 0..3 {
            for j in 0..3 {
                g[(i, j)] *= k;
            }
        }
        Ok((f * k, g))
    }
}

fn wgs84() -> Ellipsoid {
    Ellipsoid::from_spheroid(6378.137, 6378.137 * (1.0 - 1.0 / 298.257223563))
}

fn epoch_utc(s: &str) -> Epoch {
    Epoch::from_str(&format!("{s} UTC")).unwrap()
}

fn almanac(input: &Value) -> Result<Almanac, Box<dyn std::error::Error>> {
    let mut almanac = Almanac::default();
    for key in ["kernel", "pca", "bpc"] {
        if let Some(path) = input[key].as_str() {
            almanac = almanac.load(path)?;
        }
    }
    // The case export's constants in the almanac's planetary data, which
    // ANISE reads whenever it rebuilds a frame (transform_to gives the drag
    // model's ITRF93 state pck08's 6378.14 x 6356.75 km Earth otherwise): the
    // Earth's GM and WGS84 ellipsoid, the Sun's and Moon's GMs (DE440 header)
    // and the Sun's radius.
    for data in almanac.planetary_data.values_mut() {
        for (id, gm) in [(EARTH, input["gmKm3S2"].as_f64()), (SUN, input["sunGmKm3S2"].as_f64()), (MOON, input["moonGmKm3S2"].as_f64())] {
            if let (Ok(mut datum), Some(gm)) = (data.get_by_id(id), gm) {
                datum.mu_km3_s2 = gm;
                if id == EARTH {
                    datum.shape = Some(wgs84());
                }
                if id == SUN {
                    if let Some(r) = input["sunRadiusKm"].as_f64() {
                        datum.shape = Some(Ellipsoid::from_sphere(r));
                    }
                }
                data.set_by_id(id, datum)?;
            }
        }
    }
    Ok(almanac)
}

fn propagate(input: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let f = |k: &str| input[k].as_f64().unwrap();
    let almanac = Arc::new(almanac(input)?);
    // Integration frame: SPICE J2000 (DE440's ICRF axes) about the Earth with
    // the cases' GM; for the shadow, the Earth a sphere of the cases' radius.
    let mut eme = almanac.frame_info(EARTH_J2000)?;
    eme.shape = Some(Ellipsoid::from_sphere(f("occultingRadiusKm")));
    // Earth-fixed frame: ITRF93 from the loaded BPC, the WGS84 ellipsoid.
    let itrf = almanac.frame_info(EARTH_ITRF93)?;

    let mut out = vec![];
    for c in input["cases"].as_array().unwrap() {
        let x: Vec<f64> = c["state"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let epochs: Vec<Epoch> = c["epochs"].as_array().unwrap().iter().map(|v| epoch_utc(v.as_str().unwrap())).collect();
        let offsets: Vec<f64> = c["offsets"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let stm = c["stm"].as_bool().unwrap_or(false);

        let mut orbital = OrbitalDynamics::point_masses(if c["thirdBodies"].as_bool().unwrap() { vec![SUN, MOON] } else { vec![] });
        if let Some(field) = c["field"].as_object() {
            let mut data = GravityFieldData::from_cof(field["cof"].as_str().unwrap(), field["degree"].as_u64().unwrap() as usize,
                field["order"].as_u64().unwrap() as usize, itrf)?;
            data.mu_km3_s2 = Some(f("gmKm3S2"));
            data.radius_km = Some(field["radiusKm"].as_f64().unwrap());
            orbital.accel_models.push(GravityField::new(data));
        }
        match c["relativity"].as_str().unwrap_or("none") {
            "none" => {}
            r => orbital.accel_models.push(Arc::new(Relativity { gm: f("gmKm3S2"), sun_gm: f("sunGmKm3S2"), full: r == "iers2010" })),
        }
        if let Some(a) = c["inTrackMS2"].as_f64() {
            orbital.accel_models.push(Arc::new(InTrack { a_km_s2: a / 1000.0 }));
        }

        let srp = c["srp"].as_object();
        let drag = c["drag"].as_object();
        let mut sc = Spacecraft::builder()
            .orbit(Orbit::new(x[0], x[1], x[2], x[3], x[4], x[5], epochs[0], eme))
            .mass(Mass::from_dry_mass(c["massKg"].as_f64().unwrap()))
            .srp(SRPData { area_m2: srp.map_or(0.0, |s| s["areaM2"].as_f64().unwrap()), coeff_reflectivity: srp.map_or(1.0, |s| s["cr"].as_f64().unwrap()) })
            .drag(DragData { area_m2: drag.map_or(0.0, |d| d["areaM2"].as_f64().unwrap()), coeff_drag: drag.map_or(2.2, |d| d["cd"].as_f64().unwrap()) })
            .build();
        let mut forces: Vec<Arc<dyn ForceModel>> = vec![];
        if srp.is_some() {
            forces.push(Arc::new(SolarPressure {
                phi: f("fluxWm2"),
                shadow_model: ShadowModel { light_source: almanac.frame_info(anise::constants::frames::SUN_J2000)?, shadow_bodies: vec![eme], correction: None },
                estimate: stm,
            }));
        }
        if let Some(d) = drag {
            let w = &d["weather"];
            let weather = if let Some(csv) = w["csv"].as_str() {
                SpaceWeatherData::from_csv_file(csv, StaticSpaceWeather::default())?
            } else {
                SpaceWeatherData::from_static_weather(StaticSpaceWeather::Custom {
                    f107: w["f107"].as_f64().unwrap(), ap: w["ap"].as_f64().unwrap(), kp: w["kp"].as_f64().unwrap() })
            };
            // Nyx's defaults: NRLMSISE-00 on mean local solar time, daily Ap.
            let model = Drag { density: AtmDensity::NRLMSISE00 { weather, flags: None }, frame: itrf, estimate: stm };
            match d["rateM2KgS"].as_f64() {
                Some(rate) => forces.push(Arc::new(RateDrag {
                    t0: epochs[0], rate, b0: d["cd"].as_f64().unwrap() * d["areaM2"].as_f64().unwrap() / c["massKg"].as_f64().unwrap(), drag: model })),
                None => forces.push(Arc::new(model)),
            }
        }
        if stm {
            sc.enable_stm();
        }
        let dynamics = SpacecraftDynamics::from_models(orbital, forces);
        let opts = IntegratorOptions::with_adaptive_step_s(1e-3, f("maxStepS"), f("tolerance"), ErrorControl::RSSCartesianStep);
        let propagator = Propagator::rk89(dynamics, opts);
        let mut state = sc;
        let (mut samples, mut stms) = (vec![], vec![]);
        for (i, epoch) in epochs.iter().enumerate() {
            if i > 0 {
                state = propagator.with(state, almanac.clone()).until_epoch(*epoch)?;
            }
            assert!((state.orbit.epoch - *epoch).abs() < Unit::Microsecond * 1);
            let (r, v) = (state.orbit.radius_km, state.orbit.velocity_km_s);
            samples.push(json!([offsets[i], r.x, r.y, r.z, v.x, v.y, v.z]));
            if stm {
                let m = state.stm()?;
                stms.push(json!((0..9).flat_map(|i| (0..9).map(move |j| (i, j))).map(|(i, j)| m[(i, j)]).collect::<Vec<f64>>()));
            }
        }
        eprintln!("{} done", c["id"].as_str().unwrap());
        out.push(json!({"id": c["id"], "samples": samples, "stm": if stm { json!(stms) } else { Value::Null }}));
    }
    // The GMs and radii the dynamics read, for the record.
    let sun = almanac.frame_info(anise::constants::frames::SUN_J2000)?;
    let moon = almanac.frame_info(anise::constants::frames::MOON_J2000)?;
    Ok(json!({"cases": out, "constants": {"sunGmKm3S2": sun.mu_km3_s2()?, "sunRadiusKm": sun.mean_equatorial_radius_km()?,
        "moonGmKm3S2": moon.mu_km3_s2()?}}))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    let input: Value = serde_json::from_str(&text)?;
    let out = match input["mode"].as_str().unwrap_or("propagate") {
        "et" => json!({"et": input["utc"].as_array().unwrap().iter().map(|u| epoch_utc(u.as_str().unwrap()).to_et_seconds()).collect::<Vec<f64>>()}),
        "rotation" => {
            let almanac = almanac(&input)?;
            let mut c2t = vec![];
            for et in input["et"].as_array().unwrap() {
                let m = almanac.rotate(EARTH_J2000, EARTH_ITRF93, Epoch::from_et_seconds(et.as_f64().unwrap()))?.rot_mat;
                c2t.push((0..3).flat_map(|i| (0..3).map(move |j| (i, j))).map(|(i, j)| m[(i, j)]).collect::<Vec<f64>>());
            }
            json!({"c2t": c2t})
        }
        "geodetic" => {
            // How the drag model sees a GCRF state: the ITRF93 state ANISE
            // gives (transform_to the drag frame) and the ellipsoid it carries.
            let almanac = almanac(&input)?;
            let eme = almanac.frame_info(EARTH_J2000)?;
            let itrf = almanac.frame_info(EARTH_ITRF93)?;
            let mut rows = vec![];
            for p in input["states"].as_array().unwrap() {
                let x: Vec<f64> = p["state"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
                let orbit = Orbit::new(x[0], x[1], x[2], x[3], x[4], x[5], epoch_utc(p["utc"].as_str().unwrap()), eme);
                let o = almanac.transform_to(orbit, itrf, None)?;
                let shape = o.frame.shape.unwrap();
                let (lat, lon, alt) = o.latlongalt()?;
                rows.push(json!({"latDeg": lat, "lonDeg": lon, "altKm": alt, "r": [o.radius_km.x, o.radius_km.y, o.radius_km.z],
                    "v": [o.velocity_km_s.x, o.velocity_km_s.y, o.velocity_km_s.z], "semiMajorKm": shape.semi_major_equatorial_radius_km, "polarKm": shape.polar_radius_km}));
            }
            json!({"rows": rows})
        }
        "density" => {
            let mut density = vec![];
            for p in input["points"].as_array().unwrap() {
                let g = |k: &str| p[k].as_f64().unwrap();
                let epoch = epoch_utc(p["utc"].as_str().unwrap());
                let midnight = epoch.to_time_scale(TimeScale::UTC).with_hms_strict(0, 0, 0);
                let lst = ((epoch - midnight).to_unit(Unit::Hour) + g("lonDeg") / 15.0).rem_euclid(24.0);
                let sw = Msise00DailyWeather { f107_daily_sfu: g("f107"), f107_avg_sfu: g("f107a"), ap_daily: g("ap"), ap_3hour_history: [g("ap"); 7] };
                let d = msise00_density(sw, lst, g("latDeg"), g("lonDeg"), g("altKm"), epoch, Nrlmsise00Flags::default())?;
                density.push(json!({"rho": d.total_mass_density_kg_m3, "tExo": d.temp_exo_k, "tAlt": d.temp_alt_k, "He": d.density_he_per_cm3,
                    "O": d.density_o_per_cm3, "N2": d.density_n2_per_cm3, "O2": d.density_o2_per_cm3, "Ar": d.density_ar_per_cm3,
                    "H": d.density_h_per_cm3, "N": d.density_n_per_cm3, "anomalousO": d.density_anomalous_o_per_cm3}));
            }
            json!({"density": density})
        }
        _ => propagate(&input)?,
    };
    println!("{out}");
    Ok(())
}
