/*
 * files/orbit-products — NAIF CK (C-kernel) type 3, read and write.
 *
 * A CK is a DAF whose segments hold the orientation of an INSTRUMENT frame
 * against a REFERENCE frame as a function of spacecraft clock ticks. The
 * container is the DAF layer's (`daf.hpp`); this file knows what a CK segment
 * MEANS, and only type 3 (discrete pointing with interpolation intervals),
 * which is the type NAIF's own writers produce and `oel io` writes. Types 1, 2,
 * 4, 5 and 6 are refused BY NAME, never skipped and never read as type 3.
 *
 * SUMMARY (ND = 2, NI = 6):   dc = { start ticks, stop ticks }
 *                             ic = { instrument, reference frame, data type,
 *                                    angular rates present (1/0), begin, end }
 *
 * TYPE 3 SEGMENT, in file order, with N pointing records and NINTS intervals:
 *
 *     N * (q0 q1 q2 q3 [av1 av2 av3])   pointing, SPICE quaternion, rad/s
 *     N                                 the ticks of the records
 *     (N-1)/100                         directory: every 100th tick
 *     NINTS                             the tick each interpolation interval starts
 *     (NINTS-1)/100                     directory: every 100th interval start
 *     NINTS, N                          the two counts, last
 *
 * (measured against CSPICE-written and NAIF-published kernels; the layout in
 * the Required Reading does not spell out the order of the last two words).
 *
 * THE QUATERNION is NAIF's: q0 is the scalar, and q2m(q) is the C-matrix that
 * rotates vectors from the reference frame to the instrument frame. CCSDS
 * 504.0-B-2 annex F defines its quaternion by the SAME frame-transformation
 * matrix with the opposite handedness of the vector part, so the two differ by
 * the sign of (q1 q2 q3) and nothing else:
 *
 *     CCSDS (Q1 Q2 Q3 QC) from frame A to frame B  =  (-q1 -q2 -q3 q0)
 *
 * A = reference frame, B = instrument frame. The mapping is exact (a sign), and
 * the test holds it against annex F's matrix and CSPICE's q2m.
 *
 * AN INTERVAL IS A CONTINUITY CLAIM. Between two intervals the segment makes no
 * claim about the attitude, so a segment with several intervals becomes several
 * attitude segments, one per interval; a single $AEM segment would assert
 * continuity the kernel does not.
 *
 * THE WRITER writes one interval per segment, LTL-IEEE, with the toolkit's FTP
 * string and name/summary record layout, so CSPICE reads the kernel with no
 * complaint (the test reads it back with spiceypy).
 */

#ifndef ORBIT_PRODUCTS_NAIF_CK_HPP
#define ORBIT_PRODUCTS_NAIF_CK_HPP

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "daf.hpp"
#include "ephemeris_series.hpp"
#include "spk_read.hpp"
#include "spk_write.hpp"

