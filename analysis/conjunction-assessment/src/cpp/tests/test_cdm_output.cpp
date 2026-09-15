/**
 * CDM FlatBuffers Output Test
 *
 * Verifies conjunction events serialize to valid CDM FlatBuffers
 * with $CDM file identifier.
 */

#include "conjunction/conjunction_assessment.h"
#include "conjunction/conjunction_engine.h"
#include "conjunction/error_status.h"
#ifdef SING
#undef SING
#endif
#ifdef DOMAIN
#undef DOMAIN
#endif
#include "CDM_generated.h"
#include "flatbuffers/flatbuffers.h"

#include <iostream>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string>

using namespace conjunction;

static int tests_passed = 0;
static int tests_failed = 0;

#define CHECK(cond, msg) do { \
    if (cond) { tests_passed++; std::cout << "  ✓ " << msg << std::endl; } \
    else { tests_failed++; std::cout << "  ✗ " << msg << std::endl; } \
} while(0)

void test_single_cdm_output() {
    std::cout << "\n--- Test: Single CDM Output ---" << std::endl;

    // Create a synthetic conjunction event
    ConjunctionEvent event;
    event.obj1.name = "STARLINK-1234";
    event.obj1.norad_cat_id = 45678;
    event.obj2.name = "COSMOS 2251 DEB";
    event.obj2.norad_cat_id = 34567;

    event.tca_jd = 2460750.0;
    event.tca_iso = "2025-03-15T12:00:00.000Z";
    event.min_range_km = 0.234;
    event.rel_speed_kms = 14.7;

    event.rel_pos_r = 0.1;
    event.rel_pos_t = 0.15;
    event.rel_pos_n = -0.08;
    event.rel_vel_r = 2.3;
    event.rel_vel_t = 12.1;
    event.rel_vel_n = -5.4;

    event.max_probability = 1.23e-4;
    event.probability_method = "ALFANO-MAXPROB";

    event.cov_r1 = DEFAULT_COV_R_M;
    event.cov_t1 = DEFAULT_COV_T_M;
    event.cov_n1 = DEFAULT_COV_N_M;
    event.cov_r2 = DEFAULT_COV_R_M;
    event.cov_t2 = DEFAULT_COV_T_M;
    event.cov_n2 = DEFAULT_COV_N_M;

    // Serialize
    uint8_t buffer[16384];
    int32_t written = conjunction_to_cdm(event, buffer, sizeof(buffer));

    CHECK(written > 0, "CDM serialization succeeded (" + std::to_string(written) + " bytes)");

    // Verify file identifier
    bool has_id = flatbuffers::BufferHasIdentifier(buffer, "$CDM");
    CHECK(has_id, "Buffer has $CDM file identifier");

    flatbuffers::Verifier verifier(buffer, static_cast<size_t>(written));
    CHECK(VerifyCDMBuffer(verifier), "CDM FlatBuffer verifier accepts buffer");

    // Deserialize and verify fields
    auto cdm = GetCDM(buffer);
    CHECK(cdm != nullptr, "CDM deserialized successfully");

    if (cdm) {
        CHECK(cdm->CCSDS_CDM_VERS() == 1.0, "CCSDS version = 1.0");
        CHECK(std::string(cdm->ORIGINATOR()->c_str()) == "conjunction-assessment", "Originator correct");

        CHECK(cdm->TCA() != nullptr, "TCA string present");
        if (cdm->TCA()) {
            CHECK(std::string(cdm->TCA()->c_str()) == "2025-03-15T12:00:00.000Z", "TCA matches");
        }

        CHECK(std::abs(cdm->MISS_DISTANCE() - 0.234) < 0.001, "Miss distance = 0.234 km");
        CHECK(std::abs(cdm->RELATIVE_SPEED() - 14.7) < 0.01, "Relative speed = 14.7 km/s");
        CHECK(std::abs(cdm->COLLISION_PROBABILITY() - 1.23e-4) < 1e-8, "Probability = 1.23e-4");

        // Check RTN components
        CHECK(std::abs(cdm->RELATIVE_POSITION_R() - 0.1) < 0.001, "Rel pos R correct");
        CHECK(std::abs(cdm->RELATIVE_POSITION_T() - 0.15) < 0.001, "Rel pos T correct");
        CHECK(std::abs(cdm->RELATIVE_POSITION_N() - (-0.08)) < 0.001, "Rel pos N correct");

        // Check objects
        CHECK(cdm->OBJECT1() != nullptr, "Object 1 present");
        CHECK(cdm->OBJECT2() != nullptr, "Object 2 present");

        if (cdm->OBJECT1() && cdm->OBJECT1()->OBJECT()) {
            CHECK(cdm->OBJECT1()->OBJECT()->NORAD_CAT_ID() == 45678, "Object 1 NORAD ID");
        }

        if (cdm->OBJECT2() && cdm->OBJECT2()->OBJECT()) {
            CHECK(cdm->OBJECT2()->OBJECT()->NORAD_CAT_ID() == 34567, "Object 2 NORAD ID");
        }

        CHECK(cdm->CREATION_DATE()->str() == event.tca_iso, "Deterministic creation date uses the event epoch");
        CHECK(cdm->SCREEN_VOLUME_X() == 0.0, "No screening volume invented from a pair event");
    }

    std::cout << "    CDM size: " << written << " bytes" << std::endl;
}

