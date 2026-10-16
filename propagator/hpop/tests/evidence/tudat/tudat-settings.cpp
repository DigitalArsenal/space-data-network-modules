// Native Tudat evidence adapters: explicit EOP/TT settings, a changing
// relativity spin axis, and an unchanged aerodynamic force exposed through
// Tudat's custom-partial interface. No Tudat source or installed resources
// are modified, and HOME is never overridden.
//
// The installed kernel and this extension need not use the same pybind11
// release.  The kernel's _pybind11_conduit_v1_ protocol checks the C++ ABI
// and RTTI before lending a typed pointer. Borrowed pointers never outlive
// their owning Python objects; callback capsules retain those owners.
// This uses the CPython API rather than registering a second Tudat type.
#define PY_SSIZE_T_CLEAN
#include <Python.h>

#include <exception>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <string>
#include <typeinfo>

#include <tudat/simulation/environment_setup/createRotationModel.h>
#include <tudat/astro/relativity/relativisticAccelerationCorrection.h>
#include <tudat/astro/aerodynamics/aerodynamicAcceleration.h>

namespace {
using Settings = tudat::simulation_setup::GcrsToItrsRotationModelSettings;

// Pinned tudatpy 1.0.0 py311h2196d89_3, macOS arm64, libc++ ABI 1.
// A different native C++ ABI fails the conduit request rather than lending
// a pointer with an incompatible layout.
constexpr const char* platformAbi = "system_libcpp_abi1";

template <class Native>
Native* nativePointer(PyObject* object) {
    PyObject* typeInfo = PyCapsule_New(
        const_cast<std::type_info*>(&typeid(Native)), typeid(std::type_info).name(), nullptr);
    if (!typeInfo) return nullptr;
    PyObject* pointerCapsule = PyObject_CallMethod(
        object, "_pybind11_conduit_v1_", "yOy", platformAbi, typeInfo, "raw_pointer_ephemeral");
    Py_DECREF(typeInfo);
    if (!pointerCapsule) return nullptr;
    Native* pointer = nullptr;
    if (PyCapsule_CheckExact(pointerCapsule)) {
        pointer = static_cast<Native*>(PyCapsule_GetPointer(pointerCapsule, typeid(Native).name()));
    } else {
        PyErr_SetString(PyExc_RuntimeError, "Tudat settings conduit rejected the pinned C++ ABI or type");
    }
    Py_DECREF(pointerCapsule);
    return pointer;
}

PyObject* gcrsToItrsTt(PyObject*, PyObject* args) {
    const char* eopFile = nullptr;
    double initialTime = 0.0, finalTime = 0.0, interpolationStep = 60.0;
    if (!PyArg_ParseTuple(args, "sdd|d:gcrs_to_itrs_tt", &eopFile,
                          &initialTime, &finalTime, &interpolationStep)) return nullptr;
    if (!*eopFile) {
        PyErr_SetString(PyExc_ValueError, "A private C04 EOP file path is required");
        return nullptr;
    }
    if (!std::isfinite(initialTime) || !std::isfinite(finalTime) || finalTime <= initialTime ||
        !std::isfinite(interpolationStep) || interpolationStep <= 0.0 || interpolationStep > 60.0) {
        PyErr_SetString(PyExc_ValueError, "Expected increasing finite TT epochs and an interpolation step in (0, 60] seconds");
        return nullptr;
    }
    PyObject* rotationModule = PyImport_ImportModule("tudatpy.dynamics.environment_setup.rotation_model");
    if (!rotationModule) return nullptr;
    PyObject* settings = PyObject_CallMethod(rotationModule, "gcrs_to_itrs", nullptr);
    Py_DECREF(rotationModule);
    if (!settings) return nullptr;
    Settings* native = nativePointer<Settings>(settings);
    if (!native) {
        Py_DECREF(settings);
        return nullptr;
    }
    try {
        // Preserve the package's short-period UT1/polar-motion resources.
        // The native constructor explicitly accepts inputTimeScale; the
        // Python factory otherwise leaves it at TDB even for a TT integrator.
        *native = Settings(tudat::basic_astrodynamics::iau_2006, "GCRS", eopFile,
                           tudat::basic_astrodynamics::tt_scale,
                           native->getUt1CorrectionSettings(), native->getPolarMotionCorrectionSettings());
        // Only smooth model quantities are tabulated.  Tudat still applies
        // the daily C04 pole offsets and jump-aware UTC/UT1 interpolation
        // separately.  Its native CIO, short-period EOP and TDB-TT models
        // generate these tables; no rotations or time-scale math is moved
        // into Python.  Padding keeps the full integration/interpolation arc
        // away from the Lagrange boundary treatment.
        using namespace tudat::interpolators;
        const auto interpolation = std::make_shared<InterpolatorGenerationSettings<double>>(
            std::make_shared<LagrangeInterpolatorSettings>(8),
            initialTime - 7200.0, finalTime + 7200.0, interpolationStep);
        native->setCioInterpolatorSettings(interpolation);
        native->setShortTermInterpolatorSettings(interpolation);
        native->setTdbToTtInterpolatorSettings(interpolation);
        if (native->getEopFile() != std::string(eopFile) ||
            native->getInputTimeScale() != tudat::basic_astrodynamics::tt_scale) {
            PyErr_SetString(PyExc_RuntimeError, "Native Tudat EOP/TT settings did not round-trip");
            Py_DECREF(settings);
            return nullptr;
        }
    } catch (const std::exception& error) {
        PyErr_SetString(PyExc_RuntimeError, error.what());
        Py_DECREF(settings);
        return nullptr;
    }
    return settings;
}

PyObject* configureRotatingPole(PyObject*, PyObject* args) {
    PyObject* modelObject = nullptr;
    PyObject* bodiesObject = nullptr;
    if (!PyArg_ParseTuple(args, "OO:configure_rotating_pole", &modelObject, &bodiesObject)) return nullptr;
    using Acceleration = tudat::basic_astrodynamics::AccelerationModel<Eigen::Vector3d>;
    using Relativity = tudat::relativity::RelativisticAccelerationCorrection;
    auto* acceleration = nativePointer<Acceleration>(modelObject);
    if (!acceleration) return nullptr;
    auto* bodies = nativePointer<tudat::simulation_setup::SystemOfBodies>(bodiesObject);
    if (!bodies) return nullptr;
    auto* relativity = dynamic_cast<Relativity*>(acceleration);
    if (!relativity) {
        PyErr_SetString(PyExc_TypeError, "Expected a native Tudat relativistic acceleration model");
        return nullptr;
    }
    try {
        if (!relativity->getCalculateSchwarzschildCorrection() ||
            !relativity->getCalculateLenseThirringCorrection() ||
            !relativity->getCalculateDeSitterCorrection() || relativity->getPrimaryBodyName() != "Sun") {
            throw std::runtime_error("Rotating-pole adapter requires the complete Earth/Sun IERS correction");
        }
        const auto earth = bodies->getBody("Earth");
        const auto sun = bodies->getBody("Sun");
        const auto sunGravity = sun->getGravityFieldModel();
        if (!earth->getRotationalEphemeris() || !sunGravity) {
            throw std::runtime_error("Rotating-pole adapter requires Earth rotation and Sun gravity");
        }
        // This changes only the native constructor's spin-vector provider.
        // The complete Tudat relativity force remains its original C++ model.
        // R2 includes the Earth spherical-harmonic acceleration, which updates
        // this current Earth rotation before every acceleration evaluation.
        // Owning shared_ptr captures preserve body lifetimes with the model.
        const std::function<Eigen::Vector3d()> spin = [earth]() -> Eigen::Vector3d {
            return 9.8e8 * (earth->getCurrentRotationToGlobalFrame() * Eigen::Vector3d::UnitZ());
        };
        *relativity = Relativity(
            relativity->getStateFunctionOfAcceleratedBody(),
            relativity->getStateFunctionOfCentralBody(),
            [sun]() { return sun->getState(); },
            relativity->getGravitationalParameterFunctionOfCentralBody(),
            [sunGravity]() { return sunGravity->getGravitationalParameter(); }, "Sun", spin,
            relativity->getPpnParameterGammaFunction_(), relativity->getPpnParameterBetaFunction_(), true);
    } catch (const std::exception& error) {
        PyErr_SetString(PyExc_RuntimeError, error.what());
        return nullptr;
    }
    Py_RETURN_NONE;
}

// Tudat accepts custom parameter partials only for its custom/radiation
// acceleration types.  This callback lets its custom-acceleration wrapper
// call the original aerodynamic force unchanged, while its native numerical
// state partial and custom analytical parameter partials are selected.
// No drag/atmosphere calculation is duplicated in this bridge.
struct AerodynamicCallback {
    PyObject* modelOwner;
    PyObject* bodiesOwner;
    tudat::aerodynamics::AerodynamicAcceleration* acceleration;
    std::shared_ptr<tudat::simulation_setup::Body> spacecraft;
    std::shared_ptr<tudat::aerodynamics::AtmosphericFlightConditions> flight;

