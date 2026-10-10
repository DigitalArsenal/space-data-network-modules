#include "maneuver/plugin_runtime.h"

#include "maneuver/approach.h"
#include "maneuver/classical.h"
#include "maneuver/constants.h"
#include "maneuver/fault.h"
#include "maneuver/json_lite.h"
#include "maneuver/math.h"
#include "maneuver/orbit_geometry.h"
#include "maneuver/propagation.h"
#include "maneuver/rendezvous.h"
#include "maneuver/stm.h"
#include "maneuver/targeting.h"
#include "maneuver/transforms.h"
#include "maneuver/types.h"

#include <cmath>
#include <string>
#include <vector>

/**
 * THE JSON BOUNDARY.
 *
 * Everything a hostile caller can reach goes through this file, and the rule
 * here is absolute: NO input may trap. 0.1.0 could not honour that rule even in
 * principle — it linked without exception support, so its `try`/`catch` was
 * compiled away and every `throw` (including every `j.at()`) lowered to
 * `unreachable`, poisoning the instance for all subsequent calls. Seven
 * distinct error classes were measured trapping identically.
 *
 * The replacement has three parts and no exceptions anywhere:
 *
 *   1. `json_lite` parses with a depth cap and a real JSON number grammar,
 *      returning false rather than throwing.
 *   2. Every parameter read is a guarded call that LATCHES a fault
 *      (maneuver/fault.h) and returns false. The physics functions latch the
 *      same way, so the validator messages their authors wrote — "[phasing]:
 *      Number of revolutions must be >= 1" and the rest — reach a caller for
 *      the first time.
 *   3. The boundary checks the latch once and emits a structured error result,
 *      which `invoke` turns into `plugin_set_error` + a non-zero status. The
 *      instance is untouched and the next call works.
 */

namespace maneuver {

using json_lite::ObjectWriter;
using json_lite::Value;

namespace {

/// THE MODULE VERSION, and it must equal `plugin-manifest.json`'s `version`.
///
/// It read "1.0.0" from 0.1.0 through 0.3.0 — a number this module has never
/// had, published by the one operation whose entire job is to say which module
/// you are talking to. A consumer that asked `version` to decide whether the
/// artifact it fetched carries the operation it needs was told a fiction, and
/// three releases went by without it moving because nothing compared it to
/// anything. `tests/behavior.test.mjs` now asserts this string against the
/// manifest, so the next release cannot forget it.
constexpr const char* kModuleVersion = "0.6.2";

std::string version() { return kModuleVersion; }

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

Vector3 toVector3(const double v[3]) { return {v[0], v[1], v[2]}; }

/// Emit a Vector3 under `key`. Used for every RIC array.
void writeVec3(ObjectWriter& out, const char* key, const Vector3& v) {
    const double values[3] = {v[0], v[1], v[2]};
    out.vec3(key, values);
}

/// The ONE frame every delta-v this module emits is expressed in.
///
/// R = unit(r) ; C = unit(r x v) ; I = C x R, built from the INERTIAL state,
/// components ordered [radial, in-track, cross-track]. This is the triad
/// `rendezvous.cpp`'s lvlhBasis() implements and the one the engine's
/// ManeuverFrame.RIC names; it is now written down in
/// space-data-module-sdk/docs/families/maneuver.md.
///
/// `graph/findings/official-harness-shapes.md` records the D1 defect this
/// closes: r/t/n was mapped onto x/y/z RAW, with three distinct RTN triads
/// live across the stack and no frame ever declared on the wire. Declaration
/// is now mandatory and unconditional — there is no default to fall back on,
/// so a consumer can never silently assume the wrong triad.
constexpr const char* kDeltaVFrame = "RIC";

/// Stamp the delta-v frame on a response. Called by EVERY operation whose
/// response carries a delta-v, next to the vectors it qualifies.
void writeDeltaVFrame(ObjectWriter& out) {
    out.string("frame", kDeltaVFrame);
}

/// The RIC basis of an inertial state, as ROWS of the RIC <- ECI rotation.
/// Returns false (and latches a fault) for a degenerate state — a zero
/// position, a zero velocity, or a radial velocity, none of which define an
/// orbit normal.
bool ricBasisFromState(const Vector3& r, const Vector3& v, const char* op,
                       Vector3* R, Vector3* I, Vector3* C) {
    const double rn = norm3(r);
    if (!(rn > 0.0)) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     std::string("[") + op +
                         "]: position must be non-zero to define a RIC frame.");
        return false;
    }
    const Vector3 h = cross3(r, v);
    const double hn = norm3(h);
    if (!(hn > 0.0)) {
        fault::raise(fault_code::SINGULAR,
                     std::string("[") + op +
                         "]: position and velocity are collinear, so the orbit "
                         "normal is undefined and no RIC frame exists.");
        return false;
    }
    *R = {r[0] / rn, r[1] / rn, r[2] / rn};
    *C = {h[0] / hn, h[1] / hn, h[2] / hn};
    *I = cross3(*C, *R);
    return true;
}

bool readChief(const Value& object, const char* key, const char* operation,
               ClassicalOrbitalElements* out) {
    const Value* chief = nullptr;
    if (!json_lite::requireObject(object, key, operation, &chief)) return false;
    ClassicalOrbitalElements elements{};
    if (!json_lite::requirePositive(*chief, "semiMajorAxis", operation,
                                    &elements.semiMajorAxis)) {
        return false;
    }
    elements.gravitationalParameter = MU_EARTH;
    if (!json_lite::optionalNumber(*chief, "eccentricity", operation,
                                   &elements.eccentricity) ||
        !json_lite::optionalNumber(*chief, "inclination", operation,
                                   &elements.inclination) ||
        !json_lite::optionalNumber(*chief, "raan", operation, &elements.raan) ||
        !json_lite::optionalNumber(*chief, "argumentOfPerigee", operation,
                                   &elements.argumentOfPerigee) ||
        !json_lite::optionalNumber(*chief, "meanAnomaly", operation,
                                   &elements.meanAnomaly) ||
        !json_lite::optionalPositive(*chief, "mu", operation,
                                     &elements.gravitationalParameter)) {
        return false;
    }
    if (elements.eccentricity < 0.0 || elements.eccentricity >= 1.0) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     std::string("[") + operation + "]: " + key +
                         " eccentricity must be in [0, 1) (e=" +
                         json_lite::numberToString(elements.eccentricity) + ")");
        return false;
    }
    elements.angularMomentum = std::sqrt(
        elements.gravitationalParameter * elements.semiMajorAxis *
        (1.0 - elements.eccentricity * elements.eccentricity));
    if (!json_lite::optionalPositive(*chief, "angularMomentum", operation,
                                     &elements.angularMomentum)) {
        return false;
    }
    *out = elements;
    return true;
}

bool readTargetingOptions(const Value& object, const char* operation,
                          TargetingOptions* out) {
    TargetingOptions options{};
    double maxIterations = 50.0;
    if (!json_lite::optionalBool(object, "includeJ2", operation, &options.includeJ2) ||
        !json_lite::optionalBool(object, "includeDrag", operation, &options.includeDrag) ||
        !json_lite::optionalNumber(object, "maxIterations", operation, &maxIterations) ||
        !json_lite::optionalNumber(object, "positionTolerance", operation,
                                   &options.positionTolerance) ||
        !json_lite::optionalNumber(object, "velocityTolerance", operation,
                                   &options.velocityTolerance) ||
        !json_lite::optionalNumber(object, "tofMinOrbits", operation,
                                   &options.tofMinOrbits) ||
        !json_lite::optionalNumber(object, "tofMaxOrbits", operation,
                                   &options.tofMaxOrbits)) {
        return false;
    }
    // Clamped, not merely read: an iteration budget of 1e12 is a hang, and a
    // hang inside a wasm guest is indistinguishable from a trap to the caller.
    if (!(maxIterations >= 1.0)) maxIterations = 1.0;
    if (maxIterations > 10000.0) maxIterations = 10000.0;
    options.maxIterations = static_cast<int>(maxIterations);

    bool present = false;
    double target[3] = {0.0, 0.0, 0.0};
    if (!json_lite::optionalVec3(object, "targetVelocity", operation, target,
                                 &present)) {
        return false;
    }
    if (present) options.targetVelocity = toVector3(target);

    const Value* drag = object.find("dragConfig");
    if (drag != nullptr && drag->isObject()) {
        std::string type = "eccentric";
        if (!json_lite::optionalString(*drag, "type", operation, &type) ||
            !json_lite::optionalNumber(*drag, "daDotDrag", operation,
                                       &options.dragConfig.daDotDrag) ||
            !json_lite::optionalNumber(*drag, "dexDotDrag", operation,
                                       &options.dragConfig.dexDotDrag) ||
            !json_lite::optionalNumber(*drag, "deyDotDrag", operation,
                                       &options.dragConfig.deyDotDrag)) {
            return false;
        }
        options.dragConfig.type =
            (type == "arbitrary") ? DragType::ARBITRARY : DragType::ECCENTRIC;
    }
    *out = options;
    return true;
}

