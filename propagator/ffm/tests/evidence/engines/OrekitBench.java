// Orekit on the engine benchmark plan (plan.mjs, plan.tsv).
//
// Orekit (CS GROUP, Apache-2.0) is a reference engine: each case starts from
// the plan's GCRF state and is propagated with the plan's force tier and
// integrator; GCRF states are written every sample step. The force models
// are Orekit's own, configured as FFM's (tests/fixtures/orekit/
// OrekitReference.java documents each constant); this file only selects them.
//
//   java -cp "<jars>/*" OrekitBench.java <orekit-data dir> <work dir> <out.json> single [only] [reps]
//   java -cp "<jars>/*" OrekitBench.java <orekit-data dir> <work dir> <out.json> threads <only> <threads> <copies>
//
// single: each case once to warm up, then `reps` timed runs (smallest kept);
//   the timing is this thread's CPU time inside propagate() (construction
//   apart, as FFM's fixed call cost is apart).
// threads: `copies` propagations of the one case matching `only` on a pool of
//   `threads` threads (each builds its own propagator); total thread CPU and
//   wall time.
//
// Matching FFM (differences stated):
//   - field: FFM's embedded EGM2008 70x70 (EGM2008-ffm-70.gfc), Holmes and
//     Featherstone, GM 3.986004415e14, R 6378136.3 m, in ITRF (IERS 2010) with
//     the finals2000A daily rows only (simple EOP, as FFM reads them);
//   - Sun, Moon, Venus, Mars and Jupiter (barycenters) from JPL DE440;
//   - cannonball radiation pressure, 1361 W/m^2 at 1 au, conical shadow of a
//     6378137 m sphere; Knocke albedo + infrared on 15 degree elements;
//   - NRLMSISE-00 on mean local solar time with the daily Ap, constant space
//     weather, WGS84 heights; FFM-1 applies no drag above 2,500 km over the
//     6378.137 km sphere, so the FFM1 tier wraps the atmosphere with that cutoff;
//   - IERS 2010 solid tides (no pole tide) and FES2004 30x30 ocean tides, each
//     with Orekit's default coefficient cache (600 s, 12 points); IERS 2010
//     relativity (Schwarzschild, Lense-Thirring, de Sitter, the latter in the
//     state's frame as OrekitReference.java's FrameConsistentDeSitter);
//   - integrator: Hipparchus DormandPrince853 (12 evaluations a step, first same
//     as last). Hipparchus has no RK8(7)13M. Error norm: root mean square of
//     err/(abs + rel |y|) over the components (FFM: the largest component). The
//     fixed-step setting uses min step = max step with tolerances that never
//     reject.
import java.io.File;
import java.io.PrintWriter;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;

import org.hipparchus.CalculusFieldElement;
import org.hipparchus.geometry.euclidean.threed.FieldVector3D;
import org.hipparchus.geometry.euclidean.threed.Vector3D;
import org.hipparchus.ode.nonstiff.DormandPrince853Integrator;
import org.orekit.bodies.CelestialBody;
import org.orekit.bodies.CelestialBodyFactory;
import org.orekit.bodies.OneAxisEllipsoid;
import org.orekit.data.DataContext;
import org.orekit.data.DirectoryCrawler;
import org.orekit.forces.drag.DragForce;
import org.orekit.forces.drag.IsotropicDrag;
import org.orekit.forces.gravity.DeSitterRelativity;
import org.orekit.forces.gravity.HolmesFeatherstoneAttractionModel;
import org.orekit.forces.gravity.LenseThirringRelativity;
import org.orekit.forces.gravity.OceanTides;
import org.orekit.forces.gravity.Relativity;
import org.orekit.forces.gravity.SolidTides;
import org.orekit.forces.gravity.ThirdBodyAttraction;
import org.orekit.forces.gravity.potential.GravityFieldFactory;
import org.orekit.forces.gravity.potential.ICGEMFormatReader;
import org.orekit.forces.gravity.potential.NormalizedSphericalHarmonicsProvider;
import org.orekit.forces.gravity.potential.TideSystem;
import org.orekit.forces.radiation.IsotropicRadiationSingleCoefficient;
import org.orekit.forces.radiation.KnockeRediffusedForceModel;
import org.orekit.forces.radiation.SolarRadiationPressure;
import org.orekit.frames.Frame;
import org.orekit.frames.FramesFactory;
import org.orekit.models.earth.atmosphere.Atmosphere;
import org.orekit.models.earth.atmosphere.NRLMSISE00;
import org.orekit.models.earth.atmosphere.NRLMSISE00InputParameters;
import org.orekit.orbits.CartesianOrbit;
import org.orekit.orbits.OrbitType;
import org.orekit.propagation.SpacecraftState;
import org.orekit.propagation.numerical.NumericalPropagator;
import org.orekit.time.AbsoluteDate;
import org.orekit.time.FieldAbsoluteDate;
import org.orekit.time.TimeScale;
import org.orekit.time.TimeScalesFactory;
import org.orekit.time.UT1Scale;
import org.orekit.utils.Constants;
import org.orekit.utils.ExtendedPositionProvider;
import org.orekit.utils.IERSConventions;
import org.orekit.utils.PVCoordinates;
import org.orekit.utils.TimeStampedPVCoordinates;

