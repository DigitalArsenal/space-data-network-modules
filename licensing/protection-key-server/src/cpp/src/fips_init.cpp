#include "fips_init.h"

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/provider.h>

#include <mutex>

namespace protection_key_server {
namespace {

std::once_flag g_once;
bool g_active = false;

void do_init() {
  // Providers are statically linked (openssl-cmake no-dso build), so these
  // resolve in-module with no dlopen/filesystem. "base" supplies encoders/
  // serializers; "fips" supplies the approved algorithm implementations and runs
  // its power-on self-tests during load.
  OSSL_PROVIDER* fips = OSSL_PROVIDER_load(nullptr, "fips");
  OSSL_PROVIDER* base = OSSL_PROVIDER_load(nullptr, "base");
  if (fips == nullptr || base == nullptr) {
    if (fips != nullptr) OSSL_PROVIDER_unload(fips);
    if (base != nullptr) OSSL_PROVIDER_unload(base);
    return;
  }

  // Route approved EVP fetches through the FIPS module by default.
  if (EVP_default_properties_enable_fips(nullptr, 1) != 1) {
    return;
  }

  // Self-test passed iff the provider initialized and is available.
  g_active = (OSSL_PROVIDER_available(nullptr, "fips") == 1);
}

}  // namespace

bool fips_provider_init() {
  std::call_once(g_once, do_init);
  return g_active;
}

bool fips_is_active() { return g_active; }

}  // namespace protection_key_server
