/*
 * The NDM engine, native: one message file in, the record it makes, the same
 * record written as KVN and as XML, and each of those read back. Everything the
 * module does that is not the frame around it, so it is built and run without a
 * WASM toolchain:
 *
 *   ndm_native <TYPE> <message file> <output directory>
 *
 * Prints one `RESULT name actual expected PASS|FAIL` line per check, the issue
 * counts the read reported, and writes `<TYPE>.kvn`, `<TYPE>.xml`, `<TYPE>.fb`.
 * Exit status is the number of failures.
 */
#define PUGIXML_NO_EXCEPTIONS
#define PUGIXML_NO_XPATH
#define PUGIXML_NO_STL
#include "pugixml.cpp"

#include "ndm_headers.hpp"
#include "ndm_registry.hpp"

#include <cstdio>
#include <fstream>
#include <iterator>

static int failures = 0;
static void check(const std::string& name, const std::string& actual, const std::string& expected) {
    const bool ok = actual == expected;
    std::printf("RESULT %-48s %-24s %-24s %s\n", name.c_str(), actual.c_str(), expected.c_str(),
                ok ? "PASS" : "FAIL");
    if (!ok) ++failures;
}

static std::vector<uint8_t> slurp(const char* path) {
    std::ifstream f(path, std::ios::binary);
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}
static void spit(const std::string& path, const void* data, size_t n) {
    std::ofstream f(path, std::ios::binary);
    f.write(static_cast<const char*>(data), static_cast<std::streamsize>(n));
}

int main(int argc, char** argv) {
    if (argc < 4) { std::fprintf(stderr, "usage: ndm_native TYPE FILE OUTDIR\n"); return 2; }
    const std::string type = argv[1], outdir = argv[3];
    const ndm::registry::Entry* entry = ndm::registry::find(type);
    if (!entry) { std::fprintf(stderr, "no message %s\n", type.c_str()); return 2; }
    const std::vector<uint8_t> input = slurp(argv[2]);

    ndm::ReadOutcome a;
    const bool read_ok = entry->read(input.data(), input.size(), &a);
    check("read.ok", read_ok ? "ok" : a.code + ": " + a.error, "ok");
    if (!read_ok) return 1;
    check("read.syntax", ndm::syntax_name(a.syntax), ndm::syntax_name(ndm::detect_syntax(input.data(), input.size())));
    std::printf("INFO version=%s record=%zu bytes\n", a.version.c_str(), a.record.size());
    for (int k = 0; k < 6; ++k) {
        const size_t n = a.report.count(static_cast<ndm::IssueKind>(k));
        if (n) std::printf("INFO issues %s=%zu\n", ndm::issue_name(static_cast<ndm::IssueKind>(k)), n);
    }
    if (std::getenv("NDM_VERBOSE")) {
        for (const ndm::Issue& i : a.report.issues)
            std::printf("ISSUE %s %s %s %s line %d\n", ndm::issue_name(i.kind), i.where.c_str(), i.key.c_str(), i.detail.c_str(), i.line);
    }
    spit(outdir + "/" + type + ".fb", a.record.data(), a.record.size());

    for (int s = 0; s < 2; ++s) {
        ndm::WriteOptions o;
        o.syntax = s == 0 ? ndm::Syntax::Kvn : ndm::Syntax::Xml;
        std::string text, error;
        const bool wrote = entry->write(a.record.data(), a.record.size(), o, &text, &error, nullptr);
        const std::string tag = ndm::syntax_name(o.syntax);
        check("write." + tag, wrote ? "ok" : error, "ok");
        if (!wrote) continue;
        spit(outdir + "/" + type + (s == 0 ? ".kvn" : ".xml"), text.data(), text.size());
        ndm::ReadOutcome b;
        const bool again = entry->read(reinterpret_cast<const uint8_t*>(text.data()), text.size(), &b);
        check("reread." + tag, again ? "ok" : b.code + ": " + b.error, "ok");
        if (!again) continue;
        check("reread." + tag + ".syntax", ndm::syntax_name(b.syntax), tag);
        check("reread." + tag + ".record-identical", b.record == a.record ? "identical" : "differs", "identical");
        // A second write is byte-identical to the first: the writer is a fixed point.
        std::string text2, error2;
        entry->write(b.record.data(), b.record.size(), o, &text2, &error2, nullptr);
        check("rewrite." + tag + ".text-identical", text2 == text ? "identical" : "differs", "identical");
    }
    std::printf("%d failures\n", failures);
    return failures;
}
