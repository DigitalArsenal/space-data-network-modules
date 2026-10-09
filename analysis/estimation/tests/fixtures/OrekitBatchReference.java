// Orekit 13.1 batch least-squares references for analysis/estimation's
// fit_batch (state at a reference epoch plus dynamic parameters).
//
// Orekit (CS GROUP, Apache-2.0) is the independent oracle. For each case it
//   1. propagates a truth orbit with a named force set (the force sets and
//      constants of propagator/hpop's tests/fixtures/orekit/OrekitReference.java,
//      so that HPOP reproduces these trajectories to about a centimetre a day),
//   2. samples positions (or positions and velocities) and adds Gaussian
//      noise drawn with java.util.Random (the algorithm is fixed by the Java
//      specification) through the Cholesky factor of the stated measurement
//      covariance,
//   3. runs BatchLSEstimator (Gauss-Newton) from a perturbed state and
//      parameter, estimating the GCRF Cartesian state at the epoch and the
//      drag coefficient (LEO) or the reflection coefficient (GPS),
// and writes the noisy observations, the a priori and Orekit's estimate and
// physical covariance, Cd and Cr converted to Cd*A/m (B) and Cr*A/m (AGOM).
//
// Run (single-file source launch):
//   java -cp "<jars>/*" OrekitBatchReference.java <orekit-data dir> <gfc dir> <out.json>
// <gfc dir> holds EGM2008-hpop.gfc written by
// propagator/hpop/tests/fixtures/orekit/make-gfc.mjs <dir>/EGM2008-hpop.gfc 70 3.986004415e14 6378136.3
import java.io.File;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Random;

import org.hipparchus.CalculusFieldElement;
import org.hipparchus.geometry.euclidean.threed.FieldVector3D;
import org.hipparchus.geometry.euclidean.threed.Vector3D;
import org.hipparchus.linear.CholeskyDecomposition;
import org.hipparchus.linear.MatrixUtils;
import org.hipparchus.linear.QRDecomposer;
import org.hipparchus.linear.RealMatrix;
import org.hipparchus.ode.nonstiff.DormandPrince853Integrator;
import org.hipparchus.optim.nonlinear.vector.leastsquares.GaussNewtonOptimizer;
import org.orekit.bodies.CelestialBody;
import org.orekit.bodies.CelestialBodyFactory;
import org.orekit.bodies.OneAxisEllipsoid;
import org.orekit.data.DataContext;
import org.orekit.data.DirectoryCrawler;
import org.orekit.estimation.leastsquares.BatchLSEstimator;
import org.orekit.estimation.measurements.ObservableSatellite;
import org.orekit.estimation.measurements.ObservedMeasurement;
import org.orekit.estimation.measurements.PV;
import org.orekit.estimation.measurements.Position;
import org.orekit.frames.LOFType;
import org.orekit.forces.ForceModel;
import org.orekit.forces.drag.DragForce;
import org.orekit.forces.drag.DragSensitive;
import org.orekit.forces.drag.IsotropicDrag;
import org.orekit.forces.gravity.HolmesFeatherstoneAttractionModel;
import org.orekit.forces.gravity.ThirdBodyAttraction;
import org.orekit.forces.gravity.potential.GravityFieldFactory;
import org.orekit.forces.gravity.potential.ICGEMFormatReader;
import org.orekit.forces.gravity.potential.NormalizedSphericalHarmonicsProvider;
import org.orekit.forces.radiation.IsotropicRadiationSingleCoefficient;
import org.orekit.forces.radiation.RadiationSensitive;
import org.orekit.forces.radiation.SolarRadiationPressure;
import org.orekit.frames.Frame;
import org.orekit.frames.FramesFactory;
import org.orekit.models.earth.atmosphere.Atmosphere;
import org.orekit.models.earth.atmosphere.NRLMSISE00;
import org.orekit.models.earth.atmosphere.NRLMSISE00InputParameters;
import org.orekit.orbits.CartesianOrbit;
import org.orekit.orbits.KeplerianOrbit;
import org.orekit.orbits.Orbit;
import org.orekit.orbits.OrbitType;
import org.orekit.orbits.PositionAngleType;
import org.orekit.propagation.Propagator;
import org.orekit.propagation.SpacecraftState;
import org.orekit.propagation.conversion.DormandPrince853IntegratorBuilder;
import org.orekit.propagation.conversion.NumericalPropagatorBuilder;
import org.orekit.propagation.numerical.NumericalPropagator;
import org.orekit.time.AbsoluteDate;
import org.orekit.time.FieldAbsoluteDate;
import org.orekit.time.TimeScale;
import org.orekit.time.TimeScalesFactory;
import org.orekit.utils.Constants;
import org.orekit.utils.ExtendedPositionProvider;
import org.orekit.utils.IERSConventions;
import org.orekit.utils.PVCoordinates;
import org.orekit.utils.ParameterDriver;

