#pragma once
#include "conjunction/conjunction_assessment.h"
#include "CDM_generated.h"
#include <memory>

namespace conjunction {
// One builder for direct $CDM emission and CQR event attachments.
std::unique_ptr<CDMT> build_conjunction_cdm(
    const ConjunctionEvent& event, const std::string& evaluation_frame = "TEME");

inline std::string covariance_failure_reason(bool has1, bool has2, bool psd1, bool psd2) {
    std::string reason;
    if (!has1 || !has2) {
        reason = "covariance absent for ";
        if (!has1) reason += "OBJECT1";
        if (!has1 && !has2) reason += " and ";
        if (!has2) reason += "OBJECT2";
    }
    if ((has1 && !psd1) || (has2 && !psd2)) {
        if (!reason.empty()) reason += "; ";
        reason += "covariance not positive semidefinite (non-PSD) for ";
        if (has1 && !psd1) reason += "OBJECT1";
        if (has1 && !psd1 && has2 && !psd2) reason += " and ";
        if (has2 && !psd2) reason += "OBJECT2";
    }
    return reason.empty() ? reason : "Collision probability calculation failed: " + reason + ".";
}

} // namespace conjunction
