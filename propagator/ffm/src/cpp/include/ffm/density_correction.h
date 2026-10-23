#pragma once
// Published SDS 1.259.0 DCL: UTC nodes of ln(rho / rho_NRLMSISE00).
// This owns only the validated series; interpolation and exp stay in WASM.
#include "ffm/prw_codec.h"
#include "DCL_generated.h"
#include <algorithm>

namespace ffm::dynamics {
class DensityCorrection {
public:
    std::vector<TTEpoch> knots;
    bool identity = true;
    bool load(const uint8_t* data, size_t size, std::string& error) {
        const auto fail = [&](const char* why) { error = std::string("invalid-density-correction: ") + why; return false; };
        if (!data || size < 8) return fail("Expected a DCL record.");
        const bool prefixed = size >= 12 && flatbuffers::ReadScalar<uint32_t>(data) == size - 4 &&
            std::memcmp(data + 8, "$DCL", 4) == 0;
        flatbuffers::Verifier verifier(data, size);
        if (!(prefixed ? VerifySizePrefixedDCLBuffer(verifier) : VerifyDCLBuffer(verifier))) return fail("DCL verification failed.");
        const DCL* record = prefixed ? GetSizePrefixedDCL(data) : GetDCL(data);
        if (record->STATUS() != dclStatus::Solved) return fail("The published calibration must be Solved.");
        if (!record->ATMOSPHERE() || record->ATMOSPHERE()->MODEL() != AtmosphericModelFamily::NRLMSIS00E)
            return fail("The baseline atmosphere must be NRLMSISE-00.");
        const auto* c = record->CORRECTION();
        if (!c || c->FORM() != dclCorrectionForm::LogDensityNodes) return fail("Expected LogDensityNodes.");
        if ((c->NODE_ALTITUDES_KM() && c->NODE_ALTITUDES_KM()->size()) ||
            (c->NODE_VALUES_K() && c->NODE_VALUES_K()->size()) ||
            (c->NODE_SIGMAS_K() && c->NODE_SIGMAS_K()->size()) ||
            (c->SEGMENTS() && c->SEGMENTS()->size())) return fail("Log-density nodes cannot carry temperature, altitude or harmonic values.");
        const auto* times = c->NODE_TIMES_MS();
        const auto* values = c->NODE_LOG_DENSITY_SCALE_DIMENSIONLESS();
        if (!times || !values || !times->size() || times->size() != values->size()) return fail("Expected one dimensionless value per UTC node.");
        int64_t first = times->Get(0), previous = 0;
        for (size_t i = 0; i < times->size(); ++i) {
            const int64_t ms = times->Get(i);
            const double value = values->Get(i), scale = std::exp(value);
            if (ms < 63072000000LL || ms > 253402300799999LL || (i && ms <= previous)) return fail("UTC nodes must increase strictly within 1972..9999.");
            if (!std::isfinite(value) || !std::isfinite(scale) || !(scale > 0)) return fail("Log-density values must have a finite positive exponential.");
            TTEpoch tt;
            const int64_t fromJ2000 = ms - 946728000000LL;
            if (!toTT(double(fromJ2000 / 1000), double(fromJ2000 % 1000) / 1000,
                      2440587.5 + double(ms) / 86400000, timingStandard::UTC, tt, error)) return false;
            knots.push_back(tt);
            seconds_.push_back(double(ms - first) / 1000);
            values_.push_back(value);
            identity = identity && value == 0;
            previous = ms;
        }
        utcDay_ = 2440587.5 + double(first / 86400000);
        utcSeconds_ = double(first % 86400000) / 1000;
        // A constant (including zero) has no slope changes or integration restarts.
        if (std::all_of(values_.begin(), values_.end(), [&](double s) { return s == values_.front(); })) knots.clear();
        return true;
    }
    double factor(const timesys::Instant& at) const {
        const auto utc = at.utc();
        const double seconds = ((utc.jd1 - utcDay_) + utc.jd2) * 86400 - utcSeconds_;
        const auto upper = std::upper_bound(seconds_.begin(), seconds_.end(), seconds);
        double s;
        if (upper == seconds_.begin()) s = values_.front();
        else if (upper == seconds_.end()) s = values_.back();
        else {
            const size_t i = size_t(upper - seconds_.begin()) - 1;
            const double w = (seconds - seconds_[i]) / (seconds_[i + 1] - seconds_[i]);
            s = values_[i] * (1 - w) + values_[i + 1] * w;
        }
        return s == 0 ? 1 : std::exp(s);
    }
private:
    double utcDay_ = 0, utcSeconds_ = 0;
    std::vector<double> seconds_, values_;
};
}
