// ── A TILE'S MESH: WHICH LATTICE POSTS IT CARRIES, AND THE TRIANGLES OVER THEM ──
//
// Inlined into terrain_source_module.cpp by source.mjs, ahead of the encoder.
//
// Every vertex is a post of the tile's own lattice (`n` posts a side, row 0 at
// the SOUTH edge), so its coordinate comes from lattice_lat/lattice_lon on the
// global index and two tiles that carry the same post carry the same double.
//
// TWO SHAPES.
//   * regular_mesh(grid): grid x grid posts, row-major, each cell split
//     (bl, br, tr) + (bl, tr, tl). Earth's tiles have always been this, and
//     their bytes depend on its exact vertex and triangle order.
//   * edge_matched_mesh(n, cand, edges): a body's tiles. The interior is the
//     regular cand-post grid; each of the four edges carries the posts
//     matched_edge_posts chose from the heights ALONG THAT EDGE ALONE, and a
//     zipper joins each edge to the first interior ring.
//
// WHY A BODY'S EDGES ARE CHOSEN SEPARATELY. Interior density adapts to each
// tile's relief, so two neighbours can settle on different densities. On the
// 321-post lattice the ladder's sizes are not nested (41 posts sit every 8th
// lattice post, 65 every 5th), so two such tiles share only the posts both
// strides hit, and their edge polylines - each a linear run between its own
// posts - part by tens of metres (measured: 852 of 1,675 east-west pairs of
// one L7 block row mixed, gaps p95 50 m, worst 219 m). Skirts hide that from a
// distance and show it up close. An edge chosen from the edge's own heights is
// the SAME choice in both tiles (same global posts, same heights, same
// function), so both carry the same posts there and the seam is one polyline.

struct TileMesh {
    uint32_t n = 0;                  // posts per side of the lattice row/col index
    std::vector<uint32_t> row, col;  // per vertex
    std::vector<uint32_t> indices;   // triangles, counter-clockwise in u-v
    size_t size() const { return row.size(); }
};

TileMesh regular_mesh(uint32_t grid) {
    TileMesh m;
    m.n = grid;
    m.row.resize(static_cast<size_t>(grid) * grid);
    m.col.resize(m.row.size());
    for (uint32_t j = 0; j < grid; j++) {
        for (uint32_t i = 0; i < grid; i++) {
            m.row[static_cast<size_t>(j) * grid + i] = j;
            m.col[static_cast<size_t>(j) * grid + i] = i;
        }
    }
    m.indices.reserve(static_cast<size_t>(grid - 1) * (grid - 1) * 6);
    for (uint32_t j = 0; j + 1 < grid; j++) {
        for (uint32_t i = 0; i + 1 < grid; i++) {
            const uint32_t bl = j * grid + i;
            const uint32_t br = bl + 1;
            const uint32_t tl = bl + grid;
            const uint32_t tr = tl + 1;
            m.indices.insert(m.indices.end(), {bl, br, tr, bl, tr, tl});
        }
    }
    return m;
}

// The posts one edge carries, as positions 0..n-1 along it (both corners
// always): the coarsest entry of `ladder` (ascending post counts, each with
// (count - 1) dividing (n - 1)) whose polyline through the lattice heights it
// keeps reproduces every lattice height along the edge within `target` - by
// RMS when `rms`, by the worst post otherwise. Every post when none does.
// `heights` is the tile's lattice; post k of the edge is heights[first + k*step].
std::vector<uint32_t> matched_edge_posts(const std::vector<double>& heights, uint32_t n, size_t first, size_t step,
                                         const std::vector<uint32_t>& ladder, double target, bool rms) {
    auto h = [&](uint32_t k) { return heights[first + static_cast<size_t>(k) * step]; };
    uint32_t chosen = n;
    for (const uint32_t count : ladder) {
        if (count < 2 || count > n || (n - 1) % (count - 1) != 0) continue;
        const uint32_t stride = (n - 1) / (count - 1);
        double worst = 0.0, sum_sq = 0.0;
        for (uint32_t k = 0; k < n; k++) {
            const uint32_t a = k / stride * stride;
            const uint32_t b = a == n - 1 ? a : a + stride;
            const double f = b == a ? 0.0 : static_cast<double>(k - a) / static_cast<double>(stride);
            const double delta = std::fabs(h(a) + f * (h(b) - h(a)) - h(k));
            worst = std::max(worst, delta);
            sum_sq += delta * delta;
            if (!rms && worst > target) break;
        }
        const double judged = rms ? std::sqrt(sum_sq / static_cast<double>(n)) : worst;
        if (judged <= target) { chosen = count; break; }
    }
    std::vector<uint32_t> posts;
    const uint32_t stride = (n - 1) / (chosen - 1);
    for (uint32_t k = 0; k < n; k += stride) posts.push_back(k);
    return posts;
}