bool readPropagationOptions(const Value& object, const char* operation,
                            ROEPropagationOptions* out) {
    ROEPropagationOptions options{};
    if (!json_lite::optionalBool(object, "includeJ2", operation, &options.includeJ2) ||
        !json_lite::optionalBool(object, "includeDrag", operation,
                                 &options.includeDrag)) {
        return false;
    }
    const Value* drag = object.find("dragConfig");
    if (drag != nullptr && drag->isObject()) {
        std::string type = "eccentric";
        if (!json_lite::optionalString(*drag, "type", operation, &type) ||
            !json_lite::optionalNumber(*drag, "daDotDrag", operation,
                                       &options.dragConfig.daDotDrag) ||
            !json_lite::optionalNumber(*drag, "dexDotDrag", operation,
                                       &options.dragConfig.dexDotDrag) ||
            !json_lite::optionalNumber(*drag, "deyDotDrag", operation,
                                       &options.dragConfig.deyDotDrag)) {
            return false;
        }
        options.dragConfig.type =
            (type == "arbitrary") ? DragType::ARBITRARY : DragType::ECCENTRIC;
    }
    *out = options;
    return true;
}

bool readRelativeState(const Value& object, const char* key,
                       const char* operation, RelativeState* out) {
    const Value* state = nullptr;
    if (!json_lite::requireObject(object, key, operation, &state)) return false;
    double position[3];
    double velocity[3];
    if (!json_lite::requireVec3(*state, "position", operation, position) ||
        !json_lite::requireVec3(*state, "velocity", operation, velocity)) {
        return false;
    }
    out->position = toVector3(position);
    out->velocity = toVector3(velocity);
    return true;
}

/// Read ONE craft, from EITHER an element set under `elementsKey` OR a
/// Cartesian state under `stateKey` — exactly one of the two.
///
/// Two distinct keys rather than one polymorphic key (SDK ruling, 2026-08-10):
/// a reader that decides what it was handed by looking for a `position` member
/// inside it cannot tell a state from a typo, and the caller learns which
/// branch it took only from the answer's shape. With two keys the request says
/// which form it is carrying, and a request carrying BOTH or NEITHER is a
/// refusal with a message that names both spellings.
bool readCraft(const Value& params, const char* elementsKey,
               const char* stateKey, const char* operation, double defaultMu,
               ClassicalOrbitalElements* out) {
    const Value* elements = params.find(elementsKey);
    const Value* state = params.find(stateKey);
    const bool hasElements = elements != nullptr && !elements->isNull();
    const bool hasState = state != nullptr && !state->isNull();

    if (hasElements == hasState) {
        fault::raise(
            fault_code::INVALID_PARAMETER,
            std::string("[") + operation + "]: give exactly one of \"" +
                elementsKey + "\" (semiMajorAxis, eccentricity, inclination, " +
                "raan, argumentOfPerigee, meanAnomaly, mu) or \"" + stateKey +
                "\" (position[3] and velocity[3], SI metres and m/s in an " +
                "inertial frame) — " +
                (hasElements ? "both were given" : "neither was given") + ".");
        return false;
    }

    if (hasElements) {
        if (!readChief(params, elementsKey, operation, out)) return false;
        return true;
    }

    double position[3];
    double velocity[3];
    if (!json_lite::requireVec3(*state, "position", operation, position) ||
        !json_lite::requireVec3(*state, "velocity", operation, velocity)) {
        return false;
    }
    double mu = defaultMu;
    if (!json_lite::optionalPositive(*state, "mu", operation, &mu)) return false;
    *out = stateToClassicalElements(toVector3(position), toVector3(velocity), mu);
    return !fault::raised();
}

/// The wire spelling of a phasing direction. One function so the request
/// reader and the response writer cannot drift apart.
const char* directionName(PhasingDirection direction) {
    switch (direction) {
        case PhasingDirection::CATCH_UP:    return "catchUp";
        case PhasingDirection::FALL_BEHIND: return "fallBehind";
        case PhasingDirection::SHORT:       break;
    }
    return "short";
}

