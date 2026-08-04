// Native unit test for the per-schema bulk-route rule
// (foundation/http-route/src/bulk_route.h).
//
// It compiles the SAME header the wasm build prepends, with no SDK, wasm or
// flatbuffers dependency, so the routing rule stays verifiable while the flow
// bundle's toolchain lane is mid-migration.

#include "../src/bulk_route.h"

#include <cstdio>
#include <string>

namespace {

int failures = 0;

void expect_schema(const char* path, const char* want) {
    const std::string got = sdn_http_route::bulk_route_schema(path);
    if (got != want) {
        std::printf("FAIL bulk_route_schema(\"%s\") = \"%s\", want \"%s\"\n", path, got.c_str(), want);
        failures++;
    }
}

void expect_json_available(const char* schema, bool want) {
    const bool got = sdn_http_route::json_encode_available(schema);
    if (got != want) {
        std::printf("FAIL json_encode_available(\"%s\") = %d, want %d\n", schema, got ? 1 : 0, want ? 1 : 0);
        failures++;
    }
}

}  // namespace

int main() {
    // The route that already worked keeps working, byte for byte.
    expect_schema("/api/v1/data/omm/bulk", "OMM.fbs");
    // The route this change exists for: the live RF catalogue.
    expect_schema("/api/v1/data/rfb/bulk", "RFB.fbs");
    expect_schema("/api/v1/data/RFB/bulk", "RFB.fbs");
    expect_schema("/api/v1/data/cat/bulk", "CAT.fbs");
    expect_schema("/api/v1/data/spw/bulk", "SPW.fbs");
    // Mount-agnostic: the flow never knows its own mount path.
    expect_schema("/test/data/rfb/bulk", "RFB.fbs");
    expect_schema("/rfb/bulk", "RFB.fbs");

    // Not a per-schema bulk read.
    expect_schema("/bulk", "");
    expect_schema("/api/v1/data//bulk", "");
    expect_schema("/api/v1/data/query", "");
    expect_schema("/api/v1/data/rfb/bulk/extra", "");
    expect_schema("/api/v1/data/records/bafy", "");
    expect_schema("bulk", "");
    expect_schema("", "");

    // A standard code is alphanumeric and short. Anything else is a path, not
    // a schema — and must never become one.
    expect_schema("/api/v1/data/../bulk", "");
    expect_schema("/api/v1/data/rf-b/bulk", "");
    expect_schema("/api/v1/data/rf%2Fb/bulk", "");
    expect_schema("/api/v1/data/averylongstandardcode/bulk", "");

    // JSON presentation exists for $OMM alone until a schema-generic encoder
    // node does.
    expect_json_available("OMM.fbs", true);
    expect_json_available("RFB.fbs", false);
    expect_json_available("CAT.fbs", false);

    if (failures > 0) {
        std::printf("%d assertion(s) failed\n", failures);
        return 1;
    }
    std::printf("bulk_route: all assertions passed\n");
    return 0;
}
