#ifndef PROTECTION_KEY_SERVER_XPUB_AUTH_H
#define PROTECTION_KEY_SERVER_XPUB_AUTH_H

// secp256k1 / BIP32 xpub identity verification for module-delivery authorization.
//
// A requester proves it controls a key derived from an allowed extended public key
// (xpub). It presents: its xpub, a non-hardened derivation path, the derived
// (compressed) signer public key, and a secp256k1 signature over the challenge.
// The key server then: (1) verifies the signer key derives from the declared xpub
// (BIP32 CKDpub), (2) verifies the signature, (3) checks the xpub against the
// per-module allowlist. secp256k1 is not FIPS-approvable, so this runs on Crypto++.

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace protection_key_server {

constexpr std::size_t kCompressedPubKeyBytes = 33;
constexpr std::size_t kChainCodeBytes = 32;

// Decode a Base58Check BIP32 xpub into its 33-byte compressed public key and
// 32-byte chain code. Returns false on bad alphabet/length/checksum.
bool ParseXpub(const std::string& xpub_base58,
               uint8_t out_pubkey[kCompressedPubKeyBytes],
               uint8_t out_chaincode[kChainCodeBytes]);

// BIP32 non-hardened public child derivation (CKDpub). `index` must be < 2^31
// (hardened derivation from a public key is impossible). Returns false on a
// hardened index or the (negligible) invalid-child case where the caller must skip.
bool DeriveChildPub(const uint8_t parent_pub[kCompressedPubKeyBytes],
                    const uint8_t parent_cc[kChainCodeBytes],
                    uint32_t index,
                    uint8_t out_pub[kCompressedPubKeyBytes],
                    uint8_t out_cc[kChainCodeBytes]);

// Walk `path` (all non-hardened) from `xpub_base58` and write the final derived
// compressed public key to `out_pub33`. Returns false on a bad xpub / hardened
// index / invalid child.
bool DeriveXpubChildPub(const std::string& xpub_base58,
                        const std::vector<uint32_t>& path,
                        uint8_t out_pub33[kCompressedPubKeyBytes]);

// Convenience: true iff the key derived from `xpub_base58` along `path` equals
// `signer_pub33` — i.e. the signer is an address derived from this xpub identity.
bool XpubDerivesSigner(const std::string& xpub_base58,
                       const std::vector<uint32_t>& path,
                       const uint8_t signer_pub33[kCompressedPubKeyBytes]);

// Parse + verify a module-delivery identity block proving the requester controls
// a key derived from an allowed xpub. Wire format (big-endian lengths):
//   [xpub_len:2][xpub ascii][path_len:1][path: path_len * uint32][sig_len:1][sig]
// Verifies: (1) xpub is in `allowed_xpubs` when that list is non-empty, (2) the
// secp256k1 signature `sig` over `bound_msg` is valid under the key derived from
// xpub along path. `bound_msg` should bind the request (e.g. challenge_id followed
// by the client ECDH public key) to prevent replay / recipient substitution.
// On success returns true and sets `out_xpub` to the verified identity.
bool AuthorizeIdentityBlock(const uint8_t* block, std::size_t block_len,
                            const uint8_t* bound_msg, std::size_t bound_len,
                            const std::vector<std::string>& allowed_xpubs,
                            std::string* out_xpub);

// Verify a secp256k1 ECDSA signature over `msg` by the compressed key `pub33`.
// Accepts a 64-byte raw r||s signature or a DER-encoded signature. `msg` is the
// pre-image (hashed internally with SHA-256).
bool VerifySecp256k1(const uint8_t pub33[kCompressedPubKeyBytes],
                     const uint8_t* msg, std::size_t msg_len,
                     const uint8_t* sig, std::size_t sig_len);

}  // namespace protection_key_server

#endif  // PROTECTION_KEY_SERVER_XPUB_AUTH_H
