cmake_minimum_required(VERSION 3.15)
project(conjunction_assessment_sdn_plugin LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# CMake is reserved for native numerical tests. Production WASM is built by
# ../../build.mjs through the SDK's validated wasi-threads compiler.
if(EMSCRIPTEN OR WASI_SDK)
    message(FATAL_ERROR "Use node build.mjs for the canonical SDK WASM artifact.")
endif()

find_path(
    FLATBUFFERS_INCLUDE_DIR
    NAMES flatbuffers/flatbuffers.h
    PATHS
        "$ENV{SDN_FLATBUFFERS_INCLUDE_DIR}"
        "$ENV{FLATBUFFERS_INCLUDE_DIR}"
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../flatbuffers/include"
        /opt/homebrew/include
        /opt/homebrew/opt/flatbuffers/include
        /usr/local/include
        /usr/local/opt/flatbuffers/include
    NO_CMAKE_FIND_ROOT_PATH
)

if(NOT FLATBUFFERS_INCLUDE_DIR)
    message(FATAL_ERROR "flatbuffers headers not found. Install flatbuffers and retry.")
endif()

# ============================================================================
# SGP4 library (dnwrnr/sgp4)
# ============================================================================
set(SGP4_DIR "${CMAKE_SOURCE_DIR}/deps/sgp4/libsgp4")

file(GLOB SGP4_SOURCES "${SGP4_DIR}/*.cc")
add_library(sgp4_lib STATIC ${SGP4_SOURCES})
target_include_directories(sgp4_lib PUBLIC "${SGP4_DIR}" "${CMAKE_SOURCE_DIR}/include")

# ============================================================================
# ERFA (vendored in higherpop): leap seconds and TDB for time_scales.cpp
# ============================================================================
set(ERFA_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../higherpop/third_party/erfa")
file(GLOB ERFA_SOURCES "${ERFA_DIR}/*.c")
list(FILTER ERFA_SOURCES EXCLUDE REGEX "(t_erfa_c|t_erfa_c_extra|erfaversion)\\.c$")
add_library(erfa_lib STATIC ${ERFA_SOURCES})
target_include_directories(erfa_lib PUBLIC "${ERFA_DIR}")

# ============================================================================
# Conjunction assessment library
# ============================================================================
set(CA_SOURCES
    src/conjunction_assessment.cpp
    src/gp_json.cpp
    src/kdtree.cpp
    src/resident_screening_index.cpp
    src/screening_internal.cpp
    src/screening.cpp
    src/screening_tight.cpp
    src/time_scales.cpp
    src/earth_orientation.cpp
    src/ephemeris_upload.cpp
    src/cdm_output.cpp
    src/csm_output.cpp
    src/pc_method.cpp
    src/ephemeris_source.cpp
    src/conjunction_engine.cpp
)

add_library(conjunction_assessment STATIC ${CA_SOURCES})
target_include_directories(conjunction_assessment PUBLIC
    include
    include/conjunction
    generated
    generated/sds
    "${FLATBUFFERS_INCLUDE_DIR}"
    "${CMAKE_SOURCE_DIR}/deps/sgp4"
    "${SGP4_DIR}"
)
target_link_libraries(conjunction_assessment PUBLIC sgp4_lib erfa_lib)

# ============================================================================
# Native test executables
# ============================================================================
if(NOT EMSCRIPTEN AND NOT WASI_SDK)
    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_socrates.cpp")
        add_executable(test_socrates tests/test_socrates.cpp)
        target_link_libraries(test_socrates conjunction_assessment)
        target_include_directories(test_socrates PRIVATE include "${SGP4_DIR}")
    endif()

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_gp_json.cpp")
        add_executable(test_gp_json tests/test_gp_json.cpp)
        target_link_libraries(test_gp_json conjunction_assessment)
        target_include_directories(test_gp_json PRIVATE include "${SGP4_DIR}")
    endif()

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_screening.cpp")
        add_executable(test_screening tests/test_screening.cpp)
        target_link_libraries(test_screening conjunction_assessment)
        target_include_directories(test_screening PRIVATE include "${SGP4_DIR}")
    endif()

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_screening_internal.cpp")
        add_executable(test_screening_internal tests/test_screening_internal.cpp)
        target_link_libraries(test_screening_internal conjunction_assessment)
        target_include_directories(test_screening_internal PRIVATE include "${SGP4_DIR}")
    endif()

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_time_format.cpp")
        add_executable(test_time_format tests/test_time_format.cpp)
        target_link_libraries(test_time_format conjunction_assessment)
        target_include_directories(test_time_format PRIVATE include "${SGP4_DIR}")
    endif()

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_pc_methods.cpp")
        add_executable(test_pc_methods tests/test_pc_methods.cpp)
        target_link_libraries(test_pc_methods conjunction_assessment)
        target_include_directories(test_pc_methods PRIVATE include "${SGP4_DIR}")
        target_compile_definitions(test_pc_methods PRIVATE
            CONJUNCTION_TEST_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/tests/fixtures")
    endif()

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_engine.cpp")
        add_executable(test_engine tests/test_engine.cpp)
        target_link_libraries(test_engine conjunction_assessment)
        target_include_directories(test_engine PRIVATE include "${SGP4_DIR}")
    endif()

    add_executable(test_trajectory_bounds tests/test_trajectory_bounds.cpp)
    target_link_libraries(test_trajectory_bounds conjunction_assessment)

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_cdm_output.cpp")
        add_executable(test_cdm_output tests/test_cdm_output.cpp)
        target_link_libraries(test_cdm_output conjunction_assessment)
        target_include_directories(test_cdm_output PRIVATE include "${SGP4_DIR}")
    endif()

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_csm_output.cpp")
        add_executable(test_csm_output tests/test_csm_output.cpp)
        target_link_libraries(test_csm_output conjunction_assessment)
        target_include_directories(test_csm_output PRIVATE include "${SGP4_DIR}")
    endif()

    enable_testing()
    add_test(NAME trajectory_bounds COMMAND test_trajectory_bounds)
    if(TARGET test_socrates)
        add_test(NAME socrates COMMAND test_socrates)
        set_tests_properties(socrates PROPERTIES SKIP_RETURN_CODE 77)
    endif()
    if(TARGET test_gp_json)
        add_test(NAME gp_json COMMAND test_gp_json)
    endif()
    if(TARGET test_screening)
        add_test(NAME screening COMMAND test_screening)
    endif()
    if(TARGET test_screening_internal)
        add_test(NAME screening_internal COMMAND test_screening_internal)
    endif()
    if(TARGET test_time_format)
        add_test(NAME time_format COMMAND test_time_format)
    endif()
    if(TARGET test_pc_methods)
        add_test(NAME pc_methods COMMAND test_pc_methods)
    endif()
    if(TARGET test_engine)
        add_test(NAME engine COMMAND test_engine)
    endif()
    if(TARGET test_cdm_output)
        add_test(NAME cdm_output COMMAND test_cdm_output)
    endif()
    if(TARGET test_csm_output)
        add_test(NAME csm_output COMMAND test_csm_output)
    endif()
endif()
