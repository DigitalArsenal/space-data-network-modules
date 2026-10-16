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
constexpr size_t maxFrames = 60, maxControlBytes = 256u * 1024u * 1024u;
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
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
      nullptr, 0, 1, reinterpret_cast<const uint8_t*>(text.data()), text.size());
}
bool integer(const Json& j, const char* key) { return j.contains(key) && j[key].is_number_integer(); }
bool array(const Json& j, const char* key) { return j.contains(key) && j[key].is_array(); }
Json request(int id, int64_t first, int64_t last, int64_t step) {
  return {{"method", "GET"}, {"url", horizons::requestUrl(id, first, last, step)},
          {"headers", {{"If-Modified-Since", "Thu, 01 Jan 1970 00:00:00 GMT"}}}};
}
Json aliases(const char* text) {
  Json out = Json::array();
  std::string s(text);
  for (size_t at = 0; at < s.size();) {
    const auto end = s.find("; ", at);
    out.push_back(s.substr(at, end == std::string::npos ? end : end - at));
    if (end == std::string::npos) break;
    at = end + 2;
  }
  return out;
}
Json status(const Json& state) {
  Json objects = Json::array();
  for (const auto& c : state["craft"]) {
    const auto& n = *notables::find(c["id"].get<int>());
    objects.push_back({{"naif_id", n.id}, {"name", n.name}, {"aliases", aliases(n.aliases)},
        {"cospar", n.cospar}, {"norad", n.norad}, {"licence", n.licence}, {"credit", n.credit},
        {"windows", c.contains("groups") ? c["groups"].size() - 1 : n.event_count + 1}});
  }
  return {{"objects", objects}, {"stage", state["stage"]}, {"line_cap", horizons::kHorizonsLineCap}};
}
bool emit(const Json& requests, const Json& state) {
  NEED(requests.size() <= maxFrames, "too-many-requests");
  for (const auto& r : requests) NEED(output("request", r) >= 0, "output-failed");
  NEED(output("state", state) >= 0 && output("status", status(state)) >= 0, "output-failed");
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
    NEED(config["objects"].is_array() && !config["objects"].empty() && config["objects"].size() <= 13, "invalid-objects");
    ids = config["objects"];
  } else for (const auto& n : notables::kCraft) ids.push_back(n.id);
  std::set<int> seen;
  state = {{"stage", 0}, {"config", config}, {"page_rows", pageRows}, {"craft", Json::array()},
           {"pending", Json::array()}, {"queue", Json::array()}, {"next", 0}};
  for (const auto& value : ids) {
    NEED(value.is_number_integer() && value.get<int64_t>() >= INT32_MIN && value.get<int64_t>() <= INT32_MAX, "unknown-object");
    const int id = value.get<int>();
    NEED(notables::find(id), "unknown-object");
    NEED(seen.insert(id).second, "duplicate-object");
    bool present; int64_t seconds;
    NEED(limit(config, id, "start", present, seconds) && limit(config, id, "stop", present, seconds), error);
    state["craft"].push_back({{"id", id}});
  }
  return true;
}
bool dailyRuns(const Json& craft, std::vector<trajectory::RowRun>& runs) {
  const auto& groups = craft["groups"];
  NEED(groups[0]["step"] == horizons::kDay, "invalid-state");
  std::vector<trajectory::Window> windows;
  for (size_t i = 1; i < groups.size(); ++i) {
    NEED(groups[i]["step"] == horizons::kWindowStep, "invalid-state");
    windows.push_back({groups[i]["start"], groups[i]["stop"], {}});
  }
  NEED(trajectory::dailyRuns(groups[0]["start"], groups[0]["stop"], windows, runs), "invalid-state");
  return true;
}
bool validateState(const Json& s) {
  NEED(s.is_object() && integer(s, "stage") && s["stage"].get<int>() >= 0 && s["stage"].get<int>() <= 3 &&
      s.contains("config") && s["config"].is_object() && integer(s, "page_rows") &&
      s["page_rows"].get<int64_t>() > 0 && s["page_rows"].get<int64_t>() <= int64_t(horizons::kMaxPageRows) &&
      array(s, "craft") && !s["craft"].empty() && s["craft"].size() <= 13 && array(s, "pending") &&
      s["pending"].size() <= maxFrames && array(s, "queue") && s["queue"].size() <= 180 &&
      integer(s, "next") && s["next"].get<int64_t>() >= 0 && s["next"].get<size_t>() <= s["queue"].size(), "invalid-state");
  for (const auto& c : s["craft"]) {
    NEED(integer(c, "id") && notables::find(c["id"].get<int>()), "invalid-state");
    if (s["stage"] == 0) continue;
    NEED(array(c, "groups") && !c["groups"].empty() && c.contains("terminal") && c["terminal"].is_boolean(), "invalid-state");
    for (const auto& g : c["groups"]) {
      NEED(integer(g, "start") && integer(g, "stop") && integer(g, "step") &&
          g.contains("data") && g["data"].is_string() && integer(g, "received") &&
          g.contains("label") && g["label"].is_string(), "invalid-state");
      const int64_t a = g["start"], b = g["stop"], step = g["step"];
      NEED(a >= -4000000000LL && b <= 10000000000LL && b >= a &&
          (step == horizons::kDay || step == horizons::kWindowStep) && (b - a) % step == 0 &&
          g["received"].get<int64_t>() >= 0 &&
          g["received"].get<int64_t>() <= (b - a) / step + 1, "invalid-state");
    }
    std::vector<trajectory::RowRun> runs;
    NEED(dailyRuns(c, runs), error);
    for (size_t i = 0; i < c["groups"].size(); ++i) {
      const auto& g = c["groups"][i];
      const size_t received = g["received"];
      const size_t expected = i == 0 ? trajectory::retainedRows(runs, received) : received;
      size_t stored = 0;
      NEED(packed_rows::validate(g["data"].get_ref<const std::string&>(), expected, stored) &&
          stored == expected, "invalid-state");
    }
  }
  return true;
}
bool consume(Json& state) {
  const auto rs = frames("response");
  NEED(rs.size() == state["pending"].size(), "response-count-mismatch");
  for (size_t i = 0; i < rs.size(); ++i) {
    const auto* f = rs[i];
    NEED(f->payload && f->payload_length >= 8 && f->payload_length <= 32u * 1024u * 1024u &&
        std::memcmp(f->payload, "$HRB", 4) == 0, "invalid-http-response");
    const auto* p = f->payload + 4;
    const uint32_t code = uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
    NEED(code == 200, "horizons-http-error");
    const std::string body(reinterpret_cast<const char*>(f->payload + 8), f->payload_length - 8);
    const auto& pending = state["pending"][i];
    NEED(integer(pending, "craft") && pending["craft"].get<size_t>() < state["craft"].size(), "invalid-state");
    auto& craft = state["craft"][pending["craft"].get<size_t>()];
    if (state["stage"] == 0) {
      NEED(pending.contains("lower") && pending["lower"].is_boolean(), "invalid-state");
      const bool lower = pending["lower"];
      double bound;
      NEED(horizons::parseCoverage(body, lower, bound, error), error);
      craft[lower ? "lo" : "hi"] = bound;
    } else {
      NEED(integer(pending, "group") && pending["group"].get<int64_t>() >= 0 &&
          pending["group"].get<int64_t>() < int64_t(craft["groups"].size()) &&
          integer(pending, "start") && integer(pending, "step") && integer(pending, "rows") &&
          integer(pending, "offset"), "invalid-state");
      const size_t groupIndex = pending["group"];
      auto& group = craft["groups"][groupIndex];
      const int64_t step = pending["step"], start = pending["start"];
      const size_t count = pending["rows"], offset = pending["offset"];
      NEED(pending["rows"].get<int64_t>() > 0 && pending["rows"].get<int64_t>() <= state["page_rows"].get<int64_t>() &&
          step == group["step"] && pending["offset"].get<int64_t>() == group["received"].get<int64_t>() &&
          start == group["start"].get<int64_t>() + int64_t(offset) * step &&
          start + int64_t(count - 1) * step <= group["stop"].get<int64_t>(), "out-of-order-vector-page");
      std::vector<std::array<double, 6>> rows;
      NEED(horizons::parseVectors(body, start, step, count, rows, error), error);
      NEED(horizons::validateTarget(body, craft["id"].get<int>(), error), error);
      auto& packed = group["data"].get_ref<std::string&>();
      if (groupIndex == 0) {
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
Json group(int64_t start, int64_t stop, int64_t step, const std::string& label) {
  return {{"start", start}, {"stop", stop}, {"step", step}, {"label", label}, {"data", ""}, {"received", 0}};
}
bool planVectors(Json& state) {
  for (size_t i = 0; i < state["craft"].size(); ++i) {
    auto& craft = state["craft"][i];
    NEED(craft.contains("lo") && craft["lo"].is_number() && craft.contains("hi") && craft["hi"].is_number(), "missing-coverage-bound");
    const int id = craft["id"];
    bool hasStart, hasStop; int64_t start = 0, stop = 0;
    NEED(limit(state["config"], id, "start", hasStart, start) && limit(state["config"], id, "stop", hasStop, stop), error);
    trajectory::Plan plan;
    NEED(trajectory::build(*notables::find(id), craft["lo"].get<double>(), craft["hi"].get<double>(),
        hasStart, start, hasStop, stop, state["page_rows"].get<size_t>(), plan, error), error);
    craft["terminal"] = plan.terminal;
    craft["groups"] = Json::array({group(plan.start, plan.stop, horizons::kDay, "daily")});
    for (const auto& w : plan.windows) {
      std::string label;
      for (const auto& s : w.labels) { if (!label.empty()) label += "; "; label += s; }
      craft["groups"].push_back(group(w.start, w.stop, horizons::kWindowStep, label));
    }
    for (const auto& p : plan.pages) state["queue"].push_back({{"craft", i}, {"group", p.group},
        {"start", p.start}, {"stop", p.stop}, {"step", p.step}, {"rows", p.rows}, {"offset", p.offset}});
    NEED(state["queue"].size() <= 3 * maxFrames, "too-many-requests");
  }
  return true;
}
bool nextRequests(Json& state, Json& requests) {
  const size_t first = state["next"], last = std::min(state["queue"].size(), first + maxFrames);
  requests = Json::array();
  for (size_t i = first; i < last; ++i) {
    const auto& p = state["queue"][i];
    NEED(integer(p, "craft") && p["craft"].get<size_t>() < state["craft"].size() && integer(p, "start") &&
        integer(p, "stop") && integer(p, "step"), "invalid-state");
    requests.push_back(request(state["craft"][p["craft"].get<size_t>()]["id"], p["start"], p["stop"], p["step"]));
    state["pending"].push_back(p);
  }
  state["next"] = last;
  return true;
}
} // namespace

extern "C" int plan_horizons() {
  Json config = frames("config").empty() ? Json::object() : json("config"), state;
  CHECK(configure(config, state), error);
  Json requests = Json::array();
  double lo, hi;
  CHECK(horizons::parseCalendar("1900-01-01T00:00:00", lo) &&
        horizons::parseCalendar("2300-01-01T00:00:00", hi), "invalid-probe-time");
  for (size_t i = 0; i < state["craft"].size(); ++i) {
    const int id = state["craft"][i]["id"];
    for (bool lower : {true, false}) {
      const int64_t start = int64_t(lower ? lo : hi);
      requests.push_back(request(id, start, start + horizons::kDay, horizons::kDay));
      state["pending"].push_back({{"craft", i}, {"lower", lower}});
    }
  }
  CHECK(emit(requests, state), error);
  return 0;
}
extern "C" int advance() {
  Json state = json("state"), requests;
  CHECK(validateState(state), error);
  const int stage = state["stage"];
  CHECK(stage < 3, "invalid-stage");
  CHECK(consume(state), error);
  if (stage == 0) CHECK(planVectors(state), error);
  CHECK(nextRequests(state, requests), error);
  state["stage"] = stage + 1;
  CHECK(emit(requests, state), error);
  return 0;
}
extern "C" int build_oem() {
  Json state = json("state");
  CHECK(validateState(state), error);
  CHECK(state["stage"] == 3 && state["next"].get<size_t>() == state["queue"].size(), "invalid-stage");
  CHECK(consume(state), error);
  std::string creation;
  if (!frames("receipt").empty()) {
    const auto receipt = json("receipt");
    CHECK(integer(receipt, "retrieved_at_ms") && std::abs(receipt["retrieved_at_ms"].get<double>()) <= 60000000000000.0, "invalid-receipt");
    creation = sdn_time::format_iso_micro(receipt["retrieved_at_ms"].get<int64_t>() * 1000);
    if (creation.substr(creation.size() - 7) == ".000000") creation.resize(creation.size() - 7);
    creation += "Z";
  }
  // Validate and construct every craft before emitting any records.
  std::vector<std::vector<uint8_t>> records;
  Json reports = Json::array();
  for (const auto& c : state["craft"]) {
    std::vector<spacecraft_oem::Group> groups, blocks;
    std::vector<trajectory::RowRun> runs;
    CHECK(dailyRuns(c, runs), error);
    for (size_t i = 0; i < c["groups"].size(); ++i) {
      const auto& g = c["groups"][i];
      const size_t total = size_t((g["stop"].get<int64_t>() - g["start"].get<int64_t>()) / g["step"].get<int64_t>() + 1);
      CHECK(g["received"].get<size_t>() == total, "incomplete-vector-group");
      std::vector<double> data;
      CHECK(packed_rows::decode(g["data"].get_ref<const std::string&>(), data), "invalid-state");
      if (i == 0) {
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
      groups.push_back({g["start"], g["stop"], g["step"], g["label"].get<std::string>(), std::move(data)});
    }
    CHECK(spacecraft_oem::segments(groups, c["terminal"].get<bool>(), blocks, error), error);
    records.push_back(spacecraft_oem::build(*notables::find(c["id"].get<int>()), blocks, creation));
    size_t rows = 0;
    for (const auto& b : blocks) rows += b.data.size() / 6;
    reports.push_back({{"naif_id", c["id"]}, {"blocks", blocks.size()}, {"windows", groups.size() - 1},
        {"rows", rows}, {"bytes", records.back().size()}});
  }
  for (const auto& record : records) CHECK(plugin_push_output_ex("records", "OEM.fbs", "$OEM",
      PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OEM", 0, 0, record.data(), record.size()) >= 0, "output-failed");
  const auto& n = notables::kCraft[0];
  CHECK(output("meta", {{"schema", "OEM.fbs"}, {"provider_id", "deep-space-spacecraft"},
      {"source_name", "horizons"}, {"credit", n.credit}, {"licence", n.licence}}) >= 0, "output-failed");
  for (const auto& report : reports) CHECK(output("report", report) >= 0, "output-failed");
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
