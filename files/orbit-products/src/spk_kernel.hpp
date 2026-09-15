/* Geometric NAIF body states from an immutable caller-owned SPK byte buffer.
 * No filesystem, time-scale approximation, light-time or aberration correction.
 * See NAIF SPK Required Reading, "Computing States", "Data Precedence", and
 * "Segment Order and Priority":
 * https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/spk.html
 */
#ifndef ORBIT_PRODUCTS_SPK_KERNEL_HPP
#define ORBIT_PRODUCTS_SPK_KERNEL_HPP

#include "spk_read.hpp"

namespace spk {

class Kernel {
public:
    /* Retains a view, not a copy, of bytes. Keep the buffer alive and immutable
     * until the final state query. Only bounded segment metadata is copied;
     * comments and coefficient records remain in the original buffer. */
    ephem::Status load(const uint8_t* bytes, size_t size) {
        loaded_ = false;
        file_ = daf::File{};
        start_jd_ = end_jd_ = 0.0;
        ephem::Status st = daf::read(bytes, size, &file_, false, 4096);
        if (st != ephem::Status::Ok) return st;
        if ((file_.id_word != "DAF/SPK" && file_.id_word != "NAIF/DAF") ||
            file_.nd != 2 || file_.ni != 6) return ephem::Status::UnsupportedVariant;
        if (file_.summaries.empty()) return ephem::Status::NotEnoughStates;
        double first = file_.summaries.front().dc[0];
        double last = file_.summaries.front().dc[1];
        for (const auto& s : file_.summaries) {
            if (!ephem::is_finite(s.dc[0]) || !ephem::is_finite(s.dc[1]) ||
                s.dc[0] > s.dc[1] || s.ic[4] < 1 || s.ic[5] < s.ic[4]) {
                return ephem::Status::Malformed;
            }
            if (static_cast<size_t>(s.ic[5]) > size / 8) return ephem::Status::Truncated;
            if (s.dc[0] < first) first = s.dc[0];
            if (s.dc[1] > last) last = s.dc[1];
        }
        start_jd_ = 2451545.0 + first / 86400.0;
        end_jd_ = 2451545.0 + last / 86400.0;
        loaded_ = true;
        return ephem::Status::Ok;
    }

    bool loaded() const { return loaded_; }
    /* Overall file extent only; individual bodies can have narrower coverage. */
    double start_jd() const { return start_jd_; }
    double end_jd() const { return end_jd_; }

    /* Epoch is a TDB Julian date. Output is geometric target minus center in
     * ICRF/J2000, km and km/s. StateRow::epoch is TDB seconds past J2000.
     * Use state_et when sub-microsecond epoch representation matters: a single
     * double Julian date near today has approximately 40 microseconds spacing. */
    ephem::Status state(int target, int center, double jd_tdb, ephem::StateRow* out) const {
        if (!ephem::is_finite(jd_tdb)) return ephem::Status::Malformed;
        return state_et(target, center, (jd_tdb - 2451545.0) * 86400.0, out);
    }

    ephem::Status state_et(int target, int center, double et, ephem::StateRow* out) const {
        if (out == nullptr || !ephem::is_finite(et)) return ephem::Status::Malformed;
        *out = ephem::StateRow{};
        if (!loaded_) return ephem::Status::Malformed;
        if (target == center) {
            out->epoch = et;
            out->has_vel = true;
            return ephem::Status::Ok;
        }

        /* Preserve states at each ancestor. Resolving at the nearest common
         * ancestor avoids subtracting ~1 AU numbers to obtain a lunar state,
         * and permits a Moon/Earth-only excerpt without an EMB/SSB segment. */
        Link target_path[kMaxChain];
        size_t target_count = 1;
        target_path[0].body = target;
        ephem::Status target_status = ephem::Status::OutOfRange;
        while (target_count < kMaxChain) {
            const Link& previous = target_path[target_count - 1];
            if (previous.body == center || previous.body == 0) break;
            Link next;
            target_status = ascend(previous, et, &next);
            if (target_status != ephem::Status::Ok) break;
            for (size_t i = 0; i < target_count; ++i) {
                if (target_path[i].body == next.body) return ephem::Status::Malformed;
            }
            target_path[target_count++] = next;
        }
        if (target_count == kMaxChain) return ephem::Status::UnsupportedVariant;

        Link observer;
        observer.body = center;
        int observer_path[kMaxChain];
        size_t observer_count = 0;
        while (observer_count < kMaxChain) {
            for (size_t i = 0; i < target_count; ++i) {
                if (target_path[i].body == observer.body) {
                    ephem::StateRow result;
                    result.epoch = et;
                    result.has_vel = true;
                    for (int axis = 0; axis < 3; ++axis) {
                        result.pos[axis] = target_path[i].pos[axis] - observer.pos[axis];
                        result.vel[axis] = target_path[i].vel[axis] - observer.vel[axis];
                    }
                    if (!ephem::row_is_finite(result)) return ephem::Status::Malformed;
                    *out = result;
                    return ephem::Status::Ok;
                }
            }
            if (observer.body == 0) break;
            observer_path[observer_count++] = observer.body;
            Link next;
            const ephem::Status st = ascend(observer, et, &next);
            if (st != ephem::Status::Ok) {
                return st == ephem::Status::OutOfRange ? failure_or_range(target_status) : st;
            }
            for (size_t i = 0; i < observer_count; ++i) {
                if (observer_path[i] == next.body) return ephem::Status::Malformed;
            }
            observer = next;
        }
        if (observer_count == kMaxChain) return ephem::Status::UnsupportedVariant;
        return failure_or_range(target_status);
    }

private:
    static constexpr size_t kMaxChain = 64;
    struct Link {
        int body = 0;
        double pos[3] = {0.0, 0.0, 0.0};
        double vel[3] = {0.0, 0.0, 0.0};
    };

    static ephem::Status failure_or_range(ephem::Status st) {
        return st == ephem::Status::Ok ? ephem::Status::OutOfRange : st;
    }

    ephem::Status ascend(const Link& from, double et, Link* to) const {
        /* Later segments have precedence. Select before checking type/frame:
         * an unsupported winning segment must not expose stale earlier data. */
        for (size_t i = file_.summaries.size(); i > 0; --i) {
            const daf::Summary& seg = file_.summaries[i - 1];
            if (segment_target(seg) != from.body || et < seg.dc[0] || et > seg.dc[1]) continue;
            if (segment_frame(seg) != 1) return ephem::Status::UnsupportedVariant;
            ephem::StateRow relative;
            const ephem::Status st = evaluate(file_, seg, et, &relative);
            if (st != ephem::Status::Ok) return st;
            to->body = segment_center(seg);
            for (int axis = 0; axis < 3; ++axis) {
                to->pos[axis] = from.pos[axis] + relative.pos[axis];
                to->vel[axis] = from.vel[axis] + relative.vel[axis];
                if (!ephem::is_finite(to->pos[axis]) || !ephem::is_finite(to->vel[axis])) {
                    return ephem::Status::Malformed;
                }
            }
            return ephem::Status::Ok;
        }
        return ephem::Status::OutOfRange;
    }

    daf::File file_;
    bool loaded_ = false;
    double start_jd_ = 0.0;
    double end_jd_ = 0.0;
};

}  // namespace spk
#endif
