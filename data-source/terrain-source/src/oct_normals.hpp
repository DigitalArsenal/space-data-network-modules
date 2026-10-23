// ── OCT-ENCODED VERTEX NORMALS (quantized-mesh extension 1) ────────────────
//
// Inlined into terrain_source_module.cpp by source.mjs, after body_shape.hpp.
//
// A body other than Earth carries its own vertex normals, because the engine
// lights a terrain tile from them and a normal taken from the reference sphere
// lights relief flat. They are computed HERE, in WASM, from the same lattice the
// mesh is cut from, and travel inside the payload as Cesium reads them
// (extension id 1, two bytes per vertex in vertex order).
//
// THE NORMAL OF A POST IS A PROPERTY OF THE GLOBAL LATTICE, NOT OF THE TILE.
// Each is the area-weighted sum of the six triangles of the encoder's own
// triangulation ((bl, br, tr) and (bl, tr, tl) per cell, counter-clockwise from
// outside) incident on the post, in body-fixed metres, over the lattice the
// tile SAMPLED (its finest density) with a one-post halo sampled from the
// source beyond the tile. A post two tiles share therefore has the same six
// triangles - the same global posts, the same heights - and the same two bytes
// in both, whatever density each tile settles on (a coarser candidate takes the
// normals of the posts it keeps). Degenerate triangles at a pole have zero area
// and contribute nothing.

// Cesium AttributeCompression.octEncodeInRange(vector, 255): project onto the
// octahedron, fold the lower hemisphere, then toSNorm with Math.round
// (round half up).
void oct_encode(double x, double y, double z, uint8_t* out) {
    const double sum = std::fabs(x) + std::fabs(y) + std::fabs(z);
    double ox = sum > 0 ? x / sum : 0.0;
    double oy = sum > 0 ? y / sum : 0.0;
    if (z < 0) {
        const double fx = ox, fy = oy;
        ox = (1.0 - std::fabs(fy)) * (fx < 0 ? -1.0 : 1.0);
        oy = (1.0 - std::fabs(fx)) * (fy < 0 ? -1.0 : 1.0);
    }
    const auto snorm = [](double v) {
        const double c = v < -1.0 ? -1.0 : (v > 1.0 ? 1.0 : v);
        return static_cast<uint8_t>(std::floor((c * 0.5 + 0.5) * 255.0 + 0.5));
    };
    out[0] = snorm(ox);
    out[1] = snorm(oy);
}

// `halo` is (grid + 2)^2 body-fixed positions, row-major from the SOUTH halo
// row, column 0 the WEST halo column; `out` receives grid^2 x 2 bytes in the
// tile's south-row-major lattice order.
void lattice_oct_normals(const std::vector<Vec3>& halo, uint32_t grid, std::vector<uint8_t>* out) {
    const uint32_t span = grid + 2;
    const auto at = [&](long j, long i) -> const Vec3& {
        return halo[static_cast<size_t>(j + 1) * span + static_cast<size_t>(i + 1)];
    };
    const auto add_triangle = [](const Vec3& a, const Vec3& b, const Vec3& c, Vec3* n) {
        const double ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
        const double vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
        n->x += uy * vz - uz * vy;
        n->y += uz * vx - ux * vz;
        n->z += ux * vy - uy * vx;
    };
    out->assign(static_cast<size_t>(grid) * grid * 2, 0);
    for (long j = 0; j < static_cast<long>(grid); j++) {
        for (long i = 0; i < static_cast<long>(grid); i++) {
            Vec3 n;
            // Cell whose bottom-left is this post: (bl, br, tr) and (bl, tr, tl).
            add_triangle(at(j, i), at(j, i + 1), at(j + 1, i + 1), &n);
            add_triangle(at(j, i), at(j + 1, i + 1), at(j + 1, i), &n);
            // Cell to the west, this post its bottom-right: (bl, br, tr).
            add_triangle(at(j, i - 1), at(j, i), at(j + 1, i), &n);
            // Cell to the south-west, this post its top-right: both triangles.
            add_triangle(at(j - 1, i - 1), at(j - 1, i), at(j, i), &n);
            add_triangle(at(j - 1, i - 1), at(j, i), at(j, i - 1), &n);
            // Cell to the south, this post its top-left: (bl, tr, tl).
            add_triangle(at(j - 1, i), at(j, i + 1), at(j, i), &n);
            const double len = std::sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
            const Vec3& p = at(j, i);
            const double plen = std::sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
            // A pole is one point but a whole lattice row: the halo row past it
            // folds back across the pole, so the cross-pole cell is wound
            // inside out and cancels the radial part of the sum. The normal at
            // a pole is the body's axis, the same in every tile meeting it.
            if (plen > 0 && std::hypot(p.x, p.y) <= 1e-9 * plen) {
                oct_encode(0.0, 0.0, p.z > 0 ? 1.0 : -1.0,
                           &(*out)[(static_cast<size_t>(j) * grid + static_cast<size_t>(i)) * 2]);
                continue;
            }
            // A post every incident triangle of which is degenerate (none on a
            // real lattice) falls back to the radial direction.
            const Vec3 u = len > 0 ? Vec3{n.x / len, n.y / len, n.z / len}
                                   : (plen > 0 ? Vec3{p.x / plen, p.y / plen, p.z / plen} : Vec3{0, 0, 1});
            oct_encode(u.x, u.y, u.z, &(*out)[(static_cast<size_t>(j) * grid + static_cast<size_t>(i)) * 2]);
        }
    }
}
