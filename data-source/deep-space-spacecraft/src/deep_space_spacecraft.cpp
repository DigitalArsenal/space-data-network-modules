#include "space_data_module_invoke.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <set>
#include <string>
#include <vector>

using Json = nlohmann::json;
namespace {
constexpr size_t maxFrames = 60, maxControlBytes = 64u * 1024u * 1024u;
constexpr int kMaxStages = 6;
std::string error;
int fail(const std::string& code) { plugin_set_error(code.c_str(), code.c_str()); return 1; }
#define NEED(c, code) do { if (!(c)) { error = code; return false; } } while (0)
#define CHECK(c, code) do { if (!(c)) return fail(code); } while (0)
std::vector<const plugin_input_frame_t*> frames(const char* port) {
  std::vector<const plugin_input_frame_t*> result;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && std::strcmp(f->port_id, port) == 0) result.push_back(f);
  }
  return result;
}
Json json(const char* port) {
  const auto list = frames(port);
  if (list.size() != 1 || !list[0]->payload || list[0]->payload_length > maxControlBytes) return Json();
  return Json::parse(list[0]->payload, list[0]->payload + list[0]->payload_length, nullptr, false);
}
int output(const char* port, const Json& value) {
  const std::string text = value.dump();
  if (text.size() >= maxControlBytes) return -1;
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
      nullptr, 0, 1, reinterpret_cast<const uint8_t*>(text.data()), text.size());
}
bool integer(const Json& j, const char* key) { return j.contains(key) && j[key].is_number_integer(); }
bool array(const Json& j, const char* key) { return j.contains(key) && j[key].is_array(); }
std::string lifecycle(const Json& craft, const Json& config) {
  const auto& n = *notables::find(craft["id"].get<int>());
  if (n.lifecycle_end) return "ended";
  double now;
  if (craft.contains("hi") && config.contains("now_tdb") && config["now_tdb"].is_string() &&
      horizons::parseCalendar(config["now_tdb"].get<std::string>(), now) && craft["hi"].get<double>() < now) return "ended";
  return "active";
}
bool emit(const std::vector<std::string>& requests, const Json& state) {
  NEED(requests.size() <= maxFrames, "too-many-requests");
  for (const auto& url : requests) NEED(spacecraft_wire::push_get(url) >= 0, "output-failed");
  std::vector<std::string> skipped;
  for (const auto& c : state["craft"]) if (c.contains("skipped"))
    skipped.push_back(std::to_string(c["id"].get<int>()) + ":" + c["skipped"].get<std::string>());
  NEED(output("state", state) >= 0 && spacecraft_wire::notice("status", sdn::runtime::flowNoticeKind_Info,
      "stage:" + std::to_string(state["stage"].get<int>()), state["craft"].size() - skipped.size(),
      skipped, state["config"]["retrieved_ms"]) >= 0, "output-failed");
  return true;
}
bool limit(const Json& config, int id, const char* key, bool& present, int64_t& seconds) {
  present = false;
  if (!config.contains("limits")) return true;
  NEED(config["limits"].is_object(), "invalid-limits");
  const std::string name = std::to_string(id);
  if (!config["limits"].contains(name)) return true;
  const auto& item = config["limits"][name];
  NEED(item.is_object(), "invalid-limits");
  if (!item.contains(key)) return true;
  double value;
  NEED(item[key].is_string() && horizons::parseCalendar(item[key].get<std::string>(), value) &&
      value == std::floor(value), "invalid-limit-time");
  seconds = int64_t(value); present = true;
  return true;
}
bool configure(const Json& config, Json& state) {
  NEED(config.is_object(), "invalid-config");
  NEED(!config.contains("access") || (config["access"].is_string() && config["access"] == "anonymous"), "unsupported-access");
  size_t pageRows = horizons::kDefaultPageRows;
  if (config.contains("page_rows")) {
    NEED(integer(config, "page_rows") && config["page_rows"].get<int64_t>() > 0 &&
        config["page_rows"].get<int64_t>() <= int64_t(horizons::kMaxPageRows), "invalid-page-rows");
    pageRows = config["page_rows"].get<size_t>();
  }
  Json ids = Json::array();
  if (config.contains("objects")) {
    NEED(config["objects"].is_array() && !config["objects"].empty() && config["objects"].size() <= notables::kCraftCount, "invalid-objects");
    ids = config["objects"];
  } else for (const auto& n : notables::kCraft) ids.push_back(n.id);
  if (config.contains("now_tdb")) {
    double now;
    NEED(config["now_tdb"].is_string() && horizons::parseCalendar(config["now_tdb"].get<std::string>(), now) &&
        now == std::floor(now), "invalid-now");
  }
  std::set<int> seen;
  state = {{"planned", false}, {"stage", 0}, {"config", config}, {"page_rows", pageRows}, {"craft", Json::array()},
           {"pending", Json::array()}, {"queue", Json::array()}, {"next", 0}};
  for (const auto& value : ids) {
    NEED(value.is_number_integer() && value.get<int64_t>() >= INT32_MIN && value.get<int64_t>() <= INT32_MAX, "unknown-object");
    const int id = value.get<int>();
    const auto* n = notables::find(id);
    NEED(n, "unknown-object");
    NEED(!n->phase_count || config.contains("now_tdb"), "missing-now");
    NEED(seen.insert(id).second, "duplicate-object");
    bool present; int64_t seconds;
    NEED(limit(config, id, "start", present, seconds) && limit(config, id, "stop", present, seconds), error);
    state["craft"].push_back({{"id", id}});
  }
  return true;
}
bool dailyRuns(const Json& craft, std::vector<trajectory::RowRun>& runs) {
  const auto& groups = craft["groups"];
  runs.clear();
  if (craft["archive_groups"] == 0) return true;
  NEED(groups[0]["step"] == horizons::kDay, "invalid-state");
  std::vector<trajectory::Window> windows;
  for (size_t i = 1; i < craft["archive_groups"].get<size_t>(); ++i) {
    NEED(groups[i]["step"] == horizons::kWindowStep, "invalid-state");
    windows.push_back({groups[i]["start"], groups[i]["stop"], {}});
  }
  NEED(trajectory::dailyRuns(groups[0]["start"], groups[0]["stop"], windows, runs), "invalid-state");
  return true;
}
bool validateState(const Json& s) {
  NEED(s.is_object() && integer(s, "stage") && s["stage"].get<int64_t>() >= 0 && s["stage"].get<int64_t>() <= kMaxStages &&
      s.contains("planned") && s["planned"].is_boolean() &&
      s.contains("config") && s["config"].is_object() && integer(s, "page_rows") &&
      s["page_rows"].get<int64_t>() > 0 && s["page_rows"].get<int64_t>() <= int64_t(horizons::kMaxPageRows) &&
      array(s, "craft") && !s["craft"].empty() && s["craft"].size() <= notables::kCraftCount && array(s, "pending") &&
      s["pending"].size() <= maxFrames && array(s, "queue") && s["queue"].size() <= (kMaxStages + 1) * maxFrames &&
      integer(s, "next") && s["next"].get<int64_t>() >= int64_t(s["pending"].size()) &&
      s["next"].get<size_t>() <= s["queue"].size(), "invalid-state");
  std::set<int> ids;
  for (const auto& c : s["craft"]) {
    NEED(integer(c, "id") && c["id"].get<int64_t>() >= INT32_MIN && c["id"].get<int64_t>() <= INT32_MAX &&
        notables::find(c["id"].get<int>()) && ids.insert(c["id"].get<int>()).second, "invalid-state");
    if (c.contains("skipped")) { NEED(c["skipped"].is_string() && !c["skipped"].get<std::string>().empty(), "invalid-state"); continue; }
    if (!s["planned"].get<bool>()) continue;
    NEED(c.contains("lo") && c["lo"].is_number() && c.contains("hi") && c["hi"].is_number() &&
        std::isfinite(c["lo"].get<double>()) && std::isfinite(c["hi"].get<double>()) &&
        c["lo"].get<double>() < c["hi"].get<double>() &&
        array(c, "groups") && !c["groups"].empty() && c.contains("terminal") && c["terminal"].is_boolean() &&
        integer(c, "archive_groups") && c["archive_groups"].get<int64_t>() >= 0 &&
        c["archive_groups"].get<size_t>() <= c["groups"].size(), "invalid-state");
    for (const auto& g : c["groups"]) {
      NEED(integer(g, "start") && integer(g, "stop") && integer(g, "step") && integer(g, "center") &&
          g.contains("data") && g["data"].is_string() && integer(g, "received") &&
          g.contains("label") && g["label"].is_string(), "invalid-state");
      const int64_t a = g["start"], b = g["stop"], step = g["step"], center = g["center"];
      NEED(a >= -4000000000LL && b <= 10000000000LL && b >= a &&
          step > 0 && step <= horizons::kDay && step % 60 == 0 && (b - a) % step == 0 &&
          center >= 0 && center <= 699 && *trajectory::centerName(int(center)) &&
          g["received"].get<int64_t>() >= 0 &&
          g["received"].get<int64_t>() <= (b - a) / step + 1, "invalid-state");
    }
    std::vector<trajectory::RowRun> runs;
    NEED(dailyRuns(c, runs), error);
    for (size_t i = 0; i < c["groups"].size(); ++i) {
      const auto& g = c["groups"][i];
      const size_t received = g["received"];
      const size_t expected = i == 0 && c["archive_groups"] != 0 ? trajectory::retainedRows(runs, received) : received;
      size_t stored = 0;
      NEED(packed_rows::validate(g["data"].get_ref<const std::string&>(), expected, stored) &&
          stored == expected, "invalid-state");
    }
  }
  return true;
}
void skipCraft(Json& craft, const std::string& code) {
  if (!craft.contains("skipped")) craft["skipped"] = code;
  craft.erase("groups");
  craft.erase("archive_groups");
  craft.erase("terminal");
  error.clear();
}
bool readVectorPage(const Json& pending, const Json& group, int id, size_t pageRows,
                    const std::string& body, std::vector<horizons::State>& rows) {
  const int64_t step = pending["step"], start = pending["start"];
  const size_t count = pending["rows"], offset = pending["offset"];
  NEED(pending["rows"].get<int64_t>() > 0 && pending["rows"].get<int64_t>() <= int64_t(pageRows) &&
      step == group["step"] && pending["offset"].get<int64_t>() == group["received"].get<int64_t>() &&
      start == group["start"].get<int64_t>() + int64_t(offset) * step &&
      start + int64_t(count - 1) * step <= group["stop"].get<int64_t>(), "out-of-order-vector-page");
  NEED(horizons::parseVectors(body, start, step, count, rows, error, group["center"].get<int>()), error);
  NEED(horizons::validateTarget(body, id, notables::find(id)->horizons_name, error, group["center"].get<int>()), error);
  return true;
}
bool consume(Json& state) {
  const auto rs = frames("response");
  NEED(rs.size() == state["pending"].size(), "response-count-mismatch");
  for (size_t i = 0; i < rs.size(); ++i) {
    const auto* response = spacecraft_wire::response_on(rs[i], error);
    NEED(response, error);
    const auto& pending = state["pending"][i];
    NEED(integer(pending, "craft") && pending["craft"].get<size_t>() < state["craft"].size(), "invalid-state");
    auto& craft = state["craft"][pending["craft"].get<size_t>()];
    if (pending.contains("lower")) NEED(pending["lower"].is_boolean(), "invalid-state");
    else NEED(state["planned"].get<bool>() && integer(pending, "group") && pending["group"].get<int64_t>() >= 0 &&
        integer(pending, "start") && integer(pending, "step") && integer(pending, "rows") &&
        integer(pending, "offset"), "invalid-state");
    // Transport and pending-frame validity stay fatal, even after a craft skips.
    if (craft.contains("skipped")) continue;
    const std::string body(reinterpret_cast<const char*>(response->BODY()->data()), response->BODY()->size());
    if (pending.contains("lower")) {
      const bool lower = pending["lower"];
      double bound;
      if (!horizons::parseCoverage(body, lower, bound, error)) {
        skipCraft(craft, error);
      } else craft[lower ? "lo" : "hi"] = bound;
    } else {
      NEED(pending["group"].get<int64_t>() < int64_t(craft["groups"].size()), "invalid-state");
      const size_t groupIndex = pending["group"];
      auto& group = craft["groups"][groupIndex];
      const size_t count = pending["rows"], offset = pending["offset"];
      std::vector<horizons::State> rows;
      if (!readVectorPage(pending, group, craft["id"], state["page_rows"], body, rows)) {
        skipCraft(craft, error);
        continue;
      }
      auto& packed = group["data"].get_ref<std::string&>();
      if (groupIndex == 0 && craft["archive_groups"] != 0) {
        std::vector<trajectory::RowRun> runs;
        NEED(dailyRuns(craft, runs), error);
        // Every original row has already passed target/grid/finite validation.
        // Append only intersections with the retained runs, in original order.
        for (const auto& run : runs) {
          const size_t first = std::max(offset, run.first);
          const size_t last = std::min(offset + count, run.first + run.count);
          for (size_t row = first; row < last; ++row) packed_rows::append(packed, rows[row - offset]);
        }
      } else for (const auto& row : rows) packed_rows::append(packed, row);
      group["received"] = offset + count;
    }
  }
  state["pending"] = Json::array();
  return true;
}
Json group(int64_t start, int64_t stop, int64_t step, const std::string& label, int center = 10) {
  return {{"center", center}, {"start", start}, {"stop", stop}, {"step", step}, {"label", label}, {"data", ""}, {"received", 0}};
}
bool planVectors(Json& state) {
  const size_t probes = state["queue"].size();
  for (size_t i = 0; i < state["craft"].size(); ++i) {
    auto& craft = state["craft"][i];
    if (craft.contains("skipped")) continue;
    NEED(craft.contains("lo") && craft["lo"].is_number() && craft.contains("hi") && craft["hi"].is_number(), "missing-coverage-bound");
    const int id = craft["id"];
    const auto& n = *notables::find(id);
    bool hasStart, hasStop; int64_t start = 0, stop = 0;
    NEED(limit(state["config"], id, "start", hasStart, start) && limit(state["config"], id, "stop", hasStop, stop), error);
    Json pages = Json::array();
    const auto enqueue = [&](const trajectory::Plan& plan, size_t offset, int center) {
      for (const auto& p : plan.pages) pages.push_back({{"craft", i}, {"group", p.group + offset},
          {"center", center}, {"start", p.start}, {"stop", p.stop}, {"step", p.step}, {"rows", p.rows}, {"offset", p.offset}});
    };
    craft["terminal"] = false;
    craft["groups"] = Json::array();
    if (n.kind == notables::Kind::Archive) {
      trajectory::Plan plan;
      if (!trajectory::build(n, craft["lo"].get<double>(), craft["hi"].get<double>(),
          hasStart, start, hasStop, stop, state["page_rows"].get<size_t>(), plan, error)) {
        skipCraft(craft, error);
        continue;
      }
      craft["terminal"] = plan.terminal;
      craft["groups"].push_back(group(plan.start, plan.stop, horizons::kDay, "daily"));
      for (const auto& w : plan.windows) {
        std::string label;
        for (const auto& labelPart : w.labels) { if (!label.empty()) label += "; "; label += labelPart; }
        craft["groups"].push_back(group(w.start, w.stop, horizons::kWindowStep, label));
      }
      enqueue(plan, 0, 10);
    }
    craft["archive_groups"] = craft["groups"].size();
    for (size_t phaseIndex = 0; phaseIndex < n.phase_count; ++phaseIndex) {
      const auto& phase = n.phases[phaseIndex];
      double now;
      NEED(state["config"].contains("now_tdb"), "missing-now");
      NEED(state["config"]["now_tdb"].is_string() &&
          horizons::parseCalendar(state["config"]["now_tdb"].get<std::string>(), now) && now == std::floor(now), "invalid-now");
      trajectory::Plan plan;
      if (!trajectory::window(phase, int64_t(now), craft["lo"].get<double>(), craft["hi"].get<double>(),
          hasStart, start, hasStop, stop, state["page_rows"].get<size_t>(), plan, error)) {
        skipCraft(craft, error);
        break;
      }
      enqueue(plan, craft["groups"].size(), phase.center);
      craft["groups"].push_back(group(plan.start, plan.stop, phase.step, phase.label, phase.center));
    }
    if (craft.contains("skipped")) continue;
    for (auto& page : pages) state["queue"].push_back(std::move(page));
    NEED(state["queue"].size() - probes <= (kMaxStages - state["stage"].get<int>()) * maxFrames, "too-many-requests");
  }
  state["planned"] = true;
  return true;
}
bool nextRequests(Json& state, std::vector<std::string>& requests) {
  size_t next = state["next"];
  requests.clear();
  while (next < state["queue"].size()) {
    const auto& p = state["queue"][next];
    NEED(integer(p, "craft") && p["craft"].get<size_t>() < state["craft"].size() && integer(p, "start") &&
        integer(p, "stop") && integer(p, "step") && integer(p, "center") &&
        p["center"].get<int64_t>() >= 0 && p["center"].get<int64_t>() <= 699, "invalid-state");
    const auto& craft = state["craft"][p["craft"].get<size_t>()];
    if (craft.contains("skipped")) { ++next; continue; }
    if (requests.size() == maxFrames) break;
    requests.push_back(horizons::requestUrl(craft["id"], p["start"], p["stop"], p["step"], p["center"]));
    state["pending"].push_back(p);
    ++next;
  }
  state["next"] = next;
  return true;
}
} // namespace

