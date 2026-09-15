/*
 * files/orbit-products — NAIF Double Precision Array File (DAF) reader.
 *
 * A DAF is the container every NAIF binary kernel sits in: SPK, CK, binary PCK
 * and DSK all differ only in what their segments MEAN. This layer reads the
 * container and nothing else — the file record, the summary/name record chain,
 * the comment area, and bounds-checked access to the double-precision array.
 * `spk_read.hpp` interprets segments; keeping that split means a malformed
 * container and an unsupported segment type are distinguishable failures.
 *
 * INPUT IS A BUFFER, NOT A FILE. There is no filesystem here — this compiles
 * into one WASM translation unit where the host hands us bytes. `read` copies
 * only the summaries and the comment text; the double-precision array is
 * indexed in place through `File::word`, so a 19 MB kernel costs 19 MB once,
 * not twice.
 *
 * ENDIANNESS IS DECIDED, THEN RECORDED. `LOCFMT` names the format in every
 * file NAIF ships today, but the older `NAIF/DAF` ID word predates that field
 * being reliable, so the header is additionally sanity-checked and the losing
 * interpretation is rejected rather than trusted. `File::endian_source` says
 * which authority actually decided, because "we guessed and were right" and
 * "the file told us" are different provenance for the same bit.
 *
 * Every read goes through ephem::read_f64 / read_i32 — memcpy on an integer,
 * never a union or a pointer cast. The reason is in ephemeris_series.hpp: a
 * type-punning union is undefined behaviour that clang folds differently at
 * -O2, and DAF is exactly the code path where that shows up as a plausible
 * wrong number rather than a crash.
 */

#ifndef ORBIT_PRODUCTS_DAF_HPP
#define ORBIT_PRODUCTS_DAF_HPP

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "ephemeris_series.hpp"

namespace daf {

/* A DAF record is 1024 bytes = 128 double-precision words, everywhere, in
 * every DAF ever written. Addresses in a summary are 1-based word addresses
 * into that array, so word n begins at byte (n-1)*8. */
static constexpr size_t kRecordBytes = 1024;
static constexpr size_t kWordsPerRecord = kRecordBytes / 8;

/* A DAF CHARACTER record carries 1000 usable characters, NOT 1024 — comment
 * records and name records alike. The trailing 24 bytes are whatever the
 * writer left there: in ladee_r_13250_13279_pha_v01.bsp a comment record's
 * tail is live heap garbage, and a reader that treats it as text emits binary
 * into the comment string; a name record CSPICE wrote is blank-filled to 1000
 * and zero after that, so a writer that blank-fills all 1024 produces a file
 * that differs from the toolkit's by exactly those 24 bytes. Neither fact is
 * in the ID-word documentation; both were measured, the first against CSPICE
 * `dafec` and the second against a kernel written by spkw13. */
static constexpr size_t kCharactersPerRecord = 1000;

/* This reader's summary shape. ND=2 / NI=6 is SPK and CK; a binary PCK is
 * ND=2 / NI=5. A DAF declaring more than that is a real container we do not
 * describe, which is a refusal, not a truncation. */
static constexpr int32_t kMaxNd = 2;
static constexpr int32_t kMaxNi = 6;

/* Which authority decided the byte order. */
enum class EndianSource : uint8_t {
    LocFmt = 0,    /* the file record's LOCFMT field named it            */
    Heuristic = 1, /* LOCFMT was absent or wrong; the header decided it  */
};

struct Summary {
    /* SPK: dc[0] / dc[1] are the segment's start and stop ET.
     * SPK: ic = { target, center, frame, type, startAddr, endAddr }.
     * Entries past File::nd / File::ni are zero and carry no meaning. */
    double dc[2] = {0.0, 0.0};
    int32_t ic[6] = {0, 0, 0, 0, 0, 0};
    std::string name; /* the name-record entry, trailing blanks removed */
};

struct File {
    bool big_endian = false;
    EndianSource endian_source = EndianSource::LocFmt;

