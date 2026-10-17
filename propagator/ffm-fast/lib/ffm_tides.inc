// FFM Fast C2: environment-owned tide nodes and merged Stokes coefficients.
// Included inside astro::ForceModel, after the unchanged tide arithmetic.
namespace {
struct FfmMergedTides {
    static constexpr size_t TideSize = ffm::gravityRow(fes2004::MAX_DEGREE + 1);
    static constexpr size_t FieldSize = ffm::gravityRow(71);
    struct Node {
        long long index = 0;
        bool valid = false, usable = false;
        std::array<double, TideSize> C{}, S{};
    };
    struct Value { double jd = NAN; bool usable = false; std::array<double, FieldSize> C{}, S{}; };
    using Settings = std::tuple<double, double, double, int, int, int, int,
        bool, bool, int, int, bool, bool, bool, bool>;
    Settings settings{};
    bool prepared = false, tidesOn = false;
    std::array<Node, 64> nodes;
    std::array<Value, 16> values;
    size_t nextValue = 0;
    ExtendedGravityField metadata, solid, ocean;
    std::array<double, FieldSize> baseC{}, baseS{};
    std::array<double, fes2004::MAX_DEGREE + 1> scale{};
    FfmMergedTides() {
        solid.allocate(4, 4);
        ocean.allocate(fes2004::MAX_DEGREE, fes2004::MAX_DEGREE);
    }

    void prepare(const ForceModelSet& f, const ExtendedGravityField& egm, bool on) {
        const Settings now{f.mu, egm.mu, egm.referenceRadius, egm.maxDegree, egm.maxOrder,
            f.egm2008.maxTesseralDegree, int(f.egm2008.field), f.useOceanTides, f.useSolidTides,
            f.oceanTides.maxDegree, f.oceanTides.maxOrder, f.solidTides.includeSunTide,
            f.solidTides.includeMoonTide, f.solidTides.frequencyDependent, f.solidTides.zeroTideField};
        if (prepared && tidesOn == on && settings == now) return;
        settings = now; prepared = true; tidesOn = on;
        for (auto& node : nodes) node.valid = false;
        const int oceanDegree = on && f.useOceanTides ? std::max(2, std::min<int>(f.oceanTides.maxDegree, fes2004::MAX_DEGREE)) : 0;
        const int oceanOrder = std::max(0, std::min<int>(f.oceanTides.maxOrder, oceanDegree));
        metadata.maxDegree = std::max({int(egm.maxDegree), oceanDegree, on && f.useSolidTides ? 4 : 0});
        metadata.maxOrder = std::max({int(egm.maxOrder), oceanOrder, on && f.useSolidTides ? 4 : 0});
        metadata.mu = egm.mu; metadata.referenceRadius = egm.referenceRadius;
        baseC.fill(0); baseS.fill(0);
        for (int n = 0; n <= egm.maxDegree; ++n)
            for (int m = 0; m <= std::min(n, int(egm.maxOrder)); ++m) {
                baseC[ffm::gravityRow(n) + m] = egm.Cnm[n][m];
                baseS[ffm::gravityRow(n) + m] = egm.Snm[n][m];
            }
        // General degree scale; FFM-1 has identical GM/radius, hence exactly 1.
        for (int n = 0; n <= fes2004::MAX_DEGREE; ++n)
            scale[n] = (f.mu / egm.mu) * std::pow(EGM2008_RADIUS_KM / egm.referenceRadius, n);
        for (auto& value : values) { value.jd = NAN; value.usable = false; value.C = baseC; value.S = baseS; }
        nextValue = 0;
    }

