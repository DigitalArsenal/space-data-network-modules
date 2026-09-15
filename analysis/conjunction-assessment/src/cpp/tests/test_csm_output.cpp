/**
 * CSM FlatBuffers Output Test
 *
 * Verifies conjunction events serialize to valid SDS Conjunction Summary
 * Message FlatBuffers with the $CSM file identifier.
 */

#include "conjunction/conjunction_assessment.h"
#ifdef SING
#undef SING
#endif
#include "CSM_generated.h"
#include "flatbuffers/flatbuffers.h"

#include <cmath>
#include <iostream>
#include <string>

using namespace conjunction;

static int tests_passed = 0;
static int tests_failed = 0;

#define CHECK(cond, msg) do { \
    if (cond) { tests_passed++; std::cout << "  ✓ " << msg << std::endl; } \
    else { tests_failed++; std::cout << "  ✗ " << msg << std::endl; } \
} while(0)

void test_single_csm_output() {
    std::cout << "\n--- Test: Single CSM Output ---" << std::endl;

    // Source fields mirror the SDS CSM Conjunction Summary Message schema.
    // Units are module-native: TCA as Unix seconds, range in km, speed in km/s,
    // probability unitless, dilution in km, and DSE in days.
    ConjunctionEvent event;
    event.obj1.name = "STARLINK-1234";
    event.obj1.norad_cat_id = 45678;
    event.obj2.name = "COSMOS 2251 DEB";
    event.obj2.norad_cat_id = 34567;
    event.tca_jd = 2460784.5;
    event.min_range_km = 0.234;
    event.rel_speed_kms = 14.7;
    event.max_probability = 1.23e-4;
    event.dilution_threshold_km = 0.118;
    event.dse1 = 4.25;
    event.dse2 = 17.5;

    uint8_t buffer[4096];
    int32_t written = conjunction_to_csm(event, buffer, sizeof(buffer));

    CHECK(written > 0, "CSM serialization succeeded (" + std::to_string(written) + " bytes)");
    CHECK(flatbuffers::BufferHasIdentifier(buffer, "$CSM"), "Buffer has $CSM file identifier");

    flatbuffers::Verifier verifier(buffer, static_cast<size_t>(written));
    CHECK(VerifyCSMBuffer(verifier), "CSM FlatBuffer verifier accepts buffer");

    const auto* csm = GetCSM(buffer);
    CHECK(csm != nullptr, "CSM deserialized successfully");
    if (csm) {
        CHECK(csm->OBJECT_1() != nullptr, "CSM object 1 present");
        CHECK(csm->OBJECT_2() != nullptr, "CSM object 2 present");
        if (csm->OBJECT_1()) {
            CHECK(csm->OBJECT_1()->OBJECT_NAME() &&
                  csm->OBJECT_1()->OBJECT_NAME()->str() == "STARLINK-1234",
                  "CSM object 1 name preserved");
            CHECK(csm->OBJECT_1()->NORAD_CAT_ID() == 45678,
                  "CSM object 1 NORAD ID preserved");
        }
        if (csm->OBJECT_2()) {
            CHECK(csm->OBJECT_2()->OBJECT_NAME() &&
                  csm->OBJECT_2()->OBJECT_NAME()->str() == "COSMOS 2251 DEB",
                  "CSM object 2 name preserved");
            CHECK(csm->OBJECT_2()->NORAD_CAT_ID() == 34567,
                  "CSM object 2 NORAD ID preserved");
        }

        const double expected_unix = (event.tca_jd - 2440587.5) * 86400.0;
        CHECK(std::abs(csm->TCA() - expected_unix) < 1e-6,
              "CSM TCA converts Julian date to Unix seconds");
        CHECK(std::abs(csm->TCA_RANGE() - 0.234) < 1e-12,
              "CSM range preserved in kilometers");
        CHECK(std::abs(csm->TCA_RELATIVE_SPEED() - 14.7) < 1e-12,
              "CSM relative speed preserved in kilometers per second");
        CHECK(std::abs(csm->MAX_PROB() - 1.23e-4) < 1e-15,
              "CSM probability preserved");
        CHECK(std::abs(csm->DILUTION() - 0.118) < 1e-15,
              "CSM dilution preserved");
        CHECK(std::abs(csm->DSE_1() - 4.25) < 1e-15,
              "CSM object 1 days-since-epoch preserved");
        CHECK(std::abs(csm->DSE_2() - 17.5) < 1e-15,
              "CSM object 2 days-since-epoch preserved");
    }
}

void test_buffer_too_small() {
    std::cout << "\n--- Test: CSM Buffer Too Small ---" << std::endl;

    ConjunctionEvent event;
    event.obj1.name = "SAT-A";
    event.obj1.norad_cat_id = 11111;
    event.obj2.name = "SAT-B";
    event.obj2.norad_cat_id = 22222;
    event.tca_jd = 2460784.5;
    event.min_range_km = 1.0;
    event.rel_speed_kms = 10.0;
    event.max_probability = 1e-5;
    event.dilution_threshold_km = 0.01;

    uint8_t tiny_buffer[10];
    int32_t written = conjunction_to_csm(event, tiny_buffer, sizeof(tiny_buffer));
    CHECK(written == -2, "Returns -2 for CSM buffer too small");
}

int main() {
    std::cout << "=== CSM FlatBuffers Output Tests ===" << std::endl;

    test_single_csm_output();
    test_buffer_too_small();

    std::cout << "\n=== Summary: " << tests_passed << " passed, "
              << tests_failed << " failed ===" << std::endl;

    return tests_failed > 0 ? 1 : 0;
}
