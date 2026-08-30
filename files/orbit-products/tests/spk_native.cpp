/*
 * spk_native.cpp — the DAF/SPK reader and writer measured against CSPICE.
 *
 *   clang++ -std=c++17 -O2 -I src tests/spk_native.cpp -o /tmp/spk_native
 *   /tmp/spk_native [fixture-dir] [emit-dir]
 *
 * Every number this prints has an authority outside this repository. The
 * reference states come from spiceypy.spkpvn (CSPICE_N0067) evaluating ONE
 * segment in its own frame relative to its own center — the exact contract of
 * spk::evaluate — and the descriptor values come from CSPICE's own DAF search.
 * fixtures/PROVENANCE.md names the kernel, the URL and the SHA-256 behind each
 * one; fixtures/spk_reference.txt carries the numbers as IEEE-754 bit patterns
 * so nothing is lost to decimal formatting on the way in.
 *
 * WHY BIT PATTERNS FOR THE DESCRIPTORS AND A TOLERANCE FOR THE STATES: a
 * descriptor value is COPIED out of the file, so anything but bit equality is a
 * parsing bug. An interpolated state is COMPUTED, so it is allowed to differ
 * from CSPICE by round-off — and how much round-off is precisely what these
 * bounds measure.
 *
 * The test main may touch the filesystem and <cmath>; the headers it exercises
 * may not, and do not.
 */

#include <cmath>
#include <cstdarg>
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

/* ------------------------------------------------------------------------ */
/* Reporting                                                                 */
/* ------------------------------------------------------------------------ */

static int g_failures = 0;

static void result(const char* name, double value, double bound, bool pass) {
    std::printf("RESULT %-42s %-14.6e %-14.6e %s\n", name, value, bound,
                pass ? "PASS" : "FAIL");
    if (!pass) ++g_failures;
}

static void result_count(const char* name, long value, long bound, bool pass) {
    std::printf("RESULT %-42s %-14ld %-14ld %s\n", name, value, bound, pass ? "PASS" : "FAIL");
    if (!pass) ++g_failures;
}

static void info(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    std::printf("INFO   ");
    std::vprintf(fmt, ap);
    std::printf("\n");
    va_end(ap);
}

/* ------------------------------------------------------------------------ */
/* Fixture loading                                                           */
/* ------------------------------------------------------------------------ */

static bool read_whole_file(const std::string& path, std::vector<uint8_t>* out) {
    std::FILE* fh = std::fopen(path.c_str(), "rb");
    if (fh == nullptr) return false;
    std::fseek(fh, 0, SEEK_END);
    const long size = std::ftell(fh);
    std::fseek(fh, 0, SEEK_SET);
    if (size < 0) {
        std::fclose(fh);
        return false;
    }
    out->assign(static_cast<size_t>(size), 0);
    const size_t got = size == 0 ? 0 : std::fread(out->data(), 1, static_cast<size_t>(size), fh);
    std::fclose(fh);
    return got == static_cast<size_t>(size);
}

/* 16 hex digits of IEEE-754 bits -> the double they denote. The generator emits
 * this instead of %.17g so the comparison cannot be blamed on either side's
 * decimal conversion. */