namespace ck {

struct Refusal {
    std::string code;
    std::string message;
};

inline bool fail(Refusal* r, const char* code, const std::string& message) {
    if (r) {
        r->code = code;
        r->message = message;
    }
    return false;
}

/* One interpolation interval: records between two interval start ticks. */
struct Interval {
    std::vector<double> ticks;
    std::vector<double> q;  /* 4 per record: q0 q1 q2 q3 */
    std::vector<double> av; /* 3 per record when the segment has rates, rad/s */
};

struct Segment {
    std::string name;
    int32_t instrument = 0;
    int32_t ref_frame = 0;
    bool has_av = false;
    int32_t begin_address = 0;
    int32_t end_address = 0;
    double start_ticks = 0.0;
    double stop_ticks = 0.0;
    std::vector<Interval> intervals;
};

/* The NAIF frame code for a frame name: the built-in inertial names, or the
 * decimal code itself (a frame a frame kernel defines has no name here). */
inline bool frame_code_for(const std::string& name, int32_t* out) {
    if (name == "EME2000") {
        *out = 1;
        return true;
    }
    for (int32_t code = 1; code <= 21; ++code) {
        const char* known = spk::builtin_frame_name(code);
        if (known[0] != '\0' && name == known) {
            *out = code;
            return true;
        }
    }
    if (name.empty()) return false;
    char* end = nullptr;
    const long v = std::strtol(name.c_str(), &end, 10);
    if (*end != '\0' || end == name.c_str() || v < -2147483647L || v > 2147483647L) return false;
    *out = static_cast<int32_t>(v);
    return true;
}

/* The text of a frame code: the built-in name, else the decimal code. */
inline std::string frame_text(int32_t code) {
    const char* known = spk::builtin_frame_name(code);
    if (known[0] != '\0') return known;
    return std::to_string(code);
}

namespace detail {

inline bool whole(double v, size_t* out) {
    if (!(v >= 0.0) || v > 2147483647.0 || v != std::floor(v)) return false;
    *out = static_cast<size_t>(v);
    return true;
}

}  // namespace detail

/* Read one type-3 segment. `s` is the summary, `f` the file. */
inline bool read_type3(const daf::File& f, const daf::Summary& s, Segment* out, Refusal* r) {
    *out = Segment{};
    out->name = s.name;
    out->instrument = s.ic[0];
    out->ref_frame = s.ic[1];
    out->has_av = s.ic[3] != 0;
    out->begin_address = s.ic[4];
    out->end_address = s.ic[5];
    out->start_ticks = s.dc[0];
    out->stop_ticks = s.dc[1];
    const std::string who = "Segment \"" + s.name + "\": ";

    const size_t words = daf::File::segment_word_count(s);
    if (words < 4) return fail(r, "segment-length-mismatch", who + "too short to hold the two counts.");
    const size_t begin = static_cast<size_t>(s.ic[4]);
    const size_t end = static_cast<size_t>(s.ic[5]);
    if (end > f.len / 8) return fail(r, "truncated", who + "its addresses run past the end of the file.");
    double nints_d = 0.0, n_d = 0.0;
    if (!f.word(end - 1, &nints_d) || !f.word(end, &n_d)) {
        return fail(r, "truncated", who + "the counts are past the end of the file.");
    }
    size_t nints = 0, n = 0;
    if (!detail::whole(nints_d, &nints) || !detail::whole(n_d, &n) || n < 1 || nints < 1 || nints > n) {
        return fail(r, "segment-length-mismatch", who + "the counts (NINTS, N) are not whole numbers with 1 <= NINTS <= N.");
    }
    const size_t width = out->has_av ? 7 : 4;
    const size_t ndir = (n - 1) / 100;
    const size_t nidir = (nints - 1) / 100;
    if (n > words || width * n + n + ndir + nints + nidir + 2 != words) {
        char message[200];
        std::snprintf(message, sizeof(message),
                      "N=%zu and NINTS=%zu imply %zu words and the segment holds %zu.", n, nints,
                      width * n + n + ndir + nints + nidir + 2, words);
        return fail(r, "segment-length-mismatch", who + message);
    }

    std::vector<double> pointing(width * n);
    std::vector<double> ticks(n);
    std::vector<double> starts(nints);
    if (!f.words(begin, width * n, pointing.data()) ||
        !f.words(begin + width * n, n, ticks.data()) ||
        !f.words(begin + width * n + n + ndir, nints, starts.data())) {
        return fail(r, "truncated", who + "the arrays run past the end of the file.");
    }
    for (size_t i = 0; i < n; ++i) {
        if (!std::isfinite(ticks[i]) || (i > 0 && !(ticks[i] > ticks[i - 1]))) {
            return fail(r, "inconsistent-segment", who + "the record ticks do not strictly increase.");
        }
    }
    for (double v : pointing) {
        if (!std::isfinite(v)) return fail(r, "inconsistent-segment", who + "a pointing value is not finite.");
    }
    for (size_t k = 0; k < nints; ++k) {
        if (!std::isfinite(starts[k]) || (k > 0 && !(starts[k] > starts[k - 1]))) {
            return fail(r, "inconsistent-segment", who + "the interval starts do not strictly increase.");
        }
    }
    if (starts[0] != ticks[0]) {
        return fail(r, "inconsistent-segment", who + "the first interval does not start at the first record.");
    }

    size_t record = 0;
    for (size_t k = 0; k < nints; ++k) {
        Interval iv;
        const double stop = k + 1 < nints ? starts[k + 1] : 0.0;
        while (record < n && (k + 1 == nints || ticks[record] < stop)) {
            iv.ticks.push_back(ticks[record]);
            for (int c = 0; c < 4; ++c) iv.q.push_back(pointing[record * width + c]);
            if (out->has_av) {
                for (int c = 0; c < 3; ++c) iv.av.push_back(pointing[record * width + 4 + c]);
            }
            ++record;
        }
        if (iv.ticks.empty() || iv.ticks.front() != starts[k]) {
            return fail(r, "inconsistent-segment", who + "an interval start is not the tick of a record.");
        }
        out->intervals.push_back(std::move(iv));
    }
    return true;
}

/* ------------------------------------------------------------------------ */
/* Epoch text to nanoseconds                                                 */
/* ------------------------------------------------------------------------ */

/* A time in seconds past J2000 (2000-01-01T12:00:00 on its own scale) as ISO
 * 8601 with nine fractional digits. A double near 8e8 s has a spacing of about
 * 1.2e-7 s, so nine digits always reproduce the double exactly when parsed
 * back; six would not. The split is made on the integer second so no digit is
 * lost to a large intermediate. */
inline std::string iso_from_seconds_ns(double t) {
    double whole_seconds = std::floor(t);
    double ns = std::round((t - whole_seconds) * 1e9);
    if (ns >= 1e9) {
        ns -= 1e9;
        whole_seconds += 1.0;
    }
    long long total = static_cast<long long>(whole_seconds) + 43200;
    long long days = total / 86400;
    long long rem = total - days * 86400;
    if (rem < 0) {
        rem += 86400;
        days -= 1;
    }
    long long z = days + 730425;
    const long long era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned long long doe = static_cast<unsigned long long>(z - era * 146097);
    const unsigned long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    long long y = static_cast<long long>(yoe) + era * 400;
    const unsigned long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned long long mp = (5 * doy + 2) / 153;
    const unsigned d = static_cast<unsigned>(doy - (153 * mp + 2) / 5 + 1);
    const unsigned m = static_cast<unsigned>(mp + (mp < 10 ? 3 : -9));
    y += (m <= 2);
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%04lld-%02u-%02uT%02lld:%02lld:%02lld.%09lld", y, m, d, rem / 3600,
                  (rem / 60) % 60, rem % 60, static_cast<long long>(ns));
    return std::string(buf);
}

