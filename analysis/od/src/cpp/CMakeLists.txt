cmake_minimum_required(VERSION 3.15)
project(od_sdn_plugin LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Performance flags ──
if(EMSCRIPTEN)
    # WASM: optimize for broad runtime compatibility across browser and WasmEdge.
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -flto -ffast-math -DNDEBUG")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -DEIGEN_DONT_PARALLELIZE")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto")
else()
    # Native: LTO + architecture-specific tuning
    set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -O3 -flto -ffast-math -march=native -mtune=native")
    set(CMAKE_INTERPROCEDURAL_OPTIMIZATION TRUE)
endif()

# Eigen3 (header-only)
find_package(Eigen3 QUIET NO_MODULE)
if(NOT Eigen3_FOUND)
    find_path(
        EIGEN3_INCLUDE_DIR
        NAMES Eigen/Core
        PATH_SUFFIXES eigen3
        PATHS
            /opt/homebrew/include
            /opt/homebrew/opt/eigen/include
            /usr/local/include
            /usr/local/opt/eigen/include
        NO_CMAKE_FIND_ROOT_PATH
    )
    if(NOT EIGEN3_INCLUDE_DIR)
        message(FATAL_ERROR "Eigen3 headers not found. Install eigen and retry.")
    endif()
    add_library(Eigen3::Eigen INTERFACE IMPORTED)
    set_target_properties(
        Eigen3::Eigen PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${EIGEN3_INCLUDE_DIR}"
    )
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

# Generated SDS C++ headers (flat licensing/core layout) — the SAME headers
# iss-source / celestrak-parser reuse. Provides OEM_generated.h / OMM_generated.h
# (+ RFM/TIM/CAT/PPE/MET) for the $OEM reader and $OMM builder. Overridable via
# -DSDN_CORE_SDS_GENERATED_DIR or the env var of the same name.
if(DEFINED ENV{SDN_CORE_SDS_GENERATED_DIR})
    set(SDN_CORE_SDS_GENERATED_DIR "$ENV{SDN_CORE_SDS_GENERATED_DIR}" CACHE PATH "SDS generated C++ headers dir")
else()
    set(SDN_CORE_SDS_GENERATED_DIR
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../licensing/core/src/cpp/generated/sds"
        CACHE PATH "SDS generated C++ headers dir")
endif()
if(NOT EXISTS "${SDN_CORE_SDS_GENERATED_DIR}/OEM_generated.h")
    message(FATAL_ERROR "SDS generated headers not found at ${SDN_CORE_SDS_GENERATED_DIR} (need OEM_generated.h/OMM_generated.h). Set -DSDN_CORE_SDS_GENERATED_DIR.")
endif()

# The SGP4/SDP4 base: foundation/sgp4-str3, header-only (propagator/sdn-ap compiles the same parts)
set(SGP4_STR3_INCLUDE_DIR "${CMAKE_SOURCE_DIR}/../../../../foundation/sgp4-str3/include")
add_library(sgp4_lib INTERFACE)
target_include_directories(sgp4_lib INTERFACE "${SGP4_STR3_INCLUDE_DIR}")

# OD library
set(OD_SOURCES
    src/orbit_determination.cpp
    src/meme_parser.cpp
    src/frame_transform.cpp
    src/oem_parser.cpp
    src/oem_fb_reader.cpp
    src/omm_fb_builder.cpp
    src/obd_fb_builder.cpp
    src/ocm_fb_builder.cpp
    src/sgp4_fitter.cpp
    src/plugin_runtime.cpp
)

add_library(od_lib STATIC ${OD_SOURCES})
target_include_directories(od_lib PUBLIC include "${SGP4_STR3_INCLUDE_DIR}")
# The $OEM reader / $OMM builder TUs (oem_fb_reader.cpp / omm_fb_builder.cpp)
# include the generated SDS + flatbuffers headers. PRIVATE: the reader/builder
# public headers stay plain-C++ (no FlatBuffers types leak), so od_lib consumers
# need neither include path.
target_include_directories(od_lib PRIVATE
    "${FLATBUFFERS_INCLUDE_DIR}"
    "${SDN_CORE_SDS_GENERATED_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../../../common"
)
target_link_libraries(od_lib PUBLIC sgp4_lib Eigen3::Eigen)

