/*
 * Catalog semantic search — the whole query path, in WASM.
 *
 * Two kernels, both trivial by design:
 *
 *   encode(text)  = L2normalise( Σ idf[t]·scale[t]·W[t] / Σ idf[t] )
 *   search(q)     = top-k over int8 catalog rows by dot product
 *
 * There is no transformer here and that is the point. The catalog side is
 * embedded OFFLINE by a full MiniLM at publish time; only the QUERY side runs
 * in the browser, and a static token table reproduces the teacher's sentence
 * vector closely enough to retrieve against its own output (measured: the
 * distilled student scores nDCG@10 0.418 against the teacher's 0.414 on the
 * 274-query acceptance suite). What that buys is a 1.4 MB model with no
 * runtime, instead of 23 MB of weights plus an 11 MB onnxruntime whose
 * session-create measurably froze a main thread for nine seconds.
 *
 * THREADING: wasi-threads (clang wasm32-wasip1-threads, never emcc -pthread).
 * The scan is row-range partitioned, so output is bit-identical at any thread
 * count, and `wasi.thread-spawn` returning -1 (a browser lane without
 * cross-origin isolation) falls back to the inline single-threaded path with
 * the same result.
 */

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

namespace sdn_embsearch {

// ---------------------------------------------------------------- containers

/*
 * .sdnemb — the distilled query encoder.
 *   magic "SDNEMB01" | u32 dim | u32 vocabCount | u32 vocabBytes
 *   vocabBytes of '\n'-separated WordPiece tokens
 *   f32[vocabCount] idf | f32[vocabCount] scale | i8[vocabCount*dim] weights
 */
struct Encoder {
  uint32_t dim = 0;
  uint32_t count = 0;
  const float* idf = nullptr;
  const float* scale = nullptr;
  const int8_t* weights = nullptr;
  std::vector<std::string> tokens;
  // Open-addressed token -> slot map. Sized to the next power of two above
  // 2*count so probe chains stay short; the vocabulary is ~3.8k entries.
  std::vector<int32_t> bucket;
  uint32_t mask = 0;

  bool valid() const { return dim > 0 && count > 0 && weights != nullptr; }
};

/*
 * .sdnvec — the catalog vector table.
 *   magic "SDNVEC01" | u32 dim | u32 count
 *   f32[count] scale | i8[count*dim] vectors | u32[count] norads
 */
struct Catalog {
  uint32_t dim = 0;
  uint32_t count = 0;
  const float* scale = nullptr;
  const int8_t* vectors = nullptr;
  const uint32_t* norads = nullptr;

  bool valid() const { return dim > 0 && count > 0 && vectors != nullptr; }
};

static uint32_t fnv1a(const char* s, size_t n) {
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < n; ++i) {
    h ^= static_cast<uint8_t>(s[i]);
    h *= 16777619u;
  }
  return h;
}

static bool parse_encoder(const uint8_t* p, uint32_t len, Encoder& out) {
  if (!p || len < 20 || std::memcmp(p, "SDNEMB01", 8) != 0) return false;
  uint32_t dim, count, vocabBytes;
  std::memcpy(&dim, p + 8, 4);
  std::memcpy(&count, p + 12, 4);
  std::memcpy(&vocabBytes, p + 16, 4);
  const uint64_t need =
    20ull + vocabBytes + 4ull * count + 4ull * count + 1ull * count * dim;
  if (need > len) return false;

  out.dim = dim;
  out.count = count;
  const uint8_t* cur = p + 20;
  const char* vocabText = reinterpret_cast<const char*>(cur);
  cur += vocabBytes;
  out.idf = reinterpret_cast<const float*>(cur);
  cur += 4ull * count;
  out.scale = reinterpret_cast<const float*>(cur);
  cur += 4ull * count;
  out.weights = reinterpret_cast<const int8_t*>(cur);

  out.tokens.reserve(count);
  uint32_t start = 0;
  for (uint32_t i = 0; i <= vocabBytes; ++i) {
    if (i == vocabBytes || vocabText[i] == '\n') {
      out.tokens.emplace_back(vocabText + start, i - start);
      start = i + 1;
    }
  }
  if (out.tokens.size() < count) return false;
  out.tokens.resize(count);

  uint32_t cap = 16;
  while (cap < count * 2u) cap <<= 1;
  out.mask = cap - 1;
  out.bucket.assign(cap, -1);
  for (uint32_t i = 0; i < count; ++i) {
    uint32_t h = fnv1a(out.tokens[i].data(), out.tokens[i].size()) & out.mask;
    while (out.bucket[h] != -1) h = (h + 1) & out.mask;
    out.bucket[h] = static_cast<int32_t>(i);
  }
  return true;
}