void test_batch_cdm_output() {
    std::cout << "\n--- Test: Batch CDM Output ---" << std::endl;

    std::vector<ConjunctionEvent> events;
    for (int i = 0; i < 5; i++) {
        ConjunctionEvent event;
        event.obj1.name = "SAT-" + std::to_string(i);
        event.obj1.norad_cat_id = 10000 + i;
        event.obj2.name = "DEB-" + std::to_string(i);
        event.obj2.norad_cat_id = 20000 + i;
        event.tca_jd = 2460784.5 + i * 0.1;
        event.min_range_km = 1.0 + i * 0.5;
        event.rel_speed_kms = 10.0 + i;
        event.max_probability = 1e-5 * (i + 1);
        event.probability_method = "ALFANO-MAXPROB";
        event.cov_r1 = event.cov_r2 = DEFAULT_COV_R_M;
        event.cov_t1 = event.cov_t2 = DEFAULT_COV_T_M;
        event.cov_n1 = event.cov_n2 = DEFAULT_COV_N_M;
        events.push_back(event);
    }

    uint8_t buffer[65536];
    int32_t written = conjunctions_to_cdm_batch(events, buffer, sizeof(buffer));

    CHECK(written > 0, "Batch CDM serialization succeeded (" + std::to_string(written) + " bytes)");

    // Parse the size-prefixed buffer
    int count = 0;
    uint32_t offset = 0;
    while (offset < static_cast<uint32_t>(written)) {
        uint32_t size;
        std::memcpy(&size, buffer + offset, 4);
        offset += 4;

        bool valid = flatbuffers::BufferHasIdentifier(buffer + offset, "$CDM");
        CHECK(valid, "CDM #" + std::to_string(count) + " has valid $CDM identifier");

        flatbuffers::Verifier verifier(buffer + offset, size);
        CHECK(VerifyCDMBuffer(verifier), "CDM #" + std::to_string(count) + " passes FlatBuffer verification");

        auto cdm = GetCDM(buffer + offset);
        if (cdm) {
            CHECK(cdm->OBJECT1() != nullptr, "CDM #" + std::to_string(count) + " has Object 1");
        }

        offset += size;
        count++;
    }

    CHECK(count == 5, "Parsed 5 CDMs from batch (" + std::to_string(count) + " found)");
    std::cout << "    Batch size: " << written << " bytes for " << count << " CDMs" << std::endl;
}

void test_buffer_too_small() {
    std::cout << "\n--- Test: Buffer Too Small ---" << std::endl;

    ConjunctionEvent event;
    event.obj1.name = "SAT-A";
    event.obj1.norad_cat_id = 11111;
    event.obj2.name = "SAT-B";
    event.obj2.norad_cat_id = 22222;
    event.tca_jd = 2460784.5;
    event.min_range_km = 1.0;
    event.rel_speed_kms = 10.0;
    event.max_probability = 1e-5;
    event.probability_method = "ALFANO-MAXPROB";

    uint8_t tiny_buffer[10];
    int32_t written = conjunction_to_cdm(event, tiny_buffer, sizeof(tiny_buffer));
    CHECK(written == -2, "Returns -2 for buffer too small");
}