public class OrekitBench {
    static Map<String, String> G = new HashMap<>();
    static double g(String k) { return Double.parseDouble(G.get(k)); }

    static final class Case {
        String id, orbit, tier, integrator, kind; double stepS, rel, abs, init, min, max; double[] pv = new double[6];
        int degree, order; String[] bodies; boolean srp, drag, tides, relativity; double cutoffKm, knockeDeg; int ocean;
        // Catalog objects: own epoch, unit mass and area with Cd*A/m and Cr*A/m (null/NaN: the plan's).
        AbsoluteDate epoch = null; double mass = Double.NaN, area = Double.NaN, cd = Double.NaN, cr = Double.NaN;
        Case copy() {
            Case c = new Case();
            c.id = id; c.orbit = orbit; c.tier = tier; c.integrator = integrator; c.kind = kind; c.stepS = stepS; c.rel = rel; c.abs = abs;
            c.init = init; c.min = min; c.max = max; c.pv = pv.clone(); c.degree = degree; c.order = order; c.bodies = bodies; c.srp = srp;
            c.drag = drag; c.tides = tides; c.relativity = relativity; c.cutoffKm = cutoffKm; c.knockeDeg = knockeDeg; c.ocean = ocean;
            return c;
        }
        AbsoluteDate t0() { return epoch != null ? epoch : OrekitBench.epoch; }
        double mass() { return Double.isNaN(mass) ? g("massKg") : mass; }
        double area() { return Double.isNaN(area) ? g("areaM2") : area; }
        double cd() { return Double.isNaN(cd) ? g("cd") : cd; }
        double cr() { return Double.isNaN(cr) ? g("cr") : cr; }
    }

    static List<Case> readPlan(File tsv) throws Exception {
        List<Case> cases = new ArrayList<>();
        for (String line : Files.readAllLines(tsv.toPath())) {
            String[] f = line.split("\t");
            if (f[0].equals("global")) { G.put(f[1], f[2]); continue; }
            Case c = new Case(); int i = 1;
            c.id = f[i++]; c.orbit = f[i++]; c.tier = f[i++]; c.integrator = f[i++]; c.kind = f[i++];
            c.stepS = Double.parseDouble(f[i++]); c.rel = Double.parseDouble(f[i++]); c.abs = Double.parseDouble(f[i++]);
            c.init = Double.parseDouble(f[i++]); c.min = Double.parseDouble(f[i++]); c.max = Double.parseDouble(f[i++]);
            for (int k = 0; k < 6; ++k) c.pv[k] = Double.parseDouble(f[i++]);
            c.degree = Integer.parseInt(f[i++]); c.order = Integer.parseInt(f[i++]);
            c.bodies = f[i++].split(","); c.srp = f[i++].equals("1"); c.drag = f[i++].equals("1");
            c.cutoffKm = Double.parseDouble(f[i++]); c.tides = f[i++].equals("1"); c.ocean = Integer.parseInt(f[i++]);
            c.relativity = f[i++].equals("1"); c.knockeDeg = Double.parseDouble(f[i++]);
            cases.add(c);
        }
        return cases;
    }

    // IERS 2010 eq. 10.12 de Sitter with every vector in the state's frame
    // (see tests/fixtures/orekit/OrekitReference.java).
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

