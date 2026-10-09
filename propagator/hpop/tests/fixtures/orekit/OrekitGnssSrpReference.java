// Orekit 13.1 reference for HPOP's GNSS radiation pressure (lib/gnss_srp.h):
// the GPS box-wing of Rodriguez-Solano et al. (2012) in Orekit's
// BoxAndSolarArraySpacecraft under Orekit's GPS attitude providers, and
// CODE's ECOM2 (Arnold et al. 2015) as Orekit's ECOM2 force model.
//
// Run (single-file source launch, Java 11+), as OrekitReference.java:
//   java -cp "<jars>/*" OrekitGnssSrpReference.java <orekit-data dir> <out.json>
//
// Each case propagates one GPS orbit for a day from a Cartesian GCRF state
// (point mass plus the radiation model alone, so the comparison isolates the
// radiation model) and writes, every hour, the GCRF state, the radiation
// model's own acceleration at that state and Orekit's state transition
// matrix; the ECOM2 case also writes Orekit's Jacobian of the state with
// respect to the eleven ECOM2 coefficients.
//
// Shared with HPOP by construction: GM 3.986004415e14 m^3/s^2, radiation
// pressure 1361 W/m^2 / c at 1 au, solar radius 695 700 km, a spherical
// Earth of 6378137 m for the shadow, Sun from JPL DE440 (lnxp1990.440), UTC
// epochs integrated on Orekit's TAI clock (HPOP: TT).
//
// The model mapping:
//   - Body axes: Orekit's GNSS attitude providers fly nominal yaw steering
//     outside the turns, Z = -r/|r| and Y = unit(s x r) with s the Sun, the
//     axes of Rodriguez-Solano (2014) Sec. 5.1.1. The cases avoid the noon
//     turn (|beta| above GPS IIF's 4.4 deg turn limit); the eclipse case's
//     midnight turn happens in the umbra, where the force is zero.
//   - Bus faces: FixedPanel. Rodriguez-Solano's eq. (9) re-emits the
//     absorbed energy at once as Lambertian heat, which is exactly a diffuse
//     reflection of the absorbed fraction: (alpha+delta)(eD + 2/3 eN) +
//     2 rho cos(t) eN is Orekit's (1 - rho') eD + 2 (delta'/3 + rho' cos(t)) eN
//     with rho' = rho, delta' = alpha + delta, so each face is an Orekit panel
//     with absorption 0 and specular reflection rho.
//   - Solar arrays: PointingPanel about Y toward the Sun, eq. (6), absorption
//     alpha and specular reflection rho as published.
//   - Surfaces: Rodriguez-Solano (2014) Appendix Tables 5.4 (GPS-IIR, 1100 kg)
//     and 5.5 (GPS-IIF, 1555 kg).
//   - ECOM2: Orekit's ECOM2(nD = 2, nB = 2) has no shadow factor; its case
//     has |beta| = 29 deg, no eclipse, where HPOP's lit fraction is 1.
import java.io.File;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import org.hipparchus.geometry.euclidean.threed.Vector3D;
import org.hipparchus.linear.RealMatrix;
import org.hipparchus.ode.nonstiff.DormandPrince853Integrator;
import org.orekit.attitudes.AttitudeProvider;
import org.orekit.bodies.CelestialBody;
import org.orekit.bodies.CelestialBodyFactory;
import org.orekit.bodies.OneAxisEllipsoid;
import org.orekit.data.DataContext;
import org.orekit.data.DirectoryCrawler;
import org.orekit.forces.BoxAndSolarArraySpacecraft;
import org.orekit.forces.FixedPanel;
import org.orekit.forces.ForceModel;
import org.orekit.forces.Panel;
import org.orekit.forces.PointingPanel;
import org.orekit.forces.radiation.ECOM2;
import org.orekit.forces.radiation.SolarRadiationPressure;
import org.orekit.frames.Frame;
import org.orekit.frames.FramesFactory;
import org.orekit.gnss.attitude.GPSBlockIIF;
import org.orekit.gnss.attitude.GPSBlockIIR;
import org.orekit.orbits.CartesianOrbit;
import org.orekit.orbits.KeplerianOrbit;
import org.orekit.orbits.OrbitType;
import org.orekit.orbits.PositionAngleType;
import org.orekit.propagation.MatricesHarvester;
import org.orekit.propagation.SpacecraftState;
import org.orekit.propagation.numerical.NumericalPropagator;
import org.orekit.time.AbsoluteDate;
import org.orekit.time.TimeScale;
import org.orekit.time.TimeScalesFactory;
import org.orekit.utils.IERSConventions;
import org.orekit.utils.PVCoordinates;
import org.orekit.utils.ParameterDriver;

