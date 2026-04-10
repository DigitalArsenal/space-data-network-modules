// fastest_path_plugin.cpp - Fastest Path (SSSP) Plugin for OrbPro
// =============================================================================
// Implements single-source shortest paths using the "Breaking the Sorting
// Barrier" algorithm (O(E * (log V)^{2/3})) for sparse graphs, with a
// standard Dijkstra fallback for dense/small graphs.
//
// Exports:
//   graph_create(num_vertices)                  → create empty graph
//   graph_add_edge(src, dst, weight)            → add single edge
//   graph_add_edges_bulk(buffer, count)         → bulk-add from packed buffer
//   graph_build()                               → build CSR from edges
//   graph_load_csr(off, dst, w, V, E)           → load pre-built CSR
//   compute_sssp(source, algo_hint)             → run SSSP
//   get_distances()                             → pointer to dist[] array
//   get_predecessors()                          → pointer to pred[] array
//   get_vertex_count()                          → number of vertices
//   get_edge_count()                            → number of edges
//   reconstruct_path(target, out, max_len)      → trace shortest path
//   plugin_init(data, len)                      → ABI init (no-op)
//   plugin_destroy()                            → cleanup
//
// All weights must be non-negative (Dijkstra / frontier-shrinking requirement).
// =============================================================================

#include "orbpro_plugin.h"
#include "csr_graph.h"
#include "sssp_solver.h"
#include "generated/FastestPath_generated.h"
#include "generated/PluginMessage_generated.h"
#include "generated/TypedArenaBuffer_generated.h"
#include <cstring>
#include <cmath>
#include <algorithm>
#include <limits>
#include <string>
#include <vector>

// =============================================================================
// Plugin Metadata
// =============================================================================

static OrbProPluginInfo PLUGIN_INFO = {
    "com.orbpro.fastest-path",
    "Fastest Path (SSSP)",
    "1.0.0",
    ORBPRO_ABI_VERSION
};

// =============================================================================
// Global State
// =============================================================================

static bool g_initialized = false;
static CSRGraph g_graph;
static SSSPSolver g_solver;

// =============================================================================
// Bulk edge record: 16 bytes, matches JS packing layout
// =============================================================================
struct BulkEdgeRecord {
    uint32_t src;       //  0: source vertex
    uint32_t dst;       //  4: destination vertex
    double weight;      //  8: edge weight (non-negative)
};                      // Total: 16 bytes

static uint8_t* copyFlatBufferToHeap(
    const uint8_t* bytes,
    size_t size,
    uint32_t* sizeOut
) {
    if (sizeOut != nullptr) {
        *sizeOut = static_cast<uint32_t>(size);
    }
    if (bytes == nullptr || size == 0) {
        return nullptr;
    }

    uint8_t* out = static_cast<uint8_t*>(orbpro_malloc(size));
    if (out == nullptr) {
        if (sizeOut != nullptr) {
            *sizeOut = 0;
        }
        return nullptr;
    }

    std::memcpy(out, bytes, size);
    return out;
}

static uint8_t* copyFlatBufferToHeap(
    const flatbuffers::FlatBufferBuilder& builder,
    uint32_t* sizeOut
) {
    return copyFlatBufferToHeap(builder.GetBufferPointer(), builder.GetSize(), sizeOut);
}

static uint8_t* buildErrorStreamInvokeResponse(
    int32_t errorCode,
    const char* errorMessage,
    uint32_t* responseSizeOut
) {
    flatbuffers::FlatBufferBuilder builder(256);
    const auto response = orbpro::plugin::CreateStreamInvokeResponseDirect(
        builder,
        nullptr,
        0,
        false,
        errorCode,
        errorMessage);
    builder.Finish(response);
    return copyFlatBufferToHeap(builder, responseSizeOut);
}

static uint8_t* buildEmptyStreamInvokeResponse(uint32_t* responseSizeOut) {
    flatbuffers::FlatBufferBuilder builder(128);
    const auto response = orbpro::plugin::CreateStreamInvokeResponseDirect(builder);
    builder.Finish(response);
    return copyFlatBufferToHeap(builder, responseSizeOut);
}