public class OrekitBatchReference {
    // propagator/hpop's Orekit constants (OrekitReference.java).
    static final double GM = 3.986004415e14, RE = 6378137.0;
    static final double AU = 149597870700.0, SOLAR_PRESSURE = 1361.0 / 299792458.0;
    static final double MASS = 1000.0, AREA = 20.0, CR = 1.3, CD = 2.2;
    static final double F107 = 150.0, F107A = 150.0, AP = 15.0;

    // The same mean-solar-time NRLMSISE-00 as OrekitReference.java.
    static final class MeanSolarTimeNRLMSISE00 implements Atmosphere {
        final NRLMSISE00 model; final Frame itrf;
        MeanSolarTimeNRLMSISE00(NRLMSISE00InputParameters weather, OneAxisEllipsoid earth, TimeScale utc) {
            itrf = earth.getBodyFrame();
            ExtendedPositionProvider meanSun = new ExtendedPositionProvider() {
                public Vector3D getPosition(AbsoluteDate date, Frame frame) {
                    double ut = date.getComponents(utc).getTime().getSecondsInLocalDay() / 3600;
                    double lambda = Math.toRadians(15 * (12 - ut));
                    double au = Constants.IAU_2012_ASTRONOMICAL_UNIT;
                    return itrf.getStaticTransformTo(frame, date).transformPosition(new Vector3D(au * Math.cos(lambda), au * Math.sin(lambda), 0));
                }
                public <T extends CalculusFieldElement<T>> FieldVector3D<T> getPosition(FieldAbsoluteDate<T> date, Frame frame) {
                    return new FieldVector3D<>(date.getField(), getPosition(date.toAbsoluteDate(), frame));
                }
            };
            model = new NRLMSISE00(weather, meanSun, earth, utc).withSwitch(9, 1);
        }
        public Frame getFrame() { return itrf; }
        public double getDensity(AbsoluteDate date, Vector3D position, Frame frame) {
            return model.getDensity(date, frame.getStaticTransformTo(itrf, date).transformPosition(position), itrf);
        }
        public <T extends CalculusFieldElement<T>> T getDensity(FieldAbsoluteDate<T> date, FieldVector3D<T> position, Frame frame) {
            return model.getDensity(date, frame.getStaticTransformTo(itrf, date).transformPosition(position), itrf);
        }
    }

    static final class Case {
        String name; double aKm, e, iDeg, raanDeg, argpDeg, mDeg; boolean drag;
        double spanSeconds, stepSeconds; double[][] covariance; long seed;
        double[] dr, dv; double aprioriCoefficient; String parameter;
        // pv: position-velocity measurements (6x6 covariance) instead of positions.
        boolean pv;
    }

    static List<ForceModel> forces(Case c, Frame itrf, TimeScale utc, double cd, double cr) {
        List<ForceModel> list = new ArrayList<>();
        NormalizedSphericalHarmonicsProvider field = GravityFieldFactory.getNormalizedProvider(20, 20);
        list.add(new HolmesFeatherstoneAttractionModel(itrf, field));
        list.add(new ThirdBodyAttraction(CelestialBodyFactory.getSun()));
        list.add(new ThirdBodyAttraction(CelestialBodyFactory.getMoon()));
        list.add(new SolarRadiationPressure(AU, SOLAR_PRESSURE, CelestialBodyFactory.getSun(), new OneAxisEllipsoid(RE, 0.0, itrf),
            new IsotropicRadiationSingleCoefficient(AREA, cr)));
        if (c.drag) {
            NRLMSISE00InputParameters weather = new NRLMSISE00InputParameters() {
                public AbsoluteDate getMinDate() { return AbsoluteDate.PAST_INFINITY; }
                public AbsoluteDate getMaxDate() { return AbsoluteDate.FUTURE_INFINITY; }
                public double getDailyFlux(AbsoluteDate date) { return F107; }
                public double getAverageFlux(AbsoluteDate date) { return F107A; }
                public double[] getAp(AbsoluteDate date) { return new double[] {AP, AP, AP, AP, AP, AP, AP}; }
            };
            OneAxisEllipsoid earth = new OneAxisEllipsoid(Constants.WGS84_EARTH_EQUATORIAL_RADIUS, Constants.WGS84_EARTH_FLATTENING, itrf);
            list.add(new DragForce(new MeanSolarTimeNRLMSISE00(weather, earth, utc), new IsotropicDrag(AREA, cd)));
        }
        return list;
    }

