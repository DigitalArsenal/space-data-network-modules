/*
 * files/orbit-products — NAIF spacecraft clock kernels (type 1 SCLK).
 *
 * A CK stores its times as ENCODED SCLK ticks, a count that runs unbroken from
 * the start of the first clock partition. What a tick IS in time comes from the
 * spacecraft clock kernel (SCLK): a table of coefficient triples
 *
 *     ( ticks at the start of the row,  parallel time at that tick,  rate )
 *
 * where the parallel time is seconds past J2000 on the kernel's declared time
 * system (TDB by default, TT when SCLK01_TIME_SYSTEM_<id> says 2) and the rate
 * is parallel-time seconds per MOST SIGNIFICANT clock count. A "most
 * significant count" is the product of the moduli of the clock's other fields,
 * so a tick converts to time as
 *
 *     time = parallel + (ticks - start) / ticks_per_count * rate
 *
 * on the last row whose start is not after the tick, and back the same way on
 * the last row whose parallel time is not after the time.
 *
 * NO TIME-SCALE CONVERSION HAPPENS HERE, per the spine's rule. The result is
 * on the kernel's own time system and the clock says which. CSPICE converts a
 * TT-parallel clock to ET (TDB) with the constants of a leap-seconds kernel;
 * this module is given no such kernel and does not approximate it, so a caller
 * that needs TDB reads a TDB-parallel clock or converts with the time module.
 *
 * The kernel is read with the repository's one text-kernel reader
 * (propagator/solar-system-bodies/src/text_kernel.hpp); this file only knows
 * which of its variables mean what.
 */

#ifndef ORBIT_PRODUCTS_NAIF_SCLK_HPP
#define ORBIT_PRODUCTS_NAIF_SCLK_HPP

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "text_kernel.hpp"

namespace sclk {

struct Clock {
    int32_t suffix = 0;      /* the positive id in the variable names, e.g. 76 for spacecraft -76 */
    int time_system = 1;     /* 1 = TDB, 2 = TT */
    int n_fields = 1;
    double ticks_per_count = 1.0;
    std::vector<double> rows; /* triples: start ticks, parallel time, rate */

    const char* time_system_name() const { return time_system == 2 ? "TT" : "TDB"; }
    size_t row_count() const { return rows.size() / 3; }

    /* Ticks to the parallel time. A tick before the first row extrapolates
     * with the first row, as the toolkit does. */
    double ticks_to_time(double ticks) const {
        size_t lo = 0, hi = row_count();
        while (hi - lo > 1) {
            const size_t mid = lo + (hi - lo) / 2;
            if (rows[mid * 3] <= ticks) lo = mid; else hi = mid;
        }
        const double* r = &rows[lo * 3];
        return r[1] + (ticks - r[0]) / ticks_per_count * r[2];
    }

