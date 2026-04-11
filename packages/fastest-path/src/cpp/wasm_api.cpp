#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#include "fastest_path_api.h"
#include "fastest_path_plugin_manifest_bytes.h"
#include "space_data_module_invoke.h"

#include <flatbuffers/flatbuffers.h>
#include "FastestPath_generated.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

namespace {

constexpr const char* kGraphSchema = "orbpro.analysis.GraphDefinition";
constexpr const char* kEdgeSchema = "orbpro.analysis.WeightedEdgeList";
constexpr const char* kCsrSchema = "orbpro.analysis.CSRGraph";
constexpr const char* kShortestPathRequestSchema = "orbpro.analysis.ShortestPathRequest";
constexpr const char* kShortestPathResultSchema = "orbpro.analysis.ShortestPathResult";
constexpr const char* kPathRequestSchema = "orbpro.analysis.PathRequest";
constexpr const char* kPathResultSchema = "orbpro.analysis.PathResult";

const plugin_input_frame_t* find_input_frame(const char* port_id, uint32_t ordinal = 0) {
  if (!port_id || !port_id[0]) {
    return nullptr;
  }
  const int32_t index = plugin_find_input_index(port_id, ordinal);
  return index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
}

uint32_t count_input_frames(const char* port_id) {
  uint32_t count = 0;
  while (find_input_frame(port_id, count) != nullptr) {
    count += 1;
  }
  return count;
}

bool verify_buffer(
  const uint8_t* payload,
  uint32_t payload_length,
  const char* identifier,
  const char* error_code,
  const char* error_message,
  bool (*verify_fn)(flatbuffers::Verifier&)
) {
  if (!payload || payload_length == 0) {
    plugin_set_error(error_code, error_message);
    return false;
  }
  flatbuffers::Verifier verifier(payload, payload_length);
  if (!verify_fn(verifier)) {
    plugin_set_error(error_code, error_message);
    return false;
  }
  (void)identifier;
  return true;
}

bool verify_graph_definition(flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<orbpro::analysis::GraphDefinition>("FGDF");
}

bool verify_edge_list(flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<orbpro::analysis::WeightedEdgeList>("FELT");
}

bool verify_csr_graph(flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<orbpro::analysis::CSRGraph>("FCSR");
}

bool verify_shortest_path_request(flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<orbpro::analysis::ShortestPathRequest>("FSPR");
}

bool verify_path_request(flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<orbpro::analysis::PathRequest>("FPTR");
}

int32_t push_flatbuffer_output(
  const char* port_id,
  const char* schema_name,
  const char* file_identifier,
  const uint8_t* payload,
  uint32_t payload_length
) {
  return plugin_push_output_typed(
    port_id,
    schema_name,
    file_identifier,
    static_cast<uint32_t>(PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER),
    nullptr,
    0,
    payload_length,
    8,
    payload,
    payload_length
  );
}

bool emit_shortest_path_result(void) {
  if (!fastest_path_has_solution()) {
    plugin_set_error("no-solution", "Shortest paths have not been computed.");
    return false;
  }

  const uint32_t vertex_count = get_vertex_count();
  const double* distances_ptr = get_distances();
  const uint32_t* predecessors_ptr = get_predecessors();
  if (vertex_count == 0 || !distances_ptr || !predecessors_ptr) {
    plugin_set_error("no-solution", "Solver state is unavailable.");
    return false;
  }

  std::vector<double> distances(distances_ptr, distances_ptr + vertex_count);
  std::vector<uint32_t> predecessors(predecessors_ptr, predecessors_ptr + vertex_count);
  uint32_t reachable_count = 0;
  for (double distance : distances) {
    if (std::isfinite(distance)) {
      reachable_count += 1;
    }
  }

  flatbuffers::FlatBufferBuilder builder(1024);
  const auto distances_offset = builder.CreateVector(distances);
  const auto predecessors_offset = builder.CreateVector(predecessors);
  const auto result = orbpro::analysis::CreateShortestPathResult(
    builder,
    fastest_path_get_source_vertex(),
    vertex_count,
    reachable_count,
    distances_offset,
    predecessors_offset
  );
  builder.Finish(result, "FSPS");

  return push_flatbuffer_output(
           "results",
           kShortestPathResultSchema,
           "FSPS",
           builder.GetBufferPointer(),
           static_cast<uint32_t>(builder.GetSize())
         ) >= 0;
}

bool emit_path_result(uint32_t target_vertex) {
  if (!fastest_path_has_solution()) {
    plugin_set_error("no-solution", "Shortest paths have not been computed.");
    return false;
  }

  const uint32_t vertex_count = get_vertex_count();
  const double* distances_ptr = get_distances();
  if (vertex_count == 0 || !distances_ptr) {
    plugin_set_error("no-solution", "Solver state is unavailable.");
    return false;
  }

  std::vector<uint32_t> reversed_path(vertex_count > 0 ? vertex_count : 1, UINT32_MAX);
  const int32_t path_length = reconstruct_path(
    target_vertex,
    reversed_path.data(),
    static_cast<uint32_t>(reversed_path.size())
  );

  const bool reachable = path_length > 0;
  std::vector<uint32_t> path;
  if (reachable) {
    path.reserve(static_cast<size_t>(path_length));
    for (int32_t index = path_length - 1; index >= 0; index -= 1) {
      path.push_back(reversed_path[static_cast<size_t>(index)]);
    }
  }

  const double distance =
    target_vertex < vertex_count
      ? distances_ptr[target_vertex]
      : std::numeric_limits<double>::infinity();

  flatbuffers::FlatBufferBuilder builder(512);
  const auto path_offset = builder.CreateVector(path);
  const auto result = orbpro::analysis::CreatePathResult(
    builder,
    fastest_path_get_source_vertex(),
    target_vertex,
    reachable,
    distance,
    path_offset
  );
  builder.Finish(result, "FPTH");

  return push_flatbuffer_output(
           "path",
           kPathResultSchema,
           "FPTH",
           builder.GetBufferPointer(),
           static_cast<uint32_t>(builder.GetSize())
         ) >= 0;
}

}  // namespace

