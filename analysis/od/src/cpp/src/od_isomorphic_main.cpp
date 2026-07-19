// od_isomorphic_main — the isomorphic wasi-threads OD module entry.
//
// Two surfaces over the SAME threaded batch core (od::run_batch_fit):
//
//  1. WASI command `main` (the runtime thread-proof + RMS-parity surface): reads
//     N in-memory $OEM FlatBuffer files, fans them across std::thread workers,
//     writes per-object $OMM/$OBD/$OCM, and prints a JSON telemetry line
//     (distinct_worker_thread_ids proves >1 real OS thread; per-object rms +
//     omm sha256 prove single- vs multi-thread byte parity). $OEM is INPUT ONLY;
//     it is never written to any store.
//
//  2. plugin_invoke_stream (the resident flow surface): a simple self-describing
//     binary batch ABI so a host/harness can drive the resident module directly.
//       request  = [u32 num_threads][u32 flags][u32 count]{[u32 oem_len][oem]}*
//       response = [u32 count]{[u32 omm_len][omm][u32 ocm_len][ocm]
//                              [u32 obd_len][obd][f64 rms][u32 worker_tid_lo]}*
//                  [u32 distinct_thread_ids]
//     (The full SDS $PIV bridge — bake/flow-composition — reuses this same
//     run_batch_fit core; that wiring belongs to the deploy/flow node.)

#include "od_batch_fit.hpp"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

// ── minimal SHA-256 (for stable omm byte-parity hashes in the JSON telemetry) ──
namespace {
struct Sha256 {
    static void hash(const uint8_t* data, size_t len, char out_hex[65]) {
        static const uint32_t K[64] = {
            0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
            0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
            0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
            0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
            0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
            0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
            0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
            0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
        uint32_t h[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
        std::vector<uint8_t> msg(data, data + len);
        uint64_t bl = static_cast<uint64_t>(len) * 8u;
        msg.push_back(0x80);
        while (msg.size() % 64 != 56) msg.push_back(0);
        for (int i = 7; i >= 0; --i) msg.push_back(static_cast<uint8_t>((bl >> (i * 8)) & 0xff));
        auto rotr = [](uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); };
        for (size_t off = 0; off < msg.size(); off += 64) {
            uint32_t w[64];
            for (int i = 0; i < 16; ++i)
                w[i] = (uint32_t(msg[off+i*4])<<24)|(uint32_t(msg[off+i*4+1])<<16)|(uint32_t(msg[off+i*4+2])<<8)|uint32_t(msg[off+i*4+3]);
            for (int i = 16; i < 64; ++i) {
                uint32_t s0 = rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>3);
                uint32_t s1 = rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>10);
                w[i] = w[i-16]+s0+w[i-7]+s1;
            }
            uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
            for (int i = 0; i < 64; ++i) {
                uint32_t S1=rotr(e,6)^rotr(e,11)^rotr(e,25), ch=(e&f)^(~e&g);
                uint32_t t1=hh+S1+ch+K[i]+w[i];
                uint32_t S0=rotr(a,2)^rotr(a,13)^rotr(a,22), maj=(a&b)^(a&c)^(b&c);
                uint32_t t2=S0+maj;
                hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
            }
            h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
        }
        static const char* hex = "0123456789abcdef";
        for (int i = 0; i < 8; ++i)
            for (int j = 0; j < 4; ++j) {
                uint8_t byte = (h[i] >> (24 - j*8)) & 0xff;
                out_hex[i*8+j*2] = hex[byte>>4];
                out_hex[i*8+j*2+1] = hex[byte&0xf];
            }
        out_hex[64] = 0;
    }
};

std::vector<uint8_t> read_file(const char* path) {
    std::vector<uint8_t> buf;
    FILE* f = std::fopen(path, "rb");
    if (!f) return buf;
    std::fseek(f, 0, SEEK_END);
    long n = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    if (n > 0) { buf.resize(static_cast<size_t>(n)); size_t got = std::fread(buf.data(), 1, buf.size(), f); buf.resize(got); }
    std::fclose(f);
    return buf;
}

bool write_file(const std::string& path, const std::vector<uint8_t>& data) {
    FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) return false;
    if (!data.empty()) std::fwrite(data.data(), 1, data.size(), f);
    std::fclose(f);
    return true;
}
}  // namespace