void test_cdm_import_pc() {
    std::cout << "\n--- Test: CDM Import Pc Computation ---" << std::endl;

    ConjunctionEvent event;
    event.obj1.name = "PRIMARY";
    event.obj1.norad_cat_id = 11111;
    event.obj2.name = "SECONDARY";
    event.obj2.norad_cat_id = 22222;
    event.tca_jd = 2460750.0;
    event.tca_iso = "2025-03-15T12:00:00.000Z";
    // Independent centered isotropic Gaussian disk integral (Rayleigh CDF):
    // https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/raycdf.htm
    // TEME km, km/s; UTC event epoch above (integration is epoch invariant).
    // Two isotropic 70.710678 m covariances sum to sigma=100 m; radius=10 m.
    // Opposite along-track velocities give a nondegenerate encounter plane.
    event.state1 = StateVector{event.tca_jd,7000,0,0,0,7.5,0};
    event.state2 = StateVector{event.tca_jd,7000,0,0,0,-7.5,0};
    event.min_range_km = 0.0;
    event.rel_speed_kms = 15.0;
    event.max_probability = 0.0;
    event.probability_method = "LAAS-2015";
    event.cov_r1 = event.cov_t1 = event.cov_n1 = 100.0 / std::sqrt(2.0);
    event.cov_r2 = event.cov_t2 = event.cov_n2 = 100.0 / std::sqrt(2.0);

    uint8_t buffer[16384];
    int32_t written = conjunction_to_cdm(event, buffer, sizeof(buffer));
    CHECK(written > 0, "Source CDM serialization for import succeeded");

    const auto imported = compute_pc_from_cdm(buffer, static_cast<uint32_t>(written), "", 0.01);

    const double expected = 1.0 - std::exp(-0.01 * 0.01 / (2.0 * 0.1 * 0.1));
    CHECK(imported.method == "LAAS-2015", "Imported CDM uses covariance probability algorithm");
    // Smooth Gaussian integral; 1e-12 absolute error is the ratified migration bound.
    CHECK(!has_error() && std::abs(imported.probability - expected) < 1e-12,
          "Imported CDM Pc agrees with independent Gaussian disk integral to 1e-12");
    clear_error();
    (void)compute_pc_from_cdm(buffer, 8, "LAAS-2015", 0.01);
    CHECK(has_error(), "Truncated CDM input returns explicit failure status");
    clear_error();
}

