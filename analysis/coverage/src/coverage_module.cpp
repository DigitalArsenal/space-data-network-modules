/*
 ISC License

 Native analytical coverage kernel for the SDK standalone C++/WASI surface.
 The binary layouts mirror the existing JS analyzer streamInvoke contract.
 */

#include "space_data_module_invoke.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

namespace {

constexpr double kSecondsPerDay = 86400.0;
constexpr uint32_t kCellAccessed = 0x01;
constexpr uint32_t kCellMultiple = 0x02;

struct Vertex {
  double lat_deg = 0.0;
  double lon_deg = 0.0;
};

struct Interval {
  double start_jd = 0.0;
  double end_jd = 0.0;
  double duration_s = 0.0;
  uint32_t flags = 0;
};

struct Cell {
  double first_access_time = 0.0;
  double last_access_time = 0.0;
  double total_access_duration = 0.0;
  double min_revisit_time = 0.0;
  double max_revisit_time = 0.0;
  double sum_revisit_time = 0.0;
  uint32_t access_count = 0;
  uint32_t revisit_count = 0;
  uint32_t flags = 0;
  uint64_t sensor_mask = 0;
  std::vector<Interval> intervals{};
};

struct GridConfig {
  double min_latitude_deg = -90.0;
  double max_latitude_deg = 90.0;
  double min_longitude_deg = -180.0;
  double max_longitude_deg = 180.0;
  double latitude_step_deg = 1.0;
  double longitude_step_deg = 1.0;
  double start_epoch_jd = 0.0;
  double end_epoch_jd = 0.0;
};

struct Grid {
  uint32_t grid_id = 0;
  GridConfig config{};
  uint32_t row_count = 0;
  uint32_t column_count = 0;
  uint32_t cell_count = 0;
  std::vector<Cell> cells{};
};

struct Footprint {
  double start_epoch_jd = 0.0;
  double end_epoch_jd = 0.0;
  uint32_t sensor_id = 0;
  std::vector<Vertex> vertices{};
};

struct Statistics {
  uint32_t total_cells = 0;
  uint32_t accessed_cells = 0;
  uint32_t multi_access_cells = 0;
  double percent_coverage = 0.0;
  double mean_access_count = 0.0;
  double mean_revisit_time = 0.0;
  double min_revisit_time = 0.0;
  double max_revisit_time = 0.0;
  double mean_gap_duration = 0.0;
  double max_gap_duration = 0.0;
  double total_access_time = 0.0;
};

struct HeatmapRequest {
  uint32_t grid_id = 0;
  uint32_t fom_id = 0;
  uint32_t color_map_id = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  double min_value = 0.0;
  double max_value = 0.0;
};

struct Color {
  uint8_t red = 0;
  uint8_t green = 0;
  uint8_t blue = 0;
};

std::vector<Grid> g_grids{};
uint32_t g_next_grid_id = 1;

double read_f64(const uint8_t* bytes, uint32_t offset) {
  double value = 0.0;
  std::memcpy(&value, bytes + offset, sizeof(value));
  return value;
}

uint32_t read_u32(const uint8_t* bytes, uint32_t offset) {
  uint32_t value = 0;
  std::memcpy(&value, bytes + offset, sizeof(value));
  return value;
}

uint64_t read_u64(const uint8_t* bytes, uint32_t offset) {
  uint64_t value = 0;
  std::memcpy(&value, bytes + offset, sizeof(value));
  return value;
}

void write_f64(std::vector<uint8_t>& bytes, uint32_t offset, double value) {
  std::memcpy(bytes.data() + offset, &value, sizeof(value));
}

void write_u32(std::vector<uint8_t>& bytes, uint32_t offset, uint32_t value) {
  std::memcpy(bytes.data() + offset, &value, sizeof(value));
}

double normalize_seconds(double seconds) {
  const double integer_seconds = std::round(seconds);
  if (std::fabs(seconds - integer_seconds) < 1.0e-4) {
    return integer_seconds;
  }
  return std::round(seconds * 1.0e6) / 1.0e6;
}

uint32_t clamp_u32(int32_t value, uint32_t min_value, uint32_t max_value) {
  if (value < static_cast<int32_t>(min_value)) {
    return min_value;
  }
  if (value > static_cast<int32_t>(max_value)) {
    return max_value;
  }
  return static_cast<uint32_t>(value);
}

uint32_t bit_count(uint64_t value) {
  uint32_t count = 0;
  while (value != 0) {
    value &= value - 1;
    count += 1;
  }
  return count;
}

double clamp_double(double value, double min_value, double max_value) {
  return std::max(min_value, std::min(max_value, value));
}

GridConfig decode_grid_config(const uint8_t* bytes) {
  GridConfig config{};
  config.min_latitude_deg = read_f64(bytes, 0);
  config.max_latitude_deg = read_f64(bytes, 8);
  config.min_longitude_deg = read_f64(bytes, 16);
  config.max_longitude_deg = read_f64(bytes, 24);
  config.latitude_step_deg = read_f64(bytes, 32);
  config.longitude_step_deg = read_f64(bytes, 40);
  config.start_epoch_jd = read_f64(bytes, 48);
  config.end_epoch_jd = read_f64(bytes, 56);
  if (!std::isfinite(config.latitude_step_deg) || config.latitude_step_deg <= 0.0) {
    config.latitude_step_deg = 1.0;
  }
  if (!std::isfinite(config.longitude_step_deg) || config.longitude_step_deg <= 0.0) {
    config.longitude_step_deg = 1.0;
  }
  return config;
}

Grid create_grid_storage(const GridConfig& config) {
  const double raw_rows =
      (config.max_latitude_deg - config.min_latitude_deg) / config.latitude_step_deg;
  const double raw_columns =
      (config.max_longitude_deg - config.min_longitude_deg) / config.longitude_step_deg;
  Grid grid{};
  grid.grid_id = g_next_grid_id++;
  grid.config = config;
  grid.row_count = std::max(1, static_cast<int>(std::llround(raw_rows)));
  grid.column_count = std::max(1, static_cast<int>(std::llround(raw_columns)));
  grid.cell_count = grid.row_count * grid.column_count;
  grid.cells.resize(grid.cell_count);
  return grid;
}

Grid* find_grid(uint32_t grid_id) {
  for (auto& grid : g_grids) {
    if (grid.grid_id == grid_id) {
      return &grid;
    }
  }
  return nullptr;
}

Vertex cell_center(const Grid& grid, uint32_t row, uint32_t column) {
  return {
      grid.config.min_latitude_deg + (static_cast<double>(row) + 0.5) *
                                         grid.config.latitude_step_deg,
      grid.config.min_longitude_deg + (static_cast<double>(column) + 0.5) *
                                          grid.config.longitude_step_deg};
}

bool point_on_segment(const Vertex& point, const Vertex& start, const Vertex& end) {
  const double cross_value =
      (point.lat_deg - start.lat_deg) * (end.lon_deg - start.lon_deg) -
      (point.lon_deg - start.lon_deg) * (end.lat_deg - start.lat_deg);
  if (std::fabs(cross_value) > 1.0e-9) {
    return false;
  }
  const double dot_value =
      (point.lon_deg - start.lon_deg) * (end.lon_deg - start.lon_deg) +
      (point.lat_deg - start.lat_deg) * (end.lat_deg - start.lat_deg);
  if (dot_value < 0.0) {
    return false;
  }
  const double length_squared =
      (end.lon_deg - start.lon_deg) * (end.lon_deg - start.lon_deg) +
      (end.lat_deg - start.lat_deg) * (end.lat_deg - start.lat_deg);
  return dot_value <= length_squared;
}

bool point_in_polygon(const Vertex& point, const std::vector<Vertex>& vertices) {
  if (vertices.size() < 3) {
    return false;
  }
  bool inside = false;
  for (size_t index = 0; index < vertices.size(); ++index) {
    const Vertex& current = vertices[index];
    const Vertex& next = vertices[(index + 1) % vertices.size()];
    if (point_on_segment(point, current, next)) {
      return true;
    }
    const bool intersects =
        (current.lat_deg > point.lat_deg) != (next.lat_deg > point.lat_deg);
    if (!intersects) {
      continue;
    }
    const double intersect_lon =
        ((next.lon_deg - current.lon_deg) * (point.lat_deg - current.lat_deg)) /
            (next.lat_deg - current.lat_deg) +
        current.lon_deg;
    if (point.lon_deg <= intersect_lon) {
      inside = !inside;
    }
  }
  return inside;
}

uint32_t merge_interval(std::vector<Interval>& intervals, double start_jd, double end_jd) {
  Interval next{};
  next.start_jd = start_jd;
  next.end_jd = end_jd;
  next.duration_s = normalize_seconds((end_jd - start_jd) * kSecondsPerDay);

  std::vector<Interval> merged{};
  bool inserted = false;
  bool touched_existing = false;

  for (const auto& interval : intervals) {
    if (interval.end_jd < next.start_jd) {
      merged.push_back(interval);
      continue;
    }
    if (next.end_jd < interval.start_jd) {
      if (!inserted) {
        merged.push_back(next);
        inserted = true;
      }
      merged.push_back(interval);
      continue;
    }
    touched_existing = true;
    next.start_jd = std::min(next.start_jd, interval.start_jd);
    next.end_jd = std::max(next.end_jd, interval.end_jd);
    next.duration_s = normalize_seconds((next.end_jd - next.start_jd) * kSecondsPerDay);
  }

  if (!inserted) {
    merged.push_back(next);
  }
  std::sort(merged.begin(), merged.end(), [](const Interval& left, const Interval& right) {
    return left.start_jd < right.start_jd;
  });
  intervals = std::move(merged);
  return touched_existing ? 0u : 1u;
}

void update_cell_metrics(Cell& cell) {
  if (cell.intervals.empty()) {
    cell = Cell{};
    return;
  }

  cell.first_access_time = cell.intervals.front().start_jd;
  cell.last_access_time = cell.intervals.back().end_jd;
  cell.total_access_duration = 0.0;
  for (const auto& interval : cell.intervals) {
    cell.total_access_duration += interval.duration_s;
  }
  cell.access_count = static_cast<uint32_t>(cell.intervals.size());
  cell.revisit_count = cell.access_count > 0 ? cell.access_count - 1 : 0;
  cell.flags = kCellAccessed;
  if (cell.access_count > 1) {
    cell.flags |= kCellMultiple;
  }

  if (cell.revisit_count == 0) {
    cell.min_revisit_time = 0.0;
    cell.max_revisit_time = 0.0;
    cell.sum_revisit_time = 0.0;
    return;
  }

  cell.min_revisit_time = std::numeric_limits<double>::infinity();
  cell.max_revisit_time = 0.0;
  cell.sum_revisit_time = 0.0;
  for (size_t index = 1; index < cell.intervals.size(); ++index) {
    const double gap = normalize_seconds(
        (cell.intervals[index].start_jd - cell.intervals[index - 1].end_jd) *
        kSecondsPerDay);
    cell.min_revisit_time = std::min(cell.min_revisit_time, gap);
    cell.max_revisit_time = std::max(cell.max_revisit_time, gap);
    cell.sum_revisit_time += gap;
  }
}

bool decode_footprint_batch(
    const uint8_t* bytes,
    uint32_t length,
    uint32_t* grid_id,
    std::vector<Footprint>* footprints) {
  if (bytes == nullptr || grid_id == nullptr || footprints == nullptr || length < 16) {
    return false;
  }
  *grid_id = read_u32(bytes, 0);
  const uint32_t footprint_count = read_u32(bytes, 4);
  uint32_t cursor = 16;
  footprints->clear();
  footprints->reserve(footprint_count);
  for (uint32_t index = 0; index < footprint_count; ++index) {
    if (cursor + 24 > length) {
      return false;
    }
    Footprint footprint{};
    footprint.start_epoch_jd = read_f64(bytes, cursor);
    footprint.end_epoch_jd = read_f64(bytes, cursor + 8);
    footprint.sensor_id = read_u32(bytes, cursor + 16);
    const uint32_t vertex_count = read_u32(bytes, cursor + 20);
    cursor += 24;
    if (vertex_count > 100000u || cursor + vertex_count * 16u > length) {
      return false;
    }
    footprint.vertices.reserve(vertex_count);
    for (uint32_t vertex_index = 0; vertex_index < vertex_count; ++vertex_index) {
      footprint.vertices.push_back({read_f64(bytes, cursor), read_f64(bytes, cursor + 8)});
      cursor += 16;
    }
    footprints->push_back(std::move(footprint));
  }
  return true;
}

HeatmapRequest decode_heatmap_request(const uint8_t* bytes) {
  HeatmapRequest request{};
  request.grid_id = read_u32(bytes, 0);
  request.fom_id = read_u32(bytes, 4);
  request.color_map_id = read_u32(bytes, 8);
  request.width = std::max(1u, read_u32(bytes, 12));
  request.height = std::max(1u, read_u32(bytes, 16));
  request.min_value = read_f64(bytes, 24);
  request.max_value = read_f64(bytes, 24);
  return request;
}

void accumulate_footprint(Grid& grid, const Footprint& footprint) {
  if (footprint.vertices.size() < 3) {
    return;
  }
  double min_lat = footprint.vertices[0].lat_deg;
  double max_lat = footprint.vertices[0].lat_deg;
  double min_lon = footprint.vertices[0].lon_deg;
  double max_lon = footprint.vertices[0].lon_deg;
  for (const auto& vertex : footprint.vertices) {
    min_lat = std::min(min_lat, vertex.lat_deg);
    max_lat = std::max(max_lat, vertex.lat_deg);
    min_lon = std::min(min_lon, vertex.lon_deg);
    max_lon = std::max(max_lon, vertex.lon_deg);
  }

  const uint32_t min_row = clamp_u32(
      static_cast<int32_t>(std::floor(
          (min_lat - grid.config.min_latitude_deg) / grid.config.latitude_step_deg)),
      0,
      grid.row_count - 1);
  const uint32_t max_row = clamp_u32(
      static_cast<int32_t>(std::floor(
          (max_lat - grid.config.min_latitude_deg) / grid.config.latitude_step_deg)),
      0,
      grid.row_count - 1);
  const uint32_t min_column = clamp_u32(
      static_cast<int32_t>(std::floor(
          (min_lon - grid.config.min_longitude_deg) / grid.config.longitude_step_deg)),
      0,
      grid.column_count - 1);
  const uint32_t max_column = clamp_u32(
      static_cast<int32_t>(std::floor(
          (max_lon - grid.config.min_longitude_deg) / grid.config.longitude_step_deg)),
      0,
      grid.column_count - 1);

  for (uint32_t row = min_row; row <= max_row; ++row) {
    for (uint32_t column = min_column; column <= max_column; ++column) {
      if (!point_in_polygon(cell_center(grid, row, column), footprint.vertices)) {
        continue;
      }
      Cell& cell = grid.cells[row * grid.column_count + column];
      merge_interval(cell.intervals, footprint.start_epoch_jd, footprint.end_epoch_jd);
      if (footprint.sensor_id < 64u) {
        cell.sensor_mask |= (uint64_t{1} << footprint.sensor_id);
      }
      update_cell_metrics(cell);
    }
  }
}

Statistics compute_statistics(const Grid& grid) {
  Statistics statistics{};
  statistics.total_cells = grid.cell_count;
  double access_count_sum = 0.0;
  double revisit_time_sum = 0.0;
  uint32_t revisit_cell_count = 0;

  for (const auto& cell : grid.cells) {
    if (cell.access_count == 0) {
      continue;
    }
    statistics.accessed_cells += 1;
    statistics.total_access_time += cell.total_access_duration;
    access_count_sum += cell.access_count;
    if (cell.access_count > 1) {
      statistics.multi_access_cells += 1;
    }
    if (cell.revisit_count > 0) {
      revisit_cell_count += 1;
      revisit_time_sum += cell.sum_revisit_time / cell.revisit_count;
      statistics.min_revisit_time =
          revisit_cell_count == 1
              ? cell.min_revisit_time
              : std::min(statistics.min_revisit_time, cell.min_revisit_time);
      statistics.max_revisit_time =
          std::max(statistics.max_revisit_time, cell.max_revisit_time);
    }
  }

  if (grid.cell_count > 0) {
    statistics.percent_coverage =
        (static_cast<double>(statistics.accessed_cells) / grid.cell_count) * 100.0;
  }
  if (statistics.accessed_cells > 0) {
    statistics.mean_access_count = access_count_sum / statistics.accessed_cells;
  }
  if (revisit_cell_count > 0) {
    statistics.mean_revisit_time = revisit_time_sum / revisit_cell_count;
  }
  statistics.mean_gap_duration = statistics.mean_revisit_time;
  statistics.max_gap_duration = statistics.max_revisit_time;
  return statistics;
}

double fom_value(const Grid& grid, uint32_t cell_index, uint32_t fom_id) {
  const Cell& cell = grid.cells[cell_index];
  switch (fom_id) {
    case 1:
      return cell.total_access_duration;
    case 2: {
      const double total_duration =
          std::max(grid.config.end_epoch_jd - grid.config.start_epoch_jd, 0.0) *
          kSecondsPerDay;
      return total_duration > 0.0
                 ? (cell.total_access_duration / total_duration) * 100.0
                 : 0.0;
    }
    case 3:
      return cell.revisit_count > 0 ? cell.sum_revisit_time / cell.revisit_count : 0.0;
    case 4:
    case 7:
      return cell.max_revisit_time;
    case 5: {
      const double total_duration =
          std::max(grid.config.end_epoch_jd - grid.config.start_epoch_jd, 0.0) *
          kSecondsPerDay;
      return cell.access_count == 0
                 ? total_duration
                 : (cell.first_access_time - grid.config.start_epoch_jd) * kSecondsPerDay;
    }
    case 6:
      return cell.revisit_count;
    case 8:
      return cell.revisit_count > 0 ? cell.sum_revisit_time / cell.revisit_count : 0.0;
    case 0:
    default:
      return cell.access_count;
  }
}

Color apply_color_map(uint32_t color_map_id, double t) {
  const double clamped = clamp_double(t, 0.0, 1.0);
  double red = 0.0;
  double green = 0.0;
  double blue = 0.0;
  switch (color_map_id) {
    case 1:
      red = clamp_double(1.5 - std::fabs(4.0 * clamped - 3.0), 0.0, 1.0) * 255.0;
      green = clamp_double(1.5 - std::fabs(4.0 * clamped - 2.0), 0.0, 1.0) * 255.0;
      blue = clamp_double(1.5 - std::fabs(4.0 * clamped - 1.0), 0.0, 1.0) * 255.0;
      break;
    case 2:
      red = clamp_double(clamped * 3.0, 0.0, 1.0) * 255.0;
      green = clamp_double(clamped * 3.0 - 1.0, 0.0, 1.0) * 255.0;
      blue = clamp_double(clamped * 3.0 - 2.0, 0.0, 1.0) * 255.0;
      break;
    case 3:
      red = clamped * 255.0;
      green = (1.0 - clamped) * 255.0;
      blue = 255.0;
      break;
    case 4:
      red = clamped * 255.0;
      green = clamped * 255.0;
      blue = clamped * 255.0;
      break;
    case 5:
      if (clamped < 0.5) {
        red = 0.0;
        green = clamped * 2.0 * 255.0;
        blue = (1.0 - clamped * 2.0) * 255.0;
      } else {
        red = (clamped - 0.5) * 2.0 * 255.0;
        green = (1.0 - (clamped - 0.5) * 2.0) * 255.0;
        blue = 0.0;
      }
      break;
    case 0:
    default:
      red = 68.0 + clamped * 185.0;
      green = 1.0 + clamped * 230.0;
      blue = 84.0 + (1.0 - clamped) * 171.0;
      break;
  }
  return {
      static_cast<uint8_t>(std::round(red)),
      static_cast<uint8_t>(std::round(green)),
      static_cast<uint8_t>(std::round(blue))};
}

std::vector<uint8_t> encode_grid_info(const Grid& grid) {
  std::vector<uint8_t> bytes(16);
  write_u32(bytes, 0, grid.grid_id);
  write_u32(bytes, 4, grid.row_count);
  write_u32(bytes, 8, grid.column_count);
  write_u32(bytes, 12, grid.cell_count);
  return bytes;
}

std::vector<uint8_t> encode_statistics(const Statistics& statistics) {
  std::vector<uint8_t> bytes(80);
  write_u32(bytes, 0, statistics.total_cells);
  write_u32(bytes, 4, statistics.accessed_cells);
  write_u32(bytes, 8, statistics.multi_access_cells);
  write_f64(bytes, 16, statistics.percent_coverage);
  write_f64(bytes, 24, statistics.mean_access_count);
  write_f64(bytes, 32, statistics.mean_revisit_time);
  write_f64(bytes, 40, statistics.min_revisit_time);
  write_f64(bytes, 48, statistics.max_revisit_time);
  write_f64(bytes, 56, statistics.max_gap_duration);
  write_f64(bytes, 64, statistics.total_access_time);
  write_f64(bytes, 72, statistics.mean_gap_duration);
  return bytes;
}

std::vector<uint8_t> encode_intervals(uint32_t grid_id, uint32_t cell_index, const Cell& cell) {
  std::vector<uint8_t> bytes(16 + cell.intervals.size() * 32);
  write_u32(bytes, 0, grid_id);
  write_u32(bytes, 4, cell_index);
  write_u32(bytes, 8, static_cast<uint32_t>(cell.intervals.size()));
  for (size_t index = 0; index < cell.intervals.size(); ++index) {
    const uint32_t base = 16 + static_cast<uint32_t>(index) * 32;
    write_f64(bytes, base, cell.intervals[index].start_jd);
    write_f64(bytes, base + 8, cell.intervals[index].end_jd);
    write_f64(bytes, base + 16, cell.intervals[index].duration_s);
    write_u32(bytes, base + 24, cell.intervals[index].flags);
  }
  return bytes;
}

std::vector<uint8_t> encode_fom(uint32_t grid_id, uint32_t fom_id, const Grid& grid) {
  std::vector<uint8_t> bytes(16 + grid.cell_count * 8);
  write_u32(bytes, 0, grid_id);
  write_u32(bytes, 4, fom_id);
  write_u32(bytes, 8, grid.cell_count);
  for (uint32_t index = 0; index < grid.cell_count; ++index) {
    write_f64(bytes, 16 + index * 8, fom_value(grid, index, fom_id));
  }
  return bytes;
}

std::vector<uint8_t> encode_heatmap(const Grid& grid, const HeatmapRequest& request) {
  uint32_t width = std::max(1u, request.width);
  uint32_t height = std::max(1u, request.height);
  double min_value = request.min_value;
  double max_value = request.max_value;
  if (!std::isfinite(min_value) || !std::isfinite(max_value)) {
    min_value = std::numeric_limits<double>::infinity();
    max_value = -std::numeric_limits<double>::infinity();
    for (uint32_t index = 0; index < grid.cell_count; ++index) {
      const double value = fom_value(grid, index, request.fom_id);
      min_value = std::min(min_value, value);
      max_value = std::max(max_value, value);
    }
  }
  if (!std::isfinite(min_value)) {
    min_value = 0.0;
  }
  if (!std::isfinite(max_value) || max_value == min_value) {
    max_value = min_value + 1.0;
  }

  std::vector<uint8_t> bytes(12 + width * height * 4);
  write_u32(bytes, 0, width);
  write_u32(bytes, 4, height);
  write_u32(bytes, 8, width * height * 4);
  for (uint32_t row = 0; row < height; ++row) {
    const uint32_t source_row = clamp_u32(
        static_cast<int32_t>(std::floor(
            (static_cast<double>(row) / height) * grid.row_count)),
        0,
        grid.row_count - 1);
    for (uint32_t column = 0; column < width; ++column) {
      const uint32_t source_column = clamp_u32(
          static_cast<int32_t>(std::floor(
              (static_cast<double>(column) / width) * grid.column_count)),
          0,
          grid.column_count - 1);
      const uint32_t cell_index = source_row * grid.column_count + source_column;
      const double value = fom_value(grid, cell_index, request.fom_id);
      const double normalized = (value - min_value) / std::max(max_value - min_value, 1.0e-9);
      const Color color = apply_color_map(request.color_map_id, normalized);
      const uint32_t pixel_index = 12 + (row * width + column) * 4;
      bytes[pixel_index] = color.red;
      bytes[pixel_index + 1] = color.green;
      bytes[pixel_index + 2] = color.blue;
      bytes[pixel_index + 3] = grid.cells[cell_index].access_count > 0 ? 255 : 0;
    }
  }
  return bytes;
}

std::vector<uint8_t> encode_union(const Grid& grid, uint64_t selected_mask) {
  uint32_t selected_count = bit_count(selected_mask);
  uint32_t union_covered_cells = 0;
  uint32_t fully_covered_cells = 0;
  uint32_t partial_coverage_cells = 0;
  uint32_t gap_cells = 0;
  double sensor_count_sum = 0.0;
  double max_gap_duration_sec = 0.0;

  for (const auto& cell : grid.cells) {
    const uint64_t overlap_mask = cell.sensor_mask & selected_mask;
    const uint32_t overlap_count = bit_count(overlap_mask);
    if (overlap_count == 0) {
      gap_cells += 1;
      continue;
    }
    union_covered_cells += 1;
    sensor_count_sum += overlap_count;
    max_gap_duration_sec = std::max(max_gap_duration_sec, cell.max_revisit_time);
    if (overlap_count == selected_count) {
      fully_covered_cells += 1;
    } else {
      partial_coverage_cells += 1;
    }
  }

  std::vector<uint8_t> bytes(56);
  write_u32(bytes, 12, union_covered_cells);
  write_u32(bytes, 16, fully_covered_cells);
  write_u32(bytes, 20, partial_coverage_cells);
  write_u32(bytes, 24, gap_cells);
  write_f64(bytes, 40, union_covered_cells > 0
                           ? sensor_count_sum / union_covered_cells
                           : 0.0);
  write_f64(bytes, 48, max_gap_duration_sec);
  return bytes;
}

const plugin_input_frame_t* find_frame(const char* port_id) {
  const uint32_t count = plugin_get_input_count();
  for (uint32_t index = 0; index < count; ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (frame != nullptr && frame->port_id != nullptr &&
        std::strcmp(frame->port_id, port_id) == 0) {
      return frame;
    }
  }
  return nullptr;
}

int emit(
    const char* schema_name,
    const char* file_identifier,
    const std::vector<uint8_t>& payload) {
  if (plugin_push_output(
          "results",
          schema_name,
          file_identifier,
          payload.data(),
          static_cast<uint32_t>(payload.size())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit coverage output frame.");
    return 1;
  }
  return 0;
}

int missing_request(const char* method) {
  plugin_set_error(method, "Coverage request is missing or too short.");
  return 3;
}

int unknown_grid(uint32_t grid_id) {
  (void)grid_id;
  plugin_set_error("unknown-grid", "Coverage grid id is not known to this module instance.");
  return 3;
}

int unsupported_method(const char* method) {
  plugin_reset_output_state();
  plugin_set_error(method, "Coverage native method is not implemented in this migration slice.");
  return 4;
}

}  // namespace

extern "C" int create_grid(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_frame("grid");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 64) {
    return missing_request("create_grid");
  }

