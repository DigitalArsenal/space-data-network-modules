// Independent authority generator: Orekit 13.1 / Hipparchus 4.0.1.
// Based on the documented sequential PV estimation scenario; see depth README.
// Run with jars from Maven Central (commands in depth README). No module code.
import org.hipparchus.geometry.euclidean.threed.Vector3D;
import org.hipparchus.linear.*;
import org.hipparchus.util.MerweUnscentedTransform;
import org.orekit.estimation.measurements.*;
import org.orekit.estimation.sequential.*;
import org.orekit.frames.FramesFactory;
import org.orekit.orbits.*;
import org.orekit.propagation.analytical.KeplerianPropagator;
import org.orekit.propagation.conversion.KeplerianPropagatorBuilder;
import org.orekit.time.*;
import org.orekit.utils.PVCoordinates;
import java.util.Locale;
public class OrekitReference {
  public static void main(String[] args) {
    Locale.setDefault(Locale.ROOT);
    AbsoluteDate epoch = new AbsoluteDate(2000,1,1,12,0,0,TimeScalesFactory.getTAI());
    double mu=3.986004418e14;
    var frame=FramesFactory.getGCRF();
    var truthOrbit=new CartesianOrbit(new PVCoordinates(new Vector3D(7000000,0,0),new Vector3D(0,7500,1000)),frame,epoch,mu);
    var priorOrbit=new CartesianOrbit(new PVCoordinates(new Vector3D(7000100,-80,60),new Vector3D(.1,7499.92,1000.05)),frame,epoch,mu);
    var truth=new KeplerianPropagator(truthOrbit);
    for(int kind=1;kind<=2;++kind) {
      var builder=new KeplerianPropagatorBuilder(priorOrbit,PositionAngleType.TRUE,1);
      RealMatrix covariance=MatrixUtils.createRealDiagonalMatrix(new double[]{10000,10000,10000,.01,.01,.01});
      var noise=new ConstantProcessNoise(covariance,MatrixUtils.createRealMatrix(6,6));
      AbstractKalmanEstimator filter=kind==1 ? new KalmanEstimatorBuilder().addPropagationConfiguration(builder,noise).build() :
        new UnscentedKalmanEstimatorBuilder().addPropagationConfiguration(builder,noise).unscentedTransformProvider(new MerweUnscentedTransform(6,1,2,0)).build();
      for(int step=1;step<=10;++step) {
        double t=step*60;
        var pv=truth.propagate(epoch.shiftedBy(t)).getPVCoordinates();
        // Fixed nonzero errors, expressed directly, independent of any estimator.
        var obs=new PV(epoch.shiftedBy(t),pv.getPosition().add(new Vector3D(2,-1,3)),pv.getVelocity().add(new Vector3D(.002,-.001,.003)),10,.01,1,new ObservableSatellite(0));
        if(kind==1)((KalmanEstimator)filter).estimationStep(obs);else ((UnscentedKalmanEstimator)filter).estimationStep(obs);
        System.out.printf("%d %.17g",kind,t);
        for(double v:pv.getPosition().add(new Vector3D(2,-1,3)).toArray())System.out.printf(" %.17g",v);
        for(double v:pv.getVelocity().add(new Vector3D(.002,-.001,.003)).toArray())System.out.printf(" %.17g",v);
        for(double v:filter.getPhysicalEstimatedState().toArray())System.out.printf(" %.17g",v);
        for(double[] row:filter.getPhysicalEstimatedCovarianceMatrix().getData())for(double v:row)System.out.printf(" %.17g",v);
        System.out.println();
      }
    }
  }
}
