#ifndef LICENSING_GRANT_QUOTA_H
#define LICENSING_GRANT_QUOTA_H

// What one account can take from the key server.
//
// A lease goes to any signed-in account (allowed_xpubs ["*"]), and a script
// that holds one account can sign the lease proof and ask for grants with no
// browser at all. These quotas bound it. They are keyed on the account xpub the
// requester PROVED (the EPM gate: the account key's own proof for the session
// key that answered the challenge), never on anything a requester merely
// asserts, and only granted requests count. State lives in this key server's
// memory and is bounded.

#include <cstddef>
#include <cstdint>
#include <string>

namespace licensing {

// The denial reason ($LGR DENIAL_REASON) of a grant refused by these quotas.
inline constexpr const char* kGrantRateLimitedReason = "rate_limited";

// The limits, sized from the console. An honest session asks for 15-25 modules
// when it opens and for the same modules again on every reload: one request per
// module per load.
//  - One module, one account: 30 in any rolling hour (a reload every two
//    minutes for the whole hour) and 300 in a UTC day (ten such hours).
//  - All modules, one account: 500 in any rolling hour (twenty full loads of 25,
//    a reload every three minutes) and 3000 in a UTC day (120 full loads).
// A person never comes near these. A script holding one account gets at most
// this much, and an account shared among many people or machines reaches the
// daily cap.
inline constexpr uint32_t kGrantsPerModulePerHour = 30;
inline constexpr uint32_t kGrantsPerModulePerUtcDay = 300;
inline constexpr uint32_t kGrantsPerAccountPerHour = 500;
inline constexpr uint32_t kGrantsPerAccountPerUtcDay = 3000;

// Accounts tracked at once. The module's memory is fixed (32 MiB, no growth), so
// the table is bounded: an account holds a 4-byte stamp per grant in its last
// hour (at most 500) and a 24-byte window per module granted to it today, a few
// KiB at most, so a full table stays within about 3 MiB. When it is full, the
// account seen least recently is forgotten. Pushing an account out takes grants
// through this many other accounts after its last request, each of which has a
// full quota of its own.
inline constexpr std::size_t kMaxTrackedAccounts = 512;

// Admit one grant of `module_id` to the proven `account_xpub` at `now_ms`
// (Unix milliseconds) and count it, or return false when the account is at any
// of its limits.
bool AdmitGrant(const std::string& account_xpub, const std::string& module_id, int64_t now_ms);

// Take back an admission made at `now_ms` whose grant was not delivered.
void RefundGrant(const std::string& account_xpub, const std::string& module_id, int64_t now_ms);

}  // namespace licensing

#endif  // LICENSING_GRANT_QUOTA_H