extern "C" int plan_horizons() {
  const auto ticks = frames("tick");
  CHECK(ticks.size() == 1 && ticks[0]->payload, "invalid-tick");
  flatbuffers::Verifier tickVerifier(ticks[0]->payload, ticks[0]->payload_length, 64, 1000000, false);
  CHECK(sdn::runtime::VerifyTimerTickBuffer(tickVerifier), "invalid-tick");
  const uint64_t fired = sdn::runtime::GetTimerTick(ticks[0]->payload)->FIRED_MS();
  const auto hostConfig = sdm_piv::get_config();
  CHECK(hostConfig.ok(), "invalid-config");
  if (!hostConfig.boolean("deep_space_enabled")) {
    CHECK(spacecraft_wire::notice("status", sdn::runtime::flowNoticeKind_Skipped, "disabled", 0, {}, fired) >= 0, "output-failed");
    return 0;
  }
  Json config, state;
  CHECK(spacecraft_wire::config(hostConfig, fired, config, error) && configure(config, state), error);
  std::vector<std::string> requests;
  double lo, hi;
  CHECK(horizons::parseCalendar("1900-01-01T00:00:00", lo) &&
        horizons::parseCalendar("2300-01-01T00:00:00", hi), "invalid-probe-time");
  for (size_t i = 0; i < state["craft"].size(); ++i) {
    for (bool lower : {true, false}) {
      const int64_t start = int64_t(lower ? lo : hi);
      state["queue"].push_back({{"craft", i}, {"lower", lower}, {"start", start},
          {"stop", start + horizons::kDay}, {"step", horizons::kDay}, {"center", 10}});
    }
  }
  CHECK(nextRequests(state, requests) && emit(requests, state), error);
  return 0;
}
extern "C" int advance() {
  Json state = json("state");
  std::vector<std::string> requests;
  CHECK(validateState(state), error);
  const int stage = state["stage"];
  CHECK(stage < kMaxStages, "invalid-stage");
  CHECK(consume(state), error);
  if (!state["planned"].get<bool>() && state["next"].get<size_t>() == state["queue"].size()) CHECK(planVectors(state), error);
  CHECK(nextRequests(state, requests), error);
  state["stage"] = stage + 1;
  CHECK(emit(requests, state), error);
  return 0;
}
extern "C" int build_oem() {
  Json state = json("state");
  CHECK(validateState(state), error);
  CHECK(state["planned"].get<bool>() && state["next"].get<size_t>() == state["queue"].size(), "invalid-stage");
  CHECK(consume(state), error);
  CHECK(std::any_of(state["craft"].begin(), state["craft"].end(),
      [](const Json& craft) { return !craft.contains("skipped"); }), "no-trajectories");
  const auto& config = state["config"];
  CHECK(integer(config, "retrieved_ms") && config["retrieved_ms"].get<double>() >= 0 &&
      config["retrieved_ms"].get<double>() <= 60000000000000.0, "invalid-retrieved-ms");
  CHECK(config.contains("producer_peer_id") && config["producer_peer_id"].is_string() &&
      !config["producer_peer_id"].get<std::string>().empty(), "missing-producer-peer-id");
  std::string creation = sdn_time::format_iso_micro(config["retrieved_ms"].get<int64_t>() * 1000);
  const std::string retrieved = creation.substr(0, creation.size() - 3) + "Z";
  if (creation.substr(creation.size() - 7) == ".000000") creation.resize(creation.size() - 7);
  creation += "Z";
  // Validate and construct every craft before emitting any records.
  struct Record { regime::Catalog catalog; int id; std::string life; std::vector<uint8_t> bytes; };
  std::vector<Record> records;
  Json skipped = Json::array();
  std::array<size_t, regime::kCatalogCount> counts{};
  for (const auto& c : state["craft"]) {
    if (c.contains("skipped")) {
      skipped.push_back({{"naif_id", c["id"]}, {"skipped", c["skipped"]}});
      continue;
    }
    std::vector<spacecraft_oem::Group> groups, blocks;
    std::vector<trajectory::RowRun> runs;
    CHECK(dailyRuns(c, runs), error);
    for (size_t i = 0; i < c["groups"].size(); ++i) {
      const auto& g = c["groups"][i];
      const size_t total = size_t((g["stop"].get<int64_t>() - g["start"].get<int64_t>()) / g["step"].get<int64_t>() + 1);
      CHECK(g["received"].get<size_t>() == total, "incomplete-vector-group");
      std::vector<double> data;
      CHECK(packed_rows::decode(g["data"].get_ref<const std::string&>(), data), "invalid-state");
      if (i == 0 && c["archive_groups"] != 0) {
        CHECK(data.size() == trajectory::retainedRows(runs, total) * 6, "invalid-state");
        // Restore grid addresses only at the OEM boundary. Zero-filled omitted
        // interiors are never read by segments(); emitted row bits are unchanged.
        std::vector<double> grid(total * 6, 0.0);
        size_t from = 0;
        for (const auto& run : runs) {
          std::copy_n(data.begin() + from, run.count * 6, grid.begin() + run.first * 6);
          from += run.count * 6;
        }
        data = std::move(grid);
      }
      groups.push_back({g["start"], g["stop"], g["step"], g["label"].get<std::string>(), std::move(data), g["center"]});
    }
    const size_t archiveCount = c["archive_groups"];
    if (archiveCount) CHECK(spacecraft_oem::segments({groups.begin(), groups.begin() + archiveCount},
        c["terminal"].get<bool>(), blocks, error), error);
    std::vector<regime::Segment> classified;
    if (archiveCount) classified = regime::classifySun(blocks);
    for (size_t i = archiveCount; i < groups.size(); ++i) {
      auto phase = regime::classifyPhase(groups[i]);
      classified.insert(classified.end(), std::make_move_iterator(phase.begin()), std::make_move_iterator(phase.end()));
    }
    const auto& n = *notables::find(c["id"].get<int>());
    const std::string life = lifecycle(c, state["config"]);
    const std::string lifeComment = life + " " + (n.lifecycle_end ? n.lifecycle_end : horizons::formatCalendar(c["hi"].get<double>()));
    for (size_t i = 0; i < regime::kCatalogCount; ++i) {
      std::vector<spacecraft_oem::Group> selected;
      for (auto& segment : classified) if (size_t(segment.catalog) == i) selected.push_back(std::move(segment.block));
      if (selected.empty()) continue;
      auto bytes = spacecraft_oem::build(n, selected, creation, regime::kIds[i], lifeComment);
      records.push_back({regime::Catalog(i), n.id, life, std::move(bytes)});
      ++counts[i];
    }
  }
  // Catalog enum order, then descending NAIF id; independent of selection order.
  std::sort(records.begin(), records.end(), [](const Record& a, const Record& b) {
    return a.catalog != b.catalog ? a.catalog < b.catalog : a.id > b.id;
  });
  const auto groups = spacecraft_oem::groupRecords(counts, retrieved);
  spacecraft_wire::Attributes allAttributes;
  std::set<int> attributed;
  std::vector<std::string> catalogCounts;
  size_t catalogCount = 0;
  for (size_t i = 0; i < counts.size(); ++i) {
    catalogCounts.push_back(std::string(regime::kIds[i]) + ":" + std::to_string(counts[i]));
    if (!counts[i]) continue;
    ++catalogCount;
    std::vector<uint8_t> stream;
    spacecraft_wire::Attributes attributes;
    for (const auto& r : records) if (size_t(r.catalog) == i) {
      stream.insert(stream.end(), r.bytes.begin(), r.bytes.end());
      const auto& n = *notables::find(r.id);
      const auto attribute = std::make_pair("naif:" + std::to_string(r.id), std::string(n.name) + "; lifecycle " + r.life);
      attributes.push_back(attribute);
      if (attributed.insert(r.id).second) allAttributes.push_back(attribute);
    }
    const std::string port = spacecraft_wire::port_id(regime::kIds[i]);
    CHECK(spacecraft_wire::push((port + "_records").c_str(), "OEM.fbs", "$OEM", "OEM", stream.data(), stream.size()) >= 0 &&
        spacecraft_wire::meta(port + "_meta", "OEM.fbs", regime::kIds[i], stream, counts[i], config, attributes) >= 0, "output-failed");
  }
  CHECK(spacecraft_wire::push("catalogs_records", "EGP.fbs", "$EGP", "EGP", groups.data(), groups.size()) >= 0 &&
      spacecraft_wire::meta("catalogs_meta", "EGP.fbs", "catalogs", groups, catalogCount, config, allAttributes, true) >= 0, "output-failed");
  for (const auto& c : skipped) CHECK(spacecraft_wire::notice("notice", sdn::runtime::flowNoticeKind_Missing,
      c["skipped"], 1, {std::to_string(c["naif_id"].get<int>())}, config["retrieved_ms"]) >= 0, "output-failed");
  CHECK(spacecraft_wire::notice("notice", sdn::runtime::flowNoticeKind_Info, "catalog-counts", records.size(),
      catalogCounts, config["retrieved_ms"]) >= 0, "output-failed");
  return 0;
}
extern "C" int evaluate_oem() {
  const auto oem = frames("oem");
  const auto epochs = json("epochs");
  CHECK(oem.size() == 1 && oem[0]->payload && oem[0]->payload_length <= maxControlBytes, "invalid-oem-buffer");
  CHECK(array(epochs, "jd_tdb") && epochs["jd_tdb"].size() <= 100000, "invalid-epochs");
  std::vector<spacecraft_oem::SeriesBlock> blocks;
  CHECK(spacecraft_oem::read(oem[0]->payload, oem[0]->payload_length, blocks, error), error);
  Json states = Json::array();
  for (const auto& jd : epochs["jd_tdb"]) {
    CHECK(jd.is_number(), "invalid-epoch");
    size_t index; ephem::StateRow row;
    CHECK(spacecraft_oem::evaluate(blocks, jd.get<double>(), index, row, error), error);
    states.push_back({{"jd_tdb", jd}, {"block", index}, {"x", row.pos[0]}, {"y", row.pos[1]}, {"z", row.pos[2]},
        {"vx", row.vel[0]}, {"vy", row.vel[1]}, {"vz", row.vel[2]}});
  }
  CHECK(output("states", states) >= 0, "output-failed");
  return 0;
}
extern "C" int reconcile_id() {
  const auto r = json("request");
  CHECK(integer(r, "kernel_id") && r["kernel_id"].get<int64_t>() >= INT32_MIN && r["kernel_id"].get<int64_t>() <= INT32_MAX &&
      (!r.contains("mission") || r["mission"].is_string()), "invalid-reconcile-request");
  const std::string mission = r.value("mission", std::string());
  const int id = horizons::reconcileId(mission, r["kernel_id"].get<int>());
  const auto* craft = notables::find(id);
  const std::string name = id == -1024 && mission == "artemis-ii" ? "Artemis II" : craft ? craft->name : "";
  CHECK(output("result", {{"horizons_id", id}, {"name", name}}) >= 0, "output-failed");
  return 0;
}
