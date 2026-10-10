// Reads one provider ephemeris (a path, or '-' for stdin) and prints what
// odhpop::formats::parse() made of it: objects, samples, first/last epoch,
// frame, scale, events. Counts and structure only; sample values are not
// printed. '-' lets a caller pipe bytes straight from memory.
//   formats_probe <path|-> <format> [--objects N]   (N objects listed, default 3)
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

#include "formats/formats.hpp"

namespace {

std::string with_offset(const odhpop::formats::RawSample& s) {
  if (s.offset_s == 0) return s.epoch;
  char buf[48];
  std::snprintf(buf, sizeof buf, " +%gs", s.offset_s);
  return s.epoch + buf;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: formats_probe <path|-> <format> [--objects N]\n");
    std::fprintf(stderr, "formats:");
    for (const std::string& f : odhpop::formats::formats()) std::fprintf(stderr, " %s", f.c_str());
    std::fprintf(stderr, "\n");
    return 2;
  }
  std::size_t listed = 3;
  for (int i = 3; i + 1 < argc; ++i)
    if (!std::strcmp(argv[i], "--objects")) listed = static_cast<std::size_t>(std::atoi(argv[i + 1]));

  std::vector<uint8_t> bytes;
  if (!std::strcmp(argv[1], "-")) {
    bytes.assign(std::istreambuf_iterator<char>(std::cin), std::istreambuf_iterator<char>());
  } else {
    FILE* f = std::fopen(argv[1], "rb");
    if (!f) { std::fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }
    uint8_t buf[65536];
    std::size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) bytes.insert(bytes.end(), buf, buf + n);
    std::fclose(f);
  }

  const odhpop::formats::ParseResult r = odhpop::formats::parse(argv[2], bytes.data(), bytes.size());
  std::printf("format=%s bytes=%zu ok=%d\n", argv[2], bytes.size(), r.ok ? 1 : 0);
  if (!r.ok) {
    std::printf("error_code=%s\nerror_message=%s\n", r.error_code.c_str(), r.error_message.c_str());
    return 1;
  }
  std::size_t total = 0, with_v = 0, events = 0;
  for (const auto& o : r.objects) {
    total += o.samples.size();
    events += o.events.size();
    for (const auto& s : o.samples) with_v += s.has_velocity ? 1 : 0;
  }
  std::printf("objects=%zu samples=%zu with_velocity=%zu events=%zu\n", r.objects.size(), total, with_v, events);
  for (std::size_t i = 0; i < r.objects.size() && i < listed; ++i) {
    const auto& o = r.objects[i];
    std::printf("object[%zu] name=\"%s\" id=\"%s\" norad=%d frame=%s scale=%s samples=%zu\n", i, o.object_name.c_str(),
                o.object_id.c_str(), o.norad_cat_id, o.frame.c_str(), o.scale.c_str(), o.samples.size());
    if (!o.samples.empty())
      std::printf("  first=%s last=%s segments=%d..%d\n", with_offset(o.samples.front()).c_str(),
                  with_offset(o.samples.back()).c_str(), o.samples.front().segment, o.samples.back().segment);
    for (const auto& e : o.events) std::printf("  event epoch=%s text=\"%s\"\n", e.epoch.c_str(), e.text.c_str());
  }
  if (r.objects.size() > listed) std::printf("... %zu more objects\n", r.objects.size() - listed);
  return 0;
}