bool readPhasingDirection(const Value& params, const char* op,
                          PhasingDirection* out) {
    std::string text = "short";
    if (!json_lite::optionalString(params, "direction", op, &text)) return false;
    if (text == "short")      { *out = PhasingDirection::SHORT;       return true; }
    if (text == "catchUp")    { *out = PhasingDirection::CATCH_UP;    return true; }
    if (text == "fallBehind") { *out = PhasingDirection::FALL_BEHIND; return true; }
    fault::raise(fault_code::INVALID_PARAMETER,
                 std::string("[") + op +
                     "]: direction must be \"short\", \"catchUp\" or "
                     "\"fallBehind\" (got \"" + text +
                     "\"). There are exactly two ways to close an along-track "
                     "gap — gain phase or lose it — and \"short\" is whichever "
                     "of them is the smaller angle.");
    return false;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

std::string hohmannTransfer(const Value& params) {
    const char* op = "hohmannTransfer";
    double r1 = 0.0, r2 = 0.0, mu = MU_EARTH;
    if (!json_lite::requirePositive(params, "r1", op, &r1) ||
        !json_lite::requirePositive(params, "r2", op, &r2) ||
        !json_lite::optionalPositive(params, "mu", op, &mu)) {
        return {};
    }
    const auto result = computeHohmannTransfer(r1, r2, mu);
    if (fault::raised()) return {};

    ObjectWriter out;
    out.number("dv1", result.dv1)
        .number("dv2", result.dv2)
        .number("totalDeltaV", result.totalDeltaV)
        .number("tof", result.tof)
        .number("aTransfer", result.aTransfer);
    writeVec3(out, "dv1_ric", result.dv1_ric);
    writeVec3(out, "dv2_ric", result.dv2_ric);
    writeDeltaVFrame(out);
    if (!out.ok()) return {};
    return out.finish();
}

std::string biEllipticTransfer(const Value& params) {
    const char* op = "biEllipticTransfer";
    double r1 = 0.0, r2 = 0.0, rInt = 0.0, mu = MU_EARTH;
    if (!json_lite::requirePositive(params, "r1", op, &r1) ||
        !json_lite::requirePositive(params, "r2", op, &r2) ||
        !json_lite::requirePositive(params, "rIntermediate", op, &rInt) ||
        !json_lite::optionalPositive(params, "mu", op, &mu)) {
        return {};
    }
    const auto result = computeBiEllipticTransfer(r1, r2, rInt, mu);
    if (fault::raised()) return {};

    // The RIC arrays and both transfer semi-major axes were COMPUTED by 0.1.0
    // and then dropped three lines before they reached a caller, forcing the
    // console to recover the burn signs from monotone comparisons. They are
    // serialised here (graph: rebuild-batch item 6).
    ObjectWriter out;
    out.number("dv1", result.dv1)
        .number("dv2", result.dv2)
        .number("dv3", result.dv3)
        .number("totalDeltaV", result.totalDeltaV)
        .number("tof", result.tof)
        .number("aTransfer1", result.aTransfer1)
        .number("aTransfer2", result.aTransfer2);
    writeVec3(out, "dv1_ric", result.dv1_ric);
    writeVec3(out, "dv2_ric", result.dv2_ric);
    writeVec3(out, "dv3_ric", result.dv3_ric);
    writeDeltaVFrame(out);
    if (!out.ok()) return {};
    return out.finish();
}

/// Rotate one delta-v between the canonical RIC triad and the inertial frame.
///
/// The D1 defect (`graph/findings/official-harness-shapes.md`) was not that the
/// frame was named wrongly — it was that NO frame was ever applied: r/t/n
/// components were written onto x/y/z raw. Declaring the frame on the wire
/// closes half of that; this operation closes the other half by making the
/// rotation a thing a caller can actually perform, against the SAME triad the
/// module's own results are expressed in, rather than re-deriving one of the
/// three variants that were live across the stack.
///
/// params: { position:[x,y,z], velocity:[x,y,z], deltaV:[a,b,c],
///           from:"RIC"|"ECI" }   (`from` defaults to "RIC")
/// result: { deltaV:[...], frame:"ECI"|"RIC", magnitude, basis:{R,I,C} }
///
/// The rotation is orthonormal by construction, so RIC -> ECI -> RIC is exact
/// to rounding; `tests/frame_and_sign.test.mjs` asserts that round trip.
std::string transformDeltaVOp(const Value& params) {
    const char* op = "transformDeltaV";
    double position[3] = {0, 0, 0};
    double velocity[3] = {0, 0, 0};
    double deltaV[3] = {0, 0, 0};
    if (!json_lite::requireVec3(params, "position", op, position) ||
        !json_lite::requireVec3(params, "velocity", op, velocity) ||
        !json_lite::requireVec3(params, "deltaV", op, deltaV)) {
        return {};
    }
    std::string from = "RIC";
    if (!json_lite::optionalString(params, "from", op, &from)) return {};
    if (from != "RIC" && from != "ECI") {
        fault::raise(fault_code::INVALID_PARAMETER,
                     std::string("[") + op +
                         "]: `from` must be \"RIC\" or \"ECI\" (got \"" + from +
                         "\"). There is no default triad to fall back on.");
        return {};
    }

    Vector3 R{}, I{}, C{};
    if (!ricBasisFromState(toVector3(position), toVector3(velocity), op,
                           &R, &I, &C)) {
        return {};
    }

    const Vector3 d = toVector3(deltaV);
    Vector3 result{};
    const char* resultFrame = nullptr;
    if (from == "RIC") {
        // ECI = R*d_r + I*d_i + C*d_c  (basis vectors are the RIC axes in ECI)
        for (int k = 0; k < 3; ++k) {
            result[k] = R[k] * d[0] + I[k] * d[1] + C[k] * d[2];
        }
        resultFrame = "ECI";
    } else {
        // RIC = (d.R, d.I, d.C)
        result = {dot3(d, R), dot3(d, I), dot3(d, C)};
        resultFrame = "RIC";
    }

    ObjectWriter out;
    writeVec3(out, "deltaV", result);
    out.string("frame", resultFrame).number("magnitude", norm3(result));
    ObjectWriter basis;
    writeVec3(basis, "R", R);
    writeVec3(basis, "I", I);
    writeVec3(basis, "C", C);
    if (!basis.ok()) return {};
    out.raw("basis", basis.finish());
    if (!out.ok()) return {};
    return out.finish();
}

/// The wire spelling of a branch. One function so the request reader and the
/// response writer cannot drift apart.
const char* branchName(LambertBranch branch) {
    return branch == LambertBranch::HIGH ? "high" : "low";
}

const char* conicName(ConicType type) {
    switch (type) {
        case ConicType::HYPERBOLIC: return "hyperbolic";
        case ConicType::PARABOLIC:  return "parabolic";
        case ConicType::ELLIPTIC:   break;
    }
    return "elliptic";
}

/// Read the optional `branch` selector. Absent => LOW, which is what 0.2.0
/// always returned, so an existing caller's answer does not move.
bool readLambertBranch(const Value& params, const char* op, bool* present,
                       LambertBranch* out) {
    *present = params.find("branch") != nullptr &&
               !params.find("branch")->isNull();
    std::string text = "low";
    if (!json_lite::optionalString(params, "branch", op, &text)) return false;
    if (text == "low") {
        *out = LambertBranch::LOW;
        return true;
    }
    if (text == "high") {
        *out = LambertBranch::HIGH;
        return true;
    }
    fault::raise(fault_code::INVALID_PARAMETER,
                 std::string("[") + op +
                     "]: branch must be \"low\" or \"high\" (got \"" + text +
                     "\"). A multi-revolution Lambert problem has exactly two "
                     "arcs per revolution count; there is no third to name.");
    return false;
}

/// The candidate set `solveLambertMinDV` ranked, as a JSON array.
///
/// Built through nested writers rather than by string concatenation so that
/// every number goes through the same finiteness gate as the rest of the
/// document; `ObjectWriter::raw` splices bytes and validates nothing, so the
/// nested `ok()` is propagated to the caller explicitly.
std::string writeRankedCandidates(const std::vector<LambertCandidate>& ranked,
                                  bool* ok) {
    std::string out = "[";
    for (std::size_t i = 0; i < ranked.size(); ++i) {
        const LambertCandidate& candidate = ranked[i];
        ObjectWriter entry;
        entry.integer("revolutions", candidate.revolutions);
        if (candidate.revolutions >= 1) entry.string("branch", branchName(candidate.branch));
        entry.number("dv1", candidate.dv1)
            .number("dv2", candidate.dv2)
            .number("totalDeltaV", candidate.totalDeltaV);
        if (!entry.ok()) {
            *ok = false;
            return {};
        }
        if (i != 0) out.push_back(',');
        out += entry.finish();
    }
    out.push_back(']');
    return out;
}

/// Shared serialisation for both Lambert entry points.
std::string writeLambert(const LambertResult& result, const char* op) {
    if (!result.converged) {
        // A Lambert solve that did not converge is not a partial answer to be
        // decorated with velocities a caller might use. It is a refusal.
        fault::raise(fault_code::NO_SOLUTION,
                     std::string("[") + op + "]: no solution (" + result.status +
                         "): there is no " + std::to_string(result.revolutions) +
                         "-revolution arc connecting these positions in the "
                         "stated time of flight");
        return {};
    }
    ObjectWriter out;
    writeVec3(out, "v1", result.v1);
    writeVec3(out, "v2", result.v2);
    out.number("v1Magnitude", result.v1Magnitude)
        .number("v2Magnitude", result.v2Magnitude)
        .number("tof", result.tof)
        .boolean("converged", result.converged)
        .string("status", result.status)
        .number("residual", result.residual)
        .number("residualBudget", result.residualBudget)
        .number("z", result.z)
        .integer("iterations", result.iterations)
        .integer("revolutions", result.revolutions);
    if (result.hasDeltaV) {
        out.number("dv1", result.dv1)
            .number("dv2", result.dv2)
            .number("totalDeltaV", result.totalDeltaV);
        writeVec3(out, "dv1_vec", result.dv1_vec);
        writeVec3(out, "dv2_vec", result.dv2_vec);
        // NOT RIC. A Lambert solve is stated in the same INERTIAL frame its
        // r1/r2/velocity inputs arrived in, so its delta-v vectors are
        // inertial too. Declared explicitly rather than left to be guessed:
        // that guess is exactly the D1 defect.
        out.string("frame", "ECI");
    }
    // -----------------------------------------------------------------------
    // ADDITIVE, 0.3.0. Every field above keeps its 0.2.0 value and meaning; a
    // consumer written against 0.2.0 reads this response unchanged.
    //
    // Two of these keys are CONDITIONAL, and the condition is part of the
    // contract rather than an implementation detail (the `hasDeltaV` block
    // above is the precedent inside this same surface):
    //
    //   `branch`   appears only when `revolutions >= 1`. At zero revolutions
    //              the universal-variable root is unique and there is no
    //              branch to name; emitting a constant would be inventing a
    //              distinction the mathematics does not have.
    //   `apogeeRadius` / `transferSemiMajorAxis`
    //              appear only when the quantity EXISTS and is representable.
    //              A hyperbolic transfer has no apoapsis and a parabolic one
    //              has neither; `transferConic` is always present so that
    //              "this arc has no apoapsis" is never confused with "this
    //              field was dropped". Emitting an infinity instead would fail
    //              the writer's finiteness gate and turn a converged solve into
    //              an error — which is not an additive change.
    // -----------------------------------------------------------------------
    if (result.revolutions >= 1) out.string("branch", branchName(result.branch));
    if (result.hasTransferConic) {
        out.string("transferConic", conicName(result.transferConicType))
            .number("perigeeRadius", result.perigeeRadius)
            .number("transferEccentricity", result.transferEccentricity);
        if (result.hasApogeeRadius) out.number("apogeeRadius", result.apogeeRadius);
        if (result.hasTransferSemiMajorAxis) {
            out.number("transferSemiMajorAxis", result.transferSemiMajorAxis);
        }
    }
    if (!result.ranked.empty()) {
        bool rankedOk = true;
        const std::string candidates = writeRankedCandidates(result.ranked, &rankedOk);
        if (!rankedOk) {
            out.invalidate();
        } else {
            out.raw("branches", candidates);
        }
    }
    if (!out.ok()) return {};
    return out.finish();
}

bool readLambertEndpoints(const Value& params, const char* op,
                          bool* have, Vector3* vDepart, Vector3* vArrive) {
    double depart[3] = {0.0, 0.0, 0.0};
    double arrive[3] = {0.0, 0.0, 0.0};
    bool hasDepart = false;
    bool hasArrive = false;
    if (!json_lite::optionalVec3(params, "departureVelocity", op, depart, &hasDepart) ||
        !json_lite::optionalVec3(params, "arrivalVelocity", op, arrive, &hasArrive)) {
        return false;
    }
    if (hasDepart != hasArrive) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     std::string("[") + op +
                         "]: departureVelocity and arrivalVelocity must be "
                         "supplied together — a delta-v needs both endpoints");
        return false;
    }
    *have = hasDepart;
    *vDepart = toVector3(depart);
    *vArrive = toVector3(arrive);
    return true;
}

