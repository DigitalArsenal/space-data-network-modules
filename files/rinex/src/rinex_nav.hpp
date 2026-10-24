/*
 * files/rinex — RINEX 3.02 to 3.05 navigation files: the broadcast Keplerian messages, and their evaluation.
 *
 * SDS has no record that can KEEP a broadcast ephemeris ($NAV is the Naval Vessel record), so the parameters
 * cannot leave this module as parameters. What can leave it typed is what they MEAN: the satellite's position and
 * velocity on the ICD's own algorithm (IS-GPS-200 table 20-IV; the Galileo OS SIS ICD and the BeiDou ICD define the
 * same algorithm with their own constants). This reads the messages and evaluates them; `rinex_module.cpp` projects
 * the states onto $OEM.
 *
 * WHAT IS EVALUATED. G (GPS) and J (QZSS) with the GPS constants, E (Galileo), and C (BeiDou) MEO and IGSO with the
 * CGCS2000 constants. Not evaluated, and DECLARED rather than dropped: R (GLONASS) and S (SBAS), which broadcast a
 * state vector that is integrated rather than a Keplerian set; I (IRNSS); BeiDou GEO (the ICD rotates the
 * orbit plane by -5 degrees for them); and a message whose health word is not 0.
 *
 * WHICH MESSAGE. At each evaluation epoch the message whose Toe is nearest, within +-7200 s (the GPS fit interval of
 * four hours, the nominal validity of every constellation's set here). An epoch with no such message is a gap.
 *
 * TIME is each system's own (GPST, GST, QZSST, BDT), as the file's epochs are; no scale is converted. All four
 * count weeks from a Sunday, so the second of the week comes from the calendar date alone, and a Toe is placed on the
 * absolute axis by choosing the week that puts it within half a week of its message's Toc.
 */

#ifndef RINEX_RINEX_NAV_HPP
#define RINEX_RINEX_NAV_HPP

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "rinex_text.hpp"