static bool parse_catalog(const uint8_t* p, uint32_t len, Catalog& out) {
  if (!p || len < 16 || std::memcmp(p, "SDNVEC01", 8) != 0) return false;
  uint32_t dim, count;
  std::memcpy(&dim, p + 8, 4);
  std::memcpy(&count, p + 12, 4);
  const uint64_t need = 16ull + 4ull * count + 1ull * count * dim + 4ull * count;
  if (need > len) return false;
  out.dim = dim;
  out.count = count;
  const uint8_t* cur = p + 16;
  out.scale = reinterpret_cast<const float*>(cur);
  cur += 4ull * count;
  out.vectors = reinterpret_cast<const int8_t*>(cur);
  cur += 1ull * count * dim;
  out.norads = reinterpret_cast<const uint32_t*>(cur);
  return true;
}

static int32_t lookup(const Encoder& e, const char* s, size_t n) {
  if (e.bucket.empty()) return -1;
  uint32_t h = fnv1a(s, n) & e.mask;
  while (true) {
    const int32_t slot = e.bucket[h];
    if (slot < 0) return -1;
    const std::string& t = e.tokens[static_cast<size_t>(slot)];
    if (t.size() == n && std::memcmp(t.data(), s, n) == 0) return slot;
    h = (h + 1) & e.mask;
  }
}

// ---------------------------------------------------------------- tokenizer
//
// BERT basic tokenization + greedy longest-match WordPiece, over the PRUNED
// domain vocabulary. Must match lib/encoder.mjs exactly — that JS file is the
// parity oracle the tri-runtime lanes compare against.

static void tokenize(const Encoder& e, const std::string& text, std::vector<int32_t>& out) {
  out.clear();
  std::string word;
  auto flush = [&]() {
    if (word.empty()) return;
    // Greedy longest-match, "##" continuation pieces after the first.
    std::vector<int32_t> sub;
    size_t start = 0;
    bool ok = true;
    while (start < word.size()) {
      size_t end = word.size();
      int32_t found = -1;
      while (start < end) {
        std::string piece;
        if (start > 0) piece = "##";
        piece.append(word, start, end - start);
        found = lookup(e, piece.data(), piece.size());
        if (found >= 0) break;
        --end;
      }
      if (found < 0) {
        ok = false;
        break;
      }
      sub.push_back(found);
      start = end;
    }
    // Out-of-domain words contribute nothing rather than a misleading [UNK].
    if (ok) out.insert(out.end(), sub.begin(), sub.end());
    word.clear();
  };

  for (unsigned char c : text) {
    if (c < 0x80 && (std::isalnum(c) != 0)) {
      word.push_back(static_cast<char>(std::tolower(c)));
    } else if (c >= 0x80) {
      // Keep multi-byte sequences intact; the vocabulary holds them verbatim.
      word.push_back(static_cast<char>(c));
    } else if (std::isspace(c) != 0) {
      flush();
    } else {
      // Punctuation is its own token, exactly as the JS reference does.
      flush();
      const char p[1] = {static_cast<char>(c)};
      const int32_t slot = lookup(e, p, 1);
      if (slot >= 0) out.push_back(slot);
    }
  }
  flush();
}

// ------------------------------------------------------------------- encode

static bool encode(const Encoder& e, const std::string& text, std::vector<float>& out) {
  out.assign(e.dim, 0.0f);
  std::vector<int32_t> slots;
  tokenize(e, text, slots);
  if (slots.empty()) return false;

  float wsum = 0.0f;
  for (int32_t s : slots) {
    const float w = e.idf[s];
    const float q = w * e.scale[s];
    wsum += w;
    const int8_t* row = e.weights + static_cast<size_t>(s) * e.dim;
    for (uint32_t d = 0; d < e.dim; ++d) out[d] += q * static_cast<float>(row[d]);
  }
  if (wsum <= 0.0f) return false;
  float norm = 0.0f;
  for (uint32_t d = 0; d < e.dim; ++d) {
    out[d] /= wsum;
    norm += out[d] * out[d];
  }
  if (norm <= 0.0f) return false;
  norm = std::sqrt(norm);
  for (uint32_t d = 0; d < e.dim; ++d) out[d] /= norm;
  return true;
}

// ------------------------------------------------------------------- search

