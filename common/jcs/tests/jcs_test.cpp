// RFC 8785 JCS canonicalizer tests. UTF-8 byte sequences are written explicitly
// (\xNN) so the expected canonical bytes are unambiguous.
#include "jcs.h"

#include <cstdio>
#include <string>

using namespace sdn::jcs;

static int g_fail = 0;

static void Check(const char* name, const std::string& in, const std::string& expect) {
  std::string out;
  const bool ok = CanonicalizeJson(in, &out);
  if (ok && out == expect) {
    std::printf("  ok    %s\n", name);
  } else {
    std::printf("  FAIL  %s\n    in:  %s\n    got: %s\n    exp: %s\n", name, in.c_str(),
                ok ? out.c_str() : "(parse error)", expect.c_str());
    ++g_fail;
  }
}

int main() {
  std::printf("JCS (RFC 8785):\n");

  Check("sort top-level keys", "{\"b\":1,\"a\":2}", "{\"a\":2,\"b\":1}");
  Check("sort nested keys", "{\"z\":{\"b\":1,\"a\":2},\"a\":3}",
        "{\"a\":3,\"z\":{\"a\":2,\"b\":1}}");

  // a " b \ c <LF> <TAB> <0x01>  -> minimal ECMAScript escaping
  Check("string escaping (control/quote/backslash)",
        "{\"k\":\"a\\\"b\\\\c\\n\\t\\u0001\"}",
        "{\"k\":\"a\\\"b\\\\c\\n\\t\\u0001\"}");

  Check("no HTML escaping of & < >", "{\"k\":\"x&y<z>w\"}", "{\"k\":\"x&y<z>w\"}");

  // é decodes to U+00E9 and is emitted as raw UTF-8 (0xC3 0xA9).
  Check("unicode escape -> raw UTF-8", "{\"k\":\"\\u00e9\"}", "{\"k\":\"\xC3\xA9\"}");
  Check("raw UTF-8 passthrough", "{\"k\":\"\xC3\xA9\"}", "{\"k\":\"\xC3\xA9\"}");

  Check("array order preserved", "[3,1,2]", "[3,1,2]");
  Check("whitespace insensitive", "{  \"a\" : 1 , \"b\" : true }", "{\"a\":1,\"b\":true}");
  Check("literals sort/format", "{\"n\":null,\"t\":true,\"f\":false,\"i\":-42}",
        "{\"f\":false,\"i\":-42,\"n\":null,\"t\":true}");

  // UTF-16 code-unit key ordering: 1(31) < a(61) < z(7A) < é(E9) < €(20AC) < 😀(D83D…).
  Check("UTF-16 key order incl surrogate",
        "{\"\xF0\x9F\x98\x80\":1,\"\xE2\x82\xAC\":2,\"\xC3\xA9\":3,\"z\":4,\"a\":5,\"1\":6}",
        "{\"1\":6,\"a\":5,\"z\":4,\"\xC3\xA9\":3,\"\xE2\x82\xAC\":2,\"\xF0\x9F\x98\x80\":1}");

  std::printf(g_fail == 0 ? "\nALL PASS\n" : "\n%d FAILURE(S)\n", g_fail);
  return g_fail == 0 ? 0 : 1;
}