std::string solveLambertOp(const Value& params) {
    const char* op = "solveLambert";
    double r1[3], r2[3];
    double tof = 0.0, mu = MU_EARTH;
    bool prograde = true;
    int nRevs = 0;
    if (!json_lite::requireVec3(params, "r1", op, r1) ||
        !json_lite::requireVec3(params, "r2", op, r2) ||
        !json_lite::requirePositive(params, "tof", op, &tof) ||
        !json_lite::optionalPositive(params, "mu", op, &mu) ||
        !json_lite::optionalBool(params, "prograde", op, &prograde) ||
        !json_lite::optionalInt(params, "nRevs", op, &nRevs)) {
        return {};
    }
    if (nRevs < 0 || nRevs > 20) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     "[solveLambert]: nRevs must be in [0, 20] (got " +
                         std::to_string(nRevs) + ")");
        return {};
    }

    bool haveEndpoints = false;
    Vector3 vDepart{};
    Vector3 vArrive{};
    if (!readLambertEndpoints(params, op, &haveEndpoints, &vDepart, &vArrive)) {
        return {};
    }
    bool branchGiven = false;
    LambertBranch branch = LambertBranch::LOW;
    if (!readLambertBranch(params, op, &branchGiven, &branch)) return {};

    auto result =
        solveLambert(toVector3(r1), toVector3(r2), tof, mu, prograde, nRevs, branch);
    if (fault::raised()) return {};
    if (result.converged && haveEndpoints) {
        const Vector3 dv1 = sub3(result.v1, vDepart);
        const Vector3 dv2 = sub3(vArrive, result.v2);
        result.dv1 = norm3(dv1);
        result.dv2 = norm3(dv2);
        result.totalDeltaV = result.dv1 + result.dv2;
        result.dv1_vec = dv1;
        result.dv2_vec = dv2;
        result.hasDeltaV = true;
    }
    return writeLambert(result, op);
}

std::string solveLambertMinDVOp(const Value& params) {
    const char* op = "solveLambertMinDV";
    double r1[3], r2[3];
    double tof = 0.0, mu = MU_EARTH;
    bool prograde = true;
    int maxRevs = 5;
    if (!json_lite::requireVec3(params, "r1", op, r1) ||
        !json_lite::requireVec3(params, "r2", op, r2) ||
        !json_lite::requirePositive(params, "tof", op, &tof) ||
        !json_lite::optionalPositive(params, "mu", op, &mu) ||
        !json_lite::optionalBool(params, "prograde", op, &prograde) ||
        !json_lite::optionalInt(params, "maxRevs", op, &maxRevs)) {
        return {};
    }
    if (maxRevs < 0 || maxRevs > 20) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     "[solveLambertMinDV]: maxRevs must be in [0, 20] (got " +
                         std::to_string(maxRevs) + ")");
        return {};
    }
    bool haveEndpoints = false;
    Vector3 vDepart{};
    Vector3 vArrive{};
    if (!readLambertEndpoints(params, op, &haveEndpoints, &vDepart, &vArrive)) {
        return {};
    }
    if (!haveEndpoints) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     "[solveLambertMinDV]: departureVelocity and arrivalVelocity "
                     "are required. Ranking revolution counts needs a real cost; "
                     "0.1.0 minimised |v1| + |v2|, the sum of the transfer "
                     "SPEEDS, which is not the cost of anything.");
        return {};
    }
    // On this operation `branch` NARROWS the candidate set rather than choosing
    // an arc: ranking is the whole point, so the default is to rank over both
    // branches of every revolution count, and a caller that names one is
    // deliberately excluding the other.
    bool branchGiven = false;
    LambertBranch branch = LambertBranch::LOW;
    if (!readLambertBranch(params, op, &branchGiven, &branch)) return {};
    const auto result =
        solveLambertMinDV(toVector3(r1), toVector3(r2), tof, mu, prograde, maxRevs,
                          true, vDepart, vArrive, branchGiven ? &branch : nullptr);
    if (fault::raised()) return {};
    return writeLambert(result, op);
}

/// Serialise a phasing plan. ONE writer, shared by `phasingManeuver` and
/// `phasingFromTargetState`, so the two operations cannot drift into two
/// spellings of the same solution.
void writePhasingPlan(ObjectWriter& out, const PhasingResult& result) {
    out.number("dv1", result.dv1)
        .number("dv2", result.dv2)
        .number("totalDeltaV", result.totalDeltaV)
        .number("phasingPeriod", result.phasingPeriod)
        .number("phasingSMA", result.phasingSMA)
        .number("totalTime", result.totalTime)
        .integer("numRevs", result.numRevs)
        .number("phaseAngle", result.phaseAngle);
    // The SIGNED burns. 0.1.0 computed these and serialised only std::abs of
    // their in-track component, so the console had to recover the sign from
    // sign(phasingSMA - currentRadius).
    writeVec3(out, "dv1_ric", result.dv1_ric);
    writeVec3(out, "dv2_ric", result.dv2_ric);
    writeDeltaVFrame(out);
    // The Earth-collision guard, reported rather than silent.
    out.number("farApse", result.farApse)
        .number("earthFloorRadius", result.earthFloorRadius)
        .boolean("clampedToEarthFloor", result.clampedToEarthFloor)
        .number("achievedPhaseAngle", result.achievedPhaseAngle)
        .number("requestedPhasingSMA", result.requestedPhasingSMA)
        .number("requestedPhasingPeriod", result.requestedPhasingPeriod);
}

std::string phasingManeuver(const Value& params) {
    const char* op = "phasingManeuver";
    double currentRadius = 0.0, phaseAngle = 0.0, mu = MU_EARTH;
    int numRevs = 1;
    if (!json_lite::requireNumber(params, "currentRadius", op, &currentRadius) ||
        !json_lite::requireNumber(params, "phaseAngle", op, &phaseAngle) ||
        !json_lite::optionalInt(params, "numRevs", op, &numRevs) ||
        !json_lite::optionalPositive(params, "mu", op, &mu)) {
        return {};
    }
    const auto result = computePhasingManeuver(currentRadius, phaseAngle, numRevs, mu);
    if (fault::raised()) return {};

    ObjectWriter out;
    writePhasingPlan(out, result);
    if (!out.ok()) return {};
    return out.finish();
}

/// One direction's summary, as a nested object. Built through its OWN writer
/// so every number passes the same finiteness gate as the outer document, and
/// its `ok()` is propagated explicitly — `raw` splices bytes and validates
/// nothing.
std::string writeBranchSummary(const PhasingBranchSummary& summary, bool* ok) {
    ObjectWriter entry;
    entry.number("phaseAngle", summary.phaseAngle)
        .integer("numRevs", summary.numRevs)
        .number("totalDeltaV", summary.totalDeltaV)
        .number("totalTime", summary.totalTime)
        .number("phasingSMA", summary.phasingSMA)
        .boolean("clampedToEarthFloor", summary.clampedToEarthFloor)
        .boolean("metDeltaVBudget", summary.metDeltaVBudget);
    if (!entry.ok()) {
        *ok = false;
        return {};
    }
    return entry.finish();
}

