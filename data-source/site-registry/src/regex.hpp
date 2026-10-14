// A small backtracking regular-expression engine for the subset of
// ECMAScript patterns the site-registry rules use, matched over UTF-32 text
// with the "iu" flags' semantics: case-insensitive by simple Unicode case
// folding (Latin, Greek, Cyrillic), \p{L} letter classes, lookahead and
// lookbehind, lazy and bounded quantifiers. The rules are written once, as in
// the reviewed JavaScript tools they were ported from, so the module and the
// tools read the same patterns.
//
// Supported: literals, ., [...] (ranges, negation, escapes), \d \D \s \S \w \W
// \b \B \p{L} \P{L}, ^ $ (whole input), ( ) (?: ) (?= ) (?! ) (?<= ) (?<! ),
// |, * + ? {n} {n,} {n,m} and their lazy forms. No backreferences.
#pragma once
#include <cstdint>
#include <algorithm>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace rx {

using Text = std::u32string;

inline Text utf32(std::string_view s) {
  Text out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size();) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    uint32_t cp = c;
    size_t n = 1;
    if (c >= 0xF0 && i + 3 < s.size() + 0) { cp = (c & 0x07u) << 18 | (uint32_t(s[i + 1]) & 0x3Fu) << 12 | (uint32_t(s[i + 2]) & 0x3Fu) << 6 | (uint32_t(s[i + 3]) & 0x3Fu); n = 4; }
    else if (c >= 0xE0 && i + 2 < s.size()) { cp = (c & 0x0Fu) << 12 | (uint32_t(s[i + 1]) & 0x3Fu) << 6 | (uint32_t(s[i + 2]) & 0x3Fu); n = 3; }
    else if (c >= 0xC0 && i + 1 < s.size()) { cp = (c & 0x1Fu) << 6 | (uint32_t(s[i + 1]) & 0x3Fu); n = 2; }
    if (i + n > s.size()) { cp = 0xFFFD; n = 1; }
    out.push_back(cp);
    i += n;
  }
  return out;
}

