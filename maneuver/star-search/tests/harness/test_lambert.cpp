#include "lambert.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace {

int failures = 0;

#define CHECK(condition)                                                                            \
    do {                                                                                            \
        if (!(condition)) {                                                                         \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);              \
            ++failures;                                                                             \
        }                                                                                           \
    } while (false)

bool close(double actual, double expected, double relative = 2e-12) {
    return std::abs(actual - expected) <= relative * std::max(1.0, std::abs(expected));
}

struct Expected {
    std::size_t index;
    int nrev;
    star_search::Vec3 v1;
    star_search::Vec3 v2;
    double axis;
};

}  // namespace

int main() {
    using namespace star_search;

    double W = 0.0;
    double dW = 0.0;
    double ddW = 0.0;
    w_and_derivatives(-0.001, 1, 2e-2, 1e-12, &W, &dW, &ddW);
    CHECK(close(W, 3.3331647034086354));
    CHECK(close(dW, -1.0050002495552375));
    CHECK(close(ddW, 5.0022620568678695));
    w_and_derivatives(std::sqrt(2.0) + 1e-3, 0, 2e-2, 1e-12, &W, &dW, &ddW);
    CHECK(close(W, 0.4712046015715015));

    const LambertInput inputs[] = {
        {{1.0, 0.0, 0.0}, {0.0, 1.0, 0.0}, 1.7, 0},
        {{1.2, -0.1, 0.2}, {-0.2, 1.1, 0.1}, 4.2, 0},
        {{0.7, 0.8, -0.1}, {-0.9, 0.1, 0.2}, 8.0, 0},
        {{-0.8, 0.5, 0.3}, {0.6, -0.7, 0.1}, 12.0, 0},
    };
    const Expected expected[] = {
        {0U, 0, {0.07342297755383628, 0.9639621510318946, 0.0},
         {-0.9639621510318946, -0.07342297755383628, -0.0}, 0.9386269057143997},
        {1U, 0, {0.4427235280390775, 0.698243633627862, 0.16426568679188133},
         {-0.6976005725054432, -0.5740204170067728, -0.1940703064594889}, 1.077664789330809},
        {2U, 0, {-0.07692828707619459, 1.0540657616520324, 0.08326721124753757},
         {0.6637250889096015, -0.9619568574537093, -0.2037102632750857}, 1.3346402068758607},
        {3U, 0, {-0.7425297038664987, -0.17357025871063467, 0.9160999625771334},
         {-0.046817267273419644, 0.9048219099885848, -0.8580046427151652}, 1.667809249878858},
        {0U, 0, {-0.7249781882687192, -0.7011830091786625, -0.0},
         {0.7011830091786625, 0.7249781882687192, 0.0}, 1.0175538062897398},
        {1U, 0, {-0.17366561703414565, -0.8109654064163071, -0.13053658226497122},
         {0.841910600517927, 0.3221169441663159, 0.18859857629671828}, 1.0711232193110254},
        {2U, 0, {0.9470354085265152, -0.4151660052956115, -0.23006875913201036},
         {0.3822149924904232, 1.122247812532331, -0.01122045328703216}, 1.3315559506506227},
        {3U, 0, {-0.31840382221478514, 0.9555980262677797, -0.6371942040529945},
         {-0.9047433860954514, 0.04673976726664117, 0.85800361882881}, 1.6673890529199573},
        {3U, 1, {0.24662694843588234, -0.9020265033673035, 0.6553995549314212},
         {0.8397958947071111, 0.017417670301539862, -0.8572135650086511}, 1.3961023791926122},
        {3U, -1, {-0.4920702723668967, -0.35629516061948713, 0.8483654329863839},
         {0.17619703646682747, 0.679555565253765, -0.8557526017205923}, 1.073535246181211},
        {3U, 1, {0.6701056722788347, 0.22628889116903647, -0.8963945634478709},
         {-0.017568427026762246, -0.8396434169265214, 0.8572118439532836}, 1.395607963104705},
        {3U, -1, {-0.06891632075854978, 0.7698048628722405, -0.7008885421136909},
         {-0.679350231641988, -0.17640094628187658, 0.8557511779238647}, 1.0732937783819958},
    };

    MemoryBudget budget(1024U * 1024U);
    Buffer<LambertSolution> solutions;
    ThreadOptions options{};
    options.requested_threads = 1U;
    CHECK(lambert_batch(
              inputs,
              4U,
              1.0,
              2,
              true,
              0.0,
              2e-2,
              1e-6,
              options,
              64U,
              &budget,
              &solutions) == Status::Ok);
    CHECK(solutions.size() == 12U);
    if (solutions.size() == 12U) {
        for (std::size_t row = 0U; row < solutions.size(); ++row) {
            CHECK(solutions[row].input_index == expected[row].index);
            CHECK(solutions[row].nrev_signed == expected[row].nrev);
            CHECK(close(solutions[row].v1_km_s.x, expected[row].v1.x));
            CHECK(close(solutions[row].v1_km_s.y, expected[row].v1.y));
            CHECK(close(solutions[row].v1_km_s.z, expected[row].v1.z));
            CHECK(close(solutions[row].v2_km_s.x, expected[row].v2.x));
            CHECK(close(solutions[row].v2_km_s.y, expected[row].v2.y));
            CHECK(close(solutions[row].v2_km_s.z, expected[row].v2.z));
            CHECK(close(solutions[row].semi_major_axis_km, expected[row].axis));
        }
    }

    if (failures != 0) {
        std::fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    std::puts("test_lambert: PASS");
    return 0;
}