    const Node& nodeAt(long long index, const ForceModelSet& f) {
        int empty = -1, far = -1;
        for (int j = 0; j < 64; ++j) {
            if (!nodes[j].valid) { if (empty < 0) empty = j; continue; }
            if (nodes[j].index == index) return nodes[j];
            if (far < 0 || std::llabs(nodes[j].index - index) > std::llabs(nodes[far].index - index) ||
                (std::llabs(nodes[j].index - index) == std::llabs(nodes[far].index - index) && nodes[j].index < nodes[far].index)) far = j;
        }
        Node& node = nodes[empty >= 0 ? empty : far];
        const double jdTt = 2451545.0 + static_cast<double>(index) * OCEAN_TIDE_GRID_SECONDS / 86400.0;
        const double jd = timesys::ttToTdb(jdTt);
        // C3c always bypasses interpolation at these shipped TT grid nodes.
        ffm_interp::ExactScope exact;
        node.C.fill(0); node.S.fill(0);
        node.usable = true;
        if (f.useOceanTides) {
            FillOceanTideField(jd, f, ocean);
            for (int n = 2; n <= ocean.maxDegree; ++n)
                for (int m = 0; m <= std::min(n, int(ocean.maxOrder)); ++m) {
                    node.C[ffm::gravityRow(n) + m] = ocean.Cnm[n][m];
                    node.S[ffm::gravityRow(n) + m] = ocean.Snm[n][m];
                }
        }
        if (f.useSolidTides) {
            try {
                node.usable = FillSolidTideField(jd, f, EarthAxesAt(jd, f), solid);
                for (int n = 2; n <= 4; ++n)
                    for (int m = 0; m <= n; ++m) {
                        node.C[ffm::gravityRow(n) + m] += solid.Cnm[n][m];
                        node.S[ffm::gravityRow(n) + m] += solid.Snm[n][m];
                    }
            } catch (const std::exception&) {
                // A callback may throw only at a neighboring node. The
                // exact fallback evaluates and validates the requested epoch.
                node.usable = false;
            }
        }
        node.index = index; node.valid = true;
        return node;
    }

    const Value* at(double jd, const ForceModelSet& f) {
        for (const auto& value : values) if (value.jd == jd) return value.usable ? &value : nullptr;
        Value& value = values[nextValue++ % values.size()];
        value.usable = false;
        if (!tidesOn) { value.jd = jd; value.usable = true; return &value; }
        const double g = (timesys::tdbToTt(jd) - 2451545.0) * 86400.0 / OCEAN_TIDE_GRID_SECONDS;
        const long long k = static_cast<long long>(std::floor(g));
        const double u = g - static_cast<double>(k);
        const Node* node[4];
        for (int i = 0; i < 4; ++i) {
            node[i] = &nodeAt(k - 1 + i, f);
            // A short ephemeris can cover this evaluation but miss a solid
            // tide node. Keep the standard exact solid path for this epoch.
            if (!node[i]->usable) { value.jd = jd; return nullptr; }
        }
        const double w[4] = {-u * (u - 1) * (u - 2) / 6, (u + 1) * (u - 1) * (u - 2) / 2,
            -(u + 1) * u * (u - 2) / 2, (u + 1) * u * (u - 1) / 6};
        const int tideDegree = std::max(f.useOceanTides ? std::max(2, std::min<int>(f.oceanTides.maxDegree, fes2004::MAX_DEGREE)) : 0,
            f.useSolidTides ? 4 : 0);
        for (int n = 2; n <= tideDegree; ++n)
            for (int m = 0; m <= n; ++m) {
                const size_t i = ffm::gravityRow(n) + m;
                const double c = w[0] * node[0]->C[i] + w[1] * node[1]->C[i] + w[2] * node[2]->C[i] + w[3] * node[3]->C[i];
                const double s = w[0] * node[0]->S[i] + w[1] * node[1]->S[i] + w[2] * node[2]->S[i] + w[3] * node[3]->S[i];
                value.C[i] = baseC[i] + scale[n] * c;
                value.S[i] = baseS[i] + scale[n] * s;
            }
        value.jd = jd;
        value.usable = true;
        return &value;
    }
};
} // namespace
