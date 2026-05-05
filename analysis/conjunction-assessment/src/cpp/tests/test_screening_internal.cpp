#include "conjunction/screening_internal.h"

#include <cassert>

int main() {
    assert(conjunction::is_conjunction_within_threshold(15.0, 15.0));
    assert(conjunction::is_conjunction_within_threshold(14.999, 15.0));
    assert(!conjunction::is_conjunction_within_threshold(15.001, 15.0));
    assert(!conjunction::is_conjunction_within_threshold(8000.0, 15.0));
    assert(!conjunction::is_conjunction_within_threshold(-1.0, 15.0));
    assert(!conjunction::is_conjunction_within_threshold(1.0, -15.0));
    return 0;
}
