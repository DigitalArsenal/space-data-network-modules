#ifndef PROTECTION_LICENSE_CLIENT_API_H
#define PROTECTION_LICENSE_CLIENT_API_H

#include <cstdint>
#include <vector>

int32_t license_client_request_grant(
    const uint8_t* request_bytes,
    uint32_t request_len,
    const uint8_t* requester_signing_key,
    uint32_t requester_signing_key_len,
    std::vector<uint8_t>& response_out);

int32_t license_client_fetch_and_decrypt(
    const uint8_t* grant_response_bytes,
    uint32_t grant_response_len,
    const uint8_t* protected_content,
    uint32_t protected_content_len,
    std::vector<uint8_t>& plaintext_out);

int32_t license_client_fetch_protected_content(
    const uint8_t* descriptor_bytes,
    uint32_t descriptor_len,
    std::vector<uint8_t>& protected_content_out);

int32_t license_client_decrypt(
    const uint8_t* ciphertext,
    uint32_t ciphertext_len,
    const uint8_t* key,
    uint32_t key_len,
    std::vector<uint8_t>& plaintext_out);

int32_t license_client_verify(
    const uint8_t* signed_content,
    uint32_t signed_content_len,
    const uint8_t* public_key,
    uint32_t public_key_len,
    std::vector<uint8_t>& result_json_out);

int32_t license_client_decrypt_and_verify(
    const uint8_t* protected_content,
    uint32_t protected_content_len,
    const uint8_t* dek,
    uint32_t dek_len,
    const uint8_t* signer_key,
    uint32_t signer_key_len,
    std::vector<uint8_t>& plaintext_out);

#endif  // PROTECTION_LICENSE_CLIENT_API_H