// ── WASI command entry ──────────────────────────────────────────────────────
int main(int argc, char** argv) {
    // Default (no --threads): 0 => run_batch_fit resolves the effective worker
    // count (kOdFitDefaultThreads under wasi-threads, where hardware_concurrency()
    // reports 1 and would otherwise single-thread the pool). This is the SAME
    // default resolution the composed-flow fit() entry uses, so the "no --threads"
    // path exercises and PROVES the composed default path threads. An explicit
    // `--threads N` (N>0) overrides it unchanged.
    int num_threads = 0;
    std::string out_dir = ".";
    std::vector<std::string> files;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--threads" && i + 1 < argc) { num_threads = std::atoi(argv[++i]); }
        else if (a == "--out" && i + 1 < argc) { out_dir = argv[++i]; }
        else if (a == "--covariance") { /* always on; accepted for compatibility */ }
        else if (a == "--") { /* some hosts (wasmtime) forward the arg separator */ }
        else files.push_back(a);
    }

    if (std::getenv("OD_ARGV_DEBUG")) {
        std::fprintf(stderr, "argc=%d ", argc);
        for (int i = 0; i < argc; i++) std::fprintf(stderr, "[%d]=%s ", i, argv[i]);
        std::fprintf(stderr, "\n");
    }

    std::vector<od::BatchObject> objs;
    objs.reserve(files.size());
    for (const auto& fpath : files) objs.push_back(od::BatchObject{read_file(fpath.c_str())});

    od::BatchRunStats stats{};
    std::vector<od::BatchResult> results = od::run_batch_fit(objs, num_threads, &stats);

    // Emit per-object records ($OMM/$OBD/$OCM). $OEM is never written back.
    for (size_t i = 0; i < results.size(); ++i) {
        const auto& r = results[i];
        if (!r.ok) {
            std::fprintf(stderr, "obj%zu FAIL oem_bytes=%zu code=%s msg=%s\n",
                         i, objs[i].oem.size(), r.error_code.c_str(), r.error_message.c_str());
            continue;
        }
        std::string base = out_dir + "/obj" + std::to_string(i);
        write_file(base + ".omm", r.omm);
        write_file(base + ".obd", r.obd);
        write_file(base + ".ocm", r.ocm);
    }

    // JSON telemetry line to stdout (thread proof + RMS/byte-parity evidence).
    std::string js = "{\"objects\":" + std::to_string(results.size()) +
                     ",\"threads_requested\":" + std::to_string(stats.threads_requested) +
                     ",\"worker_count\":" + std::to_string(stats.worker_count) +
                     ",\"distinct_worker_thread_ids\":" + std::to_string(stats.distinct_thread_ids) +
                     ",\"results\":[";
    for (size_t i = 0; i < results.size(); ++i) {
        const auto& r = results[i];
        char rms[48]; std::snprintf(rms, sizeof(rms), "%.9g", r.rms_km);
        char omm_hash[65] = "";
        if (!r.omm.empty()) Sha256::hash(r.omm.data(), r.omm.size(), omm_hash);
        if (i) js += ",";
        js += "{\"idx\":" + std::to_string(i) +
              ",\"ok\":" + (r.ok ? "true" : "false") +
              ",\"converged\":" + (r.converged ? "true" : "false") +
              ",\"rms_km\":" + rms +
              ",\"omm_sha256\":\"" + omm_hash + "\"" +
              ",\"omm_bytes\":" + std::to_string(r.omm.size()) +
              ",\"ocm_bytes\":" + std::to_string(r.ocm.size()) +
              ",\"obd_bytes\":" + std::to_string(r.obd.size()) + "}";
    }
    js += "]}\n";
    std::fwrite(js.data(), 1, js.size(), stdout);
    std::fflush(stdout);
    return 0;
}

// ── resident flow surface: simple binary batch ABI ──────────────────────────
namespace {
uint32_t rd_u32(const uint8_t* p) { return uint32_t(p[0]) | (uint32_t(p[1])<<8) | (uint32_t(p[2])<<16) | (uint32_t(p[3])<<24); }
void wr_u32(std::vector<uint8_t>& v, uint32_t x) { v.push_back(x&0xff); v.push_back((x>>8)&0xff); v.push_back((x>>16)&0xff); v.push_back((x>>24)&0xff); }
void wr_bytes(std::vector<uint8_t>& v, const std::vector<uint8_t>& b) { wr_u32(v, uint32_t(b.size())); v.insert(v.end(), b.begin(), b.end()); }
}  // namespace

extern "C" __attribute__((visibility("default"))) uint32_t plugin_alloc(uint32_t size) {
    void* p = std::malloc(size ? size : 1);
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(p));
}
extern "C" __attribute__((visibility("default"))) void plugin_free(uint32_t ptr, uint32_t) {
    if (ptr) std::free(reinterpret_cast<void*>(static_cast<uintptr_t>(ptr)));
}

extern "C" __attribute__((visibility("default")))
uint32_t plugin_invoke_stream(uint32_t request_ptr, uint32_t request_len, uint32_t response_len_out_ptr) {
    if (response_len_out_ptr) *reinterpret_cast<uint32_t*>(static_cast<uintptr_t>(response_len_out_ptr)) = 0;
    const uint8_t* req = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(request_ptr));
    if (!req || request_len < 12) return 0;

    size_t off = 0;
    int num_threads = static_cast<int>(rd_u32(req + off)); off += 4;
    (void)rd_u32(req + off); off += 4;  // flags (reserved; covariance always on)
    uint32_t count = rd_u32(req + off); off += 4;

    std::vector<od::BatchObject> objs;
    objs.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
        if (off + 4 > request_len) return 0;
        uint32_t len = rd_u32(req + off); off += 4;
        if (off + len > request_len) return 0;
        objs.push_back(od::BatchObject{std::vector<uint8_t>(req + off, req + off + len)});
        off += len;
    }

    od::BatchRunStats stats{};
    std::vector<od::BatchResult> results = od::run_batch_fit(objs, num_threads, &stats);

    std::vector<uint8_t> resp;
    wr_u32(resp, static_cast<uint32_t>(results.size()));
    for (const auto& r : results) {
        wr_bytes(resp, r.omm);
        wr_bytes(resp, r.ocm);
        wr_bytes(resp, r.obd);
        double rms = r.rms_km;
        const uint8_t* rp = reinterpret_cast<const uint8_t*>(&rms);
        resp.insert(resp.end(), rp, rp + 8);
        wr_u32(resp, static_cast<uint32_t>(r.worker_tid & 0xffffffffull));
    }
    wr_u32(resp, static_cast<uint32_t>(stats.distinct_thread_ids));

    uint32_t out_ptr = plugin_alloc(static_cast<uint32_t>(resp.size()));
    if (!out_ptr) return 0;
    std::memcpy(reinterpret_cast<void*>(static_cast<uintptr_t>(out_ptr)), resp.data(), resp.size());
    if (response_len_out_ptr) *reinterpret_cast<uint32_t*>(static_cast<uintptr_t>(response_len_out_ptr)) = static_cast<uint32_t>(resp.size());
    return out_ptr;
}