/// PHASING FROM A TARGET SPACECRAFT.
///
/// `phasingManeuver` has always taken the phase angle as an INPUT. Nothing
/// mapped a target craft to that angle, so a console holding two spacecraft
/// states had to difference two mean anomalies in JavaScript to get it — which
/// the no-JS-physics law forbids, and which is wrong anyway the moment the two
/// orbits' apsides differ. This operation is that missing map: two craft in,
/// the angle and the plan that closes it out.
std::string phasingFromTargetState(const Value& params) {
    const char* op = "phasingFromTargetState";
    double mu = MU_EARTH;
    if (!json_lite::optionalPositive(params, "mu", op, &mu)) return {};

    ClassicalOrbitalElements chaser{};
    ClassicalOrbitalElements target{};
    if (!readCraft(params, "chaser", "chaserState", op, mu, &chaser) ||
        !readCraft(params, "target", "targetState", op, mu, &target)) {
        return {};
    }

    PhasingFromStateOptions options;
    options.mu = mu;
    int numRevs = 0;
    int maxRevs = options.maxRevs;
    if (!readPhasingDirection(params, op, &options.direction) ||
        !json_lite::optionalInt(params, "numRevs", op, &numRevs) ||
        !json_lite::optionalInt(params, "maxRevs", op, &maxRevs) ||
        !json_lite::optionalNumber(params, "deltaVBudget", op,
                                   &options.deltaVBudget) ||
        !json_lite::optionalNumber(params, "deltaVBudgetFraction", op,
                                   &options.deltaVBudgetFraction) ||
        !json_lite::optionalNumber(params, "coplanarTolerance", op,
                                   &options.coplanarTolerance) ||
        !json_lite::optionalNumber(params, "eccentricityTolerance", op,
                                   &options.eccentricityTolerance) ||
        !json_lite::optionalNumber(params, "coOrbitalTolerance", op,
                                   &options.coOrbitalTolerance)) {
        return {};
    }
    // ABSENT and ZERO are different requests, and `numRevs = 0` as the
    // "recommend it for me" sentinel would make them the same one. Presence is
    // read off the request rather than inferred from the value, so a caller
    // that asks for zero revolutions gets the refusal `phasingManeuver` would
    // have given it instead of a silently recommended count.
    const Value* numRevsGiven = params.find("numRevs");
    if (numRevsGiven != nullptr && !numRevsGiven->isNull() && numRevs < 1) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     std::string("[") + op +
                         "]: numRevs must be >= 1 when it is given at all; "
                         "omit it to have the revolution count recommended");
        return {};
    }
    if (!(options.deltaVBudgetFraction > 0.0)) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     std::string("[") + op +
                         "]: deltaVBudgetFraction must be positive (it is a "
                         "fraction of the chaser's circular speed)");
        return {};
    }
    if (options.coplanarTolerance < 0.0 || options.eccentricityTolerance < 0.0 ||
        options.coOrbitalTolerance < 0.0) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     std::string("[") + op +
                         "]: coplanarTolerance, eccentricityTolerance and "
                         "coOrbitalTolerance are thresholds and cannot be "
                         "negative");
        return {};
    }
    options.numRevs = numRevs;
    options.maxRevs = maxRevs;

    const auto result = computePhasingFromTargetState(chaser, target, options);
    if (fault::raised()) return {};
    const PhaseGeometry& geometry = result.geometry;

    ObjectWriter out;
    // THE ANSWER. Everything after this is the evidence for it.
    out.number("relativePhaseAngle", geometry.relativePhaseAngle)
        .number("catchUpAngle", geometry.catchUpAngle)
        .number("fallBehindAngle", geometry.fallBehindAngle)
        .string("direction", directionName(options.direction));
    // The angles the wrap was taken over, published so the derivation is
    // auditable from the response alone.
    out.number("chaserMeanArgumentOfLatitude",
               geometry.chaserMeanArgumentOfLatitude)
        .number("targetMeanArgumentOfLatitude",
                geometry.targetMeanArgumentOfLatitude)
        .number("chaserMeanAnomaly", geometry.chaserMeanAnomaly)
        .number("targetMeanAnomaly", geometry.targetMeanAnomaly)
        .number("raanDifference", geometry.raanDifference)
        .number("inclinationDifference", geometry.inclinationDifference)
        .number("planeAngle", geometry.planeAngle)
        .number("chaserSemiMajorAxis", geometry.chaserSemiMajorAxis)
        .number("targetSemiMajorAxis", geometry.targetSemiMajorAxis)
        .number("semiMajorAxisDifference", geometry.semiMajorAxisDifference)
        .number("chaserEccentricity", geometry.chaserEccentricity)
        .number("targetEccentricity", geometry.targetEccentricity);
    // The three verdicts, each beside the threshold that produced it.
    out.boolean("coplanar", result.coplanar)
        .number("coplanarTolerance", result.coplanarTolerance)
        .boolean("nearCircular", result.nearCircular)
        .number("eccentricityTolerance", result.eccentricityTolerance)
        .boolean("coOrbital", result.coOrbital)
        .number("coOrbitalTolerance", result.coOrbitalToleranceMetres);
    // The revolution-count trade.
    out.integer("recommendedRevs", result.recommendedRevs)
        .boolean("revsFromCaller", result.revsFromCaller)
        .boolean("metDeltaVBudget", result.metDeltaVBudget)
        .number("deltaVBudget", result.deltaVBudget)
        .integer("maxRevs", result.maxRevsApplied)
        .number("phasingRadius", result.phasingRadius);
    // The plan, in `phasingManeuver`'s own spelling.
    writePhasingPlan(out, result.plan);
    // And the road not taken, in both directions, always.
    bool nested = true;
    const std::string catchUp = writeBranchSummary(result.catchUp, &nested);
    const std::string fallBehind = writeBranchSummary(result.fallBehind, &nested);
    if (!nested) {
        out.invalidate();
    } else {
        out.raw("catchUp", catchUp).raw("fallBehind", fallBehind);
    }
    if (!out.ok()) return {};
    return out.finish();
}

std::string planeChange(const Value& params) {
    const char* op = "planeChange";
    double orbitalRadius = 0.0, velocity = 0.0, deltaInclination = 0.0;
    if (!json_lite::requirePositive(params, "orbitalRadius", op, &orbitalRadius) ||
        !json_lite::requireNumber(params, "velocity", op, &velocity) ||
        !json_lite::requireNumber(params, "deltaInclination", op, &deltaInclination)) {
        return {};
    }
    const auto result = computePlaneChange(orbitalRadius, velocity, deltaInclination);
    if (fault::raised()) return {};

    ObjectWriter out;
    out.number("dv", result.dv).number("optimalTrueAnomaly", result.optimalTrueAnomaly);
    writeVec3(out, "dv_ric", result.dv_ric);
    writeDeltaVFrame(out);
    if (!out.ok()) return {};
    return out.finish();
}

std::string combinedManeuver(const Value& params) {
    const char* op = "combinedManeuver";
    double r1 = 0.0, r2 = 0.0, deltaInclination = 0.0, mu = MU_EARTH;
    if (!json_lite::requirePositive(params, "r1", op, &r1) ||
        !json_lite::requirePositive(params, "r2", op, &r2) ||
        !json_lite::requireNumber(params, "deltaInclination", op, &deltaInclination) ||
        !json_lite::optionalPositive(params, "mu", op, &mu)) {
        return {};
    }
    const auto result = computeCombinedManeuver(r1, r2, deltaInclination, mu);
    if (fault::raised()) return {};

    ObjectWriter out;
    out.number("dv1", result.dv1)
        .number("dv2", result.dv2)
        .number("totalDeltaV", result.totalDeltaV)
        .number("tof", result.tof)
        .number("aTransfer", result.aTransfer);
    // Burn 2 carries the in-track/cross-track split of the combined
    // circularisation + plane change. 0.1.0 computed both components and
    // emitted neither, so the console reconstructed them from aTransfer.
    writeVec3(out, "dv1_ric", result.dv1_ric);
    writeVec3(out, "dv2_ric", result.dv2_ric);
    writeDeltaVFrame(out);
    if (!out.ok()) return {};
    return out.finish();
}