static uint8_t* encodeShortestPathResultPayload(
    uint32_t sourceVertex,
    uint32_t* payloadSizeOut
) {
    if (!g_solver.computed) {
        return nullptr;
    }

    uint32_t reachableCount = 0;
    for (double distance : g_solver.dist) {
        if (std::isfinite(distance)) {
            reachableCount++;
        }
    }

    flatbuffers::FlatBufferBuilder builder(1024);
    const auto distances = builder.CreateVector(g_solver.dist);
    const auto predecessors = builder.CreateVector(g_solver.pred);
    const auto result = orbpro::analysis::CreateShortestPathResult(
        builder,
        sourceVertex,
        static_cast<uint32_t>(g_solver.V),
        reachableCount,
        distances,
        predecessors);
    builder.Finish(result, "FSPS");
    return copyFlatBufferToHeap(builder, payloadSizeOut);
}

static uint8_t* encodePathResultPayload(
    uint32_t targetVertex,
    uint32_t* payloadSizeOut
) {
    if (!g_solver.computed) {
        return nullptr;
    }

    const uint32_t maxLen = g_solver.V > 0 ? g_solver.V : 1;
    std::vector<uint32_t> reversedPath(maxLen, UINT32_MAX);
    const int32_t pathLength = g_solver.reconstructPath(
        targetVertex,
        reversedPath.data(),
        maxLen);

    bool reachable = pathLength > 0;
    std::vector<uint32_t> path;
    if (reachable) {
        path.reserve(static_cast<size_t>(pathLength));
        for (int32_t index = pathLength - 1; index >= 0; index--) {
            path.push_back(reversedPath[static_cast<size_t>(index)]);
        }
    }

    const double distance =
        targetVertex < g_solver.dist.size()
            ? g_solver.dist[targetVertex]
            : std::numeric_limits<double>::infinity();

    flatbuffers::FlatBufferBuilder builder(512);
    const auto pathVector = builder.CreateVector(path);
    const auto result = orbpro::analysis::CreatePathResult(
        builder,
        g_solver.source,
        targetVertex,
        reachable,
        distance,
        pathVector);
    builder.Finish(result, "FPTH");
    return copyFlatBufferToHeap(builder, payloadSizeOut);
}

// =============================================================================
// Plugin Exports
// =============================================================================

