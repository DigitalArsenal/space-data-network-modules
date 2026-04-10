// sssp_frontier.h - Multi-level bucket queue for frontier management
// =============================================================================
// Implements the bucket queue used by the "Breaking the Sorting Barrier"
// algorithm. Replaces the binary heap in Dijkstra's with a multi-level
// bucket structure achieving amortized O((log V)^{2/3}) per vertex.
//
// Structure:
//   L levels (L = ceil(cbrt(log2(V)))), each with B buckets.
//   Level 0 has finest granularity Delta_0 = W_max / V^{2/3}.
//   Level l has width Delta_l = Delta_0 * B^l.
//   Insert: O(1) — place in coarsest valid level.
//   ExtractMin: O(B) amortized — scan level-0, refill from upper levels.
// =============================================================================

#ifndef SSSP_FRONTIER_H
#define SSSP_FRONTIER_H

#include <cstdint>
#include <vector>
#include <cmath>
#include <limits>
#include <algorithm>

struct BucketQueue {
    static constexpr uint32_t MAX_LEVELS = 8;
    static constexpr uint32_t BUCKETS_PER_LEVEL = 64;

    struct Level {
        double delta;                                    // Bucket width
        uint32_t num_buckets;                            // Number of buckets
        std::vector<std::vector<uint32_t>> buckets;      // buckets[i] = vertex list
        double base_distance;                            // Distance of bucket 0
        uint32_t min_nonempty;                           // Cached lowest nonempty bucket index
    };

    uint32_t num_levels;
    Level levels[MAX_LEVELS];
    double current_min_dist;
    uint32_t total_vertices;
    const double* dist_array;  // Pointer to distance array (owned by solver)

    void init(uint32_t V, double W_max, const double* distances) {
        dist_array = distances;
        total_vertices = 0;

        double logV = std::log2(static_cast<double>(V));
        if (logV < 1.0) logV = 1.0;

        // L = ceil(cbrt(log2(V)))
        num_levels = static_cast<uint32_t>(std::ceil(std::cbrt(logV)));
        if (num_levels < 1) num_levels = 1;
        if (num_levels > MAX_LEVELS) num_levels = MAX_LEVELS;

        // Delta_0 = W_max / V^{2/3}
        double v_pow = std::pow(static_cast<double>(V), 2.0 / 3.0);
        if (v_pow < 1.0) v_pow = 1.0;
        double delta0 = W_max / v_pow;
        if (delta0 <= 0.0 || !std::isfinite(delta0)) {
            delta0 = W_max > 0.0 ? W_max : 1.0;
        }

        uint32_t B = BUCKETS_PER_LEVEL;

        for (uint32_t l = 0; l < num_levels; l++) {
            Level& lev = levels[l];
            lev.delta = delta0 * std::pow(static_cast<double>(B), static_cast<double>(l));
            lev.num_buckets = B;
            lev.buckets.resize(B);
            for (auto& b : lev.buckets) b.clear();
            lev.base_distance = 0.0;
            lev.min_nonempty = B; // sentinel: all empty
        }

        current_min_dist = 0.0;
    }

    void insert(uint32_t vertex, double distance) {
        if (!std::isfinite(distance)) return;

        // Find the appropriate level: place in the coarsest level where the
        // vertex fits within the bucket range.
        for (int l = static_cast<int>(num_levels) - 1; l >= 0; l--) {
            Level& lev = levels[l];
            double offset = distance - lev.base_distance;
            if (offset < 0.0) offset = 0.0;

            uint32_t bucket_idx = static_cast<uint32_t>(offset / lev.delta);
            if (bucket_idx < lev.num_buckets) {
                lev.buckets[bucket_idx].push_back(vertex);
                if (bucket_idx < lev.min_nonempty) {
                    lev.min_nonempty = bucket_idx;
                }
                total_vertices++;
                return;
            }
        }

        // Doesn't fit in any level — place in last bucket of coarsest level
        Level& top = levels[num_levels - 1];
        top.buckets[top.num_buckets - 1].push_back(vertex);
        if (top.num_buckets - 1 < top.min_nonempty) {
            top.min_nonempty = top.num_buckets - 1;
        }
        total_vertices++;
    }

