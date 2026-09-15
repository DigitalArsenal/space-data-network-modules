import java.io.File;
import java.util.Locale;
import java.util.TreeSet;
import org.hipparchus.geometry.euclidean.threed.Vector3D;
import org.orekit.data.DataContext;
import org.orekit.data.DirectoryCrawler;
import org.orekit.bodies.*;
import org.orekit.frames.*;
import org.orekit.orbits.*;
import org.orekit.propagation.analytical.KeplerianPropagator;
import org.orekit.propagation.events.*;
import org.orekit.time.*;
import org.orekit.utils.*;

public class OrekitNightReference {
  public static void main(String[] args) {
    Locale.setDefault(Locale.ROOT);
    DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(new File("regular-data")));
    Frame earthFrame=FramesFactory.getITRF(IERSConventions.IERS_2010,true);
    AbsoluteDate epoch=new AbsoluteDate("2003-02-14T14:02:03.000",TimeScalesFactory.getUTC());
    CircularOrbit orbit=new CircularOrbit(7200000,1e-3,2e-4,Math.toRadians(50),Math.toRadians(134),Math.toRadians(21),PositionAngleType.MEAN,FramesFactory.getGCRF(),epoch,Constants.EIGEN5C_EARTH_MU);
    OneAxisEllipsoid earth=new OneAxisEllipsoid(Constants.WGS84_EARTH_EQUATORIAL_RADIUS,Constants.WGS84_EARTH_FLATTENING,earthFrame);
    GeodeticPoint site=new GeodeticPoint(Math.toRadians(43),0,0);
    TopocentricFrame station=new TopocentricFrame(earth,site,"Orekit civil-night station");
    KeplerianPropagator propagation=new KeplerianPropagator(orbit);
    EventsLogger logger=new EventsLogger();
    propagation.addEventDetector(logger.monitorDetector(new GroundAtNightDetector(station,CelestialBodyFactory.getSun(),GroundAtNightDetector.CIVIL_DAWN_DUSK_ELEVATION,null).withMaxCheck(120)));
    propagation.propagate(epoch.shiftedBy(86400));
    var events=logger.getLoggedEvents();
    if(events.size()!=2)throw new IllegalStateException("Expected two twilight events");
    double start=events.get(0).getState().getDate().durationFrom(epoch);
    double end=events.get(1).getState().getDate().durationFrom(epoch);
    System.err.printf("Orekit civil-night edges %.12f %.12f s; duration %.12f s\n",start,end,end-start);
    System.err.println("Loaded data: "+DataContext.getDefault().getDataProvidersManager().getLoadedDataNames());
    TreeSet<Integer> times=new TreeSet<>();
    for(int t=0;t<=86400;t+=3600)times.add(t);
    for(double edge:new double[]{start,end})for(int t=(int)Math.floor(edge)-5;t<=(int)Math.ceil(edge)+5;t++)times.add(t);
    // The fixed synthetic target is one million metres along the WGS84
    // geodetic normal, so target/Sun separation = pi/2 - Sun elevation.
    Vector3D target=earth.transform(site).add(new Vector3D(1000000,site.getZenith()));
    System.out.printf("{\n  \"epochJulianDateTT\": %.17g,\n",2451545+epoch.durationFrom(AbsoluteDate.J2000_EPOCH)/86400);
    System.out.printf("  \"externalOrekitEdgesSeconds\": [%.17g, %.17g],\n",start,end);
    System.out.printf("  \"externalOrekitDurationSeconds\": %.17g,\n",end-start);
    System.out.printf("  \"targetPositionM\": [%.17g, %.17g, %.17g],\n",target.getX(),target.getY(),target.getZ());
    System.out.println("  \"sunSamples\": [");
    int count=0;
    for(int t:times) {
      Vector3D p=CelestialBodyFactory.getSun().getPosition(epoch.shiftedBy(t),earthFrame);
      System.out.printf("    [%d, %.17g, %.17g, %.17g]%s%n",t,p.getX(),p.getY(),p.getZ(),++count<times.size()?",":"");
    }
    System.out.println("  ]\n}");
  }
}