std::string computeRoeStateTransition(const Value& params) {
    const char* op = "computeRoeStateTransition";
    ClassicalOrbitalElements chief{};
    if (!readChief(params, "chief", op, &chief)) return {};
    double deltaTime = 0.0;
    std::string model = "j2";
    if (!json_lite::requireNumber(params, "deltaTime", op, &deltaTime) ||
        !json_lite::optionalString(params, "model", op, &model)) {
        return {};
    }

    STM6 stm{};
    std::string dragExtra;
    if (model == "keplerian") {
        stm = computeKeplerianSTM(chief, deltaTime);
    } else if (model == "j2") {
        stm = computeJ2STM(chief, deltaTime);
    } else if (model == "j2-drag-eccentric") {
        const auto result = computeJ2DragSTMEccentric(chief, deltaTime);
        for (int r = 0; r < 6; ++r) {
            for (int c = 0; c < 6; ++c) stm[r][c] = result.stm[r][c];
        }
        std::string column = "[";
        for (int i = 0; i < 6; ++i) {
            if (i != 0) column.push_back(',');
            if (!std::isfinite(result.dragColumn[i])) return {};
            column += json_lite::numberToString(result.dragColumn[i]);
        }
        column.push_back(']');
        dragExtra = column;
    } else if (model == "j2-drag-arbitrary") {
        const auto result = computeJ2DragSTMArbitrary(chief, deltaTime);
        for (int r = 0; r < 6; ++r) {
            for (int c = 0; c < 6; ++c) stm[r][c] = result.stm[r][c];
        }
        std::string columns = "[";
        bool firstRow = true;
        for (const auto& row : result.dragColumns) {
            if (!firstRow) columns.push_back(',');
            firstRow = false;
            columns.push_back('[');
            for (int i = 0; i < 3; ++i) {
                if (i != 0) columns.push_back(',');
                if (!std::isfinite(row[i])) return {};
                columns += json_lite::numberToString(row[i]);
            }
            columns.push_back(']');
        }
        columns.push_back(']');
        dragExtra = columns;
    } else {
        fault::raise(fault_code::UNKNOWN_OPERATION,
                     "[computeRoeStateTransition]: unsupported ROE STM model \"" +
                         model +
                         "\". Supported: keplerian, j2, j2-drag-eccentric, "
                         "j2-drag-arbitrary");
        return {};
    }
    if (fault::raised()) return {};

    std::string matrix = "[";
    for (int r = 0; r < 6; ++r) {
        if (r != 0) matrix.push_back(',');
        matrix.push_back('[');
        for (int c = 0; c < 6; ++c) {
            if (c != 0) matrix.push_back(',');
            if (!std::isfinite(stm[r][c])) return {};
            matrix += json_lite::numberToString(stm[r][c]);
        }
        matrix.push_back(']');
    }
    matrix.push_back(']');

    ObjectWriter out;
    out.string("reference", "Koenig-Guffanti-D'Amico ROE STM")
        .string("model", model)
        .number("deltaTime", deltaTime)
        .raw("stm", matrix);

    const Value* initialRoe = params.find("initialRoe");
    if (initialRoe != nullptr && !initialRoe->isNull()) {
        const Value* array = nullptr;
        if (!json_lite::requireArray(params, "initialRoe", op, &array)) return {};
        if (array->items.size() != 6) {
            fault::raise(fault_code::INVALID_PARAMETER,
                         "[computeRoeStateTransition]: initialRoe must be an "
                         "array of exactly 6 numbers");
            return {};
        }
        ROEVector roe{};
        for (int i = 0; i < 6; ++i) {
            if (!array->items[static_cast<std::size_t>(i)].isNumber()) {
                fault::raise(fault_code::INVALID_PARAMETER,
                             "[computeRoeStateTransition]: initialRoe component " +
                                 std::to_string(i) + " must be a number");
                return {};
            }
            roe[static_cast<std::size_t>(i)] =
                array->items[static_cast<std::size_t>(i)].number;
        }
        ROEPropagationOptions options{};
        if (!readPropagationOptions(params, op, &options)) return {};
        const auto propagated = propagateROE(vectorToROE(roe), chief, deltaTime, options);
        if (fault::raised()) return {};
        const ROEVector propagatedVector = roeToVector(propagated);
        out.numbers("initialRoe", roe.data(), roe.size());
        out.numbers("propagatedRoe", propagatedVector.data(), propagatedVector.size());
    }
    if (!dragExtra.empty()) {
        out.raw(model == "j2-drag-eccentric" ? "dragColumn" : "dragColumns", dragExtra);
    }
    if (!out.ok()) return {};
    return out.finish();
}

std::string planRelativeWaypointMission(const Value& params) {
    const char* op = "planRelativeWaypointMission";
    RelativeState state{};
    if (!readRelativeState(params, "initialState", op, &state)) return {};
    ClassicalOrbitalElements chief{};
    if (!readChief(params, "chief", op, &chief)) return {};

    const Value emptyObject = [] {
        Value value;
        value.kind = json_lite::Kind::Object;
        return value;
    }();
    const Value* optionsJson = params.find("options");
    if (optionsJson != nullptr && !optionsJson->isObject()) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     "[planRelativeWaypointMission]: parameter \"options\" must be an object");
        return {};
    }
    const Value& options_source = optionsJson != nullptr ? *optionsJson : emptyObject;
    TargetingOptions options{};
    if (!readTargetingOptions(options_source, op, &options)) return {};
    int pointsPerLeg = 48;
    if (!json_lite::optionalInt(options_source, "pointsPerLeg", op, &pointsPerLeg)) {
        return {};
    }
    if (pointsPerLeg < 1 || pointsPerLeg > 2048) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     "[planRelativeWaypointMission]: pointsPerLeg must be in "
                     "[1, 2048] (got " + std::to_string(pointsPerLeg) + ")");
        return {};
    }

    const Value* waypointArray = nullptr;
    if (!json_lite::requireArray(params, "waypoints", op, &waypointArray)) return {};
    if (waypointArray->items.empty() || waypointArray->items.size() > 256) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     "[planRelativeWaypointMission]: waypoints must carry between "
                     "1 and 256 entries (got " +
                         std::to_string(waypointArray->items.size()) + ")");
        return {};
    }
    std::vector<Waypoint> waypoints;
    waypoints.reserve(waypointArray->items.size());
    for (const Value& item : waypointArray->items) {
        if (!item.isObject()) {
            fault::raise(fault_code::INVALID_PARAMETER,
                         "[planRelativeWaypointMission]: every waypoint must be an object");
            return {};
        }
        Waypoint waypoint{};
        double position[3];
        if (!json_lite::requireVec3(item, "position", op, position)) return {};
        waypoint.position = toVector3(position);
        double velocity[3];
        bool hasVelocity = false;
        if (!json_lite::optionalVec3(item, "velocity", op, velocity, &hasVelocity)) {
            return {};
        }
        if (hasVelocity) {
            waypoint.velocity = toVector3(velocity);
            waypoint.hasVelocity = true;
        }
        if (item.has("tof")) {
            if (!json_lite::requirePositive(item, "tof", op, &waypoint.tofHint)) {
                return {};
            }
            waypoint.hasTofHint = true;
        }
        waypoints.push_back(waypoint);
    }

    const auto plan = planMission(state, waypoints, chief, options);
    if (fault::raised()) return {};
    const auto trajectory = generateMissionTrajectory(
        plan, chief, state.position, state.velocity, options, pointsPerLeg);
    if (fault::raised()) return {};

    ObjectWriter out;
    out.string("reference", "Koenig-Guffanti-D'Amico ROE STM")
        .string("model", options.includeJ2 ? "j2" : "keplerian")
        .boolean("includeDrag", options.includeDrag)
        .boolean("converged", plan.converged)
        .number("totalDeltaV", plan.totalDeltaV)
        .number("totalTime", plan.totalTime);

    std::string legs = "[";
    for (std::size_t index = 0; index < plan.legs.size(); ++index) {
        if (index != 0) legs.push_back(',');
        const auto& leg = plan.legs[index];
        ObjectWriter legOut;
        legOut.integer("index", static_cast<long long>(index));
        writeVec3(legOut, "from", leg.from);
        writeVec3(legOut, "to", leg.to);
        writeVec3(legOut, "targetVelocity", leg.targetVelocity);
        legOut.number("tof", leg.tof);
        for (int burn = 0; burn < 2; ++burn) {
            const Maneuver& maneuver = burn == 0 ? leg.burn1 : leg.burn2;
            ObjectWriter burnOut;
            writeVec3(burnOut, "deltaV", maneuver.deltaV);
            burnOut.number("magnitude", maneuver.magnitude);
            writeDeltaVFrame(burnOut);
            ObjectWriter chiefOut;
            chiefOut.number("semiMajorAxis", maneuver.chief.semiMajorAxis)
                .number("eccentricity", maneuver.chief.eccentricity)
                .number("inclination", maneuver.chief.inclination)
                .number("raan", maneuver.chief.raan)
                .number("argumentOfPerigee", maneuver.chief.argumentOfPerigee)
                .number("meanAnomaly", maneuver.chief.meanAnomaly)
                .number("mu", maneuver.chief.gravitationalParameter);
            if (!chiefOut.ok() || !burnOut.ok()) return {};
            burnOut.raw("chief", chiefOut.finish());
            legOut.raw(burn == 0 ? "burn1" : "burn2", burnOut.finish());
        }
        legOut.number("totalDeltaV", leg.totalDeltaV)
            .boolean("converged", leg.converged)
            .integer("iterations", leg.iterations)
            .number("positionError", leg.positionError);
        if (!legOut.ok()) return {};
        legs += legOut.finish();
    }
    legs.push_back(']');
    out.raw("legs", legs);

    std::string points = "[";
    bool firstPoint = true;
    for (const auto& point : trajectory) {
        if (!firstPoint) points.push_back(',');
        firstPoint = false;
        ObjectWriter pointOut;
        pointOut.number("time", point.time);
        writeVec3(pointOut, "position", point.position);
        writeVec3(pointOut, "velocity", point.velocity);
        if (!pointOut.ok()) return {};
        points += pointOut.finish();
    }
    points.push_back(']');
    out.raw("trajectory", points);

    if (!out.ok()) return {};
    return out.finish();
}