// Edges are south, east, north, west; each lists positions along it from its
// west (south, north edges) or south (east, west edges) end, both corners
// included. `cand` >= 4 and (cand - 1) divides (n - 1).
TileMesh edge_matched_mesh(uint32_t n, uint32_t cand, const std::array<std::vector<uint32_t>, 4>& edges) {
    TileMesh m;
    m.n = n;
    const uint32_t L = n - 1, s = L / (cand - 1);
    std::vector<uint32_t> vertex_of(static_cast<size_t>(n) * n, UINT32_MAX);
    auto vertex = [&](uint32_t r, uint32_t c) {
        uint32_t& v = vertex_of[static_cast<size_t>(r) * n + c];
        if (v == UINT32_MAX) {
            v = static_cast<uint32_t>(m.row.size());
            m.row.push_back(r);
            m.col.push_back(c);
        }
        return v;
    };
    // Interior cells: the regular grid between the first and last interior rings.
    for (uint32_t j = 1; j + 2 < cand; j++) {
        for (uint32_t i = 1; i + 2 < cand; i++) {
            const uint32_t bl = vertex(j * s, i * s), br = vertex(j * s, (i + 1) * s);
            const uint32_t tl = vertex((j + 1) * s, i * s), tr = vertex((j + 1) * s, (i + 1) * s);
            m.indices.insert(m.indices.end(), {bl, br, tr, bl, tr, tl});
        }
    }
    // The two rings counter-clockwise from the south-west corner, each vertex with
    // its distance t round the perimeter in lattice steps (south side t = col,
    // east L + row, north 2L + (L - col), west 3L + (L - row)). The inner ring's
    // corners sit just inside the outer ring's, so a zipper that always advances
    // the ring whose next vertex has the smaller t pairs each side with its own
    // side and turns every corner on the outer corner vertex.
    struct RingVertex { uint32_t v; uint32_t t; };
    std::vector<RingVertex> outer, inner;
    for (const uint32_t c : edges[0]) outer.push_back({vertex(0, c), c});
    for (const uint32_t r : edges[1]) if (r > 0) outer.push_back({vertex(r, L), L + r});
    for (auto it = edges[2].rbegin(); it != edges[2].rend(); ++it) if (*it < L) outer.push_back({vertex(L, *it), 3 * L - *it});
    for (auto it = edges[3].rbegin(); it != edges[3].rend(); ++it) if (*it < L) outer.push_back({vertex(*it, 0), 4 * L - *it});
    for (uint32_t c = s; c <= L - s; c += s) inner.push_back({vertex(s, c), c});
    for (uint32_t r = 2 * s; r <= L - s; r += s) inner.push_back({vertex(r, L - s), L + r});
    for (uint32_t c = L - 2 * s; c >= s; c -= s) inner.push_back({vertex(L - s, c), 3 * L - c});
    for (uint32_t r = L - 2 * s; r >= 2 * s; r -= s) inner.push_back({vertex(r, s), 4 * L - r});
    inner.push_back({inner[0].v, 4 * L + s});
    size_t a = 0, b = 0;
    while (a + 1 < outer.size() || b + 1 < inner.size()) {
        const bool outer_next = b + 1 == inner.size() || (a + 1 < outer.size() && outer[a + 1].t <= inner[b + 1].t);
        if (outer_next) {
            m.indices.insert(m.indices.end(), {outer[a].v, outer[a + 1].v, inner[b].v});
            a++;
        } else {
            m.indices.insert(m.indices.end(), {outer[a].v, inner[b + 1].v, inner[b].v});
            b++;
        }
    }
    return m;
}

