// Orekit 13.1 reference trajectories for propagator/hpop.
//
// Orekit (CS GROUP, Apache-2.0) is the independent oracle: each case starts
// from one Cartesian GCRF state and is propagated with a named force set; the
// GCRF states are written every hour for a day. HPOP's tests replay the same
// initial states and force sets and compare.
//
// Run (single-file source launch, Java 11+):
//   java -cp "<jars>/*" OrekitReference.java <orekit-data dir> <gfc dir> <out.json>
//
// Physical constants are set to the values HPOP uses, so that a difference is
// a difference of implementation, not of constants:
//   GM 3.986004415e14 m^3/s^2, EGM2008's TT-compatible value (both integrate
//   on TT: Orekit's clock is TAI-based, HPOP's is TT), field radius
//   6378136.3 m, the field's coefficients from lib/egm2008_data.h
//   (make-gfc.mjs), spherical Earth of radius 6378137 m for the shadow,
//   radiation pressure 1361 W/m^2 / c at 1 au (the IAU 2015 B3 nominal solar
//   irradiance; Orekit's default 4.56e-6 N/m^2 is 1367 W/m^2, 0.45 % more)
//   and the same resolution's solar radius 695 700 km (Orekit's default),
//   Sun and Moon from JPL DE440 (Orekit's lnxp1990.440),
//   Earth-fixed axes ITRF with IERS 2010 conventions and the IERS EOP in the
//   orekit-data directory.
//
// NRLMSISE-00 runs on mean local solar time, UT + longitude/15: the
// convention its coefficients were fitted with (the reference driver's
// stl = sec/3600 + glong/15), which HPOP uses and which Orekit makes the
// default from 14.0 (issue 2003). Orekit 13.1 feeds the true Sun's hour
// angle instead (apparent solar time, about 6 minutes different in August),
// which moves the drag effect on LEO400 by 0.15 % over the day. 13.1 has no
// switch for this, so MeanSolarTimeNRLMSISE00 below hands the unmodified
// 13.1 model a mean Sun on the ITRF equator and evaluates it in ITRF, where
// the model's hour angle is then exactly UT + longitude/15. Nothing else
// about the model changes.
import java.io.File;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import org.hipparchus.CalculusFieldElement;
import org.hipparchus.geometry.euclidean.threed.FieldVector3D;
import org.hipparchus.geometry.euclidean.threed.Vector3D;
import org.hipparchus.ode.nonstiff.DormandPrince853Integrator;
import org.orekit.attitudes.LofOffset;
import org.orekit.forces.empirical.ParametricAcceleration;
import org.orekit.forces.empirical.PolynomialAccelerationModel;
import org.orekit.forces.gravity.DeSitterRelativity;
import org.orekit.forces.gravity.LenseThirringRelativity;
import org.orekit.forces.gravity.Relativity;
import org.orekit.forces.gravity.SolidTides;
import org.orekit.forces.gravity.potential.TideSystem;
import org.orekit.frames.LOFType;
import org.orekit.models.earth.atmosphere.data.CssiSpaceWeatherData;
import org.orekit.bodies.CelestialBody;
import org.orekit.bodies.CelestialBodyFactory;
import org.orekit.bodies.OneAxisEllipsoid;
import org.orekit.data.DataContext;
import org.orekit.data.DirectoryCrawler;
import org.orekit.forces.drag.DragForce;
import org.orekit.forces.drag.IsotropicDrag;
import org.orekit.forces.gravity.HolmesFeatherstoneAttractionModel;
import org.orekit.forces.gravity.ThirdBodyAttraction;
import org.orekit.forces.gravity.potential.GravityFieldFactory;
import org.orekit.forces.gravity.potential.ICGEMFormatReader;
import org.orekit.forces.gravity.potential.NormalizedSphericalHarmonicsProvider;
import org.orekit.forces.radiation.IsotropicRadiationSingleCoefficient;
import org.orekit.forces.radiation.SolarRadiationPressure;
import org.orekit.frames.Frame;
import org.orekit.frames.FramesFactory;
import org.orekit.models.earth.atmosphere.Atmosphere;
import org.orekit.models.earth.atmosphere.NRLMSISE00;
import org.orekit.models.earth.atmosphere.NRLMSISE00InputParameters;
import org.orekit.orbits.CartesianOrbit;
import org.orekit.orbits.KeplerianOrbit;
import org.orekit.orbits.OrbitType;
import org.orekit.orbits.PositionAngleType;
import org.orekit.propagation.SpacecraftState;
import org.orekit.propagation.numerical.NumericalPropagator;
import org.orekit.time.AbsoluteDate;
import org.orekit.time.FieldAbsoluteDate;
import org.orekit.time.TimeScale;
import org.orekit.time.TimeScalesFactory;
import org.orekit.utils.Constants;
import org.orekit.utils.ExtendedPositionProvider;
import org.orekit.utils.IERSConventions;
import org.orekit.utils.PVCoordinates;