/* The inverse for a text of that shape (any fractional-second length): seconds
 * past J2000, built from the integer second and the fraction separately so the
 * result is the double nearest the stamp. */
inline bool seconds_from_iso(const std::string& text, double* out) {
    int y = 0, mo = 0, d = 0, hh = 0, mi = 0, ss = 0;
    int consumed = 0;
    if (std::sscanf(text.c_str(), "%d-%d-%dT%d:%d:%d%n", &y, &mo, &d, &hh, &mi, &ss, &consumed) != 6) return false;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh < 0 || hh > 23 || mi < 0 || mi > 59 || ss < 0 || ss > 60) return false;
    double fraction = 0.0;
    const char* rest = text.c_str() + consumed;
    if (*rest == '.') {
        char* end = nullptr;
        fraction = std::strtod(std::string("0").append(rest).c_str(), &end);
        size_t digits = 1;
        while (rest[digits] >= '0' && rest[digits] <= '9') ++digits;
        if (rest[digits] != '\0' || digits == 1) return false;
    } else if (*rest != '\0') {
        return false;
    }
    /* days_from_civil, as the OEM reader does it. */
    int yy = y;
    yy -= mo <= 2;
    const int era = (yy >= 0 ? yy : yy - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(yy - era * 400);
    const unsigned doy = static_cast<unsigned>((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1);
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    const long long days = static_cast<long long>(era) * 146097 + static_cast<long long>(doe) - 719468;
    const long long seconds = (days - 10957) * 86400LL + hh * 3600LL + mi * 60LL + ss - 43200LL;
    *out = static_cast<double>(seconds) + fraction;
    return true;
}

/* ------------------------------------------------------------------------ */
/* Writer                                                                    */
/* ------------------------------------------------------------------------ */

struct WriteSegment {
    std::string name;
    int32_t instrument = 0;
    int32_t ref_frame = 0;
    bool has_av = false;
    std::vector<double> ticks;
    std::vector<double> q;  /* 4 per record */
    std::vector<double> av; /* 3 per record when has_av */
};

constexpr size_t kMaxNameChars = 40;
constexpr size_t kMaxInternalChars = 60;
constexpr size_t kSummariesPerRecord = 25; /* (128 - 3) words / (ND + (NI+1)/2 = 5) */

/* Write the segments as one DAF/CK. `begin_addresses` receives each segment's
 * first and last word address for the descriptor. */
inline bool write(const std::vector<WriteSegment>& segments, const std::string& internal_name,
                  const std::string& comments, std::vector<uint8_t>* out,
                  std::vector<std::pair<int32_t, int32_t> >* addresses, Refusal* r) {
    if (segments.empty()) return fail(r, "bad-record", "There is no segment to write.");
    if (internal_name.size() > kMaxInternalChars || !spk::detail::printable_ascii(internal_name)) {
        return fail(r, "bad-record", "The internal file name is not printable ASCII of at most 60 characters.");
    }
    for (const WriteSegment& s : segments) {
        if (s.name.size() > kMaxNameChars || !spk::detail::printable_ascii(s.name)) {
            return fail(r, "bad-record", "Segment name \"" + s.name +
                                             "\" is not printable ASCII of at most 40 characters.");
        }
        if (s.ticks.empty() || s.q.size() != 4 * s.ticks.size() ||
            (s.has_av && s.av.size() != 3 * s.ticks.size())) {
            return fail(r, "bad-record", "Segment \"" + s.name + "\" has no records or ragged ones.");
        }
    }
    std::vector<uint8_t> comment_stream;
    if (!comments.empty() && !spk::detail::pack_comments(comments, &comment_stream)) {
        return fail(r, "bad-record", "The comment holds a NUL or an end-of-transmission character.");
    }
    const size_t comment_records =
        comment_stream.empty() ? 0
                               : (comment_stream.size() + daf::kCharactersPerRecord - 1) / daf::kCharactersPerRecord;
    const size_t nseg = segments.size();
    const size_t summary_records = (nseg + kSummariesPerRecord - 1) / kSummariesPerRecord;
    const int32_t fward = static_cast<int32_t>(2 + comment_records);
    const int32_t bward = static_cast<int32_t>(2 + comment_records + 2 * (summary_records - 1));
    const size_t data_begin_word = (static_cast<size_t>(bward) + 1) * daf::kWordsPerRecord + 1;

    std::vector<size_t> seg_words(nseg);
    size_t total_words = 0;
    for (size_t i = 0; i < nseg; ++i) {
        const WriteSegment& s = segments[i];
        const size_t n = s.ticks.size();
        const size_t width = s.has_av ? 7 : 4;
        seg_words[i] = width * n + n + (n - 1) / 100 + 1 + 0 + 2;
        total_words += seg_words[i];
    }
    const size_t free_word = data_begin_word + total_words;
    const size_t used_bytes = (free_word - 1) * 8;
    const size_t total_bytes = ((used_bytes + daf::kRecordBytes - 1) / daf::kRecordBytes) * daf::kRecordBytes;

    out->assign(total_bytes, 0);
    uint8_t* b = out->data();
    const bool big = false;

    spk::detail::put_text(b + 0, 8, "DAF/CK", ' ');
    ephem::write_i32(b + 8, 2, big);
    ephem::write_i32(b + 12, 6, big);
    spk::detail::put_text(b + 16, kMaxInternalChars, internal_name, ' ');
    ephem::write_i32(b + 76, fward, big);
    ephem::write_i32(b + 80, bward, big);
    ephem::write_i32(b + 84, static_cast<int32_t>(free_word), big);
    spk::detail::put_text(b + 88, 8, "LTL-IEEE", ' ');
    std::memcpy(b + spk::detail::kFtpOffset, spk::detail::kFtpString, sizeof(spk::detail::kFtpString));

    for (size_t rec = 0; rec < comment_records; ++rec) {
        uint8_t* record = b + (1 + rec) * daf::kRecordBytes;
        const size_t from = rec * daf::kCharactersPerRecord;
        const size_t take = comment_stream.size() - from < daf::kCharactersPerRecord
                                ? comment_stream.size() - from
                                : daf::kCharactersPerRecord;
        std::memcpy(record, comment_stream.data() + from, take);
        for (size_t i = take; i < daf::kCharactersPerRecord; ++i) record[i] = ' ';
    }

    addresses->clear();
    size_t word = data_begin_word;
    for (size_t g = 0; g < summary_records; ++g) {
        const size_t first = g * kSummariesPerRecord;
        const size_t count = std::min(kSummariesPerRecord, nseg - first);
        const int32_t record_number = static_cast<int32_t>(fward + 2 * static_cast<int32_t>(g));
        uint8_t* srec = b + (static_cast<size_t>(record_number) - 1) * daf::kRecordBytes;
        uint8_t* nrec = srec + daf::kRecordBytes;
        ephem::write_f64(srec + 0, g + 1 < summary_records ? static_cast<double>(record_number + 2) : 0.0, big);
        ephem::write_f64(srec + 8, g > 0 ? static_cast<double>(record_number - 2) : 0.0, big);
        ephem::write_f64(srec + 16, static_cast<double>(count), big);
        for (size_t i = 0; i < daf::kCharactersPerRecord; ++i) nrec[i] = ' ';
        for (size_t k = 0; k < count; ++k) {
            const WriteSegment& s = segments[first + k];
            uint8_t* sum = srec + 24 + k * 40;
            ephem::write_f64(sum + 0, s.ticks.front(), big);
            ephem::write_f64(sum + 8, s.ticks.back(), big);
            ephem::write_i32(sum + 16, s.instrument, big);
            ephem::write_i32(sum + 20, s.ref_frame, big);
            ephem::write_i32(sum + 24, 3, big);
            ephem::write_i32(sum + 28, s.has_av ? 1 : 0, big);
            const int32_t begin = static_cast<int32_t>(word);
            const int32_t end = static_cast<int32_t>(word + seg_words[first + k] - 1);
            ephem::write_i32(sum + 32, begin, big);
            ephem::write_i32(sum + 36, end, big);
            spk::detail::put_text(nrec + k * 40, kMaxNameChars, s.name, ' ');
            addresses->push_back(std::make_pair(begin, end));

            uint8_t* d = b + (word - 1) * 8;
            const size_t n = s.ticks.size();
            const size_t width = s.has_av ? 7 : 4;
            for (size_t i = 0; i < n; ++i) {
                for (size_t c = 0; c < 4; ++c) ephem::write_f64(d + (i * width + c) * 8, s.q[i * 4 + c], big);
                if (s.has_av) {
                    for (size_t c = 0; c < 3; ++c) ephem::write_f64(d + (i * width + 4 + c) * 8, s.av[i * 3 + c], big);
                }
            }
            uint8_t* t = d + n * width * 8;
            for (size_t i = 0; i < n; ++i) ephem::write_f64(t + i * 8, s.ticks[i], big);
            uint8_t* dir = t + n * 8;
            const size_t ndir = (n - 1) / 100;
            for (size_t k2 = 0; k2 < ndir; ++k2) ephem::write_f64(dir + k2 * 8, s.ticks[(k2 + 1) * 100 - 1], big);
            uint8_t* starts = dir + ndir * 8;
            ephem::write_f64(starts, s.ticks.front(), big);  /* the one interval starts at the first record */
            ephem::write_f64(starts + 8, 1.0, big);          /* NINTS */
            ephem::write_f64(starts + 16, static_cast<double>(n), big);
            word += seg_words[first + k];
        }
    }
    return true;
}

}  // namespace ck

#endif  // ORBIT_PRODUCTS_NAIF_CK_HPP
