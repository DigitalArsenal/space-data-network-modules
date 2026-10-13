// Native build of the site-registry stages (the same translation unit as the
// module, without the plugin entry points), for replaying recorded answers
// fast during development: tools/run-native.mjs drives it.
//   sr-native <stage> <inputs file> <outputs directory>
// inputs: u32 count, then per frame u32 port length, port, u32 size, bytes.
#include <chrono>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include CORE_TU

int main(int argc, char** argv) {
  if (argc != 4) { std::cerr << "usage: sr-native <stage> <inputs> <outdir>\n"; return 2; }
  std::ifstream in(argv[2], std::ios::binary);
  std::string blob((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  const auto* p = reinterpret_cast<const uint8_t*>(blob.data());
  size_t at = 0;
  auto u32 = [&]() { uint32_t v = sr::le32u(p + at); at += 4; return v; };
  sr::StageIO io;
  const uint32_t count = u32();
  for (uint32_t i = 0; i < count; ++i) {
    const uint32_t pl = u32();
    std::string port(blob.data() + at, pl);
    at += pl;
    const uint32_t n = u32();
    io.inputs.push_back({port, p + at, n});
    at += n;
  }
  const auto t0 = std::chrono::steady_clock::now();
  const bool ok = sr::runStage(argv[1], io);
  const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  std::cerr << argv[1] << " " << (ok ? "ok" : "FAILED") << " " << secs << " s\n";
  if (!ok) { std::cerr << io.error << "\n"; return 1; }
  std::ofstream list(std::string(argv[3]) + "/outputs.txt");
  for (size_t i = 0; i < io.outputs.size(); ++i) {
    const auto& o = io.outputs[i];
    const std::string file = std::string(argv[3]) + "/" + std::to_string(i) + "-" + o.port + ".bin";
    std::ofstream f(file, std::ios::binary);
    f.write(reinterpret_cast<const char*>(o.bytes.data()), long(o.bytes.size()));
    list << o.port << "\t" << file << "\n";
  }
  return 0;
}