namespace rinex {

struct NavMessage {
    char system = 'G';
    int prn = 0;
    std::string id;
    double toc = 0.0;   /* seconds on the system's time, counted from 1970-01-01T00:00:00 of that scale */
    double v[28] = {0.0};
    /* The named parameters, IS-GPS-200 symbols, indexed into v by the RINEX orbit lines. */
    double crs() const { return v[1]; }
    double delta_n() const { return v[2]; }
    double m0() const { return v[3]; }
    double cuc() const { return v[4]; }
    double e() const { return v[5]; }
    double cus() const { return v[6]; }
    double sqrt_a() const { return v[7]; }
    double toe_sow() const { return v[8]; }
    double cic() const { return v[9]; }
    double omega0() const { return v[10]; }
    double cis() const { return v[11]; }
    double i0() const { return v[12]; }
    double crc() const { return v[13]; }
    double omega() const { return v[14]; }
    double omega_dot() const { return v[15]; }
    double idot() const { return v[16]; }
    double health() const { return v[21]; }
    double toe_abs = 0.0; /* Toe on the same axis as toc */
};

struct NavFile {
    double version = 0.0;
    char system = ' ';
    std::string program, run_by, date;
    std::vector<std::string> comments;
    std::vector<NavMessage> messages;
    std::map<std::string, size_t> not_evaluated; /* reason -> messages */
    std::vector<std::string> uncarried_labels;
};

namespace nav_detail {

inline bool number(const std::string& line, size_t from, double* out) {
    std::string f = cols(line, from, 19);
    for (char& c : f) {
        if (c == 'D' || c == 'd') c = 'E';
    }
    if (trim(f).empty()) {
        *out = 0.0;
        return true;
    }
    return to_double(f, out);
}

inline bool is_system_letter(char c) {
    return c == 'G' || c == 'R' || c == 'E' || c == 'C' || c == 'J' || c == 'I' || c == 'S';
}

/* Seconds into the week of an absolute time on a Sunday-based scale. 1970-01-01 is a Thursday; the GPS
 * epoch, 1980-01-06, is 3657 days later and a Sunday. */
inline double second_of_week(double t) {
    double s = std::fmod(t - 3657.0 * 86400.0, 604800.0);
    return s < 0.0 ? s + 604800.0 : s;
}

}  // namespace nav_detail

inline bool parse_navigation(const char* bytes, size_t length, NavFile* out, Refusal* r) {
    using namespace nav_detail;
    *out = NavFile{};
    if (!bytes || length == 0) return fail(r, "bad-rinex", "The file is empty.");
    std::vector<std::string> lines;
    if (!split_ascii_lines(bytes, length, &lines, r)) return false;
    if (lines.empty()) return fail(r, "bad-rinex", "The file is empty.");

    size_t i = 0;
    bool saw_version = false, saw_end = false;
    std::map<std::string, size_t> uncarried;
    for (; i < lines.size(); ++i) {
        const std::string& line = lines[i];
        const std::string label = trim(cols(line, 60, 20));
        const std::string where = "Header line " + std::to_string(i + 1) + " (" + label + "): ";
        if (label == "RINEX VERSION / TYPE") {
            double version = 0.0;
            if (!to_double(cols(line, 0, 9), &version)) return fail(r, "bad-value", where + "the version is not a number.");
            out->version = version;
            if (!(std::fabs(version - 3.02) < 0.004 || std::fabs(version - 3.03) < 0.004 ||
                  std::fabs(version - 3.04) < 0.004 || std::fabs(version - 3.05) < 0.004)) {
                char text[96];
                std::snprintf(text, sizeof(text), "RINEX version %.2f is not one of 3.02, 3.03, 3.04 or 3.05.", version);
                return fail(r, "unsupported-rinex-version", where + text);
            }
            const char type = cols(line, 20, 1)[0];
            if (type != 'N') {
                return fail(r, "wrong-rinex-type", where + std::string("the file type is \"") + type + "\", not N (navigation data).");
            }
            out->system = cols(line, 40, 1)[0];
            saw_version = true;
        } else if (!saw_version) {
            return fail(r, "bad-rinex", "The first header line is not RINEX VERSION / TYPE.");
        } else if (label == "PGM / RUN BY / DATE") {
            out->program = trim(cols(line, 0, 20));
            out->run_by = trim(cols(line, 20, 20));
            out->date = trim(cols(line, 40, 20));
        } else if (label == "COMMENT") {
            out->comments.push_back(trim(cols(line, 0, 60)));
        } else if (label == "END OF HEADER") {
            saw_end = true;
            ++i;
            break;
        } else if (!label.empty()) {
            ++uncarried[label];
        }
    }
    if (!saw_version) return fail(r, "bad-rinex", "The file has no RINEX VERSION / TYPE record.");
    if (!saw_end) return fail(r, "bad-rinex", "The header has no END OF HEADER record.");
    for (const auto& kv : uncarried) {
        out->uncarried_labels.push_back(kv.second > 1 ? kv.first + " (" + std::to_string(kv.second) + ")" : kv.first);
    }

    while (i < lines.size()) {
        if (trim(lines[i]).empty()) { ++i; continue; }
        const std::string& head = lines[i];
        const std::string where = "Line " + std::to_string(i + 1) + ": ";
        if (!is_system_letter(head[0])) {
            return fail(r, "bad-navigation-record", where + "a navigation record opens with a satellite id (G R E C J I S).");
        }
        std::vector<const std::string*> body;
        size_t j = i + 1;
        while (j < lines.size() && !lines[j].empty() && lines[j][0] == ' ') body.push_back(&lines[j++]);
        const size_t first_line = i + 1;
        i = j;

        const char sys = head[0];
        if (sys == 'R' || sys == 'S') {
            ++out->not_evaluated[std::string(1, sys) + ": broadcasts a state vector, not a Keplerian set"];
            continue;
        }
        if (body.size() != 7) {
            return fail(r, "bad-navigation-record", "Line " + std::to_string(first_line) + ": a " + std::string(1, sys) +
                                                       " record has " + std::to_string(body.size() + 1) + " lines, not 8.");
        }
        NavMessage m;
        m.system = sys;
        std::string prn = cols(head, 1, 2);
        if (prn[0] == ' ') prn[0] = '0';
        long long prn_number = 0;
        if (!to_int(prn, &prn_number)) return fail(r, "bad-navigation-record", where + "the satellite number is not two digits.");
        m.prn = static_cast<int>(prn_number);
        m.id = std::string(1, sys) + prn;
        long long y = 0, mo = 0, d = 0, hh = 0, mi = 0, ss = 0;
        if (!to_int(cols(head, 4, 4), &y) || !to_int(cols(head, 9, 2), &mo) || !to_int(cols(head, 12, 2), &d) ||
            !to_int(cols(head, 15, 2), &hh) || !to_int(cols(head, 18, 2), &mi) || !to_int(cols(head, 21, 2), &ss) ||
            mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) {
            return fail(r, "bad-navigation-record", where + "the Toc is not \"yyyy mm dd hh mm ss\".");
        }
        m.toc = static_cast<double>(detail::days_from_civil(y, static_cast<unsigned>(mo), static_cast<unsigned>(d))) * 86400.0 +
                static_cast<double>(hh * 3600 + mi * 60 + ss);
        double clock[3] = {0.0, 0.0, 0.0};
        for (int k = 0; k < 3; ++k) {
            if (!number(head, 23 + static_cast<size_t>(k) * 19, &clock[k])) return fail(r, "bad-value", where + "a clock term is not a number.");
        }
        for (size_t row = 0; row < 7; ++row) {
            for (size_t k = 0; k < 4; ++k) {
                if (!number(*body[row], 4 + k * 19, &m.v[row * 4 + k])) {
                    return fail(r, "bad-value", "Line " + std::to_string(first_line + 1 + row) + ": a broadcast orbit value is not a number.");
                }
            }
        }
        const double sow_toc = second_of_week(m.toc);
        double delta = m.toe_sow() - sow_toc;
        m.toe_abs = m.toc - sow_toc + m.toe_sow();
        if (delta > 302400.0) m.toe_abs -= 604800.0;
        else if (delta < -302400.0) m.toe_abs += 604800.0;

        /* What this reader does not evaluate is counted by reason. */
        if (sys == 'I') { ++out->not_evaluated["I: IRNSS is not evaluated"]; continue; }
        if (sys == 'C' && (m.prn <= 5 || m.prn >= 59)) { ++out->not_evaluated["C: BeiDou GEO (PRN 1-5 and 59 and above) needs the ICD's -5 degree rotation"]; continue; }
        if (m.health() != 0.0) { ++out->not_evaluated[std::string(1, sys) + ": health word not 0"]; continue; }
        if (!(m.sqrt_a() > 1000.0) || !(m.e() >= 0.0 && m.e() < 0.9)) {
            return fail(r, "bad-navigation-record", where + m.id + ": sqrt(A) or the eccentricity is not an orbit.");
        }
        out->messages.push_back(m);
    }
    if (out->messages.empty() && out->not_evaluated.empty()) return fail(r, "missing-record", "The file holds no navigation record.");
    return true;
}

struct Constants {
    double mu, omega_e;
    const char* frame;
    const char* time_system;
};

inline bool constants_of(char system, Constants* out) {
    switch (system) {
        case 'G': *out = {3.986005e14, 7.2921151467e-5, "WGS84", "GPS"}; return true;
        case 'J': *out = {3.986005e14, 7.2921151467e-5, "WGS84", "QZSS"}; return true;
        case 'E': *out = {3.986004418e14, 7.2921151467e-5, "GTRF", "GST"}; return true;
        case 'C': *out = {3.986004418e14, 7.292115e-5, "CGCS2000", "BDT"}; return true;
        default: return false;
    }
}

struct State {
    double pos[3]; /* m, in the system's Earth-fixed frame */
    double vel[3]; /* m/s */
};

/* IS-GPS-200 table 20-IV at the absolute time t, with the velocity as the exact derivative of the same terms. */
inline bool evaluate(const NavMessage& m, double t, State* out) {
    Constants c;
    if (!constants_of(m.system, &c)) return false;
    const double tk = t - m.toe_abs;
    const double a = m.sqrt_a() * m.sqrt_a();
    const double n = std::sqrt(c.mu / (a * a * a)) + m.delta_n();
    const double mk = m.m0() + n * tk;
    double ek = mk;
    for (int it = 0; it < 60; ++it) {
        const double next = mk + m.e() * std::sin(ek);
        const bool done = std::fabs(next - ek) < 1e-15;
        ek = next;
        if (done) break;
    }
    const double sin_e = std::sin(ek), cos_e = std::cos(ek);
    const double root = std::sqrt(1.0 - m.e() * m.e());
    const double nu = std::atan2(root * sin_e, cos_e - m.e());
    const double phi = nu + m.omega();
    const double s2 = std::sin(2.0 * phi), c2 = std::cos(2.0 * phi);
    const double du = m.cus() * s2 + m.cuc() * c2;
    const double dr = m.crs() * s2 + m.crc() * c2;
    const double di = m.cis() * s2 + m.cic() * c2;
    const double u = phi + du;
    const double rk = a * (1.0 - m.e() * cos_e) + dr;
    const double ik = m.i0() + di + m.idot() * tk;
    const double xp = rk * std::cos(u), yp = rk * std::sin(u);
    const double omega_k = m.omega0() + (m.omega_dot() - c.omega_e) * tk - c.omega_e * m.toe_sow();
    const double so = std::sin(omega_k), co = std::cos(omega_k), si = std::sin(ik), ci = std::cos(ik);
    out->pos[0] = xp * co - yp * ci * so;
    out->pos[1] = xp * so + yp * ci * co;
    out->pos[2] = yp * si;

    const double e_dot = n / (1.0 - m.e() * cos_e);
    const double nu_dot = root * e_dot / (1.0 - m.e() * cos_e);
    const double du_dot = 2.0 * nu_dot * (m.cus() * c2 - m.cuc() * s2);
    const double dr_dot = 2.0 * nu_dot * (m.crs() * c2 - m.crc() * s2);
    const double di_dot = 2.0 * nu_dot * (m.cis() * c2 - m.cic() * s2);
    const double u_dot = nu_dot + du_dot;
    const double r_dot = a * m.e() * sin_e * e_dot + dr_dot;
    const double i_dot = m.idot() + di_dot;
    const double xp_dot = r_dot * std::cos(u) - rk * u_dot * std::sin(u);
    const double yp_dot = r_dot * std::sin(u) + rk * u_dot * std::cos(u);
    const double om_dot = m.omega_dot() - c.omega_e;
    out->vel[0] = xp_dot * co - yp_dot * ci * so + yp * si * so * i_dot - out->pos[1] * om_dot;
    out->vel[1] = xp_dot * so + yp_dot * ci * co - yp * si * co * i_dot + out->pos[0] * om_dot;
    out->vel[2] = yp_dot * si + yp * ci * i_dot;
    return true;
}

/* The state of one satellite at t, from the message whose Toe is nearest within the half-width; false if none. */
constexpr double kHalfWidthSeconds = 7200.0;
inline bool state_at(const std::vector<const NavMessage*>& messages, double t, State* out) {
    const NavMessage* best = nullptr;
    double best_distance = 0.0;
    for (const NavMessage* m : messages) {
        const double d = std::fabs(t - m->toe_abs);
        if (d <= kHalfWidthSeconds && (best == nullptr || d < best_distance)) {
            best = m;
            best_distance = d;
        }
    }
    return best != nullptr && evaluate(*best, t, out);
}

}  // namespace rinex

#endif  // RINEX_RINEX_NAV_HPP