  Grid grid = create_grid_storage(decode_grid_config(frame->payload));
  const std::vector<uint8_t> output = encode_grid_info(grid);
  g_grids.push_back(std::move(grid));
  return emit("orbpro.analysis.CoverageGridInfo", "CVGI", output);
}

extern "C" int accumulate_footprints(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_frame("footprints");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 16) {
    return missing_request("accumulate_footprints");
  }

  uint32_t grid_id = 0;
  std::vector<Footprint> footprints{};
  if (!decode_footprint_batch(frame->payload, frame->payload_length, &grid_id, &footprints)) {
    plugin_set_error("invalid-footprint-batch", "Coverage footprint batch is malformed.");
    return 3;
  }
  Grid* grid = find_grid(grid_id);
  if (grid == nullptr) {
    return unknown_grid(grid_id);
  }
  for (const auto& footprint : footprints) {
    accumulate_footprint(*grid, footprint);
  }
  return 0;
}

extern "C" int get_statistics(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_frame("grid");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 4) {
    return missing_request("get_statistics");
  }
  Grid* grid = find_grid(read_u32(frame->payload, 0));
  if (grid == nullptr) {
    return unknown_grid(0);
  }
  return emit(
      "orbpro.analysis.CoverageStatisticsResult",
      "CVST",
      encode_statistics(compute_statistics(*grid)));
}