    // NRLMSISE-00 on mean local solar time with the daily Ap, and optionally
    // no density above `cutoffM` over the 6378137 m sphere (FFM-1's drag cutoff).
    static final class FfmAtmosphere implements Atmosphere {
        final NRLMSISE00 model; final Frame itrf; final double cutoffM;
        FfmAtmosphere(NRLMSISE00InputParameters weather, OneAxisEllipsoid earth, TimeScale utc, double cutoffM) {
            itrf = earth.getBodyFrame(); this.cutoffM = cutoffM;
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
            Vector3D p = frame.getStaticTransformTo(itrf, date).transformPosition(position);
            if (cutoffM > 0 && p.getNorm() - Constants.WGS84_EARTH_EQUATORIAL_RADIUS > cutoffM) return 0.0;
            return model.getDensity(date, p, itrf);
        }
        public <T extends CalculusFieldElement<T>> T getDensity(FieldAbsoluteDate<T> date, FieldVector3D<T> position, Frame frame) {
            FieldVector3D<T> p = frame.getStaticTransformTo(itrf, date).transformPosition(position);
            if (cutoffM > 0 && p.getNorm().getReal() - Constants.WGS84_EARTH_EQUATORIAL_RADIUS > cutoffM) return date.getField().getZero();
            return model.getDensity(date, p, itrf);
        }
    }

    static Frame gcrf, itrf; static TimeScale utc; static AbsoluteDate epoch; static NormalizedSphericalHarmonicsProvider field70;

    static DormandPrince853Integrator lastIntegrator;
    static NumericalPropagator build(Case c, AtomicLong evaluations) {
        final double gm = g("gm"), ae = g("fieldRadiusM"), mass = c.mass(), area = c.area();
        DormandPrince853Integrator integrator;
        // Seven components: position, velocity, mass.
        if (c.kind.equals("fixed")) {
            integrator = new DormandPrince853Integrator(c.stepS, c.stepS, new double[] {1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6}, new double[] {1, 1, 1, 1, 1, 1, 1});
            integrator.setInitialStepSize(c.stepS);
        } else {
            double[] abs = {c.abs, c.abs, c.abs, c.abs, c.abs, c.abs, 1e3}, rel = {c.rel, c.rel, c.rel, c.rel, c.rel, c.rel, c.rel};
            integrator = new DormandPrince853Integrator(c.min, c.max, abs, rel);
            integrator.setInitialStepSize(c.init);
        }
        lastIntegrator = integrator;
        NumericalPropagator p = new NumericalPropagator(integrator);
        p.setOrbitType(OrbitType.CARTESIAN);
        CartesianOrbit orbit = new CartesianOrbit(new PVCoordinates(new Vector3D(c.pv[0], c.pv[1], c.pv[2]), new Vector3D(c.pv[3], c.pv[4], c.pv[5])), gcrf, c.t0(), gm);
        p.setInitialState(new SpacecraftState(orbit).withMass(mass));
        p.addForceModel(new HolmesFeatherstoneAttractionModel(itrf, GravityFieldFactory.getNormalizedProvider(c.degree, c.order)));
        CelestialBody sun = CelestialBodyFactory.getSun(), moon = CelestialBodyFactory.getMoon();
        for (String b : c.bodies) switch (b) {
            case "SUN": p.addForceModel(new ThirdBodyAttraction(sun)); break;
            case "MOON": p.addForceModel(new ThirdBodyAttraction(moon)); break;
            case "VENUS_BARYCENTER": p.addForceModel(new ThirdBodyAttraction(CelestialBodyFactory.getVenus())); break;
            case "MARS_BARYCENTER": p.addForceModel(new ThirdBodyAttraction(CelestialBodyFactory.getMars())); break;
            case "JUPITER_BARYCENTER": p.addForceModel(new ThirdBodyAttraction(CelestialBodyFactory.getJupiter())); break;
            default: throw new IllegalArgumentException(b);
        }
        IsotropicRadiationSingleCoefficient spacecraft = new IsotropicRadiationSingleCoefficient(area, c.cr());
        if (c.srp) p.addForceModel(new SolarRadiationPressure(g("auM"), g("solarPressureAt1AuNm2"), sun, new OneAxisEllipsoid(g("shadowRadiusM"), 0.0, itrf), spacecraft));
        if (c.knockeDeg > 0) p.addForceModel(new KnockeRediffusedForceModel(sun, spacecraft, Constants.WGS84_EARTH_EQUATORIAL_RADIUS, Math.toRadians(c.knockeDeg)));
        UT1Scale ut1 = TimeScalesFactory.getUT1(IERSConventions.IERS_2010, true);
        if (c.ocean > 0) p.addForceModel(new OceanTides(itrf, ae, gm, false, OceanTides.DEFAULT_STEP, OceanTides.DEFAULT_POINTS, c.ocean, c.ocean, IERSConventions.IERS_2010, ut1));
        if (c.tides) p.addForceModel(new SolidTides(itrf, ae, gm, TideSystem.TIDE_FREE, false, SolidTides.DEFAULT_STEP, SolidTides.DEFAULT_POINTS, IERSConventions.IERS_2010, ut1, sun, moon));
        if (c.relativity) {
            p.addForceModel(new Relativity(gm));
            p.addForceModel(new LenseThirringRelativity(gm, itrf));
            p.addForceModel(new FrameConsistentDeSitter());
        }
        if (c.drag) {
            final double f107 = g("f107"), f107a = g("f107a"), ap = g("ap");
            NRLMSISE00InputParameters weather = new NRLMSISE00InputParameters() {
                public AbsoluteDate getMinDate() { return AbsoluteDate.PAST_INFINITY; }
                public AbsoluteDate getMaxDate() { return AbsoluteDate.FUTURE_INFINITY; }
                public double getDailyFlux(AbsoluteDate date) { return f107; }
                public double getAverageFlux(AbsoluteDate date) { return f107a; }
                public double[] getAp(AbsoluteDate date) { return new double[] {ap, ap, ap, ap, ap, ap, ap}; }
            };
            OneAxisEllipsoid earth = new OneAxisEllipsoid(Constants.WGS84_EARTH_EQUATORIAL_RADIUS, Constants.WGS84_EARTH_FLATTENING, itrf);
            p.addForceModel(new DragForce(new FfmAtmosphere(weather, earth, utc, c.cutoffKm * 1000), new IsotropicDrag(area, c.cd())));
        }
        return p;
    }

