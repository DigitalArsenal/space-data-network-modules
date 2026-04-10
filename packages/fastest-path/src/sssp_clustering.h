// sssp_clustering.h - r-Clustering for frontier-shrinking SSSP
// =============================================================================
// Partitions vertices into clusters of bounded radius r (= Delta_0).
// Within each cluster, edges can be relaxed with BFS-like operations
// (simple FIFO queue) instead of priority queue operations, because
// all intra-cluster distances are bounded by r.
//
// Construction: greedy BFS from unclaimed vertices.
// Relaxation: within a cluster, settle vertices in FIFO order.
// =============================================================================

#ifndef SSSP_CLUSTERING_H
#define SSSP_CLUSTERING_H

#include "csr_graph.h"
#include <cstdint>
#include <vector>
#include <queue>
#include <limits>

struct ClusterPartition {
    struct Cluster {
        uint32_t center;
        std::vector<uint32_t> members;
    };

    std::vector<Cluster> clusters;
    std::vector<uint32_t> vertex_to_cluster;  // V entries: cluster index

    // Build r-clustering using greedy BFS with radius bound.
    // Vertices are assigned to the first cluster whose BFS reaches them
    // within distance r.
    void build(const CSRGraph& graph, double radius) {
        uint32_t V = graph.V;
        vertex_to_cluster.assign(V, UINT32_MAX);
        clusters.clear();

        std::vector<double> bfs_dist(V, std::numeric_limits<double>::infinity());

        for (uint32_t seed = 0; seed < V; seed++) {
            if (vertex_to_cluster[seed] != UINT32_MAX) continue;

            // Start a new cluster centered at this vertex
            uint32_t cluster_idx = static_cast<uint32_t>(clusters.size());
            clusters.push_back({seed, {}});
            Cluster& cluster = clusters.back();

            // BFS with distance bound
            struct QueueEntry {
                uint32_t vertex;
                double dist;
            };
            std::queue<QueueEntry> q;
            q.push({seed, 0.0});
            bfs_dist[seed] = 0.0;
            vertex_to_cluster[seed] = cluster_idx;
            cluster.members.push_back(seed);

            while (!q.empty()) {
                auto [u, du] = q.front();
                q.pop();

                // Relax neighbors
                for (uint32_t ei = graph.offsets[u]; ei < graph.offsets[u + 1]; ei++) {
                    uint32_t v = graph.destinations[ei];
                    double w = graph.weights[ei];
                    double dv = du + w;

                    if (dv <= radius && dv < bfs_dist[v] &&
                        vertex_to_cluster[v] == UINT32_MAX) {
                        bfs_dist[v] = dv;
                        vertex_to_cluster[v] = cluster_idx;
                        cluster.members.push_back(v);
                        q.push({v, dv});
                    }
                }
            }
        }
    }

    // Relax edges within a single cluster using BFS-like FIFO processing.
    // Only processes vertices whose tentative distance is in the active band.
    // Updates dist[] and pred[], and inserts newly-updated vertices into the
    // bucket queue for inter-cluster propagation.
    //
    // Returns the number of vertices relaxed.
    uint32_t relaxWithinCluster(
        uint32_t cluster_idx,
        double* dist,
        uint32_t* pred,
        const CSRGraph& graph,
        const std::vector<uint32_t>& active_vertices,
        double radius
    ) {
        if (cluster_idx >= clusters.size()) return 0;

        const Cluster& cluster = clusters[cluster_idx];
        uint32_t relaxed = 0;

        // Use a FIFO queue seeded with active vertices in this cluster
        std::queue<uint32_t> q;
        std::vector<bool> in_queue(graph.V, false);

        for (uint32_t v : active_vertices) {
            if (vertex_to_cluster[v] == cluster_idx) {
                q.push(v);
                in_queue[v] = true;
            }
        }

        while (!q.empty()) {
            uint32_t u = q.front();
            q.pop();
            in_queue[u] = false;

            double du = dist[u];

            for (uint32_t ei = graph.offsets[u]; ei < graph.offsets[u + 1]; ei++) {
                uint32_t v = graph.destinations[ei];
                double w = graph.weights[ei];
                double new_dist = du + w;

                if (new_dist < dist[v]) {
                    dist[v] = new_dist;
                    pred[v] = u;
                    relaxed++;

                    // Only continue BFS within the same cluster
                    if (vertex_to_cluster[v] == cluster_idx && !in_queue[v]) {
                        q.push(v);
                        in_queue[v] = true;
                    }
                }
            }
        }

        return relaxed;
    }

    // Check if two vertices are in the same cluster
    bool sameCluster(uint32_t u, uint32_t v) const {
        if (u >= vertex_to_cluster.size() || v >= vertex_to_cluster.size()) {
            return false;
        }
        return vertex_to_cluster[u] == vertex_to_cluster[v];
    }
};

#endif // SSSP_CLUSTERING_H