/** Dot product of a float query against one int8 catalog row. */
static inline float row_dot(const float* q, const int8_t* row, uint32_t dim) {
#if defined(__wasm_simd128__)
  v128_t acc = wasm_f32x4_splat(0.0f);
  uint32_t d = 0;
  for (; d + 16 <= dim; d += 16) {
    const v128_t raw = wasm_v128_load(row + d);
    const v128_t lo16 = wasm_i16x8_extend_low_i8x16(raw);
    const v128_t hi16 = wasm_i16x8_extend_high_i8x16(raw);
    const v128_t a = wasm_f32x4_convert_i32x4(wasm_i32x4_extend_low_i16x8(lo16));
    const v128_t b = wasm_f32x4_convert_i32x4(wasm_i32x4_extend_high_i16x8(lo16));
    const v128_t c = wasm_f32x4_convert_i32x4(wasm_i32x4_extend_low_i16x8(hi16));
    const v128_t e = wasm_f32x4_convert_i32x4(wasm_i32x4_extend_high_i16x8(hi16));
    acc = wasm_f32x4_add(acc, wasm_f32x4_mul(a, wasm_v128_load(q + d)));
    acc = wasm_f32x4_add(acc, wasm_f32x4_mul(b, wasm_v128_load(q + d + 4)));
    acc = wasm_f32x4_add(acc, wasm_f32x4_mul(c, wasm_v128_load(q + d + 8)));
    acc = wasm_f32x4_add(acc, wasm_f32x4_mul(e, wasm_v128_load(q + d + 12)));
  }
  float sum = wasm_f32x4_extract_lane(acc, 0) + wasm_f32x4_extract_lane(acc, 1) +
              wasm_f32x4_extract_lane(acc, 2) + wasm_f32x4_extract_lane(acc, 3);
  for (; d < dim; ++d) sum += q[d] * static_cast<float>(row[d]);
  return sum;
#else
  float sum = 0.0f;
  for (uint32_t d = 0; d < dim; ++d) sum += q[d] * static_cast<float>(row[d]);
  return sum;
#endif
}

struct Hit {
  float score;
  uint32_t index;
};

/**
 * Top-k over a row range.
 *
 * Ties break on ASCENDING INDEX, never on completion order, so a threaded run
 * and a single-threaded run produce byte-identical output. That is the
 * determinism contract the SDK's threading declaration requires.
 */
static void scan_range(const Catalog& cat, const float* q, const uint8_t* allow,
                       uint32_t from, uint32_t to, uint32_t k, std::vector<Hit>& heap) {
  for (uint32_t i = from; i < to; ++i) {
    if (allow && allow[i] == 0) continue;
    const float raw = row_dot(q, cat.vectors + static_cast<size_t>(i) * cat.dim, cat.dim);
    const Hit h{raw * cat.scale[i], i};
    if (heap.size() < k) {
      heap.push_back(h);
      if (heap.size() == k) {
        std::make_heap(heap.begin(), heap.end(), [](const Hit& a, const Hit& b) {
          return a.score > b.score || (a.score == b.score && a.index < b.index);
        });
      }
    } else {
      const Hit& worst = heap.front();
      if (h.score > worst.score || (h.score == worst.score && h.index < worst.index)) {
        std::pop_heap(heap.begin(), heap.end(), [](const Hit& a, const Hit& b) {
          return a.score > b.score || (a.score == b.score && a.index < b.index);
        });
        heap.back() = h;
        std::push_heap(heap.begin(), heap.end(), [](const Hit& a, const Hit& b) {
          return a.score > b.score || (a.score == b.score && a.index < b.index);
        });
      }
    }
  }
}

static std::vector<Hit> search(const Catalog& cat, const std::vector<float>& q,
                               const uint8_t* allow, uint32_t k) {
  std::vector<Hit> heap;
  heap.reserve(k);
  scan_range(cat, q.data(), allow, 0, cat.count, k, heap);
  std::sort(heap.begin(), heap.end(), [](const Hit& a, const Hit& b) {
    return a.score > b.score || (a.score == b.score && a.index < b.index);
  });
  return heap;
}

// --------------------------------------------------------------- JSON helpers

static std::string json_escape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(c);
        }
    }
  }
  return out;
}

static std::string string_field(const std::string& json, const char* key) {
  const std::string needle = std::string("\"") + key + "\"";
  size_t at = json.find(needle);
  if (at == std::string::npos) return {};
  at = json.find(':', at + needle.size());
  if (at == std::string::npos) return {};
  size_t open = json.find('"', at);
  if (open == std::string::npos) return {};
  std::string out;
  for (size_t i = open + 1; i < json.size(); ++i) {
    if (json[i] == '\\' && i + 1 < json.size()) {
      const char n = json[++i];
      out.push_back(n == 'n' ? '\n' : n == 't' ? '\t' : n);
      continue;
    }
    if (json[i] == '"') break;
    out.push_back(json[i]);
  }
  return out;
}