public class OrekitReference {
    static final double GM = 3.986004415e14;
    static final double FIELD_RADIUS = 6378136.3;
    static final double RE = 6378137.0;  // shadow body
    static final double AU = 149597870700.0, SOLAR_PRESSURE = 1361.0 / 299792458.0;  // at 1 au, N/m^2
    static final double MASS = 1000.0, AREA = 20.0, CR = 1.3, CD = 2.2;
    static final double F107 = 150.0, F107A = 150.0, AP = 15.0;
    static final double DURATION = 86400.0, STEP = 3600.0;

    static final class Case {
        final String name; final double aKm, e, iDeg, raanDeg, argpDeg, mDeg; final boolean drag;
        Case(String name, double aKm, double e, double iDeg, double raanDeg, double argpDeg, double mDeg, boolean drag) {
            this.name = name; this.aKm = aKm; this.e = e; this.iDeg = iDeg; this.raanDeg = raanDeg; this.argpDeg = argpDeg; this.mDeg = mDeg; this.drag = drag;
        }
    }
    static final class Forces {
        final String name; final int degree, order; final boolean thirdBodies, srp, drag;
        // PRW SDS 1.240.0 additions: relativity 0 none, 1 Schwarzschild, 2 IERS 2010
        // (+ Lense-Thirring, de Sitter); IERS 2010 solid tides; in-track
        // acceleration (m/s^2); Cd*A/m rate (m^2/kg/s); CSSI daily space weather.
        int relativity = 0; boolean tides = false, cssi = false; double inTrack = 0, bdot = 0;
        Forces(String name, int degree, int order, boolean thirdBodies, boolean srp, boolean drag) {
            this.name = name; this.degree = degree; this.order = order; this.thirdBodies = thirdBodies; this.srp = srp; this.drag = drag;
        }
        Forces relativity(int r) { relativity = r; return this; }
        Forces tides() { tides = true; return this; }
        Forces inTrack(double a) { inTrack = a; return this; }
        Forces bdot(double rate) { bdot = rate; return this; }
        Forces cssi() { cssi = true; return this; }
    }

    // Drag whose Cd*A/m grows linearly from the epoch: Cd*A/m + rate*(t - t0).
    static final class RateDrag extends IsotropicDrag {
        final AbsoluteDate t0; final double rate;
        RateDrag(double area, double cd, AbsoluteDate t0, double rate) { super(area, cd); this.t0 = t0; this.rate = rate; }
        @Override
        public Vector3D dragAcceleration(SpacecraftState s, double density, Vector3D relativeVelocity, double[] parameters) {
            double b0 = CD * AREA / s.getMass();
            return super.dragAcceleration(s, density, relativeVelocity, parameters).scalarMultiply((b0 + rate * s.getDate().durationFrom(t0)) / b0);
        }
    }

    // IERS 2010 eq. 10.12 de Sitter term with every vector in the state's
    // frame. Orekit 13.1 DeSitterRelativity (and develop as of 2026-10-08)
    // takes the Earth's position and velocity in the Sun's IAU-pole
    // "inertially oriented" frame (pole RA 286.13, Dec 63.87 deg) and crosses
    // them with the satellite velocity in the state's frame, so its result is
    // rotated by that frame's orientation. Same equation and Sun GM here,
    // with Earth-from-Sun taken as minus the Sun in the state's frame.
    static final class FrameConsistentDeSitter extends DeSitterRelativity {
        final CelestialBody sunBody = CelestialBodyFactory.getSun();
        @Override
        public Vector3D acceleration(SpacecraftState s, double[] parameters) {
            final double c2 = Constants.SPEED_OF_LIGHT * Constants.SPEED_OF_LIGHT;
            final PVCoordinates sunPv = sunBody.getPVCoordinates(s.getDate(), s.getFrame());
            final Vector3D pEarth = sunPv.getPosition().negate(), vEarth = sunPv.getVelocity().negate();
            final double r = pEarth.getNorm();
            return new Vector3D(-3.0 * parameters[0] / (c2 * r * r * r), vEarth.crossProduct(pEarth).crossProduct(s.getPVCoordinates().getVelocity()));
        }
    }

