using namespace sdn_hypersonics;

namespace {

struct Interval {
  double start = 0.0;
  double stop = 0.0;
};

struct Footprint {
  int sensorId = 0;
  double start = 0.0;
  double stop = 0.0;
  double minLat = 0.0;
  double maxLat = 0.0;
  double minLon = 0.0;
  double maxLon = 0.0;
};

struct Cell {
  int index = 0;
  int row = 0;
  int column = 0;
  double latitude = 0.0;
  double longitude = 0.0;
  std::vector<Interval> intervals;
  uint32_t sensorMask = 0;
  double totalAccess = 0.0;
  double maxGap = 0.0;
  double meanRevisit = 0.0;
  int accessCount = 0;
  int revisitCount = 0;
};

struct GridConfig {
  double minLat = -90.0;
  double maxLat = 90.0;
  double minLon = -180.0;
  double maxLon = 180.0;
  double latStep = 1.0;
  double lonStep = 1.0;
  double start = 0.0;
  double stop = 86400.0;
  int rows = 0;
  int columns = 0;
};

double clamp(double value, double min_value, double max_value) {
  return std::max(min_value, std::min(max_value, value));
}

GridConfig parse_grid(const std::string& request) {
  const std::string grid = object_value(request, "grid");
  const std::string time_span = object_value(request, "timeSpan");
  GridConfig config{};
  config.minLat = number_value(grid, "minLatitudeDeg", 0.0);
  config.maxLat = number_value(grid, "maxLatitudeDeg", 2.0);
  config.minLon = number_value(grid, "minLongitudeDeg", 0.0);
  config.maxLon = number_value(grid, "maxLongitudeDeg", 3.0);
  config.latStep = std::max(0.01, number_value(grid, "latitudeStepDeg", 1.0));
  config.lonStep = std::max(0.01, number_value(grid, "longitudeStepDeg", 1.0));
  config.start = number_value(time_span, "startSeconds", 0.0);
  config.stop = number_value(time_span, "stopSeconds", 3600.0);
  config.rows = std::max(1, static_cast<int>(std::ceil((config.maxLat - config.minLat) / config.latStep)));
  config.columns = std::max(1, static_cast<int>(std::ceil((config.maxLon - config.minLon) / config.lonStep)));
  return config;
}

std::vector<Cell> create_cells(const GridConfig& grid) {
  std::vector<Cell> cells;
  cells.reserve(static_cast<size_t>(grid.rows * grid.columns));
  int index = 0;
  for (int row = 0; row < grid.rows; ++row) {
    for (int column = 0; column < grid.columns; ++column) {
      Cell cell{};
      cell.index = index++;
      cell.row = row;
      cell.column = column;
      cell.latitude = grid.minLat + (row + 0.5) * grid.latStep;
      cell.longitude = grid.minLon + (column + 0.5) * grid.lonStep;
      cells.push_back(cell);
    }
  }
  return cells;
}

std::vector<Footprint> parse_footprints(const std::string& request) {
  std::vector<Footprint> footprints;
  const auto objects = object_array(request, "footprints");
  footprints.reserve(objects.size());
  for (const auto& object : objects) {
    Footprint footprint{};
    footprint.sensorId = static_cast<int>(number_value(object, "sensorId", 0));
    footprint.start = number_value(object, "startSeconds", 0.0);
    footprint.stop = number_value(object, "stopSeconds", footprint.start);
    footprint.minLat = number_value(object, "minLatitudeDeg", -90.0);
    footprint.maxLat = number_value(object, "maxLatitudeDeg", 90.0);
    footprint.minLon = number_value(object, "minLongitudeDeg", -180.0);
    footprint.maxLon = number_value(object, "maxLongitudeDeg", 180.0);
    if (footprint.stop > footprint.start) {
      footprints.push_back(footprint);
    }
  }
  return footprints;
}

bool contains(const Footprint& footprint, const Cell& cell) {
  return cell.latitude >= footprint.minLat &&
    cell.latitude < footprint.maxLat &&
    cell.longitude >= footprint.minLon &&
    cell.longitude < footprint.maxLon;
}

void merge_intervals(Cell& cell, double scenario_start, double scenario_stop) {
  if (cell.intervals.empty()) {
    return;
  }
  std::sort(cell.intervals.begin(), cell.intervals.end(), [](const Interval& left, const Interval& right) {
    return left.start < right.start;
  });
  std::vector<Interval> merged;
  for (const auto& interval : cell.intervals) {
    const Interval clipped{
      clamp(interval.start, scenario_start, scenario_stop),
      clamp(interval.stop, scenario_start, scenario_stop),
    };
    if (clipped.stop <= clipped.start) {
      continue;
    }
    if (merged.empty() || clipped.start > merged.back().stop) {
      merged.push_back(clipped);
    } else {
      merged.back().stop = std::max(merged.back().stop, clipped.stop);
    }
  }
  cell.intervals = merged;
}

void update_cell_statistics(Cell& cell, const GridConfig& grid) {
  merge_intervals(cell, grid.start, grid.stop);
  cell.accessCount = static_cast<int>(cell.intervals.size());
  cell.revisitCount = std::max(0, cell.accessCount - 1);
  cell.totalAccess = 0.0;
  double gap_sum = 0.0;
  for (size_t index = 0; index < cell.intervals.size(); ++index) {
    cell.totalAccess += cell.intervals[index].stop - cell.intervals[index].start;
    if (index > 0) {
      const double gap = cell.intervals[index].start - cell.intervals[index - 1].stop;
      cell.maxGap = std::max(cell.maxGap, gap);
      gap_sum += gap;
    }
  }
  cell.meanRevisit = cell.revisitCount > 0 ? gap_sum / cell.revisitCount : 0.0;
}

std::string color_json(double percent) {
  const double u = clamp(percent / 100.0, 0.0, 1.0);
  const int red = static_cast<int>(std::round(255.0 * u));
  const int green = static_cast<int>(std::round(220.0 * (1.0 - std::fabs(u - 0.5) * 2.0)));
  const int blue = static_cast<int>(std::round(255.0 * (1.0 - u)));
  const int alpha = percent > 0.0 ? 205 : 45;
  char buffer[128];
  std::snprintf(buffer, sizeof(buffer), "[%d,%d,%d,%d]", red, green, blue, alpha);
  return buffer;
}

std::string cells_json(const std::vector<Cell>& cells, double duration) {
  std::string output = "[";
  for (size_t index = 0; index < cells.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    const auto& cell = cells[index];
    const double percent = duration > 0.0 ? 100.0 * cell.totalAccess / duration : 0.0;
    char buffer[1024];
    std::snprintf(
      buffer,
      sizeof(buffer),
      "{\"index\":%d,\"row\":%d,\"column\":%d,\"latitudeDeg\":%.12g,"
      "\"longitudeDeg\":%.12g,\"accessCount\":%d,\"revisitCount\":%d,"
      "\"totalAccessDurationSec\":%.12g,\"percentCoverage\":%.12g,"
      "\"maxGapDurationSec\":%.12g,\"meanRevisitTimeSec\":%.12g,"
      "\"sensorMask\":%u,\"colorRgba\":%s}",
      cell.index,
      cell.row,
      cell.column,
      cell.latitude,
      cell.longitude,
      cell.accessCount,
      cell.revisitCount,
      cell.totalAccess,
      percent,
      cell.maxGap,
      cell.meanRevisit,
      cell.sensorMask,
      color_json(percent).c_str());
    output += buffer;
  }
  output += "]";
  return output;
}

std::string fom_json(const std::vector<Cell>& cells, const std::string& fom_type, double duration) {
  std::string values = "[";
  for (size_t index = 0; index < cells.size(); ++index) {
    if (index > 0) {
      values += ",";
    }
    const auto& cell = cells[index];
    double value = cell.totalAccess;
    std::string units = "seconds";
    if (fom_type == "access_count") {
      value = cell.accessCount;
      units = "count";
    } else if (fom_type == "percent_coverage") {
      value = duration > 0.0 ? 100.0 * cell.totalAccess / duration : 0.0;
      units = "percent";
    } else if (fom_type == "max_gap_duration") {
      value = cell.maxGap;
      units = "seconds";
    } else if (fom_type == "mean_revisit_time") {
      value = cell.meanRevisit;
      units = "seconds";
    }
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.12g", value);
    values += buffer;
    if (index + 1 == cells.size()) {
      return "{\"type\":" + quote(fom_type) + ",\"units\":" + quote(units) + ",\"values\":" + values + "]}";
    }
  }
  return "{\"type\":" + quote(fom_type) + ",\"units\":\"seconds\",\"values\":[]}";
}

std::string swaths_json(const std::vector<Cell>& cells, const GridConfig& grid, double duration) {
  std::string output = "[";
  bool first = true;
  for (const auto& cell : cells) {
    if (cell.totalAccess <= 0.0) {
      continue;
    }
    if (!first) {
      output += ",";
    }
    first = false;
    const double percent = duration > 0.0 ? 100.0 * cell.totalAccess / duration : 0.0;
    char buffer[1024];
    std::snprintf(
      buffer,
      sizeof(buffer),
      "{\"cellIndex\":%d,\"totalAccessDurationSec\":%.12g,\"percentCoverage\":%.12g,"
      "\"colorRgba\":%s,\"vertices\":["
      "{\"latitudeDeg\":%.12g,\"longitudeDeg\":%.12g},"
      "{\"latitudeDeg\":%.12g,\"longitudeDeg\":%.12g},"
      "{\"latitudeDeg\":%.12g,\"longitudeDeg\":%.12g},"
      "{\"latitudeDeg\":%.12g,\"longitudeDeg\":%.12g}]}",
      cell.index,
      cell.totalAccess,
      percent,
      color_json(percent).c_str(),
      cell.latitude - grid.latStep * 0.5,
      cell.longitude - grid.lonStep * 0.5,
      cell.latitude - grid.latStep * 0.5,
      cell.longitude + grid.lonStep * 0.5,
      cell.latitude + grid.latStep * 0.5,
      cell.longitude + grid.lonStep * 0.5,
      cell.latitude + grid.latStep * 0.5,
      cell.longitude - grid.lonStep * 0.5);
    output += buffer;
  }
  output += "]";
  return output;
}

}  // namespace

