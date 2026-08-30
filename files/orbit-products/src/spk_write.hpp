/*
 * files/orbit-products — DAF/SPK writer for segment types 13 and 9.
 *
 * ONE segment per file, which is the whole product: this exists so a Series
 * that arrived as an OEM, an STK ephemeris, a Code-500 file or an OD result can
 * leave as a kernel the rest of the world already reads. Multi-segment append
 * would mean owning DAF's free-list and record-splitting logic; a caller that
 * needs several segments in one kernel merges with the toolkit, which does that
 * correctly and is not in a hot path.
 *
 * TYPE 13 IS THE DEFAULT because a Series carries velocities, and a Hermite
 * segment reproduces them as data rather than as a fit. Type 9 falls out of the
 * same byte layout — the segments differ in one trailer word and in what the
 * reader does with the window — so it is written by the same code rather than
 * by a copy that can drift. THE TRAILER WORD IS NOT THE SAME QUANTITY in the
 * two types: type 9 stores the polynomial DEGREE, type 13 stores WINDOW SIZE
 * MINUS ONE. That asymmetry is in NAIF's format, not in this code, and getting
 * it backwards produces a file CSPICE reads without complaint at the wrong
 * interpolation order.
 *
 * The output must be readable by CSPICE, so everything the toolkit checks is
 * emitted exactly: the `DAF/SPK ` ID word, ND=2/NI=6, the FTP validation string
 * at its fixed offset, LOCFMT, the summary/name record pair, and file length
 * rounded up to a whole 1024-byte record. LTL-IEEE only — big-endian DAF output
 * would be write-only code, since every platform this runs on is little-endian
 * and CSPICE reads either.
 */

#ifndef ORBIT_PRODUCTS_SPK_WRITE_HPP
#define ORBIT_PRODUCTS_SPK_WRITE_HPP

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "daf.hpp"
#include "ephemeris_series.hpp"