    std::string id_word;       /* "DAF/SPK", "NAIF/DAF", ... blanks removed */
    std::string internal_name; /* LOCIFN, blanks removed                    */
    std::string loc_fmt;       /* LOCFMT verbatim, blanks removed           */

    int32_t nd = 0;
    int32_t ni = 0;
    int32_t fward = 0;     /* record number of the first summary record */
    int32_t bward = 0;     /* record number of the last summary record  */
    int32_t free_addr = 0; /* first free word address, 1-based          */

    std::vector<Summary> summaries;
    std::string comments;

    const uint8_t* base = nullptr;
    size_t len = 0;

    /* 1-based DAF double-word accessor. Returns false rather than reading past
     * the buffer: a segment descriptor is data from an untrusted file, and a
     * corrupt endAddr must be a refusal, not a heap read. */
    bool word(size_t address, double* out) const {
        if (address < 1 || out == nullptr || base == nullptr) return false;
        if (address > len / 8) return false;
        const size_t offset = (address - 1) * 8;
        *out = ephem::read_f64(base + offset, big_endian);
        return true;
    }

    /* `count` consecutive words starting at 1-based `first`. One bounds check
     * instead of `count` of them, because a type-9 segment reads ten thousand
     * words per materialisation and the per-word check dominates. */
    bool words(size_t first, size_t count, double* out) const {
        if (out == nullptr || base == nullptr) return false;
        if (count == 0) return true;
        if (first < 1) return false;
        if (first > len / 8 || count > len / 8 - (first - 1)) return false;
        const size_t offset = (first - 1) * 8;
        for (size_t i = 0; i < count; ++i) {
            out[i] = ephem::read_f64(base + offset + i * 8, big_endian);
        }
        return true;
    }

