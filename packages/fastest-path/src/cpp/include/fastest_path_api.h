#ifndef FASTEST_PATH_API_H
#define FASTEST_PATH_API_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int32_t plugin_init(const uint8_t* data, size_t len);
void plugin_destroy(void);

int32_t graph_create(uint32_t num_vertices);
int32_t graph_add_edge(uint32_t src, uint32_t dst, double weight);
int32_t graph_add_edges_bulk(const uint8_t* edge_buffer, uint32_t edge_count);
int32_t graph_build(void);
int32_t graph_load_csr(
  const uint32_t* offsets,
  const uint32_t* destinations,
  const double* weights,
  uint32_t num_vertices,
  uint32_t num_edges
);
int32_t compute_sssp(uint32_t source_vertex, uint32_t algorithm_hint);
double* get_distances(void);
uint32_t* get_predecessors(void);
uint32_t get_vertex_count(void);
uint32_t get_edge_count(void);
int32_t reconstruct_path(uint32_t target_vertex, uint32_t* path_out, uint32_t max_len);

uint32_t fastest_path_get_source_vertex(void);
int32_t fastest_path_has_solution(void);

int fastest_path_create_graph(void);
int fastest_path_ingest_edges(void);
int fastest_path_ingest_csr(void);
int fastest_path_compute_shortest_paths(void);
int fastest_path_reconstruct_path(void);

#ifdef __cplusplus
}
#endif

#endif