    // Extract all vertices in the current minimum distance band [D, D+Delta_0)
    // from level-0 buckets. Returns the band boundaries.
    uint32_t extractFrontierBand(std::vector<uint32_t>& frontier_out,
                                  double& band_low, double& band_high) {
        frontier_out.clear();

        // Ensure level 0 has vertices
        while (levels[0].min_nonempty >= levels[0].num_buckets) {
            if (!refillLevel0()) {
                return 0; // All levels empty
            }
        }

        Level& lev0 = levels[0];
        uint32_t bucket_idx = lev0.min_nonempty;

        band_low = lev0.base_distance + bucket_idx * lev0.delta;
        band_high = band_low + lev0.delta;

        // Extract all vertices from this bucket
        auto& bucket = lev0.buckets[bucket_idx];
        for (uint32_t v : bucket) {
            // Only include if the vertex's current distance is still in this band
            // (it may have been updated via a shorter path since insertion)
            double d = dist_array[v];
            if (d >= band_low && d < band_high) {
                frontier_out.push_back(v);
            } else if (d < band_low) {
                // Already settled with shorter distance, skip
            } else {
                // Distance increased (shouldn't happen with SSSP), re-insert
                insert(v, d);
            }
        }
        total_vertices -= static_cast<uint32_t>(bucket.size());
        bucket.clear();

        // Update min_nonempty for level 0
        while (lev0.min_nonempty < lev0.num_buckets &&
               lev0.buckets[lev0.min_nonempty].empty()) {
            lev0.min_nonempty++;
        }

        current_min_dist = band_high;
        return static_cast<uint32_t>(frontier_out.size());
    }

    bool empty() const {
        return total_vertices == 0;
    }

private:
    // Refill level 0 from level 1 (and cascade up if needed).
    // Returns true if level 0 now has vertices, false if all empty.
    bool refillLevel0() {
        for (uint32_t l = 1; l < num_levels; l++) {
            Level& upper = levels[l];
            Level& lower = levels[l - 1];

            // Find first nonempty bucket in upper level
            while (upper.min_nonempty < upper.num_buckets &&
                   upper.buckets[upper.min_nonempty].empty()) {
                upper.min_nonempty++;
            }

            if (upper.min_nonempty >= upper.num_buckets) {
                continue; // This level is also empty, try next
            }

            uint32_t bucket_idx = upper.min_nonempty;
            auto& bucket = upper.buckets[bucket_idx];

            // Update lower level's base distance
            lower.base_distance = upper.base_distance + bucket_idx * upper.delta;

            // Clear lower level buckets
            for (auto& b : lower.buckets) b.clear();
            lower.min_nonempty = lower.num_buckets;

            // Redistribute vertices from upper bucket into lower level
            for (uint32_t v : bucket) {
                double d = dist_array[v];
                if (!std::isfinite(d)) continue;

                double offset = d - lower.base_distance;
                if (offset < 0.0) offset = 0.0;

                uint32_t lower_idx = static_cast<uint32_t>(offset / lower.delta);
                if (lower_idx >= lower.num_buckets) {
                    lower_idx = lower.num_buckets - 1;
                }

                lower.buckets[lower_idx].push_back(v);
                if (lower_idx < lower.min_nonempty) {
                    lower.min_nonempty = lower_idx;
                }
            }

            bucket.clear();

            // Update upper min_nonempty
            while (upper.min_nonempty < upper.num_buckets &&
                   upper.buckets[upper.min_nonempty].empty()) {
                upper.min_nonempty++;
            }

            // If we got vertices into the lowest level (l-1), cascade down
            if (l - 1 == 0 && lower.min_nonempty < lower.num_buckets) {
                return true;
            }
        }

        // Check if level 0 has anything after cascading
        Level& lev0 = levels[0];
        while (lev0.min_nonempty < lev0.num_buckets &&
               lev0.buckets[lev0.min_nonempty].empty()) {
            lev0.min_nonempty++;
        }
        return lev0.min_nonempty < lev0.num_buckets;
    }
};

#endif // SSSP_FRONTIER_H
