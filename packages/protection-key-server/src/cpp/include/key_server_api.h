#ifndef KEY_SERVER_API_H
#define KEY_SERVER_API_H

/**
 * C API for the protection key server core.
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

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialize the key server with a JSON configuration.
 * JSON fields: privateKeyHex, generateRandomKey, maxClockSkewMs, activeKeyVersion
 * Returns 0 on success.
 */
int32_t key_server_configure_runtime(
    const uint8_t *config_json, uint32_t config_len,
    std::vector<uint8_t> &status_out);

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

#ifdef __cplusplus
}
#endif

#endif  // KEY_SERVER_API_H
