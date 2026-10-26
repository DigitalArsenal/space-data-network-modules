//! Nyx Space on the FFM engine benchmark plan (run-nyx.mjs writes the input
//! and runs this program). A reference engine only; nothing here ships.
//!
//! stdin {"kernel", "pca", "bpc", "gmKm3S2", "occultingRadiusKm",
//!   "sunRadiusKm", "sunGmKm3S2", "moonGmKm3S2", "fluxWm2", "reps",
//!   "cases": [{"id", "state": [km, km/s], "epochs": [UTC ISO],
//!   "offsets": [s], "massKg", "field": {"cof", "degree", "order",
//!   "radiusKm"}, "srp": null | {"cr", "areaM2"}, "drag": null | {"cd",
//!   "areaM2", "weather": {"f107", "ap", "kp"}}, "integrator": {"kind":
//!   "fixed" | "adaptive", "stepS", "tolerance", "minStepS", "maxStepS"}}]}
//! -> {"cases": [{"id", "cpuS", "wallS", "samples": [[t, x, y, z]]}]} in km.
//!
//! Dynamics as tests/evidence/nyx/src/main.rs: J2000 (ICRF axes) about the
//! Earth with the plan's GM; FFM's EGM2008 .cof in ITRF93 from the BPC; Sun
//! and Moon from DE440; cannonball radiation pressure with Nyx's conical
//! shadow of the plan's sphere; NRLMSISE-00 on mean local solar time with
//! the daily Ap, WGS84 heights in ITRF93, constant weather. Integrator:
//! DormandPrince78 (GMAT's PrinceDormand78 coefficients, RK8(7)13M), fixed
//! steps, or adaptive with RSSCartesianState error control (the RSS of the
//! position and of the velocity error, each over the state's) at the plan's
//! relative tolerance; stopped at every sample. Timing: this thread's CPU
//! time over the propagation (construction apart), smallest of `reps`.
use std::io::Read;
use std::str::FromStr;
use std::sync::Arc;

use anise::constants::celestial_objects::{EARTH, MOON, SUN};
use anise::constants::frames::{EARTH_ITRF93, EARTH_J2000};
use anise::prelude::Almanac;
use anise::structure::planetocentric::ellipsoid::Ellipsoid;
use hifitime::{Epoch, Unit};
use nyx_space::cosmic::eclipse::ShadowModel;
use nyx_space::cosmic::{DragData, Mass, Orbit, SRPData, Spacecraft};
use nyx_space::dynamics::{AtmDensity, Drag, ForceModel, GravityField, OrbitalDynamics, SolarPressure, SpacecraftDynamics};
use nyx_space::io::gravity::GravityFieldData;
use nyx_space::io::space_weather::{SpaceWeatherData, StaticSpaceWeather};
use nyx_space::propagators::{ErrorControl, IntegratorOptions, Propagator};
use serde_json::{Value, json};

fn thread_cpu_s() -> f64 {
    let mut t = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut t) };
    t.tv_sec as f64 + t.tv_nsec as f64 * 1e-9
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    let input: Value = serde_json::from_str(&text)?;
    let f = |k: &str| input[k].as_f64().unwrap();
    let reps = input["reps"].as_u64().unwrap_or(1).max(1);
    let almanac = Arc::new(almanac(&input)?);
    let mut eme = almanac.frame_info(EARTH_J2000)?;
    eme.shape = Some(Ellipsoid::from_sphere(f("occultingRadiusKm")));
    let itrf = almanac.frame_info(EARTH_ITRF93)?;
    let mut out = vec![];
    for c in input["cases"].as_array().unwrap() {
        let x: Vec<f64> = c["state"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let epochs: Vec<Epoch> = c["epochs"].as_array().unwrap().iter().map(|v| epoch_utc(v.as_str().unwrap())).collect();
        let offsets: Vec<f64> = c["offsets"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let mut orbital = OrbitalDynamics::point_masses(vec![SUN, MOON]);
        let field = &c["field"];
        let mut data = GravityFieldData::from_cof(field["cof"].as_str().unwrap(), field["degree"].as_u64().unwrap() as usize,
            field["order"].as_u64().unwrap() as usize, itrf)?;
        data.mu_km3_s2 = Some(f("gmKm3S2"));
        data.radius_km = Some(field["radiusKm"].as_f64().unwrap());
        orbital.accel_models.push(GravityField::new(data));
        let srp = c["srp"].as_object();
        let drag = c["drag"].as_object();
        let sc = Spacecraft::builder()
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
                estimate: false,
            }));
        }
        if let Some(d) = drag {
            let w = &d["weather"];
            let weather = SpaceWeatherData::from_static_weather(StaticSpaceWeather::Custom {
                f107: w["f107"].as_f64().unwrap(), ap: w["ap"].as_f64().unwrap(), kp: w["kp"].as_f64().unwrap() });
            forces.push(Arc::new(Drag { density: AtmDensity::NRLMSISE00 { weather, flags: None }, frame: itrf, estimate: false }));
        }
        let dynamics = SpacecraftDynamics::from_models(orbital, forces);
        let it = &c["integrator"];
        let opts = if it["kind"].as_str() == Some("fixed") {
            IntegratorOptions::with_fixed_step_s(it["stepS"].as_f64().unwrap())
        } else {
            IntegratorOptions::with_adaptive_step_s(it["minStepS"].as_f64().unwrap(), it["maxStepS"].as_f64().unwrap(),
                it["tolerance"].as_f64().unwrap(), ErrorControl::RSSCartesianState)
        };
        let propagator = Propagator::dp78(dynamics, opts);
        let (mut best_cpu, mut best_wall, mut samples) = (f64::INFINITY, 0.0, vec![]);
        for _ in 0..reps {
            let mut state = sc;
            let mut rows = vec![];
            let (c0, w0) = (thread_cpu_s(), std::time::Instant::now());
            for (i, epoch) in epochs.iter().enumerate() {
                if i > 0 {
                    state = propagator.with(state, almanac.clone()).until_epoch(*epoch)?;
                }
                assert!((state.orbit.epoch - *epoch).abs() < Unit::Microsecond * 1);
                let r = state.orbit.radius_km;
                rows.push(json!([offsets[i], r.x, r.y, r.z]));
            }
            let (cpu, wall) = (thread_cpu_s() - c0, w0.elapsed().as_secs_f64());
            if cpu < best_cpu {
                best_cpu = cpu;
                best_wall = wall;
                samples = rows;
            }
        }
        eprintln!("{}: {:.4} CPU-s over the arc", c["id"].as_str().unwrap(), best_cpu);
        out.push(json!({"id": c["id"], "cpuS": best_cpu, "wallS": best_wall, "samples": samples}));
    }
    println!("{}", json!({"cases": out}));
    Ok(())
}