void test_orekit_cdm_example1_kvn_roundtrip() {
    std::cout << "\n--- Test: Orekit CDMExample1 KVN Import/Export ---" << std::endl;

    // Numeric fields are from Orekit 13.1 src/test/resources/ccsds/cdm/CDMExample1.txt.
    // The international designator minus sign is normalized to ASCII in this fixture.
    const char* kvn =
        "CCSDS_CDM_VERS                = 1.0\n"
        "CREATION_DATE                 = 2010-03-12T22:31:12.000\n"
        "ORIGINATOR                    = JSPOC\n"
        "MESSAGE_ID                    = 201113719185\n"
        "TCA                           = 2010-03-13T22:37:52.618\n"
        "MISS_DISTANCE                 = 715                                  [m]\n"
        "OBJECT                        = OBJECT1\n"
        "OBJECT_DESIGNATOR             = 12345\n"
        "CATALOG_NAME                  = SATCAT\n"
        "OBJECT_NAME                   = SATELLITE A\n"
        "INTERNATIONAL_DESIGNATOR      = 1997-030E\n"
        "EPHEMERIS_NAME                = EPHEMERIS SATELLITE A\n"
        "COVARIANCE_METHOD             = CALCULATED\n"
        "MANEUVERABLE                  = YES\n"
        "REF_FRAME                     = EME2000\n"
        "X                             = 2570.097065                          [km]\n"
        "Y                             = 2244.654904                          [km]\n"
        "Z                             = 6281.497978                          [km]\n"
        "X_DOT                         = 4.418769571                          [km/s]\n"
        "Y_DOT                         = 4.833547743                          [km/s]\n"
        "Z_DOT                         = -3.526774282                         [km/s]\n"
        "CR_R                          = 4.142E+01                            [m**2]\n"
        "CT_R                          = -8.579E+00                           [m**2]\n"
        "CT_T                          = 2.533E+03                            [m**2]\n"
        "CN_R                          = -2.313E+01                           [m**2]\n"
        "CN_T                          = 1.336E+01                            [m**2]\n"
        "CN_N                          = 7.098E+01                            [m**2]\n"
        "OBJECT                        = OBJECT2\n"
        "OBJECT_DESIGNATOR             = 30337\n"
        "CATALOG_NAME                  = SATCAT\n"
        "OBJECT_NAME                   = FENGYUN 1C DEB\n"
        "INTERNATIONAL_DESIGNATOR      = 1999-025AA\n"
        "EPHEMERIS_NAME                = NONE\n"
        "COVARIANCE_METHOD             = CALCULATED\n"
        "MANEUVERABLE                  = NO\n"
        "REF_FRAME                     = EME2000\n"
        "X                             = 2569.540800                          [km]\n"
        "Y                             = 2245.093614                          [km]\n"
        "Z                             = 6281.599946                          [km]\n"
        "X_DOT                         = -2.888612500                         [km/s]\n"
        "Y_DOT                         = -6.007247516                         [km/s]\n"
        "Z_DOT                         = 3.328770172                          [km/s]\n"
        "CR_R                          = 1.337E+03                            [m**2]\n"
        "CT_R                          = -4.806E+04                           [m**2]\n"
        "CT_T                          = 2.492E+06                            [m**2]\n"
        "CN_R                          = -3.298E+01                           [m**2]\n"
        "CN_T                          = -7.5888E+02                          [m**2]\n"
        "CN_N                          = 7.105E+01                            [m**2]\n";

    uint8_t buffer[16384];
    int32_t written = cdm_kvn_to_sds(
        kvn,
        static_cast<uint32_t>(std::strlen(kvn)),
        buffer,
        sizeof(buffer));

    CHECK(written > 0, "Orekit CDMExample1 KVN parses to SDS $CDM");
    flatbuffers::Verifier verifier(buffer, static_cast<size_t>(written));
    CHECK(VerifyCDMBuffer(verifier), "Parsed Orekit KVN passes SDS CDM verifier");

    const auto* cdm = GetCDM(buffer);
    CHECK(cdm != nullptr, "Parsed Orekit KVN deserializes as CDM");
    if (cdm) {
        CHECK(std::abs(cdm->CCSDS_CDM_VERS() - 1.0) < 1e-12, "Orekit CDM version preserved");
        CHECK(cdm->CREATION_DATE() && cdm->CREATION_DATE()->str() == "2010-03-12T22:31:12.000",
              "Orekit creation date preserved");
        CHECK(cdm->ORIGINATOR() && cdm->ORIGINATOR()->str() == "JSPOC", "Orekit originator preserved");
        CHECK(cdm->MESSAGE_ID() && cdm->MESSAGE_ID()->str() == "201113719185", "Orekit message ID preserved");
        CHECK(cdm->TCA() && cdm->TCA()->str() == "2010-03-13T22:37:52.618", "Orekit TCA preserved");
        CHECK(std::abs(cdm->MISS_DISTANCE() - 0.715) < 1e-12,
              "Orekit miss distance converted from meters to module CDM kilometers");
        CHECK(std::abs(cdm->RELATIVE_SPEED() - 14.762) < 1e-3,
              "Orekit relative speed derived from object state vectors");
        CHECK(cdm->OBJECT1() != nullptr, "Orekit object 1 parsed");
        CHECK(cdm->OBJECT2() != nullptr, "Orekit object 2 parsed");
        if (cdm->OBJECT1() && cdm->OBJECT1()->OBJECT()) {
            CHECK(cdm->OBJECT1()->OBJECT()->NORAD_CAT_ID() == 12345, "Orekit object 1 designator maps to NORAD id");
            CHECK(cdm->OBJECT1()->OBJECT()->OBJECT_NAME() &&
                  cdm->OBJECT1()->OBJECT()->OBJECT_NAME()->str() == "SATELLITE A",
                  "Orekit object 1 name preserved");
            CHECK(std::abs(cdm->OBJECT1()->X() - 2570.097065) < 1e-12,
                  "Orekit object 1 X preserved in kilometers");
            CHECK(cdm->OBJECT1()->COVARIANCE() && cdm->OBJECT1()->COVARIANCE()->size() == 45,
                  "Orekit object 1 covariance emits SDS 45-entry lower triangle");
            CHECK(std::abs(cdm->OBJECT1()->COVARIANCE()->Get(0) - 4.142e-5) < 1e-14,
                  "Orekit object 1 CR_R converted from m^2 to km^2");
        }
    }

    char roundtrip[16384];
    int32_t kvn_written = cdm_sds_to_kvn(
        buffer,
        static_cast<uint32_t>(written),
        roundtrip,
        sizeof(roundtrip));
    CHECK(kvn_written > 0, "SDS $CDM writes back to KVN text");

    if (kvn_written > 0) {
        const std::string roundtrip_text(roundtrip, roundtrip + kvn_written);
        CHECK(roundtrip_text.find("CCSDS_CDM_VERS") != std::string::npos,
              "Round-tripped KVN includes CDM version");
        CHECK(roundtrip_text.find("MISS_DISTANCE") != std::string::npos,
              "Round-tripped KVN includes miss distance");
        CHECK(roundtrip_text.find("[m]") != std::string::npos,
              "Round-tripped KVN writes CCSDS meter units");
        CHECK(roundtrip_text.find("OBJECT                        = OBJECT1") != std::string::npos,
              "Round-tripped KVN includes object 1 block");

        uint8_t reparsed[16384];
        int32_t reparsed_size = cdm_kvn_to_sds(
            roundtrip_text.data(),
            static_cast<uint32_t>(roundtrip_text.size()),
            reparsed,
            sizeof(reparsed));
        CHECK(reparsed_size > 0, "Round-tripped KVN reparses to SDS $CDM");
        if (reparsed_size > 0) {
            const auto* reparsed_cdm = GetCDM(reparsed);
            CHECK(std::abs(reparsed_cdm->MISS_DISTANCE() - 0.715) < 1e-12,
                  "Round-tripped KVN preserves miss distance");
            CHECK(std::abs(reparsed_cdm->OBJECT2()->COVARIANCE()->Get(2) - 2.492) < 1e-12,
                  "Round-tripped KVN preserves object 2 CT_T covariance in km^2");
        }
    }
}