// THE SURFACE A MESH RENDERS, evaluated at a point of its tile given in
// lattice units (u = column, v = row, both 0..n-1). Triangles are bucketed on a
// grid of `buckets` cells a side by their bounding boxes; a point is looked up
// in its cell and taken by barycentric weights from the triangle that holds it
// (on a shared edge either triangle gives the same height).
struct MeshSurface {
    const TileMesh* mesh = nullptr;
    const std::vector<double>* heights = nullptr;  // per vertex
    uint32_t buckets = 1;
    double per_bucket = 1.0;
    std::vector<uint32_t> start, items;

    MeshSurface(const TileMesh& m, const std::vector<double>& h, uint32_t cells) : mesh(&m), heights(&h) {
        buckets = std::max<uint32_t>(1, cells);
        per_bucket = static_cast<double>(buckets) / static_cast<double>(m.n - 1);
        std::vector<uint32_t> count(static_cast<size_t>(buckets) * buckets + 1, 0);
        auto cell_range = [&](size_t tri, uint32_t* c0, uint32_t* c1, uint32_t* r0, uint32_t* r1) {
            double u_lo = 1e300, u_hi = -1e300, v_lo = 1e300, v_hi = -1e300;
            for (size_t k = 0; k < 3; k++) {
                const uint32_t v = m.indices[tri * 3 + k];
                u_lo = std::min(u_lo, static_cast<double>(m.col[v]));
                u_hi = std::max(u_hi, static_cast<double>(m.col[v]));
                v_lo = std::min(v_lo, static_cast<double>(m.row[v]));
                v_hi = std::max(v_hi, static_cast<double>(m.row[v]));
            }
            *c0 = bucket(u_lo); *c1 = bucket(u_hi); *r0 = bucket(v_lo); *r1 = bucket(v_hi);
        };
        const size_t tris = m.indices.size() / 3;
        for (int pass = 0; pass < 2; pass++) {
            for (size_t tri = 0; tri < tris; tri++) {
                uint32_t c0, c1, r0, r1;
                cell_range(tri, &c0, &c1, &r0, &r1);
                for (uint32_t r = r0; r <= r1; r++) {
                    for (uint32_t c = c0; c <= c1; c++) {
                        const size_t cell = static_cast<size_t>(r) * buckets + c;
                        if (pass == 0) count[cell + 1]++;
                        else items[start[cell] + count[cell]++] = static_cast<uint32_t>(tri);
                    }
                }
            }
            if (pass == 0) {
                for (size_t k = 1; k < count.size(); k++) count[k] += count[k - 1];
                start = count;
                items.resize(count.back());
                std::fill(count.begin(), count.end(), 0);
            }
        }
    }

    uint32_t bucket(double coordinate) const {
        const double b = coordinate * per_bucket;
        if (!(b > 0)) return 0;
        return std::min<uint32_t>(buckets - 1, static_cast<uint32_t>(b));
    }

    double at(double u, double v) const {
        const TileMesh& m = *mesh;
        const double limit = static_cast<double>(m.n - 1);
        u = std::min(std::max(u, 0.0), limit);
        v = std::min(std::max(v, 0.0), limit);
        const size_t cell = static_cast<size_t>(bucket(v)) * buckets + bucket(u);
        double best = -1e300, value = 0.0;
        for (uint32_t k = start[cell]; k < start[cell + 1]; k++) {
            const uint32_t* t = &m.indices[static_cast<size_t>(items[k]) * 3];
            const double ax = m.col[t[0]], ay = m.row[t[0]];
            const double bx = m.col[t[1]], by = m.row[t[1]];
            const double cx = m.col[t[2]], cy = m.row[t[2]];
            const double det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (det == 0) continue;
            const double wa = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / det;
            const double wb = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / det;
            const double wc = 1.0 - wa - wb;
            const double inside = std::min(wa, std::min(wb, wc));
            if (inside > best) {
                best = inside;
                value = wa * (*heights)[t[0]] + wb * (*heights)[t[1]] + wc * (*heights)[t[2]];
                if (inside >= 0) break;
            }
        }
        return value;
    }
};
