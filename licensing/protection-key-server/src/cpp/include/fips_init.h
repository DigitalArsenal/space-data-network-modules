#ifndef PROTECTION_KEY_SERVER_FIPS_INIT_H
#define PROTECTION_KEY_SERVER_FIPS_INIT_H

// OpenSSL FIPS provider, compiled into this wasm module (statically linked via the
// no-dso openssl-cmake build) and registered with OSSL_PROVIDER_load. The FIPS
// provider performs the approved data-protection crypto (P-256 ECDH key-wrap,
// AES-256-GCM, SHA-2, HMAC). secp256k1 xpub identity is NOT FIPS-approvable and
// runs on Crypto++ instead. NOTE: a wasm recompile is outside the FIPS 140
// certificate boundary — this is the validated code path, not a certified module.

namespace protection_key_server {

// Loads the statically-linked FIPS + base providers and pins FIPS as the default
// EVP property so approved fetches route through the FIPS module. Idempotent.
// Returns true once the provider is active and its power-on self-test passed.
bool fips_provider_init();

// Whether the FIPS provider is active (self-test passed) after fips_provider_init().
bool fips_is_active();

}  // namespace protection_key_server

#endif  // PROTECTION_KEY_SERVER_FIPS_INIT_H