namespace spk {

/* NAIF's MAXDEG for types 8, 9 and 13. */
static constexpr int kMaxWriteDegree = 27;

/* An SPK summary is ND + (NI+1)/2 = 5 words, so a name is 40 characters. NAIF
 * refuses a longer segment identifier and so do we, rather than truncating an
 * identifier the caller will later fail to match. */
static constexpr size_t kSegmentNameChars = 40;
static constexpr size_t kInternalNameChars = 60;

namespace detail {

/*
 * The FTP validation string. NAIF puts it at byte 699 of the file record so a
 * transfer that mangled CR, LF, CRLF, a lone CR-NUL, or the high-bit bytes
 * 0x81 / 0x10CE can be detected on read. It is emitted verbatim; a file without
 * it loads, but every NAIF diagnostic that checks FTP damage goes silent.
 */
static const uint8_t kFtpString[28] = {
    'F', 'T', 'P', 'S', 'T', 'R', ':',
    0x0D, ':',
    0x0A, ':',
    0x0D, 0x0A, ':',
    0x0D, 0x00, ':',
    0x81, ':',
    0x10, 0xCE, ':',
    'E', 'N', 'D', 'F', 'T', 'P',
};
static constexpr size_t kFtpOffset = 699;

inline void put_text(uint8_t* dst, size_t width, const std::string& s, uint8_t pad) {
    const size_t n = s.size() < width ? s.size() : width;
    for (size_t i = 0; i < n; ++i) dst[i] = static_cast<uint8_t>(s[i]);
    for (size_t i = n; i < width; ++i) dst[i] = pad;
}

inline bool printable_ascii(const std::string& s) {
    for (char c : s) {
        const unsigned char u = static_cast<unsigned char>(c);
        if (u < 0x20 || u > 0x7E) return false;
    }
    return true;
}

/*
 * Pack the comment text into DAF's character stream: NUL ends a line, 0x04 ends
 * the comment area. A '\n' in the caller's string is a line break, so it maps
 * to NUL; a NUL the caller passed in would be indistinguishable from a line
 * break on read, so it is a refusal rather than a silent re-interpretation.
 */
inline bool pack_comments(const std::string& text, std::vector<uint8_t>* out) {
    for (char c : text) {
        const unsigned char u = static_cast<unsigned char>(c);
        if (u == 0x00 || u == 0x04) return false;
        out->push_back(u == '\n' ? 0x00 : u);
    }
    if (!out->empty() && out->back() != 0x00) out->push_back(0x00);
    out->push_back(0x04);
    return true;
}

/*
 * The shared type-9 / type-13 emitter. `control_word` is the value the trailer
 * carries, which the two types define differently — see the file header.
 */
inline ephem::Status write_lagrange_layout(const ephem::Series& s, int32_t spk_type,
                                           int32_t target, int32_t center, int32_t frame,
                                           int control_word, const std::string& segment_name,
                                           const std::string& internal_name,
                                           const std::string& comments,
                                           std::vector<uint8_t>* out) {
    if (out == nullptr) return ephem::Status::Malformed;
    const size_t n = s.rows.size();
    if (n == 0) return ephem::Status::NotEnoughStates;

    /* Every state must carry a velocity: an SPK state IS six numbers, and
     * writing zeros for an absent velocity produces a kernel that evaluates to
     * a stationary object without ever reporting an error. */
    if (!s.all_have_velocity()) return ephem::Status::Unsupported;

    for (const ephem::StateRow& r : s.rows) {
        if (!ephem::row_is_finite(r)) return ephem::Status::Malformed;
    }
    /* Strictly increasing epochs: NAIF requires it, and the Neville and Hermite
     * recurrences both divide by node differences. */
    for (size_t i = 1; i < n; ++i) {
        if (!(s.rows[i].epoch > s.rows[i - 1].epoch)) return ephem::Status::Malformed;
    }

    if (segment_name.size() > kSegmentNameChars) return ephem::Status::Unsupported;
    if (!printable_ascii(segment_name)) return ephem::Status::Unsupported;
    if (internal_name.size() > kInternalNameChars) return ephem::Status::Unsupported;
    if (!printable_ascii(internal_name)) return ephem::Status::Unsupported;

    std::vector<uint8_t> comment_stream;
    if (!comments.empty()) {
        if (!pack_comments(comments, &comment_stream)) return ephem::Status::Unsupported;
    }
    const size_t comment_records =
        comment_stream.empty()
            ? 0
            : (comment_stream.size() + daf::kCharactersPerRecord - 1) /
                  daf::kCharactersPerRecord;

    const size_t ndir = (n - 1) / 100;
    const size_t data_words = n * 7 + ndir + 2;

    const int32_t fward = static_cast<int32_t>(2 + comment_records);
    const int32_t bward = fward;
    /* Data begins in the record after the name record, which follows the
     * summary record: word (fward+1)*128 + 1. */
    const size_t data_begin_word =
        (static_cast<size_t>(fward) + 1) * daf::kWordsPerRecord + 1;
    const size_t free_word = data_begin_word + data_words;

    const size_t used_bytes = (data_begin_word - 1) * 8 + data_words * 8;
    const size_t total_bytes =
        ((used_bytes + daf::kRecordBytes - 1) / daf::kRecordBytes) * daf::kRecordBytes;

    out->assign(total_bytes, 0);
    uint8_t* b = out->data();
    const bool big = false;

    /* --- file record ---------------------------------------------------- */
    put_text(b + 0, 8, "DAF/SPK", ' ');
    ephem::write_i32(b + 8, 2, big);  /* ND */
    ephem::write_i32(b + 12, 6, big); /* NI */
    put_text(b + 16, kInternalNameChars, internal_name, ' ');
    ephem::write_i32(b + 76, fward, big);
    ephem::write_i32(b + 80, bward, big);
    ephem::write_i32(b + 84, static_cast<int32_t>(free_word), big);
    put_text(b + 88, 8, "LTL-IEEE", ' ');
    std::memcpy(b + kFtpOffset, kFtpString, sizeof(kFtpString));

    /* --- comment area --------------------------------------------------- */
    for (size_t r = 0; r < comment_records; ++r) {
        uint8_t* rec = b + (1 + r) * daf::kRecordBytes;
        const size_t from = r * daf::kCharactersPerRecord;
        const size_t take = comment_stream.size() - from < daf::kCharactersPerRecord
                                ? comment_stream.size() - from
                                : daf::kCharactersPerRecord;
        std::memcpy(rec, comment_stream.data() + from, take);
        /* Blank fill to 1000; the last 24 bytes of a comment record are not
         * comment area at all and stay zero. */
        for (size_t i = take; i < daf::kCharactersPerRecord; ++i) rec[i] = ' ';
    }

    /* --- summary record ------------------------------------------------- */
    uint8_t* srec = b + (static_cast<size_t>(fward) - 1) * daf::kRecordBytes;
    ephem::write_f64(srec + 0, 0.0, big);  /* NEXT: no following summary record */
    ephem::write_f64(srec + 8, 0.0, big);  /* PREV                             */
    ephem::write_f64(srec + 16, 1.0, big); /* NSUM                             */
    ephem::write_f64(srec + 24, s.rows.front().epoch, big);
    ephem::write_f64(srec + 32, s.rows.back().epoch, big);
    ephem::write_i32(srec + 40, target, big);
    ephem::write_i32(srec + 44, center, big);
    ephem::write_i32(srec + 48, frame, big);
    ephem::write_i32(srec + 52, spk_type, big);
    ephem::write_i32(srec + 56, static_cast<int32_t>(data_begin_word), big);
    ephem::write_i32(srec + 60, static_cast<int32_t>(data_begin_word + data_words - 1), big);

    /* --- name record ---------------------------------------------------- */
    uint8_t* nrec = srec + daf::kRecordBytes;
    /* Blank fill to 1000, not to 1024: a DAF character record is 1000
     * characters and the toolkit leaves the remaining 24 bytes zero. */
    for (size_t i = 0; i < daf::kCharactersPerRecord; ++i) nrec[i] = ' ';
    put_text(nrec, kSegmentNameChars, segment_name, ' ');

    /* --- segment data --------------------------------------------------- */
    uint8_t* d = b + (data_begin_word - 1) * 8;
    for (size_t i = 0; i < n; ++i) {
        const ephem::StateRow& r = s.rows[i];
        for (int a = 0; a < 3; ++a) ephem::write_f64(d + (i * 6 + a) * 8, r.pos[a], big);
        for (int a = 0; a < 3; ++a) ephem::write_f64(d + (i * 6 + 3 + a) * 8, r.vel[a], big);
    }
    uint8_t* e = d + n * 6 * 8;
    for (size_t i = 0; i < n; ++i) ephem::write_f64(e + i * 8, s.rows[i].epoch, big);

    /* The epoch directory: every 100th epoch, 1-based indices 100, 200, ...,
     * ((N-1)/100)*100. Off-by-one here is invisible on a short kernel and
     * catastrophic on a long one, because CSPICE uses these to choose which
     * hundred epochs to search. */
    uint8_t* dir = e + n * 8;
    for (size_t k = 0; k < ndir; ++k) {
        ephem::write_f64(dir + k * 8, s.rows[(k + 1) * 100 - 1].epoch, big);
    }

    uint8_t* ctrl = dir + ndir * 8;
    ephem::write_f64(ctrl + 0, static_cast<double>(control_word), big);
    ephem::write_f64(ctrl + 8, static_cast<double>(n), big);

    return ephem::Status::Ok;
}

}  // namespace detail

/*
 * Write ONE type-13 (Hermite, unequally spaced) segment as a complete
 * DAF/SPK file.
 *
 * `degree` is the polynomial degree, which NAIF requires to be ODD: a Hermite
 * window of w states reaches degree 2w-1, so an even degree does not name a
 * window. It is refused rather than rounded, because rounding it changes the
 * interpolation order of a file that will outlive this call.
 */
inline ephem::Status write_type13(const ephem::Series& s, int32_t target, int32_t center,
                                  int32_t frame, int degree, const std::string& segment_name,
                                  const std::string& internal_name, const std::string& comments,
                                  std::vector<uint8_t>* out) {
    if (degree < 1 || degree > kMaxWriteDegree) return ephem::Status::UnsupportedVariant;
    if (degree % 2 == 0) return ephem::Status::UnsupportedVariant;
    const size_t window = static_cast<size_t>(degree + 1) / 2;
    if (s.rows.size() < window) return ephem::Status::NotEnoughStates;
    /* The trailer carries WINDOW SIZE - 1 for type 13. */
    return detail::write_lagrange_layout(s, 13, target, center, frame,
                                         static_cast<int>(window) - 1, segment_name,
                                         internal_name, comments, out);
}

/*
 * Write ONE type-9 (Lagrange, unequally spaced) segment as a complete DAF/SPK
 * file. Same container, same record layout; the trailer carries the polynomial
 * DEGREE and the reader Lagrange-interpolates all six components independently
 * instead of Hermite-interpolating three.
 */
inline ephem::Status write_type9(const ephem::Series& s, int32_t target, int32_t center,
                                 int32_t frame, int degree, const std::string& segment_name,
                                 const std::string& internal_name, const std::string& comments,
                                 std::vector<uint8_t>* out) {
    if (degree < 1 || degree > kMaxWriteDegree) return ephem::Status::UnsupportedVariant;
    if (s.rows.size() < static_cast<size_t>(degree) + 1) return ephem::Status::NotEnoughStates;
    return detail::write_lagrange_layout(s, 9, target, center, frame, degree, segment_name,
                                         internal_name, comments, out);
}

}  // namespace spk

#endif  // ORBIT_PRODUCTS_SPK_WRITE_HPP
