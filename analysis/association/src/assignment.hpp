// Minimum-cost rectangular assignment: every row gets a distinct column,
// rows <= columns, a forbidden pair is +infinity. The Hungarian method in its
// shortest-augmenting-path form with row and column potentials (Kuhn 1955,
// Munkres 1957; the O(n^2 m) formulation of Jonker and Volgenant 1987): rows
// are added one at a time and each augmentation follows reduced costs that
// the potentials keep non-negative, so the result is optimal, not greedy.
#include <limits>

namespace assoc {

constexpr double kForbidden = std::numeric_limits<double>::infinity();

// cost: rows x columns, row-major. On success, columnOf[i] is row i's column.
// Fails when some row cannot be given any permitted column.
inline bool solveAssignment(const std::vector<double>& cost, std::size_t rows, std::size_t columns,
                            std::vector<long>& columnOf, double* total) {
  columnOf.assign(rows, -1);
  *total = 0.0;
  if (rows == 0) return true;
  if (rows > columns) return false;
  const double inf = std::numeric_limits<double>::infinity();
  // 1-based: u row potentials, v column potentials, p[j] row matched to column j.
  std::vector<double> u(rows + 1, 0.0), v(columns + 1, 0.0), minv(columns + 1);
  std::vector<std::size_t> p(columns + 1, 0), way(columns + 1, 0);
  std::vector<char> used(columns + 1);
  for (std::size_t i = 1; i <= rows; ++i) {
    p[0] = i;
    std::size_t j0 = 0;
    std::fill(minv.begin(), minv.end(), inf);
    std::fill(used.begin(), used.end(), 0);
    do {
      used[j0] = 1;
      const std::size_t i0 = p[j0];
      double delta = inf;
      std::size_t j1 = 0;
      for (std::size_t j = 1; j <= columns; ++j) {
        if (used[j]) continue;
        const double c = cost[(i0 - 1) * columns + (j - 1)];
        if (c != inf) {
          const double reduced = c - u[i0] - v[j];
          if (reduced < minv[j]) { minv[j] = reduced; way[j] = j0; }
        }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      if (j1 == 0 || delta == inf) return false;  // no permitted column remains
      for (std::size_t j = 0; j <= columns; ++j) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else if (minv[j] != inf) minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] != 0);
    do {
      const std::size_t j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  for (std::size_t j = 1; j <= columns; ++j)
    if (p[j]) columnOf[p[j] - 1] = static_cast<long>(j - 1);
  for (std::size_t i = 0; i < rows; ++i) *total += cost[i * columns + static_cast<std::size_t>(columnOf[i])];
  return true;
}

}  // namespace assoc