public class OrekitGnssSrpReference {
    static final double GM = 3.986004415e14;
    static final double RE = 6378137.0;
    static final double AU = 149597870700.0, SOLAR_PRESSURE = 1361.0 / 299792458.0;
    static final double DURATION = 86400.0, STEP = 3600.0;

    // area, alpha, rho (specular), delta (diffuse): Rodriguez-Solano (2014) Tables 5.4, 5.5.
    static final double[][] IIF = {
        {5.720, 0.440, 0.448, 0.112}, {5.720, 0.440, 0.448, 0.112},   // +X, -X
        {7.010, 0.440, 0.448, 0.112}, {7.010, 0.440, 0.448, 0.112},   // +Y, -Y
        {5.400, 0.440, 0.448, 0.112}, {5.400, 1.000, 0.000, 0.000},   // +Z, -Z
        {22.250, 0.770, 0.035, 0.195}};                              // solar panels
    static final double[][] IIR = {
        {4.110, 0.940, 0.060, 0.0}, {4.110, 0.940, 0.060, 0.0},
        {4.460, 0.940, 0.060, 0.0}, {4.460, 0.940, 0.060, 0.0},
        {4.250, 0.940, 0.060, 0.0}, {4.250, 0.940, 0.060, 0.0},
        {13.920, 0.707, 0.044, 0.249}};
    // ECOM2 coefficients (m/s^2) in HPOP's order D0, Y0, B0, D2c, D2s, D4c, D4s,
    // B1c, B1s, B3c, B3s: GPS-like magnitudes (Arnold et al. 2015, Figs. 7-8:
    // D0 about -100 nm/s^2, periodic terms a few nm/s^2), all nonzero.
    static final double[] ECOM = {-1.0e-7, 6.0e-10, 1.0e-9, 4.0e-9, -1.5e-9, 1.2e-9, 0.7e-9, 3.0e-9, -2.0e-9, 0.8e-9, -0.5e-9};
    // Orekit's ECOM2(2, 2) driver names for the same order.
    static final String[] ECOM_DRIVERS = {"D0", "Y0", "B0", "Dcos0", "Dsin0", "Dcos1", "Dsin1", "Bcos0", "Bsin0", "Bcos1", "Bsin1"};

    static BoxAndSolarArraySpacecraft boxWing(double[][] s, CelestialBody sun) {
        Vector3D[] normals = {Vector3D.PLUS_I, Vector3D.MINUS_I, Vector3D.PLUS_J, Vector3D.MINUS_J, Vector3D.PLUS_K, Vector3D.MINUS_K};
        List<Panel> panels = new ArrayList<>();
        for (int i = 0; i < 6; ++i)  // absorbed energy re-emitted as Lambertian heat == diffuse
            panels.add(new FixedPanel(normals[i], s[i][0], false, 2.2, 0.0, 0.0, s[i][2]));
        panels.add(new PointingPanel(Vector3D.PLUS_J, sun, s[6][0], 2.2, 0.0, s[6][1], s[6][2]));
        return new BoxAndSolarArraySpacecraft(panels);
    }