    AerodynamicCallback(PyObject* model, PyObject* bodies,
                        tudat::aerodynamics::AerodynamicAcceleration* nativeAcceleration,
                        std::shared_ptr<tudat::simulation_setup::Body> body,
                        std::shared_ptr<tudat::aerodynamics::AtmosphericFlightConditions> conditions)
        : modelOwner(model), bodiesOwner(bodies), acceleration(nativeAcceleration),
          spacecraft(std::move(body)), flight(std::move(conditions)) {
        Py_INCREF(modelOwner);
        Py_INCREF(bodiesOwner);
    }
    ~AerodynamicCallback() {
        Py_DECREF(modelOwner);
        Py_DECREF(bodiesOwner);
    }
};

constexpr const char* aerodynamicCapsuleName = "tudat_evidence.native_aerodynamic_callback";

void destroyAerodynamicCallback(PyObject* capsule) {
    auto* context = static_cast<AerodynamicCallback*>(PyCapsule_GetPointer(capsule, aerodynamicCapsuleName));
    if (context) delete context;
    else PyErr_Clear();
}

Eigen::Vector3d updateNativeAerodynamics(AerodynamicCallback* context, double time) {
    context->flight->resetCurrentTime();
    context->acceleration->resetCurrentTime();
    context->flight->updateConditions(time);
    context->acceleration->updateMembers(time);
    return context->acceleration->getAcceleration();
}

PyObject* evaluateNativeAerodynamics(PyObject* capsule, PyObject* args) {
    double time = 0.0;
    if (!PyArg_ParseTuple(args, "d:native_aerodynamic_acceleration", &time)) return nullptr;
    auto* context = static_cast<AerodynamicCallback*>(PyCapsule_GetPointer(capsule, aerodynamicCapsuleName));
    if (!context) return nullptr;
    try {
        // This is the same reset/update sequence as Tudat's own aerodynamic
        // numerical partial. Reset even at an unchanged epoch: the native
        // custom state partial perturbs the spacecraft at that same epoch.
        // Earth orientation is updated by the existing spherical-harmonic
        // force's environment requirements in every exported B1/C1 case.
        const Eigen::Vector3d result = updateNativeAerodynamics(context, time);
        return Py_BuildValue("[ddd]", result.x(), result.y(), result.z());
    } catch (const std::exception& error) {
        PyErr_SetString(PyExc_RuntimeError, error.what());
        return nullptr;
    }
}

struct RestoreAerodynamicState {
    AerodynamicCallback* context;
    double time;
    Eigen::Vector6d state;
    bool active = true;

