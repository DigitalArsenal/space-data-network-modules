// provider_source_cid_test — byte-match proof for the in-guest CIDv1 helper.
//
// storage.ingest_with_source (A2.2c-3) is a batch op that returns only an
// inserted count, so provider_source::publish_record_with_source computes the
// stored record's CID IN-GUEST. That value MUST byte-match the CID the SDN host
// assigns for the same bytes (storage.computeCID -> cidV1RawSHA256 ->
// cid.NewCidV1(cid.Raw, mh.Sum(data, SHA2_256)).String()). The expected strings
// below were captured directly from the Go storage package's computeCID over
// the listed inputs (go-cid / go-multihash), so this test locks the two
// implementations together.
//
// Build + run:  common/tests/run-native.sh
#include <cstdio>
#include <string>
#include <vector>
#include "provider_source.hpp"

namespace ps = provider_source;

// The WASM host imports are referenced only by inline hostcall helpers this test
// never calls; stub them so the native link resolves.
extern "C" int32_t sdm_host_call(const char*, int32_t, const char*, int32_t) { return 0; }
extern "C" int32_t sdm_host_response_len(void) { return 0; }
extern "C" int32_t sdm_host_read_response(char*, int32_t) { return 0; }
extern "C" int32_t sdm_host_clear_response(void) { return 0; }
extern "C" int32_t sdm_host_last_status_code(void) { return 0; }

int main() {
    struct V { const char* name; std::string data; const char* expect; };
    // Ground truth: storage.computeCID(<data>) on the SDN host (go-cid).
    std::vector<V> vectors = {
        {"empty", "", "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"},
        {"hello", "hello", "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"},
        {"json", "{\"NORAD_CAT_ID\":12345}", "bafkreifftf3q432s3j35vchqcsfxgfv57ej6osrinxu4erwzki6cxngtbe"},
        {"oemish", "{\"CCSDS_OEM_VERS\":2.0,\"EPHEMERIS_DATA\":[1.5,-2.25,3.0]}", "bafkreieh5erg2vyvgmgehfpdharbz6rfcrkc3l4xudwh5yefiaz6fnpr6q"},
    };
    int fails = 0;
    for (const auto& v : vectors) {
        std::string got = ps::cid_v1_raw_sha256(
            reinterpret_cast<const uint8_t*>(v.data.data()), v.data.size());
        bool ok = (got == v.expect);
        printf("[cid %-6s] len=%zu %s\n         got    %s\n         expect %s\n",
               v.name, v.data.size(), ok ? "MATCH" : "MISMATCH", got.c_str(), v.expect);
        if (!ok) fails++;
    }
    // sha256_hex must remain byte-identical after the sha256_raw refactor.
    struct H { std::string data; const char* expect; };
    std::vector<H> hashes = {
        {"", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
        {"hello", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},
    };
    for (const auto& h : hashes) {
        std::string got = ps::sha256_hex(
            reinterpret_cast<const uint8_t*>(h.data.data()), h.data.size());
        bool ok = (got == h.expect);
        printf("[sha256 %-6s] %s %s\n", ("\"" + h.data + "\"").c_str(), ok ? "MATCH" : "MISMATCH", got.c_str());
        if (!ok) fails++;
    }
    if (fails) { printf("\nFAIL: %d mismatch(es)\n", fails); return 1; }
    printf("\nPASS: in-guest CIDv1 byte-matches go-cid; sha256_hex byte-identical (FIPS-180-4)\n");
    return 0;
}
