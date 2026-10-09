//! Nyx Space reference trajectories for propagator/hpop (make-nyx-reference.mjs
//! writes the input and builds and runs this program).
//!
//! stdin: {"cof", "kernel", "pca", "bpc", "gmKm3S2", "fieldRadiusKm",
//!         "shadowRadiusKm", "massKg", "areaM2", "cr", "cd", "fluxWm2", "f107",
//!         "ap", "kp", "cases": [
//!         {"orbit", "forces", "degree", "order", "thirdBodies", "srp", "drag",
//!          "state": [km, km/s], "epochs": [UTC ISO], "offsets": [s]}]}
//! stdout: {"cases": [{"orbit", "forces", "samples": [[t, x, y, z, vx, vy, vz]]}]} in km, km/s.
use std::io::Read;
use std::str::FromStr;
use std::sync::Arc;

use anise::constants::celestial_objects::{MOON, SUN};
use anise::constants::frames::{EARTH_ITRF93, EARTH_J2000, SUN_J2000};
use anise::prelude::Almanac;
use anise::structure::planetocentric::ellipsoid::Ellipsoid;
use hifitime::{Epoch, Unit};
use nyx_space::cosmic::eclipse::ShadowModel;
use nyx_space::cosmic::{DragData, Mass, Orbit, SRPData, Spacecraft};
use nyx_space::dynamics::{AtmDensity, Drag, ForceModel, GravityField, OrbitalDynamics, SolarPressure, SpacecraftDynamics};
use nyx_space::io::space_weather::{SpaceWeatherData, StaticSpaceWeather};
use nyx_space::io::gravity::GravityFieldData;
use nyx_space::propagators::{ErrorControl, IntegratorOptions, Propagator};
use serde_json::{Value, json};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    let input: Value = serde_json::from_str(&text)?;
    let f = |k: &str| input[k].as_f64().unwrap();
    let s = |k: &str| input[k].as_str().unwrap().to_string();
    let almanac = Arc::new(Almanac::default().load(&s("kernel"))?.load(&s("pca"))?.load(&s("bpc"))?);

    // The integration frame: SPICE's J2000 (DE440's ICRF axes) about the
    // Earth, with the cases' GM; the Earth a sphere of the shadow radius.
    let mut eme = almanac.frame_info(EARTH_J2000)?;
    eme.mu_km3_s2 = Some(f("gmKm3S2"));
    eme.shape = Some(Ellipsoid::from_sphere(f("shadowRadiusKm")));
    let tolerance = std::env::var("NYX_XVAL_TOLERANCE").ok().map(|v| v.parse::<f64>().unwrap()).unwrap_or(1e-13);
    let max_step = std::env::var("NYX_XVAL_MAX_STEP").ok().map(|v| v.parse::<f64>().unwrap()).unwrap_or(60.0);

    let mut out = vec![];
    for c in input["cases"].as_array().unwrap() {
        let degree = c["degree"].as_u64().unwrap() as usize;
        let order = c["order"].as_u64().unwrap() as usize;
        let third = c["thirdBodies"].as_bool().unwrap();
        let srp = c["srp"].as_bool().unwrap();
        let drag = c["drag"].as_bool().unwrap();
        let x: Vec<f64> = c["state"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let epochs: Vec<Epoch> = c["epochs"].as_array().unwrap().iter().map(|v| Epoch::from_str(&format!("{} UTC", v.as_str().unwrap())).unwrap()).collect();
        let offsets: Vec<f64> = c["offsets"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();

        let mut orbital = OrbitalDynamics::point_masses(if third { vec![SUN, MOON] } else { vec![] });
        if degree > 0 {
            // The field in ITRF93 (JPL's high-precision Earth orientation).
            let mut field = GravityFieldData::from_cof(&s("cof"), degree, order, almanac.frame_info(EARTH_ITRF93)?)?;
            field.mu_km3_s2 = Some(f("gmKm3S2"));
            field.radius_km = Some(f("fieldRadiusKm"));
            orbital.accel_models.push(GravityField::new(field));
        }
        let sc = Spacecraft::builder()
            .orbit(Orbit::new(x[0], x[1], x[2], x[3], x[4], x[5], epochs[0], eme))
            .mass(Mass::from_dry_mass(f("massKg")))
            .srp(SRPData { area_m2: f("areaM2"), coeff_reflectivity: f("cr") })
            .drag(DragData { area_m2: f("areaM2"), coeff_drag: f("cd") })
            .build();
        let mut forces: Vec<Arc<dyn ForceModel>> = vec![];
        if srp {
            forces.push(Arc::new(SolarPressure {
                phi: f("fluxWm2"),
                shadow_model: ShadowModel { light_source: almanac.frame_info(SUN_J2000)?, shadow_bodies: vec![eme], correction: None },
                estimate: false,
            }));
        }
        if drag {
            // NRLMSISE-00 (mean local solar time, daily Ap: Nyx's defaults)
            // on the WGS84 ellipsoid in ITRF93, constant space weather.
            let mut itrf = almanac.frame_info(EARTH_ITRF93)?;
            itrf.shape = Some(Ellipsoid::from_spheroid(6378.137, 6378.137 * (1.0 - 1.0 / 298.257223563)));
            let weather = SpaceWeatherData::from_static_weather(StaticSpaceWeather::Custom { f107: f("f107"), ap: f("ap"), kp: f("kp") });
            forces.push(Arc::new(Drag { density: AtmDensity::NRLMSISE00 { weather, flags: None }, frame: itrf, estimate: false }));
        }
        let dynamics = SpacecraftDynamics::from_models(orbital, forces);
        let opts = IntegratorOptions::with_adaptive_step_s(1e-3, max_step, tolerance, ErrorControl::RSSCartesianStep);
        let propagator = Propagator::rk89(dynamics, opts);
        let mut state = sc;
        let mut samples = vec![];
        for (i, epoch) in epochs.iter().enumerate() {
            if i > 0 {
                state = propagator.with(state, almanac.clone()).until_epoch(*epoch)?;
            }
            assert!((state.orbit.epoch - *epoch).abs() < Unit::Microsecond * 1);
            let r = state.orbit.radius_km;
            let v = state.orbit.velocity_km_s;
            samples.push(json!([offsets[i], r.x, r.y, r.z, v.x, v.y, v.z]));
        }
        eprintln!("{} {} done", c["orbit"].as_str().unwrap(), c["forces"].as_str().unwrap());
        out.push(json!({"orbit": c["orbit"], "forces": c["forces"], "samples": samples}));
    }
    println!("{}", json!({"cases": out}));
    Ok(())
}