extern "C" int compute_sensor_coverage(void) {
  plugin_reset_output_state();

  const std::string request = payload_for_port("coverage");
  if (request.empty()) {
    return fail("missing-coverage", "Input port \"coverage\" is required.");
  }

  const GridConfig grid = parse_grid(request);
  if (!(grid.stop > grid.start)) {
    return fail("invalid-time-span", "Coverage stopSeconds must be greater than startSeconds.");
  }

  const std::vector<Footprint> footprints = parse_footprints(request);
  if (footprints.empty()) {
    return fail("missing-footprints", "Coverage request must include at least one footprint.");
  }

  std::vector<Cell> cells = create_cells(grid);
  for (const auto& footprint : footprints) {
    for (auto& cell : cells) {
      if (!contains(footprint, cell)) {
        continue;
      }
      cell.intervals.push_back({footprint.start, footprint.stop});
      if (footprint.sensorId >= 0 && footprint.sensorId < 32) {
        cell.sensorMask |= static_cast<uint32_t>(1u << footprint.sensorId);
      }
    }
  }

  int accessed = 0;
  int multi_access = 0;
  double total_access = 0.0;
  for (auto& cell : cells) {
    update_cell_statistics(cell, grid);
    if (cell.totalAccess > 0.0) {
      ++accessed;
      total_access += cell.totalAccess;
    }
    if (cell.sensorMask != 0 && (cell.sensorMask & (cell.sensorMask - 1u)) != 0) {
      ++multi_access;
    }
  }

  const double duration = grid.stop - grid.start;
  const std::string fom_type = string_value(request, "figureOfMerit", "percent_coverage");
  char header[2048];
  std::snprintf(
    header,
    sizeof(header),
    "{\"provider\":\"sensor-coverage-analysis\",\"status\":\"nominal\","
    "\"grid\":{\"rows\":%d,\"columns\":%d,\"cellCount\":%zu,"
    "\"latitudeStepDeg\":%.12g,\"longitudeStepDeg\":%.12g},"
    "\"statistics\":{\"totalCells\":%zu,\"accessedCells\":%d,\"multiAccessCells\":%d,"
    "\"totalAccessDurationSec\":%.12g,\"percentCoverage\":%.12g},",
    grid.rows,
    grid.columns,
    cells.size(),
    grid.latStep,
    grid.lonStep,
    cells.size(),
    accessed,
    multi_access,
    total_access,
    cells.empty() ? 0.0 : 100.0 * static_cast<double>(accessed) / static_cast<double>(cells.size()));

  std::string response = std::string(header) +
    "\"cells\":" + cells_json(cells, duration) + "," +
    "\"figureOfMerit\":" + fom_json(cells, fom_type, duration) + "," +
    "\"swaths\":" + swaths_json(cells, grid, duration) + "," +
    "\"assumptions\":[\"input footprints are module-owned coverage intervals\","
    "\"cell values represent merged time coverage over the requested time span\","
    "\"stk_coverage colors are derived from percent coverage\"]}";

  return emit_json("coverage", "TAB.fbs", "$TAB", response);
}
