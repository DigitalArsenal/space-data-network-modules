#ifndef KEY_SERVER_API_H
#define KEY_SERVER_API_H

/**
 * C API for the unified licensing server core.
 *
 * The canonical public transport is a single SDS-backed module-delivery
 * protocol handled by `key_server_handle_message`.
 *
 * Each function takes raw input bytes and writes output to a vector.
 * The caller (plugin entry points) handles SDK frame plumbing.
 */

#include <cstdint>
#include <vector>

#include "KMF_generated.h"

/**
 * Initialize the key server with a runtime configuration payload.
 * Returns 0 on success.
 */
int32_t key_server_configure_runtime(
    const uint8_t *config_bytes, uint32_t config_len,
    std::vector<uint8_t> &status_out);

/**
 * Publish an encrypted module artifact and bind its content key to moduleId+version.
 * Inputs:
 * - descriptor_bytes: SDS PLG descriptor for the protected module publication
 * - protected_content: encrypted module delivery bytes
 * - content_key: raw 32-byte module decrypt key
 * - content_key_role / content_key_algorithm: the SDS key-material semantics
 *   for the supplied 32-byte key
 * Output:
 * - updated PLG descriptor with CID/hash/size delivery metadata
 */
int32_t key_server_publish_module(
    const uint8_t *descriptor_bytes, uint32_t descriptor_len,
    const uint8_t *protected_content, uint32_t protected_content_len,
    const uint8_t *content_key, uint32_t content_key_len,
    keyMaterialRole content_key_role,
    keyMaterialAlgorithm content_key_algorithm,
    std::vector<uint8_t> &response_out);

/**
 * Handle a single canonical SDS module-delivery message.
 * Supported inputs:
 * - LCH request: emit LCH response/error
 * - LPF proof: emit LGR grant/denial
 */
int32_t key_server_handle_message(
    const uint8_t *request, uint32_t request_len,
    std::vector<uint8_t> &response_out);

/**
 * Periodic check for key rotation.
 * Returns 0 on success.
 */
int32_t key_server_check_key_rotation(std::vector<uint8_t> &status_out);

#endif  // KEY_SERVER_API_H
