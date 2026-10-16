import java.io.File;
import java.util.Locale;
import java.util.Scanner;

import org.hipparchus.geometry.euclidean.threed.Vector3D;
import org.orekit.data.DataContext;
import org.orekit.data.DirectoryCrawler;
import org.orekit.frames.Frame;
import org.orekit.frames.FramesFactory;
import org.orekit.time.AbsoluteDate;
import org.orekit.time.TimeScalesFactory;
import org.orekit.utils.PVCoordinates;

/** Independent frame oracle: reads "UTC-epoch x y z vx vy vz" lines (km, km/s) in TEME from
 *  stdin and prints the same state in EME2000 and GCRF, in km and km/s, one line per input. */
public final class OrekitFrameCheck {

    public static void main(final String[] args) {
        DataContext.getDefault().getDataProvidersManager()
                   .addProvider(new DirectoryCrawler(new File(args[0])));
        final Frame teme = FramesFactory.getTEME();
        final Frame eme2000 = FramesFactory.getEME2000();
        final Frame gcrf = FramesFactory.getGCRF();
        final Scanner in = new Scanner(System.in).useLocale(Locale.ROOT);
        while (in.hasNext()) {
            final AbsoluteDate date = new AbsoluteDate(in.next(), TimeScalesFactory.getUTC());
            final PVCoordinates pv = new PVCoordinates(
                new Vector3D(in.nextDouble() * 1e3, in.nextDouble() * 1e3, in.nextDouble() * 1e3),
                new Vector3D(in.nextDouble() * 1e3, in.nextDouble() * 1e3, in.nextDouble() * 1e3));
            final StringBuilder line = new StringBuilder();
            for (final Frame target : new Frame[] { eme2000, gcrf }) {
                final PVCoordinates out = teme.getTransformTo(target, date).transformPVCoordinates(pv);
                line.append(String.format(Locale.ROOT, "%.9f %.9f %.9f %.12f %.12f %.12f ",
                    out.getPosition().getX() / 1e3, out.getPosition().getY() / 1e3, out.getPosition().getZ() / 1e3,
                    out.getVelocity().getX() / 1e3, out.getVelocity().getY() / 1e3, out.getVelocity().getZ() / 1e3));
            }
            System.out.println(line.toString().trim());
        }
    }
}