std::string computeCAMOp(const Value& params) {
    const char* op = "computeCAM";
    RelativeState state{};
    if (!readRelativeState(params, "initialState", op, &state)) return {};
    ClassicalOrbitalElements chief{};
    if (!readChief(params, "chief", op, &chief)) return {};

    CAMConfig config{};
    const Value* configJson = params.find("config");
    if (configJson != nullptr && !configJson->isNull()) {
        if (!configJson->isObject()) {
            fault::raise(fault_code::INVALID_PARAMETER,
                         "[computeCAM]: parameter \"config\" must be an object");
            return {};
        }
        if (!json_lite::optionalNumber(*configJson, "minMissDistance", op,
                                       &config.minMissDistance) ||
            !json_lite::optionalNumber(*configJson, "timeToTCA", op, &config.timeToTCA) ||
            !json_lite::optionalNumber(*configJson, "maxDeltaV", op, &config.maxDeltaV) ||
            !json_lite::optionalBool(*configJson, "preferRadial", op, &config.preferRadial)) {
            return {};
        }
    }
    const auto result = computeCAM(state, chief, config);
    if (fault::raised()) return {};

    ObjectWriter out;
    writeVec3(out, "deltaV", result.deltaV);
    writeDeltaVFrame(out);
    out.number("magnitude", result.magnitude)
        .number("achievedMiss", result.achievedMiss)
        .boolean("feasible", result.feasible)
        .number("optimalBurnTime", result.optimalBurnTime);
    if (!out.ok()) {
        // A CAM whose sensitivity denominator vanished yields a non-finite
        // burn. Refusing is the honest answer; emitting NaN is not JSON and
        // would explode at the consumer's parse instead of here.
        fault::raise(fault_code::INFEASIBLE,
                     "[computeCAM]: the requested miss distance is not reachable "
                     "at this geometry — the burn sensitivity is degenerate and "
                     "the solution is not a finite delta-v");
        return {};
    }
    return out.finish();
}

std::string computeApproachOp(const Value& params) {
    const char* op = "computeApproach";
    RelativeState state{};
    if (!readRelativeState(params, "initialState", op, &state)) return {};
    ClassicalOrbitalElements chief{};
    if (!readChief(params, "chief", op, &chief)) return {};

    ApproachConfig config{};
    const Value* configJson = params.find("config");
    if (configJson != nullptr && !configJson->isNull()) {
        if (!configJson->isObject()) {
            fault::raise(fault_code::INVALID_PARAMETER,
                         "[computeApproach]: parameter \"config\" must be an object");
            return {};
        }
        int axis = 0;
        if (!json_lite::optionalInt(*configJson, "axis", op, &axis)) return {};
        if (axis < 0 || axis > 2) {
            fault::raise(fault_code::INVALID_PARAMETER,
                         "[computeApproach]: axis must be 0 (V-bar), 1 (R-bar) "
                         "or 2 (H-bar) (got " + std::to_string(axis) + ")");
            return {};
        }
        config.axis = static_cast<ApproachAxis>(axis);
        double target[3];
        bool hasTarget = false;
        if (!json_lite::optionalVec3(*configJson, "targetPosition", op, target, &hasTarget)) {
            return {};
        }
        if (hasTarget) config.targetPosition = toVector3(target);
        if (!json_lite::optionalNumber(*configJson, "approachSpeed", op,
                                       &config.approachSpeed) ||
            !json_lite::optionalNumber(*configJson, "safetyCorridorWidth", op,
                                       &config.safetyCorridorWidth)) {
            return {};
        }
    }
    const auto result = computeApproach(state, chief, config);
    if (fault::raised()) return {};

    ObjectWriter legOut;
    legOut.number("totalDeltaV", result.leg.totalDeltaV);
    if (!legOut.ok()) return {};

    ObjectWriter out;
    out.number("corridorDeviation", result.corridorDeviation)
        .boolean("withinCorridor", result.withinCorridor)
        .integer("axis", static_cast<long long>(result.axis))
        .raw("leg", legOut.finish());
    if (!out.ok()) return {};
    return out.finish();
}

const char* phaseName(RendezvousPhase phase) {
    switch (phase) {
        case RendezvousPhase::DRIFT: return "drift";
        case RendezvousPhase::BRAKE: return "brake";
        case RendezvousPhase::HOLD: return "hold";
    }
    return "unknown";
}