    void restore() {
        context->spacecraft->setState(state);
        updateNativeAerodynamics(context, time);
        active = false;
    }
    ~RestoreAerodynamicState() noexcept {
        if (active) {
            try { restore(); } catch (...) { }
        }
    }
};

PyObject* evaluateNativeAerodynamicStatePartial(PyObject* capsule, PyObject* args) {
    double time = 0.0;
    PyObject* currentAcceleration = nullptr;
    if (!PyArg_ParseTuple(args, "dO:native_aerodynamic_state_partial", &time, &currentAcceleration)) return nullptr;
    auto* context = static_cast<AerodynamicCallback*>(PyCapsule_GetPointer(capsule, aerodynamicCapsuleName));
    if (!context) return nullptr;
    try {
        // Match the package's ordinary aerodynamic state partial: second-
        // order central differences at 10 m and 0.01 m/s.  The generic custom
        // numerical partial in this Tudat build leaves its final perturbed
        // state installed.  Keep the native drag force, but restore both the
        // spacecraft and its flight/force caches before parameter partials
        // can run.  The custom wrapper's nominal force is never overwritten.
        const Eigen::Vector6d nominal = context->spacecraft->getState();
        RestoreAerodynamicState restore{context, time, nominal};
        constexpr double perturbations[6] = {10.0, 10.0, 10.0, 0.01, 0.01, 0.01};
        Eigen::Matrix<double, 3, 6> partial;
        for (int column = 0; column < 6; ++column) {
            Eigen::Vector6d perturbed = nominal;
            perturbed(column) += perturbations[column];
            context->spacecraft->setState(perturbed);
            const Eigen::Vector3d upper = updateNativeAerodynamics(context, time);
            perturbed = nominal;
            perturbed(column) -= perturbations[column];
            context->spacecraft->setState(perturbed);
            const Eigen::Vector3d lower = updateNativeAerodynamics(context, time);
            partial.col(column) = (upper - lower) / (2.0 * perturbations[column]);
        }
        restore.restore();
        return Py_BuildValue("[[dddddd][dddddd][dddddd]]",
                            partial(0, 0), partial(0, 1), partial(0, 2), partial(0, 3), partial(0, 4), partial(0, 5),
                            partial(1, 0), partial(1, 1), partial(1, 2), partial(1, 3), partial(1, 4), partial(1, 5),
                            partial(2, 0), partial(2, 1), partial(2, 2), partial(2, 3), partial(2, 4), partial(2, 5));
    } catch (const std::exception& error) {
        PyErr_SetString(PyExc_RuntimeError, error.what());
        return nullptr;
    }
}

PyMethodDef aerodynamicCallbackMethod = {
    "native_aerodynamic_acceleration", evaluateNativeAerodynamics, METH_VARARGS,
    "Evaluate the retained, unmodified native Tudat aerodynamic model at the current spacecraft state.",
};

PyMethodDef aerodynamicStatePartialMethod = {
    "native_aerodynamic_state_partial", evaluateNativeAerodynamicStatePartial, METH_VARARGS,
    "Differentiate the retained native aerodynamic force, restoring nominal state and caches with RAII.",
};

PyObject* createAerodynamicCallable(PyObject* args, PyMethodDef* method) {
    PyObject* modelObject = nullptr;
    PyObject* bodiesObject = nullptr;
    if (!PyArg_ParseTuple(args, "OO:native_aerodynamic_callback", &modelObject, &bodiesObject)) return nullptr;
    using Acceleration = tudat::basic_astrodynamics::AccelerationModel<Eigen::Vector3d>;
    auto* acceleration = nativePointer<Acceleration>(modelObject);
    if (!acceleration) return nullptr;
    auto* aerodynamic = dynamic_cast<tudat::aerodynamics::AerodynamicAcceleration*>(acceleration);
    if (!aerodynamic) {
        PyErr_SetString(PyExc_TypeError, "Expected an existing native Tudat aerodynamic acceleration model");
        return nullptr;
    }
    auto* bodies = nativePointer<tudat::simulation_setup::SystemOfBodies>(bodiesObject);
    if (!bodies) return nullptr;
    try {
        const auto spacecraft = bodies->getBody("Sat");
        const auto flight = std::dynamic_pointer_cast<tudat::aerodynamics::AtmosphericFlightConditions>(
            spacecraft->getFlightConditions());
        if (!flight || !bodies->getBody("Earth")->getRotationalEphemeris()) {
            throw std::runtime_error("Native aerodynamic callback requires Sat atmospheric flight conditions and Earth rotation");
        }
        auto context = std::make_unique<AerodynamicCallback>(modelObject, bodiesObject, aerodynamic, spacecraft, flight);
        PyObject* capsule = PyCapsule_New(context.get(), aerodynamicCapsuleName, destroyAerodynamicCallback);
        if (!capsule) return nullptr;
        context.release();
        PyObject* callable = PyCFunction_New(method, capsule);
        Py_DECREF(capsule);
        return callable;
    } catch (const std::exception& error) {
        PyErr_SetString(PyExc_RuntimeError, error.what());
        return nullptr;
    }
}

PyObject* nativeAerodynamicCallback(PyObject*, PyObject* args) {
    return createAerodynamicCallable(args, &aerodynamicCallbackMethod);
}

PyObject* nativeAerodynamicStatePartial(PyObject*, PyObject* args) {
    return createAerodynamicCallable(args, &aerodynamicStatePartialMethod);
}

PyMethodDef methods[] = {
    {"gcrs_to_itrs_tt", gcrsToItrsTt, METH_VARARGS,
     "gcrs_to_itrs_tt(eop_path, initial_tt, final_tt, interpolation_step=60)\n"
     "Create native IAU 2006 GCRS/ITRS settings with a private C04 path and TT input.\n"
     "Epochs are TT seconds since J2000. Native Lagrange-8 CIO, short-period EOP, and\n"
     "TDB-TT tables use the requested step and 7200-second padding at each end.\n"
     "Use 60 seconds for the base run and 30 seconds for its finer comparison."},
    {"configure_rotating_pole", configureRotatingPole, METH_VARARGS,
     "Configure native IERS relativity to use the current Earth-fixed pole (Earth field required)."},
    {"native_aerodynamic_callback", nativeAerodynamicCallback, METH_VARARGS,
     "native_aerodynamic_callback(existing_aero_model, bodies)\n"
     "Return a native callable for propagation_setup.acceleration.custom_acceleration.\n"
     "Retains the existing Sat/Earth native aerodynamic force and owning objects;\n"
     "refreshes atmospheric flight conditions for every native state perturbation.\n"
     "The exported B1/C1 Earth-field environment must remain present."},
    {"native_aerodynamic_state_partial", nativeAerodynamicStatePartial, METH_VARARGS,
     "native_aerodynamic_state_partial(existing_aero_model, bodies)\n"
     "Return a (time, acceleration)->3x6 callback for custom_analytical_partial.\n"
     "Uses the native aerodynamic force with 10 m/0.01 m/s central differences,\n"
     "then restores the nominal spacecraft state and native flight/force caches."},
    {nullptr, nullptr, 0, nullptr},
};
PyModuleDef module = {PyModuleDef_HEAD_INIT, "tudat_settings",
                      "Native settings bridge for the pinned Tudat evidence runner.", -1, methods};
}  // namespace

PyMODINIT_FUNC PyInit_tudat_settings() {
    return PyModule_Create(&module);
}
