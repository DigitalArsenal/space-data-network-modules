// Offline independent reference: Orekit 13.1, IERS 1996 classical frames
// without EOP corrections, and IERS 2010 CIO ITRF with simple EOP.
// Classical EME2000 is the bias-free J2000 origin called GCRF by FFM coords;
// the ITRF reference starts at true GCRF and includes frame bias.
// Use noninterpolating frame providers so only EOP interpolation remains.
// Orekit permits EOP degree 4k-1: 3 is its minimum, not linear interpolation.
import java.io.*;
import java.util.*;
import org.orekit.data.*;
import org.orekit.frames.*;
import org.orekit.time.*;
import org.orekit.utils.IERSConventions;

public class OrekitFrames {
    static void matrix(String key, Frame from, Frame to, AbsoluteDate date) {
        double[][] m = FramesFactory.getNonInterpolatingTransform(from, to, date).getRotation().getMatrix();
        System.out.print(",\"" + key + "\":[");
        for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j)
            System.out.printf(Locale.ROOT, "%.17g%s", m[i][j], i == 2 && j == 2 ? "]" : ",");
    }
    public static void main(String[] args) throws Exception {
        DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(new File(args[0])));
        FramesFactory.clearEOPHistoryLoaders();
        FramesFactory.addDefaultEOP2000HistoryLoaders("^finals2000A\\.all$", "(?!)", "(?!)", "(?!)", "(?!)", "(?!)");
        UTCScale utc = TimeScalesFactory.getUTC();
        EOPHistory loaded = FramesFactory.getEOPHistory(IERSConventions.IERS_2010, true);
        EOPHistory eop = new EOPHistory(IERSConventions.IERS_2010, 3, loaded.getEntries(), true, DataContext.getDefault().getTimeScales());
        Frame itrf = FramesFactory.buildUncachedITRF(eop, utc);
        Frame eme2000 = FramesFactory.getEME2000();
        Frame mod = FramesFactory.getMOD(false), tod = FramesFactory.getTOD(false), teme = FramesFactory.getTEME();
        try (BufferedReader in = new BufferedReader(new InputStreamReader(System.in))) {
            String line;
            while ((line = in.readLine()) != null) {
                if (line.isEmpty()) continue;
                AbsoluteDate date = new AbsoluteDate(line, utc);
                PoleCorrection p = eop.getPoleCorrection(date);
                double[] d = eop.getNonRotatinOriginNutationCorrection(date);
                System.out.printf(Locale.ROOT, "{\"utc\":\"%s\",\"dut1\":%.17g,\"xp\":%.17g,\"yp\":%.17g,\"dx\":%.17g,\"dy\":%.17g", line,
                    eop.getUT1MinusUTC(date), p.getXp(), p.getYp(), d[0], d[1]);
                matrix("mod", eme2000, mod, date);
                matrix("tod", eme2000, tod, date);
                matrix("teme", eme2000, teme, date);
                matrix("itrf", FramesFactory.getGCRF(), itrf, date);
                System.out.println("}");
            }
        }
    }
}