static double hex_to_double(const std::string& h) {
    uint64_t bits = 0;
    for (char c : h) {
        bits <<= 4;
        if (c >= '0' && c <= '9') bits |= static_cast<uint64_t>(c - '0');
        else if (c >= 'a' && c <= 'f') bits |= static_cast<uint64_t>(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') bits |= static_cast<uint64_t>(c - 'A' + 10);
    }
    double v;
    std::memcpy(&v, &bits, 8);
    return v;
}

static uint64_t bits_of(double v) {
    uint64_t b;
    std::memcpy(&b, &v, 8);
    return b;
}

/* FNV-1a 64, the same function the generator runs over CSPICE's dafec output. */
static uint64_t fnv1a64(const std::string& s) {
    uint64_t h = 0xcbf29ce484222325ull;
    for (char c : s) {
        h ^= static_cast<uint8_t>(c);
        h *= 0x100000001b3ull;
    }
    return h;
}

/* ------------------------------------------------------------------------ */
/* Reference records                                                         */
/* ------------------------------------------------------------------------ */

struct RefFile {
    std::string fixture, id_word, internal_name;
    int32_t nd, ni, fward, bward, free_addr;
    int big_endian, nseg;
};
struct RefComment {
    std::string fixture;
    long bytes;
    uint64_t hash;
};
struct RefSeg {
    std::string fixture, name;
    int index;
    double dc[2];
    int32_t ic[6];
};
struct RefState {
    std::string fixture, kind;
    int index;
    double et;
    double state[6];
};

struct Tokens {
    std::vector<std::string> parts;
    std::string rest; /* everything after the fixed fields, spaces intact */
};

/* Splits `line` into `fixed` whitespace-delimited tokens plus the remainder,
 * because names (LOCIFN, segment identifiers) legally contain spaces and must
 * survive as one field. */
static Tokens split(const std::string& line, size_t fixed) {
    Tokens t;
    size_t i = 0;
    while (t.parts.size() < fixed) {
        while (i < line.size() && line[i] == ' ') ++i;
        if (i >= line.size()) break;
        const size_t start = i;
        while (i < line.size() && line[i] != ' ') ++i;
        t.parts.push_back(line.substr(start, i - start));
    }
    while (i < line.size() && line[i] == ' ') ++i;
    t.rest = line.substr(i);
    return t;
}

/* ------------------------------------------------------------------------ */
/* Loaded fixtures                                                           */
/* ------------------------------------------------------------------------ */

struct Loaded {
    std::string name;
    std::vector<uint8_t> bytes;
    daf::File file;
    ephem::Status status = ephem::Status::Ok;
};

static std::vector<Loaded*> g_loaded;

static Loaded* fixture(const std::string& dir, const std::string& name) {
    for (Loaded* l : g_loaded) {
        if (l->name == name) return l;
    }
    Loaded* l = new Loaded();
    l->name = name;
    if (!read_whole_file(dir + "/" + name, &l->bytes)) {
        std::fprintf(stderr, "cannot read fixture %s/%s\n", dir.c_str(), name.c_str());
        std::exit(2);
    }
    l->status = daf::read(l->bytes.data(), l->bytes.size(), &l->file);
    g_loaded.push_back(l);
    return l;
}

/* ------------------------------------------------------------------------ */
/* Error buckets                                                             */
/* ------------------------------------------------------------------------ */

struct Bucket {
    double max_pos = 0.0;
    double max_vel = 0.0;
    long count = 0;
    std::string worst;
};

static void note(Bucket* b, double dpos, double dvel, const std::string& where) {
    if (dpos > b->max_pos) {
        b->max_pos = dpos;
        b->worst = where;
    }
    if (dvel > b->max_vel) b->max_vel = dvel;
    ++b->count;
}

static int type_slot(int32_t t) { return t == 8 ? 0 : (t == 9 ? 1 : 2); }
static const char* type_label(int slot) { return slot == 0 ? "8" : (slot == 1 ? "9" : "13"); }

/* ------------------------------------------------------------------------ */
/* The synthetic arc the writer round-trip uses                              */
/* ------------------------------------------------------------------------ */

/*
 * A two-body circular arc, analytic in position AND velocity. Analytic
 * velocities matter: a Hermite segment stores them as data, so a finite-
 * differenced velocity would make the round-trip measure the difference
 * scheme rather than the writer. Non-uniform spacing on purpose — type 13 is
 * the unequally-spaced type, and a uniform grid would not exercise the epoch
 * array or its directory.
 */
static ephem::Series synthetic_arc(size_t n, double t0) {
    const double mu = 398600.4418;
    const double radius = 7000.0;
    const double w = std::sqrt(mu / (radius * radius * radius));
    const double inc = 51.6 * 3.14159265358979323846 / 180.0;
    const double ci = std::cos(inc), si = std::sin(inc);

    ephem::Series s;
    s.time_system = "TDB";
    s.interp = ephem::Interp::Hermite;
    s.interp_degree = 7;
    s.rows.resize(n);
    double t = t0;
    for (size_t i = 0; i < n; ++i) {
        const double a = w * (t - t0);
        const double ca = std::cos(a), sa = std::sin(a);
        ephem::StateRow& r = s.rows[i];
        r.epoch = t;
        r.pos[0] = radius * ca;
        r.pos[1] = radius * sa * ci;
        r.pos[2] = radius * sa * si;
        r.vel[0] = -radius * w * sa;
        r.vel[1] = radius * w * ca * ci;
        r.vel[2] = radius * w * ca * si;
        r.has_vel = true;
        t += 30.0 + 60.0 * static_cast<double>(i % 3);
    }
    return s;
}

/* ------------------------------------------------------------------------ */

int main(int argc, char** argv) {
    const std::string dir = argc > 1 ? argv[1] : "fixtures";
    /* Optional second argument: a directory to drop the kernels this run WROTE,
     * so an operator with the toolkit installed can point CSPICE at them. The
     * permanent proof of container correctness is the byte-parity assertion
     * below, which does not need a toolkit; this is for diagnosing the day it
     * ever fails. */
    const std::string emit_dir = argc > 2 ? argv[2] : "";

    std::vector<uint8_t> reference;
    if (!read_whole_file(dir + "/spk_reference.txt", &reference)) {
        std::fprintf(stderr, "cannot read %s/spk_reference.txt\n", dir.c_str());
        return 2;
    }

    std::vector<RefFile> ref_files;
    std::vector<RefComment> ref_comments;
    std::vector<RefSeg> ref_segs;
    std::vector<RefState> ref_states;

    {
        const std::string text(reinterpret_cast<const char*>(reference.data()), reference.size());
        size_t pos = 0;
        while (pos < text.size()) {
            size_t eol = text.find('\n', pos);
            if (eol == std::string::npos) eol = text.size();
            const std::string line = text.substr(pos, eol - pos);
            pos = eol + 1;
            if (line.empty() || line[0] == '#') continue;
            if (line.compare(0, 5, "FILE ") == 0) {
                const Tokens t = split(line, 10);
                RefFile f;
                f.fixture = t.parts[1];
                f.id_word = t.parts[2];
                f.nd = std::atoi(t.parts[3].c_str());
                f.ni = std::atoi(t.parts[4].c_str());
                f.fward = std::atoi(t.parts[5].c_str());
                f.bward = std::atoi(t.parts[6].c_str());
                f.free_addr = std::atoi(t.parts[7].c_str());
                f.big_endian = std::atoi(t.parts[8].c_str());
                f.nseg = std::atoi(t.parts[9].c_str());
                f.internal_name = t.rest;
                ref_files.push_back(f);
            } else if (line.compare(0, 8, "COMMENT ") == 0) {
                const Tokens t = split(line, 4);
                RefComment c;
                c.fixture = t.parts[1];
                c.bytes = std::atol(t.parts[2].c_str());
                c.hash = std::strtoull(t.parts[3].c_str(), nullptr, 16);
                ref_comments.push_back(c);
            } else if (line.compare(0, 4, "SEG ") == 0) {
                const Tokens t = split(line, 11);
                RefSeg s;
                s.fixture = t.parts[1];
                s.index = std::atoi(t.parts[2].c_str());
                s.dc[0] = hex_to_double(t.parts[3]);
                s.dc[1] = hex_to_double(t.parts[4]);
                for (int i = 0; i < 6; ++i) {
                    s.ic[i] = static_cast<int32_t>(std::atol(t.parts[5 + i].c_str()));
                }
                s.name = t.rest;
                ref_segs.push_back(s);
            } else if (line.compare(0, 6, "STATE ") == 0) {
                const Tokens t = split(line, 11);
                RefState s;
                s.fixture = t.parts[1];
                s.index = std::atoi(t.parts[2].c_str());
                s.kind = t.parts[3];
                s.et = hex_to_double(t.parts[4]);
                for (int i = 0; i < 6; ++i) s.state[i] = hex_to_double(t.parts[5 + i]);
                ref_states.push_back(s);
            }
        }
    }

    info("reference: %zu files, %zu segments, %zu states, %zu comment areas",
         ref_files.size(), ref_segs.size(), ref_states.size(), ref_comments.size());

    /* -------------------------------------------------------------------- */
    /* DAF structure                                                        */
    /* -------------------------------------------------------------------- */

    long fields_compared = 0;
    long field_mismatches = 0;
    long segment_count_mismatches = 0;
    long endian_mismatches = 0;
    long parse_failures = 0;
    /* How many fixtures actually make the reader follow a summary record's
     * forward link. If this is zero the chain traversal and its cycle guard
     * were never executed, and "the reader handles multi-record chains" is a
     * claim about the source rather than a measurement. */
    long chained_files = 0;

    for (const RefFile& rf : ref_files) {
        Loaded* l = fixture(dir, rf.fixture);
        if (l->status != ephem::Status::Ok) {
            info("%s: daf::read returned %s", rf.fixture.c_str(), ephem::status_name(l->status));
            ++parse_failures;
            continue;
        }
        const daf::File& f = l->file;
        info("%s: id=%s locfmt=%s endian=%s (%s) nd=%d ni=%d fward=%d bward=%d free=%d nseg=%zu",
             rf.fixture.c_str(), f.id_word.c_str(), f.loc_fmt.c_str(),
             f.big_endian ? "big" : "little",
             f.endian_source == daf::EndianSource::LocFmt ? "from LOCFMT" : "from header",
             f.nd, f.ni, f.fward, f.bward, f.free_addr, f.summaries.size());

        if (f.bward != f.fward) ++chained_files;
        if ((f.big_endian ? 1 : 0) != rf.big_endian) ++endian_mismatches;
        if (static_cast<int>(f.summaries.size()) != rf.nseg) ++segment_count_mismatches;

        struct { const char* what; long got; long want; } ints[] = {
            {"nd", f.nd, rf.nd}, {"ni", f.ni, rf.ni}, {"fward", f.fward, rf.fward},
            {"bward", f.bward, rf.bward}, {"free", f.free_addr, rf.free_addr},
        };
        for (const auto& p : ints) {
            ++fields_compared;
            if (p.got != p.want) {
                ++field_mismatches;
                info("  %s %s: got %ld want %ld", rf.fixture.c_str(), p.what, p.got, p.want);
            }
        }
        ++fields_compared;
        if (f.id_word != rf.id_word) {
            ++field_mismatches;
            info("  %s id word: got %s want %s", rf.fixture.c_str(), f.id_word.c_str(),
                 rf.id_word.c_str());
        }
        ++fields_compared;
        if (f.internal_name != rf.internal_name) {
            ++field_mismatches;
            info("  %s internal name: got '%s' want '%s'", rf.fixture.c_str(),
                 f.internal_name.c_str(), rf.internal_name.c_str());
        }
    }

    for (const RefSeg& rs : ref_segs) {
        Loaded* l = fixture(dir, rs.fixture);
        if (l->status != ephem::Status::Ok) continue;
        if (static_cast<size_t>(rs.index) >= l->file.summaries.size()) {
            ++field_mismatches;
            continue;
        }
        const daf::Summary& s = l->file.summaries[static_cast<size_t>(rs.index)];
        for (int i = 0; i < 2; ++i) {
            ++fields_compared;
            /* BIT equality, not a tolerance: a descriptor double is copied out
             * of the file, so a near miss is a wrong offset or a wrong swap. */
            if (bits_of(s.dc[i]) != bits_of(rs.dc[i])) {
                ++field_mismatches;
                info("  %s seg %d dc[%d]: got %016llx want %016llx", rs.fixture.c_str(), rs.index,
                     i, static_cast<unsigned long long>(bits_of(s.dc[i])),
                     static_cast<unsigned long long>(bits_of(rs.dc[i])));
            }
        }
        for (int i = 0; i < 6; ++i) {
            ++fields_compared;
            if (s.ic[i] != rs.ic[i]) {
                ++field_mismatches;
                info("  %s seg %d ic[%d]: got %d want %d", rs.fixture.c_str(), rs.index, i,
                     s.ic[i], rs.ic[i]);
            }
        }
        ++fields_compared;
        if (s.name != rs.name) {
            ++field_mismatches;
            info("  %s seg %d name: got '%s' want '%s'", rs.fixture.c_str(), rs.index,
                 s.name.c_str(), rs.name.c_str());
        }
    }

    /* Force the heuristic path: blank LOCFMT and make the file record decide.
     * Real `NAIF/DAF` files predate LOCFMT being dependable, so this branch is
     * not hypothetical — and it is the one branch no shipped fixture reaches,
     * because every kernel NAIF serves today fills LOCFMT in correctly. */
    long endian_heuristic_failures = 0;
    for (const char* name : {"writer_parity_t13.bsp", "cspice_t13_big_endian.bsp",
                             "msl_atls_gc120806_v1.bsp", "earthstns_itrf93_260814.bsp"}) {
        Loaded* l = fixture(dir, name);
        if (l->status != ephem::Status::Ok) continue;
        std::vector<uint8_t> blanked = l->bytes;
        for (size_t i = 88; i < 96; ++i) blanked[i] = ' ';
        daf::File f;
        const ephem::Status st = daf::read(blanked.data(), blanked.size(), &f);
        const bool ok = st == ephem::Status::Ok &&
                        f.big_endian == l->file.big_endian &&
                        f.endian_source == daf::EndianSource::Heuristic &&
                        f.summaries.size() == l->file.summaries.size() &&
                        f.free_addr == l->file.free_addr;
        if (!ok) ++endian_heuristic_failures;
        info("%s with LOCFMT blanked: %s, endian=%s (%s), %zu segments", name,
             ephem::status_name(st), f.big_endian ? "big" : "little",
             f.endian_source == daf::EndianSource::LocFmt ? "from LOCFMT" : "from header",
             f.summaries.size());
    }

    long comment_mismatches = 0;
    for (const RefComment& rc : ref_comments) {
        Loaded* l = fixture(dir, rc.fixture);
        if (l->status != ephem::Status::Ok) continue;
        /* Normalise the way the generator does: right-trim each line, drop
         * trailing empty lines. CSPICE's dafec hands back trimmed lines, and
         * arguing about a line's blank fill is not what this measures — the
         * 1000-usable-bytes-per-record rule is. */
        std::vector<std::string> lines;
        std::string cur;
        for (char c : l->file.comments) {
            if (c == '\n') {
                lines.push_back(cur);
                cur.clear();
            } else {
                cur.push_back(c);
            }
        }
        lines.push_back(cur);
        for (std::string& s : lines) {
            size_t end = s.size();
            while (end > 0 && s[end - 1] == ' ') --end;
            s.resize(end);
        }
        while (!lines.empty() && lines.back().empty()) lines.pop_back();
        std::string joined;
        for (size_t i = 0; i < lines.size(); ++i) {
            if (i) joined.push_back('\n');
            joined += lines[i];
        }
        if (static_cast<long>(joined.size()) != rc.bytes || fnv1a64(joined) != rc.hash) {
            ++comment_mismatches;
            info("  %s comment area: got %zu bytes / %016llx want %ld / %016llx",
                 rc.fixture.c_str(), joined.size(),
                 static_cast<unsigned long long>(fnv1a64(joined)), rc.bytes,
                 static_cast<unsigned long long>(rc.hash));
        }
    }

    /* -------------------------------------------------------------------- */
    /* Segment evaluation                                                   */
    /* -------------------------------------------------------------------- */

    Bucket nodes[3];
    Bucket mids[3];
    long eval_failures = 0;

    for (const RefState& rs : ref_states) {
        Loaded* l = fixture(dir, rs.fixture);
        if (l->status != ephem::Status::Ok) continue;
        if (static_cast<size_t>(rs.index) >= l->file.summaries.size()) continue;
        const daf::Summary& seg = l->file.summaries[static_cast<size_t>(rs.index)];
        ephem::StateRow got;
        const ephem::Status st = spk::evaluate(l->file, seg, rs.et, &got);
        if (st != ephem::Status::Ok) {
            ++eval_failures;
            info("  %s seg %d at %.9f: %s", rs.fixture.c_str(), rs.index, rs.et,
                 ephem::status_name(st));
            continue;
        }
        double dpos = 0.0, dvel = 0.0;
        for (int a = 0; a < 3; ++a) {
            const double p = std::fabs(got.pos[a] - rs.state[a]);
            const double v = std::fabs(got.vel[a] - rs.state[a + 3]);
            if (p > dpos) dpos = p;
            if (v > dvel) dvel = v;
        }
        const int slot = type_slot(spk::segment_type(seg));
        char where[256];
        std::snprintf(where, sizeof(where), "%s seg %d @ %.6f", rs.fixture.c_str(), rs.index,
                      rs.et);
        note(rs.kind == "node" ? &nodes[slot] : &mids[slot], dpos, dvel, where);
    }

    /* -------------------------------------------------------------------- */
    /* Refusals                                                             */
    /* -------------------------------------------------------------------- */

    long refusal_failures = 0;
    {
        Loaded* l = fixture(dir, "cspice_t05_unsupported.bsp");
        if (l->status != ephem::Status::Ok || l->file.summaries.empty()) {
            ++refusal_failures;
        } else {
            const daf::Summary& seg = l->file.summaries[0];
            ephem::StateRow row;
            ephem::Series series;
            const ephem::Status a = spk::evaluate(l->file, seg, seg.dc[0], &row);
            const ephem::Status b = spk::to_series(l->file, seg, &series);
            info("type %d segment: evaluate=%s to_series=%s", seg.ic[3],
                 ephem::status_name(a), ephem::status_name(b));
            if (a != ephem::Status::UnsupportedVariant) ++refusal_failures;
            if (b != ephem::Status::UnsupportedVariant) ++refusal_failures;
        }
    }
    {
        /* A truncated buffer must be Truncated, not a plausible parse. */
        Loaded* l = fixture(dir, "writer_parity_t13.bsp");
        daf::File clipped;
        const ephem::Status s1 = daf::read(l->bytes.data(), 512, &clipped);
        if (s1 != ephem::Status::Truncated) ++refusal_failures;
        static const uint8_t junk[1024] = {0};
        daf::File bad;
        const ephem::Status s2 = daf::read(junk, sizeof(junk), &bad);
        if (s2 != ephem::Status::BadMagic) ++refusal_failures;
        info("short buffer=%s, non-DAF buffer=%s", ephem::status_name(s1),
             ephem::status_name(s2));
    }

    /* -------------------------------------------------------------------- */
    /* to_series                                                            */
    /* -------------------------------------------------------------------- */

    double series_node_max = 0.0;
    long series_rows = 0;
    {
        /* Materialising a segment must reproduce its stored nodes exactly:
         * to_series copies, it does not interpolate, so anything but zero here
         * is an addressing mistake. Measured against the reference states at
         * the node epochs, which CSPICE produced by interpolation, so the
         * comparison bound is the interpolation floor, not zero. */
        Loaded* l = fixture(dir, "ladee_seg01_t13.bsp");
        ephem::Series s;
        const ephem::Status st = spk::to_series(l->file, l->file.summaries[0], &s);
        if (st != ephem::Status::Ok) {
            info("to_series on the LADEE extract: %s", ephem::status_name(st));
            ++eval_failures;
        } else {
            series_rows = static_cast<long>(s.rows.size());
            info("LADEE extract: %zu rows, interp=%s degree=%d frame=%s target=%d center=%d",
                 s.rows.size(), ephem::interp_name(s.interp), s.interp_degree,
                 s.frame_name.c_str(), s.naif_target, s.naif_center);
            for (const RefState& rs : ref_states) {
                if (rs.fixture != "ladee_seg01_t13.bsp" || rs.kind != "node") continue;
                /* Find the stored row at this epoch. */
                for (const ephem::StateRow& r : s.rows) {
                    if (bits_of(r.epoch) != bits_of(rs.et)) continue;
                    for (int a = 0; a < 3; ++a) {
                        const double d = std::fabs(r.pos[a] - rs.state[a]);
                        if (d > series_node_max) series_node_max = d;
                    }
                    break;
                }
            }
        }
    }

    /* -------------------------------------------------------------------- */
    /* Writer                                                               */
    /* -------------------------------------------------------------------- */

    double write_pos_max = 0.0;
    double write_vel_max = 0.0;
    long write_failures = 0;
    {
        const ephem::Series input = synthetic_arc(250, 700000000.0);
        std::vector<uint8_t> kernel;
        const ephem::Status w = spk::write_type13(input, -940, 399, 1, 7, "ROUNDTRIP-T13",
                                                  "orbit-products round trip",
                                                  "written by files/orbit-products\n"
                                                  "for the native acceptance",
                                                  &kernel);
        if (w != ephem::Status::Ok) {
            info("write_type13: %s", ephem::status_name(w));
            ++write_failures;
        } else {
            if (!emit_dir.empty()) {
                const std::string path = emit_dir + "/emitted_roundtrip_t13.bsp";
                std::FILE* fh = std::fopen(path.c_str(), "wb");
                if (fh) {
                    std::fwrite(kernel.data(), 1, kernel.size(), fh);
                    std::fclose(fh);
                    info("wrote %s", path.c_str());
                }
                std::vector<uint8_t> nine;
                if (spk::write_type9(input, -941, 399, 1, 7, "ROUNDTRIP-T9",
                                     "orbit-products round trip", "", &nine) ==
                    ephem::Status::Ok) {
                    const std::string p9 = emit_dir + "/emitted_roundtrip_t9.bsp";
                    std::FILE* g = std::fopen(p9.c_str(), "wb");
                    if (g) {
                        std::fwrite(nine.data(), 1, nine.size(), g);
                        std::fclose(g);
                        info("wrote %s", p9.c_str());
                    }
                }
            }
            daf::File f;
            const ephem::Status r = daf::read(kernel.data(), kernel.size(), &f);
            if (r != ephem::Status::Ok || f.summaries.size() != 1) {
                info("re-reading our own kernel: %s (%zu segments)", ephem::status_name(r),
                     f.summaries.size());
                ++write_failures;
            } else {
                info("written kernel: %zu bytes, id=%s fward=%d free=%d seg='%s' type=%d "
                     "comments=%zu bytes",
                     kernel.size(), f.id_word.c_str(), f.fward, f.free_addr,
                     f.summaries[0].name.c_str(), f.summaries[0].ic[3], f.comments.size());
                for (size_t i = 0; i < input.rows.size(); ++i) {
                    ephem::StateRow got;
                    const ephem::Status e =
                        spk::evaluate(f, f.summaries[0], input.rows[i].epoch, &got);
                    if (e != ephem::Status::Ok) {
                        ++write_failures;
                        continue;
                    }
                    for (int a = 0; a < 3; ++a) {
                        const double dp = std::fabs(got.pos[a] - input.rows[i].pos[a]);
                        const double dv = std::fabs(got.vel[a] - input.rows[i].vel[a]);
                        if (dp > write_pos_max) write_pos_max = dp;
                        if (dv > write_vel_max) write_vel_max = dv;
                    }
                }
            }
        }
    }

    /* Byte-for-byte against a kernel the official toolkit wrote from the same
     * states. This is the only check that proves the container is right rather
     * than merely self-consistent: our reader could share a bug with our
     * writer, but it cannot share one with CSPICE's. */
    long byte_diffs = -1;
    long size_diff = -1;
    {
        Loaded* l = fixture(dir, "writer_parity_t13.bsp");
        ephem::Series s;
        const ephem::Status st = spk::to_series(l->file, l->file.summaries[0], &s);
        std::vector<uint8_t> ours;
        const ephem::Status w =
            st == ephem::Status::Ok
                ? spk::write_type13(s, l->file.summaries[0].ic[0], l->file.summaries[0].ic[1],
                                    l->file.summaries[0].ic[2], 7, l->file.summaries[0].name,
                                    l->file.internal_name, "", &ours)
                : st;
        if (w != ephem::Status::Ok) {
            info("writer parity: %s", ephem::status_name(w));
        } else {
            size_diff = static_cast<long>(ours.size()) - static_cast<long>(l->bytes.size());
            byte_diffs = 0;
            const size_t n = ours.size() < l->bytes.size() ? ours.size() : l->bytes.size();
            long first = -1;
            for (size_t i = 0; i < n; ++i) {
                if (ours[i] != l->bytes[i]) {
                    if (first < 0) first = static_cast<long>(i);
                    ++byte_diffs;
                }
            }
            info("writer parity: ours %zu bytes, CSPICE %zu bytes, first difference at %ld",
                 ours.size(), l->bytes.size(), first);
        }
    }

    /* -------------------------------------------------------------------- */
    /* Report                                                               */
    /* -------------------------------------------------------------------- */

    std::printf("\n");
    result_count("daf.parse_failures", parse_failures, 0, parse_failures == 0);
    result_count("daf.segment_count_mismatches", segment_count_mismatches, 0,
                 segment_count_mismatches == 0);
    result_count("daf.endian_mismatches", endian_mismatches, 0, endian_mismatches == 0);
    result_count("daf.descriptor_fields_compared", fields_compared, 200, fields_compared >= 200);
    result_count("daf.descriptor_field_mismatches", field_mismatches, 0, field_mismatches == 0);
    result_count("daf.comment_area_mismatches", comment_mismatches, 0, comment_mismatches == 0);
    result_count("daf.endian_heuristic_failures", endian_heuristic_failures, 0,
                 endian_heuristic_failures == 0);
    result_count("daf.multi_record_summary_chains", chained_files, 1, chained_files >= 1);
    result_count("spk.evaluate_failures", eval_failures, 0, eval_failures == 0);
    result_count("spk.refusal_failures", refusal_failures, 0, refusal_failures == 0);

    for (int slot = 0; slot < 3; ++slot) {
        char name[96];
        const char* t = type_label(slot);

        std::snprintf(name, sizeof(name), "spk%s.node.samples", t);
        result_count(name, nodes[slot].count, 1, nodes[slot].count >= 1);

        std::snprintf(name, sizeof(name), "spk%s.node.max_pos_km", t);
        result(name, nodes[slot].max_pos, 1e-9, nodes[slot].max_pos <= 1e-9);

        std::snprintf(name, sizeof(name), "spk%s.node.max_vel_km_s", t);
        result(name, nodes[slot].max_vel, 1e-12, nodes[slot].max_vel <= 1e-12);

        std::snprintf(name, sizeof(name), "spk%s.interior.samples", t);
        result_count(name, mids[slot].count, 1, mids[slot].count >= 1);

        std::snprintf(name, sizeof(name), "spk%s.interior.max_pos_km", t);
        result(name, mids[slot].max_pos, 1e-6, mids[slot].max_pos <= 1e-6);

        std::snprintf(name, sizeof(name), "spk%s.interior.max_vel_km_s", t);
        result(name, mids[slot].max_vel, 1e-9, mids[slot].max_vel <= 1e-9);

        if (!nodes[slot].worst.empty()) {
            info("type %s worst node position: %s", t, nodes[slot].worst.c_str());
        }
    }

    result_count("spk.to_series.rows", series_rows, 1, series_rows >= 1);
    result("spk.to_series.node_max_pos_km", series_node_max, 1e-9, series_node_max <= 1e-9);

    result_count("spkwrite.failures", write_failures, 0, write_failures == 0);
    result("spkwrite.t13.roundtrip_max_pos_km", write_pos_max, 1e-9, write_pos_max <= 1e-9);
    result("spkwrite.t13.roundtrip_max_vel_km_s", write_vel_max, 1e-12, write_vel_max <= 1e-12);
    result_count("spkwrite.t13.cspice_size_delta_bytes", size_diff, 0, size_diff == 0);
    result_count("spkwrite.t13.cspice_byte_differences", byte_diffs, 0, byte_diffs == 0);

    std::printf("\n%s: %d failing assertion(s)\n", g_failures == 0 ? "OK" : "FAILED", g_failures);
    for (Loaded* l : g_loaded) delete l;
    return g_failures == 0 ? 0 : 1;
}