    double time_to_ticks(double time) const {
        size_t lo = 0, hi = row_count();
        while (hi - lo > 1) {
            const size_t mid = lo + (hi - lo) / 2;
            if (rows[mid * 3 + 1] <= time) lo = mid; else hi = mid;
        }
        const double* r = &rows[lo * 3];
        return r[0] + (time - r[1]) * ticks_per_count / r[2];
    }
};

/* The clock a CK instrument is driven by, by NAIF's rule: the spacecraft whose
 * id is the instrument id divided by 1000, truncating toward zero (-76852 is on
 * spacecraft -76). A kernel pool variable can override the rule in the toolkit;
 * the request names the clock instead (see the module). */
inline int32_t spacecraft_of_instrument(int32_t instrument) { return instrument / 1000; }

/* Load the clock whose spacecraft id is `spacecraft` (negative for a
 * spacecraft; the variable names use the absolute value). Returns false with a
 * stable code and sentence. */
inline bool load(const ssb::KernelPool& pool, int32_t spacecraft, Clock* out,
                 std::string* code, std::string* message) {
    auto fail = [&](const char* c, const std::string& m) {
        *code = c;
        *message = m;
        return false;
    };
    const int32_t suffix = spacecraft < 0 ? -spacecraft : spacecraft;
    const std::string id = std::to_string(suffix);
    auto var = [&](const char* stem) { return std::string(stem) + "_" + id; };

    const std::vector<double>* type = pool.get(var("SCLK_DATA_TYPE"));
    if (!type) {
        /* Say which clocks the kernel does hold, so a wrong id is a one-line fix. */
        std::string held;
        for (const auto& kv : pool.numbers) {
            const std::string prefix = "SCLK_DATA_TYPE_";
            if (kv.first.compare(0, prefix.size(), prefix) == 0) {
                if (!held.empty()) held += ", ";
                held += kv.first.substr(prefix.size());
            }
        }
        return fail("sclk-clock-not-in-kernel",
                    "The SCLK kernel has no clock " + id + " (SCLK_DATA_TYPE_" + id + " is absent); it holds " +
                        (held.empty() ? std::string("none") : held) + ".");
    }
    if (type->size() != 1 || (*type)[0] != 1.0) {
        return fail("unsupported-sclk-type", "SCLK_DATA_TYPE_" + id +
                                                 " is not 1; only type 1 spacecraft clocks are read.");
    }
    *out = Clock{};
    out->suffix = suffix;

    if (const std::vector<double>* ts = pool.get(var("SCLK01_TIME_SYSTEM"))) {
        if (ts->size() != 1 || ((*ts)[0] != 1.0 && (*ts)[0] != 2.0)) {
            return fail("unsupported-sclk-time-system", "SCLK01_TIME_SYSTEM_" + id +
                                                            " is not 1 (TDB) or 2 (TT).");
        }
        out->time_system = static_cast<int>((*ts)[0]);
    }
    const std::vector<double>* nf = pool.get(var("SCLK01_N_FIELDS"));
    const std::vector<double>* moduli = pool.get(var("SCLK01_MODULI"));
    if (!nf || nf->size() != 1 || (*nf)[0] < 1.0 || (*nf)[0] > 8.0 || !moduli ||
        moduli->size() != static_cast<size_t>((*nf)[0])) {
        return fail("bad-sclk-kernel", "SCLK01_N_FIELDS_" + id + " and SCLK01_MODULI_" + id +
                                           " do not describe the same fields.");
    }
    out->n_fields = static_cast<int>((*nf)[0]);
    out->ticks_per_count = 1.0;
    for (size_t k = 1; k < moduli->size(); ++k) {
        if (!((*moduli)[k] >= 1.0)) {
            return fail("bad-sclk-kernel", "SCLK01_MODULI_" + id + " holds a modulus below 1.");
        }
        out->ticks_per_count *= (*moduli)[k];
    }
    const std::vector<double>* coeff = pool.get(var("SCLK01_COEFFICIENTS"));
    if (!coeff || coeff->size() < 3 || coeff->size() % 3 != 0) {
        return fail("bad-sclk-kernel", "SCLK01_COEFFICIENTS_" + id + " is not a table of triples.");
    }
    out->rows = *coeff;
    for (size_t i = 0; i < out->row_count(); ++i) {
        const double* r = &out->rows[i * 3];
        if (!std::isfinite(r[0]) || !std::isfinite(r[1]) || !(r[2] > 0.0) || !std::isfinite(r[2])) {
            return fail("bad-sclk-kernel", "SCLK01_COEFFICIENTS_" + id + " holds a row that is not finite and "
                                           "positive in rate.");
        }
        if (i > 0 && (!(r[0] > out->rows[(i - 1) * 3]) || !(r[1] > out->rows[(i - 1) * 3 + 1]))) {
            return fail("bad-sclk-kernel", "SCLK01_COEFFICIENTS_" + id + " rows do not increase.");
        }
    }
    return true;
}

}  // namespace sclk

#endif  // ORBIT_PRODUCTS_NAIF_SCLK_HPP
