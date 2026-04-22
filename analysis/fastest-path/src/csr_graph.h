// csr_graph.h - Compressed Sparse Row graph data structure
// =============================================================================
// Provides a CSR representation for weighted directed graphs. Supports both
// incremental edge addition (via pending_edges + build()) and direct CSR
// loading from pre-packed WASM memory (via loadCSR()).
// =============================================================================

#ifndef CSR_GRAPH_H
#define CSR_GRAPH_H

#include <cstdint>
#include <cstring>
#include <vector>
#include <algorithm>
#include <cmath>
#include <limits>

struct CSRGraph {
    uint32_t V;  // Number of vertices
    uint32_t E;  // Number of edges

    // CSR arrays (populated after build() or loadCSR())
    std::vector<uint32_t> offsets;      // V+1: row pointers
    std::vector<uint32_t> destinations; // E: edge targets
    std::vector<double> weights;        // E: edge weights

    // Temporary edge list for incremental construction
    struct EdgeTmp {
        uint32_t src;
        uint32_t dst;
        double w;
    };
    std::vector<EdgeTmp> pending_edges;
    bool built;

    CSRGraph() : V(0), E(0), built(false) {}

    void create(uint32_t num_vertices) {
        V = num_vertices;
        E = 0;
        offsets.clear();
        destinations.clear();
        weights.clear();
        pending_edges.clear();
        built = false;
    }

    void addEdge(uint32_t src, uint32_t dst, double weight) {
        pending_edges.push_back({src, dst, weight});
    }

    // Build CSR from accumulated pending edges.
    // Sorts edges by source vertex, then populates offsets/destinations/weights.
    // Returns 0 on success, -1 on error.
    int build() {
        if (V == 0) return -1;

        E = static_cast<uint32_t>(pending_edges.size());

        // Sort by source vertex for CSR construction
        std::sort(pending_edges.begin(), pending_edges.end(),
                  [](const EdgeTmp& a, const EdgeTmp& b) {
                      return a.src < b.src;
                  });

        offsets.resize(V + 1, 0);
        destinations.resize(E);
        weights.resize(E);

        // Count edges per vertex
        for (uint32_t i = 0; i < E; i++) {
            if (pending_edges[i].src < V) {
                offsets[pending_edges[i].src + 1]++;
            }
        }

        // Prefix sum to get offsets
        for (uint32_t i = 1; i <= V; i++) {
            offsets[i] += offsets[i - 1];
        }

        // Fill destinations and weights
        for (uint32_t i = 0; i < E; i++) {
            destinations[i] = pending_edges[i].dst;
            weights[i] = pending_edges[i].w;
        }

        pending_edges.clear();
        pending_edges.shrink_to_fit();
        built = true;
        return 0;
    }

    // Load a pre-built CSR from external pointers (copies data).
    void loadCSR(const uint32_t* off, const uint32_t* dst, const double* w,
                 uint32_t v, uint32_t e) {
        V = v;
        E = e;
        offsets.assign(off, off + (v + 1));
        destinations.assign(dst, dst + e);
        weights.assign(w, w + e);
        pending_edges.clear();
        pending_edges.shrink_to_fit();
        built = true;
    }

    // Compute the maximum edge weight in the graph.
    double maxWeight() const {
        double wmax = 0.0;
        for (uint32_t i = 0; i < E; i++) {
            if (weights[i] > wmax) wmax = weights[i];
        }
        return wmax;
    }

    // Check if graph is sparse: E < V * (log2(V))^2
    bool isSparse() const {
        if (V <= 1) return true;
        double logV = std::log2(static_cast<double>(V));
        double threshold = logV * logV;
        double density = static_cast<double>(E) / static_cast<double>(V);
        return density <= threshold;
    }
};

#endif // CSR_GRAPH_H
