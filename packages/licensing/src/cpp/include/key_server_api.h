#ifndef KEY_SERVER_API_H
#define KEY_SERVER_API_H

/**
 * C API for the unified licensing server core.
 *
 * These functions implement the key broker protocol:
 * - ECDH P-256 key agreement
 * - Challenge-response authentication
 * - DEK distribution
 *
 * Each function takes raw input bytes and writes output to a vector.
 * The caller (plugin entry points) handles SDK frame plumbing.
 */

#include <cstdint>
#include <vector>

/**
 * Initialize the key server with a JSON configuration.
 * JSON fields: privateKeyHex, generateRandomKey, maxClockSkewMs, activeKeyVersion
 * Returns 0 on success.
 */
int32_t key_server_configure_runtime(
    const uint8_t *config_json, uint32_t config_len,
    std::vector<uint8_t> &status_out);

/**
 * Publish an encrypted module artifact and bind its content key to moduleId+version.
 * Inputs:
 * - descriptor_bytes: SDS PLG descriptor for the protected module publication
 * - protected_content: encrypted module delivery bytes
 * - content_key: raw 32-byte module content key
 * Output:
 * - updated PLG descriptor with CID/hash/size delivery metadata
 */
int32_t key_server_publish_module(
    const uint8_t *descriptor_bytes, uint32_t descriptor_len,
    const uint8_t *protected_content, uint32_t protected_content_len,
    const uint8_t *content_key, uint32_t content_key_len,
    std::vector<uint8_t> &response_out);

/**
 * Get the server's P-256 public key and runtime state as JSON.
 * Returns 0 on success, non-zero if not initialized.
 */
int32_t key_server_get_public_key(std::vector<uint8_t> &response_out);

/**
 * Generate a random challenge for client proof-of-possession.
 * Input: optional JSON with client info.
 * Output: JSON with challenge_id, challenge_token, expires_at.
 */
int32_t key_server_request_challenge(
    const uint8_t *request, uint32_t request_len,
    std::vector<uint8_t> &response_out);

/**
 * Handle a key broker request (protocol v3 packet).
 * Input: binary packet from client.
 * Output: binary response packet.
 */
int32_t key_server_handle_key_request(
    const uint8_t *request, uint32_t request_len,
    std::vector<uint8_t> &response_out);

/**
 * Periodic check for key rotation.
 * Returns 0 on success.
 */
int32_t key_server_check_key_rotation(std::vector<uint8_t> &status_out);

#endif  // KEY_SERVER_API_H