void test_orekit_cdm_example1_xml_roundtrip() {
    std::cout << "\n--- Test: Orekit CDMExample1 XML Import/Export ---" << std::endl;

    // Numeric fields are from Orekit 13.1 src/test/resources/ccsds/cdm/CDMExample1.xml.
    const char* xml = R"CDMXML(<?xml version="1.0" encoding="UTF-8"?>
<cdm xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
xsi:noNamespaceSchemaLocation="http://sanaregistry.org/r/ndmxml/ndmxml-1.0-master.xsd"
id="CCSDS_CDM_VERS" version="1.0">
<header>
<COMMENT>Sample CDM - XML version</COMMENT>
<CREATION_DATE>2010-03-12T22:31:12.000</CREATION_DATE>
<ORIGINATOR>JSPOC</ORIGINATOR>
<MESSAGE_FOR>SATELLITE A</MESSAGE_FOR>
<MESSAGE_ID>20111371985</MESSAGE_ID>
</header>
<body>
<relativeMetadataData>
<COMMENT>Relative Metadata/Data</COMMENT>
<TCA>2010-03-13T22:37:52.618</TCA>
<MISS_DISTANCE units="m">715</MISS_DISTANCE>
<RELATIVE_SPEED units="m/s">14762</RELATIVE_SPEED>
<relativeStateVector>
<RELATIVE_POSITION_R units="m">27.4</RELATIVE_POSITION_R>
<RELATIVE_POSITION_T units="m">-70.2</RELATIVE_POSITION_T>
<RELATIVE_POSITION_N units="m">711.8</RELATIVE_POSITION_N>
<RELATIVE_VELOCITY_R units="m/s">-7.2</RELATIVE_VELOCITY_R>
<RELATIVE_VELOCITY_T units="m/s">-14692.0</RELATIVE_VELOCITY_T>
<RELATIVE_VELOCITY_N units="m/s">-1437.2</RELATIVE_VELOCITY_N>
</relativeStateVector>
<COLLISION_PROBABILITY>4.835E-05</COLLISION_PROBABILITY>
<COLLISION_PROBABILITY_METHOD>FOSTER-1992</COLLISION_PROBABILITY_METHOD>
</relativeMetadataData>
<segment>
<metadata>
<OBJECT>OBJECT1</OBJECT>
<OBJECT_DESIGNATOR>12345</OBJECT_DESIGNATOR>
<CATALOG_NAME>SATCAT</CATALOG_NAME>
<OBJECT_NAME>SATELLITE A</OBJECT_NAME>
<INTERNATIONAL_DESIGNATOR>1997-030E</INTERNATIONAL_DESIGNATOR>
<OBJECT_TYPE>PAYLOAD</OBJECT_TYPE>
<EPHEMERIS_NAME>EPHEMERIS SATELLITE A</EPHEMERIS_NAME>
<COVARIANCE_METHOD>CALCULATED</COVARIANCE_METHOD>
<MANEUVERABLE>YES</MANEUVERABLE>
<REF_FRAME>EME2000</REF_FRAME>
</metadata>
<data>
<stateVector>
<X units="km">2570.097065</X>
<Y units="km">2244.654904</Y>
<Z units="km">6281.497978</Z>
<X_DOT units="km/s">4.418769571</X_DOT>
<Y_DOT units="km/s">4.833547743</Y_DOT>
<Z_DOT units="km/s">-3.526774282</Z_DOT>
</stateVector>
<covarianceMatrix>
<CR_R units="m**2">4.142E+01</CR_R>
<CT_R units="m**2">-8.579E+00</CT_R>
<CT_T units="m**2">2.533E+03</CT_T>
<CN_R units="m**2">-2.313E+01</CN_R>
<CN_T units="m**2">1.336E+01</CN_T>
<CN_N units="m**2">7.098E+01</CN_N>
<CRDOT_R units="m**2/s">2.520E-03</CRDOT_R>
<CRDOT_T units="m**2/s">-5.476E+00</CRDOT_T>
<CRDOT_N units="m**2/s">8.626E-04</CRDOT_N>
<CRDOT_RDOT units="m**2/s**2">5.744E-03</CRDOT_RDOT>
<CTDOT_R units="m**2/s">-1.006E-02</CTDOT_R>
<CTDOT_T units="m**2/s">4.041E-03</CTDOT_T>
<CTDOT_N units="m**2/s">-1.359E-03</CTDOT_N>
<CTDOT_RDOT units="m**2/s**2">-1.502E-05</CTDOT_RDOT>
<CTDOT_TDOT units="m**2/s**2">1.049E-05</CTDOT_TDOT>
<CNDOT_R units="m**2/s">1.053E-03</CNDOT_R>
<CNDOT_T units="m**2/s">-3.412E-03</CNDOT_T>
<CNDOT_N units="m**2/s">1.213E-02</CNDOT_N>
<CNDOT_RDOT units="m**2/s**2">-3.004E-06</CNDOT_RDOT>
<CNDOT_TDOT units="m**2/s**2">-1.091E-06</CNDOT_TDOT>
<CNDOT_NDOT units="m**2/s**2">5.529E-05</CNDOT_NDOT>
</covarianceMatrix>
</data>
</segment>
<segment>
<metadata>
<OBJECT>OBJECT2</OBJECT>
<OBJECT_DESIGNATOR>30337</OBJECT_DESIGNATOR>
<CATALOG_NAME>SATCAT</CATALOG_NAME>
<OBJECT_NAME>FENGYUN 1C DEB</OBJECT_NAME>
<INTERNATIONAL_DESIGNATOR>1999-025AA</INTERNATIONAL_DESIGNATOR>
<OBJECT_TYPE>DEBRIS</OBJECT_TYPE>
<EPHEMERIS_NAME>NONE</EPHEMERIS_NAME>
<COVARIANCE_METHOD>CALCULATED</COVARIANCE_METHOD>
<MANEUVERABLE>NO</MANEUVERABLE>
<REF_FRAME>EME2000</REF_FRAME>
</metadata>
<data>
<stateVector>
<X units="km">2569.540800</X>
<Y units="km">2245.093614</Y>
<Z units="km">6281.599946</Z>
<X_DOT units="km/s">-2.888612500</X_DOT>
<Y_DOT units="km/s">-6.007247516</Y_DOT>
<Z_DOT units="km/s">3.328770172</Z_DOT>
</stateVector>
<covarianceMatrix>
<CR_R units="m**2">1.337E+03</CR_R>
<CT_R units="m**2">-4.806E+04</CT_R>
<CT_T units="m**2">2.492E+06</CT_T>
<CN_R units="m**2">-3.298E+01</CN_R>
<CN_T units="m**2">-7.5888E+02</CN_T>
<CN_N units="m**2">7.105E+01</CN_N>
<CRDOT_R units="m**2/s">2.591E-03</CRDOT_R>
<CRDOT_T units="m**2/s">-4.152E-02</CRDOT_T>
<CRDOT_N units="m**2/s">-1.784E-06</CRDOT_N>
<CRDOT_RDOT units="m**2/s**2">6.886E-05</CRDOT_RDOT>
<CTDOT_R units="m**2/s">-1.016E-02</CTDOT_R>
<CTDOT_T units="m**2/s">-1.506E-04</CTDOT_T>
<CTDOT_N units="m**2/s">1.637E-03</CTDOT_N>
<CTDOT_RDOT units="m**2/s**2">-2.987E-06</CTDOT_RDOT>
<CTDOT_TDOT units="m**2/s**2">1.059E-05</CTDOT_TDOT>
<CNDOT_R units="m**2/s">4.400E-03</CNDOT_R>
<CNDOT_T units="m**2/s">8.482E-03</CNDOT_T>
<CNDOT_N units="m**2/s">8.633E-05</CNDOT_N>
<CNDOT_RDOT units="m**2/s**2">-1.903E-06</CNDOT_RDOT>
<CNDOT_TDOT units="m**2/s**2">-4.594E-06</CNDOT_TDOT>
<CNDOT_NDOT units="m**2/s**2">5.178E-05</CNDOT_NDOT>
</covarianceMatrix>
</data>
</segment>
</body>
</cdm>)CDMXML";

    uint8_t buffer[16384];
    int32_t written = cdm_xml_to_sds(
        xml,
        static_cast<uint32_t>(std::strlen(xml)),
        buffer,
        sizeof(buffer));

    CHECK(written > 0, "Orekit CDMExample1 XML parses to SDS $CDM");
    flatbuffers::Verifier verifier(buffer, static_cast<size_t>(written));
    CHECK(VerifyCDMBuffer(verifier), "Parsed Orekit XML passes SDS CDM verifier");

    const auto* cdm = GetCDM(buffer);
    CHECK(cdm != nullptr, "Parsed Orekit XML deserializes as CDM");
    if (cdm) {
        CHECK(std::abs(cdm->CCSDS_CDM_VERS() - 1.0) < 1e-12, "Orekit XML CDM version preserved");
        CHECK(cdm->CREATION_DATE() && cdm->CREATION_DATE()->str() == "2010-03-12T22:31:12.000",
              "Orekit XML creation date preserved");
        CHECK(cdm->ORIGINATOR() && cdm->ORIGINATOR()->str() == "JSPOC",
              "Orekit XML originator preserved");
        CHECK(cdm->MESSAGE_FOR() && cdm->MESSAGE_FOR()->str() == "SATELLITE A",
              "Orekit XML message recipient preserved");
        CHECK(cdm->MESSAGE_ID() && cdm->MESSAGE_ID()->str() == "20111371985",
              "Orekit XML message ID preserved");
        CHECK(cdm->TCA() && cdm->TCA()->str() == "2010-03-13T22:37:52.618",
              "Orekit XML TCA preserved");
        CHECK(std::abs(cdm->MISS_DISTANCE() - 0.715) < 1e-12,
              "Orekit XML miss distance converted from meters to kilometers");
        CHECK(std::abs(cdm->RELATIVE_SPEED() - 14.762) < 1e-12,
              "Orekit XML relative speed converted from meters per second to kilometers per second");
        CHECK(std::abs(cdm->RELATIVE_POSITION_R() - 0.0274) < 1e-12,
              "Orekit XML relative position R converted from meters to kilometers");
        CHECK(std::abs(cdm->RELATIVE_POSITION_T() + 0.0702) < 1e-12,
              "Orekit XML relative position T converted from meters to kilometers");
        CHECK(std::abs(cdm->RELATIVE_POSITION_N() - 0.7118) < 1e-12,
              "Orekit XML relative position N converted from meters to kilometers");
        CHECK(std::abs(cdm->RELATIVE_VELOCITY_R() + 0.0072) < 1e-12,
              "Orekit XML relative velocity R converted from meters per second");
        CHECK(std::abs(cdm->RELATIVE_VELOCITY_T() + 14.692) < 1e-12,
              "Orekit XML relative velocity T converted from meters per second");
        CHECK(std::abs(cdm->RELATIVE_VELOCITY_N() + 1.4372) < 1e-12,
              "Orekit XML relative velocity N converted from meters per second");
        CHECK(std::abs(cdm->COLLISION_PROBABILITY() - 4.835e-5) < 1e-15,
              "Orekit XML collision probability preserved");
        CHECK(cdm->COLLISION_PROBABILITY_METHOD() &&
              cdm->COLLISION_PROBABILITY_METHOD()->str() == "FOSTER-1992",
              "Orekit XML collision probability method preserved");

        CHECK(cdm->OBJECT1() != nullptr, "Orekit XML object 1 parsed");
        CHECK(cdm->OBJECT2() != nullptr, "Orekit XML object 2 parsed");
        if (cdm->OBJECT1() && cdm->OBJECT1()->OBJECT()) {
            const auto* object = cdm->OBJECT1();
            const auto* cat = object->OBJECT();
            CHECK(cat->NORAD_CAT_ID() == 12345, "Orekit XML object 1 designator maps to NORAD id");
            CHECK(cat->OBJECT_NAME() && cat->OBJECT_NAME()->str() == "SATELLITE A",
                  "Orekit XML object 1 name preserved");
            CHECK(cat->OBJECT_ID() && cat->OBJECT_ID()->str() == "1997-030E",
                  "Orekit XML object 1 international designator preserved");
            CHECK(cat->OBJECT_TYPE() == spaceObjectClass::PAYLOAD, "Orekit XML object 1 type preserved");
            CHECK(cat->MANEUVERABLE(), "Orekit XML object 1 maneuverable flag preserved");
            CHECK(std::abs(object->X() - 2570.097065) < 1e-12,
                  "Orekit XML object 1 X preserved in kilometers");
            CHECK(std::abs(object->X_DOT() - 4.418769571) < 1e-12,
                  "Orekit XML object 1 X_DOT preserved in kilometers per second");
            CHECK(object->COVARIANCE() && object->COVARIANCE()->size() == 45,
                  "Orekit XML object 1 covariance emits SDS 45-entry lower triangle");
            CHECK(std::abs(object->COVARIANCE()->Get(0) - 4.142e-5) < 1e-14,
                  "Orekit XML object 1 CR_R converted from m^2 to km^2");
            CHECK(std::abs(object->COVARIANCE()->Get(20) - 5.529e-11) < 1e-20,
                  "Orekit XML object 1 CNDOT_NDOT converted from m^2/s^2 to km^2/s^2");
        }
        if (cdm->OBJECT2() && cdm->OBJECT2()->OBJECT()) {
            const auto* object = cdm->OBJECT2();
            const auto* cat = object->OBJECT();
            CHECK(cat->NORAD_CAT_ID() == 30337, "Orekit XML object 2 designator maps to NORAD id");
            CHECK(cat->OBJECT_NAME() && cat->OBJECT_NAME()->str() == "FENGYUN 1C DEB",
                  "Orekit XML object 2 name preserved");
            CHECK(cat->OBJECT_TYPE() == spaceObjectClass::DEBRIS, "Orekit XML object 2 type preserved");
            CHECK(!cat->MANEUVERABLE(), "Orekit XML object 2 maneuverable flag preserved");
            CHECK(std::abs(object->COVARIANCE()->Get(0) - 1.337e-3) < 1e-14,
                  "Orekit XML object 2 CR_R converted from m^2 to km^2");
            CHECK(std::abs(object->COVARIANCE()->Get(1) + 4.806e-2) < 1e-12,
                  "Orekit XML object 2 CT_R converted from m^2 to km^2");
            CHECK(std::abs(object->COVARIANCE()->Get(20) - 5.178e-11) < 1e-20,
                  "Orekit XML object 2 CNDOT_NDOT converted from m^2/s^2 to km^2/s^2");
        }
    }

    char roundtrip[20000];
    int32_t xml_written = cdm_sds_to_xml(
        buffer,
        static_cast<uint32_t>(written),
        roundtrip,
        sizeof(roundtrip));
    CHECK(xml_written > 0, "SDS $CDM writes back to XML text");

    if (xml_written > 0) {
        const std::string roundtrip_text(roundtrip, roundtrip + xml_written);
        CHECK(roundtrip_text.find("<cdm") != std::string::npos,
              "Round-tripped XML includes CDM root");
        CHECK(roundtrip_text.find("<MISS_DISTANCE units=\"m\">715</MISS_DISTANCE>") != std::string::npos,
              "Round-tripped XML writes miss distance in CCSDS meter units");
        CHECK(roundtrip_text.find("<RELATIVE_SPEED units=\"m/s\">14762</RELATIVE_SPEED>") != std::string::npos,
              "Round-tripped XML writes relative speed in CCSDS meter-per-second units");
        CHECK(roundtrip_text.find("<OBJECT>OBJECT1</OBJECT>") != std::string::npos,
              "Round-tripped XML includes object 1 block");
        CHECK(roundtrip_text.find("<OBJECT>OBJECT2</OBJECT>") != std::string::npos,
              "Round-tripped XML includes object 2 block");

        uint8_t reparsed[16384];
        int32_t reparsed_size = cdm_xml_to_sds(
            roundtrip_text.data(),
            static_cast<uint32_t>(roundtrip_text.size()),
            reparsed,
            sizeof(reparsed));
        CHECK(reparsed_size > 0, "Round-tripped XML reparses to SDS $CDM");
        if (reparsed_size > 0) {
            const auto* reparsed_cdm = GetCDM(reparsed);
            CHECK(std::abs(reparsed_cdm->MISS_DISTANCE() - 0.715) < 1e-12,
                  "Round-tripped XML preserves miss distance");
            CHECK(std::abs(reparsed_cdm->RELATIVE_POSITION_N() - 0.7118) < 1e-12,
                  "Round-tripped XML preserves relative state vector");
            CHECK(std::abs(reparsed_cdm->OBJECT2()->COVARIANCE()->Get(2) - 2.492) < 1e-12,
                  "Round-tripped XML preserves object 2 CT_T covariance in km^2");
        }
    }
}

int main() {
    std::cout << "=== CDM FlatBuffers Output Tests ===" << std::endl;

    test_single_cdm_output();
    test_batch_cdm_output();
    test_buffer_too_small();
    test_cdm_import_pc();
    test_orekit_cdm_example1_kvn_roundtrip();
    test_orekit_cdm_example1_xml_roundtrip();

    std::cout << "\n=== Summary: " << tests_passed << " passed, "
              << tests_failed << " failed ===" << std::endl;

    return tests_failed > 0 ? 1 : 0;
}