extern "C" {

// -----------------------------------------------------------------------------
// plugin_init — Generic ABI init. For this plugin, just marks as initialized.
// Returns 0 on success.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
int32_t plugin_init(const uint8_t* data, size_t len) {
    (void)data;
    (void)len;
    g_initialized = true;
    return 0;
}

// -----------------------------------------------------------------------------
// plugin_destroy — Clean up all state.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
void plugin_destroy(void) {
    g_graph = CSRGraph();
    g_solver = SSSPSolver();
    g_initialized = false;
}

// -----------------------------------------------------------------------------
// graph_create — Create a new empty graph with num_vertices vertices.
// Resets any prior graph and solver state.
// Returns 0 on success, -1 on invalid input.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
int32_t graph_create(uint32_t num_vertices) {
    if (num_vertices == 0) return -1;
    g_graph.create(num_vertices);
    g_solver = SSSPSolver();
    g_initialized = true;
    return 0;
}

// -----------------------------------------------------------------------------
// graph_add_edge — Add a single directed edge.
// Must be called after graph_create and before graph_build.
// Returns 0 on success, -1 if graph not created or invalid vertex.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
int32_t graph_add_edge(uint32_t src, uint32_t dst, double weight) {
    if (g_graph.V == 0) return -1;
    if (src >= g_graph.V || dst >= g_graph.V) return -1;
    if (weight < 0.0) return -1;
    g_graph.addEdge(src, dst, weight);
    return 0;
}

// -----------------------------------------------------------------------------
// graph_add_edges_bulk — Bulk-add edges from packed binary buffer.
// Buffer layout: [src:u32, dst:u32, weight:f64] x edge_count (16 bytes each).
// Returns number of edges added, or negative error code.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
int32_t graph_add_edges_bulk(const uint8_t* edge_buffer, uint32_t edge_count) {
    if (g_graph.V == 0 || edge_buffer == nullptr || edge_count == 0) return -1;

    const BulkEdgeRecord* records =
        reinterpret_cast<const BulkEdgeRecord*>(edge_buffer);

    uint32_t added = 0;
    for (uint32_t i = 0; i < edge_count; i++) {
        const BulkEdgeRecord& rec = records[i];
        if (rec.src < g_graph.V && rec.dst < g_graph.V && rec.weight >= 0.0) {
            g_graph.addEdge(rec.src, rec.dst, rec.weight);
            added++;
        }
    }

    return static_cast<int32_t>(added);
}

// -----------------------------------------------------------------------------
// graph_build — Build CSR from accumulated edges.
// Must be called after all edges are added, before compute_sssp.
// Returns 0 on success, -1 on failure.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
int32_t graph_build() {
    return g_graph.build();
}

// -----------------------------------------------------------------------------
// graph_load_csr — Load a pre-built CSR directly from WASM memory pointers.
// Returns 0 on success, -1 on failure.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
int32_t graph_load_csr(
    const uint32_t* offsets,
    const uint32_t* destinations,
    const double* weights,
    uint32_t num_vertices,
    uint32_t num_edges
) {
    if (offsets == nullptr || destinations == nullptr || weights == nullptr) {
        return -1;
    }
    if (num_vertices == 0) return -1;

    g_graph.loadCSR(offsets, destinations, weights, num_vertices, num_edges);
    g_solver = SSSPSolver();
    return 0;
}

// -----------------------------------------------------------------------------
// compute_sssp — Run SSSP from source_vertex.
// algorithm_hint: 0 = auto, 1 = frontier-shrinking, 2 = dijkstra.
// Returns 0 on success, negative error code on failure.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
int32_t compute_sssp(uint32_t source_vertex, uint32_t algorithm_hint) {
    if (!g_graph.built) return -1;
    if (source_vertex >= g_graph.V) return -2;
    return g_solver.solve(g_graph, source_vertex, algorithm_hint);
}

// -----------------------------------------------------------------------------
// get_distances — Get pointer to distance array in WASM linear memory.
// Returns pointer to Float64 array of V entries, or 0 if not computed.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
double* get_distances() {
    if (!g_solver.computed || g_solver.dist.empty()) return nullptr;
    return g_solver.dist.data();
}

// -----------------------------------------------------------------------------
// get_predecessors — Get pointer to predecessor array in WASM linear memory.
// Returns pointer to Uint32 array of V entries, or 0 if not computed.
// Predecessor of source is UINT32_MAX (0xFFFFFFFF).
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
uint32_t* get_predecessors() {
    if (!g_solver.computed || g_solver.pred.empty()) return nullptr;
    return g_solver.pred.data();
}

// -----------------------------------------------------------------------------
// get_vertex_count — Number of vertices in the current graph.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
uint32_t get_vertex_count() {
    return g_graph.V;
}

// -----------------------------------------------------------------------------
// get_edge_count — Number of edges in the current graph.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
uint32_t get_edge_count() {
    return g_graph.E;
}

// -----------------------------------------------------------------------------
// reconstruct_path — Trace shortest path from source to target.
// Writes vertex IDs into path_out buffer (target → source order).
// Returns path length, or -1 if unreachable, -2 if buffer too small.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
int32_t reconstruct_path(uint32_t target_vertex, uint32_t* path_out,
                          uint32_t max_len) {
    return g_solver.reconstructPath(target_vertex, path_out, max_len);
}

// -----------------------------------------------------------------------------
// plugin_stream_invoke — Canonical stream-based method entrypoint.
// -----------------------------------------------------------------------------
ORBPRO_EXPORT
uint8_t* plugin_stream_invoke(
    const uint8_t* request_data,
    size_t request_size,
    uint32_t* response_size_out
) {
    if (response_size_out != nullptr) {
        *response_size_out = 0;
    }
    if (request_data == nullptr || request_size == 0) {
        return buildErrorStreamInvokeResponse(
            -1,
            "Missing stream invoke request bytes.",
            response_size_out);
    }

    flatbuffers::Verifier requestVerifier(request_data, request_size);
    if (!requestVerifier.VerifyBuffer<orbpro::plugin::StreamInvokeRequest>(nullptr)) {
        return buildErrorStreamInvokeResponse(
            -1,
            "Invalid StreamInvokeRequest payload.",
            response_size_out);
    }

    const auto* request =
        flatbuffers::GetRoot<orbpro::plugin::StreamInvokeRequest>(request_data);
    if (request == nullptr || request->method_id() == nullptr) {
        return buildErrorStreamInvokeResponse(
            -1,
            "StreamInvokeRequest is missing method_id.",
            response_size_out);
    }

    const std::string methodId = request->method_id()->str();
    const auto* inputs = request->inputs();
    const uint32_t outputCap = request->output_stream_cap();

    if (methodId == "create_graph") {
        if (inputs == nullptr || inputs->size() == 0) {
            return buildEmptyStreamInvokeResponse(response_size_out);
        }
        for (flatbuffers::uoffset_t inputIndex = 0; inputIndex < inputs->size(); inputIndex++) {
            const auto* input = inputs->Get(inputIndex);
            if (input == nullptr || input->size() == 0 || input->offset() == 0) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "create_graph expects non-empty GraphDefinition input frames.",
                    response_size_out);
            }
            const auto* payload = reinterpret_cast<const uint8_t*>(
                static_cast<uintptr_t>(input->offset()));
            flatbuffers::Verifier verifier(payload, input->size());
            if (!verifier.VerifyBuffer<orbpro::analysis::GraphDefinition>("FGDF")) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "create_graph expects GraphDefinition input frames.",
                    response_size_out);
            }
            const auto* definition =
                flatbuffers::GetRoot<orbpro::analysis::GraphDefinition>(payload);
            if (definition == nullptr || definition->vertex_count() == 0) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "create_graph requires a positive vertex_count.",
                    response_size_out);
            }
            if (graph_create(definition->vertex_count()) != 0) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "create_graph failed to initialize the graph.",
                    response_size_out);
            }
        }
        return buildEmptyStreamInvokeResponse(response_size_out);
    }

    if (methodId == "ingest_edges") {
        if (inputs == nullptr || inputs->size() == 0) {
            return buildEmptyStreamInvokeResponse(response_size_out);
        }
        for (flatbuffers::uoffset_t inputIndex = 0; inputIndex < inputs->size(); inputIndex++) {
            const auto* input = inputs->Get(inputIndex);
            if (input == nullptr || input->size() == 0 || input->offset() == 0) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "ingest_edges expects non-empty WeightedEdgeList input frames.",
                    response_size_out);
            }
            const auto* payload = reinterpret_cast<const uint8_t*>(
                static_cast<uintptr_t>(input->offset()));
            flatbuffers::Verifier verifier(payload, input->size());
            if (!verifier.VerifyBuffer<orbpro::analysis::WeightedEdgeList>("FELT")) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "ingest_edges expects WeightedEdgeList input frames.",
                    response_size_out);
            }
            const auto* edgeList =
                flatbuffers::GetRoot<orbpro::analysis::WeightedEdgeList>(payload);
            if (edgeList == nullptr) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "ingest_edges received a null WeightedEdgeList payload.",
                    response_size_out);
            }

            if (edgeList->vertex_count() > 0 &&
                (g_graph.V == 0 || g_graph.V != edgeList->vertex_count())) {
                if (graph_create(edgeList->vertex_count()) != 0) {
                    return buildErrorStreamInvokeResponse(
                        -1,
                        "ingest_edges failed to initialize graph storage.",
                        response_size_out);
                }
            }
            if (g_graph.V == 0) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "ingest_edges requires a graph to be created first or a vertex_count on the edge list.",
                    response_size_out);
            }

            const auto* edges = edgeList->edges();
            if (edges != nullptr) {
                for (flatbuffers::uoffset_t edgeIndex = 0; edgeIndex < edges->size(); edgeIndex++) {
                    const auto* edge = edges->Get(edgeIndex);
                    if (edge == nullptr) {
                        continue;
                    }
                    if (graph_add_edge(edge->src(), edge->dst(), edge->weight()) != 0) {
                        return buildErrorStreamInvokeResponse(
                            -1,
                            "ingest_edges encountered an invalid edge record.",
                            response_size_out);
                    }
                }
            }

            if (edgeList->build_graph() && graph_build() != 0) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "ingest_edges failed to build CSR graph state.",
                    response_size_out);
            }
        }
        return buildEmptyStreamInvokeResponse(response_size_out);
    }

    if (methodId == "ingest_csr") {
        if (inputs == nullptr || inputs->size() == 0) {
            return buildEmptyStreamInvokeResponse(response_size_out);
        }
        for (flatbuffers::uoffset_t inputIndex = 0; inputIndex < inputs->size(); inputIndex++) {
            const auto* input = inputs->Get(inputIndex);
            if (input == nullptr || input->size() == 0 || input->offset() == 0) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "ingest_csr expects non-empty CSRGraph input frames.",
                    response_size_out);
            }
            const auto* payload = reinterpret_cast<const uint8_t*>(
                static_cast<uintptr_t>(input->offset()));
            flatbuffers::Verifier verifier(payload, input->size());
            if (!verifier.VerifyBuffer<orbpro::analysis::CSRGraph>("FCSR")) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "ingest_csr expects CSRGraph input frames.",
                    response_size_out);
            }
            const auto* csr = flatbuffers::GetRoot<orbpro::analysis::CSRGraph>(payload);
            if (csr == nullptr ||
                csr->offsets() == nullptr ||
                csr->destinations() == nullptr ||
                csr->weights() == nullptr) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "ingest_csr requires offsets, destinations, and weights arrays.",
                    response_size_out);
            }

            const uint32_t vertexCount =
                csr->vertex_count() > 0
                    ? csr->vertex_count()
                    : (csr->offsets()->size() > 0
                        ? static_cast<uint32_t>(csr->offsets()->size() - 1)
                        : 0);
            const uint32_t edgeCount =
                static_cast<uint32_t>(csr->destinations()->size());

            if (vertexCount == 0 ||
                csr->offsets()->size() != static_cast<size_t>(vertexCount + 1) ||
                csr->weights()->size() != edgeCount) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "ingest_csr received inconsistent CSR array sizes.",
                    response_size_out);
            }

            graph_load_csr(
                csr->offsets()->data(),
                csr->destinations()->data(),
                csr->weights()->data(),
                vertexCount,
                edgeCount);
        }
        return buildEmptyStreamInvokeResponse(response_size_out);
    }

    if (methodId == "compute_shortest_paths") {
        if (inputs == nullptr || inputs->size() == 0) {
            return buildEmptyStreamInvokeResponse(response_size_out);
        }
        if (outputCap > 0 && inputs->size() > outputCap) {
            return buildErrorStreamInvokeResponse(
                -1,
                "compute_shortest_paths output_stream_cap is smaller than the requested solve count.",
                response_size_out);
        }

        flatbuffers::FlatBufferBuilder builder(1024);
        std::vector<flatbuffers::Offset<orbpro::stream::TypedArenaBuffer>> outputs;
        outputs.reserve(inputs->size());
        const auto typeRef = orbpro::stream::CreateFlatBufferTypeRefDirect(
            builder,
            "orbpro.analysis.ShortestPathResult",
            "FSPS",
            nullptr,
            false,
            orbpro::stream::PayloadWireFormat_AlignedBinary,
            "ShortestPathResult",
            0,
            0,
            8);

        for (flatbuffers::uoffset_t inputIndex = 0; inputIndex < inputs->size(); inputIndex++) {
            const auto* input = inputs->Get(inputIndex);
            if (input == nullptr || input->size() == 0 || input->offset() == 0) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "compute_shortest_paths expects non-empty ShortestPathRequest frames.",
                    response_size_out);
            }
            const auto* payload = reinterpret_cast<const uint8_t*>(
                static_cast<uintptr_t>(input->offset()));
            flatbuffers::Verifier verifier(payload, input->size());
            if (!verifier.VerifyBuffer<orbpro::analysis::ShortestPathRequest>("FSPR")) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "compute_shortest_paths expects ShortestPathRequest input frames.",
                    response_size_out);
            }
            const auto* solveRequest =
                flatbuffers::GetRoot<orbpro::analysis::ShortestPathRequest>(payload);
            if (solveRequest == nullptr) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "compute_shortest_paths received a null ShortestPathRequest payload.",
                    response_size_out);
            }

            if (compute_sssp(
                    solveRequest->source(),
                    static_cast<uint32_t>(solveRequest->algorithm_hint())) != 0) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "compute_shortest_paths failed to solve the requested graph.",
                    response_size_out);
            }

            uint32_t payloadSize = 0;
            uint8_t* resultPayload = encodeShortestPathResultPayload(
                solveRequest->source(),
                &payloadSize);
            if (resultPayload == nullptr) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "compute_shortest_paths failed to encode a result payload.",
                    response_size_out);
            }

            outputs.push_back(orbpro::stream::CreateTypedArenaBufferDirect(
                builder,
                typeRef,
                "results",
                8,
                static_cast<uint32_t>(reinterpret_cast<uintptr_t>(resultPayload)),
                payloadSize,
                orbpro::stream::BufferOwnership_BORROWED,
                0,
                orbpro::stream::BufferMutability_IMMUTABLE,
                input->trace_id(),
                input->stream_id(),
                input->sequence(),
                false));
        }

        const auto response = orbpro::plugin::CreateStreamInvokeResponse(
            builder,
            builder.CreateVector(outputs),
            0,
            false,
            0,
            0);
        builder.Finish(response);
        return copyFlatBufferToHeap(builder, response_size_out);
    }

    if (methodId == "reconstruct_path") {
        if (!g_solver.computed) {
            return buildErrorStreamInvokeResponse(
                -1,
                "reconstruct_path requires a prior compute_shortest_paths solve.",
                response_size_out);
        }
        if (inputs == nullptr || inputs->size() == 0) {
            return buildEmptyStreamInvokeResponse(response_size_out);
        }
        if (outputCap > 0 && inputs->size() > outputCap) {
            return buildErrorStreamInvokeResponse(
                -1,
                "reconstruct_path output_stream_cap is smaller than the requested path count.",
                response_size_out);
        }

        flatbuffers::FlatBufferBuilder builder(512);
        std::vector<flatbuffers::Offset<orbpro::stream::TypedArenaBuffer>> outputs;
        outputs.reserve(inputs->size());
        const auto typeRef = orbpro::stream::CreateFlatBufferTypeRefDirect(
            builder,
            "orbpro.analysis.PathResult",
            "FPTH",
            nullptr,
            false,
            orbpro::stream::PayloadWireFormat_AlignedBinary,
            "PathResult",
            0,
            0,
            8);

        for (flatbuffers::uoffset_t inputIndex = 0; inputIndex < inputs->size(); inputIndex++) {
            const auto* input = inputs->Get(inputIndex);
            if (input == nullptr || input->size() == 0 || input->offset() == 0) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "reconstruct_path expects non-empty PathRequest frames.",
                    response_size_out);
            }
            const auto* payload = reinterpret_cast<const uint8_t*>(
                static_cast<uintptr_t>(input->offset()));
            flatbuffers::Verifier verifier(payload, input->size());
            if (!verifier.VerifyBuffer<orbpro::analysis::PathRequest>("FPTR")) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "reconstruct_path expects PathRequest input frames.",
                    response_size_out);
            }
            const auto* pathRequest =
                flatbuffers::GetRoot<orbpro::analysis::PathRequest>(payload);
            if (pathRequest == nullptr) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "reconstruct_path received a null PathRequest payload.",
                    response_size_out);
            }

            uint32_t payloadSize = 0;
            uint8_t* pathPayload = encodePathResultPayload(
                pathRequest->target(),
                &payloadSize);
            if (pathPayload == nullptr) {
                return buildErrorStreamInvokeResponse(
                    -1,
                    "reconstruct_path failed to encode a path result payload.",
                    response_size_out);
            }

            outputs.push_back(orbpro::stream::CreateTypedArenaBufferDirect(
                builder,
                typeRef,
                "path",
                8,
                static_cast<uint32_t>(reinterpret_cast<uintptr_t>(pathPayload)),
                payloadSize,
                orbpro::stream::BufferOwnership_BORROWED,
                0,
                orbpro::stream::BufferMutability_IMMUTABLE,
                input->trace_id(),
                input->stream_id(),
                input->sequence(),
                false));
        }

        const auto response = orbpro::plugin::CreateStreamInvokeResponse(
            builder,
            builder.CreateVector(outputs),
            0,
            false,
            0,
            0);
        builder.Finish(response);
        return copyFlatBufferToHeap(builder, response_size_out);
    }

    return buildErrorStreamInvokeResponse(
        -1,
        "Unsupported stream method for Fastest Path plugin.",
        response_size_out);
}

}  // extern "C"