extern "C" int get_access_intervals(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_frame("cell");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    return missing_request("get_access_intervals");
  }
  const uint32_t grid_id = read_u32(frame->payload, 0);
  const uint32_t cell_index = read_u32(frame->payload, 4);
  Grid* grid = find_grid(grid_id);
  if (grid == nullptr) {
    return unknown_grid(grid_id);
  }
  if (cell_index >= grid->cell_count) {
    plugin_set_error("invalid-cell", "Coverage cell index is outside the grid.");
    return 3;
  }
  return emit(
      "orbpro.analysis.CoverageIntervalsResult",
      "CVIR",
      encode_intervals(grid_id, cell_index, grid->cells[cell_index]));
}

extern "C" int compute_fom(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_frame("grid");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    return missing_request("compute_fom");
  }
  const uint32_t grid_id = read_u32(frame->payload, 0);
  const uint32_t fom_id = read_u32(frame->payload, 4);
  Grid* grid = find_grid(grid_id);
  if (grid == nullptr) {
    return unknown_grid(grid_id);
  }
  return emit("orbpro.analysis.CoverageFomResult", "CVFR", encode_fom(grid_id, fom_id, *grid));
}

extern "C" int generate_heatmap(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_frame("heatmap");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 32) {
    return missing_request("generate_heatmap");
  }
  const HeatmapRequest request = decode_heatmap_request(frame->payload);
  Grid* grid = find_grid(request.grid_id);
  if (grid == nullptr) {
    return unknown_grid(request.grid_id);
  }
  return emit("orbpro.analysis.CoverageHeatmapResult", "CVHR", encode_heatmap(*grid, request));
}

extern "C" int analyze_sensor_union(void) {
  plugin_reset_output_state();
  const plugin_input_frame_t* frame = find_frame("union");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 16) {
    return missing_request("analyze_sensor_union");
  }
  const uint32_t grid_id = read_u32(frame->payload, 0);
  const uint64_t selected_mask = read_u64(frame->payload, 8);
  Grid* grid = find_grid(grid_id);
  if (grid == nullptr) {
    return unknown_grid(grid_id);
  }
  return emit("orbpro.analysis.CoverageUnionResult", "CVUR", encode_union(*grid, selected_mask));
}