static long number_field(const std::string& json, const char* key, long fallback) {
  const std::string needle = std::string("\"") + key + "\"";
  size_t at = json.find(needle);
  if (at == std::string::npos) return fallback;
  at = json.find(':', at + needle.size());
  if (at == std::string::npos) return fallback;
  return std::strtol(json.c_str() + at + 1, nullptr, 10);
}

static const plugin_input_frame_t* frame_for(const char* port) {
  const int32_t idx = plugin_find_input_index(port, 0);
  if (idx < 0) return nullptr;
  return plugin_get_input_frame(static_cast<uint32_t>(idx));
}

static int emit(const std::string& body) {
  return plugin_push_output("results", "", "",
                            reinterpret_cast<const uint8_t*>(body.data()),
                            static_cast<uint32_t>(body.size()));
}

static int fail(const char* code, const std::string& message) {
  const std::string body = std::string("{\"OK\":false,\"ERROR_CODE\":\"") + code +
                           "\",\"ERROR_MESSAGE\":\"" + json_escape(message) + "\"}";
  emit(body);
  return 1;
}

}  // namespace sdn_embsearch

/**
 * semantic_search — encode the query text and return the top-k catalog rows.
 *
 * Ports: `encoder` (.sdnemb), `catalog` (.sdnvec), `request` (JSON).
 * Request: { "QUERY_TEXT": "...", "TOP_K": 25, "CANDIDATE_MASK": <optional> }
 */
extern "C" int semantic_search(void) {
  using namespace sdn_embsearch;
  plugin_reset_output_state();

  const plugin_input_frame_t* encFrame = frame_for("encoder");
  const plugin_input_frame_t* catFrame = frame_for("catalog");
  const plugin_input_frame_t* reqFrame = frame_for("request");
  if (!encFrame) return fail("missing-encoder", "Input port \"encoder\" is required.");
  if (!catFrame) return fail("missing-catalog", "Input port \"catalog\" is required.");
  if (!reqFrame) return fail("missing-request", "Input port \"request\" is required.");

  Encoder enc;
  if (!parse_encoder(encFrame->payload, encFrame->payload_length, enc)) {
    return fail("bad-encoder", "Encoder payload is not a valid SDNEMB01 container.");
  }
  Catalog cat;
  if (!parse_catalog(catFrame->payload, catFrame->payload_length, cat)) {
    return fail("bad-catalog", "Catalog payload is not a valid SDNVEC01 container.");
  }
  if (enc.dim != cat.dim) {
    return fail("dimension-mismatch",
                "Encoder dim " + std::to_string(enc.dim) + " does not match catalog dim " +
                  std::to_string(cat.dim) + "; the encoder and the shard are from different builds.");
  }

  const std::string request(reinterpret_cast<const char*>(reqFrame->payload),
                            reqFrame->payload_length);
  const std::string text = string_field(request, "QUERY_TEXT");
  if (text.empty()) return fail("missing-query", "QUERY_TEXT is required and must be non-empty.");
  long k = number_field(request, "TOP_K", 25);
  if (k < 1) k = 1;
  if (static_cast<uint32_t>(k) > cat.count) k = static_cast<long>(cat.count);

  // Optional structured pre-filter from the query planner. One byte per row,
  // supplied by the caller (in production, the FlatSQL WHERE result).
  const plugin_input_frame_t* maskFrame = frame_for("candidates");
  const uint8_t* allow = nullptr;
  if (maskFrame && maskFrame->payload_length == cat.count) allow = maskFrame->payload;

  std::vector<float> q;
  if (!encode(enc, text, q)) {
    return fail("unencodable-query",
                "No token in \"" + text + "\" is present in the encoder's domain vocabulary.");
  }

  const std::vector<Hit> hits = search(cat, q, allow, static_cast<uint32_t>(k));

  std::string body = "{\"OK\":true,\"COUNT\":" + std::to_string(hits.size()) + ",\"RESULTS\":[";
  for (size_t i = 0; i < hits.size(); ++i) {
    if (i) body += ',';
    char buf[96];
    std::snprintf(buf, sizeof(buf), "{\"NORAD_CAT_ID\":%u,\"SCORE\":%.6f}",
                  cat.norads[hits[i].index], static_cast<double>(hits[i].score));
    body += buf;
  }
  body += "]}";
  emit(body);
  return 0;
}