std::string simulateRendezvousOp(const Value& params) {
    const char* op = "simulateRendezvous";
    ClassicalOrbitalElements chief{};
    if (!readChief(params, "chief", op, &chief)) return {};

    RendezvousConfig config{};
    double initialPosition[3], brakePoint[3], holdPoint[3];
    if (!json_lite::requireVec3(params, "initialPosition", op, initialPosition) ||
        !json_lite::requireVec3(params, "brakePoint", op, brakePoint) ||
        !json_lite::requireVec3(params, "holdPoint", op, holdPoint)) {
        return {};
    }
    config.initialPosition = toVector3(initialPosition);
    config.brakePoint = toVector3(brakePoint);
    config.holdPoint = toVector3(holdPoint);

    double initialVelocity[3];
    bool hasInitialVelocity = false;
    if (!json_lite::optionalVec3(params, "initialVelocity", op, initialVelocity,
                                 &hasInitialVelocity)) {
        return {};
    }
    if (hasInitialVelocity) {
        config.initialVelocity = toVector3(initialVelocity);
        config.solveInitialVelocity = false;
    }
    if (!json_lite::optionalBool(params, "solveInitialVelocity", op,
                                 &config.solveInitialVelocity) ||
        !json_lite::requirePositive(params, "driftDuration", op, &config.driftDuration) ||
        !json_lite::requirePositive(params, "brakeDuration", op, &config.brakeDuration) ||
        !json_lite::optionalNumber(params, "holdDuration", op, &config.holdDuration)) {
        return {};
    }

    const Value* control = params.find("control");
    if (control != nullptr && control->isObject()) {
        if (!json_lite::optionalNumber(*control, "bandwidth", op, &config.controlBandwidth) ||
            !json_lite::optionalNumber(*control, "dampingRatio", op, &config.dampingRatio) ||
            !json_lite::optionalNumber(*control, "kp", op, &config.kp) ||
            !json_lite::optionalNumber(*control, "kd", op, &config.kd) ||
            !json_lite::optionalBool(*control, "useFeedforward", op, &config.useFeedforward) ||
            !json_lite::optionalBool(*control, "compensateCoriolis", op,
                                     &config.compensateCoriolis) ||
            !json_lite::optionalBool(*control, "compensateGravityGradient", op,
                                     &config.compensateGravityGradient) ||
            !json_lite::optionalNumber(*control, "maxAccel", op, &config.maxAccel)) {
            return {};
        }
    }
    const Value* integration = params.find("integration");
    if (integration != nullptr && integration->isObject()) {
        if (!json_lite::optionalPositive(*integration, "timeStep", op, &config.timeStep) ||
            !json_lite::optionalInt(*integration, "outputEvery", op, &config.outputEvery) ||
            !json_lite::optionalBool(*integration, "includeJ2", op, &config.includeJ2)) {
            return {};
        }
        if (config.outputEvery < 1) {
            fault::raise(fault_code::INVALID_PARAMETER,
                         "[simulateRendezvous]: integration.outputEvery must be >= 1");
            return {};
        }
    }
    // Step-count guard: `timeStep` and the durations together decide how many
    // integration steps run inside the guest. Unbounded, a request of
    // driftDuration=1e12 with timeStep=1e-6 is a hang, and a hung guest is a
    // dead instance to every caller sharing it.
    const double totalDuration =
        config.driftDuration + config.brakeDuration + config.holdDuration;
    if (!(config.timeStep > 0.0) || totalDuration / config.timeStep > 5.0e6) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     "[simulateRendezvous]: (driftDuration + brakeDuration + "
                     "holdDuration) / integration.timeStep must not exceed 5e6 "
                     "steps");
        return {};
    }

    const auto result = simulateRendezvous(config, chief);
    if (fault::raised()) return {};
    if (!result.valid) {
        fault::raise(fault_code::INFEASIBLE,
                     std::string("[simulateRendezvous]: ") + result.message);
        return {};
    }

    ObjectWriter out;
    out.string("reference",
               "HCW combined-case drift + quintic brake + feedback-linearized PD")
        .number("meanMotion", result.meanMotion);
    writeVec3(out, "solvedInitialVelocity", result.solvedInitialVelocity);

    ObjectWriter gains;
    writeVec3(gains, "kp", result.gainKp);
    writeVec3(gains, "kd", result.gainKd);
    if (!gains.ok()) return {};
    out.raw("gains", gains.finish());

    ObjectWriter phases;
    phases.number("driftEnd", result.driftEnd)
        .number("brakeEnd", result.brakeEnd)
        .number("totalTime", result.totalTime);
    if (!phases.ok()) return {};
    out.raw("phases", phases.finish());

    ObjectWriter metrics;
    metrics.number("totalDeltaV", result.metrics.totalDeltaV)
        .number("maxControlAccel", result.metrics.maxControlAccel)
        .integer("saturatedSteps", result.metrics.saturatedSteps)
        .number("maxPositionError", result.metrics.maxPositionError)
        .number("rmsPositionError", result.metrics.rmsPositionError)
        .number("maxPositionErrorDrift", result.metrics.maxPositionErrorDrift)
        .number("maxPositionErrorBrake", result.metrics.maxPositionErrorBrake)
        .number("maxPositionErrorHold", result.metrics.maxPositionErrorHold)
        .number("finalPositionError", result.metrics.finalPositionError)
        .number("finalVelocityError", result.metrics.finalVelocityError);
    if (!metrics.ok()) return {};
    out.raw("metrics", metrics.finish());

    std::string samples = "[";
    bool firstSample = true;
    for (const auto& sample : result.trajectory) {
        if (!firstSample) samples.push_back(',');
        firstSample = false;
        ObjectWriter sampleOut;
        sampleOut.number("time", sample.time).string("phase", phaseName(sample.phase));
        writeVec3(sampleOut, "position", sample.position);
        writeVec3(sampleOut, "velocity", sample.velocity);
        writeVec3(sampleOut, "referencePosition", sample.referencePosition);
        writeVec3(sampleOut, "referenceVelocity", sample.referenceVelocity);
        writeVec3(sampleOut, "referenceAcceleration", sample.referenceAcceleration);
        writeVec3(sampleOut, "controlAccel", sample.controlAccel);
        sampleOut.number("positionError", sample.positionError)
            .number("velocityError", sample.velocityError);
        if (!sampleOut.ok()) return {};
        samples += sampleOut.finish();
    }
    samples.push_back(']');
    out.raw("trajectory", samples);

    if (!out.ok()) return {};
    return out.finish();
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

std::string dispatch(const std::string& operation, const Value& params) {
    if (operation == "version") {
        ObjectWriter out;
        out.string("version", version());
        return out.finish();
    }
    if (operation == "hohmannTransfer") return hohmannTransfer(params);
    if (operation == "biEllipticTransfer") return biEllipticTransfer(params);
    if (operation == "solveLambert") return solveLambertOp(params);
    if (operation == "solveLambertMinDV") return solveLambertMinDVOp(params);
    if (operation == "phasingManeuver") return phasingManeuver(params);
    if (operation == "phasingFromTargetState") return phasingFromTargetState(params);
    if (operation == "planeChange") return planeChange(params);
    if (operation == "transformDeltaV") return transformDeltaVOp(params);
    if (operation == "evaluateOrbitGeometry" || operation == "convertOrbitAnomaly" ||
        operation == "orbitTimeOfFlight" || operation == "sampleOrbitGeometry") {
        return orbitGeometryOperation(operation, params);
    }
    if (operation == "combinedManeuver") return combinedManeuver(params);
    if (operation == "computeRoeStateTransition") return computeRoeStateTransition(params);
    if (operation == "planRelativeWaypointMission") return planRelativeWaypointMission(params);
    if (operation == "computeCAM") return computeCAMOp(params);
    if (operation == "computeApproach") return computeApproachOp(params);
    if (operation == "simulateRendezvous") return simulateRendezvousOp(params);

    fault::raise(fault_code::UNKNOWN_OPERATION,
                 "Unknown maneuver operation: \"" + operation +
                     "\". Supported: version, hohmannTransfer, "
                     "biEllipticTransfer, solveLambert, solveLambertMinDV, "
                     "phasingManeuver, phasingFromTargetState, planeChange, "
                     "combinedManeuver, computeRoeStateTransition, "
                     "planRelativeWaypointMission, computeCAM, computeApproach, "
                     "simulateRendezvous");
    return {};
}

PluginInvokeResult errorResult(const char* code, std::string message) {
    PluginInvokeResult result{};
    result.ok = false;
    result.error_code = code;
    result.error_message = std::move(message);
    ObjectWriter out;
    out.string("error", result.error_message).string("errorCode", result.error_code);
    result.json = out.finish();
    return result;
}

}  // namespace

PluginInvokeResult invoke_json_request(std::string_view request_json) {
    // A fault latched by a PREVIOUS call must never fail this one. This one
    // line is what makes "the instance is still usable for the next call" true.
    fault::reset();

    if (request_json.size() > (8u << 20)) {
        return errorResult(fault_code::MALFORMED_REQUEST,
                           "Request body exceeds the 8 MiB ceiling.");
    }

    Value request;
    std::string parseError;
    if (!json_lite::parse(request_json, &request, &parseError)) {
        return errorResult(fault_code::MALFORMED_REQUEST,
                           "Request body is not valid JSON: " + parseError);
    }
    if (!request.isObject()) {
        return errorResult(fault_code::MALFORMED_REQUEST,
                           "Request body must be a JSON object of the form "
                           "{\"operation\": \"...\", \"params\": { ... }}.");
    }
    const Value* operationValue = request.find("operation");
    if (operationValue == nullptr) {
        return errorResult(fault_code::MALFORMED_REQUEST,
                           "Request is missing the required \"operation\" key.");
    }
    if (!operationValue->isString()) {
        return errorResult(fault_code::MALFORMED_REQUEST,
                           "Request key \"operation\" must be a string.");
    }

    Value emptyParams;
    emptyParams.kind = json_lite::Kind::Object;
    const Value* paramsValue = request.find("params");
    if (paramsValue != nullptr && !paramsValue->isNull() && !paramsValue->isObject()) {
        return errorResult(fault_code::MALFORMED_REQUEST,
                           "Request key \"params\" must be an object when present.");
    }
    const Value& params =
        (paramsValue != nullptr && paramsValue->isObject()) ? *paramsValue : emptyParams;

    const std::string body = dispatch(operationValue->text, params);
    if (fault::raised()) {
        return errorResult(fault::code(), fault::message());
    }
    if (body.empty()) {
        // A dispatcher returned nothing without latching a reason. That is a
        // defect in THIS file rather than in the request, and it is reported as
        // one instead of being emitted as an empty response body.
        return errorResult("internal-error",
                           "Operation \"" + operationValue->text +
                               "\" produced no response and reported no reason. "
                               "This is a module defect, not a bad request.");
    }

    PluginInvokeResult result{};
    result.ok = true;
    result.json = body;
    return result;
}

}  // namespace maneuver
