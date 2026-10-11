#include "grant_quota.h"

#include <algorithm>
#include <mutex>
#include <unordered_map>
#include <vector>

namespace licensing {
namespace {

constexpr int64_t kHourSeconds = 60LL * 60LL;
constexpr int64_t kUtcDaySeconds = 24LL * kHourSeconds;

// One module's grants to one account: the grant times (Unix seconds) in the
// last hour, oldest first, and the count for UTC day `utc_day`.
struct ModuleWindow {
  uint32_t module_hash = 0;
  uint32_t utc_day = 0;
  uint32_t day_count = 0;
  std::vector<uint32_t> last_hour;
};

struct AccountLedger {
  std::vector<ModuleWindow> modules;
  uint32_t utc_day = 0;
  uint32_t day_count = 0;
  int64_t last_seen = 0;  // seconds; the eviction order
};

std::mutex g_mutex;
std::unordered_map<std::string, AccountLedger> g_accounts;  // by proven xpub

uint32_t ModuleHash(const std::string& module_id) {
  uint32_t hash = 2166136261u;  // FNV-1a; a collision only joins two modules' counts
  for (const char c : module_id) {
    hash = (hash ^ static_cast<uint8_t>(c)) * 16777619u;
  }
  return hash;
}

// Forget what no limit can see any more: grants older than an hour, counts of a
// past UTC day, and modules left with neither.
void Prune(AccountLedger* account, uint32_t now, uint32_t day) {
  if (account->utc_day != day) {
    account->utc_day = day;
    account->day_count = 0;
  }
  for (ModuleWindow& window : account->modules) {
    auto& stamps = window.last_hour;
    stamps.erase(stamps.begin(),
                 std::find_if(stamps.begin(), stamps.end(),
                              [&](uint32_t at) { return at + kHourSeconds > now; }));
    if (window.utc_day != day) {
      window.utc_day = day;
      window.day_count = 0;
    }
  }
  account->modules.erase(
      std::remove_if(account->modules.begin(), account->modules.end(),
                     [](const ModuleWindow& w) { return w.last_hour.empty() && w.day_count == 0; }),
      account->modules.end());
}

AccountLedger& LedgerFor(const std::string& account_xpub) {
  const auto found = g_accounts.find(account_xpub);
  if (found != g_accounts.end()) {
    return found->second;
  }
  if (g_accounts.size() >= kMaxTrackedAccounts) {
    g_accounts.erase(std::min_element(
        g_accounts.begin(), g_accounts.end(),
        [](const auto& a, const auto& b) { return a.second.last_seen < b.second.last_seen; }));
  }
  return g_accounts[account_xpub];
}

ModuleWindow* FindWindow(AccountLedger* account, uint32_t module_hash) {
  for (ModuleWindow& window : account->modules) {
    if (window.module_hash == module_hash) {
      return &window;
    }
  }
  return nullptr;
}

uint32_t Seconds(int64_t now_ms) {
  return static_cast<uint32_t>(std::max<int64_t>(now_ms, 0) / 1000);
}

}  // namespace

bool AdmitGrant(const std::string& account_xpub, const std::string& module_id, int64_t now_ms) {
  const uint32_t now = Seconds(now_ms);
  const uint32_t day = static_cast<uint32_t>(now / kUtcDaySeconds);
  const uint32_t module_hash = ModuleHash(module_id);

  std::lock_guard<std::mutex> lock(g_mutex);
  AccountLedger& account = LedgerFor(account_xpub);
  account.last_seen = now;
  Prune(&account, now, day);

  size_t account_last_hour = 0;
  for (const ModuleWindow& window : account.modules) {
    account_last_hour += window.last_hour.size();
  }
  ModuleWindow* window = FindWindow(&account, module_hash);
  if (account.day_count >= kGrantsPerAccountPerUtcDay ||
      account_last_hour >= kGrantsPerAccountPerHour ||
      (window && (window->day_count >= kGrantsPerModulePerUtcDay ||
                  window->last_hour.size() >= kGrantsPerModulePerHour))) {
    return false;
  }

  if (!window) {
    account.modules.push_back(ModuleWindow{module_hash, day, 0, {}});
    window = &account.modules.back();
  }
  window->last_hour.push_back(now);
  ++window->day_count;
  ++account.day_count;
  return true;
}

void RefundGrant(const std::string& account_xpub, const std::string& module_id, int64_t now_ms) {
  const uint32_t now = Seconds(now_ms);
  const uint32_t day = static_cast<uint32_t>(now / kUtcDaySeconds);

  std::lock_guard<std::mutex> lock(g_mutex);
  const auto found = g_accounts.find(account_xpub);
  if (found == g_accounts.end()) {
    return;
  }
  AccountLedger& account = found->second;
  ModuleWindow* window = FindWindow(&account, ModuleHash(module_id));
  if (!window) {
    return;
  }
  const auto stamp = std::find(window->last_hour.rbegin(), window->last_hour.rend(), now);
  if (stamp == window->last_hour.rend()) {
    return;
  }
  window->last_hour.erase(std::next(stamp).base());
  if (window->utc_day == day && window->day_count > 0) {
    --window->day_count;
  }
  if (account.utc_day == day && account.day_count > 0) {
    --account.day_count;
  }
}

}  // namespace licensing
