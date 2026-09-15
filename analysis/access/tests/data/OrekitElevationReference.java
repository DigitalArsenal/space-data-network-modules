import java.io.File;
import java.util.Locale;
import org.orekit.data.DataContext;
import org.orekit.data.DirectoryCrawler;
import org.orekit.bodies.*;
import org.orekit.frames.*;
import org.orekit.orbits.*;
import org.orekit.propagation.analytical.KeplerianPropagator;
import org.orekit.propagation.events.*;
import org.orekit.propagation.events.handlers.ContinueOnEvent;
import org.orekit.time.*;
import org.orekit.utils.*;

public class OrekitElevationReference {
  public static void main(String[] args) {
    Locale.setDefault(Locale.ROOT);
    DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(new File("regular-data")));
    Frame eme2000=FramesFactory.getEME2000();
    Frame earthFrame=FramesFactory.getITRF(IERSConventions.IERS_2010,true);
    AbsoluteDate epoch=AbsoluteDate.J2000_EPOCH;
    KeplerianOrbit orbit=new KeplerianOrbit(7000000,0,Math.PI/2.2,0,Math.PI/2,0,PositionAngleType.TRUE,eme2000,epoch,Constants.EGM96_EARTH_MU);
    OneAxisEllipsoid earth=new OneAxisEllipsoid(Constants.WGS84_EARTH_EQUATORIAL_RADIUS,Constants.WGS84_EARTH_FLATTENING,earthFrame);
    TopocentricFrame station=new TopocentricFrame(earth,new GeodeticPoint(Math.toRadians(35),Math.toRadians(149.8),0),"GSTATION");
    KeplerianPropagator propagation=new KeplerianPropagator(orbit);
    EventsLogger logger=new EventsLogger();
    propagation.addEventDetector(logger.monitorDetector(new ElevationDetector(600,1e-3,station).withConstantElevation(Math.toRadians(5)).withHandler(new ContinueOnEvent())));
    propagation.propagate(epoch.shiftedBy(1800));
    System.err.printf("mu=%.17g\n",Constants.EGM96_EARTH_MU);
    for(var event:logger.getLoggedEvents())System.err.printf("Orekit edge %.12f s increasing=%s\n",event.getState().getDate().durationFrom(epoch),event.isIncreasing());
    System.err.println("Loaded data: "+DataContext.getDefault().getDataProvidersManager().getLoadedDataNames());
    KeplerianPropagator samples=new KeplerianPropagator(orbit);
    System.out.println("[");
    for(int t=460;t<=680;t++) {
      var p=samples.propagate(epoch.shiftedBy(t)).getPVCoordinates(earthFrame).getPosition();
      System.out.printf("  [%d, %.17g, %.17g, %.17g]%s%n",t,p.getX(),p.getY(),p.getZ(),t<680?",":"");
    }
    System.out.println("]");
  }
}