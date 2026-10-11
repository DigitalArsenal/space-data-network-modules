/*
 * files/ccsds-messages — pieces several messages share.
 *
 * The position/velocity covariance every ODM carries is a 6x6 lower triangle
 * with fixed keyword names and units; the SDS records hold it as a flat array of
 * 21 doubles in that order. USER_DEFINED parameters are the same pair of text
 * everywhere. Both are written once here.
 */

#ifndef CCSDS_MESSAGES_NDM_COMMON_HPP
#define CCSDS_MESSAGES_NDM_COMMON_HPP

#include "ndm_core.hpp"

namespace ndm {

/* The 21 lower-triangle covariance keywords of CCSDS 502.0-B-3, in the order the
 * SDS records store them: CX_X, CY_X, CY_Y, CZ_X, CZ_Y, CZ_Z, CX_DOT_X, ... */
inline const char* const* covariance_names() {
    static const char* const names[21] = {
        "CX_X",         "CY_X",         "CY_Y",         "CZ_X",         "CZ_Y",
        "CZ_Z",         "CX_DOT_X",     "CX_DOT_Y",     "CX_DOT_Z",     "CX_DOT_X_DOT",
        "CY_DOT_X",     "CY_DOT_Y",     "CY_DOT_Z",     "CY_DOT_X_DOT", "CY_DOT_Y_DOT",
        "CZ_DOT_X",     "CZ_DOT_Y",     "CZ_DOT_Z",     "CZ_DOT_X_DOT", "CZ_DOT_Y_DOT",
        "CZ_DOT_Z_DOT"};
    return names;
}

/* Units of covariance cell `index`: position x position, position x velocity,
 * velocity x velocity. */
inline const char* covariance_units(size_t index) {
    /* Row r of the triangle holds r+1 cells; cell (row, col) with row, col in 0..5. */
    size_t row = 0, base = 0;
    while (base + row + 1 <= index) {
        base += row + 1;
        ++row;
    }
    const size_t col = index - base;
    const bool row_velocity = row >= 3;
    const bool col_velocity = col >= 3;
    if (!row_velocity && !col_velocity) return "km**2";
    if (row_velocity && col_velocity) return "km**2/s**2";
    return "km**2/s";
}

/* The 21 keywords bound to cell i of a std::vector<double> member `P` of C. The
 * array is created, zero-filled, on the first cell read. */
template <class C, std::vector<double> C::*P>
inline void add_covariance_leaves(std::vector<Item>* items, bool matrix) {
    for (size_t i = 0; i < 21; ++i) {
        Leaf l;
        l.name = covariance_names()[i];
        l.units = covariance_units(i);
        l.required = true;
        l.matrix = matrix;
        l.take = [i](Obj* o, const std::string& t, std::string* e) {
            std::vector<double>& v = static_cast<C*>(o)->*P;
            if (v.size() != 21) v.assign(21, 0.0);
            return Conv<double>::take(v[i], t, e);
        };
        l.give = [i](const Obj* o, bool, std::vector<std::string>* out) {
            const std::vector<double>& v = static_cast<const C*>(o)->*P;
            if (v.size() == 21) out->push_back(format_double(v[i]));
        };
        items->push_back(Item(l));
    }
}

/* A USER_DEFINED leaf whose parameters are kept as (name, value) pairs in a
 * vector of tables with PARAM_NAME and PARAM_VALUE members. */
template <class C, class T, std::vector<std::unique_ptr<T>> C::*P>
inline Leaf user_defined_leaf() {
    Leaf l;
    l.name = "USER_DEFINED";
    l.user_defined = true;
    l.take_param = [](Obj* o, const std::string& name, const std::string& value, std::string*) {
        auto p = std::make_unique<T>();
        p->PARAM_NAME = name;
        p->PARAM_VALUE = value;
        (static_cast<C*>(o)->*P).push_back(std::move(p));
        return true;
    };
    l.give_param = [](const Obj* o, std::vector<std::pair<std::string, std::string>>* out) {
        for (const auto& p : static_cast<const C*>(o)->*P) {
            out->push_back(std::make_pair(p->PARAM_NAME, p->PARAM_VALUE));
        }
    };
    return l;
}

}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_COMMON_HPP