# Test executable
if(NOT EMSCRIPTEN)
    add_executable(test_od tests/test_od.cpp)
    target_link_libraries(test_od od_lib)

    add_executable(test_supgp tests/test_supgp.cpp)
    target_link_libraries(test_supgp od_lib)

    add_executable(test_frame_time_fit tests/test_frame_time_fit.cpp)
    target_link_libraries(test_frame_time_fit od_lib)

    add_executable(bench_supgp tests/bench_supgp.cpp)
    target_link_libraries(bench_supgp od_lib)

    add_executable(analyze_outliers tests/analyze_outliers.cpp)
    target_link_libraries(analyze_outliers od_lib)

    add_executable(test_downsample_accuracy tests/test_downsample_accuracy.cpp)
    target_link_libraries(test_downsample_accuracy od_lib)

    # SACRED parity gate: fitting an $OEM FlatBuffer built from the ISS fixture
    # must match the KVN text path bit-for-bit (RMS + every mean element). This
    # test builds the $OEM FlatBuffer, so it needs the SDS + flatbuffers headers.
    add_executable(test_oem_fb_parity tests/test_oem_fb_parity.cpp)
    target_include_directories(test_oem_fb_parity PRIVATE
        "${FLATBUFFERS_INCLUDE_DIR}"
        "${SDN_CORE_SDS_GENERATED_DIR}"
    )
    target_compile_definitions(test_oem_fb_parity PRIVATE
        OD_ISS_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/../../tests/data/supgp-reference/iss/ISS.OEM_J2K_EPH.trimmed.txt")
    target_link_libraries(test_oem_fb_parity od_lib)
endif()

# WASM target (Emscripten): the browser bundle and command module build.sh builds. Its units are ../../units.mjs, the
# list build-wasi.mjs compiles too (OD's units, FFM's physics from propagator/ffm/lib/units.mjs, HWM14, NRLMSISE-00 and
# the ERFA amalgamation), plus direct_initialize, the bundle's _initialize.
if(EMSCRIPTEN)
    enable_language(C)
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -O3 -flto -ffast-math -DNDEBUG")
    find_program(NODE_EXECUTABLE node REQUIRED)
    execute_process(
        COMMAND "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/../../units.mjs"
            --cmake "${CMAKE_CURRENT_BINARY_DIR}/od-units.cmake"
            --erfa "${CMAKE_CURRENT_BINARY_DIR}/erfa.cpp"
        RESULT_VARIABLE OD_UNITS_RESULT
    )
    if(NOT OD_UNITS_RESULT EQUAL 0)
        message(FATAL_ERROR "analysis/od/units.mjs could not list the module's units")
    endif()
    include("${CMAKE_CURRENT_BINARY_DIR}/od-units.cmake")
    set_source_files_properties(${OD_UNITS_IGNORE_EXCEPTIONS} PROPERTIES COMPILE_OPTIONS "-fignore-exceptions")
    set_source_files_properties(${OD_UNITS_NO_EXCEPTIONS} PROPERTIES COMPILE_OPTIONS "-fno-exceptions")
    add_executable(
        od_wasm
        ${OD_UNITS_IGNORE_EXCEPTIONS}
        ${OD_UNITS_NO_EXCEPTIONS}
        ${OD_UNITS_C}
        src/direct_initialize.cpp
    )
    target_include_directories(
        od_wasm PRIVATE
        include
        generated
        ${OD_MODEL_INCLUDE_DIRS}
        "${SGP4_STR3_INCLUDE_DIR}"
        "${FLATBUFFERS_INCLUDE_DIR}"
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../common"
        "${SDN_CORE_SDS_GENERATED_DIR}"
    )
    target_compile_definitions(od_wasm PRIVATE ${OD_MODEL_DEFINITIONS})
    target_link_libraries(od_wasm Eigen3::Eigen)
    set_target_properties(od_wasm PROPERTIES
        SUFFIX ".js"
        LINK_FLAGS "\
            -s EXPORTED_FUNCTIONS='[\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\"]' \
            -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\"]' \
            -s MODULARIZE=1 \
            -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
            -Wl,--allow-undefined \
            -s EXPORT_NAME='ODModule' \
            -Wl,--wrap=__wasm_call_ctors \
            -s STANDALONE_WASM=1 \
            -s INITIAL_MEMORY=67108864 \
            -s STACK_SIZE=2097152 \
            -s MALLOC='emmalloc' \
            -s FILESYSTEM=0 \
        "
    )
endif()
