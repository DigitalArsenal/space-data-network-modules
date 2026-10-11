/*
 * A mutation fuzz of the NDM engine, native, under whatever sanitizers the test builds it with.
 *
 *   ndm_fuzz <rounds per file> <fixtures directory> <directory for the cases that fail>
 *
 * Every fixture, in KVN and in XML, is mutated `rounds` times (a byte or a run of them deleted,
 * replaced, inserted or reversed, a line dropped or doubled, markup characters scattered, the text
 * cut short or doubled), deterministically. Each mutation is read. What the engine refuses it
 * refuses by name; what it reads must write as KVN and as XML (or be refused as unwritable in that
 * syntax) and what it writes must read back as the very same record. A mutation that breaks any of
 * these is written to the directory and reported as a line starting with FAIL; the exit status is
 * the number of failures.
 */
#define PUGIXML_NO_EXCEPTIONS
#define PUGIXML_NO_XPATH
#define PUGIXML_NO_STL
#include "pugixml.cpp"

#include "ndm_headers.hpp"
#include "ndm_registry.hpp"

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <functional>
#include <iterator>
#include <map>
#include <random>

static std::string slurp(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

static void spit(const std::string& path, const std::string& bytes) {
    std::ofstream f(path, std::ios::binary);
    f.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

static std::string mutate(const std::string& in, std::mt19937_64& rng) {
    static const char* const pieces[] = {"=", " = ", "[", "]", "<", ">", "</", "/>", "\"", "&", "&amp;", "<!--",
                                         "-->", "e", "E+", "nan", "inf", "-", "+", ".", "\r", "\t", " "};
    std::string s = in;
    const int count = 1 + static_cast<int>(rng() % 4);
    for (int k = 0; k < count && !s.empty(); ++k) {
        switch (rng() % 9) {
            case 0: s.erase(rng() % s.size(), 1 + rng() % 20); break;
            case 1: s.insert(rng() % s.size(), 1, (rng() & 1) ? static_cast<char>(32 + rng() % 95) : static_cast<char>(rng() % 256)); break;
            case 2: s[rng() % s.size()] = (rng() & 3) ? static_cast<char>(32 + rng() % 95) : static_cast<char>(rng() % 256); break;
            case 3: s.resize(rng() % s.size()); break;
            case 4: {
                const size_t a = s.find('\n', rng() % s.size());
                if (a != std::string::npos && a > 0) {
                    size_t b = s.rfind('\n', a - 1);
                    b = b == std::string::npos ? 0 : b;
                    s.insert(a, s.substr(b, a - b));
                }
                break;
            }
            case 5: {
                const size_t a = s.find('\n', rng() % s.size());
                if (a != std::string::npos && a > 0) {
                    size_t b = s.rfind('\n', a - 1);
                    b = b == std::string::npos ? 0 : b;
                    s.erase(b, a - b);
                }
                break;
            }
            case 6: s.insert(rng() % s.size(), pieces[rng() % (sizeof(pieces) / sizeof(pieces[0]))]); break;
            case 7: s.append(in.substr(0, rng() % in.size())); break;
            case 8: {
                size_t a = rng() % s.size(), b = rng() % s.size();
                if (a > b) std::swap(a, b);
                std::reverse(s.begin() + static_cast<std::ptrdiff_t>(a), s.begin() + static_cast<std::ptrdiff_t>(b));
                break;
            }
        }
    }
    return s;
}

int main(int argc, char** argv) {
    if (argc < 4) {
        std::fprintf(stderr, "usage: ndm_fuzz ROUNDS FIXTURES FAILDIR\n");
        return 2;
    }
    const int rounds = std::atoi(argv[1]);
    const std::string dir = argv[2], faildir = argv[3];
    struct F { const char* type; const char* stem; };
    const F files[] = {
        {"OMM", "ndm/ndm-omm-sgp4-covariance"}, {"OMM", "ndm/ndm-omm-sgp4xp"}, {"OEM", "ndm/ndm-oem-two-segments"},
        {"OPM", "ndm/ndm-opm-two-maneuvers"}, {"OCM", "ndm/ndm-ocm-blocks"}, {"CDM", "ndm/ndm-cdm-full-covariance"},
        {"APM", "ndm/ndm-apm-states"}, {"ACM", "ndm/ndm-acm-blocks"}, {"RDM", "ndm/ndm-rdm-prediction"},
    };
    std::map<std::string, long> outcomes;
    long mutated = 0, failures = 0;
    for (const F& f : files) {
        const ndm::registry::Entry* entry = ndm::registry::find(f.type);
        for (const char* extension : {".kvn", ".xml"}) {
            const std::string original = slurp(dir + "/" + f.stem + extension);
            std::mt19937_64 rng(std::hash<std::string>()(std::string(f.stem) + extension));
            for (int round = 0; round < rounds; ++round) {
                const std::string message = mutate(original, rng);
                ++mutated;
                ndm::ReadOutcome first;
                if (!entry->read(reinterpret_cast<const uint8_t*>(message.data()), message.size(), &first)) {
                    ++outcomes["refused:" + first.code];
                    continue;
                }
                ++outcomes["read"];
                for (const ndm::Syntax syntax : {ndm::Syntax::Kvn, ndm::Syntax::Xml}) {
                    ndm::WriteOptions options;
                    options.syntax = syntax;
                    std::string text, error;
                    if (!entry->write(first.record.data(), first.record.size(), options, &text, &error, nullptr)) {
                        ++outcomes["unwritable"];  // text one syntax cannot state, said so by name
                        continue;
                    }
                    ndm::ReadOutcome again;
                    const bool readable = entry->read(reinterpret_cast<const uint8_t*>(text.data()), text.size(), &again);
                    if (readable && again.record == first.record) {
                        ++outcomes["roundtrip"];
                        continue;
                    }
                    const std::string base = faildir + "/" + std::string(f.type) + "-" + std::to_string(failures++);
                    spit(base + ".input", message);
                    spit(base + ".written", text);
                    std::printf("FAIL %s %s %s: %s\n", f.type, ndm::syntax_name(syntax), readable ? "reads back as another record" : "does not read back",
                                readable ? "" : again.error.c_str());
                }
            }
        }
    }
    std::printf("%ld mutated messages\n", mutated);
    for (const auto& kv : outcomes) std::printf("  %-34s %ld\n", kv.first.c_str(), kv.second);
    return static_cast<int>(failures);
}
