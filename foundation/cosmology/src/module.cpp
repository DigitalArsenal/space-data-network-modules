#include "space_data_module_invoke.h"
#include "cosmology.hpp"
#include "frames.hpp"
#include "placement.hpp"
#include "wire.hpp"

namespace cosmology {
bool redshift_valid(double z) { return z >= 0 && z <= max_redshift; }
bool directions_valid(const wire::Request& request, size_t count) {
  if (!request.length("galactic_longitude_rad", count) || !request.length("galactic_latitude_rad", count)) return false;
  for (double l : request.get("galactic_longitude_rad")) if (l < 0 || l >= 2 * pi) return false;
  for (double b : request.get("galactic_latitude_rad")) if (b < -pi / 2 || b > pi / 2) return false;
  return true;
}
struct DistanceColumns {
  std::vector<double> comoving, lookback, light_travel, luminosity;
  void add(const Distances& d) {
    comoving.push_back(d.comoving_mpc); lookback.push_back(d.lookback_gyr);
    light_travel.push_back(d.light_travel_mpc); luminosity.push_back(d.luminosity_mpc);
  }
  void emit(wire::Result& r) const {
    r.vector("comoving_distance_mpc", comoving, "Mpc"); r.vector("lookback_time_gyr", lookback, "Gyr");
    r.vector("light_travel_distance_mpc", light_travel, "Mpc"); r.vector("luminosity_distance_mpc", luminosity, "Mpc");
  }
};
struct PositionColumns {
  std::vector<double> longitude, latitude, x, y, z;
  void add(const Position& p) {
    longitude.push_back(p.longitude_rad); latitude.push_back(p.latitude_rad);
    x.push_back(p.x_mpc); y.push_back(p.y_mpc); z.push_back(p.z_mpc);
  }
  void emit(wire::Result& r) const {
    r.vector("supergalactic_longitude_rad", longitude, "rad");
    r.vector("supergalactic_latitude_rad", latitude, "rad");
    r.vector("sgx_comoving_mpc", x, "Mpc"); r.vector("sgy_comoving_mpc", y, "Mpc");
    r.vector("sgz_comoving_mpc", z, "Mpc");
  }
};
} // namespace cosmology

extern "C" int distances() {
  using namespace cosmology;
  wire::Request request{"redshift_cmb"};
  const auto& z = request.get("redshift_cmb");
  if (!request.ok || z.empty()) return wire::fail("Expected nonempty redshift_cmb vector");
  DistanceColumns columns;
  for (double value : z) {
    if (!redshift_valid(value)) return wire::fail("Distance redshifts must be in [0,1100]");
    columns.add(cosmology::distances(value));
  }
  wire::Result result; columns.emit(result); return result.emit();
}
extern "C" int cmb_redshift() {
  using namespace cosmology;
  wire::Request request{"redshift_heliocentric", "galactic_longitude_rad", "galactic_latitude_rad"};
  const auto& z = request.get("redshift_heliocentric");
  if (!request.ok || z.empty() || !directions_valid(request, z.size())) return wire::fail("Expected matching redshift and Galactic direction vectors");
  std::vector<double> corrected;
  for (size_t i = 0; i < z.size(); ++i) {
    if (z[i] <= -1 || z[i] > max_redshift) return wire::fail("Heliocentric redshift must be in (-1,1100]");
    corrected.push_back(cosmology::cmb_redshift(z[i], request.get("galactic_longitude_rad")[i], request.get("galactic_latitude_rad")[i]));
  }
  wire::Result result; result.vector("redshift_cmb", corrected); return result.emit();
}
extern "C" int supergalactic() {
  using namespace cosmology;
  wire::Request request{"comoving_distance_mpc", "galactic_longitude_rad", "galactic_latitude_rad"};
  const auto& d = request.get("comoving_distance_mpc");
  if (!request.ok || d.empty() || !directions_valid(request, d.size())) return wire::fail("Expected matching comoving distance and Galactic direction vectors");
  PositionColumns columns;
  for (size_t i = 0; i < d.size(); ++i) {
    if (d[i] < 0) return wire::fail("Comoving distance must be nonnegative");
    columns.add(to_supergalactic(request.get("galactic_longitude_rad")[i], request.get("galactic_latitude_rad")[i], d[i]));
  }
  wire::Result result; columns.emit(result); return result.emit();
}
extern "C" int place() {
  using namespace cosmology;
  wire::Request request{"redshift_cmb", "galactic_longitude_rad", "galactic_latitude_rad",
    "cf4_luminosity_distance_mpc", "tempel2017_group_id", "tempel2017_group_redshift_cmb"};
  const auto& z = request.get("redshift_cmb");
  const bool cf4 = request.has("cf4_luminosity_distance_mpc"), groups = request.has("tempel2017_group_id");
  if (!request.ok || z.empty() || !directions_valid(request, z.size()) ||
      !request.length("cf4_luminosity_distance_mpc", z.size(), false) ||
      !request.length("tempel2017_group_id", z.size(), false) ||
      !request.length("tempel2017_group_redshift_cmb", z.size(), groups) ||
      groups != request.has("tempel2017_group_redshift_cmb")) return wire::fail("Expected matching placement vectors and paired Tempel group IDs/redshifts");
  DistanceColumns distances; PositionColumns positions; std::vector<double> sources, placement_z;
  std::map<unsigned, double> group_redshifts;
  const double max_luminosity = comoving(max_redshift) * (1 + max_redshift);
  for (size_t i = 0; i < z.size(); ++i) {
    const double measured = cf4 ? request.get("cf4_luminosity_distance_mpc")[i] : 0;
    const double id = groups ? request.get("tempel2017_group_id")[i] : 0;
    const double group_z = groups ? request.get("tempel2017_group_redshift_cmb")[i] : 0;
    if (z[i] <= -1 || z[i] > max_redshift || measured < 0 || measured > max_luminosity ||
        id < 0 || id > 88662 || std::floor(id) != id ||
        (id > 0 && !redshift_valid(group_z)) || (id == 0 && group_z != 0) ||
        (measured == 0 && id == 0 && !redshift_valid(z[i]))) return wire::fail("Invalid redshift, luminosity distance or published group assignment");
    if (id > 0) {
      const auto entry = group_redshifts.emplace(static_cast<unsigned>(id), group_z);
      if (!entry.second && entry.first->second != group_z)
        return wire::fail("Members of the same Tempel group must carry the same published group redshift");
    }
    const auto p = cosmology::place(z[i], measured, id > 0, group_z);
    placement_z.push_back(p.redshift); sources.push_back(static_cast<int>(p.source)); distances.add(p.distance);
    positions.add(to_supergalactic(request.get("galactic_longitude_rad")[i], request.get("galactic_latitude_rad")[i], p.distance.comoving_mpc));
  }
  wire::Result result; distances.emit(result); positions.emit(result);
  result.vector("placement_redshift_cmb", placement_z); result.vector("distance_source", sources);
  return result.emit();
}
