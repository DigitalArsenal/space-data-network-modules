// Maneuvers of one object from every source, merged. Two sources that report the same burn are one event that keeps
// each source's confirmation; a source never merges with itself, and the merged event's status is the best any
// source gave. The catalog's MANEUVERABLE comes from this history, and an event that follows a product's epoch
// retires that product.
namespace integrate {

struct ManeuverPolicy {
  double time_tolerance_s = 3600;
  double dv_tolerance_km_s = NAN;  // NaN: not compared
  double dv_relative = NAN;
  std::set<int> maneuverable{static_cast<int>(maneuverStatus::DETECTED), static_cast<int>(maneuverStatus::CONFIRMED), static_cast<int>(maneuverStatus::EXECUTED)};
  std::set<int> retiring{static_cast<int>(maneuverStatus::DETECTED), static_cast<int>(maneuverStatus::CONFIRMED), static_cast<int>(maneuverStatus::EXECUTED)};
};

bool status_named(const std::string& name, maneuverStatus* out) {
  for (int i = static_cast<int>(maneuverStatus::MIN); i <= static_cast<int>(maneuverStatus::MAX); ++i) {
    if (name == EnumNamemaneuverStatus(static_cast<maneuverStatus>(i))) { *out = static_cast<maneuverStatus>(i); return true; }
  }
  return false;
}
bool status_set(const Json& value, std::set<int>* out, std::string* error) {
  if (value.is_null()) return true;
  if (!value.is_array()) { *error = "Maneuver statuses must be an array of status names."; return false; }
  std::set<int> parsed;
  for (const auto& name : value) {
    maneuverStatus status;
    if (!status_named(text(name), &status)) { *error = "Unknown maneuver status."; return false; }
    parsed.insert(static_cast<int>(status));
  }
  *out = parsed;
  return true;
}
bool parse_maneuver_policy(const Json& m, ManeuverPolicy* out, std::string* error) {
  if (m.is_null()) return true;
  if (!m.is_object()) { *error = "The maneuvers policy must be an object."; return false; }
  if (!field(m, "timeToleranceSeconds").is_null()) {
    out->time_tolerance_s = number(field(m, "timeToleranceSeconds"));
    if (!std::isfinite(out->time_tolerance_s) || out->time_tolerance_s <= 0) { *error = "timeToleranceSeconds must be positive and finite."; return false; }
  }
  for (const char* key : {"deltaVToleranceKmS", "deltaVRelativeTolerance"}) {
    if (field(m, key).is_null()) continue;
    const double v = number(field(m, key));
    if (!std::isfinite(v) || v < 0) { *error = std::string(key) + " must be nonnegative and finite."; return false; }
    (std::strcmp(key, "deltaVToleranceKmS") == 0 ? out->dv_tolerance_km_s : out->dv_relative) = v;
  }
  return status_set(field(m, "maneuverableStatuses"), &out->maneuverable, error) && status_set(field(m, "retiringStatuses"), &out->retiring, error);
}
Json maneuver_policy_json(const ManeuverPolicy& p) {
  Json maneuverable = Json::array(), retiring = Json::array();
  for (int s : p.maneuverable) maneuverable.push_back(EnumNamemaneuverStatus(static_cast<maneuverStatus>(s)));
  for (int s : p.retiring) retiring.push_back(EnumNamemaneuverStatus(static_cast<maneuverStatus>(s)));
  return {{"timeToleranceSeconds", p.time_tolerance_s}, {"deltaVToleranceKmS", std::isfinite(p.dv_tolerance_km_s) ? Json(p.dv_tolerance_km_s) : Json()},
          {"deltaVRelativeTolerance", std::isfinite(p.dv_relative) ? Json(p.dv_relative) : Json()}, {"maneuverableStatuses", maneuverable}, {"retiringStatuses", retiring}};
}

// Best first: the status a merged event takes.
int rank_of(maneuverStatus s) {
  switch (s) {
    case maneuverStatus::EXECUTED: return 6;
    case maneuverStatus::CONFIRMED: return 5;
    case maneuverStatus::DETECTED: return 4;
    case maneuverStatus::PREDICTED: return 3;
    case maneuverStatus::PLANNED: return 2;
    case maneuverStatus::UNKNOWN: return 1;
    case maneuverStatus::CANCELLED: return 0;
  }
  return 1;
}

struct Event {
  std::vector<const Mnv*> members;  // time order
  const Mnv* primary = nullptr;     // the member whose record the event is written from
  maneuverStatus status = maneuverStatus::UNKNOWN;
};

bool agree(const Mnv& a, const Mnv& b, const ManeuverPolicy& p) {
  if (!std::isfinite(a.delta_v) || !std::isfinite(b.delta_v)) return true;
  if (!std::isfinite(p.dv_tolerance_km_s) && !std::isfinite(p.dv_relative)) return true;
  const double limit = std::max(std::isfinite(p.dv_tolerance_km_s) ? p.dv_tolerance_km_s : 0.0, (std::isfinite(p.dv_relative) ? p.dv_relative : 0.0) * std::max(a.delta_v, b.delta_v));
  return std::fabs(a.delta_v - b.delta_v) <= limit;
}

std::vector<Event> merge_maneuvers(std::vector<const Mnv*> list, const ManeuverPolicy& policy) {
  std::stable_sort(list.begin(), list.end(), [](const Mnv* a, const Mnv* b) {
    if (a->time != b->time) return a->time < b->time;
    if (a->source != b->source) return a->source < b->source;
    return a->ordinal < b->ordinal;
  });
  const double tolerance_us = policy.time_tolerance_s * 1e6;
  std::vector<Event> events;
  for (const Mnv* m : list) {
    Event* join = nullptr;
    for (size_t i = events.size(); i-- > 0;) {
      Event& e = events[i];
      const Mnv& anchor = *e.members.front();
      if (static_cast<double>(m->time - anchor.time) > tolerance_us) break;
      if (!agree(anchor, *m, policy)) continue;
      bool same_source = false;
      for (const Mnv* member : e.members) same_source = same_source || member->source == m->source;
      if (same_source) continue;
      join = &e;
      break;
    }
    if (!join) {
      events.emplace_back();
      join = &events.back();
    }
    join->members.push_back(m);
  }
  for (Event& e : events) {
    e.primary = e.members.front();
    for (const Mnv* m : e.members) if (rank_of(m->status) > rank_of(e.primary->status)) e.primary = m;
    e.status = e.primary->status;
  }
  return events;
}

// Written from the primary member. An event of one record is that record, byte for byte; an event of several carries
// each source's confirmation in its tags (member:<source>=<STATUS>) and the best status.
std::vector<uint8_t> event_record(const Event& e) {
  if (e.members.size() == 1) return std::vector<uint8_t>(e.primary->bytes, e.primary->bytes + e.primary->length);
  std::unique_ptr<MNVT> record(GetSizePrefixedMNV(e.primary->bytes)->UnPack());
  record->STATUS = e.status;
  for (const Mnv* m : e.members) record->TAGS.push_back("member:" + m->source + "=" + EnumNamemaneuverStatus(m->status));
  record->TAGS.push_back("merged:" + std::to_string(e.members.size()));
  flatbuffers::FlatBufferBuilder fbb(1024);
  FinishSizePrefixedMNVBuffer(fbb, CreateMNV(fbb, record.get()));
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

// When an event began: its earliest report, so a product is retired by the first source to see the burn.
int64_t began(const Event& e) { return e.members.front()->time; }

bool is_maneuverable(const std::vector<Event>& events, const ManeuverPolicy& p, int64_t as_of) {
  for (const Event& e : events) if (began(e) <= as_of && p.maneuverable.count(static_cast<int>(e.status))) return true;
  return false;
}
// The latest event at or before `as_of` whose status retires the products before it, or null.
const Event* latest_retiring(const std::vector<Event>& events, const ManeuverPolicy& p, int64_t as_of) {
  const Event* latest = nullptr;
  for (const Event& e : events) {
    if (began(e) > as_of || !p.retiring.count(static_cast<int>(e.status))) continue;
    if (!latest || began(e) >= began(*latest)) latest = &e;
  }
  return latest;
}

}  // namespace integrate
