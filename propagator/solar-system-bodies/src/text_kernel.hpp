/*
 * propagator/solar-system-bodies — SPICE text-kernel reader.
 *
 * Reads the data sections of NAIF text kernels (PCK, FK): the assignments
 * between `\begindata` and `\begintext`, in the form `NAME = value`,
 * `NAME = ( v1 v2 ... )` and `NAME += ...`. Values are numbers (a D or E
 * exponent), quoted strings with doubled quotes, or `@` dates (kept as strings).
 * The grammar is NAIF's "Kernel Required Reading", section "Text kernel
 * format": https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/kernel.html
 *
 * A later assignment of the same name replaces the earlier one and `+=`
 * appends, exactly as the toolkit's kernel pool does, so loading pck00011
 * after an older PCK gives the toolkit's answer.
 */

#ifndef SSB_TEXT_KERNEL_HPP
#define SSB_TEXT_KERNEL_HPP

#include <cstdint>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>

namespace ssb {

struct KernelPool {
    std::map<std::string, std::vector<double>> numbers;
    std::map<std::string, std::vector<std::string>> strings;

    const std::vector<double>* get(const std::string& name) const {
        auto it = numbers.find(name);
        return it == numbers.end() ? nullptr : &it->second;
    }
    bool has(const std::string& name) const { return numbers.count(name) || strings.count(name); }
};

namespace text_detail {

inline bool is_space(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == ','; }

/* Section markers stand alone on a line, possibly indented. */
inline bool line_is(const std::string& line, const char* marker) {
    size_t a = 0, b = line.size();
    while (a < b && (line[a] == ' ' || line[a] == '\t')) ++a;
    while (b > a && (line[b - 1] == ' ' || line[b - 1] == '\t' || line[b - 1] == '\r')) --b;
    return line.compare(a, b - a, marker) == 0;
}

inline bool parse_number(const std::string& token, double* out) {
    std::string t = token;
    for (char& c : t) {
        if (c == 'D' || c == 'd') c = 'E';
    }
    char* end = nullptr;
    const double v = std::strtod(t.c_str(), &end);
    if (end == t.c_str() || *end != '\0') return false;
    *out = v;
    return true;
}

}  // namespace text_detail

/*
 * Parse one text kernel into `pool`. Returns false with `error` set on a
 * malformed data section; a kernel with no data section is an error too,
 * because loading it would silently change nothing.
 */
inline bool parse_text_kernel(const uint8_t* bytes, size_t len, KernelPool* pool, std::string* error) {
    using namespace text_detail;
    std::string data;
    bool in_data = false, saw_data = false;
    size_t start = 0;
    const char* text = reinterpret_cast<const char*>(bytes);
    while (start <= len) {
        size_t end = start;
        while (end < len && text[end] != '\n') ++end;
        std::string line(text + start, end - start);
        if (line_is(line, "\\begindata")) {
            in_data = saw_data = true;
        } else if (line_is(line, "\\begintext")) {
            in_data = false;
        } else if (in_data) {
            data += line;
            data += '\n';
        }
        if (end >= len) break;
        start = end + 1;
    }
    if (!saw_data) {
        *error = "the text kernel has no \\begindata section";
        return false;
    }

    size_t i = 0;
    const size_t n = data.size();
    auto skip = [&]() { while (i < n && is_space(data[i])) ++i; };
    while (true) {
        skip();
        if (i >= n) break;
        size_t name_start = i;
        while (i < n && !is_space(data[i]) && data[i] != '=' && data[i] != '+') ++i;
        std::string name = data.substr(name_start, i - name_start);
        skip();
        bool append = false;
        if (i < n && data[i] == '+') {
            append = true;
            ++i;
        }
        if (i >= n || data[i] != '=') {
            *error = "expected '=' after " + name;
            return false;
        }
        ++i;
        skip();
        std::vector<double> nums;
        std::vector<std::string> strs;
        auto read_value = [&]() -> bool {
            if (data[i] == '\'') {
                std::string s;
                ++i;
                while (i < n) {
                    if (data[i] == '\'') {
                        if (i + 1 < n && data[i + 1] == '\'') {
                            s += '\'';
                            i += 2;
                            continue;
                        }
                        ++i;
                        break;
                    }
                    s += data[i++];
                }
                strs.push_back(s);
                return true;
            }
            size_t t0 = i;
            while (i < n && !is_space(data[i]) && data[i] != ')') ++i;
            std::string token = data.substr(t0, i - t0);
            if (!token.empty() && token[0] == '@') {
                strs.push_back(token);
                return true;
            }
            double v = 0.0;
            if (!parse_number(token, &v)) {
                *error = "unreadable value '" + token + "' for " + name;
                return false;
            }
            nums.push_back(v);
            return true;
        };
        if (i < n && data[i] == '(') {
            ++i;
            while (true) {
                skip();
                if (i >= n) {
                    *error = "unterminated list for " + name;
                    return false;
                }
                if (data[i] == ')') {
                    ++i;
                    break;
                }
                if (!read_value()) return false;
            }
        } else if (i < n) {
            if (!read_value()) return false;
        }
        if (!nums.empty()) {
            auto& slot = pool->numbers[name];
            if (!append) slot.clear();
            slot.insert(slot.end(), nums.begin(), nums.end());
            if (!append) pool->strings.erase(name);
        }
        if (!strs.empty()) {
            auto& slot = pool->strings[name];
            if (!append) slot.clear();
            slot.insert(slot.end(), strs.begin(), strs.end());
            if (!append) pool->numbers.erase(name);
        }
    }
    return true;
}

}  // namespace ssb

#endif  // SSB_TEXT_KERNEL_HPP
