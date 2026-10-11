/*
 * files/ccsds-messages — reference frame names <-> the SDS $RFM table.
 *
 * REF_FRAME, COV_REF_FRAME, TRAJ_REF_FRAME and their kin are free text in a
 * message and a TABLE in the record: `RFM.NAME` holds the name as the message
 * spelled it, and the `REFERENCE_FRAME` union holds the registry member the name
 * is, when it is one. The name is always kept, so a frame this build has no
 * registry member for (ITRF-93, a mission frame) still round-trips; the union is
 * set only when the name is exactly a member of the celestial, orbit, custom or
 * spacecraft frame enumerations, which is the SANA registry.
 *
 * Requires the generated $RFM object-API types (and ndm_core.hpp) in scope.
 */

#ifndef CCSDS_MESSAGES_NDM_FRAMES_HPP
#define CCSDS_MESSAGES_NDM_FRAMES_HPP

#include "ndm_core.hpp"

namespace ndm {

NDM_ENUM(CelestialFrame);
NDM_ENUM(SpacecraftFrame);
NDM_ENUM(OrbitFrame);
NDM_ENUM(CustomFrame);

namespace frames {

template <class E>
inline bool find_member(const std::string& text, E* out) {
    const E* values = EnumTraits<E>::values();
    for (size_t i = 0; i < EnumTraits<E>::count(); ++i) {
        const char* name = EnumTraits<E>::name(values[i]);
        if (name && text == name) {
            *out = values[i];
            return true;
        }
    }
    return false;
}

/* `SC_BODY_3` -> member `SC_BODY_i`, index 3. */
inline bool find_spacecraft(const std::string& text, SpacecraftFrame* out, int* index) {
    const size_t us = text.rfind('_');
    if (us == std::string::npos || us + 1 >= text.size()) return false;
    long long n = 0;
    if (!parse_i64(text.substr(us + 1), &n) || n < 0 || n > 1000000) return false;
    if (!find_member(text.substr(0, us) + "_i", out)) return false;
    *index = static_cast<int>(n);
    return true;
}

inline void set(RFMT& rfm, const std::string& text) {
    rfm = RFMT();
    rfm.NAME = text;
    CelestialFrame celestial;
    OrbitFrame orbit;
    CustomFrame custom;
    SpacecraftFrame spacecraft;
    int index = 0;
    if (find_member(text, &celestial)) {
        CelestialFrameWrapperT w;
        w.frame = celestial;
        rfm.REFERENCE_FRAME.Set(std::move(w));
    } else if (find_member(text, &orbit)) {
        OrbitFrameWrapperT w;
        w.frame = orbit;
        rfm.REFERENCE_FRAME.Set(std::move(w));
    } else if (find_member(text, &custom)) {
        CustomFrameWrapperT w;
        w.frame = custom;
        rfm.REFERENCE_FRAME.Set(std::move(w));
    } else if (find_spacecraft(text, &spacecraft, &index)) {
        SpacecraftFrameWrapperT w;
        w.frame = spacecraft;
        rfm.REFERENCE_FRAME.Set(std::move(w));
        rfm.INDEX = index;
    }
}

/* The name the record states: the message's own spelling, else the registry
 * member the union holds. Empty when the record names no frame. */
inline std::string name_of(const RFMT& rfm) {
    if (!rfm.NAME.empty()) return rfm.NAME;
    std::string name;
    if (const CelestialFrameWrapperT* w = rfm.REFERENCE_FRAME.AsCelestialFrameWrapper()) {
        name = EnumNameCelestialFrame(w->frame);
    } else if (const OrbitFrameWrapperT* w = rfm.REFERENCE_FRAME.AsOrbitFrameWrapper()) {
        name = EnumNameOrbitFrame(w->frame);
    } else if (const CustomFrameWrapperT* w = rfm.REFERENCE_FRAME.AsCustomFrameWrapper()) {
        name = EnumNameCustomFrame(w->frame);
    } else if (const SpacecraftFrameWrapperT* w = rfm.REFERENCE_FRAME.AsSpacecraftFrameWrapper()) {
        name = EnumNameSpacecraftFrame(w->frame);
        if (name.size() >= 2 && name.compare(name.size() - 2, 2, "_i") == 0) {
            name = name.substr(0, name.size() - 1) + std::to_string(rfm.INDEX);
        }
    }
    return name;
}

}  // namespace frames

template <>
struct Conv<std::unique_ptr<RFMT>> {
    static bool take(std::unique_ptr<RFMT>& m, const std::string& t, std::string*) {
        m = std::make_unique<RFMT>();
        frames::set(*m, trim(t));
        return true;
    }
    static bool same(const std::unique_ptr<RFMT>& a, const std::unique_ptr<RFMT>& b) {
        return !a == !b;
    }
    static void give(const std::unique_ptr<RFMT>& m, const std::unique_ptr<RFMT>&, bool required,
                     std::vector<std::string>* out) {
        const std::string name = m ? frames::name_of(*m) : std::string();
        if (required || !name.empty()) out->push_back(name);
    }
};

}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_FRAMES_HPP