    /* Number of double-precision words the segment at `s` occupies. */
    static size_t segment_word_count(const Summary& s) {
        if (s.ic[5] < s.ic[4] || s.ic[4] < 1) return 0;
        return static_cast<size_t>(s.ic[5]) - static_cast<size_t>(s.ic[4]) + 1;
    }
};

namespace detail {

/* Trailing blanks are padding in every fixed-width DAF character field
 * (LOCIDW, LOCIFN, LOCFMT and the name record all blank-fill). NULs appear
 * too, from writers that C-terminated instead of blank-filling. */
inline std::string trim_field(const uint8_t* p, size_t n) {
    size_t end = n;
    while (end > 0 && (p[end - 1] == ' ' || p[end - 1] == '\0')) --end;
    std::string out;
    out.reserve(end);
    for (size_t i = 0; i < end; ++i) out.push_back(static_cast<char>(p[i]));
    return out;
}

/* Does the file record parse as something a DAF writer could have produced?
 *
 * This is the endianness oracle for `NAIF/DAF` files whose LOCFMT cannot be
 * trusted. It works because the swap is violent: ND=2 read the wrong way round
 * is 33554432, and FWARD=22 is 369098752. The bounds are deliberately loose —
 * this must accept every real DAF, not just SPK — and it only ever has to
 * separate a real header from its own byte-reversal. */
inline bool header_is_plausible(int32_t nd, int32_t ni, int32_t fward, int32_t bward,
                                int32_t free_addr, size_t len) {
    if (nd < 0 || nd > 8) return false;
    if (ni < 0 || ni > 16) return false;
    if (nd + ni <= 0) return false;
    /* Record 1 is the file record, so the first summary record cannot be it. */
    if (fward < 2 || bward < 2) return false;
    if (free_addr < 1) return false;
    const size_t records = len / kRecordBytes;
    if (static_cast<size_t>(fward) > records || static_cast<size_t>(bward) > records) return false;
    /* One summary must fit in a record: 3 control doubles + ND + (NI+1)/2. */
    if (static_cast<size_t>(nd) + static_cast<size_t>((ni + 1) / 2) + 3 > kWordsPerRecord) {
        return false;
    }
    return true;
}

struct RawHeader {
    int32_t nd, ni, fward, bward, free_addr;
};

inline RawHeader parse_header(const uint8_t* b, bool big_endian) {
    RawHeader h;
    h.nd = ephem::read_i32(b + 8, big_endian);
    h.ni = ephem::read_i32(b + 12, big_endian);
    h.fward = ephem::read_i32(b + 76, big_endian);
    h.bward = ephem::read_i32(b + 80, big_endian);
    h.free_addr = ephem::read_i32(b + 84, big_endian);
    return h;
}

}  // namespace detail

/*
 * Parse the container. On Ok, `out->base` aliases `bytes` — the caller keeps
 * the buffer alive for as long as it evaluates segments.
 */
inline ephem::Status read(const uint8_t* bytes, size_t len, File* out,
                          bool include_comments = true, size_t max_summaries = 65536) {
    if (out == nullptr || bytes == nullptr) return ephem::Status::Malformed;
    if (len < kRecordBytes) return ephem::Status::Truncated;

    *out = File{};

    /* The ID word. "DAF/xxxx" is what every writer since 1995 emits; the older
     * "NAIF/DAF" is still in the wild — dss_30_itrf93_210201.bsp and
     * earthstns_itrf93_260814.bsp both start with it — so a reader that only
     * accepts the modern spelling refuses files NAIF is currently serving. */
    const std::string id = detail::trim_field(bytes, 8);
    const bool modern = id.size() >= 4 && id.compare(0, 4, "DAF/") == 0;
    const bool legacy = id == "NAIF/DAF";
    if (!modern && !legacy) return ephem::Status::BadMagic;
    out->id_word = id;

    const std::string fmt = detail::trim_field(bytes + 88, 8);
    out->loc_fmt = fmt;

    /* Decide the byte order. LOCFMT is believed only if the header it implies
     * is coherent; otherwise the other order gets its turn. A file where
     * NEITHER order parses is malformed, and saying so beats emitting numbers
     * from a header we could not read. */
    bool declared_big = false;
    bool have_declaration = false;
    if (fmt == "LTL-IEEE") {
        declared_big = false;
        have_declaration = true;
    } else if (fmt == "BIG-IEEE") {
        declared_big = true;
        have_declaration = true;
    }

    bool big = false;
    bool decided = false;
    EndianSource source = EndianSource::Heuristic;
    if (have_declaration) {
        const detail::RawHeader h = detail::parse_header(bytes, declared_big);
        if (detail::header_is_plausible(h.nd, h.ni, h.fward, h.bward, h.free_addr, len)) {
            big = declared_big;
            decided = true;
            source = EndianSource::LocFmt;
        }
    }
    if (!decided) {
        for (int attempt = 0; attempt < 2 && !decided; ++attempt) {
            const bool candidate = attempt == 1;
            const detail::RawHeader h = detail::parse_header(bytes, candidate);
            if (detail::header_is_plausible(h.nd, h.ni, h.fward, h.bward, h.free_addr, len)) {
                big = candidate;
                decided = true;
                source = EndianSource::Heuristic;
            }
        }
    }
    if (!decided) return ephem::Status::Malformed;

    out->big_endian = big;
    out->endian_source = source;
    out->base = bytes;
    out->len = len;

    const detail::RawHeader h = detail::parse_header(bytes, big);
    out->nd = h.nd;
    out->ni = h.ni;
    out->fward = h.fward;
    out->bward = h.bward;
    out->free_addr = h.free_addr;
    out->internal_name = detail::trim_field(bytes + 16, 60);

    /* A wider descriptor is a real DAF flavour this reader does not describe.
     * Truncating it into dc[2]/ic[6] would hand the caller a segment address
     * read from the wrong offset — numbers, confidently wrong. */
    if (out->nd > kMaxNd || out->ni > kMaxNi) return ephem::Status::UnsupportedVariant;

    const size_t summary_words =
        static_cast<size_t>(out->nd) + static_cast<size_t>((out->ni + 1) / 2);
    if (summary_words == 0) return ephem::Status::Malformed;
    const size_t max_per_record = (kWordsPerRecord - 3) / summary_words;

    /* Comment area: records 2 .. FWARD-1. Text is a character stream in which
     * NUL ends a line and 0x04 ends the comment area; everything after that
     * 0x04 is blank fill. */
    bool saw_eot = false;
    for (int32_t rec = 2; include_comments && rec < out->fward && !saw_eot; ++rec) {
        const size_t offset = static_cast<size_t>(rec - 1) * kRecordBytes;
        if (offset + kRecordBytes > len) return ephem::Status::Truncated;
        const uint8_t* p = bytes + offset;
        for (size_t i = 0; i < kCharactersPerRecord; ++i) {
            const uint8_t c = p[i];
            if (c == 0x04) {
                saw_eot = true;
                break;
            }
            out->comments.push_back(c == 0x00 ? '\n' : static_cast<char>(c));
        }
    }
    if (!saw_eot) {
        /* No end-of-transmission marker: the tail is blank fill we cannot
         * distinguish from content, so trim it rather than emit padding. */
        size_t end = out->comments.size();
        while (end > 0 && (out->comments[end - 1] == ' ' || out->comments[end - 1] == '\n')) --end;
        out->comments.resize(end);
    }

    /* Summary records are a forward-linked list starting at FWARD. The cycle
     * guard is not paranoia: NEXT is a double read out of the file, and a
     * corrupt one that points back at itself is an infinite loop inside a WASM
     * module with no way for the host to interrupt it. */
    const size_t record_count = len / kRecordBytes;
    size_t visited = 0;
    int32_t rec = out->fward;
    while (rec != 0) {
        if (++visited > record_count + 1) return ephem::Status::Malformed;
        if (rec < 2) return ephem::Status::Malformed;
        const size_t summary_offset = static_cast<size_t>(rec - 1) * kRecordBytes;
        const size_t name_offset = summary_offset + kRecordBytes;
        /* The name record always follows its summary record, so both must be
         * resident before any summary in this record is believable. */
        if (name_offset + kRecordBytes > len) return ephem::Status::Truncated;

        const uint8_t* srec = bytes + summary_offset;
        const uint8_t* nrec = bytes + name_offset;
        const double next = ephem::read_f64(srec, big);
        const double nsum_d = ephem::read_f64(srec + 16, big);
        if (!ephem::is_finite(next) || !ephem::is_finite(nsum_d)) return ephem::Status::Malformed;
        if (nsum_d < 0.0 || nsum_d > static_cast<double>(max_per_record)) {
            return ephem::Status::Malformed;
        }
        const size_t nsum = static_cast<size_t>(nsum_d);
        if (nsum_d != static_cast<double>(nsum) ||
            nsum > max_summaries - out->summaries.size()) return ephem::Status::Malformed;

        for (size_t i = 0; i < nsum; ++i) {
            Summary s;
            const size_t base_off = 24 + i * summary_words * 8;
            for (int32_t d = 0; d < out->nd; ++d) {
                s.dc[d] = ephem::read_f64(srec + base_off + static_cast<size_t>(d) * 8, big);
            }
            const size_t ic_off = base_off + static_cast<size_t>(out->nd) * 8;
            for (int32_t k = 0; k < out->ni; ++k) {
                s.ic[k] = ephem::read_i32(srec + ic_off + static_cast<size_t>(k) * 4, big);
            }
            s.name = detail::trim_field(nrec + i * summary_words * 8, summary_words * 8);
            out->summaries.push_back(s);
        }

        if (next < 0.0 || next > static_cast<double>(record_count)) {
            return ephem::Status::Malformed;
        }
        const int32_t next_rec = static_cast<int32_t>(next);
        if (next != static_cast<double>(next_rec)) return ephem::Status::Malformed;
        if (next_rec == rec) return ephem::Status::Malformed;
        rec = next_rec;
    }

    return ephem::Status::Ok;
}

}  // namespace daf

#endif  // ORBIT_PRODUCTS_DAF_HPP