    // Orekit 13.1's NRLMSISE-00 on mean local solar time (see the header).
    static final class MeanSolarTimeNRLMSISE00 implements Atmosphere {
        final NRLMSISE00 model;
        final Frame itrf;
        MeanSolarTimeNRLMSISE00(NRLMSISE00InputParameters weather, OneAxisEllipsoid earth, TimeScale utc) {
            itrf = earth.getBodyFrame();
            // On the ITRF equator at longitude 15 * (12 - UT hours) degrees:
            // 13.1's hour angle pi + atan2(s x p, s . p) about ITRF z is then
            // 12 + (longitude - that)/15 = UT + longitude/15 hours.
            ExtendedPositionProvider meanSun = new ExtendedPositionProvider() {
                public Vector3D getPosition(AbsoluteDate date, Frame frame) {
                    double ut = date.getComponents(utc).getTime().getSecondsInLocalDay() / 3600;
                    double lambda = Math.toRadians(15 * (12 - ut));
                    double au = Constants.IAU_2012_ASTRONOMICAL_UNIT;
                    Vector3D inItrf = new Vector3D(au * Math.cos(lambda), au * Math.sin(lambda), 0);
                    return itrf.getStaticTransformTo(frame, date).transformPosition(inItrf);
                }
                public <T extends CalculusFieldElement<T>> FieldVector3D<T> getPosition(FieldAbsoluteDate<T> date, Frame frame) {
                    throw new UnsupportedOperationException("double precision only");
                }
            };
            // Switch 9 = 1: the daily Ap only, as HPOP evaluates NRLMSISE-00.
            model = new NRLMSISE00(weather, meanSun, earth, utc).withSwitch(9, 1);
        }
        public Frame getFrame() { return itrf; }
        public double getDensity(AbsoluteDate date, Vector3D position, Frame frame) {
            return model.getDensity(date, frame.getStaticTransformTo(itrf, date).transformPosition(position), itrf);
        }
        public <T extends CalculusFieldElement<T>> T getDensity(FieldAbsoluteDate<T> date, FieldVector3D<T> position, Frame frame) {
            throw new UnsupportedOperationException("double precision only");
        }
    }