    public static void main(String[] args) throws Exception {
        Locale.setDefault(Locale.ROOT);
        DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(new File(args[0])));
        TimeScale utc = TimeScalesFactory.getUTC();
        AbsoluteDate epoch = new AbsoluteDate(2026, 8, 2, 0, 0, 0.0, utc);
        Frame gcrf = FramesFactory.getGCRF();
        Frame itrf = FramesFactory.getITRF(IERSConventions.IERS_2010, false);
        CelestialBody sun = CelestialBodyFactory.getSun();
        OneAxisEllipsoid earth = new OneAxisEllipsoid(RE, 0.0, itrf);

        // name, block, model, RAAN (deg): beta 29 deg at RAAN 155, 8.5 deg at 130.
        Object[][] cases = {
            {"IIF-beta29-boxwing", "IIF", "boxwing", 155.0},
            {"IIF-beta8-eclipse-boxwing", "IIF", "boxwing", 130.0},
            {"IIR-beta29-boxwing", "IIR", "boxwing", 155.0},
            {"beta29-ecom2", "IIF", "ecom2", 155.0}};
        StringBuilder out = new StringBuilder();
        out.append("{\n \"source\": \"Orekit 13.1 (CS GROUP, Apache-2.0): BoxAndSolarArraySpacecraft under GPSBlockIIF/GPSBlockIIR attitude, ECOM2(2,2); point mass; DormandPrince853 at 1e-14, steps <= 10 s; GCRF\",\n");
        out.append(String.format(" \"epochUtc\": \"%s\",\n \"constants\": {\"gm\": %.10e, \"shadowRadiusM\": %.1f, \"solarPressureAt1AuNm2\": %.10e},\n", epoch.toString(utc), GM, RE, SOLAR_PRESSURE));
        out.append(" \"ecom2\": [");
        for (int i = 0; i < ECOM.length; ++i) out.append(i == 0 ? "" : ", ").append(String.format("%.6e", ECOM[i]));
        out.append("],\n \"cases\": [\n");
        for (int ci = 0; ci < cases.length; ++ci) {
            String name = (String) cases[ci][0], block = (String) cases[ci][1], model = (String) cases[ci][2];
            double raan = (Double) cases[ci][3];
            double mass = block.equals("IIF") ? 1555.0 : 1100.0;
            KeplerianOrbit kep = new KeplerianOrbit(26559.7e3, 0.005, Math.toRadians(55), Math.toRadians(30), Math.toRadians(raan),
                Math.toRadians(45), PositionAngleType.MEAN, gcrf, epoch, GM);
            CartesianOrbit orbit = new CartesianOrbit(kep.getPVCoordinates(), gcrf, epoch, GM);
            AbsoluteDate end = epoch.shiftedBy(DURATION + 3600);
            AttitudeProvider attitude = block.equals("IIF")
                ? new GPSBlockIIF(GPSBlockIIF.DEFAULT_YAW_RATE, GPSBlockIIF.DEFAULT_YAW_BIAS, epoch.shiftedBy(-3600), end, sun, gcrf)
                : new GPSBlockIIR(GPSBlockIIR.DEFAULT_YAW_RATE, epoch.shiftedBy(-3600), end, sun, gcrf);
            DormandPrince853Integrator integrator = new DormandPrince853Integrator(1e-3, 10, 1e-7, 1e-14);
            NumericalPropagator p = new NumericalPropagator(integrator);
            p.setOrbitType(OrbitType.CARTESIAN);
            p.setAttitudeProvider(attitude);
            p.setInitialState(new SpacecraftState(orbit, attitude.getAttitude(orbit, epoch, gcrf)).withMass(mass));
            ForceModel force;
            if (model.equals("boxwing")) {
                force = new SolarRadiationPressure(AU, SOLAR_PRESSURE, sun, earth, boxWing(block.equals("IIF") ? IIF : IIR, sun));
            } else {
                ECOM2 ecom = new ECOM2(2, 2, 0.0, sun, RE);
                for (int i = 0; i < ECOM.length; ++i) driver(ecom, ECOM_DRIVERS[i]).setValue(ECOM[i]);
                force = ecom;
            }
            p.addForceModel(force);
            for (ParameterDriver d : force.getParametersDrivers()) d.setSelected(model.equals("ecom2"));
            MatricesHarvester harvester = p.setupMatricesComputation("stm", null, null);
            double beta = 90 - Math.toDegrees(Vector3D.angle(sun.getPosition(epoch, gcrf), orbit.getPVCoordinates().getMomentum()));
            out.append(ci == 0 ? "" : ",\n");
            out.append(String.format("  {\"name\": \"%s\", \"block\": \"%s\", \"model\": \"%s\", \"massKg\": %.1f, \"raanDeg\": %.1f, \"betaDeg\": %.3f,\n",
                name, block, model, mass, raan, beta));
            StringBuilder samples = new StringBuilder(), accel = new StringBuilder(), jac = new StringBuilder(), stms = new StringBuilder();
            for (double t = 0; t <= DURATION + 1e-9; t += STEP) {
                AbsoluteDate date = epoch.shiftedBy(t);
                SpacecraftState state = p.propagate(date);
                PVCoordinates pv = state.getPVCoordinates(gcrf);
                Vector3D r = pv.getPosition(), v = pv.getVelocity();
                Vector3D a = force.acceleration(state, force.getParameters(date));
                samples.append(t == 0 ? "\n    " : ",\n    ").append(String.format("[%.1f, %.6f, %.6f, %.6f, %.9f, %.9f, %.9f, \"%s\"]",
                    t, r.getX(), r.getY(), r.getZ(), v.getX(), v.getY(), v.getZ(), date.toString(utc)));
                accel.append(t == 0 ? "\n    " : ",\n    ").append(String.format("[%.12e, %.12e, %.12e]", a.getX(), a.getY(), a.getZ()));
                RealMatrix phi = harvester.getStateTransitionMatrix(state);
                StringBuilder prow = new StringBuilder();
                for (int i = 0; i < 6; ++i) for (int j = 0; j < 6; ++j) prow.append(prow.length() == 0 ? "" : ", ").append(String.format("%.12e", phi.getEntry(i, j)));
                stms.append(t == 0 ? "\n    [" : ",\n    [").append(prow).append("]");
                if (model.equals("ecom2")) {
                    RealMatrix j = harvester.getParametersJacobian(state);
                    List<String> columns = harvester.getJacobiansColumnsNames();
                    StringBuilder row = new StringBuilder();
                    for (int i = 0; i < 6; ++i) for (String d : ECOM_DRIVERS) {
                        int k = -1;
                        for (int c = 0; c < columns.size(); ++c) if (columns.get(c).endsWith(ECOM2.ECOM_COEFFICIENT + " " + d + "0")) k = c;  // single-span name: "Span" + name + "0"
                        if (k < 0) throw new IllegalStateException("no column " + d + " in " + columns);
                        row.append(row.length() == 0 ? "" : ", ").append(String.format("%.12e", j.getEntry(i, k)));
                    }
                    jac.append(t == 0 ? "\n    [" : ",\n    [").append(row).append("]");
                }
            }
            out.append("   \"samples\": [").append(samples).append("],\n   \"acceleration\": [").append(accel).append("],\n   \"stm\": [").append(stms).append("]");
            if (model.equals("ecom2")) out.append(",\n   \"parameterJacobian\": [").append(jac).append("]");
            out.append("}");
            System.err.println(name + " beta " + beta + " done");
        }
        out.append("\n ]\n}\n");
        try (PrintWriter w = new PrintWriter(args[1], "UTF-8")) { w.print(out); }
    }

    static ParameterDriver driver(ForceModel f, String suffix) {
        for (ParameterDriver d : f.getParametersDrivers()) if (d.getName().equals(ECOM2.ECOM_COEFFICIENT + " " + suffix)) return d;
        throw new IllegalStateException("no driver " + suffix);
    }
}