inline void appendUtf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) out += char(cp);
  else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
  else if (cp < 0x10000) { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
  else { out += char(0xF0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3F)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
}

inline std::string utf8(const Text& t, size_t from = 0, size_t to = std::u32string::npos) {
  std::string out;
  if (to > t.size()) to = t.size();
  for (size_t i = from; i < to; ++i) appendUtf8(out, t[i]);
  return out;
}

// Simple case folding to lower case for the scripts the sources use.
inline uint32_t fold(uint32_t c) {
  if (c < 0x80) return (c >= 'A' && c <= 'Z') ? c + 32 : c;
  if (c >= 0xC0 && c <= 0xDE && c != 0xD7) return c + 32;
  if (c >= 0x100 && c <= 0x17F) {
    if (c == 0x130) return 'i';
    if (c == 0x178) return 0xFF;
    if (c == 0x17F) return 's';
    if ((c >= 0x139 && c <= 0x148) || (c >= 0x179 && c <= 0x17E)) return (c & 1) ? c + 1 : c;
    if (c == 0x131 || c == 0x138 || c == 0x149) return c;
    return (c & 1) ? c : c + 1;
  }
  if (c >= 0x180 && c <= 0x24F) {
    // Latin Extended-B: the pairs the sources' languages use.
    if ((c >= 0x1CD && c <= 0x1DC) || (c >= 0x1F8 && c <= 0x21F) || (c >= 0x222 && c <= 0x233) || (c >= 0x246 && c <= 0x24F)) {
      const bool oddLower = (c >= 0x1CD && c <= 0x1DC);
      return oddLower ? ((c & 1) ? c + 1 : c) : ((c & 1) ? c : c + 1);
    }
    return c;
  }
  if (c >= 0x391 && c <= 0x3AB && c != 0x3A2) return c + 32;
  if (c >= 0x388 && c <= 0x38A) return c + 37;
  if (c == 0x386) return 0x3AC;
  if (c == 0x38C) return 0x3CC;
  if (c == 0x38E || c == 0x38F) return c + 63;
  if (c == 0x3C2) return 0x3C3;
  if (c >= 0x410 && c <= 0x42F) return c + 32;
  if (c >= 0x400 && c <= 0x40F) return c + 80;
  if (c >= 0x460 && c <= 0x4FF) {
    if ((c >= 0x460 && c <= 0x481) || (c >= 0x48A && c <= 0x4BF) || (c >= 0x4D0 && c <= 0x4FF)) return (c & 1) ? c : c + 1;
    if (c >= 0x4C1 && c <= 0x4CE) return (c & 1) ? c + 1 : c;
    return c;
  }
  if (c >= 0x500 && c <= 0x52F) return (c & 1) ? c : c + 1;
  if (c >= 0x1E00 && c <= 0x1EFF) {
    if (c == 0x1E9E) return 0xDF;
    if (c >= 0x1E96 && c <= 0x1E9F) return c;
    return (c & 1) ? c : c + 1;
  }
  if (c >= 0xFF21 && c <= 0xFF3A) return c + 32;
  return c;
}

inline bool isLetter(uint32_t c) {
  if (c < 0x80) return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  if (c == 0xAA || c == 0xB5 || c == 0xBA) return true;
  if (c >= 0xC0 && c <= 0x24F) return c != 0xD7 && c != 0xF7;
  if (c >= 0x250 && c <= 0x2C1) return true;
  if (c >= 0x2C6 && c <= 0x2D1) return true;
  if (c >= 0x2E0 && c <= 0x2E4) return true;
  if (c >= 0x370 && c <= 0x3FF) return c != 0x375 && c != 0x37E && c != 0x384 && c != 0x385 && c != 0x387 && c != 0x3F6;
  if (c >= 0x400 && c <= 0x52F) return !(c >= 0x482 && c <= 0x489);
  if (c >= 0x531 && c <= 0x587) return !(c >= 0x557 && c <= 0x560);
  if (c >= 0x5D0 && c <= 0x5F2) return true;
  if (c >= 0x620 && c <= 0x64A) return true;
  if (c >= 0x671 && c <= 0x6D3) return true;
  if (c >= 0x904 && c <= 0x939) return true;
  if (c >= 0xE01 && c <= 0xE30) return true;
  if (c >= 0x10A0 && c <= 0x10FF) return true;
  if (c >= 0x1E00 && c <= 0x1FFF) return true;
  if (c >= 0x3041 && c <= 0x3096) return true;
  if (c >= 0x309D && c <= 0x309F) return true;
  if (c >= 0x30A1 && c <= 0x30FA) return true;
  if (c >= 0x30FC && c <= 0x30FF) return true;
  if (c >= 0x3105 && c <= 0x312F) return true;
  if (c >= 0x3400 && c <= 0x4DBF) return true;
  if (c >= 0x4E00 && c <= 0x9FFF) return true;
  if (c >= 0xAC00 && c <= 0xD7A3) return true;
  if (c >= 0xF900 && c <= 0xFAFF) return true;
  if (c >= 0xFF21 && c <= 0xFF3A) return true;
  if (c >= 0xFF41 && c <= 0xFF5A) return true;
  if (c >= 0xFF66 && c <= 0xFFDC) return true;
  if (c >= 0x20000 && c <= 0x2FA1F) return true;
  return false;
}

inline bool isSpace(uint32_t c) {
  return c == ' ' || (c >= 0x09 && c <= 0x0D) || c == 0xA0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 ||
         c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
}
inline bool isDigit(uint32_t c) { return c >= '0' && c <= '9'; }
inline bool isWord(uint32_t c) { return (c < 0x80) && (isDigit(c) || c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')); }
inline bool isLineTerminator(uint32_t c) { return c == '\n' || c == '\r' || c == 0x2028 || c == 0x2029; }

class Regex {
 public:
  struct Match { bool ok = false; size_t begin = 0, end = 0; };

  Regex() = default;
  Regex(std::string_view pattern, bool icase = true) { compile(pattern, icase); }

  bool valid() const { return root_ != nullptr && error_.empty(); }
  const std::string& error() const { return error_; }

  // The first match at or after `from`.
  Match search(const Text& t, size_t from = 0) const {
    Match m;
    if (!root_) return m;
    for (size_t s = from; s <= t.size(); ++s) {
      if (firstLiteral_ && s < t.size()) {
        // Skip ahead to a possible first character.
        bool any = false;
        for (; s < t.size(); ++s) if (canStart(t[s])) { any = true; break; }
        if (!any) { if (!nullable_) return m; s = t.size(); }
      }
      size_t end = 0;
      if (run(t, s, end)) { m.ok = true; m.begin = s; m.end = end; return m; }
      if (anchoredStart_) break;
    }
    return m;
  }
  bool test(const Text& t) const { return search(t).ok; }
  // Every non-overlapping match, left to right (JavaScript matchAll with "g").
  std::vector<Match> all(const Text& t) const {
    std::vector<Match> out;
    size_t from = 0;
    while (from <= t.size()) {
      Match m = search(t, from);
      if (!m.ok) break;
      out.push_back(m);
      from = m.end > m.begin ? m.end : m.end + 1;
    }
    return out;
  }
  // Groups of the last successful search() call made through capture().
  Match capture(const Text& t, std::vector<std::pair<size_t, size_t>>& groups, size_t from = 0) const {
    Match m = search(t, from);
    groups.assign(groupCount_ + 1, {SIZE_MAX, SIZE_MAX});
    if (!m.ok) return m;
    // Re-run at the match start to record groups (the capture target is per thread:
    // the stages match the same patterns on several workers at once).
    caps_ = &groups;
    size_t end = 0;
    run(t, m.begin, end);
    caps_ = nullptr;
    groups[0] = {m.begin, m.end};
    return m;
  }

 private:
  enum Kind : uint8_t { CHAR, ANY, CLASS, BOL, EOL, WB, NWB, GROUP, REPEAT, LOOK, EMPTY };
  struct Range { uint32_t lo, hi; };
  struct Node {
    Kind kind = EMPTY;
    uint32_t ch = 0;
    // CLASS
    std::vector<Range> ranges;
    uint8_t classFlags = 0;  // 1 digit, 2 space, 4 word, 8 letter, 16 !digit, 32 !space, 64 !word, 128 !letter
    bool negate = false;
    // GROUP / LOOK: alternatives, each a sequence
    std::vector<std::vector<Node*>> alts;
    int capture = -1;
    // REPEAT
    Node* child = nullptr;
    int min = 0, max = -1;
    bool lazy = false;
    // LOOK
    bool behind = false, negative = false;
    int minLen = 0, maxLen = -1;
  };

  std::vector<std::unique_ptr<Node>> pool_;
  Node* root_ = nullptr;
  std::string error_;
  bool icase_ = true;
  int groupCount_ = 0;
  bool anchoredStart_ = false;
  bool firstLiteral_ = false;
  bool nullable_ = true;
  std::vector<uint32_t> starts_;
  static inline thread_local std::vector<std::pair<size_t, size_t>>* caps_ = nullptr;

  Node* make(Kind k) { pool_.push_back(std::make_unique<Node>()); pool_.back()->kind = k; return pool_.back().get(); }

  // ── parser ──────────────────────────────────────────────────────────────
  struct Parser {
    Regex& re;
    Text p;
    size_t i = 0;
    bool fail(const char* msg) { if (re.error_.empty()) re.error_ = msg; return false; }
    bool eof() const { return i >= p.size(); }
    uint32_t peek(size_t k = 0) const { return i + k < p.size() ? p[i + k] : 0; }

    Node* alternation(int capture) {
      Node* g = re.make(GROUP);
      g->capture = capture;
      g->alts.emplace_back();
      while (!eof() && peek() != ')') {
        if (peek() == '|') { ++i; g->alts.emplace_back(); continue; }
        Node* atom = term();
        if (!atom) return nullptr;
        g->alts.back().push_back(atom);
      }
      return g;
    }

    bool number(int& out) {
      size_t s = i;
      out = 0;
      while (!eof() && isDigit(peek())) { out = out * 10 + int(peek() - '0'); ++i; }
      return i > s;
    }

    Node* term() {
      Node* atom = this->atom();
      if (!atom) return nullptr;
      for (;;) {
        int mn, mx;
        if (peek() == '*') { mn = 0; mx = -1; ++i; }
        else if (peek() == '+') { mn = 1; mx = -1; ++i; }
        else if (peek() == '?') { mn = 0; mx = 1; ++i; }
        else if (peek() == '{' && isDigit(peek(1))) {
          size_t save = i;
          ++i;
          number(mn);
          mx = mn;
          if (peek() == ',') { ++i; if (!number(mx)) mx = -1; }
          if (peek() != '}') { i = save; return atom; }
          ++i;
        } else return atom;
        Node* r = re.make(REPEAT);
        r->child = atom;
        r->min = mn;
        r->max = mx;
        if (peek() == '?') { r->lazy = true; ++i; }
        atom = r;
      }
    }

    bool classEscape(Node* n, uint32_t e) {
      switch (e) {
        case 'd': n->classFlags |= 1; return true;
        case 's': n->classFlags |= 2; return true;
        case 'w': n->classFlags |= 4; return true;
        case 'D': n->classFlags |= 16; return true;
        case 'S': n->classFlags |= 32; return true;
        case 'W': n->classFlags |= 64; return true;
        default: return false;
      }
    }
    bool property(Node* n, bool negated) {
      // \p{L} or \P{L}
      if (peek() != '{') return fail("Expected { after \\p");
      size_t close = i;
      while (close < p.size() && p[close] != '}') ++close;
      if (close >= p.size()) return fail("Unclosed \\p{}");
      Text name(p.begin() + long(i + 1), p.begin() + long(close));
      i = close + 1;
      if (name != U"L" && name != U"Letter") return fail("Only \\p{L} is supported");
      n->classFlags |= negated ? 128 : 8;
      return true;
    }
    uint32_t escapeChar(uint32_t e) {
      switch (e) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case 'f': return '\f';
        case 'v': return '\v';
        case '0': return 0;
        default: return e;
      }
    }
    uint32_t unicodeEscape() {
      // after \u
      uint32_t v = 0;
      if (peek() == '{') {
        ++i;
        while (!eof() && peek() != '}') { v = v * 16 + hex(peek()); ++i; }
        ++i;
        return v;
      }
      for (int k = 0; k < 4 && !eof(); ++k) { v = v * 16 + hex(peek()); ++i; }
      return v;
    }
    static uint32_t hex(uint32_t c) { return isDigit(c) ? c - '0' : (fold(c) - 'a' + 10) & 15; }

    Node* charClass() {
      Node* n = re.make(CLASS);
      if (peek() == '^') { n->negate = true; ++i; }
      bool first = true;
      while (!eof() && (peek() != ']' || first)) {
        first = false;
        uint32_t lo;
        if (peek() == '\\') {
          ++i;
          uint32_t e = peek();
          ++i;
          if (classEscape(n, e)) continue;
          if (e == 'p' || e == 'P') { if (!property(n, e == 'P')) return nullptr; continue; }
          if (e == 'u') lo = unicodeEscape();
          else lo = escapeChar(e);
        } else {
          lo = peek();
          ++i;
        }
        uint32_t hi = lo;
        if (peek() == '-' && peek(1) != ']' && i + 1 < p.size()) {
          ++i;
          if (peek() == '\\') {
            ++i;
            uint32_t e = peek();
            ++i;
            hi = e == 'u' ? unicodeEscape() : escapeChar(e);
          } else { hi = peek(); ++i; }
        }
        n->ranges.push_back({lo, hi});
      }
      if (peek() != ']') { fail("Unclosed character class"); return nullptr; }
      ++i;
      return n;
    }

    Node* atom() {
      const uint32_t c = peek();
      if (c == '(') {
        ++i;
        if (peek() == '?') {
          ++i;
          Node* look = nullptr;
          if (peek() == ':') { ++i; Node* g = alternation(-1); if (!g || peek() != ')') { fail("Unclosed group"); return nullptr; } ++i; return g; }
          if (peek() == '=' || peek() == '!') { look = re.make(LOOK); look->negative = peek() == '!'; ++i; }
          else if (peek() == '<' && (peek(1) == '=' || peek(1) == '!')) { look = re.make(LOOK); look->behind = true; look->negative = peek(1) == '!'; i += 2; }
          else { fail("Unsupported group"); return nullptr; }
          Node* body = alternation(-1);
          if (!body || peek() != ')') { fail("Unclosed lookaround"); return nullptr; }
          ++i;
          look->alts = body->alts;
          return look;
        }
        const int index = ++re.groupCount_;
        Node* g = alternation(index);
        if (!g || peek() != ')') { fail("Unclosed group"); return nullptr; }
        ++i;
        return g;
      }
      if (c == '[') { ++i; return charClass(); }
      if (c == '.') { ++i; return re.make(ANY); }
      if (c == '^') { ++i; return re.make(BOL); }
      if (c == '$') { ++i; return re.make(EOL); }
      if (c == '\\') {
        ++i;
        const uint32_t e = peek();
        ++i;
        if (e == 'b') return re.make(WB);
        if (e == 'B') return re.make(NWB);
        Node* n = re.make(CLASS);
        if (classEscape(n, e)) return n;
        if (e == 'p' || e == 'P') { if (!property(n, e == 'P')) return nullptr; return n; }
        Node* ch = re.make(CHAR);
        ch->ch = e == 'u' ? unicodeEscape() : escapeChar(e);
        return ch;
      }
      if (c == '*' || c == '+' || c == '?' || c == ')') { fail("Nothing to repeat"); return nullptr; }
      Node* ch = re.make(CHAR);
      ch->ch = c;
      ++i;
      return ch;
    }
  };

  void compile(std::string_view pattern, bool icase) {
    icase_ = icase;
    Parser parser{*this, utf32(pattern)};
    root_ = parser.alternation(0);
    if (root_ && !parser.eof()) { error_ = "Unbalanced parenthesis"; root_ = nullptr; }
    if (!root_) return;
    for (auto& node : pool_) if (node->kind == LOOK) lengths(node.get());
    for (auto& node : pool_) if (node->kind == CHAR && icase_) node->ch = fold(node->ch);
    analyseStart();
  }

  // Minimum and maximum length of a lookbehind body.
  void seqLen(const std::vector<Node*>& seq, int& mn, int& mx) {
    mn = 0; mx = 0;
    for (Node* n : seq) {
      int a, b;
      nodeLen(n, a, b);
      mn += a;
      mx = (mx < 0 || b < 0) ? -1 : mx + b;
    }
  }
  void nodeLen(Node* n, int& mn, int& mx) {
    switch (n->kind) {
      case CHAR: case ANY: case CLASS: mn = mx = 1; return;
      case BOL: case EOL: case WB: case NWB: case LOOK: case EMPTY: mn = mx = 0; return;
      case GROUP: {
        mn = -1; mx = 0;
        for (auto& alt : n->alts) {
          int a, b;
          seqLen(alt, a, b);
          mn = mn < 0 ? a : std::min(mn, a);
          mx = (mx < 0 || b < 0) ? -1 : std::max(mx, b);
        }
        if (mn < 0) mn = 0;
        return;
      }
      case REPEAT: {
        int a, b;
        nodeLen(n->child, a, b);
        mn = a * n->min;
        mx = (n->max < 0 || b < 0) ? -1 : b * n->max;
        return;
      }
    }
  }
  void lengths(Node* look) {
    int mn = -1, mx = 0;
    for (auto& alt : look->alts) {
      int a, b;
      seqLen(alt, a, b);
      mn = mn < 0 ? a : std::min(mn, a);
      mx = (mx < 0 || b < 0) ? -1 : std::max(mx, b);
    }
    look->minLen = mn < 0 ? 0 : mn;
    look->maxLen = mx;
  }

  // The characters a match can start with, when they are few (a literal word or
  // a group of them, behind any zero-width assertion): the scan skips to them.
  // Returns false when a match may start with anything (or be empty).
  bool firstOfSeq(const std::vector<Node*>& seq, size_t from, std::vector<uint32_t>& out, int depth) {
    for (size_t k = from; k < seq.size(); ++k) {
      Node* n = seq[k];
      switch (n->kind) {
        case LOOK: case WB: case NWB: continue;  // zero-width: the next node decides
        case CHAR: out.push_back(n->ch); return true;
        case GROUP: {
          if (depth > 8) return false;
          for (auto& alt : n->alts) if (!firstOfSeq(alt, 0, out, depth + 1)) return false;
          return true;
        }
        case REPEAT: {
          if (n->min < 1 || depth > 8) return false;
          std::vector<Node*> one{n->child};
          return firstOfSeq(one, 0, out, depth + 1);
        }
        default: return false;
      }
    }
    return false;  // nullable
  }
  void analyseStart() {
    anchoredStart_ = root_->alts.size() == 1 && !root_->alts[0].empty() && root_->alts[0][0]->kind == BOL;
    nullable_ = false;
    std::vector<uint32_t> set;
    firstLiteral_ = !anchoredStart_;
    if (firstLiteral_) for (auto& alt : root_->alts) if (!firstOfSeq(alt, 0, set, 0)) { firstLiteral_ = false; break; }
    if (firstLiteral_) {
      std::sort(set.begin(), set.end());
      set.erase(std::unique(set.begin(), set.end()), set.end());
      starts_ = set;
    } else starts_.clear();
  }
  bool canStart(uint32_t c) const {
    const uint32_t f = icase_ ? fold(c) : c;
    return std::binary_search(starts_.begin(), starts_.end(), f);
  }

  bool classMatch(const Node* n, uint32_t c) const {
    bool hit = false;
    const uint32_t f = icase_ ? fold(c) : c;
    for (const auto& r : n->ranges) {
      if (c >= r.lo && c <= r.hi) { hit = true; break; }
      if (icase_) {
        if (r.lo == r.hi) { if (fold(r.lo) == f) { hit = true; break; } }
        else if (f >= r.lo && f <= r.hi) { hit = true; break; }
        else {
          // An upper-case letter against a lower-case range ("[a-z]" with i).
          for (uint32_t k = r.lo; k <= r.hi && k - r.lo < 512; ++k) if (fold(k) == f) { hit = true; break; }
          if (hit) break;
        }
      }
    }
    if (!hit && n->classFlags) {
      const uint8_t m = n->classFlags;
      if (((m & 1) && isDigit(c)) || ((m & 2) && isSpace(c)) || ((m & 4) && isWord(c)) || ((m & 8) && isLetter(c)) ||
          ((m & 16) && !isDigit(c)) || ((m & 32) && !isSpace(c)) || ((m & 64) && !isWord(c)) || ((m & 128) && !isLetter(c)))
        hit = true;
    }
    return hit != n->negate;
  }
  bool single(const Node* n, uint32_t c) const {
    switch (n->kind) {
      case CHAR: return (icase_ ? fold(c) : c) == n->ch;
      case ANY: return !isLineTerminator(c);
      case CLASS: return classMatch(n, c);
      default: return false;
    }
  }
  static bool isSingle(const Node* n) { return n->kind == CHAR || n->kind == ANY || n->kind == CLASS; }

  // ── matcher (continuation passing over sequences) ─────────────────────────
  struct Cont {
    const std::vector<Node*>* seq;
    size_t index;
    const Cont* next;
    // repeat bookkeeping
    const Node* repeat = nullptr;
    int count = 0;
    size_t start = 0;
    // group capture bookkeeping
    int capture = -1;
    size_t capStart = 0;
    // lookbehind end check
    bool endCheck = false;
    size_t endAt = 0;
  };

  bool run(const Text& t, size_t s, size_t& end) const {
    size_t e = 0;
    Cont done{nullptr, 0, nullptr};
    done.endCheck = false;
    bool ok = matchGroup(root_, t, s, &done, &e);
    if (ok) end = e;
    return ok;
  }

  bool matchGroup(const Node* g, const Text& t, size_t i, const Cont* k, size_t* end) const {
    for (const auto& alt : g->alts) {
      Cont c{&alt, 0, k};
      if (g->capture > 0 && caps_) { c.capture = g->capture; c.capStart = i; }
      if (seq(t, i, &c, end)) return true;
    }
    return false;
  }

  // Continue with continuation k at position i.
  bool cont(const Text& t, size_t i, const Cont* k, size_t* end) const {
    if (!k) return true;
    if (k->seq == nullptr) {
      if (k->endCheck) return i == k->endAt;
      *end = i;
      return true;
    }
    return seq(t, i, k, end);
  }

  bool seq(const Text& t, size_t i, const Cont* k, size_t* end) const {
    const auto& nodes = *k->seq;
    size_t idx = k->index;
    // Run single-character nodes iteratively.
    while (idx < nodes.size() && isSingle(nodes[idx])) {
      if (i >= t.size() || !single(nodes[idx], t[i])) return false;
      ++i;
      ++idx;
    }
    if (idx >= nodes.size()) {
      if (k->repeat) return repeatNext(t, i, k, end);
      if (k->capture > 0 && caps_) {
        auto saved = (*caps_)[size_t(k->capture)];
        (*caps_)[size_t(k->capture)] = {k->capStart, i};
        if (cont(t, i, k->next, end)) return true;
        (*caps_)[size_t(k->capture)] = saved;
        return false;
      }
      return cont(t, i, k->next, end);
    }
    const Node* n = nodes[idx];
    Cont rest = *k;
    rest.index = idx + 1;
    switch (n->kind) {
      case BOL: return i == 0 && seq(t, i, &rest, end);
      case EOL: return i == t.size() && seq(t, i, &rest, end);
      case WB: case NWB: {
        const bool a = i > 0 && isWord(t[i - 1]);
        const bool b = i < t.size() && isWord(t[i]);
        return ((a != b) == (n->kind == WB)) && seq(t, i, &rest, end);
      }
      case GROUP: return matchGroup(n, t, i, &rest, end);
      case LOOK: {
        bool hit = false;
        if (!n->behind) {
          for (const auto& alt : n->alts) {
            Cont body{&alt, 0, nullptr};
            Cont stop{nullptr, 0, nullptr};
            body.next = &stop;
            size_t e2 = 0;
            if (seq(t, i, &body, &e2)) { hit = true; break; }
          }
        } else {
          const size_t lo = n->maxLen < 0 ? 0 : (i >= size_t(n->maxLen) ? i - size_t(n->maxLen) : 0);
          const size_t hiStart = i >= size_t(n->minLen) ? i - size_t(n->minLen) : SIZE_MAX;
          if (hiStart != SIZE_MAX) {
            for (size_t j = hiStart + 1; j-- > lo && !hit;) {
              for (const auto& alt : n->alts) {
                Cont stop{nullptr, 0, nullptr};
                stop.endCheck = true;
                stop.endAt = i;
                Cont body{&alt, 0, &stop};
                size_t e2 = 0;
                if (seq(t, j, &body, &e2)) { hit = true; break; }
              }
              if (j == 0) break;
            }
          }
        }
        if (hit == n->negative) return false;
        return seq(t, i, &rest, end);
      }
      case REPEAT: {
        if (isSingle(n->child)) {
          // Greedy or lazy run of one-character matches, without recursion per character.
          const size_t limit = n->max < 0 ? t.size() - i : std::min<size_t>(size_t(n->max), t.size() - i);
          if (n->lazy) {
            // Extend one character at a time: never scan past the first place the rest matches.
            size_t c = 0;
            for (; c < size_t(n->min); ++c) if (c >= limit || !single(n->child, t[i + c])) return false;
            for (;; ++c) {
              if (seq(t, i + c, &rest, end)) return true;
              if (c >= limit || !single(n->child, t[i + c])) return false;
            }
          }
          size_t run = 0;
          while (run < limit && single(n->child, t[i + run])) ++run;
          if (run < size_t(n->min)) return false;
          {
            for (size_t c = run + 1; c-- > size_t(n->min);) { if (seq(t, i + c, &rest, end)) return true; if (c == 0) break; }
          }
          return false;
        }
        Cont loop{nullptr, 0, &rest};
        loop.repeat = n;
        loop.count = 0;
        loop.start = i;
        return repeatNext(t, i, &loop, end);
      }
      default: return false;
    }
  }

  // At a repeat boundary: k->repeat has matched k->count times, the last starting at k->start.
  bool repeatNext(const Text& t, size_t i, const Cont* k, size_t* end) const {
    const Node* n = k->repeat;
    int count = k->count;
    // A finished iteration (k->seq set) increments the count.
    if (k->seq != nullptr) {
      ++count;
      if (i == k->start && count > n->min) return false;  // an empty iteration ends the loop
    }
    const Cont* after = k->next;
    auto tryMore = [&]() -> bool {
      if (n->max >= 0 && count >= n->max) return false;
      std::vector<Node*> one{n->child};
      Cont body{&one, 0, after};
      body.repeat = n;
      body.count = count;
      body.start = i;
      return seq(t, i, &body, end);
    };
    auto tryStop = [&]() -> bool { return count >= n->min && cont(t, i, after, end); };
    if (n->lazy) return tryStop() || tryMore();
    return tryMore() || tryStop();
  }
};

}  // namespace rx
