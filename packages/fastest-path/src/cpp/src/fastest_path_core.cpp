#include "fastest_path_api.h"

#include "csr_graph.h"
#include "orbpro_plugin.h"
#include "sssp_solver.h"

#include <vector>

namespace {

struct BulkEdgeRecord {
  uint32_t src;
  uint32_t dst;
  double weight;
};

bool g_initialized = false;
uint32_t g_source_vertex = 0;
CSRGraph g_graph;
SSSPSolver g_solver;

}  // namespace

extern "C" {

ORBPRO_EXPORT
int32_t plugin_init(const uint8_t* data, size_t len) {
  (void)data;
  (void)len;
  g_initialized = true;
  return 0;
}

ORBPRO_EXPORT
void plugin_destroy(void) {
  g_graph = CSRGraph();
  g_solver = SSSPSolver();
  g_source_vertex = 0;
  g_initialized = false;
}

ORBPRO_EXPORT
int32_t graph_create(uint32_t num_vertices) {
  if (num_vertices == 0) {
    return -1;
  }
  g_graph.create(num_vertices);
  g_solver = SSSPSolver();
  g_source_vertex = 0;
  g_initialized = true;
  return 0;
}

ORBPRO_EXPORT
int32_t graph_add_edge(uint32_t src, uint32_t dst, double weight) {
  if (g_graph.V == 0 || src >= g_graph.V || dst >= g_graph.V || weight < 0.0) {
    return -1;
  }
  g_graph.addEdge(src, dst, weight);
  return 0;
}

ORBPRO_EXPORT
int32_t graph_add_edges_bulk(const uint8_t* edge_buffer, uint32_t edge_count) {
  if (g_graph.V == 0 || edge_buffer == nullptr || edge_count == 0) {
    return -1;
  }

  const auto* records = reinterpret_cast<const BulkEdgeRecord*>(edge_buffer);
  uint32_t added = 0;
  for (uint32_t index = 0; index < edge_count; index += 1) {
    const auto& record = records[index];
    if (record.src < g_graph.V && record.dst < g_graph.V && record.weight >= 0.0) {
      g_graph.addEdge(record.src, record.dst, record.weight);
      added += 1;
    }
  }

  return static_cast<int32_t>(added);
}

ORBPRO_EXPORT
int32_t graph_build(void) {
  return g_graph.build();
}

ORBPRO_EXPORT
int32_t graph_load_csr(
  const uint32_t* offsets,
  const uint32_t* destinations,
  const double* weights,
  uint32_t num_vertices,
  uint32_t num_edges
) {
  if (offsets == nullptr || num_vertices == 0) {
    return -1;
  }
  if (num_edges > 0 && (destinations == nullptr || weights == nullptr)) {
    return -1;
  }

  g_graph.loadCSR(offsets, destinations, weights, num_vertices, num_edges);
  g_solver = SSSPSolver();
  g_source_vertex = 0;
  g_initialized = true;
  return 0;
}

ORBPRO_EXPORT
int32_t compute_sssp(uint32_t source_vertex, uint32_t algorithm_hint) {
  if (!g_graph.built) {
    return -1;
  }
  if (source_vertex >= g_graph.V) {
    return -2;
  }

  const int32_t result = g_solver.solve(g_graph, source_vertex, algorithm_hint);
  if (result == 0) {
    g_source_vertex = source_vertex;
  }
  return result;
}

ORBPRO_EXPORT
double* get_distances(void) {
  if (!g_solver.computed || g_solver.dist.empty()) {
    return nullptr;
  }
  return g_solver.dist.data();
}

ORBPRO_EXPORT
uint32_t* get_predecessors(void) {
  if (!g_solver.computed || g_solver.pred.empty()) {
    return nullptr;
  }
  return g_solver.pred.data();
}

ORBPRO_EXPORT
uint32_t get_vertex_count(void) {
  return g_graph.V;
}

ORBPRO_EXPORT
uint32_t get_edge_count(void) {
  return g_graph.E;
}

ORBPRO_EXPORT
int32_t reconstruct_path(uint32_t target_vertex, uint32_t* path_out, uint32_t max_len) {
  return g_solver.reconstructPath(target_vertex, path_out, max_len);
}

uint32_t fastest_path_get_source_vertex(void) {
  return g_source_vertex;
}

int32_t fastest_path_has_solution(void) {
  return g_solver.computed ? 1 : 0;
}

}  // extern "C"
