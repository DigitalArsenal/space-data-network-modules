import java.io.File;
import java.util.Locale;

import org.orekit.data.DataContext;
import org.orekit.data.DataSource;
import org.orekit.data.DirectoryCrawler;
import org.orekit.files.ccsds.ndm.ParserBuilder;
import org.orekit.files.ccsds.ndm.cdm.Cdm;
import org.orekit.files.ccsds.ndm.cdm.CdmData;
import org.orekit.files.ccsds.ndm.cdm.CdmMetadata;
import org.orekit.files.ccsds.ndm.cdm.ODParameters;

/** Independent CCSDS 508.0-B-1 reader: Orekit's CdmParser parses each file
 *  (KVN or XML, by content) and prints what it read as key=value lines, one
 *  block per file. A rejected file prints REJECTED and the parser's message. */
public final class OrekitCdmCheck {

    public static void main(final String[] args) {
        DataContext.getDefault().getDataProvidersManager()
                   .addProvider(new DirectoryCrawler(new File(args[0])));
        for (int i = 1; i < args.length; ++i) {
            System.out.println("FILE " + args[i]);
            try {
                final Cdm cdm = new ParserBuilder().buildCdmParser()
                                                   .parseMessage(new DataSource(new File(args[i])));
                print(cdm);
            } catch (final Exception e) {
                System.out.println("REJECTED " + e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }
    }

    private static void print(final Cdm cdm) {
        out("HEADER.MESSAGE_ID", cdm.getHeader().getMessageId());
        out("HEADER.CREATION_DATE", cdm.getHeader().getCreationDate());
        out("HEADER.ORIGINATOR", cdm.getHeader().getOriginator());
        out("HEADER.MESSAGE_FOR", cdm.getHeader().getMessageFor());
        out("REL.TCA", cdm.getRelativeMetadata().getTca());
        out("REL.MISS_DISTANCE_M", cdm.getRelativeMetadata().getMissDistance());
        out("REL.RELATIVE_SPEED_MS", cdm.getRelativeMetadata().getRelativeSpeed());
        out("REL.COLLISION_PROBABILITY", cdm.getRelativeMetadata().getCollisionProbability());
        out("REL.COLLISION_PROBABILITY_METHOD", name(cdm.getRelativeMetadata().getCollisionProbaMethod() == null ? null : cdm.getRelativeMetadata().getCollisionProbaMethod().getName()));
        object("OBJECT1", cdm.getMetadataObject1(), cdm.getDataObject1());
        object("OBJECT2", cdm.getMetadataObject2(), cdm.getDataObject2());
    }

    private static void object(final String tag, final CdmMetadata m, final CdmData d) {
        out(tag + ".OBJECT", m.getObject());
        out(tag + ".OBJECT_DESIGNATOR", m.getObjectDesignator());
        out(tag + ".CATALOG_NAME", m.getCatalogName());
        out(tag + ".OBJECT_NAME", m.getObjectName());
        out(tag + ".INTERNATIONAL_DESIGNATOR", m.getInternationalDes());
        out(tag + ".EPHEMERIS_NAME", m.getEphemName());
        out(tag + ".COVARIANCE_METHOD", m.getCovarianceMethod());
        out(tag + ".MANEUVERABLE", m.getManeuverable());
        out(tag + ".REF_FRAME", m.getRefFrame().getName());
        out(tag + ".X_M", d.getStateVectorBlock().getPositionVector().getX());
        out(tag + ".VX_MS", d.getStateVectorBlock().getVelocityVector().getX());
        out(tag + ".CR_R_M2", d.getRTNCovarianceBlock().getCrr());
        out(tag + ".CT_T_M2", d.getRTNCovarianceBlock().getCtt());
        out(tag + ".CN_N_M2", d.getRTNCovarianceBlock().getCnn());
        out(tag + ".CTDOT_TDOT_M2S2", d.getRTNCovarianceBlock().getCtdottdot());
        out(tag + ".CNDOT_NDOT_M2S2", d.getRTNCovarianceBlock().getCndotndot());
        final ODParameters od = d.getODParametersBlock();
        if (od != null) {
            out(tag + ".ACTUAL_OD_SPAN_D", od.getActualOdSpan());
            out(tag + ".OBS_USED", od.getObsUsed());
            out(tag + ".WEIGHTED_RMS", od.getWeightedRMS());
        }
    }

    private static String name(final String value) {
        return value;
    }

    private static void out(final String key, final Object value) {
        System.out.println(key + "=" + (value instanceof Double ? String.format(Locale.ROOT, "%.17g", value) : value));
    }
}
