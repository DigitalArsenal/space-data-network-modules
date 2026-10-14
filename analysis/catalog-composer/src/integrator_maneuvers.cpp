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

using Statuses = flatbuffers::Vector<maneuverStatus>;
// An absent or empty list keeps the default (DETECTED, CONFIRMED, EXECUTED); a list replaces it.
bool status_set(const Statuses* value, std::set<int>* out, std::string* error) {
  if (!value || value->size() == 0) return true;
  std::set<int> parsed;
  for (const auto status : *value) {
    if (static_cast<int>(status) < static_cast<int>(maneuverStatus::MIN) || static_cast<int>(status) > static_cast<int>(maneuverStatus::MAX)) { *error = "Unknown maneuver status."; return false; }
    parsed.insert(static_cast<int>(status));
  }
  *out = parsed;
  return true;
}
bool parse_maneuver_policy(const XMTManeuverPolicy* m, ManeuverPolicy* out, std::string* error) {
  if (!m) return true;
  out->time_tolerance_s = m->TIME_TOLERANCE_S();
  if (!std::isfinite(out->time_tolerance_s) || out->time_tolerance_s <= 0) { *error = "TIME_TOLERANCE_S must be positive and finite."; return false; }
  for (const auto& [name, value, slot] : {std::tuple<const char*, double, double*>{"DELTA_V_TOLERANCE_KM_S", m->DELTA_V_TOLERANCE_KM_S(), &out->dv_tolerance_km_s},
                                          std::tuple<const char*, double, double*>{"DELTA_V_RELATIVE_TOLERANCE", m->DELTA_V_RELATIVE_TOLERANCE(), &out->dv_relative}}) {
    if (std::isnan(value)) continue;
    if (!std::isfinite(value) || value < 0) { *error = std::string(name) + " must be nonnegative and finite."; return false; }
    *slot = value;
  }
  return status_set(m->MANEUVERABLE_STATUSES(), &out->maneuverable, error) && status_set(m->RETIRING_STATUSES(), &out->retiring, error);
}
std::unique_ptr<XMTManeuverPolicyT> maneuver_policy_table(const ManeuverPolicy& p) {
  auto out = std::make_unique<XMTManeuverPolicyT>();
  out->TIME_TOLERANCE_S = p.time_tolerance_s;
  out->DELTA_V_TOLERANCE_KM_S = p.dv_tolerance_km_s;
  out->DELTA_V_RELATIVE_TOLERANCE = p.dv_relative;
  for (int s : p.maneuverable) out->MANEUVERABLE_STATUSES.push_back(static_cast<maneuverStatus>(s));
  for (int s : p.retiring) out->RETIRING_STATUSES.push_back(static_cast<maneuverStatus>(s));
  return out;
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