    public static void main(String[] args) throws Exception {
        Locale.setDefault(Locale.ROOT);
        DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(new File(args[0])));
        DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(new File(args[1])));
        GravityFieldFactory.clearPotentialCoefficientsReaders();
        GravityFieldFactory.addPotentialCoefficientsReader(new ICGEMFormatReader("EGM2008-hpop.gfc", false));

        TimeScale utc = TimeScalesFactory.getUTC();
        AbsoluteDate epoch = new AbsoluteDate(2026, 8, 2, 0, 0, 0.0, utc);
        Frame gcrf = FramesFactory.getGCRF();
        Frame itrf = FramesFactory.getITRF(IERSConventions.IERS_2010, false);
        CelestialBody sun = CelestialBodyFactory.getSun();
        CelestialBody moon = CelestialBodyFactory.getMoon();

        List<Case> cases = List.of(
            new Case("LEO400", 6778.137, 0.0005, 51.6, 30, 40, 0, true),
            new Case("SSO700", 7078.137, 0.001, 98.2, 100, 90, 10, true),
            new Case("GPS", 26559.7, 0.005, 55, 200, 30, 45, false),
            new Case("GEO", 42164.17, 0.0002, 0.05, 80, 10, 120, false),
            new Case("MOLNIYA", 26554.0, 0.72, 63.4, 60, 270, 0, false));
        List<Forces> sets = List.of(
            new Forces("F0-point-mass", 0, 0, false, false, false),
            new Forces("F1-J2", 2, 0, false, false, false),
            new Forces("F2-zonal20", 20, 0, false, false, false),
            new Forces("Z1-zonal20-sun-moon", 20, 0, true, false, false),
            new Forces("Z2-zonal20-sun-moon-srp", 20, 0, true, true, false),
            new Forces("Z3-zonal20-sun-moon-srp-drag", 20, 0, true, true, true),
            new Forces("F3-field20x20", 20, 20, false, false, false),
            new Forces("F4-field-sun-moon", 20, 20, true, false, false),
            new Forces("F5-field-sun-moon-srp", 20, 20, true, true, false),
            new Forces("F6-field-sun-moon-srp-drag", 20, 20, true, true, true));
        // Forces added with PRW SDS 1.240.0, on top of F4 or F6.
        java.util.Map<String, List<Forces>> extra = java.util.Map.of(
            "LEO400", List.of(
                new Forces("R1-field-sun-moon-schwarzschild", 20, 20, true, false, false).relativity(1),
                new Forces("R2-field-sun-moon-relativity-iers2010", 20, 20, true, false, false).relativity(2),
                new Forces("T1-field-sun-moon-solid-tides", 20, 20, true, false, false).tides(),
                new Forces("I1-field-sun-moon-in-track", 20, 20, true, false, false).inTrack(5e-8),
                new Forces("B1-field-sun-moon-srp-drag-bdot", 20, 20, true, true, true).bdot(5e-8),
                new Forces("W1-field-sun-moon-srp-drag-cssi", 20, 20, true, true, true).cssi()),
            "SSO700", List.of(
                new Forces("W1-field-sun-moon-srp-drag-cssi", 20, 20, true, true, true).cssi()),
            "GPS", List.of(
                new Forces("R1-field-sun-moon-schwarzschild", 20, 20, true, false, false).relativity(1),
                new Forces("R2-field-sun-moon-relativity-iers2010", 20, 20, true, false, false).relativity(2),
                new Forces("T1-field-sun-moon-solid-tides", 20, 20, true, false, false).tides()));

        StringBuilder out = new StringBuilder();
        out.append("{\n \"source\": \"Orekit 13.1 (CS GROUP, Apache-2.0), DormandPrince853 (steps <= 10 s), GCRF; NRLMSISE-00 on mean local solar time\",\n");
        out.append(String.format(" \"epochUtc\": \"%s\",\n \"epochTdb\": \"%s\",\n", epoch.toString(utc), epoch.toString(TimeScalesFactory.getTDB())));
        out.append(String.format(" \"constants\": {\"gm\": %.10e, \"fieldRadiusM\": %.1f, \"shadowRadiusM\": %.1f, \"solarPressureAt1AuNm2\": %.10e, \"massKg\": %.1f, \"areaM2\": %.1f, \"cr\": %.2f, \"cd\": %.2f, \"f107\": %.1f, \"f107a\": %.1f, \"ap\": %.1f},\n",
            GM, FIELD_RADIUS, RE, SOLAR_PRESSURE, MASS, AREA, CR, CD, F107, F107A, AP));
        out.append(" \"cases\": [\n");
        boolean first = true;
        for (Case c : cases) {
            KeplerianOrbit kep = new KeplerianOrbit(c.aKm * 1000, c.e, Math.toRadians(c.iDeg), Math.toRadians(c.argpDeg),
                Math.toRadians(c.raanDeg), Math.toRadians(c.mDeg), PositionAngleType.MEAN, gcrf, epoch, GM);
            PVCoordinates pv0 = kep.getPVCoordinates();
            List<Forces> all = new ArrayList<>(sets);
            all.addAll(extra.getOrDefault(c.name, List.of()));
            for (Forces f : all) {
                if (f.drag && !c.drag) continue;
                CartesianOrbit orbit = new CartesianOrbit(pv0, gcrf, epoch, GM);
                // Steps of at most 10 s: with longer steps Orekit's own LEO400
                // radiation-pressure trajectory moves by up to 0.4 m with the
                // step limit (30 s: 0.11 m, 120 s and 300 s: 0.40 m), the ~9 s
                // penumbra crossings being stepped over; at 10 s it agrees with
                // a 1e-15 / 10 s run to 0.4 mm.
                DormandPrince853Integrator integrator = new DormandPrince853Integrator(1e-3, 10, 1e-7, 1e-14);
                NumericalPropagator p = new NumericalPropagator(integrator);
                p.setOrbitType(OrbitType.CARTESIAN);
                p.setInitialState(new SpacecraftState(orbit).withMass(MASS));
                if (f.degree > 0) {
                    NormalizedSphericalHarmonicsProvider field = GravityFieldFactory.getNormalizedProvider(f.degree, f.order);
                    p.addForceModel(new HolmesFeatherstoneAttractionModel(itrf, field));
                }
                if (f.thirdBodies) {
                    p.addForceModel(new ThirdBodyAttraction(sun));
                    p.addForceModel(new ThirdBodyAttraction(moon));
                }
                if (f.srp) {
                    p.addForceModel(new SolarRadiationPressure(AU, SOLAR_PRESSURE, sun, new OneAxisEllipsoid(RE, 0.0, itrf),
                        new IsotropicRadiationSingleCoefficient(AREA, CR)));
                }
                if (f.relativity >= 1) p.addForceModel(new Relativity(GM));
                if (f.relativity >= 2) {
                    p.addForceModel(new LenseThirringRelativity(GM, itrf));
                    p.addForceModel(new FrameConsistentDeSitter());
                }
                if (f.tides) {
                    // IERS 2010 section 6.2 only (no pole tide), for the tide-free
                    // field; tidal coefficients sampled every 60 s.
                    p.addForceModel(new SolidTides(itrf, FIELD_RADIUS, GM, TideSystem.TIDE_FREE, false, 60.0, 12,
                        IERSConventions.IERS_2010, TimeScalesFactory.getUT1(IERSConventions.IERS_2010, false), sun, moon));
                }
                if (f.inTrack != 0) {
                    // QSW's S axis is the in-track axis, N x rhat.
                    p.setAttitudeProvider(new LofOffset(gcrf, LOFType.QSW));
                    ParametricAcceleration inTrack = new ParametricAcceleration(Vector3D.PLUS_J, false, new PolynomialAccelerationModel("in-track", epoch, 0));
                    inTrack.getParametersDrivers().get(0).setValue(f.inTrack);
                    p.addForceModel(inTrack);
                }
                if (f.drag) {
                    NRLMSISE00InputParameters weather = f.cssi ? new CssiSpaceWeatherData(CssiSpaceWeatherData.DEFAULT_SUPPORTED_NAMES) : new NRLMSISE00InputParameters() {
                        public AbsoluteDate getMinDate() { return AbsoluteDate.PAST_INFINITY; }
                        public AbsoluteDate getMaxDate() { return AbsoluteDate.FUTURE_INFINITY; }
                        public double getDailyFlux(AbsoluteDate date) { return F107; }
                        public double getAverageFlux(AbsoluteDate date) { return F107A; }
                        public double[] getAp(AbsoluteDate date) { return new double[] {AP, AP, AP, AP, AP, AP, AP}; }
                    };
                    OneAxisEllipsoid earth = new OneAxisEllipsoid(Constants.WGS84_EARTH_EQUATORIAL_RADIUS, Constants.WGS84_EARTH_FLATTENING, itrf);
                    Atmosphere atmosphere = new MeanSolarTimeNRLMSISE00(weather, earth, utc);
                    p.addForceModel(new DragForce(atmosphere, f.bdot != 0 ? new RateDrag(AREA, CD, epoch, f.bdot) : new IsotropicDrag(AREA, CD)));
                }
                if (!first) out.append(",\n");
                first = false;
                out.append(String.format("  {\"orbit\": \"%s\", \"forces\": \"%s\", \"degree\": %d, \"order\": %d, \"thirdBodies\": %b, \"srp\": %b, \"drag\": %b,\n",
                    c.name, f.name, f.degree, f.order, f.thirdBodies, f.srp, f.drag));
                if (f.relativity != 0 || f.tides || f.inTrack != 0 || f.bdot != 0 || f.cssi)
                    out.append(String.format("   \"relativity\": %d, \"solidTides\": %b, \"inTrackAccelerationMS2\": %.6e, \"dragAreaOverMassRateM2KgS\": %.6e, \"spaceWeather\": \"%s\",\n",
                        f.relativity, f.tides, f.inTrack, f.bdot, f.cssi ? "cssi" : "constant"));
                out.append("   \"samples\": [");
                for (double t = 0; t <= DURATION + 1e-9; t += STEP) {
                    AbsoluteDate date = epoch.shiftedBy(t);
                    PVCoordinates pv = p.propagate(date).getPVCoordinates(gcrf);
                    Vector3D r = pv.getPosition(), v = pv.getVelocity();
                    // Each sample carries its UTC epoch (exact: whole seconds here), which HPOP is
                    // asked for; both convert it to TT, the integration clock.
                    out.append(String.format("%s\n    [%.1f, %.6f, %.6f, %.6f, %.9f, %.9f, %.9f, \"%s\"]", t == 0 ? "" : ",", t,
                        r.getX(), r.getY(), r.getZ(), v.getX(), v.getY(), v.getZ(), date.toString(utc)));
                }
                out.append("]}");
                System.err.println(c.name + " " + f.name + " done");
            }
        }
        out.append("\n ]\n}\n");
        try (PrintWriter w = new PrintWriter(args[2], "UTF-8")) { w.print(out); }
    }
}