    static String vec(double[] v) {
        StringBuilder s = new StringBuilder("[");
        for (int i = 0; i < v.length; ++i) s.append(i == 0 ? "" : ", ").append(String.format("%.17g", v[i]));
        return s.append("]").toString();
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

        Case leo = new Case();
        leo.name = "LEO400-drag"; leo.aKm = 6778.137; leo.e = 0.0005; leo.iDeg = 51.6; leo.raanDeg = 30; leo.argpDeg = 40; leo.mDeg = 0; leo.drag = true;
        leo.spanSeconds = 86400; leo.stepSeconds = 300; leo.seed = 20261009L;
        leo.covariance = new double[][] {{25, 0, 0}, {0, 25, 0}, {0, 0, 25}};
        leo.dr = new double[] {400, -300, 200}; leo.dv = new double[] {0.3, -0.2, 0.1}; leo.aprioriCoefficient = 1.8; leo.parameter = "DRAG_AREA_OVER_MASS";
        Case gps = new Case();
        gps.name = "GPS-srp"; gps.aKm = 26559.7; gps.e = 0.005; gps.iDeg = 55; gps.raanDeg = 200; gps.argpDeg = 30; gps.mDeg = 45; gps.drag = false;
        gps.spanSeconds = 86400; gps.stepSeconds = 900; gps.seed = 20261010L;
        // Unequal component variances (m^2). BatchLSEstimator weights each
        // component by its theoretical standard deviation alone (the
        // correlation of a Position covariance is not used in the batch
        // normal equations), so the covariance is diagonal here; the module
        // receives it as the full 3x3 matrix.
        gps.covariance = new double[][] {{4, 0, 0}, {0, 25, 0}, {0, 0, 1}};
        gps.dr = new double[] {300, 200, -100}; gps.dv = new double[] {0.03, -0.02, 0.01}; gps.aprioriCoefficient = 1.0; gps.parameter = "SRP_AREA_OVER_MASS";

        StringBuilder out = new StringBuilder();
        out.append("{\n \"source\": \"Orekit 13.1 (CS GROUP, Apache-2.0) BatchLSEstimator, GaussNewtonOptimizer(QRDecomposer 1e-11), NumericalPropagatorBuilder DormandPrince853 (steps <= 10 s, dP 1e-4 m), GCRF; forces and constants of propagator/hpop tests/fixtures/orekit/OrekitReference.java\",\n");
        out.append(String.format(" \"epochUtc\": \"%s\",\n \"constants\": {\"gm\": %.10e, \"massKg\": %.1f, \"areaM2\": %.1f, \"cr\": %.2f, \"cd\": %.2f, \"f107\": %.1f, \"f107a\": %.1f, \"ap\": %.1f},\n",
            epoch.toString(utc), GM, MASS, AREA, CR, CD, F107, F107A, AP));
        out.append(" \"cases\": [\n");
        boolean firstCase = true;
        // GPS-pv: each measurement a full state, as a catalog element set's
        // state at its epoch is, every 3 h; sigmas 20, 50, 10 m and 0.005,
        // 0.002, 0.004 m/s. The fixture also states each measurement's
        // covariance in the radial, transverse, normal (QSW) axes of the
        // measured state, rotated by Orekit's LOFType.QSW.
        Case gpsPv = new Case();
        gpsPv.name = "GPS-pv"; gpsPv.aKm = 26559.7; gpsPv.e = 0.005; gpsPv.iDeg = 55; gpsPv.raanDeg = 200; gpsPv.argpDeg = 30; gpsPv.mDeg = 45; gpsPv.drag = false;
        gpsPv.spanSeconds = 86400; gpsPv.stepSeconds = 10800; gpsPv.seed = 20261011L; gpsPv.pv = true;
        gpsPv.covariance = new double[6][6];
        double[] pvSigma = {20, 50, 10, 0.005, 0.002, 0.004};
        for (int i = 0; i < 6; ++i) gpsPv.covariance[i][i] = pvSigma[i] * pvSigma[i];
        gpsPv.dr = new double[] {300, 200, -100}; gpsPv.dv = new double[] {0.03, -0.02, 0.01}; gpsPv.aprioriCoefficient = 1.0; gpsPv.parameter = "SRP_AREA_OVER_MASS";

        for (Case c : List.of(leo, gps, gpsPv)) {
            KeplerianOrbit kep = new KeplerianOrbit(c.aKm * 1000, c.e, Math.toRadians(c.iDeg), Math.toRadians(c.argpDeg),
                Math.toRadians(c.raanDeg), Math.toRadians(c.mDeg), PositionAngleType.MEAN, gcrf, epoch, GM);
            CartesianOrbit truthOrbit = new CartesianOrbit(kep.getPVCoordinates(), gcrf, epoch, GM);
            NumericalPropagator truth = new NumericalPropagator(new DormandPrince853Integrator(1e-3, 10, 1e-7, 1e-14));
            truth.setOrbitType(OrbitType.CARTESIAN);
            truth.setInitialState(new SpacecraftState(truthOrbit).withMass(MASS));
            for (ForceModel f : forces(c, itrf, utc, CD, CR)) truth.addForceModel(f);

            // Noisy positions: truth + L z, z standard normal from java.util.Random(seed).
            RealMatrix l = new CholeskyDecomposition(MatrixUtils.createRealMatrix(c.covariance), 1e-15, 1e-15).getL();
            Random random = new Random(c.seed);
            List<ObservedMeasurement<?>> measurements = new ArrayList<>();
            StringBuilder obs = new StringBuilder(), rtn = new StringBuilder();
            final int m = c.pv ? 6 : 3;
            ObservableSatellite sat = new ObservableSatellite(0);
            for (double t = c.stepSeconds; t <= c.spanSeconds + 1e-9; t += c.stepSeconds) {
                AbsoluteDate date = epoch.shiftedBy(t);
                PVCoordinates truePv = truth.propagate(date).getPVCoordinates(gcrf);
                double[] z = new double[m];
                for (int k = 0; k < m; ++k) z[k] = random.nextGaussian();
                double[] n = l.operate(z);
                Vector3D y = truePv.getPosition().add(new Vector3D(n[0], n[1], n[2]));
                StringBuilder row = new StringBuilder(String.format("[%.1f, \"%s\", %.6f, %.6f, %.6f", t, date.toString(utc), y.getX(), y.getY(), y.getZ()));
                if (c.pv) {
                    Vector3D yv = truePv.getVelocity().add(new Vector3D(n[3], n[4], n[5]));
                    measurements.add(new PV(date, y, yv, c.covariance, 1.0, sat));
                    row.append(String.format(", %.9f, %.9f, %.9f", yv.getX(), yv.getY(), yv.getZ()));
                    // M C M' blockwise, M the inertial -> QSW rotation at the measured state.
                    RealMatrix q = MatrixUtils.createRealMatrix(LOFType.QSW.rotationFromInertial(new PVCoordinates(y, yv)).getMatrix());
                    RealMatrix big = MatrixUtils.createRealMatrix(6, 6);
                    big.setSubMatrix(q.getData(), 0, 0);
                    big.setSubMatrix(q.getData(), 3, 3);
                    RealMatrix inRtn = big.multiply(MatrixUtils.createRealMatrix(c.covariance)).multiply(big.transpose());
                    double[] flat = new double[36];
                    for (int a = 0; a < 6; ++a) for (int b = 0; b < 6; ++b) flat[a * 6 + b] = inRtn.getEntry(a, b);
                    rtn.append(rtn.length() == 0 ? "\n    " : ",\n    ").append(vec(flat));
                } else {
                    measurements.add(new Position(date, y, c.covariance, 1.0, sat));
                }
                obs.append(obs.length() == 0 ? "\n    " : ",\n    ").append(row).append("]");
            }

            // The a priori: the truth perturbed, and the coefficient perturbed.
            PVCoordinates pv0 = truthOrbit.getPVCoordinates();
            Vector3D r0 = pv0.getPosition().add(new Vector3D(c.dr[0], c.dr[1], c.dr[2]));
            Vector3D v0 = pv0.getVelocity().add(new Vector3D(c.dv[0], c.dv[1], c.dv[2]));
            CartesianOrbit apriori = new CartesianOrbit(new PVCoordinates(r0, v0), gcrf, epoch, GM);
            NumericalPropagatorBuilder builder = new NumericalPropagatorBuilder(apriori, new DormandPrince853IntegratorBuilder(1e-3, 10, 1e-4), PositionAngleType.MEAN, 1.0);
            builder.setMass(MASS);
            double cd = c.drag ? c.aprioriCoefficient : CD, cr = c.drag ? CR : c.aprioriCoefficient;
            for (ForceModel f : forces(c, itrf, utc, cd, cr)) builder.addForceModel(f);
            String driver = c.drag ? DragSensitive.DRAG_COEFFICIENT : RadiationSensitive.REFLECTION_COEFFICIENT;
            for (ParameterDriver d : builder.getPropagationParametersDrivers().getDrivers()) if (d.getName().contains(driver)) d.setSelected(true);
            BatchLSEstimator estimator = new BatchLSEstimator(new GaussNewtonOptimizer(new QRDecomposer(1e-11), false), builder);
            estimator.setParametersConvergenceThreshold(1e-6);
            estimator.setMaxIterations(30);
            estimator.setMaxEvaluations(40);
            for (ObservedMeasurement<?> measurement : measurements) estimator.addMeasurement(measurement);
            Propagator[] estimated = estimator.estimate();
            PVCoordinates est = estimated[0].getInitialState().getPVCoordinates(gcrf);
            double coefficient = 0;
            for (ParameterDriver d : estimator.getPropagatorParametersDrivers(true).getDrivers()) if (d.getName().contains(driver)) coefficient = d.getValue();
            // Physical covariance, orbital drivers (Cartesian, GCRF) then the
            // coefficient; the coefficient row and column times A/m.
            RealMatrix p = estimator.getPhysicalCovariances(1e-12);
            int n = p.getRowDimension();
            double[] cov = new double[n * n];
            for (int i = 0; i < n; ++i) for (int j = 0; j < n; ++j) cov[i * n + j] = p.getEntry(i, j) * (i == 6 ? AREA / MASS : 1) * (j == 6 ? AREA / MASS : 1);
            double chi2 = 0; int count = 0;
            for (var e : estimator.getLastEstimations().entrySet()) {
                double[] o = e.getKey().getObservedValue(), x = e.getValue().getEstimatedValue();
                RealMatrix inv = MatrixUtils.inverse(MatrixUtils.createRealMatrix(c.covariance));
                double[] d = new double[m];
                for (int k = 0; k < m; ++k) d[k] = o[k] - x[k];
                double[] w = inv.operate(d);
                for (int k = 0; k < m; ++k) chi2 += d[k] * w[k];
                count += m;
            }
            if (!firstCase) out.append(",\n");
            firstCase = false;
            double[] flatCov = new double[m * m];
            for (int i = 0; i < m; ++i) for (int j = 0; j < m; ++j) flatCov[i * m + j] = c.covariance[i][j];
            out.append(String.format("  {\"name\": \"%s\", \"orbit\": {\"aKm\": %.3f, \"e\": %.4f, \"iDeg\": %.1f, \"raanDeg\": %.1f, \"argpDeg\": %.1f, \"mDeg\": %.1f},\n", c.name, c.aKm, c.e, c.iDeg, c.raanDeg, c.argpDeg, c.mDeg));
            out.append(String.format("   \"forces\": {\"degree\": 20, \"order\": 20, \"thirdBodies\": true, \"srp\": true, \"drag\": %b},\n", c.drag));
            out.append(String.format("   \"parameter\": \"%s\", \"truthParameter\": %.17g, \"aprioriParameter\": %.17g,\n", c.parameter,
                (c.drag ? CD : CR) * AREA / MASS, c.aprioriCoefficient * AREA / MASS));
            out.append("   \"truth\": " + vec(new double[] {pv0.getPosition().getX(), pv0.getPosition().getY(), pv0.getPosition().getZ(), pv0.getVelocity().getX(), pv0.getVelocity().getY(), pv0.getVelocity().getZ()}) + ",\n");
            out.append("   \"apriori\": " + vec(new double[] {r0.getX(), r0.getY(), r0.getZ(), v0.getX(), v0.getY(), v0.getZ()}) + ",\n");
            out.append("   \"measurementCovariance\": " + vec(flatCov) + ",\n");
            out.append(String.format("   \"orekit\": {\"iterations\": %d, \"evaluations\": %d, \"chiSquare\": %.17g, \"scalarCount\": %d,\n", estimator.getIterationsCount(), estimator.getEvaluationsCount(), chi2, count));
            out.append("    \"estimate\": " + vec(new double[] {est.getPosition().getX(), est.getPosition().getY(), est.getPosition().getZ(), est.getVelocity().getX(), est.getVelocity().getY(), est.getVelocity().getZ(), coefficient * AREA / MASS}) + ",\n");
            out.append("    \"covariance\": " + vec(cov) + "},\n");
            if (c.pv) out.append("   \"rtnCovariances\": [" + rtn + "],\n");
            out.append(String.format("   \"measurement\": \"%s\",\n", c.pv ? "POSITION_VELOCITY" : "POSITION_VECTOR"));
            out.append("   \"observations\": [" + obs + "]}");
            System.err.println(c.name + ": " + estimator.getIterationsCount() + " iterations, coefficient " + coefficient);
        }
        out.append("\n ]\n}\n");
        try (PrintWriter w = new PrintWriter(args[2], "UTF-8")) { w.print(out); }
    }
}