    static final class Run { double cpuS, wallS; long evaluations; List<double[]> samples = new ArrayList<>(); }

    static Run run(Case c) {
        ThreadMXBean mx = ManagementFactory.getThreadMXBean();
        NumericalPropagator p;
        DormandPrince853Integrator integrator;
        synchronized (OrekitBench.class) { p = build(c, null); integrator = lastIntegrator; }  // lastIntegrator is shared
        Run r = new Run();
        double step = g("sampleStepS"), span = g("days") * 86400;
        p.setStepHandler(step, (SpacecraftState s) -> {
            Vector3D x = s.getPVCoordinates(gcrf).getPosition();
            r.samples.add(new double[] {s.getDate().durationFrom(epoch), x.getX(), x.getY(), x.getZ()});
        });
        long c0 = mx.getCurrentThreadCpuTime(), w0 = System.nanoTime();
        p.propagate(epoch.shiftedBy(span));
        r.cpuS = (mx.getCurrentThreadCpuTime() - c0) / 1e9; r.wallS = (System.nanoTime() - w0) / 1e9;
        r.evaluations = integrator.getEvaluations();
        return r;
    }

    public static void main(String[] args) throws Exception {
        Locale.setDefault(Locale.ROOT);
        System.setProperty("orekit.simpleEOP", "true");
        File data = new File(args[0]), work = new File(args[1]);
        DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(data));
        DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(work));
        List<Case> cases = readPlan(new File(work, "plan.tsv"));
        GravityFieldFactory.clearPotentialCoefficientsReaders();
        GravityFieldFactory.addPotentialCoefficientsReader(new ICGEMFormatReader(G.get("gfc"), false));
        utc = TimeScalesFactory.getUTC();
        epoch = new AbsoluteDate(G.get("epochUtc"), utc);
        gcrf = FramesFactory.getGCRF();
        itrf = FramesFactory.getITRF(IERSConventions.IERS_2010, true);
        String mode = args[3];
        StringBuilder out = new StringBuilder();
        out.append(String.format("{\"engine\": \"Orekit\", \"version\": \"Orekit %s, Hipparchus %s\", \"runtime\": \"Java %s (%s)\",\n",
            AbsoluteDate.class.getPackage().getImplementationVersion(), DormandPrince853Integrator.class.getPackage().getImplementationVersion(),
            System.getProperty("java.version"), System.getProperty("java.vm.name")));
        if (mode.equals("single")) {
            String only = args.length > 4 ? args[4] : "";
            int reps = args.length > 5 ? Integer.parseInt(args[5]) : 2;
            out.append(" \"reps\": " + reps + ", \"results\": [\n");
            boolean first = true;
            for (Case c : cases) {
                if (!c.id.contains(only)) continue;
                Run best = run(c);
                for (int i = 0; i < reps; ++i) { Run r = run(c); if (r.cpuS < best.cpuS) best = r; }
                System.err.printf("%s: %.4f CPU-s/object-day, %d evaluations, %.2f us/eval%n", c.id, best.cpuS / g("days"), best.evaluations, 1e6 * best.cpuS / best.evaluations);
                if (!first) out.append(",\n");
                first = false;
                String method = c.kind.equals("fixed") ? String.format("DormandPrince853 (Hipparchus, 8(5,3), 12 evaluations a step) fixed %.0f s", c.stepS)
                    : String.format("DormandPrince853 (Hipparchus, 8(5,3)) rel %s abs %s m, m/s, max step %.0f s; error norm: RMS over components of err/(abs + rel |y|)", c.rel, c.abs, c.max);
                out.append(String.format("  {\"engine\": \"Orekit\", \"id\": \"%s\", \"orbit\": \"%s\", \"tier\": \"%s\", \"integrator\": \"%s\", \"method\": \"%s\", \"cpuS\": %.6f, \"wallS\": %.6f, \"propagationCpuS\": %.6f, \"cpuSPerObjectDay\": %.6f, \"evaluations\": %d, \"usPerEvaluation\": %.4f, \"samples\": [",
                    c.id, c.orbit, c.tier, c.integrator, method, best.cpuS, best.wallS, best.cpuS, best.cpuS / g("days"), best.evaluations, 1e6 * best.cpuS / best.evaluations));
                for (int k = 0; k < best.samples.size(); ++k) {
                    double[] s = best.samples.get(k);
                    out.append(String.format("%s[%.3f, %.6f, %.6f, %.6f]", k == 0 ? "" : ", ", s[0], s[1], s[2], s[3]));
                }
                out.append("]}");
            }
            out.append("\n ]}\n");
        } else if (mode.equals("catalog")) {
            // catalog <states.tsv> <startUtc> <days> <threads> <rel> <abs> <maxStepS> <results.tsv>
            File states = new File(args[4]); AbsoluteDate start = new AbsoluteDate(args[5], utc);
            double days = Double.parseDouble(args[6]); int threads = Integer.parseInt(args[7]);
            double rel = Double.parseDouble(args[8]), abs = Double.parseDouble(args[9]), maxStep = Double.parseDouble(args[10]);
            Case template = cases.stream().filter(x -> x.tier.equals("FFM1")).findFirst().orElseThrow();
            List<Case> objects = new ArrayList<>(); List<String> ids = new ArrayList<>();
            for (String line : Files.readAllLines(states.toPath())) {
                if (line.isBlank()) continue;
                String[] f = line.split("\t");
                Case c = template.copy();
                c.id = f[0]; c.kind = "adaptive"; c.rel = rel; c.abs = abs; c.init = 30; c.min = 0.01; c.max = maxStep;
                String iso = f[1].endsWith("Z") ? f[1].substring(0, f[1].length() - 1) : f[1];
                c.epoch = new AbsoluteDate(iso, utc);
                for (int k = 0; k < 6; ++k) c.pv[k] = Double.parseDouble(f[2 + k]);
                c.mass = 1; c.area = 1; c.cd = Double.parseDouble(f[8]); c.cr = Double.parseDouble(f[9]);
                objects.add(c); ids.add(f[0]);
            }
            final AbsoluteDate end = start.shiftedBy(days * 86400);
            ExecutorService pool = Executors.newFixedThreadPool(threads);
            List<Future<String>> futures = new ArrayList<>();
            long w0 = System.nanoTime();
            for (Case c : objects) futures.add(pool.submit(() -> {
                ThreadMXBean mx = ManagementFactory.getThreadMXBean();
                long propagationNs = 0, buildNs = 0;
                String status = "ok";
                try {
                    // From the object's epoch through [start, end]: backward to the start when the epoch is later.
                    for (AbsoluteDate target : c.t0().isAfter(start) ? List.of(start, end) : List.of(end)) {
                        // Construction (field, tide and atmosphere models) is timed apart, as FFM's
                        // ingest is apart from its windows; builds run in parallel.
                        long b0 = mx.getCurrentThreadCpuTime();
                        NumericalPropagator p = build(c, null);
                        // FFM's physical stop: 100 km above the WGS84 ellipsoid.
                        p.addEventDetector(new org.orekit.propagation.events.AltitudeDetector(100e3,
                            new OneAxisEllipsoid(Constants.WGS84_EARTH_EQUATORIAL_RADIUS, Constants.WGS84_EARTH_FLATTENING, itrf))
                            .withHandler(new org.orekit.propagation.events.handlers.StopOnDecreasing()));
                        long c0 = mx.getCurrentThreadCpuTime();
                        buildNs += c0 - b0;
                        SpacecraftState s = p.propagate(target);
                        propagationNs += mx.getCurrentThreadCpuTime() - c0;
                        if (Math.abs(s.getDate().durationFrom(target)) > 1e-6) { status = "reentry"; break; }
                    }
                } catch (Exception e) { status = "error:" + e.getClass().getSimpleName(); }
                return c.id + "\t" + (propagationNs / 1e9) + "\t" + status + "\t" + (buildNs / 1e9);
            }));
            StringBuilder rows = new StringBuilder(); double cpu = 0; int n = 0, failed = 0;
            for (Future<String> f : futures) {
                String r = f.get(); rows.append(r).append('\n'); String[] x = r.split("\t");
                cpu += Double.parseDouble(x[1]); ++n; if (!x[2].equals("ok")) ++failed;
                if (n % 100 == 0) System.err.printf("%d/%d objects, %.1f s wall%n", n, objects.size(), (System.nanoTime() - w0) / 1e9);
            }
            double wall = (System.nanoTime() - w0) / 1e9;
            pool.shutdown();
            try (PrintWriter w = new PrintWriter(args[11])) { w.print(rows); }
            System.err.printf("catalog %d objects on %d threads: wall %.1f s, thread CPU %.1f s, %d not ok%n", n, threads, wall, cpu, failed);
            out.append(String.format(" \"mode\": \"catalog\", \"objects\": %d, \"threads\": %d, \"startUtc\": \"%s\", \"days\": %s, \"rel\": %s, \"abs\": %s, \"maxStepS\": %s, \"wallS\": %.3f, \"threadCpuS\": %.3f, \"notOk\": %d}\n",
                n, threads, args[5], args[6], args[8], args[9], args[10], wall, cpu, failed));
        } else if (mode.equals("threads")) {
            String only = args[4]; int threads = Integer.parseInt(args[5]), copies = Integer.parseInt(args[6]);
            Case c = cases.stream().filter(x -> x.id.equals(only)).findFirst().orElseThrow();
            run(c);  // warm-up on this thread
            ExecutorService pool = Executors.newFixedThreadPool(threads);
            List<Future<Run>> futures = new ArrayList<>();
            long w0 = System.nanoTime();
            for (int i = 0; i < copies; ++i) futures.add(pool.submit(() -> run(c)));
            double cpu = 0;
            for (Future<Run> f : futures) cpu += f.get().cpuS;
            double wall = (System.nanoTime() - w0) / 1e9;
            pool.shutdown();
            System.err.printf("%s x %d on %d threads: wall %.2f s, total thread CPU %.2f s, %.4f CPU-s/object-day%n", c.id, copies, threads, wall, cpu, cpu / copies / g("days"));
            out.append(String.format(" \"mode\": \"threads\", \"id\": \"%s\", \"threads\": %d, \"copies\": %d, \"wallS\": %.6f, \"threadCpuS\": %.6f, \"cpuSPerObjectDay\": %.6f}\n",
                c.id, threads, copies, wall, cpu, cpu / copies / g("days")));
        }
        try (PrintWriter w = new PrintWriter(args[2])) { w.print(out); }
    }
}
