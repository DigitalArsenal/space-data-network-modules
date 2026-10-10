// Orekit 13.1 reference states for files/orbit-products normalize_ses_i11.
//
//   javac -cp 'orekit-13.1.jar:hipparchus-*.jar' GenerateReference.java
//   java -cp '.:orekit-13.1.jar:hipparchus-*.jar' GenerateReference <orekit-data dir> > orekit-13.1-reference.json
//
// IntelsatElevenElementsPropagator.propagateInEcef gives the Earth-fixed
// position and velocity the module must reproduce (no frame transform enters:
// the module labels its states FIXED_EARTH, as the format does).
import java.io.File;
import java.util.Locale;
import org.orekit.data.DataContext;
import org.orekit.data.DirectoryCrawler;
import org.orekit.propagation.analytical.intelsat.IntelsatElevenElements;
import org.orekit.propagation.analytical.intelsat.IntelsatElevenElementsPropagator;
import org.orekit.time.AbsoluteDate;
import org.orekit.time.TimeScalesFactory;
import org.orekit.utils.PVCoordinates;

public class GenerateReference {
    // name, epoch (UTC), LM0, LM1, LM2, LONC, LONC1, LONS, LONS1, LATC, LATC1, LATS, LATS1
    static final Object[][] SETS = {
        // Orekit 13.1's own test set: Intelsat calculator, spacecraft 4521, 2023-12-04.
        {"intelsat-4521", "2023-12-04T00:00:00.000", 302.0058, -0.0096, -0.000629, 0.0297, -0.0004, -0.0194, 0.0007, 0.0378, -0.0018, -0.0011, 0.0015},
        // An inclined, drifting geostationary orbit: every term large enough to matter.
        {"inclined-drifting", "2026-09-08T23:15:00.000", 28.1905, 0.35, 0.0012, 0.215, -0.004, -0.183, 0.003, 2.41, -0.0021, -1.37, 0.0018},
        // Station-kept, negative drift, west longitude.
        {"west-stationkept", "2026-03-01T12:30:30.000", -55.5, -0.0128, 0.001111, -0.0342, -0.0002, 0.0017, -0.0001, 0.0036, -0.0006, 0.0212, 0.0005},
    };
    public static void main(String[] args) {
        DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(new File(args[0])));
        StringBuilder out = new StringBuilder("{\n \"generator\": \"Orekit 13.1 IntelsatElevenElementsPropagator.propagateInEcef\",\n \"units\": \"m, m/s, Earth-fixed; t in seconds after the element epoch\",\n \"sets\": [\n");
        for (int s = 0; s < SETS.length; ++s) {
            Object[] e = SETS[s];
            AbsoluteDate epoch = new AbsoluteDate((String) e[1], TimeScalesFactory.getUTC());
            double[] p = new double[11];
            for (int k = 0; k < 11; ++k) p[k] = (Double) e[k + 2];
            IntelsatElevenElements el = new IntelsatElevenElements(epoch, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10]);
            IntelsatElevenElementsPropagator prop = new IntelsatElevenElementsPropagator(el);
            out.append(String.format(Locale.ROOT, "  {\"name\": \"%s\", \"epoch\": \"%sZ\", \"elements\": [", e[0], e[1]));
            for (int k = 0; k < 11; ++k) out.append(String.format(Locale.ROOT, "%s%.17g", k == 0 ? "" : ", ", p[k]));
            out.append("],\n   \"states\": [\n");
            boolean first = true;
            for (double t = 0; t <= 170 * 3600.0 + 1e-6; t += 18000.0) {
                for (double dt : new double[] {0, 1234.5}) {
                    if (t + dt > 170 * 3600.0 + 1e-6) continue;
                    PVCoordinates pv = prop.propagateInEcef(epoch.shiftedBy(t + dt));
                    out.append(String.format(Locale.ROOT, "%s    {\"t\": %.1f, \"lon\": %.17g, \"lat\": %.17g, \"r\": %.17g, \"p\": [%.17g, %.17g, %.17g], \"v\": [%.17g, %.17g, %.17g]}",
                        first ? "" : ",\n", t + dt, prop.getEastLongitudeDegrees().getValue(), prop.getGeocentricLatitudeDegrees().getValue(), prop.getOrbitRadius().getValue(),
                        pv.getPosition().getX(), pv.getPosition().getY(), pv.getPosition().getZ(), pv.getVelocity().getX(), pv.getVelocity().getY(), pv.getVelocity().getZ()));
                    first = false;
                }
            }
            out.append(s + 1 < SETS.length ? "\n   ]},\n" : "\n   ]}\n");
        }
        out.append(" ]\n}\n");
        System.out.print(out);
    }
}