extern "C" void __wasm_call_ctors(void);

extern "C" {

EMSCRIPTEN_KEEPALIVE
void _initialize(void) {
  static bool initialized = false;
  if (!initialized) {
    initialized = true;
    __wasm_call_ctors();
  }
}

EMSCRIPTEN_KEEPALIVE
const uint8_t* plugin_get_manifest_flatbuffer(void) {
  return fastest_path_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
  return static_cast<uint32_t>(fastest_path_plugin_manifest_bytes_size);
}

int fastest_path_create_graph(void) {
  plugin_reset_output_state();

  const uint32_t graph_inputs = count_input_frames("graph");
  if (graph_inputs == 0) {
    plugin_set_error("missing-input", "Input port \"graph\" is required.");
    return 1;
  }

  for (uint32_t index = 0; index < graph_inputs; index += 1) {
    const auto* frame = find_input_frame("graph", index);
    if (!frame || !verify_buffer(
          frame->payload,
          frame->payload_length,
          "FGDF",
          "invalid-graph-definition",
          "Input port \"graph\" must contain GraphDefinition FlatBuffers.",
          &verify_graph_definition
        )) {
      return 1;
    }

    const auto* definition = flatbuffers::GetRoot<orbpro::analysis::GraphDefinition>(frame->payload);
    if (!definition || definition->vertex_count() == 0) {
      plugin_set_error("invalid-graph-definition", "GraphDefinition must declare a positive vertex_count.");
      return 1;
    }
    if (graph_create(definition->vertex_count()) != 0) {
      plugin_set_error("graph-create-failed", "Failed to initialize graph state.");
      return 1;
    }
  }

  return 0;
}

int fastest_path_ingest_edges(void) {
  plugin_reset_output_state();

  const uint32_t edge_inputs = count_input_frames("edges");
  if (edge_inputs == 0) {
    plugin_set_error("missing-input", "Input port \"edges\" is required.");
    return 1;
  }

  for (uint32_t index = 0; index < edge_inputs; index += 1) {
    const auto* frame = find_input_frame("edges", index);
    if (!frame || !verify_buffer(
          frame->payload,
          frame->payload_length,
          "FELT",
          "invalid-edge-list",
          "Input port \"edges\" must contain WeightedEdgeList FlatBuffers.",
          &verify_edge_list
        )) {
      return 1;
    }

    const auto* edge_list = flatbuffers::GetRoot<orbpro::analysis::WeightedEdgeList>(frame->payload);
    if (!edge_list) {
      plugin_set_error("invalid-edge-list", "WeightedEdgeList payload is null.");
      return 1;
    }

    if (edge_list->vertex_count() > 0 &&
        (get_vertex_count() == 0 || get_vertex_count() != edge_list->vertex_count())) {
      if (graph_create(edge_list->vertex_count()) != 0) {
        plugin_set_error("graph-create-failed", "Failed to initialize graph storage.");
        return 1;
      }
    }
    if (get_vertex_count() == 0) {
      plugin_set_error(
        "graph-not-initialized",
        "ingest_edges requires a graph to exist or a vertex_count on the edge list."
      );
      return 1;
    }

    const auto* edges = edge_list->edges();
    if (edges) {
      for (flatbuffers::uoffset_t edge_index = 0; edge_index < edges->size(); edge_index += 1) {
        const auto* edge = edges->Get(edge_index);
        if (!edge) {
          continue;
        }
        if (graph_add_edge(edge->src(), edge->dst(), edge->weight()) != 0) {
          plugin_set_error("invalid-edge", "WeightedEdgeList contains an invalid edge.");
          return 1;
        }
      }
    }

    if (edge_list->build_graph() && graph_build() != 0) {
      plugin_set_error("graph-build-failed", "Failed to build CSR graph state.");
      return 1;
    }
  }

  return 0;
}

int fastest_path_ingest_csr(void) {
  plugin_reset_output_state();

  const uint32_t csr_inputs = count_input_frames("csr");
  if (csr_inputs == 0) {
    plugin_set_error("missing-input", "Input port \"csr\" is required.");
    return 1;
  }

  for (uint32_t index = 0; index < csr_inputs; index += 1) {
    const auto* frame = find_input_frame("csr", index);
    if (!frame || !verify_buffer(
          frame->payload,
          frame->payload_length,
          "FCSR",
          "invalid-csr-graph",
          "Input port \"csr\" must contain CSRGraph FlatBuffers.",
          &verify_csr_graph
        )) {
      return 1;
    }

    const auto* csr = flatbuffers::GetRoot<orbpro::analysis::CSRGraph>(frame->payload);
    if (!csr || csr->vertex_count() == 0 || !csr->offsets() || !csr->destinations() || !csr->weights()) {
      plugin_set_error("invalid-csr-graph", "CSRGraph payload is incomplete.");
      return 1;
    }
    if (csr->offsets()->size() != csr->vertex_count() + 1) {
      plugin_set_error("invalid-csr-graph", "CSRGraph offsets length must equal vertex_count + 1.");
      return 1;
    }
    if (csr->destinations()->size() != csr->weights()->size()) {
      plugin_set_error("invalid-csr-graph", "CSRGraph destinations and weights must have matching lengths.");
      return 1;
    }

    if (graph_load_csr(
          csr->offsets()->data(),
          csr->destinations()->size() > 0 ? csr->destinations()->data() : nullptr,
          csr->weights()->size() > 0 ? csr->weights()->data() : nullptr,
          csr->vertex_count(),
          csr->destinations()->size()
        ) != 0) {
      plugin_set_error("csr-load-failed", "Failed to load CSR graph into solver state.");
      return 1;
    }
  }

  return 0;
}

int fastest_path_compute_shortest_paths(void) {
  plugin_reset_output_state();

  const uint32_t request_inputs = count_input_frames("request");
  if (request_inputs == 0) {
    plugin_set_error("missing-input", "Input port \"request\" is required.");
    return 1;
  }

  for (uint32_t index = 0; index < request_inputs; index += 1) {
    const auto* frame = find_input_frame("request", index);
    if (!frame || !verify_buffer(
          frame->payload,
          frame->payload_length,
          "FSPR",
          "invalid-request",
          "Input port \"request\" must contain ShortestPathRequest FlatBuffers.",
          &verify_shortest_path_request
        )) {
      return 1;
    }

    const auto* request = flatbuffers::GetRoot<orbpro::analysis::ShortestPathRequest>(frame->payload);
    if (!request) {
      plugin_set_error("invalid-request", "ShortestPathRequest payload is null.");
      return 1;
    }
    if (compute_sssp(request->source(), static_cast<uint32_t>(request->algorithm_hint())) != 0) {
      plugin_set_error("solve-failed", "Failed to compute shortest paths.");
      return 1;
    }
    if (!emit_shortest_path_result()) {
      return 1;
    }
  }

  return 0;
}

int fastest_path_reconstruct_path(void) {
  plugin_reset_output_state();

  const uint32_t request_inputs = count_input_frames("request");
  if (request_inputs == 0) {
    plugin_set_error("missing-input", "Input port \"request\" is required.");
    return 1;
  }

  for (uint32_t index = 0; index < request_inputs; index += 1) {
    const auto* frame = find_input_frame("request", index);
    if (!frame || !verify_buffer(
          frame->payload,
          frame->payload_length,
          "FPTR",
          "invalid-request",
          "Input port \"request\" must contain PathRequest FlatBuffers.",
          &verify_path_request
        )) {
      return 1;
    }

    const auto* request = flatbuffers::GetRoot<orbpro::analysis::PathRequest>(frame->payload);
    if (!request) {
      plugin_set_error("invalid-request", "PathRequest payload is null.");
      return 1;
    }
    if (!emit_path_result(request->target())) {
      return 1;
    }
  }

  return 0;
}

}  // extern "C"
