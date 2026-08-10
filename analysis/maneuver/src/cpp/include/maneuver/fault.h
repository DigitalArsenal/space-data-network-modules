#ifndef MANEUVER_FAULT_H
#define MANEUVER_FAULT_H

#include <string>

namespace maneuver {

/**
 * THE NO-THROW FAULT CHANNEL.
 *
 * This module compiles with `-fno-exceptions`: the sanctioned wasi toolchain's
 * libc++ is built without exception support, so a `throw` in guest code does
 * not become a catchable C++ exception — it lowers to a trap that POISONS the
 * instance for every subsequent call. Shipping 0.1.0 that way is why every
 * validator message the authors wrote was unreachable and every bad input
 * killed the module (graph: modules-maneuver-planner-rebuild-batch item 1).
 *
 * So validation reports through a latch instead. A validator calls `raise()`
 * and returns a default value; the entry-point boundary asks `raised()` once
 * and turns the latch into a structured error result. The messages themselves
 * are unchanged — they were always good, they were simply never observable.
 *
 * Two properties this relies on, both deliberate:
 *
 *  - EVERY raise site returns IMMEDIATELY. The latch is not a "keep going and
 *    check later" flag; it is set at the point of refusal and the function
 *    stops. Nothing downstream ever runs on the input that was refused.
 *  - The latch is CLEARED at the start of every invoke. A fault from a previous
 *    call must not be able to fail the next one — the whole point is that the
 *    instance survives.
 *
 * Single-threaded by construction: the manifest declares `wasi-sequential`, so
 * there is exactly one logical thread of execution inside the guest and a plain
 * static is the correct storage. If this module ever adopts the pthreads model
 * this becomes `thread_local` and the boundary aggregates.
 */
namespace fault {

/// Clear the latch. Called once per invoke, before any dispatch.
void reset();

/// Latch a refusal. The FIRST raise of a call wins — later ones are ignored so
/// that the message a caller sees is the deepest cause, not the last symptom.
void raise(const char* code, std::string message);

/// True when this call has been refused.
bool raised();

/// The structured code of the current fault ("" when none).
const char* code();

/// The human-readable message of the current fault ("" when none).
const std::string& message();

/**
 * Raise and yield a default-constructed value in one expression, so a refusal
 * inside a value-returning function is a single line that cannot fall through:
 *
 *     if (a <= 0.0) return fault::fail<double>("invalid-parameter", "...");
 */
template <typename T>
T fail(const char* code, std::string message) {
    raise(code, static_cast<std::string&&>(message));
    return T{};
}

}  // namespace fault

/// Structured codes. Kept few and stable: a caller switches on these, and a
/// vocabulary that grows a code per call site is a vocabulary nobody switches
/// on. The MESSAGE carries the specifics.
namespace fault_code {
/// A parameter is missing, of the wrong type, or outside its admissible range.
inline constexpr const char* INVALID_PARAMETER = "invalid-parameter";
/// The request body is not the JSON object the bridge requires.
inline constexpr const char* MALFORMED_REQUEST = "malformed-request";
/// The requested operation (or model/mode selector) is not one this module has.
inline constexpr const char* UNKNOWN_OPERATION = "unknown-operation";
/// The inputs are individually admissible but describe no solution.
inline constexpr const char* NO_SOLUTION = "no-solution";
/// The inputs describe a maneuver that is not physically flyable.
inline constexpr const char* INFEASIBLE = "infeasible";
/// The arithmetic is degenerate at this configuration (singular Jacobian, ...).
inline constexpr const char* SINGULAR = "singular-configuration";
}  // namespace fault_code

}  // namespace maneuver

#endif  // MANEUVER_FAULT_H
