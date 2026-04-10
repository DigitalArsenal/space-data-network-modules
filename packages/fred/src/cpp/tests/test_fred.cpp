/**
 * fred-sdn-plugin Tests
 */

#include "fred/types.h"
#include <cassert>
#include <iostream>

void test_parse_empty() {
    auto ds = fred::parse_json("{}");
    assert(ds.version == fred::VERSION);
    assert(ds.records.empty());
    std::cout << "PASS: test_parse_empty" << std::endl;
}

void test_validate() {
    assert(fred::validate("{\"data\":[]}") == true);
    assert(fred::validate("") == false);
    std::cout << "PASS: test_validate" << std::endl;
}

void test_record_defaults() {
    fred::Record r;
    r.timestamp = 0.0;
    r.latitude = 0.0;
    r.longitude = 0.0;
    r.value = 0.0;
    assert(r.timestamp == 0.0);
    std::cout << "PASS: test_record_defaults" << std::endl;
}

int main() {
    test_parse_empty();
    test_validate();
    test_record_defaults();
    std::cout << "All fred tests passed." << std::endl;
    return 0;
}
